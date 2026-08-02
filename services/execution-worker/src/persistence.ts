import { randomUUID } from "node:crypto";
import { DomainError, validateTradeProposal, type ApprovalMode, type Entitlements, type ReleaseGates, type RiskPolicy, type ProposalStatus, type ProposalTransition } from "@whox/contracts";
import { transitionProposal, type ProposalAggregate, type ProposalStore, type TransitionCommand } from "@whox/agent-orchestrator";
import { Pool, type PoolClient } from "pg";
import { validateUserPolicyAgainstPlatform, type RiskContext } from "@whox/risk-schemas";
import type { ExecutionAuthorization, ExecutionOutcome } from "./index.js";

const REQUIRED_LEGAL_DOCUMENTS = Object.freeze(["terms", "privacy", "ai-risk"] as const);
const CAPABILITY_MAX_AGE_SECONDS = 300;
const CLOCK_SKEW_MILLISECONDS = 5_000;
const FOUNDATION_EQUITY_CAPABILITIES = Object.freeze([
  "get_equity_quotes",
  "get_equity_tradability",
  "review_equity_order"
] as const);
const PAPER_SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,14}$/;
const PAPER_SECTOR_MAX_LENGTH = 100;

interface ProposalRow {proposal:unknown;status:ProposalStatus;version:number;created_at:Date;updated_at:Date;}
interface AuthorizationRow extends ProposalRow {
  owner_user_id:string;broker_account_id:string;environment:"demo"|"paper"|"live";user_status:"active"|"suspended"|"closed";account_mode:"demo"|"paper"|"live";
  broker_active:boolean;is_agentic_account:boolean;verified_for_trading_at:Date|null;connection_status:string;connection_revoked_at:Date|null;
  user_agent_status:string;user_agent_environment:"demo"|"paper"|"live";approval_mode:ApprovalMode;user_agent_deleted_at:Date|null;
  agent_version_matches:boolean;agent_definition_id:string;agent_version:string;deterministic_strategy_version:string;agent_version_status:string;agent_definition:unknown;
  policy_id:string|null;policy_version:number|null;policy_limits:unknown;policy_exclusions:unknown;policy_effective_at:Date|null;
  plan_features:unknown;plan_agent_catalog_version:number|null;plan_agent_version_mapped:boolean|null;entitlement_values:unknown;
  market_provider:string|null;market_payload:unknown;market_source_timestamp:Date|null;
  approval_id:string|null;approval_user_id:string|null;approval_status:string|null;approval_requested_at:Date|null;approval_expires_at:Date|null;approval_acted_at:Date|null;authentication_context:unknown;
}

interface PersistedPolicyRow {
  owner_user_id:string;policy_id:string|null;policy_version:number|null;policy_limits:unknown;
  policy_exclusions:unknown;policy_effective_at:Date|null;
}

interface PaperExecutionBindingRow {
  owner_user_id:string;environment:"demo"|"paper"|"live";broker_account_id:string;
  user_status:"active"|"suspended"|"closed";account_mode:"demo"|"paper"|"live";
  account_active:boolean;is_agentic_account:boolean;verified_for_trading_at:Date|null;
  connection_id:string;connection_provider:string;connection_status:string;connection_last_sync_at:Date|null;connection_revoked_at:Date|null;
  user_agent_id:string;user_agent_status:string;user_agent_environment:"demo"|"paper"|"live";
  allocation_limit:string;approval_mode:ApprovalMode;user_agent_deleted_at:Date|null;
  agent_version_id:string;agent_version:string;agent_version_status:string;deterministic_strategy_version:string;
  persisted_definition:unknown;agent_definition_id:string;agent_key:string;approval_expires_at:Date|null;
}

interface PaperPortfolioRow {
  id:string;total_value:string;buying_power:string;source_timestamp:Date;valid_until:Date;
  sync_completed_at:Date;snapshot_fingerprint:string;
}
interface PaperPositionRow {symbol:string;instrument_type:"equity"|"option";quantity:string;market_value:string;details:unknown;}
interface PaperQuoteRow {
  id:string;provider:string;symbol:string;payload:unknown;source_timestamp:Date;received_at:Date;delayed_by_seconds:number;
}
interface PaperReconciliationQuoteRow {
  provider:string;symbol:string;payload:unknown;source_timestamp:Date;received_at:Date;delayed_by_seconds:number;
}
interface PaperReconciliationQuote {
  bid:number;ask:number;last:number;tradable:boolean;liquiditySufficient:boolean;
  marketSession:"open"|"extended"|"closed";volatilityHalt:boolean;tradingHalt:boolean;
  corporateActionRestricted:boolean;brokerWarningSeverity:"none"|"informational"|"blocking";
}
interface PaperOperationalMetricsRow {
  own_reservations:string;other_reservations:string;proposal_reservation_count:string;
  proposal_reserved_amount:string;proposal_reservation_side_matches:boolean;
  trades_today:string;turnover_notional:string;duplicate_proposal:boolean;duplicate_open_order:boolean;
  peak_value:string|null;opening_value:string|null;active_risk_halt:boolean;active_security_halt:boolean;
  active_system_incident:boolean;
}

interface PaperParsedQuote {
  readonly sourceTimestamp:string;readonly bid:number;readonly ask:number;readonly last:number;
  readonly tradable:boolean;readonly fractionalSupported:boolean;readonly liquiditySufficient:boolean;
  readonly marketSession:"open"|"extended"|"closed";readonly volatilityHalt:boolean;
  readonly tradingHalt:boolean;readonly corporateActionRestricted:boolean;readonly earningsWindow:boolean;
  readonly sector:string;readonly brokerWarningSeverity:"none"|"informational"|"blocking";
}

export interface AuthorizedExecution {readonly aggregate:ProposalAggregate;readonly policy:RiskPolicy;readonly authorization:ExecutionAuthorization;}
export type PaperReconciliationDisposition =
  | {readonly resolution:"completed"}
  | {readonly resolution:"deferred";readonly retryAt:string;readonly reasonCode:string};

