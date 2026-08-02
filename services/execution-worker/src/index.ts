export * from "./oauth.js";
export * from "./mcp-client.js";
export * from "./token-vault.js";
export * from "./brokers.js";
export * from "./persistence.js";
export * from "./execution-prerequisites.js";

import { DomainError, type ApprovalMode, type Entitlements, type ReleaseGates, type RiskPolicy, type TradeProposal } from "@whox/contracts";
import { evaluateRisk, type RiskContext } from "@whox/risk-schemas";
import type { ProposalAggregate, ProposalStore, TransitionCommand } from "@whox/agent-orchestrator";
import type { BrokerGateway, BrokerReview, BrokerSubmission, ExecutionMarketQuote } from "./brokers.js";

export interface ExecutionOutcome {readonly proposalId:string;readonly review:BrokerReview;readonly submission:BrokerSubmission;readonly aggregate:ProposalAggregate;readonly riskFingerprint:string;}

export interface ExecutionAuthorization {
  readonly verifiedBy:"persistent-execution-store";
  readonly ownerUserId:string;
  readonly verifiedAccountId:string;
  readonly policyId:string;
  readonly policyVersion:number;
  readonly approvalMode:ApprovalMode;
  readonly authorizationKind:"authenticated_user"|"automatic_server_gate";
  readonly authorizationReference:string;
  readonly placementAuthorized:boolean;
  readonly entitlements:Entitlements;
  readonly releaseGates:ReleaseGates;
  readonly userStatus:"active"|"suspended"|"closed";
  readonly strategyEnabled:boolean;
  readonly agentVersionEnabled:boolean;
  readonly accountConnectionHealthy:boolean;
  readonly tradingPermission:boolean;
  readonly marketQuote?:ExecutionMarketQuote;
}

interface SubmissionInput {readonly aggregate:ProposalAggregate;readonly policy:RiskPolicy;readonly riskContext:RiskContext;readonly authorization:ExecutionAuthorization;readonly idempotencyKey:string;readonly correlationId:string;readonly now:string;}
export interface PlacementReceiptStore {recordPlacementAttempt(userId:string,aggregate:ProposalAggregate,idempotencyKey:string,now:string):Promise<string>;}

