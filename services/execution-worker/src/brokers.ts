import { createHash, randomUUID } from "node:crypto";
import { DomainError, type ProposalStatus, type TradeProposal } from "@whox/contracts";
import { liveTradingGatesSatisfied, type ReleaseGates } from "@whox/shared-config";
import { LIVE_PLACEMENT_TOOLS, McpStreamableHttpClient } from "./mcp-client.js";

export interface BrokerWarning {readonly code:string;readonly severity:"informational"|"warning"|"blocking";readonly message:string;}
export interface ExecutionMarketQuote {readonly verifiedBy:"approved-market-data-store";readonly symbol:string;readonly bid:number;readonly ask:number;readonly last:number;readonly sourceTimestamp:string;readonly provider:string;}
export interface BrokerReviewContext {readonly marketQuote?:ExecutionMarketQuote;readonly priorProposalStatus?:ProposalStatus;}
export interface BrokerReview {readonly reviewId:string;readonly accountId:string;readonly proposalId:string;readonly warnings:readonly BrokerWarning[];readonly reviewedAt:string;readonly marketQuote?:ExecutionMarketQuote;readonly rawReference?:string;}
export interface BrokerSubmission {readonly brokerOrderId:string;readonly status:"submitted"|"partially_filled"|"filled"|"rejected";readonly submittedAt:string;readonly filledQuantity:number;readonly averageFillPrice?:number;readonly rawReference?:string;}
export interface BrokerCancellation {readonly brokerOrderId:string;readonly canceled:boolean;readonly status:string;readonly occurredAt:string;}
export type PlacementReconciliation =
  | {readonly resolution:"found";readonly review:BrokerReview;readonly submission:BrokerSubmission}
  | {readonly resolution:"not_found"}
  | {readonly resolution:"unknown";readonly reasonCode:string};

export interface BrokerGateway {
  readonly environment:"demo"|"paper"|"live";
  review(proposal:TradeProposal,now:string,context?:BrokerReviewContext):Promise<BrokerReview>;
  place(proposal:TradeProposal,review:BrokerReview,idempotencyKey:string,now:string):Promise<BrokerSubmission>;
  reconcilePlacement(proposal:TradeProposal,idempotencyKey:string,now:string,context?:BrokerReviewContext):Promise<PlacementReconciliation>;
  cancel(brokerOrderId:string,idempotencyKey:string,now:string):Promise<BrokerCancellation>;
}

export interface PaperExecutionAssumptions {
  readonly quoteDelaySeconds:number;readonly slippageBasisPoints:number;readonly commissionPerOrder:number;
  readonly partialFillThresholdShares:number;readonly fillAtLimitOrBetter:boolean;
}
export const DEFAULT_PAPER_ASSUMPTIONS:PaperExecutionAssumptions=Object.freeze({quoteDelaySeconds:0,slippageBasisPoints:2,commissionPerOrder:0,partialFillThresholdShares:100,fillAtLimitOrBetter:true});