export class PostgresProposalStore implements ProposalStore {
  public constructor(private readonly pool:Pool,private readonly userId:string){}
  public async create():Promise<ProposalAggregate>{throw new DomainError("PROPOSAL_CREATE_FORBIDDEN","Execution worker cannot create proposals",403);}
  public async get(proposalId:string):Promise<ProposalAggregate|undefined>{return this.#transaction(async(client)=>{await client.query(`SELECT set_config('app.user_id',$1,true)`,[this.userId]);const result=await client.query<ProposalRow>(`SELECT proposal,status,version,created_at,updated_at FROM trade_proposals WHERE id=$1 AND user_id=$2`,[proposalId,this.userId]);const row=result.rows[0];return row===undefined?undefined:this.#aggregate(row);});}
  public async loadApproved(proposalId:string,now:string,releaseGates:ReleaseGates,approvedMarketDataProviders:readonly string[]):Promise<AuthorizedExecution>{const execution=await this.#loadAuthorized(proposalId,now,releaseGates,approvedMarketDataProviders,true);if(execution.aggregate.status!=="APPROVED")throw new DomainError("PROPOSAL_NOT_APPROVED","Only a freshly approved proposal can begin submission",409);if(!execution.authorization.placementAuthorized)throw new DomainError("APPROVAL_NOT_CURRENT","A current authenticated approval or autonomous authorization is required",409);return execution;}
  public async loadRecoverable(proposalId:string,now:string,releaseGates:ReleaseGates,approvedMarketDataProviders:readonly string[]):Promise<AuthorizedExecution>{const execution=await this.#loadAuthorized(proposalId,now,releaseGates,approvedMarketDataProviders,false);if(!["SUBMITTING","SUBMITTED","PARTIALLY_FILLED","FILLED","REJECTED","RECONCILIATION_ERROR"].includes(execution.aggregate.status))throw new DomainError("PROPOSAL_NOT_RECOVERABLE","Proposal is not in a recoverable execution state",409);return execution;}
  public async transition(proposalId:string,expectedVersion:number,command:TransitionCommand):Promise<ProposalAggregate>{return this.#transaction(async(client)=>{await client.query(`SELECT set_config('app.user_id',$1,true)`,[this.userId]);const result=await client.query<ProposalRow>(`SELECT proposal,status,version,created_at,updated_at FROM trade_proposals WHERE id=$1 AND user_id=$2 FOR UPDATE`,[proposalId,this.userId]);const row=result.rows[0];if(row===undefined)throw new DomainError("PROPOSAL_NOT_FOUND","Proposal was not found",404);if(row.version!==expectedVersion)throw new DomainError("PROPOSAL_VERSION_CONFLICT","Proposal changed concurrently",409);const next=transitionProposal(this.#aggregate(row),command);const updated=await client.query(`UPDATE trade_proposals SET status=$3::proposal_status,version=$4,updated_at=$5::timestamptz WHERE id=$1 AND user_id=$2 AND version=$6`,[proposalId,this.userId,next.status,next.version,next.updatedAt,expectedVersion]);if(updated.rowCount!==1)throw new DomainError("PROPOSAL_VERSION_CONFLICT","Proposal changed concurrently",409);const event=next.transitions.at(-1)!;await client.query(`INSERT INTO trade_proposal_events(proposal_id,user_id,from_status,to_status,actor_type,actor_id,reason_code,correlation_id,idempotency_key,metadata,occurred_at) VALUES($1,$2,$3::proposal_status,$4::proposal_status,$5,$6,$7,$8,$9,$10::jsonb,$11::timestamptz)`,[proposalId,this.userId,event.fromStatus,event.toStatus,event.actorType,event.actorId,event.reasonCode,event.correlationId,event.idempotencyKey,JSON.stringify(event.metadata??{}),event.occurredAt]);return next;});}
  #aggregate(row:ProposalRow):ProposalAggregate{const proposal=validateTradeProposal(row.proposal);return Object.freeze({proposal,status:row.status,version:row.version,transitions:Object.freeze([] as ProposalTransition[]),createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString()});}
  async #loadAuthorized(proposalId:string,now:string,releaseGates:ReleaseGates,approvedMarketDataProviders:readonly string[],requireCurrentProposalData:boolean):Promise<AuthorizedExecution>{return this.#transaction(async(client)=>{
    await client.query(`SELECT set_config('app.user_id',$1,true)`,[this.userId]);
    const result=await client.query<AuthorizationRow>(`SELECT proposal.proposal,proposal.status,proposal.version,proposal.created_at,proposal.updated_at,
      proposal.user_id::text AS owner_user_id,proposal.broker_account_id::text,proposal.environment,
      app_user.status AS user_status,app_user.account_mode,account.active AS broker_active,account.is_agentic_account,
      account.verified_for_trading_at,connection.status AS connection_status,connection.revoked_at AS connection_revoked_at,user_agent.status AS user_agent_status,
      user_agent.environment AS user_agent_environment,user_agent.approval_mode,user_agent.deleted_at AS user_agent_deleted_at,
      (user_agent.agent_version_id=proposal.agent_version_id) AS agent_version_matches,
      definition.id::text AS agent_definition_id,version.version AS agent_version,version.deterministic_strategy_version,
      version.status AS agent_version_status,version.definition AS agent_definition,
      policy.id::text AS policy_id,policy.version AS policy_version,policy.limits AS policy_limits,
      policy.exclusions AS policy_exclusions,policy.effective_at AS policy_effective_at,
      subscription.plan_features,subscription.plan_agent_catalog_version,subscription.plan_agent_version_mapped,
      entitlement.entitlement_values,market.provider AS market_provider,
      market.payload AS market_payload,market.source_timestamp AS market_source_timestamp,
      approval.id::text AS approval_id,approval.user_id::text AS approval_user_id,approval.status AS approval_status,
      approval.requested_at AS approval_requested_at,approval.expires_at AS approval_expires_at,
      approval.acted_at AS approval_acted_at,approval.authentication_context
      FROM trade_proposals AS proposal
      JOIN users AS app_user ON app_user.id=proposal.user_id
      JOIN broker_accounts AS account ON account.id=proposal.broker_account_id AND account.user_id=proposal.user_id
      JOIN broker_connections AS connection ON connection.id=account.connection_id AND connection.user_id=proposal.user_id
      JOIN agent_runs AS run ON run.id=proposal.agent_run_id AND run.user_id=proposal.user_id
      JOIN user_agents AS user_agent ON user_agent.id=run.user_agent_id AND user_agent.user_id=proposal.user_id
      JOIN agent_versions AS version ON version.id=proposal.agent_version_id
      JOIN agent_definitions AS definition ON definition.id=version.agent_definition_id
      LEFT JOIN LATERAL (SELECT current_policy.* FROM risk_policies AS current_policy
        WHERE current_policy.user_id=proposal.user_id AND current_policy.effective_at<=$3::timestamptz
          AND (current_policy.superseded_at IS NULL OR current_policy.superseded_at>$3::timestamptz)
        ORDER BY current_policy.version DESC LIMIT 1) AS policy ON true
      LEFT JOIN LATERAL (SELECT plan.features AS plan_features,catalog.version AS plan_agent_catalog_version,
          (entry.agent_version_id IS NOT NULL) AS plan_agent_version_mapped
        FROM subscriptions AS current_subscription
        JOIN plans AS plan ON plan.id=current_subscription.plan_id AND plan.active
        LEFT JOIN plan_agent_catalog_versions AS catalog ON catalog.plan_id=plan.id
          AND catalog.activated_at IS NOT NULL AND catalog.superseded_at IS NULL
        LEFT JOIN plan_agent_catalog_entries AS entry ON entry.catalog_version_id=catalog.id
          AND entry.agent_version_id=proposal.agent_version_id
        WHERE current_subscription.user_id=proposal.user_id AND current_subscription.status IN ('active','grace_period')
          AND current_subscription.effective_at<=$3::timestamptz AND current_subscription.revoked_at IS NULL
          AND (current_subscription.expires_at IS NULL OR current_subscription.expires_at>$3::timestamptz)
        ORDER BY current_subscription.effective_at DESC LIMIT 1) AS subscription ON true
      LEFT JOIN LATERAL (SELECT jsonb_object_agg(latest.feature_key,latest.value) AS entitlement_values FROM
        (SELECT DISTINCT ON (feature_key) feature_key,value FROM entitlements
          WHERE user_id=proposal.user_id AND effective_at<=$3::timestamptz AND (expires_at IS NULL OR expires_at>$3::timestamptz)
          ORDER BY feature_key,effective_at DESC) AS latest) AS entitlement ON true
      LEFT JOIN LATERAL (SELECT request.* FROM approval_requests AS request
        WHERE request.proposal_id=proposal.id AND request.user_id=proposal.user_id AND request.status IN ('approved','expired') AND request.acted_at IS NOT NULL
        ORDER BY request.acted_at DESC NULLS LAST,request.requested_at DESC LIMIT 1) AS approval ON true
      LEFT JOIN LATERAL (SELECT snapshot.provider,snapshot.payload,snapshot.source_timestamp FROM market_data_snapshots AS snapshot
        WHERE snapshot.symbol=proposal.symbol AND snapshot.data_type='quote' AND snapshot.provider=ANY($4::text[])
          AND snapshot.source_timestamp<=$3::timestamptz+interval '5 seconds'
        ORDER BY snapshot.source_timestamp DESC LIMIT 1) AS market ON true
      WHERE proposal.id=$2 AND proposal.user_id=$1`,[this.userId,proposalId,now,approvedMarketDataProviders]);
    const row=result.rows[0];if(row===undefined)throw new DomainError("PROPOSAL_NOT_FOUND","Proposal or an authoritative ownership binding was not found",404);
    const aggregate=this.#aggregate(row);const proposal=aggregate.proposal;const nowInstant=Date.parse(now);
    if(!Number.isFinite(nowInstant))throw new DomainError("EXECUTION_TIME_INVALID","Execution time is invalid",422);
    if(row.owner_user_id!==this.userId||proposal.userId!==row.owner_user_id||proposal.accountId!==row.broker_account_id)throw new DomainError("EXECUTION_BINDING_INVALID","Proposal JSON does not match persisted user and account bindings",403);
    if(proposal.environment!==row.environment||row.account_mode!==proposal.environment||row.user_agent_environment!==proposal.environment)throw new DomainError("EXECUTION_MODE_MISMATCH","Persisted user, agent, and proposal modes do not match",409);
    if(row.user_status!=="active")throw new DomainError("EXECUTION_USER_INACTIVE","Proposal owner is not active",403);
    if(!row.broker_active||!row.is_agentic_account||row.connection_status!=="connected"||row.connection_revoked_at!==null||(proposal.environment!=="demo"&&row.verified_for_trading_at===null))throw new DomainError("BROKER_ACCOUNT_BINDING_INVALID","A current verified Agentic Account binding is required",403);
    if(row.user_agent_deleted_at!==null||row.approval_mode!==proposal.requiredApprovalMode||!row.agent_version_matches||row.agent_definition_id!==proposal.agentDefinitionId||row.agent_version!==proposal.agentVersion||row.deterministic_strategy_version!==proposal.deterministicStrategyVersion)throw new DomainError("AGENT_BINDING_INVALID","Current agent configuration does not match the proposal",409);
    const permittedModes=record(row.agent_definition).permittedAccountModes;if(!Array.isArray(permittedModes)||!permittedModes.includes(proposal.environment)||!["paper","limited_rollout","live"].includes(row.agent_version_status))throw new DomainError("AGENT_VERSION_DISABLED","Agent version is not currently enabled for this mode",403);
    if(!Number.isInteger(Number(row.plan_agent_catalog_version))||row.plan_agent_version_mapped!==true)throw new DomainError("EXECUTION_ENTITLEMENT_BINDING_INVALID","The current subscription plan does not map this exact agent version",403);
    const policy=persistedPolicy(row);const entitlements=persistedEntitlements(row.plan_features,row.entitlement_values);
    if(requireCurrentProposalData&&!proposalMarketDataCurrent(proposal,nowInstant,policy.maximumQuoteAgeSeconds))throw new DomainError("PROPOSAL_REAPPROVAL_REQUIRED","The immutable proposal analysis is stale and must be regenerated and approved again",409,{nonRetryable:true});
    const marketQuote=persistedMarketQuote(row,proposal.symbol,nowInstant,policy.maximumQuoteAgeSeconds,proposal.environment,approvedMarketDataProviders);
    if(proposal.requiredApprovalMode==="observe")throw new DomainError("OBSERVE_MODE_EXECUTION_FORBIDDEN","Observe mode can never execute an order",403);
    let authorizationKind:ExecutionAuthorization["authorizationKind"];let authorizationReference:string;let placementAuthorized=false;
    if(proposal.requiredApprovalMode==="confirm_every_trade"){
      const proof=authenticatedApproval(row,nowInstant,proposal.userId,proposal.proposalId);authorizationKind="authenticated_user";authorizationReference=proof.reference;placementAuthorized=proof.current;
    }else{
      if(row.user_agent_status!=="automatic"||!entitlements.automaticMode||!releaseGates.AUTONOMOUS_MODE_ENABLED)throw new DomainError("AUTOMATIC_EXECUTION_LOCKED","Current agent state, entitlement, and autonomous server gate must all authorize automatic execution",403);
      authorizationKind="automatic_server_gate";authorizationReference="AUTONOMOUS_MODE_ENABLED";placementAuthorized=true;
    }
    const authorization:ExecutionAuthorization=Object.freeze({verifiedBy:"persistent-execution-store",ownerUserId:proposal.userId,verifiedAccountId:proposal.accountId,policyId:policy.policyId,policyVersion:policy.version,approvalMode:proposal.requiredApprovalMode,authorizationKind,authorizationReference,placementAuthorized,entitlements,releaseGates,userStatus:row.user_status,strategyEnabled:["monitoring","waiting_approval","automatic"].includes(row.user_agent_status),agentVersionEnabled:true,accountConnectionHealthy:true,tradingPermission:proposal.environment==="demo"||row.verified_for_trading_at!==null,...(marketQuote===undefined?{}:{marketQuote})});
    return Object.freeze({aggregate,policy,authorization});
  });}
  async #transaction<T>(operation:(client:PoolClient)=>Promise<T>):Promise<T>{const client=await this.pool.connect();try{await client.query("BEGIN");const result=await operation(client);await client.query("COMMIT");return result;}catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}}
}

function record(value:unknown):Readonly<Record<string,unknown>>{return typeof value==="object"&&value!==null&&!Array.isArray(value)?value as Readonly<Record<string,unknown>>:{};}
function finite(value:unknown,name:string):number{if(typeof value!=="number"||!Number.isFinite(value))throw new DomainError("PERSISTED_RISK_POLICY_INVALID",`Current risk policy ${name} is invalid`,500);return value;}
function persistedPolicy(row:PersistedPolicyRow):RiskPolicy{
  if(row.policy_id===null||row.policy_version===null||row.policy_effective_at===null)throw new DomainError("CURRENT_RISK_POLICY_REQUIRED","A current persisted risk policy is required",409);
  const values={...record(row.policy_limits),...record(row.policy_exclusions)};const numberValue=(name:string):number=>finite(values[name],name);const booleanValue=(name:string):boolean=>{const value=values[name];if(typeof value!=="boolean")throw new DomainError("PERSISTED_RISK_POLICY_INVALID",`Current risk policy ${name} is invalid`,500);return value;};
  const list=(name:string):readonly string[]=>{const value=values[name];if(!Array.isArray(value)||!value.every((item)=>typeof item==="string"))throw new DomainError("PERSISTED_RISK_POLICY_INVALID",`Current risk policy ${name} is invalid`,500);return Object.freeze(value.map((item)=>item.toUpperCase()));};
  const policy=Object.freeze({policyId:row.policy_id,userId:row.owner_user_id,maximumAccountAllocation:numberValue("maximumAccountAllocation"),maximumPositionAmount:numberValue("maximumPositionAmount"),maximumNewOrderAmount:numberValue("maximumNewOrderAmount"),maximumDailyLoss:numberValue("maximumDailyLoss"),maximumPortfolioDrawdown:numberValue("maximumPortfolioDrawdown"),minimumBuyingPowerReserve:numberValue("minimumBuyingPowerReserve"),maximumSimultaneousPositions:numberValue("maximumSimultaneousPositions"),maximumSymbolConcentration:numberValue("maximumSymbolConcentration"),maximumSectorConcentration:numberValue("maximumSectorConcentration"),maximumTradesPerDay:numberValue("maximumTradesPerDay"),maximumDailyTurnover:numberValue("maximumDailyTurnover"),maximumOptionsExposure:numberValue("maximumOptionsExposure"),maximumOptionRiskPerTrade:numberValue("maximumOptionRiskPerTrade"),maximumContractsPerTrade:numberValue("maximumContractsPerTrade"),minimumDaysToExpiration:numberValue("minimumDaysToExpiration"),maximumDaysToExpiration:numberValue("maximumDaysToExpiration"),maximumBidAskSpreadRatio:numberValue("maximumBidAskSpreadRatio"),maximumQuoteAgeSeconds:numberValue("maximumQuoteAgeSeconds"),maximumAccountSnapshotAgeSeconds:numberValue("maximumAccountSnapshotAgeSeconds"),maximumPriceDeviationRatio:numberValue("maximumPriceDeviationRatio"),excludedSymbols:list("excludedSymbols"),excludedSectors:list("excludedSectors"),fractionalSharesPermitted:booleanValue("fractionalSharesPermitted"),extendedHoursPermitted:booleanValue("extendedHoursPermitted"),earningsTradesPermitted:booleanValue("earningsTradesPermitted"),coveredCallsPermitted:booleanValue("coveredCallsPermitted"),protectivePutsPermitted:booleanValue("protectivePutsPermitted"),definedRiskSpreadsPermitted:booleanValue("definedRiskSpreadsPermitted"),updatedAt:row.policy_effective_at.toISOString(),version:row.policy_version});
  const violations=validateUserPolicyAgainstPlatform(policy);
  if(violations.length>0)throw new DomainError("PERSISTED_RISK_POLICY_INVALID","Current risk policy exceeds platform safety limits or contains invalid bounds",500,{fields:violations});
  return policy;
}
function persistedEntitlements(planValue:unknown,overrideValue:unknown):Entitlements{const values={...record(planValue),...record(overrideValue)};const boolean=(name:string):boolean=>values[name]===true;const integer=(name:string,fallback:number):number=>typeof values[name]==="number"&&Number.isInteger(values[name])&&Number(values[name])>=0?Number(values[name]):fallback;const maximumActiveAgents=integer("maximumActiveAgents",0);const monitoringFrequencyMinutes=integer("monitoringFrequencyMinutes",Number.MAX_SAFE_INTEGER);const catalog=Array.isArray(values.agentCatalog)&&values.agentCatalog.every((item)=>typeof item==="string"&&item.length>0)?values.agentCatalog as string[]:[];if(maximumActiveAgents<1||maximumActiveAgents>3||monitoringFrequencyMinutes<1||catalog.length<1||catalog.length>3||new Set(catalog).size!==catalog.length)throw new DomainError("PERSISTED_ENTITLEMENTS_INVALID","Current plan entitlements violate the one-to-three-agent contract",500);return Object.freeze({stockTrading:boolean("stockTrading"),optionsTrading:boolean("optionsTrading"),multiLegOptions:boolean("multiLegOptions"),maximumActiveAgents,automaticMode:boolean("automaticMode"),monitoringFrequencyMinutes,advancedAnalytics:boolean("advancedAnalytics"),customWatchlists:boolean("customWatchlists"),scannerAccess:boolean("scannerAccess"),agentCatalog:Object.freeze([...catalog]),prioritySupport:boolean("prioritySupport")});}
function authenticatedApproval(row:AuthorizationRow,now:number,userId:string,proposalId:string):{readonly reference:string;readonly current:boolean}{
  const context=record(row.authentication_context);const contextUser=typeof context.authenticatedUserId==="string"?context.authenticatedUserId:context.userId;const contextReference=typeof context.authenticationContextId==="string"?context.authenticationContextId:context.sessionId;const authenticatedAt=Date.parse(typeof context.authenticatedAt==="string"?context.authenticatedAt:"");const actedAt=row.approval_acted_at?.getTime()??Number.NaN;const requestedAt=row.approval_requested_at?.getTime()??Number.NaN;const expiresAt=row.approval_expires_at?.getTime()??Number.NaN;
  if(row.approval_id===null||row.approval_user_id!==userId||!["approved","expired"].includes(row.approval_status??"")||context.actorType!=="user"||contextUser!==userId||typeof contextReference!=="string"||contextReference.trim()===""||context.action!=="approve_trade_proposal"||context.resourceId!==proposalId||!["app_attest","devicecheck","webauthn"].includes(String(context.method))||(typeof context.sessionId==="string"&&context.sessionId!==contextReference)||(typeof context.authenticationContextId==="string"&&context.authenticationContextId!==contextReference)||!Number.isFinite(authenticatedAt)||!Number.isFinite(actedAt)||!Number.isFinite(requestedAt)||!Number.isFinite(expiresAt)||authenticatedAt>actedAt||actedAt-authenticatedAt>5*60_000||requestedAt>actedAt||actedAt>now)throw new DomainError("AUTHENTICATED_APPROVAL_REQUIRED","A persisted approval by the authenticated proposal owner and bound step-up context is required",403);
  return Object.freeze({reference:row.approval_id,current:row.approval_status==="approved"&&expiresAt>now});
}
function proposalMarketDataCurrent(proposal:ProposalAggregate["proposal"],now:number,maximumAgeSeconds:number):boolean{
  return [proposal.quoteTimestamp,proposal.dataTimestamp].every((timestamp)=>{
    const instant=Date.parse(timestamp);
    return Number.isFinite(instant)&&instant<=now+CLOCK_SKEW_MILLISECONDS&&(now-instant)/1_000<=maximumAgeSeconds;
  });
}
function persistedMarketQuote(row:AuthorizationRow,symbol:string,now:number,maximumAgeSeconds:number,environment:"demo"|"paper"|"live",approvedProviders:readonly string[]):ExecutionAuthorization["marketQuote"]{
  if(environment==="demo"&&row.market_provider===null)return undefined;
  if(approvedProviders.length===0)throw new DomainError("APPROVED_MARKET_DATA_PROVIDERS_REQUIRED","Paper and Live execution require an explicit approved market-data provider allowlist",503);
  const payload=record(row.market_payload);const sourceTimestamp=row.market_source_timestamp?.getTime()??Number.NaN;const bid=payload.bid;const ask=payload.ask;const last=payload.last;
  if(row.market_provider===null||!Number.isFinite(sourceTimestamp))throw new DomainError("AUTHORITATIVE_MARKET_QUOTE_REQUIRED","An approved persisted quote is missing",503,{refreshable:true,reason:"missing"});
  if(!approvedProviders.includes(row.market_provider)||payload.symbol!==symbol||typeof bid!=="number"||!Number.isFinite(bid)||typeof ask!=="number"||!Number.isFinite(ask)||typeof last!=="number"||!Number.isFinite(last)||bid<0||ask<=0||ask<bid||last<=0||sourceTimestamp-now>CLOCK_SKEW_MILLISECONDS)throw new DomainError("AUTHORITATIVE_MARKET_QUOTE_INVALID","The persisted quote does not satisfy its approved provider, symbol, numeric, and clock bindings",503);
  if((now-sourceTimestamp)/1_000>maximumAgeSeconds)throw new DomainError("AUTHORITATIVE_MARKET_QUOTE_REQUIRED","The approved persisted quote is stale",503,{refreshable:true,reason:"stale"});
  return Object.freeze({verifiedBy:"approved-market-data-store",symbol,bid,ask,last,sourceTimestamp:new Date(sourceTimestamp).toISOString(),provider:row.market_provider});
}

async function loadPaperRiskContext(
  client:PoolClient,
  userId:string,
  execution:AuthorizedExecution,
  now:string,
  nowInstant:number
):Promise<RiskContext>{
  const proposal=execution.aggregate.proposal;
  const bindingResult=await client.query<PaperExecutionBindingRow>(
    `SELECT proposal.user_id::text AS owner_user_id,proposal.environment,proposal.broker_account_id::text,
       app_user.status AS user_status,app_user.account_mode,account.active AS account_active,account.is_agentic_account,
       account.verified_for_trading_at,connection.id::text AS connection_id,connection.provider AS connection_provider,
       connection.status AS connection_status,connection.last_sync_at AS connection_last_sync_at,
       connection.revoked_at AS connection_revoked_at,
       user_agent.id::text AS user_agent_id,user_agent.status AS user_agent_status,
       user_agent.environment AS user_agent_environment,user_agent.allocation_limit::text,user_agent.approval_mode,
       user_agent.deleted_at AS user_agent_deleted_at,version.id::text AS agent_version_id,version.version AS agent_version,
       version.status AS agent_version_status,version.deterministic_strategy_version,version.definition AS persisted_definition,
       definition.id::text AS agent_definition_id,definition.agent_key,approval.expires_at AS approval_expires_at
     FROM trade_proposals AS proposal
     JOIN users AS app_user ON app_user.id=proposal.user_id
     JOIN broker_accounts AS account ON account.id=proposal.broker_account_id AND account.user_id=proposal.user_id
     JOIN broker_connections AS connection ON connection.id=account.connection_id AND connection.user_id=proposal.user_id
     JOIN agent_runs AS run ON run.id=proposal.agent_run_id AND run.user_id=proposal.user_id
     JOIN user_agents AS user_agent ON user_agent.id=run.user_agent_id AND user_agent.user_id=proposal.user_id
     JOIN agent_versions AS version ON version.id=proposal.agent_version_id
     JOIN agent_definitions AS definition ON definition.id=version.agent_definition_id
     LEFT JOIN LATERAL (
       SELECT request.expires_at FROM approval_requests AS request
       WHERE request.proposal_id=proposal.id AND request.user_id=proposal.user_id
         AND request.status IN ('approved','expired') AND request.acted_at IS NOT NULL
       ORDER BY request.acted_at DESC NULLS LAST,request.requested_at DESC LIMIT 1
     ) AS approval ON true
     WHERE proposal.id=$2 AND proposal.user_id=$1`,
    [userId,proposal.proposalId]
  );
  const binding=bindingResult.rows[0];
  if(binding===undefined||bindingResult.rows.length!==1)throw new DomainError("EXECUTION_BINDING_INVALID","A unique tenant-bound Paper execution graph is required",403);
  const verificationTime=binding.verified_for_trading_at?.getTime()??Number.NaN;
  const syncTime=binding.connection_last_sync_at?.getTime()??Number.NaN;
  if(
    binding.owner_user_id!==userId||binding.owner_user_id!==proposal.userId||binding.broker_account_id!==proposal.accountId||
    binding.environment!=="paper"||binding.account_mode!=="paper"||binding.user_agent_environment!=="paper"||
    binding.user_status!=="active"||binding.user_agent_deleted_at!==null||
    !["monitoring","waiting_approval","automatic"].includes(binding.user_agent_status)||
    binding.approval_mode!==proposal.requiredApprovalMode
  )throw new DomainError("PAPER_EXECUTION_BINDING_INVALID","The current user, agent, proposal, and Paper environment bindings must agree",403);
  if(
    !binding.account_active||!binding.is_agentic_account||binding.connection_provider!=="robinhood_mcp"||
    binding.connection_status!=="connected"||binding.connection_revoked_at!==null||!Number.isFinite(verificationTime)||!Number.isFinite(syncTime)||
    verificationTime>nowInstant+CLOCK_SKEW_MILLISECONDS||syncTime>nowInstant+CLOCK_SKEW_MILLISECONDS||
    nowInstant-syncTime>CAPABILITY_MAX_AGE_SECONDS*1_000
  )throw new DomainError("AGENTIC_ACCOUNT_BINDING_INVALID","A recently synchronized, connected, verified Agentic Account is required",403);
  const persistedDefinition=record(binding.persisted_definition);
  const permittedModes=persistedDefinition.permittedAccountModes;
  const instruments=persistedDefinition.instruments;
  if(
    proposal.instrumentType!=="equity"||binding.agent_key!=="foundation-equity"||binding.agent_version!=="1.0.0"||
    binding.agent_version_status!=="paper"||binding.agent_definition_id!==proposal.agentDefinitionId||
    binding.agent_version!==proposal.agentVersion||binding.deterministic_strategy_version!==proposal.deterministicStrategyVersion||
    !Array.isArray(permittedModes)||!permittedModes.includes("paper")||
    !Array.isArray(instruments)||!instruments.includes("equity")
  )throw new DomainError("PAPER_EXECUTION_STRATEGY_UNIMPLEMENTED","Only the current Foundation Equity v1 Paper strategy may execute",503);
  const allocationLimit=authoritativeNumber(binding.allocation_limit,"agent allocation limit");
  if(allocationLimit<=0||allocationLimit>1)throw new DomainError("AUTHORITATIVE_OPERATIONAL_CONTEXT_REQUIRED","The current agent allocation limit is invalid",503);

  const capabilityRows=await client.query<{tool_name:string}>(
    `SELECT DISTINCT ON (tool_name) tool_name FROM broker_capabilities
     WHERE connection_id=$1 AND unavailable_at IS NULL AND last_seen_at<=$2::timestamptz+interval '5 seconds'
       AND last_seen_at>$2::timestamptz-($3::text||' seconds')::interval
     ORDER BY tool_name,last_seen_at DESC`,
    [binding.connection_id,now,CAPABILITY_MAX_AGE_SECONDS]
  );
  const capabilities=new Set(capabilityRows.rows.map((row)=>row.tool_name));
  if(FOUNDATION_EQUITY_CAPABILITIES.some((capability)=>!capabilities.has(capability)))throw new DomainError("BROKER_CAPABILITY_BINDING_INVALID","Current fresh Foundation Equity broker capabilities are required",503);

  const policyResult=await client.query<PersistedPolicyRow>(
    `SELECT user_id::text AS owner_user_id,id::text AS policy_id,version AS policy_version,
       limits AS policy_limits,exclusions AS policy_exclusions,effective_at AS policy_effective_at
     FROM risk_policies WHERE user_id=$1 AND effective_at<=$2::timestamptz
       AND (superseded_at IS NULL OR superseded_at>$2::timestamptz)
     ORDER BY version DESC LIMIT 1`,
    [userId,now]
  );
  const policyRow=policyResult.rows[0];
  if(policyRow===undefined)throw new DomainError("CURRENT_RISK_POLICY_REQUIRED","A current persisted risk policy is required",409);
  const currentPolicy=persistedPolicy(policyRow);
  if(
    execution.authorization.policyId!==currentPolicy.policyId||execution.authorization.policyVersion!==currentPolicy.version||
    execution.policy.userId!==userId||canonical(execution.policy)!==canonical(currentPolicy)
  )throw new DomainError("EXECUTION_POLICY_BINDING_INVALID","The authorized risk policy is no longer the current persisted policy",409);

  const entitlementResult=await client.query<{plan_features:unknown;catalog_version:number|null;agent_version_mapped:boolean;entitlement_values:unknown}>(
    `SELECT current_plan.features AS plan_features,current_plan.catalog_version,
       current_plan.agent_version_mapped,overrides.entitlement_values
     FROM LATERAL (
       SELECT plan.features,catalog.version AS catalog_version,
         (entry.agent_version_id IS NOT NULL) AS agent_version_mapped
       FROM subscriptions AS subscription JOIN plans AS plan ON plan.id=subscription.plan_id
       LEFT JOIN plan_agent_catalog_versions AS catalog ON catalog.plan_id=plan.id
         AND catalog.activated_at IS NOT NULL AND catalog.superseded_at IS NULL
       LEFT JOIN plan_agent_catalog_entries AS entry ON entry.catalog_version_id=catalog.id
         AND entry.agent_version_id=$3::uuid
       WHERE subscription.user_id=$1 AND subscription.status IN ('active','grace_period') AND plan.active
         AND subscription.effective_at<=$2::timestamptz AND subscription.revoked_at IS NULL
         AND (subscription.expires_at IS NULL OR subscription.expires_at>$2::timestamptz)
       ORDER BY subscription.effective_at DESC LIMIT 1
     ) AS current_plan
     LEFT JOIN LATERAL (
       SELECT jsonb_object_agg(latest.feature_key,latest.value) AS entitlement_values FROM (
         SELECT DISTINCT ON (feature_key) feature_key,value FROM entitlements
         WHERE user_id=$1 AND effective_at<=$2::timestamptz AND (expires_at IS NULL OR expires_at>$2::timestamptz)
         ORDER BY feature_key,effective_at DESC
       ) AS latest
     ) AS overrides ON true`,
    [userId,now,binding.agent_version_id]
  );
  const entitlementRow=entitlementResult.rows[0];
  if(entitlementRow===undefined)throw new DomainError("ACTIVE_SUBSCRIPTION_REQUIRED","A current active subscription is required",403);
  if(!Number.isInteger(Number(entitlementRow.catalog_version))||entitlementRow.agent_version_mapped!==true)throw new DomainError("EXECUTION_ENTITLEMENT_BINDING_INVALID","The current subscription plan does not map this exact Paper agent version",403);
  const entitlements=persistedEntitlements(entitlementRow.plan_features,entitlementRow.entitlement_values);
  const activeAgentResult=await client.query<{count:string}>(
    `SELECT count(*)::text AS count FROM user_agents
     WHERE user_id=$1 AND deleted_at IS NULL AND status IN ('monitoring','waiting_approval','automatic')`,
    [userId]
  );
  const activeAgents=authoritativeInteger(activeAgentResult.rows[0]?.count,"active agent count");
  if(
    !entitlements.stockTrading||!entitlements.agentCatalog.includes(binding.agent_key)||
    activeAgents>entitlements.maximumActiveAgents||!entitlementsEquivalent(entitlements,execution.authorization.entitlements)
  )throw new DomainError("EXECUTION_ENTITLEMENT_BINDING_INVALID","Current entitlements no longer authorize this Paper strategy",403);
  if(
    execution.authorization.verifiedBy!=="persistent-execution-store"||
    execution.authorization.ownerUserId!==userId||execution.authorization.verifiedAccountId!==proposal.accountId||
    execution.authorization.userStatus!==binding.user_status||!execution.authorization.strategyEnabled||
    !execution.authorization.agentVersionEnabled||!execution.authorization.accountConnectionHealthy||
    !execution.authorization.tradingPermission
  )throw new DomainError("EXECUTION_AUTHORIZATION_STALE","The persisted execution authorization no longer matches current Paper state",409);

  const legalResult=await client.query<{document_count:string;consent_count:string}>(
    `WITH current_documents AS (
       SELECT DISTINCT ON (document_key) id,document_key FROM legal_documents
       WHERE document_key=ANY($2::text[]) AND production_approved AND published_at<=$3::timestamptz
         AND (retired_at IS NULL OR retired_at>$3::timestamptz)
       ORDER BY document_key,published_at DESC,created_at DESC
     )
     SELECT count(*)::text AS document_count,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM legal_consents AS consent WHERE consent.user_id=$1
           AND consent.legal_document_id=current_documents.id AND consent.accepted_at<=$3::timestamptz
           AND consent.revoked_at IS NULL
       ))::text AS consent_count
     FROM current_documents`,
    [userId,REQUIRED_LEGAL_DOCUMENTS,now]
  );
  const legalRow=legalResult.rows[0];
  const legalConsentsCurrent=authoritativeInteger(legalRow?.document_count,"legal document count")===REQUIRED_LEGAL_DOCUMENTS.length&&
    authoritativeInteger(legalRow?.consent_count,"legal consent count")===REQUIRED_LEGAL_DOCUMENTS.length;

  const portfolioResult=await client.query<PaperPortfolioRow>(
    `SELECT snapshot.id::text,snapshot.total_value::text,snapshot.buying_power::text,
       snapshot.source_timestamp,snapshot.valid_until,sync.completed_at AS sync_completed_at,sync.snapshot_fingerprint
     FROM portfolio_snapshots AS snapshot
     JOIN broker_sync_runs AS sync ON sync.portfolio_snapshot_id=snapshot.id AND sync.user_id=snapshot.user_id
       AND sync.connection_id=$4 AND sync.source_timestamp=snapshot.source_timestamp
     WHERE snapshot.user_id=$1 AND snapshot.broker_account_id=$2 AND snapshot.environment='paper'
       AND snapshot.data_classification='paper'
       AND snapshot.source_timestamp<=$3::timestamptz+interval '5 seconds'
     ORDER BY snapshot.source_timestamp DESC,snapshot.captured_at DESC LIMIT 1`,
    [userId,proposal.accountId,now,binding.connection_id]
  );
  const portfolio=portfolioResult.rows[0];
  const portfolioAge=portfolio===undefined?Number.POSITIVE_INFINITY:(nowInstant-portfolio.source_timestamp.getTime())/1_000;
  if(
    portfolio===undefined||portfolioAge>currentPolicy.maximumAccountSnapshotAgeSeconds||
    !Number.isFinite(portfolio.valid_until.getTime())||portfolio.valid_until.getTime()<=nowInstant||
    !Number.isFinite(portfolio.sync_completed_at.getTime())||
    portfolio.sync_completed_at.getTime()>nowInstant+CLOCK_SKEW_MILLISECONDS||
    portfolio.source_timestamp.getTime()>portfolio.sync_completed_at.getTime()+CLOCK_SKEW_MILLISECONDS||
    syncTime<portfolio.source_timestamp.getTime()||!/^[0-9a-f]{64}$/.test(portfolio.snapshot_fingerprint)
  )throw new DomainError("AUTHORITATIVE_ACCOUNT_SNAPSHOT_REQUIRED","A fresh, unexpired tenant-bound Paper Agentic Account snapshot is required",503);
  const accountValue=authoritativeNumber(portfolio.total_value,"portfolio total value");
  const buyingPower=authoritativeNumber(portfolio.buying_power,"portfolio buying power");
  if(accountValue<=0||buyingPower<0)throw new DomainError("AUTHORITATIVE_ACCOUNT_SNAPSHOT_REQUIRED","Paper account value and buying power must be valid non-negative broker values",503);
  const positionResult=await client.query<PaperPositionRow>(
    `SELECT symbol,instrument_type,quantity::text,market_value::text,details FROM position_snapshots
     WHERE user_id=$1 AND portfolio_snapshot_id=$2`,
    [userId,portfolio.id]
  );
  for(const position of positionResult.rows){
    if(position.instrument_type==="equity"&&(!PAPER_SYMBOL_PATTERN.test(position.symbol)||position.symbol!==position.symbol.toUpperCase()))throw new DomainError("AUTHORITATIVE_ACCOUNT_SNAPSHOT_REQUIRED","A persisted equity position symbol is invalid",503);
    const quantity=authoritativeNumber(position.quantity,"position quantity");
    const marketValue=authoritativeNumber(position.market_value,"position market value");
    if(!isRecord(position.details))throw new DomainError("AUTHORITATIVE_ACCOUNT_SNAPSHOT_REQUIRED","Persisted position details must be an object",503);
    if(position.instrument_type==="equity"&&(quantity!==0||marketValue!==0))authoritativeSector(record(position.details).sector,"position sector","AUTHORITATIVE_ACCOUNT_SNAPSHOT_REQUIRED");
  }

  const authorizedQuote=execution.authorization.marketQuote;
  if(
    authorizedQuote===undefined||authorizedQuote.verifiedBy!=="approved-market-data-store"||
    authorizedQuote.symbol!==proposal.symbol||authorizedQuote.provider.trim()===""
  )throw new DomainError("AUTHORITATIVE_MARKET_CONTEXT_REQUIRED","Paper execution requires its approved persisted market quote binding",503);
  const quoteResult=await client.query<PaperQuoteRow>(
    `SELECT id::text,provider,symbol,payload,source_timestamp,received_at,delayed_by_seconds
     FROM market_data_snapshots WHERE provider=$1 AND symbol=$2 AND data_type='quote' AND source_timestamp=$3::timestamptz
     LIMIT 1`,
    [authorizedQuote.provider,proposal.symbol,authorizedQuote.sourceTimestamp]
  );
  const quoteRow=quoteResult.rows[0];
  if(quoteRow===undefined)throw new DomainError("AUTHORITATIVE_MARKET_CONTEXT_REQUIRED","The authorized approved quote is no longer available",503,{refreshable:true,reason:"missing"});
  const quote=parsePaperQuote(quoteRow,proposal.symbol,authorizedQuote,currentPolicy.maximumQuoteAgeSeconds,nowInstant);

  const metricsResult=await client.query<PaperOperationalMetricsRow>(
    `SELECT
       COALESCE((SELECT sum(amount) FROM capital_reservations WHERE user_id=$1 AND broker_account_id=$3
         AND user_agent_id=$2 AND proposal_id IS DISTINCT FROM $5::uuid AND released_at IS NULL AND expires_at>$6::timestamptz),0)::text AS own_reservations,
       COALESCE((SELECT sum(amount) FROM capital_reservations WHERE user_id=$1 AND broker_account_id=$3
         AND user_agent_id<>$2 AND released_at IS NULL AND expires_at>$6::timestamptz),0)::text AS other_reservations,
       (SELECT count(*)::text FROM capital_reservations WHERE user_id=$1 AND broker_account_id=$3
         AND user_agent_id=$2 AND proposal_id=$5 AND released_at IS NULL AND expires_at>$6::timestamptz) AS proposal_reservation_count,
       COALESCE((SELECT sum(amount) FROM capital_reservations WHERE user_id=$1 AND broker_account_id=$3
         AND user_agent_id=$2 AND proposal_id=$5 AND released_at IS NULL AND expires_at>$6::timestamptz),0)::text AS proposal_reserved_amount,
       COALESCE((SELECT bool_and(side=$8) FROM capital_reservations WHERE user_id=$1 AND broker_account_id=$3
         AND user_agent_id=$2 AND proposal_id=$5 AND released_at IS NULL AND expires_at>$6::timestamptz),true) AS proposal_reservation_side_matches,
       COALESCE((SELECT count(DISTINCT orders.id) FROM fills JOIN orders ON orders.id=fills.order_id
         WHERE fills.user_id=$1 AND orders.broker_account_id=$3 AND fills.occurred_at>=date_trunc('day',$6::timestamptz)),0)::text AS trades_today,
       COALESCE((SELECT sum(fills.quantity*fills.price) FROM fills JOIN orders ON orders.id=fills.order_id
         WHERE fills.user_id=$1 AND orders.broker_account_id=$3 AND fills.occurred_at>=date_trunc('day',$6::timestamptz)),0)::text AS turnover_notional,
       EXISTS(SELECT 1 FROM trade_proposals WHERE user_id=$1 AND broker_account_id=$3 AND id<>$5 AND symbol=$4
         AND proposal->>'side'=$8 AND status IN ('DRAFT','ANALYZED','SCHEMA_VALIDATED','RISK_CHECKED','BROKER_REVIEWED','AWAITING_USER_APPROVAL','APPROVED')) AS duplicate_proposal,
       EXISTS(SELECT 1 FROM orders JOIN trade_proposals ON trade_proposals.id=orders.proposal_id
         WHERE orders.user_id=$1 AND orders.broker_account_id=$3 AND trade_proposals.id<>$5 AND trade_proposals.symbol=$4
           AND trade_proposals.proposal->>'side'=$8 AND orders.status IN ('pending','submitted','partially_filled')) AS duplicate_open_order,
       (SELECT max(snapshot.total_value)::text FROM portfolio_snapshots AS snapshot
         JOIN broker_sync_runs AS sync ON sync.portfolio_snapshot_id=snapshot.id AND sync.user_id=snapshot.user_id
           AND sync.connection_id=$9 AND sync.source_timestamp=snapshot.source_timestamp
         WHERE snapshot.user_id=$1 AND snapshot.broker_account_id=$3
           AND snapshot.environment=$7::app_environment AND snapshot.data_classification='paper'
           AND snapshot.source_timestamp<=$6::timestamptz) AS peak_value,
       (SELECT snapshot.total_value::text FROM portfolio_snapshots AS snapshot
         JOIN broker_sync_runs AS sync ON sync.portfolio_snapshot_id=snapshot.id AND sync.user_id=snapshot.user_id
           AND sync.connection_id=$9 AND sync.source_timestamp=snapshot.source_timestamp
         WHERE snapshot.user_id=$1 AND snapshot.broker_account_id=$3
           AND snapshot.environment=$7::app_environment AND snapshot.data_classification='paper'
           AND snapshot.source_timestamp>=date_trunc('day',$6::timestamptz)
           AND snapshot.source_timestamp<=$6::timestamptz ORDER BY snapshot.source_timestamp LIMIT 1) AS opening_value,
       EXISTS(SELECT 1 FROM risk_events WHERE user_id=$1 AND broker_account_id=$3
         AND severity IN ('blocking','critical') AND occurred_at>$6::timestamptz-interval '24 hours') AS active_risk_halt,
       EXISTS(SELECT 1 FROM security_events WHERE user_id=$1 AND lower(severity) IN ('blocking','critical')
         AND occurred_at>$6::timestamptz-interval '24 hours' AND COALESCE(structured_details->>'active','true')<>'false') AS active_security_halt,
       EXISTS(SELECT 1 FROM system_incidents WHERE environment=$7::app_environment AND status<>'resolved'
         AND lower(severity) IN ('blocking','critical')) AS active_system_incident`,
    [userId,binding.user_agent_id,proposal.accountId,proposal.symbol,proposal.proposalId,now,"paper",proposal.side,binding.connection_id]
  );
  const metrics=metricsResult.rows[0];
  if(metrics===undefined)throw new DomainError("AUTHORITATIVE_OPERATIONAL_CONTEXT_REQUIRED","Operational Paper risk context is unavailable",503);
  const proposalReservationCount=authoritativeInteger(metrics.proposal_reservation_count,"proposal reservation count");
  const proposalReservedAmount=authoritativeNumber(metrics.proposal_reserved_amount,"proposal reserved amount");
  if(
    proposalReservationCount>1||
    (proposalReservationCount===1&&(!metrics.proposal_reservation_side_matches||Math.abs(proposalReservedAmount-proposal.notionalEstimate)>0.000001))||
    (execution.aggregate.status==="APPROVED"&&proposalReservationCount!==1)
  )throw new DomainError("PAPER_CAPITAL_RESERVATION_INVALID","Initial Paper placement requires its exact current tenant-bound capital reservation",409);

  const positions=positionResult.rows;
  const equityPositions=positions.filter((position)=>position.instrument_type==="equity");
  const currentAllocatedValue=equityPositions.reduce((total,position)=>total+Math.abs(authoritativeNumber(position.market_value,"position market value")),0);
  const targetPositions=equityPositions.filter((position)=>position.symbol===proposal.symbol);
  const currentPositionValue=targetPositions.reduce((total,position)=>total+Math.max(0,authoritativeNumber(position.market_value,"target position market value")),0);
  const currentHeldQuantity=targetPositions.reduce((total,position)=>total+Math.max(0,authoritativeNumber(position.quantity,"target position quantity")),0);
  const quoteSector=quote.sector.toUpperCase();
  const currentSectorValue=equityPositions.filter((position)=>{
    const sector=authoritativeSector(record(position.details).sector,"position sector","AUTHORITATIVE_ACCOUNT_SNAPSHOT_REQUIRED");
    return sector.toUpperCase()===quoteSector;
  }).reduce((total,position)=>total+Math.max(0,authoritativeNumber(position.market_value,"sector position market value")),0);
  const ownReservations=authoritativeNumber(metrics.own_reservations,"own capital reservations");
  const otherReservations=authoritativeNumber(metrics.other_reservations,"other agent capital reservations");
  const tradesToday=authoritativeInteger(metrics.trades_today,"daily trade count");
  const turnoverNotional=authoritativeNumber(metrics.turnover_notional,"daily turnover");
  if(ownReservations<0||otherReservations<0||turnoverNotional<0)throw new DomainError("AUTHORITATIVE_OPERATIONAL_CONTEXT_REQUIRED","Persisted Paper operational totals cannot be negative",503);
  const peakValue=metrics.peak_value===null?accountValue:authoritativeNumber(metrics.peak_value,"portfolio peak value");
  const openingValue=metrics.opening_value===null?accountValue:authoritativeNumber(metrics.opening_value,"opening portfolio value");
  if(peakValue<0||openingValue<0)throw new DomainError("AUTHORITATIVE_OPERATIONAL_CONTEXT_REQUIRED","Persisted Paper portfolio history is invalid",503);
  const proposalExpiry=Date.parse(proposal.expirationTimestamp);
  if(!Number.isFinite(proposalExpiry))throw new DomainError("EXECUTION_BINDING_INVALID","Proposal expiration is invalid",409);
  let approvalExpiry=proposalExpiry;
  if(proposal.requiredApprovalMode==="confirm_every_trade"){
    const persistedApprovalExpiry=binding.approval_expires_at?.getTime()??Number.NaN;
    if(!Number.isFinite(persistedApprovalExpiry))throw new DomainError("AUTHENTICATED_APPROVAL_REQUIRED","A persisted approval expiry is required",403);
    approvalExpiry=Math.min(approvalExpiry,persistedApprovalExpiry);
  }

  return Object.freeze({
    now,releaseGates:execution.authorization.releaseGates,userStatus:binding.user_status,
    currentLegalConsents:legalConsentsCurrent,entitlements,accountConnectionHealthy:true,
    verifiedAgenticAccountId:proposal.accountId,strategyEnabled:true,agentVersionEnabled:true,tradingPermission:true,
    marketSession:quote.marketSession,criticalServicesHealthy:!metrics.active_system_incident,
    securityHalt:metrics.active_security_halt,accountValue,buyingPower,reservedBuyingPower:ownReservations,
    currentAllocatedValue,currentPositionValue,currentHeldQuantity,currentSectorValue,
    openPositionCount:equityPositions.filter((position)=>authoritativeNumber(position.quantity,"position quantity")!==0).length,
    dailyLoss:Math.max(0,openingValue-accountValue),drawdownRatio:peakValue>0?Math.max(0,(peakValue-accountValue)/peakValue):1,
    agentAllocatedValue:currentAllocatedValue,agentAllocationLimit:allocationLimit*accountValue,
    otherAgentReservations:otherReservations,duplicateProposal:metrics.duplicate_proposal,
    duplicateOpenOrder:metrics.duplicate_open_order,symbolSector:quote.sector,tradable:quote.tradable,
    fractionalSupported:quote.fractionalSupported,liquiditySufficient:quote.liquiditySufficient,
    volatilityHalt:quote.volatilityHalt,tradingHalt:quote.tradingHalt,
    corporateActionRestricted:quote.corporateActionRestricted,earningsWindow:quote.earningsWindow,
    cooldownActive:metrics.active_risk_halt,tradesToday,turnoverToday:turnoverNotional/Math.max(accountValue,1),
    accountSnapshotTimestamp:portfolio.source_timestamp.toISOString(),quotePrice:quote.last,
    expectedExecutionPrice:proposal.side==="buy"?quote.ask:quote.bid,
    brokerWarningSeverity:quote.brokerWarningSeverity,approvalExpiresAt:new Date(approvalExpiry).toISOString()
  });
}

function parsePaperQuote(
  row:PaperQuoteRow,
  symbol:string,
  authorizedQuote:NonNullable<ExecutionAuthorization["marketQuote"]>,
  maximumAgeSeconds:number,
  nowInstant:number
):PaperParsedQuote{
  if(!isRecord(row.payload))throw new DomainError("AUTHORITATIVE_MARKET_CONTEXT_REQUIRED","Approved persisted quote payload must be an object",503);
  const payload=row.payload;
  const bid=authoritativeJsonNumber(payload.bid,"quote bid");
  const ask=authoritativeJsonNumber(payload.ask,"quote ask");
  const last=authoritativeJsonNumber(payload.last,"quote last");
  const sourceTimestamp=row.source_timestamp.getTime();
  const receivedAt=row.received_at.getTime();
  const sector=authoritativeSector(payload.sector,"quote sector","AUTHORITATIVE_MARKET_CONTEXT_REQUIRED");
  const marketSession=payload.marketSession;
  const warning=payload.brokerWarningSeverity;
  const booleanValue=(name:string):boolean=>{
    const value=payload[name];
    if(typeof value!=="boolean")throw new DomainError("AUTHORITATIVE_MARKET_CONTEXT_REQUIRED",`Approved quote ${name} is missing`,503);
    return value;
  };
  if(
    row.provider!==authorizedQuote.provider||row.symbol!==symbol||payload.symbol!==symbol||
    bid!==authorizedQuote.bid||ask!==authorizedQuote.ask||last!==authorizedQuote.last||
    bid<0||ask<=0||ask<bid||last<=0||
    !["open","extended","closed"].includes(String(marketSession))||
    !["none","informational","blocking"].includes(String(warning))||
    !Number.isFinite(sourceTimestamp)||!Number.isFinite(receivedAt)||
    sourceTimestamp>nowInstant+CLOCK_SKEW_MILLISECONDS||receivedAt>nowInstant+CLOCK_SKEW_MILLISECONDS||
    sourceTimestamp>receivedAt+CLOCK_SKEW_MILLISECONDS||
    !Number.isInteger(row.delayed_by_seconds)||row.delayed_by_seconds<0
  )throw new DomainError("AUTHORITATIVE_MARKET_CONTEXT_REQUIRED","Approved persisted quote context is malformed or no longer matches its authorization",503);
  if((nowInstant-sourceTimestamp)/1_000>maximumAgeSeconds)throw new DomainError("AUTHORITATIVE_MARKET_CONTEXT_REQUIRED","The authorized approved quote became stale before placement",503,{refreshable:true,reason:"stale"});
  return Object.freeze({
    sourceTimestamp:row.source_timestamp.toISOString(),bid,ask,last,
    tradable:booleanValue("tradable"),fractionalSupported:booleanValue("fractionalSupported"),
    liquiditySufficient:booleanValue("liquiditySufficient"),marketSession:marketSession as PaperParsedQuote["marketSession"],
    volatilityHalt:booleanValue("volatilityHalt"),tradingHalt:booleanValue("tradingHalt"),
    corporateActionRestricted:booleanValue("corporateActionRestricted"),earningsWindow:booleanValue("earningsWindow"),
    sector,brokerWarningSeverity:warning as PaperParsedQuote["brokerWarningSeverity"]
  });
}

function parsePaperReconciliationQuote(
  row:PaperReconciliationQuoteRow,
  symbol:string,
  nowInstant:number
):PaperReconciliationQuote{
  if(!isRecord(row.payload))throw new DomainError("AUTHORITATIVE_MARKET_CONTEXT_REQUIRED","Paper reconciliation quote payload must be an object",503);
  const payload=row.payload;
  const bid=authoritativeJsonNumber(payload.bid,"reconciliation quote bid");
  const ask=authoritativeJsonNumber(payload.ask,"reconciliation quote ask");
  const last=authoritativeJsonNumber(payload.last,"reconciliation quote last");
  const marketSession=payload.marketSession;
  const warning=payload.brokerWarningSeverity;
  const booleanValue=(name:string):boolean=>{
    const value=payload[name];
    if(typeof value!=="boolean")throw new DomainError("AUTHORITATIVE_MARKET_CONTEXT_REQUIRED",`Paper reconciliation quote ${name} is missing`,503);
    return value;
  };
  const sourceTimestamp=row.source_timestamp.getTime();
  const receivedAt=row.received_at.getTime();
  if(
    row.symbol!==symbol||payload.symbol!==symbol||bid<0||ask<=0||ask<bid||last<=0||
    !["open","extended","closed"].includes(String(marketSession))||
    !["none","informational","blocking"].includes(String(warning))||
    !Number.isFinite(sourceTimestamp)||!Number.isFinite(receivedAt)||
    sourceTimestamp>nowInstant+CLOCK_SKEW_MILLISECONDS||receivedAt>nowInstant+CLOCK_SKEW_MILLISECONDS||
    sourceTimestamp>receivedAt+CLOCK_SKEW_MILLISECONDS||
    !Number.isInteger(row.delayed_by_seconds)||row.delayed_by_seconds<0
  )throw new DomainError("AUTHORITATIVE_MARKET_CONTEXT_REQUIRED","Paper reconciliation quote is malformed",503);
  return Object.freeze({
    bid,ask,last,tradable:booleanValue("tradable"),liquiditySufficient:booleanValue("liquiditySufficient"),
    marketSession:marketSession as PaperReconciliationQuote["marketSession"],
    volatilityHalt:booleanValue("volatilityHalt"),tradingHalt:booleanValue("tradingHalt"),
    corporateActionRestricted:booleanValue("corporateActionRestricted"),
    brokerWarningSeverity:warning as PaperReconciliationQuote["brokerWarningSeverity"]
  });
}

async function deferReconciliationJob(
  client:PoolClient,
  jobId:string,
  userId:string,
  orderId:string,
  nowInstant:number,
  reasonCode:string
):Promise<PaperReconciliationDisposition>{
  const retryAt=new Date(nowInstant+15_000).toISOString();
  const result=await client.query(
    `UPDATE reconciliation_jobs SET status='queued',run_after=$4::timestamptz,leased_until=NULL,
       last_error_code=$5,attempts=attempts+1,updated_at=clock_timestamp()
     WHERE id=$1 AND user_id=$2 AND order_id=$3`,
    [jobId,userId,orderId,retryAt,reasonCode]
  );
  if(result.rowCount!==1)throw new DomainError("RECONCILIATION_JOB_NOT_FOUND","Paper reconciliation job was not found",404);
  return Object.freeze({resolution:"deferred",retryAt,reasonCode});
}

async function completeReconciliationJob(client:PoolClient,jobId:string,userId:string,orderId:string):Promise<void>{
  const result=await client.query(
    `UPDATE reconciliation_jobs SET status='succeeded',leased_until=NULL,last_error_code=NULL,updated_at=clock_timestamp()
     WHERE id=$1 AND user_id=$2 AND order_id=$3`,
    [jobId,userId,orderId]
  );
  if(result.rowCount!==1)throw new DomainError("RECONCILIATION_JOB_NOT_FOUND","Paper reconciliation job was not found",404);
}

function authoritativeNumber(value:unknown,name:string):number{
  const parsed=typeof value==="number"?value:typeof value==="string"&&value.trim()!==""?Number(value):Number.NaN;
  if(!Number.isFinite(parsed))throw new DomainError("AUTHORITATIVE_NUMERIC_VALUE_INVALID",`${name} is not finite`,500);
  return parsed;
}
function authoritativeJsonNumber(value:unknown,name:string):number{
  if(typeof value!=="number"||!Number.isFinite(value))throw new DomainError("AUTHORITATIVE_NUMERIC_VALUE_INVALID",`${name} is not a finite JSON number`,500);
  return value;
}
function authoritativeInteger(value:unknown,name:string):number{
  const parsed=authoritativeNumber(value,name);
  if(!Number.isSafeInteger(parsed)||parsed<0)throw new DomainError("AUTHORITATIVE_NUMERIC_VALUE_INVALID",`${name} is not a non-negative safe integer`,500);
  return parsed;
}
function authoritativeSector(value:unknown,name:string,code:string):string{
  const sector=typeof value==="string"?value.trim():"";
  if(sector===""||sector.length>PAPER_SECTOR_MAX_LENGTH||/[\u0000-\u001F\u007F]/u.test(sector)){
    throw new DomainError(code,`${name} is missing or invalid`,503);
  }
  return sector;
}
function isRecord(value:unknown):value is Readonly<Record<string,unknown>>{
  return typeof value==="object"&&value!==null&&!Array.isArray(value);
}
function canonical(value:unknown):string{
  if(Array.isArray(value))return `[${value.map(canonical).join(",")}]`;
  if(isRecord(value))return `{${Object.entries(value).sort(([left],[right])=>left.localeCompare(right)).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function entitlementsEquivalent(left:Entitlements,right:Entitlements):boolean{
  const normalized=(value:Entitlements):Readonly<Record<string,unknown>>=>({...value,agentCatalog:[...value.agentCatalog].sort()});
  return canonical(normalized(left))===canonical(normalized(right));
}

export class PostgresExecutionRepository {
  public readonly pool:Pool;
  public constructor(databaseUrl:string){this.pool=new Pool({connectionString:databaseUrl,application_name:"whox-execution-worker",max:8});}
  public proposalStore(userId:string):PostgresProposalStore{return new PostgresProposalStore(this.pool,userId);}
  public async loadAuthoritativeRiskContext(userId:string,execution:AuthorizedExecution,now:string):Promise<RiskContext>{
    if(userId!==execution.aggregate.proposal.userId)throw new DomainError("EXECUTION_BINDING_INVALID","Risk context owner does not match the proposal",403);
    if(execution.aggregate.proposal.environment==="live")throw new DomainError("AUTHORITATIVE_RISK_CONTEXT_UNAVAILABLE","Live execution remains unavailable until its approved server-side account and order adapters are configured",503);
    if(execution.aggregate.proposal.environment==="demo")throw new DomainError("DEMO_EXECUTION_PIPELINE_UNCONFIGURED","Demo order execution is provided by the isolated Demo application fixtures, not the persistent worker",503,{at:now});
    const nowInstant=Date.parse(now);
    if(!Number.isFinite(nowInstant))throw new DomainError("EXECUTION_TIME_INVALID","Execution time is invalid",422);
    const client=await this.pool.connect();
    try{
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query(`SELECT set_config('app.user_id',$1,true)`,[userId]);
      const context=await loadPaperRiskContext(client,userId,execution,now,nowInstant);
      await client.query("COMMIT");
      return context;
    }catch(error){
      await client.query("ROLLBACK");
      throw error;
    }finally{client.release();}
  }
  public async recordPlacementAttempt(userId:string,aggregate:ProposalAggregate,idempotencyKey:string,now:string):Promise<string>{const proposal=aggregate.proposal;const client=await this.pool.connect();try{await client.query("BEGIN");await client.query(`SELECT set_config('app.user_id',$1,true)`,[userId]);const persisted=await client.query<{status:ProposalStatus;user_id:string;broker_account_id:string}>(`SELECT status,user_id::text,broker_account_id::text FROM trade_proposals WHERE id=$1 AND user_id=$2 FOR SHARE`,[proposal.proposalId,userId]);const row=persisted.rows[0];if(row===undefined||proposal.userId!==userId||row.user_id!==userId||proposal.accountId!==row.broker_account_id)throw new DomainError("EXECUTION_BINDING_INVALID","Placement receipt does not match persisted proposal ownership",403);if(row.status!=="SUBMITTING")throw new DomainError("PLACEMENT_RECEIPT_STATE_INVALID","A placement receipt may only be recorded for a submitting proposal",409);const result=await client.query<{id:string}>(`INSERT INTO orders(user_id,proposal_id,broker_account_id,broker_order_id,instrument_type,status,submission_idempotency_key) VALUES($1,$2,$3,NULL,$4,'pending',$5) ON CONFLICT(proposal_id) DO UPDATE SET proposal_id=EXCLUDED.proposal_id WHERE orders.submission_idempotency_key=EXCLUDED.submission_idempotency_key AND orders.status='pending' RETURNING id`,[userId,proposal.proposalId,proposal.accountId,proposal.instrumentType,idempotencyKey]);const orderId=result.rows[0]?.id;if(orderId===undefined)throw new DomainError("ORDER_IDEMPOTENCY_REUSED","Proposal already has a different or completed placement receipt",409);await client.query(`INSERT INTO order_events(order_id,user_id,status,broker_event_id,occurred_at,payload,idempotency_key) VALUES($1,$2,'pending',NULL,$3::timestamptz,'{"source":"durable_pre_submission_receipt"}'::jsonb,$4) ON CONFLICT(idempotency_key) DO NOTHING`,[orderId,userId,now,`${idempotencyKey}:attempt`]);await client.query("COMMIT");return orderId;}catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}}
  public async persistOutcome(userId:string,outcome:ExecutionOutcome,idempotencyKey:string):Promise<string>{const proposal=outcome.aggregate.proposal;const status=outcome.submission.status;const terminal=status==="filled"||status==="rejected";const client=await this.pool.connect();try{await client.query("BEGIN");await client.query(`SELECT set_config('app.user_id',$1,true)`,[userId]);const result=await client.query<{id:string}>(`UPDATE orders SET broker_account_id=$3,broker_order_id=$4,instrument_type=$5,status=$6::order_status,submitted_at=$8::timestamptz,terminal_at=$9::timestamptz,updated_at=clock_timestamp() WHERE user_id=$1 AND proposal_id=$2 AND submission_idempotency_key=$7 AND (status='pending' OR (status=$6::order_status AND broker_order_id=$4)) RETURNING id`,[userId,proposal.proposalId,proposal.accountId,outcome.submission.brokerOrderId,proposal.instrumentType,status,idempotencyKey,outcome.submission.submittedAt,terminal?outcome.submission.submittedAt:null]);const orderId=result.rows[0]?.id;if(orderId===undefined)throw new DomainError("PERSISTENT_PLACEMENT_RECEIPT_REQUIRED","A matching uncanceled durable pre-submission receipt is required before persisting an outcome",409);await client.query(`INSERT INTO order_events(order_id,user_id,status,broker_event_id,occurred_at,payload,idempotency_key) VALUES($1,$2,$3::order_status,$4,$5::timestamptz,$6::jsonb,$7) ON CONFLICT(idempotency_key) DO NOTHING`,[orderId,userId,status,outcome.submission.brokerOrderId,outcome.submission.submittedAt,JSON.stringify({environment:proposal.environment,filledQuantity:outcome.submission.filledQuantity,averageFillPrice:outcome.submission.averageFillPrice??null}),`${idempotencyKey}:event`]);if(outcome.submission.filledQuantity>0)await client.query(`INSERT INTO fills(order_id,user_id,broker_fill_id,quantity,price,fees,occurred_at) VALUES($1,$2,$3,$4,$5,0,$6::timestamptz) ON CONFLICT(order_id,broker_fill_id) DO NOTHING`,[orderId,userId,`${outcome.submission.brokerOrderId}:initial`,outcome.submission.filledQuantity,outcome.submission.averageFillPrice??0,outcome.submission.submittedAt]);if(!terminal)await client.query(`INSERT INTO reconciliation_jobs(order_id,user_id,status,idempotency_key,run_after) VALUES($1,$2,'queued',$3,clock_timestamp()+interval '5 seconds') ON CONFLICT(idempotency_key) DO NOTHING`,[orderId,userId,`${idempotencyKey}:reconcile`]);await client.query("COMMIT");return orderId;}catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}}
  public async claimDueReconciliations(limit=25):Promise<readonly {readonly jobId:string;readonly orderId:string;readonly userId:string}[]>{const result=await this.pool.query<{id:string;order_id:string;user_id:string}>(`UPDATE reconciliation_jobs AS job SET status='leased',leased_until=clock_timestamp()+interval '30 seconds' FROM (SELECT id FROM reconciliation_jobs WHERE (status IN ('queued','failed') OR (status='leased' AND leased_until<=clock_timestamp())) AND run_after<=clock_timestamp() AND (leased_until IS NULL OR leased_until<=clock_timestamp()) ORDER BY run_after FOR UPDATE SKIP LOCKED LIMIT $1) due WHERE job.id=due.id RETURNING job.id,job.order_id,job.user_id`,[limit]);return Object.freeze(result.rows.map((row)=>Object.freeze({jobId:row.id,orderId:row.order_id,userId:row.user_id})));}
  public async reconcilePaperOrder(
    userId:string,
    jobId:string,
    orderId:string,
    now:string,
    approvedMarketDataProviders:readonly string[]
  ):Promise<PaperReconciliationDisposition>{
    if(
      approvedMarketDataProviders.length===0||
      approvedMarketDataProviders.some((provider)=>!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(provider))
    )throw new DomainError("APPROVED_MARKET_DATA_PROVIDERS_REQUIRED","Paper reconciliation requires an explicit approved market-data provider allowlist",503);
    const nowInstant=Date.parse(now);
    if(!Number.isFinite(nowInstant))throw new DomainError("EXECUTION_TIME_INVALID","Reconciliation time is invalid",422);
    const client=await this.pool.connect();
    try{
      await client.query("BEGIN");
      await client.query(`SELECT set_config('app.user_id',$1,true)`,[userId]);
      const result=await client.query<{
        status:string;broker_order_id:string|null;proposal_id:string;proposal_status:ProposalStatus;
        proposal_version:number;proposal:unknown;filled:string;environment:"demo"|"paper"|"live";
      }>(`SELECT orders.status,orders.broker_order_id,trade_proposals.id::text AS proposal_id,
          trade_proposals.status AS proposal_status,trade_proposals.version AS proposal_version,
          trade_proposals.proposal,trade_proposals.environment,
          COALESCE((SELECT sum(quantity) FROM fills WHERE fills.order_id=orders.id),0)::text AS filled
        FROM orders JOIN trade_proposals ON trade_proposals.id=orders.proposal_id AND trade_proposals.user_id=orders.user_id
        WHERE orders.id=$1 AND orders.user_id=$2 FOR UPDATE OF orders,trade_proposals`,[orderId,userId]);
      const row=result.rows[0];
      if(row===undefined)throw new DomainError("ORDER_NOT_FOUND","Reconciliation order was not found",404);
      if(!["submitted","partially_filled"].includes(row.status)){
        await completeReconciliationJob(client,jobId,userId,orderId);
        await client.query("COMMIT");
        return Object.freeze({resolution:"completed"});
      }
      if(row.environment!=="paper"||!["SUBMITTED","PARTIALLY_FILLED"].includes(row.proposal_status)){
        throw new DomainError("RECONCILIATION_PROPOSAL_STATE_INVALID","Only matching submitted Paper proposals may be reconciled",409);
      }
      const proposal=validateTradeProposal(row.proposal);
      if(proposal.userId!==userId||proposal.proposalId!==row.proposal_id||proposal.environment!=="paper"){
        throw new DomainError("RECONCILIATION_PROPOSAL_STATE_INVALID","Paper reconciliation ownership or environment binding is invalid",409);
      }
      const quantity=proposal.quantity;
      const remaining=quantity-authoritativeNumber(row.filled,"filled quantity");
      if(!Number.isFinite(remaining)||remaining<=0)throw new DomainError("RECONCILIATION_QUANTITY_INVALID","Remaining Paper fill quantity is invalid",500);
      const quoteResult=await client.query<PaperReconciliationQuoteRow>(
        `SELECT provider,symbol,payload,source_timestamp,received_at,delayed_by_seconds
         FROM market_data_snapshots WHERE symbol=$1 AND data_type='quote' AND provider=ANY($2::text[])
           AND source_timestamp<=$3::timestamptz+interval '5 seconds'
         ORDER BY source_timestamp DESC,received_at DESC LIMIT 1`,
        [proposal.symbol,approvedMarketDataProviders,now]
      );
      const quoteRow=quoteResult.rows[0];
      if(quoteRow===undefined||(nowInstant-quoteRow.source_timestamp.getTime())/1_000>30){
        const disposition=await deferReconciliationJob(client,jobId,userId,orderId,nowInstant,"PAPER_RECONCILIATION_QUOTE_REQUIRED");
        await client.query("COMMIT");
        return disposition;
      }
      const quote=parsePaperReconciliationQuote(quoteRow,proposal.symbol,nowInstant);
      const safeToFill=quote.tradable&&quote.liquiditySufficient&&quote.marketSession==="open"&&
        !quote.volatilityHalt&&!quote.tradingHalt&&!quote.corporateActionRestricted&&
        quote.brokerWarningSeverity!=="blocking";
      const marketable=proposal.limitPrice===undefined||(
        proposal.side==="buy"?proposal.limitPrice>=quote.ask:proposal.limitPrice<=quote.bid
      );
      const stopTriggered=proposal.stopPrice===undefined||(
        proposal.side==="buy"?quote.last>=proposal.stopPrice:quote.last<=proposal.stopPrice
      );
      if(!safeToFill||!marketable||!stopTriggered){
        const reason=!safeToFill?"PAPER_RECONCILIATION_MARKET_BLOCKED":!stopTriggered?"PAPER_RECONCILIATION_STOP_NOT_TRIGGERED":"PAPER_RECONCILIATION_LIMIT_NOT_MARKETABLE";
        const disposition=await deferReconciliationJob(client,jobId,userId,orderId,nowInstant,reason);
        await client.query("COMMIT");
        return disposition;
      }
      const referencePrice=proposal.side==="buy"?quote.ask:quote.bid;
      const fillPrice=proposal.limitPrice===undefined?referencePrice:
        proposal.side==="buy"?Math.min(proposal.limitPrice,referencePrice):Math.max(proposal.limitPrice,referencePrice);
      if(!Number.isFinite(fillPrice)||fillPrice<=0)throw new DomainError("RECONCILIATION_PRICE_INVALID","Paper reconciliation fill price is invalid",500);
      if(row.broker_order_id===null||row.broker_order_id.trim()==="")throw new DomainError("RECONCILIATION_BROKER_ORDER_REQUIRED","Paper reconciliation requires its durable broker order identifier",409);
      await client.query(
        `INSERT INTO fills(order_id,user_id,broker_fill_id,quantity,price,fees,occurred_at)
         VALUES($1,$2,$3,$4,$5,0,$6::timestamptz) ON CONFLICT(order_id,broker_fill_id) DO NOTHING`,
        [orderId,userId,`${row.broker_order_id}:reconciled:${jobId}`,remaining,fillPrice,now]
      );
      const orderUpdate=await client.query(
        `UPDATE orders SET status='filled',terminal_at=$3::timestamptz,updated_at=$3::timestamptz
         WHERE id=$1 AND user_id=$2 AND status IN ('submitted','partially_filled')`,
        [orderId,userId,now]
      );
      const proposalUpdate=await client.query(
        `UPDATE trade_proposals SET status='FILLED',version=version+1,updated_at=$3::timestamptz
         WHERE id=$1 AND user_id=$2 AND version=$4 AND status=$5::proposal_status`,
        [row.proposal_id,userId,now,row.proposal_version,row.proposal_status]
      );
      if(orderUpdate.rowCount!==1||proposalUpdate.rowCount!==1)throw new DomainError("RECONCILIATION_STATE_CONFLICT","Paper order or proposal changed during reconciliation",409);
      await client.query(
        `INSERT INTO order_events(order_id,user_id,status,broker_event_id,occurred_at,payload,idempotency_key)
         VALUES($1,$2,'filled',$3,$4::timestamptz,$5::jsonb,$6) ON CONFLICT(idempotency_key) DO NOTHING`,
        [orderId,userId,row.broker_order_id,now,JSON.stringify({source:"paper_reconciliation",quoteProvider:quoteRow.provider,quoteTimestamp:quoteRow.source_timestamp.toISOString(),fillRule:"marketable_at_fresh_authoritative_quote"}),`reconciliation:${jobId}:order`]
      );
      await client.query(
        `INSERT INTO trade_proposal_events(proposal_id,user_id,from_status,to_status,actor_type,actor_id,reason_code,correlation_id,idempotency_key,metadata,occurred_at)
         VALUES($1,$2,$3::proposal_status,'FILLED','worker','execution-worker','PAPER_RECONCILIATION_FILLED',$4,$5,$6::jsonb,$7::timestamptz)
         ON CONFLICT(idempotency_key) DO NOTHING`,
        [row.proposal_id,userId,row.proposal_status,`reconciliation:${jobId}`,`reconciliation:${jobId}:proposal`,JSON.stringify({quoteProvider:quoteRow.provider,quoteTimestamp:quoteRow.source_timestamp.toISOString()}),now]
      );
      await completeReconciliationJob(client,jobId,userId,orderId);
      await client.query("COMMIT");
      return Object.freeze({resolution:"completed"});
    }catch(error){
      await client.query("ROLLBACK");
      throw error;
    }finally{client.release();}
  }
  public async close():Promise<void>{await this.pool.end();}
}