export class ExecutionWorker {
  readonly #outcomes=new Map<string,ExecutionOutcome>();readonly #inFlight=new Map<string,Promise<ExecutionOutcome>>();
  public constructor(private readonly store:ProposalStore,private readonly broker:BrokerGateway,private readonly receipts?:PlacementReceiptStore){}
  public async submitApproved(input:SubmissionInput):Promise<ExecutionOutcome>{
    const scope=`${input.aggregate.proposal.proposalId}:${input.idempotencyKey}`;const completed=this.#outcomes.get(scope);if(completed!==undefined)return completed;const active=this.#inFlight.get(scope);if(active!==undefined)return active;
    const operation=this.#execute(input).finally(()=>this.#inFlight.delete(scope));this.#inFlight.set(scope,operation);return operation;
  }
  async #execute(input:SubmissionInput):Promise<ExecutionOutcome>{
    const proposal:TradeProposal=input.aggregate.proposal;
    if(!["APPROVED","SUBMITTING","SUBMITTED","PARTIALLY_FILLED","FILLED","REJECTED","RECONCILIATION_ERROR"].includes(input.aggregate.status))throw new DomainError("PROPOSAL_NOT_EXECUTABLE","Proposal is not approved or recoverable",409);
    this.#assertAuthorization(input);
    if(proposal.environment!==this.broker.environment)throw new DomainError("BROKER_ENVIRONMENT_MISMATCH","Broker environment does not match proposal",409);
    const risk=evaluateRisk(proposal,input.policy,{...input.riskContext,now:input.now,releaseGates:input.authorization.releaseGates,userStatus:input.authorization.userStatus,entitlements:input.authorization.entitlements,accountConnectionHealthy:input.authorization.accountConnectionHealthy,verifiedAgenticAccountId:input.authorization.verifiedAccountId,strategyEnabled:input.authorization.strategyEnabled,agentVersionEnabled:input.authorization.agentVersionEnabled,tradingPermission:input.authorization.tradingPermission});
    const brokerContext={priorProposalStatus:input.aggregate.status,...(input.authorization.marketQuote===undefined?{}:{marketQuote:input.authorization.marketQuote})};
    let aggregate=input.aggregate;
    if(aggregate.status!=="APPROVED"){
      const reconciliation=await this.broker.reconcilePlacement(proposal,`${input.idempotencyKey}:broker`,input.now,brokerContext);
      if(reconciliation.resolution==="found")return this.#outcome(input,await this.#applySubmission(input,aggregate,reconciliation.submission),reconciliation.review,reconciliation.submission,risk.proposalFingerprint);
      if(reconciliation.resolution==="unknown"){
        await this.#markAmbiguous(input,aggregate,reconciliation.reasonCode);
        throw new DomainError("PLACEMENT_RECONCILIATION_PENDING","Broker placement could not be reconciled; no new order was sent",503,{reasonCode:reconciliation.reasonCode});
      }
      if(["SUBMITTED","PARTIALLY_FILLED","FILLED","REJECTED"].includes(aggregate.status))throw new DomainError("PERSISTED_SUBMISSION_NOT_FOUND","A terminal or submitted proposal could not be found at the broker; replacement is blocked",503);
      if(!input.authorization.placementAuthorized)throw new DomainError("PLACEMENT_AUTHORIZATION_EXPIRED","Fresh placement authorization is required after reconciliation found no order",409);
      if(!risk.passed)throw new DomainError("RISK_RECHECK_FAILED","Proposal failed deterministic risk recheck after broker confirmed no prior order",422,{failedChecks:risk.checks.filter((item)=>!item.passed).map((item)=>item.code)});
      if(aggregate.status==="RECONCILIATION_ERROR")aggregate=await this.#transition(input,aggregate,"SUBMITTING","reconciled-not-found");
    }
    if(!input.authorization.placementAuthorized)throw new DomainError("PLACEMENT_NOT_AUTHORIZED","Current approval or autonomous authorization is required",403);
    if(!risk.passed)throw new DomainError("RISK_RECHECK_FAILED","Proposal failed deterministic risk recheck",422,{failedChecks:risk.checks.filter((item)=>!item.passed).map((item)=>item.code)});
    const review=await this.broker.review(proposal,input.now,brokerContext);if(review.warnings.some((warning)=>warning.severity==="blocking"))throw new DomainError("BROKER_REVIEW_BLOCKING","Broker review contains blocking warnings",422);
    if(aggregate.status==="APPROVED")aggregate=await this.#transition(input,aggregate,"SUBMITTING","submitting");
    if(this.broker.environment!=="demo"&&this.receipts===undefined)throw new DomainError("PERSISTENT_PLACEMENT_RECEIPT_REQUIRED","Paper and Live placement require a durable pre-submission receipt",503);
    await this.receipts?.recordPlacementAttempt(input.authorization.ownerUserId,aggregate,input.idempotencyKey,input.now);
    let submission:BrokerSubmission;
    try{submission=await this.broker.place(proposal,review,`${input.idempotencyKey}:broker`,input.now);}catch(error){
      await this.#markAmbiguous(input,aggregate,error instanceof DomainError?error.code:"UNKNOWN_PLACEMENT_ERROR");
      throw new DomainError("PLACEMENT_OUTCOME_AMBIGUOUS","Order placement outcome is unknown and requires reconciliation",503,{causeCode:error instanceof DomainError?error.code:"UNKNOWN_PLACEMENT_ERROR"});
    }
    aggregate=await this.#applySubmission(input,aggregate,submission);
    return this.#outcome(input,aggregate,review,submission,risk.proposalFingerprint);
  }
  #assertAuthorization(input:SubmissionInput):void{
    const proposal=input.aggregate.proposal;const authorization=input.authorization;
    if(authorization.verifiedBy!=="persistent-execution-store"||authorization.ownerUserId!==proposal.userId||authorization.verifiedAccountId!==proposal.accountId)throw new DomainError("EXECUTION_BINDING_INVALID","Persistent user and account bindings do not match the proposal",403);
    if(input.policy.userId!==proposal.userId||authorization.policyId!==input.policy.policyId||authorization.policyVersion!==input.policy.version)throw new DomainError("EXECUTION_POLICY_BINDING_INVALID","Current persisted risk policy does not match the proposal owner",403);
    if(authorization.approvalMode!==proposal.requiredApprovalMode)throw new DomainError("EXECUTION_APPROVAL_MODE_MISMATCH","Current agent approval mode does not match the proposal",409);
    if(proposal.requiredApprovalMode==="observe")throw new DomainError("OBSERVE_MODE_EXECUTION_FORBIDDEN","Observe mode can never execute an order",403);
    if(proposal.requiredApprovalMode==="confirm_every_trade"&&authorization.authorizationKind!=="authenticated_user")throw new DomainError("USER_APPROVAL_AUTHENTICATION_REQUIRED","Confirm-every-trade execution requires authenticated user approval",403);
    if(proposal.requiredApprovalMode==="automatic_within_limits"&&(authorization.authorizationKind!=="automatic_server_gate"||!authorization.releaseGates.AUTONOMOUS_MODE_ENABLED||!authorization.entitlements.automaticMode))throw new DomainError("AUTOMATIC_EXECUTION_LOCKED","Automatic execution is not authorized by current server gates and entitlements",403);
  }
  async #markAmbiguous(input:SubmissionInput,aggregate:ProposalAggregate,reasonCode:string):Promise<ProposalAggregate>{
    if(aggregate.status==="RECONCILIATION_ERROR"||aggregate.status==="FILLED")return aggregate;
    if(!["SUBMITTING","SUBMITTED","PARTIALLY_FILLED"].includes(aggregate.status))return aggregate;
    return this.#transition(input,aggregate,"RECONCILIATION_ERROR",`placement-ambiguous-${reasonCode.toLowerCase().replace(/[^a-z0-9]+/g,"-").slice(0,40)}`);
  }
  async #applySubmission(input:SubmissionInput,starting:ProposalAggregate,submission:BrokerSubmission):Promise<ProposalAggregate>{
    let aggregate=starting;const actor=this.broker.environment==="live"?"broker":"worker";
    if((aggregate.status==="FILLED"&&submission.status!=="filled")||(aggregate.status==="PARTIALLY_FILLED"&&submission.status==="submitted")||(aggregate.status==="REJECTED"&&submission.status!=="rejected"))throw new DomainError("BROKER_STATE_REGRESSION","Broker reconciliation cannot regress persisted proposal state",409);
    if(submission.status==="rejected"){
      if(aggregate.status==="FILLED")throw new DomainError("BROKER_STATE_REGRESSION","Broker rejection cannot replace a filled proposal",409);
      if(aggregate.status!=="REJECTED")aggregate=await this.#transition(input,aggregate,"REJECTED","broker-rejected",actor);
      return aggregate;
    }
    if(aggregate.status==="SUBMITTING"||aggregate.status==="RECONCILIATION_ERROR")aggregate=await this.#transition(input,aggregate,"SUBMITTED","broker-submitted",actor);
    if(submission.status==="partially_filled"&&aggregate.status==="SUBMITTED")aggregate=await this.#transition(input,aggregate,"PARTIALLY_FILLED","broker-partial",actor);
    if(submission.status==="filled"&&aggregate.status!=="FILLED")aggregate=await this.#transition(input,aggregate,"FILLED","broker-filled",actor);
    return aggregate;
  }
  #transition(input:SubmissionInput,aggregate:ProposalAggregate,toStatus:TransitionCommand["toStatus"],reason:string,actorType:TransitionCommand["actorType"]="worker"):Promise<ProposalAggregate>{return this.store.transition(aggregate.proposal.proposalId,aggregate.version,{toStatus,actorType,actorId:"execution-worker",reasonCode:`EXECUTION_${reason.toUpperCase().replace(/[^A-Z0-9]+/g,"_")}`,correlationId:input.correlationId,idempotencyKey:`${input.idempotencyKey}:v${aggregate.version}:${toStatus.toLowerCase()}`,occurredAt:input.now});}
  #outcome(input:SubmissionInput,aggregate:ProposalAggregate,review:BrokerReview,submission:BrokerSubmission,riskFingerprint:string):ExecutionOutcome{const outcome=Object.freeze({proposalId:aggregate.proposal.proposalId,review,submission,aggregate,riskFingerprint});this.#outcomes.set(`${aggregate.proposal.proposalId}:${input.idempotencyKey}`,outcome);return outcome;}
}