interface PaperOrderState {readonly submission:BrokerSubmission;readonly proposalId:string;readonly canceled:boolean;}
export class PaperBroker implements BrokerGateway {
  public readonly environment:"demo"|"paper";
  readonly #submissions=new Map<string,PaperOrderState>();readonly #cancellations=new Map<string,BrokerCancellation>();
  public constructor(environment:"demo"|"paper"="paper",private readonly assumptions:PaperExecutionAssumptions=DEFAULT_PAPER_ASSUMPTIONS){this.environment=environment;if(!Number.isFinite(assumptions.slippageBasisPoints)||assumptions.slippageBasisPoints<0||!Number.isFinite(assumptions.partialFillThresholdShares)||assumptions.partialFillThresholdShares<=0||!Number.isFinite(assumptions.quoteDelaySeconds)||assumptions.quoteDelaySeconds<0)throw new TypeError("Paper execution assumptions must contain finite non-negative values and a positive fill threshold");}
  public async review(proposal:TradeProposal,now:string,context?:BrokerReviewContext):Promise<BrokerReview>{
    if(proposal.environment!==this.environment)throw new DomainError("BROKER_ENVIRONMENT_MISMATCH","Proposal environment does not match paper broker",409);
    const fallback=proposal.limitPrice??proposal.stopPrice??proposal.notionalEstimate/proposal.quantity;
    const quote=context?.marketQuote??(this.environment==="demo"&&Number.isFinite(fallback)&&fallback>0?Object.freeze({verifiedBy:"approved-market-data-store" as const,symbol:proposal.symbol,bid:fallback,ask:fallback,last:fallback,sourceTimestamp:now,provider:"whox-demo-fixture"}):undefined);
    if(quote===undefined)throw new DomainError("PAPER_MARKET_DATA_REQUIRED","Paper review requires a fresh quote from an approved persisted provider",503);
    const quoteAge=(Date.parse(now)-Date.parse(quote.sourceTimestamp))/1_000;if(quote.verifiedBy!=="approved-market-data-store"||quote.symbol!==proposal.symbol||!Number.isFinite(quote.bid)||!Number.isFinite(quote.ask)||!Number.isFinite(quote.last)||quote.bid<0||quote.ask<quote.bid||quote.last<=0||!Number.isFinite(quoteAge)||quoteAge< -5||quoteAge>30)throw new DomainError("PAPER_MARKET_DATA_INVALID","Paper quote provenance, prices, or freshness are invalid",503);
    const warnings:BrokerWarning[]=[];if(proposal.orderType==="market")warnings.push({code:"PAPER_MARKET_SLIPPAGE",severity:"warning",message:"Paper market fill includes the configured slippage assumption."});
    return Object.freeze({reviewId:`paper-review-${proposal.proposalId}`,accountId:proposal.accountId,proposalId:proposal.proposalId,warnings:Object.freeze(warnings),reviewedAt:now,marketQuote:quote});
  }
  public async place(proposal:TradeProposal,review:BrokerReview,idempotencyKey:string,now:string):Promise<BrokerSubmission>{
    const prior=this.#submissions.get(idempotencyKey);if(prior!==undefined)return prior.submission;
    if(review.proposalId!==proposal.proposalId||review.accountId!==proposal.accountId)throw new DomainError("BROKER_REVIEW_MISMATCH","Broker review does not match proposal and account",409);
    if(review.warnings.some((warning)=>warning.severity==="blocking"))throw new DomainError("BROKER_REVIEW_BLOCKING","Broker review contains a blocking warning",422);
    if(!Number.isFinite(proposal.quantity)||proposal.quantity<=0||!Number.isFinite(proposal.notionalEstimate)||proposal.notionalEstimate<=0)throw new DomainError("BROKER_ORDER_NUMERIC_INVALID","Quantity and notional must be finite and positive",422);
    const quote=review.marketQuote;if(this.environment==="paper"&&quote===undefined)throw new DomainError("PAPER_MARKET_DATA_REQUIRED","Paper placement requires its approved reviewed quote",503);
    const referencePrice=quote===undefined?(proposal.limitPrice??proposal.stopPrice??proposal.notionalEstimate/proposal.quantity):(proposal.side==="buy"?quote.ask:quote.bid);
    if(!Number.isFinite(referencePrice)||referencePrice<=0)throw new DomainError("BROKER_ORDER_PRICE_INVALID","Paper reference price must be finite and positive",422);
    const marketable=proposal.limitPrice===undefined||(proposal.side==="buy"?proposal.limitPrice>=referencePrice:proposal.limitPrice<=referencePrice);const stopTriggered=proposal.stopPrice===undefined||(proposal.side==="buy"?Number(quote?.last??referencePrice)>=proposal.stopPrice:Number(quote?.last??referencePrice)<=proposal.stopPrice);if(!marketable||!stopTriggered){const submission:BrokerSubmission=Object.freeze({brokerOrderId:`paper-${createHash("sha256").update(`${proposal.proposalId}:${idempotencyKey}`).digest("hex").slice(0,24)}`,status:"submitted",submittedAt:now,filledQuantity:0});this.#submissions.set(idempotencyKey,{submission,proposalId:proposal.proposalId,canceled:false});return submission;}
    const slippage=this.assumptions.slippageBasisPoints/10_000*(proposal.side==="buy"?1:-1);const slippedPrice=referencePrice*(1+slippage);const fillPrice=proposal.limitPrice!==undefined&&this.assumptions.fillAtLimitOrBetter?(proposal.side==="buy"?Math.min(proposal.limitPrice,slippedPrice):Math.max(proposal.limitPrice,slippedPrice)):slippedPrice;
    const partial=proposal.quantity>this.assumptions.partialFillThresholdShares;const filledQuantity=partial?Math.max(1,Math.floor(proposal.quantity/2)):proposal.quantity;
    const orderId=`paper-${createHash("sha256").update(`${proposal.proposalId}:${idempotencyKey}`).digest("hex").slice(0,24)}`;
    const submission:BrokerSubmission=Object.freeze({brokerOrderId:orderId,status:partial?"partially_filled":"filled",submittedAt:now,filledQuantity,averageFillPrice:Number(fillPrice.toFixed(4))});
    this.#submissions.set(idempotencyKey,{submission,proposalId:proposal.proposalId,canceled:false});return submission;
  }
  public async reconcilePlacement(proposal:TradeProposal,idempotencyKey:string,now:string,context?:BrokerReviewContext):Promise<PlacementReconciliation>{
    const prior=this.#submissions.get(idempotencyKey);if(prior!==undefined)return Object.freeze({resolution:"found",review:await this.review(proposal,now,context),submission:prior.submission});
    if(context?.priorProposalStatus!==undefined&&["SUBMITTED","PARTIALLY_FILLED","FILLED","REJECTED"].includes(context.priorProposalStatus)){const review=await this.review(proposal,now,context);const submission=await this.place(proposal,review,idempotencyKey,now);return Object.freeze({resolution:"found",review,submission});}
    return Object.freeze({resolution:"not_found"});
  }
  public async cancel(brokerOrderId:string,idempotencyKey:string,now:string):Promise<BrokerCancellation>{
    const prior=this.#cancellations.get(idempotencyKey);if(prior!==undefined)return prior;
    const order=[...this.#submissions.values()].find((value)=>value.submission.brokerOrderId===brokerOrderId);if(order===undefined)throw new DomainError("ORDER_NOT_FOUND","Paper order was not found",404);
    const terminal=order.submission.status==="filled"||order.submission.status==="rejected";const result=Object.freeze({brokerOrderId,canceled:!terminal,status:terminal?order.submission.status:"canceled",occurredAt:now});this.#cancellations.set(idempotencyKey,result);return result;
  }
}

export interface RobinhoodOrderArgumentMapper {
  readonly approvedMappingVersion:string;
  mapReview(proposal:TradeProposal,verifiedAccountId:string,discoveredInputSchema:Readonly<Record<string,unknown>>):Readonly<Record<string,unknown>>;
  parseReview(result:Readonly<Record<string,unknown>>,proposal:TradeProposal,now:string):BrokerReview;
  mapPlace(proposal:TradeProposal,review:BrokerReview,verifiedAccountId:string,discoveredInputSchema:Readonly<Record<string,unknown>>):Readonly<Record<string,unknown>>;
  parsePlacement(result:Readonly<Record<string,unknown>>,proposal:TradeProposal,now:string):BrokerSubmission;
  mapCancel(brokerOrderId:string,verifiedAccountId:string,discoveredInputSchema:Readonly<Record<string,unknown>>):Readonly<Record<string,unknown>>;
  parseCancellation(result:Readonly<Record<string,unknown>>,brokerOrderId:string,now:string):BrokerCancellation;
}

export class UnconfiguredRobinhoodOrderMapper implements RobinhoodOrderArgumentMapper {
  public readonly approvedMappingVersion="unconfigured";
  #blocked():never{throw new DomainError("ROBINHOOD_ORDER_MAPPING_UNAPPROVED","No approved Robinhood order-schema mapping is configured; live execution is locked",503);}
  public mapReview():never{return this.#blocked();} public parseReview():never{return this.#blocked();}
  public mapPlace():never{return this.#blocked();} public parsePlacement():never{return this.#blocked();}
  public mapCancel():never{return this.#blocked();} public parseCancellation():never{return this.#blocked();}
}

export class RobinhoodMcpBroker implements BrokerGateway {
  public readonly environment="live" as const;readonly #placements=new Map<string,BrokerSubmission>();readonly #cancellations=new Map<string,BrokerCancellation>();readonly #orderInstruments=new Map<string,TradeProposal["instrumentType"]>();
  public constructor(private readonly client:McpStreamableHttpClient,private readonly verifiedAccountId:string,private readonly gates:ReleaseGates,private readonly mapper:RobinhoodOrderArgumentMapper=new UnconfiguredRobinhoodOrderMapper()){}
  #tool(proposal:TradeProposal,operation:"review"|"place"):string{return `${operation}_${proposal.instrumentType}_order`;}
  #schema(name:string):Readonly<Record<string,unknown>>{const tool=this.client.tools.find((candidate)=>candidate.name===name);if(tool===undefined)throw new DomainError("BROKER_CAPABILITY_UNAVAILABLE",`Broker tool ${name} is unavailable`,503);return tool.inputSchema;}
  #assertLive(proposal:TradeProposal):void{
    if(proposal.environment!=="live")throw new DomainError("BROKER_ENVIRONMENT_MISMATCH","Robinhood broker only accepts live proposals",409);
    if(proposal.accountId!==this.verifiedAccountId)throw new DomainError("BROKER_ACCOUNT_BINDING_INVALID","Proposal does not target the verified Agentic Account",403);
    if(!liveTradingGatesSatisfied(this.gates,proposal.instrumentType,proposal.requiredApprovalMode))throw new DomainError("LIVE_TRADING_LOCKED","Applicable live-trading release gates are not enabled",503);
  }
  public async review(proposal:TradeProposal,now:string):Promise<BrokerReview>{this.#assertLive(proposal);const name=this.#tool(proposal,"review");const args=this.mapper.mapReview(proposal,this.verifiedAccountId,this.#schema(name));const result=await this.client.callTool(name,args);const review=this.mapper.parseReview(result,proposal,now);if(review.accountId!==this.verifiedAccountId||review.proposalId!==proposal.proposalId)throw new DomainError("BROKER_REVIEW_MISMATCH","Parsed review is not bound to the verified account and proposal",502);return review;}
  public async place(proposal:TradeProposal,review:BrokerReview,idempotencyKey:string,now:string):Promise<BrokerSubmission>{const prior=this.#placements.get(idempotencyKey);if(prior!==undefined)return prior;this.#assertLive(proposal);if(review.accountId!==this.verifiedAccountId||review.proposalId!==proposal.proposalId)throw new DomainError("BROKER_REVIEW_MISMATCH","Broker review does not match verified account and proposal",409);if(review.warnings.some((warning)=>warning.severity==="blocking"))throw new DomainError("BROKER_REVIEW_BLOCKING","Broker review contains a blocking warning",422);
    const name=this.#tool(proposal,"place");if(!LIVE_PLACEMENT_TOOLS.has(name))throw new DomainError("BROKER_PLACEMENT_FORBIDDEN","Tool is not an allowlisted placement tool",403);const args=this.mapper.mapPlace(proposal,review,this.verifiedAccountId,this.#schema(name));const result=await this.client.callTool(name,args);const submission=this.mapper.parsePlacement(result,proposal,now);this.#placements.set(idempotencyKey,submission);this.#orderInstruments.set(submission.brokerOrderId,proposal.instrumentType);return submission;}
  public async reconcilePlacement(proposal:TradeProposal,idempotencyKey:string,now:string):Promise<PlacementReconciliation>{const prior=this.#placements.get(idempotencyKey);if(prior!==undefined)return Object.freeze({resolution:"found",review:await this.review(proposal,now),submission:prior});return Object.freeze({resolution:"unknown",reasonCode:"BROKER_RECONCILIATION_MAPPING_UNAPPROVED"});}
  public async cancel(brokerOrderId:string,idempotencyKey:string,now:string):Promise<BrokerCancellation>{const prior=this.#cancellations.get(idempotencyKey);if(prior!==undefined)return prior;const instrument=this.#orderInstruments.get(brokerOrderId);if(instrument===undefined)throw new DomainError("ORDER_INSTRUMENT_UNKNOWN","Persisted order instrument is required before cancellation",409);const name=`cancel_${instrument}_order`;if(!this.client.hasTool(name))throw new DomainError("BROKER_CAPABILITY_UNAVAILABLE",`Broker tool ${name} is unavailable`,503);const args=this.mapper.mapCancel(brokerOrderId,this.verifiedAccountId,this.#schema(name));const result=await this.client.callTool(name,args);const cancellation=this.mapper.parseCancellation(result,brokerOrderId,now);this.#cancellations.set(idempotencyKey,cancellation);return cancellation;}
}

export function createExecutionAttemptId():string{return randomUUID();}
