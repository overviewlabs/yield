import { createCipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { AGENT_CATALOG } from "@whox/agent-definitions";
import { DomainError, type Entitlements, type PlanAgentAssignment, type RiskPolicy, type SubscriptionPlanCatalog, type TradeProposal } from "@whox/contracts";
import { validateUserPolicyAgainstPlatform } from "@whox/risk-schemas";
import { assessEligibility, evaluateRiskAssessment, LEGAL_DOCUMENTS, type EligibilityRecord, type LegalConsentRecord, type RiskAssessmentRecord } from "./compliance.js";
import { PostgresTenantDatabase, type TenantTransaction } from "./database.js";
import type { VerifiedStepUpAuthentication } from "./step-up.js";
import type { VerifiedStoreKitTransaction } from "./storekit.js";
import type { ApiDataStore, ApprovalRecord, NotificationRecord, OrderRecord, ProposalRecord, UserAgentRecord, UserRecord } from "./store.js";

const BASE_LEGAL_KEYS=Object.freeze(LEGAL_DOCUMENTS.filter((document)=>document.required).map((document)=>document.key));
const EMPTY_ENTITLEMENTS:Entitlements=Object.freeze({stockTrading:false,optionsTrading:false,multiLegOptions:false,maximumActiveAgents:0,automaticMode:false,monitoringFrequencyMinutes:1440,advancedAnalytics:false,customWatchlists:false,scannerAccess:false,agentCatalog:[],prioritySupport:false});
const DEFAULT_POLICY_LIMITS=Object.freeze({maximumAccountAllocation:0.6,maximumPositionAmount:5000,maximumNewOrderAmount:2000,maximumDailyLoss:500,maximumPortfolioDrawdown:0.1,minimumBuyingPowerReserve:0.2,maximumSimultaneousPositions:10,maximumSymbolConcentration:0.15,maximumSectorConcentration:0.3,maximumTradesPerDay:5,maximumDailyTurnover:0.3,maximumOptionsExposure:0.1,maximumOptionRiskPerTrade:500,maximumContractsPerTrade:2,minimumDaysToExpiration:21,maximumDaysToExpiration:180,maximumBidAskSpreadRatio:0.08,maximumQuoteAgeSeconds:30,maximumAccountSnapshotAgeSeconds:60,maximumPriceDeviationRatio:0.02,fractionalSharesPermitted:true,extendedHoursPermitted:false,earningsTradesPermitted:false,coveredCallsPermitted:false,protectivePutsPermitted:false,definedRiskSpreadsPermitted:false});
const jsonObject=(value:unknown):Readonly<Record<string,unknown>>=>typeof value==="object"&&value!==null&&!Array.isArray(value)?value as Readonly<Record<string,unknown>>:{};
const numberValue=(value:unknown):number=>typeof value==="number"?value:Number(value);
const iso=(value:unknown):string=>{if(value instanceof Date)return value.toISOString();const parsed=Date.parse(String(value));return Number.isFinite(parsed)?new Date(parsed).toISOString():String(value);};
const canonicalJson=(value:unknown):string=>{if(value===null||typeof value!=="object")return JSON.stringify(value)??"null";if(Array.isArray(value))return `[${value.map(canonicalJson).join(",")}]`;return `{${Object.entries(value as Readonly<Record<string,unknown>>).sort(([left],[right])=>left.localeCompare(right)).map(([key,item])=>`${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;};
const sensitiveIdempotencyReplayMarker=Object.freeze({reexecuteSensitiveResponse:true});
const persistenceSafeResponse=(value:unknown):unknown=>{if(typeof value!=="object"||value===null||Array.isArray(value))return value;const record=value as Readonly<Record<string,unknown>>;if(typeof record.authorizationUrl==="string"&&record.callbackScheme==="yield"&&record.returnUrl==="yield://broker-connection/callback"&&typeof record.pairingId==="string"&&typeof record.expiresAt==="string")return sensitiveIdempotencyReplayMarker;if(typeof record.pairingId!=="string"||typeof record.code!=="string"||typeof record.setupUrl!=="string")return value;let setupUrl=record.setupUrl;try{const parsed=new URL(setupUrl);parsed.search="";parsed.hash="";setupUrl=parsed.href;}catch{setupUrl="";}return {...record,code:"",setupUrl};};
const reexecutesSensitiveResponse=(value:unknown):boolean=>typeof value==="object"&&value!==null&&!Array.isArray(value)&&(value as Readonly<Record<string,unknown>>).reexecuteSensitiveResponse===true&&Object.keys(value).length===1;
const AGENT_SYMBOL_PATTERN=/^[A-Z][A-Z0-9.-]{0,14}$/;
const agentConfiguration=(agentId:string,value:unknown):Readonly<Record<string,unknown>>=>{if(typeof value!=="object"||value===null||Array.isArray(value))throw new DomainError("AGENT_CONFIGURATION_INVALID","Agent configuration must be an object",422);const configuration=value as Readonly<Record<string,unknown>>;if(agentId==="foundation-equity"){const symbol=typeof configuration.symbol==="string"?configuration.symbol.trim().toUpperCase():"";const targetOrderAmount=configuration.targetOrderAmount;if(!AGENT_SYMBOL_PATTERN.test(symbol)||typeof targetOrderAmount!=="number"||!Number.isFinite(targetOrderAmount)||targetOrderAmount<=0)throw new DomainError("AGENT_CONFIGURATION_INVALID","Foundation Equity requires a valid symbol and positive targetOrderAmount",422);return Object.freeze({...configuration,symbol,targetOrderAmount});}if(Object.keys(configuration).length===0)throw new DomainError("AGENT_CONFIGURATION_INVALID","An agent configuration is required",422);return Object.freeze({...configuration});};
const paperApprovalMode=(value:unknown):"observe"|"confirm_every_trade"=>{if(value!=="observe"&&value!=="confirm_every_trade")throw new DomainError("AGENT_APPROVAL_MODE_INVALID","Paper agents support observe or confirm-every-trade approval",422);return value;};
const researchUniverse=(value:unknown):readonly string[]=>{if(!Array.isArray(value)||value.length<1||value.length>50||value.some((symbol)=>typeof symbol!=="string"||!AGENT_SYMBOL_PATTERN.test(symbol))||new Set(value).size!==value.length)throw new DomainError("PLAN_AGENT_CATALOG_INVALID","A plan agent assignment has an invalid research universe",503);const symbols=value as string[];if(symbols.some((symbol,index)=>index>0&&symbols[index-1]!>=symbol))throw new DomainError("PLAN_AGENT_CATALOG_INVALID","A plan agent assignment research universe must be in canonical lexical order",503);return Object.freeze([...symbols]);};
const assertConfigurationResearchUniverse=(configuration:Readonly<Record<string,unknown>>,universe:readonly string[],agentId:string):void=>{const symbol=configuration.symbol;if(symbol!==undefined&&(typeof symbol!=="string"||!universe.includes(symbol)))throw new DomainError("AGENT_SYMBOL_NOT_ALLOWED","The configured symbol is not available for this exact plan agent assignment",409,{agentId});};
const storeKitDate=(value:string|undefined,field:string):string=>{if(value===undefined)throw new DomainError("SUBSCRIPTION_VERIFICATION_METADATA_REQUIRED",`Verified StoreKit ${field} is required`,422);const parsed=Date.parse(value);if(!Number.isFinite(parsed))throw new DomainError("SUBSCRIPTION_VERIFICATION_METADATA_INVALID",`Verified StoreKit ${field} is invalid`,422);return new Date(parsed).toISOString();};
const postgresCode=(error:unknown):string|undefined=>typeof error==="object"&&error!==null&&"code" in error&&typeof (error as{code?:unknown}).code==="string"?(error as{code:string}).code:undefined;
const AGENT_RELEASE_STATUSES=Object.freeze(["draft","paper","limited_rollout","live","paused","retired"] as const);
export const parsePlanAgentAssignments=(value:unknown):readonly PlanAgentAssignment[]=>{if(!Array.isArray(value)||value.length<1||value.length>3)throw new DomainError("PLAN_AGENT_CATALOG_INVALID","An active plan requires one to three agent assignments",503);const assignments=value.map((item,index)=>{const row=jsonObject(item);const position=Number(row.catalogPosition);if(typeof row.agentId!=="string"||row.agentId.length===0||typeof row.displayName!=="string"||row.displayName.length===0||typeof row.agentVersion!=="string"||row.agentVersion.length===0||position!==index+1||!AGENT_RELEASE_STATUSES.includes(row.releaseStatus as typeof AGENT_RELEASE_STATUSES[number])||typeof row.deterministicStrategyVersion!=="string"||row.deterministicStrategyVersion.length===0)throw new DomainError("PLAN_AGENT_CATALOG_INVALID","Plan agent assignment metadata is invalid",503);return Object.freeze({agentId:row.agentId,displayName:row.displayName,agentVersion:row.agentVersion,catalogPosition:position as 1|2|3,releaseStatus:row.releaseStatus as PlanAgentAssignment["releaseStatus"],deterministicStrategyVersion:row.deterministicStrategyVersion,researchUniverse:researchUniverse(row.researchUniverse)});});if(new Set(assignments.map((item)=>item.agentId)).size!==assignments.length)throw new DomainError("PLAN_AGENT_CATALOG_INVALID","A plan cannot map the same agent definition more than once",503);return Object.freeze(assignments);};
const planEntitlements=(value:unknown,agentIds:readonly string[]):Entitlements=>{const features=jsonObject(value);const booleanKeys=["stockTrading","optionsTrading","multiLegOptions","automaticMode","advancedAnalytics","customWatchlists","scannerAccess","prioritySupport"] as const;const maximumActiveAgents=Number(features.maximumActiveAgents);const monitoringFrequencyMinutes=Number(features.monitoringFrequencyMinutes);if(agentIds.length<1||agentIds.length>3||new Set(agentIds).size!==agentIds.length||!Number.isInteger(maximumActiveAgents)||maximumActiveAgents<1||maximumActiveAgents>3||!Number.isInteger(monitoringFrequencyMinutes)||monitoringFrequencyMinutes<1||booleanKeys.some((key)=>typeof features[key]!=="boolean"))throw new DomainError("PLAN_AGENT_CATALOG_INVALID","Plan features or agent assignments violate the one-to-three-agent contract",503);return Object.freeze({stockTrading:features.stockTrading as boolean,optionsTrading:features.optionsTrading as boolean,multiLegOptions:features.multiLegOptions as boolean,maximumActiveAgents,automaticMode:features.automaticMode as boolean,monitoringFrequencyMinutes,advancedAnalytics:features.advancedAnalytics as boolean,customWatchlists:features.customWatchlists as boolean,scannerAccess:features.scannerAccess as boolean,agentCatalog:Object.freeze([...agentIds]),prioritySupport:features.prioritySupport as boolean});};

async function cancelUnsubmittedAgentWork(
  transaction:TenantTransaction,
  userId:string,
  userAgentIds:readonly string[],
  now:string,
  reasonCode:"AGENT_PAUSED"|"ALL_AGENTS_PAUSED"|"AGENT_REMOVED"
):Promise<void>{
  if(userAgentIds.length===0)return;
  const canceled=await transaction.query<{id:string;fromStatus:string}>(
    `WITH candidates AS (
       SELECT proposal.id,proposal.status FROM trade_proposals AS proposal
       JOIN agent_runs AS run ON run.id=proposal.agent_run_id AND run.user_id=proposal.user_id
       WHERE proposal.user_id=$1 AND run.user_agent_id=ANY($2::uuid[])
         AND proposal.status IN ('DRAFT','ANALYZED','SCHEMA_VALIDATED','RISK_CHECKED','BROKER_REVIEWED','AWAITING_USER_APPROVAL','APPROVED')
         AND NOT EXISTS (
           SELECT 1 FROM orders AS submitted_order
           WHERE submitted_order.user_id=proposal.user_id AND submitted_order.proposal_id=proposal.id
         )
       FOR UPDATE OF proposal
     ), updated AS (
       UPDATE trade_proposals AS proposal SET status='CANCELED',version=version+1,updated_at=$3::timestamptz
       FROM candidates WHERE proposal.id=candidates.id
       RETURNING proposal.id::text,candidates.status::text AS "fromStatus"
     ) SELECT id,"fromStatus" FROM updated`,
    [userId,userAgentIds,now]
  );
  const proposalIds=canceled.rows.map((row)=>row.id);
  if(proposalIds.length>0){
    await transaction.query(
      `UPDATE approval_requests SET status='canceled',acted_at=COALESCE(acted_at,$3::timestamptz)
       WHERE user_id=$1 AND proposal_id=ANY($2::uuid[]) AND status='pending'`,
      [userId,proposalIds,now]
    );
    await transaction.query(
      `UPDATE queue_jobs SET status='dead_letter',last_error_code=$3,leased_by=NULL,leased_until=NULL
       WHERE user_id=$1 AND status IN ('queued','failed')
         AND (payload->>'proposalId'=ANY($2::text[]) OR idempotency_key=ANY($4::text[]))`,
      [userId,proposalIds,reasonCode,proposalIds.map((id)=>`proposal-ready:${id}`)]
    );
    for(const proposal of canceled.rows){
      await transaction.query(
        `INSERT INTO trade_proposal_events(
           proposal_id,user_id,from_status,to_status,actor_type,actor_id,reason_code,
           correlation_id,idempotency_key,metadata,occurred_at
         ) VALUES($1,$2,$3::proposal_status,'CANCELED','user',$4,$5,'api',$6,$7::jsonb,$8::timestamptz)
         ON CONFLICT(idempotency_key) DO NOTHING`,
        [proposal.id,userId,proposal.fromStatus,userId,reasonCode,`${reasonCode==="AGENT_REMOVED"?"remove":"pause"}:${proposal.id}:${now}`,JSON.stringify({source:reasonCode==="AGENT_REMOVED"?"authoritative_agent_removal":"authoritative_pause_control"}),now]
      );
    }
  }
  await transaction.query(
    `UPDATE capital_reservations SET released_at=COALESCE(released_at,$3::timestamptz)
     WHERE user_id=$1 AND user_agent_id=ANY($2::uuid[]) AND released_at IS NULL
       AND (proposal_id IS NULL OR proposal_id=ANY($4::uuid[]))`,
    [userId,userAgentIds,now,proposalIds]
  );
  await transaction.query(
    `UPDATE queue_jobs SET status='dead_letter',last_error_code=$3,leased_by=NULL,leased_until=NULL
     WHERE user_id=$1 AND status IN ('queued','failed') AND payload->>'userAgentId'=ANY($2::text[])
       AND queue_name IN ('agent-runs','market-data')`,
    [userId,userAgentIds,reasonCode]
  );
}

async function recordAgentRemovalConfirmation(
  transaction:TenantTransaction,
  userId:string,
  userAgentId:string,
  priorStatus:string,
  now:string
):Promise<void>{
  const notificationKey=`agent-removed:${userAgentId}:${now}`;
  await transaction.query(
    `INSERT INTO audit_events(
       user_id,actor_id,actor_role,action,reason,resource_type,resource_id,
       before_state,after_state,correlation_id,occurred_at
     ) VALUES($1,$2,'user','remove_agent','Authenticated agent removal control','user_agent',$3,
       $4::jsonb,'{"agentAssigned":false,"automationPaused":true,"positionsUntouched":true}'::jsonb,$5,$6::timestamptz)`,
    [userId,userId,userAgentId,JSON.stringify({agentAssigned:true,status:priorStatus}),notificationKey,now]
  );
  await transaction.query(
    `INSERT INTO queue_jobs(queue_name,user_id,job_type,payload,idempotency_key,available_at)
     VALUES('notifications',$1,'deliver_notification',$2::jsonb,$3,$4::timestamptz)
     ON CONFLICT(queue_name,idempotency_key) DO NOTHING`,
    [userId,JSON.stringify({
      notificationType:"agent_removed",
      priority:"normal",
      title:"Agent removed",
      privateBody:"The agent was removed. Unsubmitted work was canceled and positions were not changed.",
      publicBody:"Open Yield to review the agent removal confirmation.",
      deepLink:"yield://agents",
      occurredAt:now,
      notificationIdempotencyKey:notificationKey
    }),notificationKey,now]
  );
}

async function recordPauseConfirmation(
  transaction:TenantTransaction,
  userId:string,
  resourceType:"user_agent"|"account_automation",
  resourceId:string,
  now:string
):Promise<void>{
  const allAgents=resourceType==="account_automation";
  const notificationKey=`${allAgents?"all-agents-paused":"agent-paused"}:${resourceId}:${now}`;
  await transaction.query(
    `INSERT INTO audit_events(
       user_id,actor_id,actor_role,action,reason,resource_type,resource_id,
       before_state,after_state,correlation_id,occurred_at
     ) VALUES($1,$2,'user',$3,'Authenticated emergency pause control',$4,$5,
       '{"automationPaused":false}'::jsonb,'{"automationPaused":true,"positionsUntouched":true}'::jsonb,$6,$7::timestamptz)`,
    [userId,userId,allAgents?"pause_all_automation":"pause_agent",resourceType,resourceId,notificationKey,now]
  );
  await transaction.query(
    `INSERT INTO queue_jobs(queue_name,user_id,job_type,payload,idempotency_key,available_at)
     VALUES('notifications',$1,'deliver_notification',$2::jsonb,$3,$4::timestamptz)
     ON CONFLICT(queue_name,idempotency_key) DO NOTHING`,
    [userId,JSON.stringify({
      notificationType:allAgents?"all_agents_paused":"agent_paused",
      priority:"normal",
      title:allAgents?"All agents paused":"Agent paused",
      privateBody:allAgents?
        "All automation is paused. Unsubmitted proposals and scheduled work were canceled; positions were not changed.":
        "This agent is paused. Its unsubmitted proposals and scheduled work were canceled; positions were not changed.",
      publicBody:"Open Yield to review the pause confirmation.",
      deepLink:"yield://risk/pause",
      occurredAt:now,
      notificationIdempotencyKey:notificationKey
    }),notificationKey,now]
  );
}

export interface PostgresApiDataStoreOptions {readonly deviceBindingKey:Buffer;readonly deviceTokenEncryptionKey?:Buffer;}

export class PostgresApiDataStore implements ApiDataStore {
  public readonly persistenceKind="persistent" as const;
  public constructor(private readonly database:PostgresTenantDatabase,private readonly options:PostgresApiDataStoreOptions){if(options.deviceBindingKey.length<32)throw new TypeError("Device binding key must contain at least 32 bytes");if(options.deviceTokenEncryptionKey!==undefined&&options.deviceTokenEncryptionKey.length<32)throw new TypeError("Device-token encryption key must contain at least 32 bytes");}
  #deviceDigest(deviceId:string):string{return createHmac("sha256",this.options.deviceBindingKey).update(`device:${deviceId}`).digest("hex");}
  async #ensureDefaultRiskPolicy(userId:string,now:string):Promise<void>{await this.database.withTenant(userId,async(transaction)=>{await transaction.query(`INSERT INTO risk_policies(user_id,version,limits,exclusions,effective_at)
      SELECT $1,1,$2,'{"excludedSymbols":[],"excludedSectors":[]}'::jsonb,$3
      WHERE NOT EXISTS(SELECT 1 FROM risk_policies WHERE user_id=$1 AND superseded_at IS NULL)`,[userId,DEFAULT_POLICY_LIMITS,now]);});}
  async #lockUserAgentMutation(transaction:TenantTransaction,userId:string):Promise<void>{
    await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`whox:user-agent-assignments:${userId}`]);
  }
  async #currentUserAgentAssignmentScope(transaction:TenantTransaction,userId:string):Promise<{readonly planId:string;readonly maximumActiveAgents:number}>{
    const result=await transaction.query<{planId:string;maximumActiveAgents:unknown}>(`SELECT current_subscription.plan_id::text AS "planId",
        COALESCE(maximum_override.value,current_subscription.plan_features->'maximumActiveAgents') AS "maximumActiveAgents"
      FROM LATERAL (
        SELECT subscription.plan_id,plan.features AS plan_features
        FROM subscriptions AS subscription
        JOIN plans AS plan ON plan.id=subscription.plan_id AND plan.active
        WHERE subscription.user_id=$1 AND subscription.status IN ('active','grace_period')
          AND subscription.effective_at<=clock_timestamp() AND subscription.revoked_at IS NULL
          AND (subscription.expires_at IS NULL OR subscription.expires_at>clock_timestamp())
        ORDER BY subscription.effective_at DESC,subscription.created_at DESC,subscription.id DESC
        LIMIT 1
        FOR SHARE OF subscription
      ) AS current_subscription
      LEFT JOIN LATERAL (
        SELECT entitlement.value
        FROM entitlements AS entitlement
        WHERE entitlement.user_id=$1 AND entitlement.feature_key='maximumActiveAgents'
          AND entitlement.effective_at<=clock_timestamp()
          AND (entitlement.expires_at IS NULL OR entitlement.expires_at>clock_timestamp())
        ORDER BY entitlement.effective_at DESC,entitlement.id DESC
        LIMIT 1
        FOR SHARE OF entitlement
      ) AS maximum_override ON true`,[userId]);
    const row=result.rows[0];
    if(row===undefined)throw new DomainError("ACTIVE_SUBSCRIPTION_REQUIRED","A current active subscription is required",403);
    const maximumActiveAgents=Number(row.maximumActiveAgents);
    if(!Number.isInteger(maximumActiveAgents)||maximumActiveAgents<1||maximumActiveAgents>3)throw new DomainError("PLAN_AGENT_CATALOG_INVALID","The current plan active-agent limit is invalid",503);
    return Object.freeze({planId:row.planId,maximumActiveAgents});
  }
  async #lockUserAgentAssignmentMutation(transaction:TenantTransaction,userId:string):Promise<{readonly planId:string;readonly maximumActiveAgents:number}>{
    await this.#lockUserAgentMutation(transaction,userId);
    return await this.#currentUserAgentAssignmentScope(transaction,userId);
  }
  async #assertUserAgentCountWithinLimit(transaction:TenantTransaction,userId:string,maximumActiveAgents:number):Promise<void>{
    const result=await transaction.query<{count:number}>("SELECT count(*)::integer AS count FROM user_agents WHERE user_id=$1 AND deleted_at IS NULL",[userId]);
    const count=Number(result.rows[0]?.count);
    if(!Number.isInteger(count)||count<0)throw new DomainError("AGENT_ASSIGNMENT_STATE_INVALID","Current agent assignments could not be verified",503);
    if(count>maximumActiveAgents)throw new DomainError("AGENT_LIMIT_REACHED","The account has more assigned agents than the current subscription permits",409,{assignedAgentCount:count,maximumActiveAgents});
  }
  async #mappedAgentVersion(transaction:TenantTransaction,userId:string,agentId:string):Promise<{readonly planId:string;readonly id:string;readonly version:string;readonly status:string;readonly researchUniverse:readonly string[]}>{const result=await transaction.query<{planId:string;id:string;version:string;status:string;researchUniverse:unknown}>(`SELECT assignment.plan_id::text AS "planId",assignment.agent_version_id::text AS id,assignment.agent_version AS version,assignment.release_status AS status,assignment.research_universe AS "researchUniverse" FROM app.lock_current_plan_agent_assignment($1,$2,NULL::uuid) AS assignment`,[userId,agentId]);const row=result.rows[0];if(row===undefined)throw new DomainError("AGENT_NOT_ENTITLED","The current subscription does not map this agent version",403);const implementation=AGENT_CATALOG.find((item)=>item.agentId===agentId&&item.version===row.version);if(implementation===undefined||!["paper","limited_rollout","live"].includes(implementation.status)||!["paper","limited_rollout","live"].includes(row.status))throw new DomainError("AGENT_VERSION_UNAVAILABLE","The plan-mapped agent version has no enabled Paper runtime",409);return Object.freeze({...row,researchUniverse:researchUniverse(row.researchUniverse)});}
  async #assertAgentVersionMapped(transaction:TenantTransaction,userId:string,agentVersionId:string):Promise<{readonly planId:string;readonly agentId:string;readonly version:string;readonly status:string;readonly researchUniverse:readonly string[]}>{const result=await transaction.query<{planId:string;agentId:string;version:string;status:string;researchUniverse:unknown}>(`SELECT assignment.plan_id::text AS "planId",assignment.agent_key AS "agentId",assignment.agent_version AS version,assignment.release_status AS status,assignment.research_universe AS "researchUniverse" FROM app.lock_current_plan_agent_assignment($1,NULL::text,$2::uuid) AS assignment`,[userId,agentVersionId]);const row=result.rows[0];if(row===undefined)throw new DomainError("AGENT_NOT_ENTITLED","The current plan no longer includes this agent version",403);const implementation=AGENT_CATALOG.find((item)=>item.agentId===row.agentId&&item.version===row.version);if(implementation===undefined||!["paper","limited_rollout","live"].includes(implementation.status)||!["paper","limited_rollout","live"].includes(row.status))throw new DomainError("AGENT_VERSION_UNAVAILABLE","The plan-mapped agent version has no enabled Paper runtime",409);return Object.freeze({...row,researchUniverse:researchUniverse(row.researchUniverse)});}
  public async userForAppleSubject(subject:string,email?:string,displayName?:string):Promise<UserRecord>{const userId=await this.database.resolveAppleIdentity(subject,email,displayName,"paper");const account=await this.getUser(userId);if(account.accountMode!=="paper")throw new DomainError("ACCOUNT_MODE_MISMATCH","This identity is not enrolled in the Paper environment",409);await this.#ensureDefaultRiskPolicy(userId,new Date().toISOString());return account;}
  public async consumeAppleIdentityAssertion(assertionDigest:string,expiresAt:string,consumedAt:string):Promise<void>{await this.database.consumeAppleIdentityAssertion(assertionDigest,expiresAt,consumedAt);}
  public async consumeStepUpAuthentication(userId:string,verification:VerifiedStepUpAuthentication,usedAt:string):Promise<void>{
    if(verification.userId!==userId)throw new DomainError("STEP_UP_CONTEXT_MISMATCH","The verified authentication proof belongs to another user",403);
    try{
      await this.database.withTenant(userId,async(transaction)=>{await transaction.query(`INSERT INTO step_up_authentication_uses(user_id,verification_id,session_id,device_identifier_digest,action,resource_id,authentication_method,authenticated_at,expires_at,used_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[userId,verification.verificationId,verification.sessionId,this.#deviceDigest(verification.deviceId),verification.action,verification.resourceId,verification.method,verification.authenticatedAt,verification.expiresAt,usedAt]);});
    }catch(error){
      if(typeof error==="object"&&error!==null&&(error as{code?:string}).code==="23505")throw new DomainError("STEP_UP_PROOF_REPLAYED","The authentication proof was already used",409);
      throw error;
    }
  }
  public async getUser(userId:string):Promise<UserRecord>{return await this.database.withTenant(userId,async(transaction)=>{const result=await transaction.query<{userId:string;name:string|null;email:string|null;status:UserRecord["status"];onboardingStep:number;accountMode:UserRecord["accountMode"]}>(`SELECT id::text AS "userId",display_name AS name,email,status,onboarding_step AS "onboardingStep",account_mode AS "accountMode" FROM users WHERE id=$1 AND deleted_at IS NULL`,[userId]);const row=result.rows[0];if(row===undefined)throw new DomainError("USER_NOT_FOUND","User was not found",404);return {userId:row.userId,name:row.name??"Treasury User",email:row.email??"",status:row.status,onboardingStep:Number(row.onboardingStep),accountMode:row.accountMode};});}
  public async patchUser(userId:string,input:Readonly<Record<string,unknown>>):Promise<UserRecord>{if(input.accountMode!==undefined&&input.accountMode!=="paper")throw new DomainError("ACCOUNT_MODE_CHANGE_FORBIDDEN","Paper runtime cannot change account environments",409);const name=typeof input.name==="string"&&input.name.trim()!==""?input.name.trim():undefined;await this.database.withTenant(userId,async(transaction)=>{const result=await transaction.query("UPDATE users SET display_name=COALESCE($2,display_name) WHERE id=$1 AND status='active'",[userId,name??null]);if(result.rowCount!==1)throw new DomainError("USER_NOT_FOUND","User was not found",404);});return await this.getUser(userId);}
  public async onboarding(userId:string):Promise<Readonly<Record<string,unknown>>>{const account=await this.getUser(userId);const eligibility=await this.eligibility(userId);const riskCurrent=await this.database.withTenant(userId,async(transaction)=>(await transaction.query<{exists:boolean}>("SELECT EXISTS(SELECT 1 FROM risk_assessments WHERE user_id=$1 AND superseded_at IS NULL) AS exists",[userId])).rows[0]?.exists===true);const legalComplete=await this.hasAllRequiredLegalConsents(userId);return Object.freeze({currentStep:account.onboardingStep,completed:account.onboardingStep>=14&&eligibility?.status==="eligible"&&riskCurrent&&legalComplete,resumable:true,eligibilityStatus:eligibility?.status??"not_assessed",riskAssessmentStatus:riskCurrent?"current":"not_assessed",legalConsentsComplete:legalComplete});}
  public async updateOnboarding(userId:string,step:number):Promise<Readonly<Record<string,unknown>>>{if(!Number.isInteger(step)||step<1||step>14)throw new DomainError("ONBOARDING_STEP_INVALID","Onboarding step must be between 1 and 14",400);if(step>=4)await this.requireEligible(userId);if(step>=6)await this.currentRiskAssessment(userId);if(step>=14&&!await this.hasAllRequiredLegalConsents(userId))throw new DomainError("LEGAL_CONSENTS_REQUIRED","Every applicable current legal-document version must be accepted before onboarding can be completed",409);await this.database.withTenant(userId,async(transaction)=>{await transaction.query("UPDATE users SET onboarding_step=GREATEST(onboarding_step,$2) WHERE id=$1",[userId,step]);});return await this.onboarding(userId);}
  public async eligibility(userId:string):Promise<EligibilityRecord|undefined>{return await this.database.withTenant(userId,async(transaction)=>{const result=await transaction.query<{id:string;country:string;region:string|null;ageEligible:boolean;individualAccount:boolean;understands:boolean;classification:EligibilityRecord["adviserClientClassification"];status:string;reasons:unknown;version:string;recordedAt:string}>(`SELECT id::text,country,region,age_eligible AS "ageEligible",own_individual_account AS "individualAccount",understands_not_bank_or_broker AS understands,adviser_client_classification AS classification,eligibility_status AS status,decision_reasons AS reasons,assessment_version AS version,assessed_at::text AS "recordedAt" FROM eligibility_profiles WHERE user_id=$1 AND superseded_at IS NULL`,[userId]);const row=result.rows[0];if(row===undefined)return undefined;const status=row.status==="review"?"review_required":row.status as EligibilityRecord["status"];const reasons=Array.isArray(row.reasons)?row.reasons as EligibilityRecord["reasons"]:[];return Object.freeze({id:row.id,userId,country:row.country.trim(),region:row.region??"",ageEligible:row.ageEligible,individualAccount:row.individualAccount,understandsNotBankOrBroker:row.understands,adviserClientClassification:row.classification,status,eligible:status==="eligible",reasons,assessmentVersion:row.version,recordedAt:iso(row.recordedAt)});});}
  public async recordEligibility(userId:string,input:Readonly<Record<string,unknown>>,recordedAt:string):Promise<EligibilityRecord>{await this.getUser(userId);const record=assessEligibility(input,randomUUID(),userId,recordedAt);await this.database.withTenant(userId,async(transaction)=>{await transaction.query("UPDATE eligibility_profiles SET superseded_at=$2 WHERE user_id=$1 AND superseded_at IS NULL",[userId,recordedAt]);await transaction.query(`INSERT INTO eligibility_profiles(id,user_id,country,region,age_eligible,own_individual_account,understands_not_bank_or_broker,adviser_client_classification,eligibility_status,decision_reasons,assessment_version,assessed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`,[record.id,userId,record.country,record.region,record.ageEligible,record.individualAccount,record.understandsNotBankOrBroker,record.adviserClientClassification,record.status==="review_required"?"review":record.status,JSON.stringify(record.reasons),record.assessmentVersion,recordedAt]);await transaction.query("UPDATE users SET jurisdiction_country=$2,jurisdiction_region=$3,onboarding_step=CASE WHEN $4='eligible' THEN onboarding_step ELSE LEAST(onboarding_step,3) END WHERE id=$1",[userId,record.country,record.region,record.status]);});return record;}
  public async requireEligible(userId:string):Promise<EligibilityRecord>{const record=await this.eligibility(userId);if(record===undefined)throw new DomainError("ELIGIBILITY_REQUIRED","An eligibility assessment is required before onboarding can continue",409);if(record.status!=="eligible")throw new DomainError("ELIGIBILITY_NOT_APPROVED","Eligibility is ineligible or requires review",409,{status:record.status,reasons:record.reasons});return record;}
  public async createRiskAssessment(userId:string,input:Readonly<Record<string,unknown>>,recordedAt:string):Promise<RiskAssessmentRecord>{await this.requireEligible(userId);const record=evaluateRiskAssessment(input,randomUUID(),userId,recordedAt);await this.database.withTenant(userId,async(transaction)=>{await transaction.query("UPDATE risk_assessments SET superseded_at=$2 WHERE user_id=$1 AND superseded_at IS NULL",[userId,recordedAt]);await transaction.query(`INSERT INTO risk_assessments(id,user_id,classification,options_classification,score,factors,rationale,scoring_version,explanation,completed_at)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)`,[record.id,userId,record.classification,record.optionsClassification,record.score,JSON.stringify(record.factors),JSON.stringify(record.rationale),record.scoringVersion,record.explanation,recordedAt]);for(const[questionId,answer]of Object.entries(record.answers))await transaction.query("INSERT INTO risk_assessment_answers(assessment_id,question_id,answer) VALUES($1,$2,$3::jsonb)",[record.id,questionId,JSON.stringify(answer)]);});return record;}
  public async currentRiskAssessment(userId:string):Promise<RiskAssessmentRecord>{return await this.database.withTenant(userId,async(transaction)=>{const result=await transaction.query<{id:string;classification:RiskAssessmentRecord["classification"];optionsClassification:RiskAssessmentRecord["optionsClassification"];score:number;factors:RiskAssessmentRecord["factors"];rationale:RiskAssessmentRecord["rationale"];scoringVersion:string;explanation:string;recordedAt:string;answers:Readonly<Record<string,unknown>>}>(`SELECT r.id::text,r.classification,r.options_classification AS "optionsClassification",r.score,r.factors,r.rationale,r.scoring_version AS "scoringVersion",r.explanation,r.completed_at::text AS "recordedAt",COALESCE(jsonb_object_agg(a.question_id,a.answer) FILTER(WHERE a.question_id IS NOT NULL),'{}'::jsonb) AS answers FROM risk_assessments r LEFT JOIN risk_assessment_answers a ON a.assessment_id=r.id WHERE r.user_id=$1 AND r.superseded_at IS NULL GROUP BY r.id`,[userId]);const row=result.rows[0];if(row===undefined)throw new DomainError("RISK_ASSESSMENT_NOT_FOUND","A current risk assessment was not found",404);return Object.freeze({...row,userId,status:"current" as const,recordedAt:iso(row.recordedAt),answers:row.answers as unknown as RiskAssessmentRecord["answers"]});});}
  async #deviceIdForSession(transaction:TenantTransaction,userId:string,sessionId:string,clientDeviceId:string):Promise<string>{const result=await transaction.query<{id:string}>(`SELECT d.id::text FROM sessions s JOIN devices d ON d.id=s.device_id AND d.user_id=s.user_id WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND d.revoked_at IS NULL AND d.client_identifier_digest=$3`,[sessionId,userId,this.#deviceDigest(clientDeviceId)]);const id=result.rows[0]?.id;if(id===undefined)throw new DomainError("SESSION_DEVICE_MISMATCH","Session device was not found",403);return id;}
  public async recordLegalConsents(userId:string,input:Readonly<Record<string,unknown>>,sessionId:string,deviceId:string,acceptedAt:string):Promise<Readonly<Record<string,unknown>>>{if(input.accepted!==true)throw new DomainError("LEGAL_CONSENT_NOT_ACCEPTED","Explicit acceptance is required",422);if(typeof input.documentVersions!=="object"||input.documentVersions===null||Array.isArray(input.documentVersions))throw new DomainError("LEGAL_CONSENT_INPUT_INVALID","documentVersions must be an object",422);const requested=Object.entries(input.documentVersions as Readonly<Record<string,unknown>>);if(requested.length===0||requested.some(([,version])=>typeof version!=="string"))throw new DomainError("LEGAL_CONSENT_INPUT_INVALID","At least one document version must be accepted",422);const records=await this.database.withTenant(userId,async(transaction)=>{const storedDeviceId=await this.#deviceIdForSession(transaction,userId,sessionId,deviceId);const accepted:LegalConsentRecord[]=[];for(const[key,version]of requested){const document=await transaction.query<{id:string}>(`SELECT id::text FROM legal_documents WHERE document_key=$1 AND version=$2 AND production_approved=true AND published_at<=clock_timestamp() AND (retired_at IS NULL OR retired_at>clock_timestamp())`,[key,version]);const legalDocumentId=document.rows[0]?.id;if(legalDocumentId===undefined)throw new DomainError("LEGAL_DOCUMENT_VERSION_UNAVAILABLE","The requested legal-document version is not approved, published, and current",409,{documentKey:key});const id=randomUUID();await transaction.query(`INSERT INTO legal_consents(id,user_id,legal_document_id,accepted_at,device_id) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(user_id,legal_document_id,accepted_at) DO NOTHING`,[id,userId,legalDocumentId,acceptedAt,storedDeviceId]);accepted.push(Object.freeze({id,userId,documentKey:key,documentVersion:String(version),acceptedAt,sessionId,deviceId}));}return accepted;});return Object.freeze({accepted:true,acceptedAt,consents:Object.freeze(records),allRequiredCurrentDocumentsAccepted:await this.hasAllRequiredLegalConsents(userId)});}
  public async legalDocuments(userId:string):Promise<readonly Readonly<Record<string,unknown>>[]>{
    const entitlements=await this.entitlements(userId);
    const eligibility=await this.eligibility(userId);
    const keys=[...BASE_LEGAL_KEYS,...(entitlements.optionsTrading?["options"]:[]),...(eligibility?.adviserClientClassification==="adviser_client"?["advisory"]:[])];
    return await this.database.withTenant(userId,async(transaction)=>{
      const result=await transaction.query<{
        id:string;title:string;version:string;contentURI:string;contentSHA256:string;publishedAt:string;
      }>(
        `SELECT DISTINCT ON(document_key) document_key AS id,title,version,content_uri AS "contentURI",
           content_sha256 AS "contentSHA256",published_at::text AS "publishedAt"
         FROM legal_documents
         WHERE document_key=ANY($1::text[]) AND production_approved=true AND published_at<=clock_timestamp()
           AND (retired_at IS NULL OR retired_at>clock_timestamp())
         ORDER BY document_key,published_at DESC,created_at DESC`,
        [keys]
      );
      if(result.rows.length!==keys.length)throw new DomainError("LEGAL_DOCUMENTS_UNAVAILABLE","Every applicable counsel-approved current legal document must be published before Paper onboarding",503);
      return Object.freeze(result.rows.map((row)=>{
        let contentURL:URL;
        try{contentURL=new URL(row.contentURI);}catch{throw new DomainError("LEGAL_DOCUMENT_CONTENT_URI_INVALID","A published legal document URI is invalid",500,{documentKey:row.id});}
        if(contentURL.protocol!=="https:"||contentURL.username!==""||contentURL.password!=="")throw new DomainError("LEGAL_DOCUMENT_CONTENT_URI_INVALID","Published legal documents require credential-free HTTPS URIs",500,{documentKey:row.id});
        return Object.freeze({...row,productionApproved:true,required:true,publishedAt:iso(row.publishedAt)});
      }));
    });
  }
  public async legalConsents(userId:string):Promise<readonly LegalConsentRecord[]>{return await this.database.withTenant(userId,async(transaction)=>{const result=await transaction.query<{id:string;documentKey:string;documentVersion:string;acceptedAt:string;sessionId:string;deviceId:string}>(`SELECT lc.id::text,ld.document_key AS "documentKey",ld.version AS "documentVersion",lc.accepted_at::text AS "acceptedAt",COALESCE((SELECT s.id::text FROM sessions s WHERE s.device_id=lc.device_id AND s.user_id=lc.user_id ORDER BY s.created_at DESC LIMIT 1),'') AS "sessionId",COALESCE(d.public_identifier::text,'') AS "deviceId" FROM legal_consents lc JOIN legal_documents ld ON ld.id=lc.legal_document_id LEFT JOIN devices d ON d.id=lc.device_id AND d.user_id=lc.user_id WHERE lc.user_id=$1 AND lc.revoked_at IS NULL ORDER BY lc.accepted_at`,[userId]);return Object.freeze(result.rows.map((row)=>Object.freeze({...row,userId,acceptedAt:iso(row.acceptedAt)})));});}
  public async hasAllRequiredLegalConsents(userId:string):Promise<boolean>{const entitlements=await this.entitlements(userId);const eligibility=await this.eligibility(userId);const keys=[...BASE_LEGAL_KEYS,...(entitlements.optionsTrading?["options"]:[]),...(eligibility?.adviserClientClassification==="adviser_client"?["advisory"]:[])];return await this.database.withTenant(userId,async(transaction)=>{const result=await transaction.query<{complete:boolean}>(`SELECT COUNT(DISTINCT required.document_key)=cardinality($2::text[]) AS complete FROM (SELECT DISTINCT ON(document_key) id,document_key FROM legal_documents WHERE production_approved=true AND published_at<=clock_timestamp() AND (retired_at IS NULL OR retired_at>clock_timestamp()) AND document_key=ANY($2::text[]) ORDER BY document_key,published_at DESC,created_at DESC) required JOIN legal_consents lc ON lc.legal_document_id=required.id AND lc.user_id=$1 AND lc.revoked_at IS NULL`,[userId,keys]);return result.rows[0]?.complete===true;});}
  public async plans(userId?:string):Promise<readonly SubscriptionPlanCatalog[]>{if(userId===undefined)throw new DomainError("AUTH_REQUIRED","Authentication is required",401);return await this.database.withTenant(userId,async(transaction)=>{const result=await transaction.query<{id:string;name:string;productId:string;features:Readonly<Record<string,unknown>>;agentCatalogVersion:number|null;agents:unknown}>(`SELECT plan.plan_key AS id,plan.display_name AS name,plan.product_id AS "productId",plan.features,catalog.version AS "agentCatalogVersion",COALESCE(assignments.agents,'[]'::jsonb) AS agents
      FROM plans AS plan
      LEFT JOIN plan_agent_catalog_versions AS catalog ON catalog.plan_id=plan.id AND catalog.activated_at IS NOT NULL AND catalog.activated_at<=clock_timestamp() AND catalog.superseded_at IS NULL
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
          'agentId',definition.agent_key,
          'displayName',definition.display_name,
          'agentVersion',agent_version.version,
          'catalogPosition',entry.position,
          'releaseStatus',agent_version.status,
          'deterministicStrategyVersion',agent_version.deterministic_strategy_version,
          'researchUniverse',to_jsonb(entry.research_universe)
        ) ORDER BY entry.position) AS agents
        FROM plan_agent_catalog_entries AS entry
        JOIN agent_versions AS agent_version ON agent_version.id=entry.agent_version_id
        JOIN agent_definitions AS definition ON definition.id=agent_version.agent_definition_id
        WHERE entry.catalog_version_id=catalog.id
      ) AS assignments ON true
      WHERE plan.active ORDER BY plan.created_at`);return Object.freeze(result.rows.map((row)=>{const agents=parsePlanAgentAssignments(row.agents);const catalogVersion=Number(row.agentCatalogVersion);if(!Number.isInteger(catalogVersion)||catalogVersion<1)throw new DomainError("PLAN_AGENT_CATALOG_INVALID","An active plan has no current agent catalog version",503);return Object.freeze({id:row.id,name:row.name,productId:row.productId,features:planEntitlements(row.features,agents.map((item)=>item.agentId)),agentCatalogVersion:catalogVersion,agents});}));});}
  public async subscription(userId:string):Promise<Readonly<Record<string,unknown>>>{return await this.database.withTenant(userId,async(transaction)=>{const result=await transaction.query<{status:string;planId:string;productId:string;renewsAt:string|null}>(`SELECT s.status,p.plan_key AS "planId",p.product_id AS "productId",s.expires_at::text AS "renewsAt" FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.user_id=$1 ORDER BY s.effective_at DESC LIMIT 1`,[userId]);const row=result.rows[0];return row===undefined?Object.freeze({status:"pending",planId:null,productId:null,source:"none",renewsAt:null}):Object.freeze({...row,source:"verified_storekit"});});}
  public async syncVerifiedSubscription(userId:string,verified:VerifiedStoreKitTransaction):Promise<Readonly<Record<string,unknown>>>{
    if(verified.environment!=="Sandbox"&&verified.environment!=="Production")throw new DomainError("STOREKIT_ENVIRONMENT_DISABLED","Persistent Paper subscriptions accept only Apple Sandbox or Production transactions",422);
    if(verified.appAccountToken?.toLowerCase()!==userId.toLowerCase())throw new DomainError("STOREKIT_ACCOUNT_TOKEN_MISMATCH","Signed transaction is not bound to the authenticated WHOX account",403);
    if(verified.signedPayloadDigest===undefined||!/^[0-9a-f]{64}$/.test(verified.signedPayloadDigest))throw new DomainError("SUBSCRIPTION_VERIFICATION_METADATA_REQUIRED","Verified StoreKit signed-payload digest is required",422);
    for(const[field,value]of [["product identifier",verified.productID],["transaction identifier",verified.transactionID],["original transaction identifier",verified.originalTransactionID]] as const)if(value.length<1||value.length>255)throw new DomainError("SUBSCRIPTION_VERIFICATION_METADATA_INVALID",`Verified StoreKit ${field} is invalid`,422);
    const purchasedAt=storeKitDate(verified.purchasedAt,"purchase date");const expiresAt=storeKitDate(verified.expiresAt,"expiration date");const signedAt=storeKitDate(verified.signedAt,"signed date");const revokedAt=verified.revokedAt===undefined?null:storeKitDate(verified.revokedAt,"revocation date");
    try{await this.database.withTenant(userId,async(transaction)=>{
      await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${verified.environment}:${verified.originalTransactionID}`]);
      const resolved=await transaction.query<{userId:string|null}>("SELECT app.resolve_storekit_notification_tenant($1,$2,$3)::text AS \"userId\"",[verified.originalTransactionID,verified.environment.toLowerCase(),verified.appAccountToken]);
      if(resolved.rows[0]?.userId?.toLowerCase()!==userId.toLowerCase())throw new DomainError("STOREKIT_ACCOUNT_TOKEN_MISMATCH","Original transaction belongs to a different WHOX account",409);
      const plan=await transaction.query<{id:string}>("SELECT id::text FROM plans WHERE product_id=$1 AND active=true",[verified.productID]);const planId=plan.rows[0]?.id;if(planId===undefined)throw new DomainError("SUBSCRIPTION_PRODUCT_UNKNOWN","Subscription product is not configured",400);
      const state=await transaction.query<{status:"active"|"expired"|"refunded"}>("SELECT CASE WHEN $1::timestamptz IS NOT NULL THEN 'refunded' WHEN $2::timestamptz<=clock_timestamp() THEN 'expired' ELSE 'active' END AS status",[revokedAt,expiresAt]);const status=state.rows[0]!.status;
      const current=await transaction.query<{id:string}>("SELECT id::text FROM subscriptions WHERE user_id=$1 AND original_transaction_id=$2 AND environment=$3",[userId,verified.originalTransactionID,verified.environment.toLowerCase()]);let subscriptionId=current.rows[0]?.id;
      const stale=subscriptionId===undefined?false:(await transaction.query<{stale:boolean}>("SELECT EXISTS(SELECT 1 FROM subscription_events WHERE subscription_id=$1 AND event_timestamp>$2::timestamptz) AS stale",[subscriptionId,signedAt])).rows[0]?.stale===true;
      if(!stale){const upserted=await transaction.query<{id:string}>(`INSERT INTO subscriptions(user_id,plan_id,original_transaction_id,status,environment,effective_at,expires_at,revoked_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(original_transaction_id,environment) DO UPDATE SET plan_id=EXCLUDED.plan_id,status=EXCLUDED.status,effective_at=LEAST(subscriptions.effective_at,EXCLUDED.effective_at),expires_at=EXCLUDED.expires_at,revoked_at=EXCLUDED.revoked_at,updated_at=clock_timestamp()
        WHERE subscriptions.user_id=EXCLUDED.user_id RETURNING id::text`,[userId,planId,verified.originalTransactionID,status,verified.environment.toLowerCase(),purchasedAt,expiresAt,revokedAt]);subscriptionId=upserted.rows[0]?.id;if(subscriptionId===undefined)throw new DomainError("STOREKIT_ACCOUNT_TOKEN_MISMATCH","Original transaction belongs to a different WHOX account",409);}
      await transaction.query(`INSERT INTO subscription_events(subscription_id,transaction_id,event_type,signed_payload_digest,event_timestamp,idempotency_key,payload)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING`,[subscriptionId,verified.transactionID,`client_sync:${status}`,verified.signedPayloadDigest,signedAt,`storekit-sync:${verified.environment.toLowerCase()}:${verified.transactionID}:${status}`,JSON.stringify({source:"verified_storekit",productID:verified.productID,environment:verified.environment,purchasedAt,expiresAt,...(revokedAt===null?{}:{revokedAt}),stale})]);
    });}catch(error){if(postgresCode(error)==="23514")throw new DomainError("STOREKIT_ACCOUNT_TOKEN_MISMATCH","Original transaction belongs to a different WHOX account",409);throw error;}
    return await this.subscription(userId);
  }
  public async entitledProductIds(userId:string):Promise<readonly string[]>{return await this.database.withTenant(userId,async(transaction)=>{const result=await transaction.query<{productId:string}>(`SELECT DISTINCT p.product_id AS "productId" FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.user_id=$1 AND s.status IN ('active','grace_period') AND (s.expires_at IS NULL OR s.expires_at>clock_timestamp())`,[userId]);return Object.freeze(result.rows.map((row)=>row.productId));});}
  public async entitlements(userId:string):Promise<Entitlements>{return await this.database.withTenant(userId,async(transaction)=>{const result=await transaction.query<{features:Readonly<Record<string,unknown>>;catalogVersion:number|null;agentCatalog:string[]|null}>(`SELECT plan.features||COALESCE(overrides.values,'{}'::jsonb) AS features,catalog.version AS "catalogVersion",assignments.agent_catalog AS "agentCatalog"
      FROM subscriptions AS subscription
      JOIN plans AS plan ON plan.id=subscription.plan_id AND plan.active
      LEFT JOIN plan_agent_catalog_versions AS catalog ON catalog.plan_id=plan.id AND catalog.activated_at IS NOT NULL AND catalog.activated_at<=clock_timestamp() AND catalog.superseded_at IS NULL
      LEFT JOIN LATERAL (
        SELECT array_agg(definition.agent_key ORDER BY entry.position) AS agent_catalog
        FROM plan_agent_catalog_entries AS entry
        JOIN agent_versions AS agent_version ON agent_version.id=entry.agent_version_id
        JOIN agent_definitions AS definition ON definition.id=agent_version.agent_definition_id
        WHERE entry.catalog_version_id=catalog.id
      ) AS assignments ON true
      LEFT JOIN LATERAL (
        SELECT jsonb_object_agg(latest.feature_key,latest.value) AS values
        FROM (
          SELECT DISTINCT ON (entitlement.feature_key) entitlement.feature_key,entitlement.value
          FROM entitlements AS entitlement
          WHERE entitlement.user_id=subscription.user_id
            AND entitlement.effective_at<=clock_timestamp()
            AND (entitlement.expires_at IS NULL OR entitlement.expires_at>clock_timestamp())
          ORDER BY entitlement.feature_key,entitlement.effective_at DESC,entitlement.id DESC
        ) AS latest
      ) AS overrides ON true
      WHERE subscription.user_id=$1 AND subscription.status IN ('active','grace_period')
        AND subscription.effective_at<=clock_timestamp() AND subscription.revoked_at IS NULL
        AND (subscription.expires_at IS NULL OR subscription.expires_at>clock_timestamp())
      ORDER BY subscription.effective_at DESC,subscription.created_at DESC LIMIT 1`,[userId]);const row=result.rows[0];if(row===undefined)return EMPTY_ENTITLEMENTS;if(!Number.isInteger(Number(row.catalogVersion))||row.agentCatalog===null)throw new DomainError("PLAN_AGENT_CATALOG_INVALID","The active subscription plan has no current agent catalog",503);return planEntitlements(row.features,row.agentCatalog);});}
  public async riskPolicy(userId:string):Promise<RiskPolicy>{await this.#ensureDefaultRiskPolicy(userId,new Date().toISOString());return await this.database.withTenant(userId,async(transaction)=>{const result=await transaction.query<{id:string;version:number;limits:Readonly<Record<string,unknown>>;exclusions:Readonly<Record<string,unknown>>;updatedAt:string}>(`SELECT id::text,version,limits,exclusions,effective_at::text AS "updatedAt" FROM risk_policies WHERE user_id=$1 AND superseded_at IS NULL`,[userId]);const row=result.rows[0];if(row===undefined)throw new DomainError("RISK_POLICY_NOT_FOUND","Risk policy was not found",404);return {...row.limits,...row.exclusions,policyId:row.id,userId,version:Number(row.version),updatedAt:iso(row.updatedAt),excludedSymbols:Array.isArray(row.exclusions.excludedSymbols)?row.exclusions.excludedSymbols:[],excludedSectors:Array.isArray(row.exclusions.excludedSectors)?row.exclusions.excludedSectors:[]} as unknown as RiskPolicy;});}
  public async setRiskPolicy(userId:string,policy:RiskPolicy):Promise<RiskPolicy>{const violations=validateUserPolicyAgainstPlatform(policy);if(violations.length>0)throw new DomainError("RISK_POLICY_EXCEEDS_PLATFORM","Risk policy exceeds platform caps",422,{fields:violations});await this.database.withTenant(userId,async(transaction)=>{const current=await transaction.query<{id:string;version:number}>("SELECT id::text,version FROM risk_policies WHERE user_id=$1 AND superseded_at IS NULL FOR UPDATE",[userId]);const row=current.rows[0];if(row===undefined)throw new DomainError("RISK_POLICY_NOT_FOUND","Risk policy was not found",404);const version=Number(row.version)+1;if(policy.policyId!==row.id||policy.version!==version)throw new DomainError("RISK_POLICY_VERSION_CONFLICT","The risk policy changed before this update could be applied",409);await transaction.query("UPDATE risk_policies SET superseded_at=$2 WHERE user_id=$1 AND superseded_at IS NULL",[userId,policy.updatedAt]);const {policyId:_,userId:__,version:___,updatedAt:____,excludedSymbols,excludedSectors,...limits}=policy;await transaction.query("INSERT INTO risk_policies(id,user_id,version,limits,exclusions,effective_at) VALUES($1,$2,$3,$4,$5,$6)",[randomUUID(),userId,version,limits,{excludedSymbols,excludedSectors},policy.updatedAt]);});return await this.riskPolicy(userId);}
  public async userAgents(userId:string):Promise<readonly UserAgentRecord[]>{return await this.database.withTenant(userId,async(transaction)=>{const result=await transaction.query<{id:string;userId:string;agentId:string;status:string;allocation:number;approvalMode:UserAgentRecord["approvalMode"];configurationVersion:number|null;configuration:Readonly<Record<string,unknown>>|null;createdAt:string;updatedAt:string}>(`SELECT ua.id::text,ua.user_id::text AS "userId",ad.agent_key AS "agentId",ua.status,ua.allocation_limit::float8 AS allocation,ua.approval_mode AS "approvalMode",ac.version AS "configurationVersion",ac.configuration,ua.created_at::text AS "createdAt",ua.updated_at::text AS "updatedAt" FROM user_agents ua JOIN agent_versions av ON av.id=ua.agent_version_id JOIN agent_definitions ad ON ad.id=av.agent_definition_id LEFT JOIN LATERAL (SELECT version,configuration FROM agent_configurations WHERE user_agent_id=ua.id AND user_id=ua.user_id AND superseded_at IS NULL ORDER BY effective_at DESC LIMIT 1) ac ON true WHERE ua.user_id=$1 AND ua.deleted_at IS NULL ORDER BY ua.created_at`,[userId]);return Object.freeze(result.rows.map((row)=>Object.freeze({...row,status:row.status==="monitoring"?"monitoring":"paused" as const,allocation:Number(row.allocation),configurationVersion:Number(row.configurationVersion??0),configuration:Object.freeze({...jsonObject(row.configuration)}),createdAt:iso(row.createdAt),updatedAt:iso(row.updatedAt)})));});}
  public async addUserAgent(userId:string,input:Readonly<Record<string,unknown>>,now:string):Promise<UserAgentRecord>{
    const agentId=typeof input.agentId==="string"?input.agentId:"";
    const definition=AGENT_CATALOG.find((item)=>item.agentId===agentId);
    if(definition===undefined)throw new DomainError("AGENT_NOT_FOUND","Agent definition was not found",404);
    const policy=await this.riskPolicy(userId);
    const allocation=input.allocation===undefined?0.1:input.allocation;
    if(typeof allocation!=="number"||!Number.isFinite(allocation)||allocation<=0||allocation>Math.min(0.8,policy.maximumAccountAllocation))throw new DomainError("AGENT_ALLOCATION_INVALID","Agent allocation exceeds the effective risk policy",422);
    const approvalMode=paperApprovalMode(input.approvalMode??"observe");
    const id=randomUUID();
    await this.database.withTenant(userId,async(transaction)=>{
      const assignmentScope=await this.#lockUserAgentAssignmentMutation(transaction,userId);
      const mappedVersion=await this.#mappedAgentVersion(transaction,userId,agentId);
      if(mappedVersion.planId!==assignmentScope.planId)throw new DomainError("AGENT_NOT_ENTITLED","The authoritative current plan does not include this agent version",403);
      const configuration=agentConfiguration(agentId,input.configuration);
      assertConfigurationResearchUniverse(configuration,mappedVersion.researchUniverse,agentId);
      const assigned=await transaction.query<{count:number;duplicate:boolean}>(`SELECT count(*)::integer AS count,
          COALESCE(bool_or(agent_version_id=$2::uuid),false) AS duplicate
        FROM user_agents WHERE user_id=$1 AND deleted_at IS NULL`,[userId,mappedVersion.id]);
      const assignmentCount=Number(assigned.rows[0]?.count);
      if(!Number.isInteger(assignmentCount)||assignmentCount<0)throw new DomainError("AGENT_ASSIGNMENT_STATE_INVALID","Current agent assignments could not be verified",503);
      if(assigned.rows[0]?.duplicate===true)throw new DomainError("AGENT_ALREADY_ASSIGNED","This plan agent is already assigned to the account",409);
      if(assignmentCount>=assignmentScope.maximumActiveAgents)throw new DomainError("AGENT_LIMIT_REACHED","Subscription active-agent limit reached",409);
      await transaction.query("INSERT INTO user_agents(id,user_id,agent_version_id,status,environment,allocation_limit,approval_mode,created_at,updated_at) VALUES($1,$2,$3,'paused','paper',$4,$5,$6,$6)",[id,userId,mappedVersion.id,allocation,approvalMode,now]);
      await transaction.query("INSERT INTO agent_configurations(user_agent_id,user_id,version,configuration,effective_at) VALUES($1,$2,1,$3::jsonb,$4)",[id,userId,JSON.stringify(configuration),now]);
    });
    const created=(await this.userAgents(userId)).find((item)=>item.id===id);
    if(created===undefined)throw new DomainError("AGENT_ASSIGNMENT_STATE_INVALID","The persisted agent assignment could not be loaded",500);
    return created;
  }
  public async patchUserAgent(userId:string,id:string,input:Readonly<Record<string,unknown>>,now:string):Promise<UserAgentRecord>{const policy=await this.riskPolicy(userId);let allocation:number|undefined;if(input.allocation!==undefined){if(typeof input.allocation!=="number"||!Number.isFinite(input.allocation)||input.allocation<=0||input.allocation>Math.min(0.8,policy.maximumAccountAllocation))throw new DomainError("AGENT_ALLOCATION_INVALID","Agent allocation exceeds the effective risk policy",422);allocation=input.allocation;}const approvalMode=input.approvalMode===undefined?undefined:paperApprovalMode(input.approvalMode);await this.database.withTenant(userId,async(transaction)=>{const current=await transaction.query<{agentId:string;agentVersionId:string;configurationVersion:number|null;configuration:Readonly<Record<string,unknown>>|null}>(`SELECT ad.agent_key AS "agentId",av.id::text AS "agentVersionId",ac.version AS "configurationVersion",ac.configuration FROM user_agents ua JOIN agent_versions av ON av.id=ua.agent_version_id JOIN agent_definitions ad ON ad.id=av.agent_definition_id LEFT JOIN LATERAL (SELECT version,configuration FROM agent_configurations WHERE user_agent_id=ua.id AND user_id=ua.user_id AND superseded_at IS NULL ORDER BY effective_at DESC LIMIT 1) ac ON true WHERE ua.id=$1 AND ua.user_id=$2 AND ua.deleted_at IS NULL FOR UPDATE OF ua`,[id,userId]);const row=current.rows[0];if(row===undefined)throw new DomainError("USER_AGENT_NOT_FOUND","Agent was not found",404);const assignment=await this.#assertAgentVersionMapped(transaction,userId,row.agentVersionId);if(row.configurationVersion===null&&input.configuration===undefined)throw new DomainError("AGENT_CONFIGURATION_REQUIRED","A persisted agent configuration is required",409);if(input.configuration!==undefined&&(typeof input.configuration!=="object"||input.configuration===null||Array.isArray(input.configuration)))throw new DomainError("AGENT_CONFIGURATION_INVALID","Agent configuration must be an object",422);const configuration=agentConfiguration(row.agentId,input.configuration===undefined?row.configuration:{...jsonObject(row.configuration),...input.configuration as Readonly<Record<string,unknown>>});assertConfigurationResearchUniverse(configuration,assignment.researchUniverse,row.agentId);await transaction.query(`UPDATE user_agents SET allocation_limit=COALESCE($3,allocation_limit),approval_mode=COALESCE($4,approval_mode),updated_at=$5 WHERE id=$1 AND user_id=$2`,[id,userId,allocation??null,approvalMode??null,now]);if(input.configuration!==undefined){await transaction.query("UPDATE agent_configurations SET superseded_at=$3 WHERE user_agent_id=$1 AND user_id=$2 AND superseded_at IS NULL",[id,userId,now]);await transaction.query("INSERT INTO agent_configurations(user_agent_id,user_id,version,configuration,effective_at) VALUES($1,$2,$3,$4::jsonb,$5)",[id,userId,Number(row.configurationVersion??0)+1,JSON.stringify(configuration),now]);}});return (await this.userAgents(userId)).find((item)=>item.id===id)!;}
  public async setAgentStatus(userId:string,id:string,status:"paused"|"monitoring",now:string):Promise<UserAgentRecord>{await this.database.withTenant(userId,async(transaction)=>{
    await this.#lockUserAgentMutation(transaction,userId);
    const assignmentScope=status==="monitoring"?await this.#currentUserAgentAssignmentScope(transaction,userId):undefined;
    const current=await transaction.query<{agentId:string;agentVersionId:string;configuration:Readonly<Record<string,unknown>>|null}>(
      `SELECT ad.agent_key AS "agentId",av.id::text AS "agentVersionId",ac.configuration FROM user_agents ua
       JOIN agent_versions av ON av.id=ua.agent_version_id JOIN agent_definitions ad ON ad.id=av.agent_definition_id
       LEFT JOIN LATERAL (
         SELECT configuration FROM agent_configurations WHERE user_agent_id=ua.id AND user_id=ua.user_id
           AND superseded_at IS NULL ORDER BY effective_at DESC LIMIT 1
       ) ac ON true WHERE ua.id=$1 AND ua.user_id=$2 AND ua.deleted_at IS NULL FOR UPDATE OF ua`,
      [id,userId]
    );
    const row=current.rows[0];
    if(row===undefined)throw new DomainError("USER_AGENT_NOT_FOUND","Agent was not found",404);
    if(status==="monitoring"){
      await this.#assertUserAgentCountWithinLimit(transaction,userId,assignmentScope!.maximumActiveAgents);
      const assignment=await this.#assertAgentVersionMapped(transaction,userId,row.agentVersionId);
      if(assignment.planId!==assignmentScope!.planId)throw new DomainError("AGENT_NOT_ENTITLED","The authoritative current plan does not include this agent version",403);
      if(row.configuration===null)throw new DomainError("AGENT_CONFIGURATION_REQUIRED","A persisted agent configuration is required before resume",409);
      const configuration=agentConfiguration(row.agentId,row.configuration);
      assertConfigurationResearchUniverse(configuration,assignment.researchUniverse,row.agentId);
    }
    const result=await transaction.query("UPDATE user_agents SET status=$3,updated_at=$4 WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL",[id,userId,status,now]);
    if(result.rowCount!==1)throw new DomainError("USER_AGENT_NOT_FOUND","Agent was not found",404);
    if(status==="paused"){
      await cancelUnsubmittedAgentWork(transaction,userId,[id],now,"AGENT_PAUSED");
      await recordPauseConfirmation(transaction,userId,"user_agent",id,now);
    }
  });return (await this.userAgents(userId)).find((item)=>item.id===id)!;}
  public async deleteUserAgent(userId:string,id:string,now:string):Promise<void>{await this.database.withTenant(userId,async(transaction)=>{
    await this.#lockUserAgentMutation(transaction,userId);
    const current=await transaction.query<{status:string}>("SELECT status FROM user_agents WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE",[id,userId]);
    const row=current.rows[0];
    if(row===undefined)throw new DomainError("USER_AGENT_NOT_FOUND","Agent was not found",404);
    await cancelUnsubmittedAgentWork(transaction,userId,[id],now,"AGENT_REMOVED");
    const result=await transaction.query("UPDATE user_agents SET deleted_at=$3::timestamptz,status='paused',updated_at=$3::timestamptz WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL",[id,userId,now]);
    if(result.rowCount!==1)throw new DomainError("USER_AGENT_NOT_FOUND","Agent was not found",404);
    await recordAgentRemovalConfirmation(transaction,userId,id,row.status,now);
  });}
  async #proposalRows(userId:string,id?:string):Promise<readonly ProposalRecord[]>{return await this.database.withTenant(userId,async(transaction)=>{const result=await transaction.query<{id:string;userId:string;status:string;proposal:TradeProposal;updatedAt:string}>(`SELECT id::text,user_id::text AS "userId",status,proposal,updated_at::text AS "updatedAt" FROM trade_proposals WHERE user_id=$1 AND environment='paper'${id===undefined?"":" AND id=$2"} ORDER BY updated_at DESC`,id===undefined?[userId]:[userId,id]);return Object.freeze(result.rows.map((row)=>Object.freeze({...row,proposal:row.proposal as ProposalRecord["proposal"],updatedAt:iso(row.updatedAt)})));});}
  public async proposals(userId:string):Promise<readonly ProposalRecord[]>{return await this.#proposalRows(userId);}
  public async proposal(userId:string,id:string):Promise<ProposalRecord>{const value=(await this.#proposalRows(userId,id))[0];if(value===undefined)throw new DomainError("PROPOSAL_NOT_FOUND","Proposal was not found",404);return value;}
  public async proposalAction(userId:string,id:string,status:"APPROVED"|"USER_REJECTED",now:string):Promise<ProposalRecord>{if(status==="APPROVED")throw new DomainError("STEP_UP_PROOF_REQUIRED","Server-verified step-up authentication is required for approval",403);await this.database.withTenant(userId,async(transaction)=>{const current=await transaction.query<{status:string;expiresAt:string}>("SELECT status,expires_at::text AS \"expiresAt\" FROM trade_proposals WHERE id=$1 AND user_id=$2 AND environment='paper' FOR UPDATE",[id,userId]);const row=current.rows[0];if(row===undefined)throw new DomainError("PROPOSAL_NOT_FOUND","Proposal was not found",404);if(row.status!=="AWAITING_USER_APPROVAL")throw new DomainError("PROPOSAL_NOT_ACTIONABLE","Proposal is no longer actionable",409);await transaction.query("UPDATE trade_proposals SET status='USER_REJECTED',version=version+1,updated_at=$3 WHERE id=$1 AND user_id=$2",[id,userId,now]);await transaction.query(`INSERT INTO trade_proposal_events(proposal_id,user_id,from_status,to_status,actor_type,actor_id,reason_code,correlation_id,idempotency_key,occurred_at)
      VALUES($1,$2,'AWAITING_USER_APPROVAL','USER_REJECTED','user',$5,'USER_REJECTED','api',$3,$4)`,[id,userId,`reject:${id}:${now}`,now,userId]);});return await this.proposal(userId,id);}
  public async approveProposal(userId:string,id:string,verification:VerifiedStepUpAuthentication,idempotencyKey:string,approvedAt:string):Promise<ProposalRecord>{
    await this.requireEligible(userId);
    await this.currentRiskAssessment(userId);
    if(!await this.hasAllRequiredLegalConsents(userId))throw new DomainError("LEGAL_CONSENTS_REQUIRED","Every applicable current legal-document version must be accepted before a proposal can be approved",409);
    const policy=await this.riskPolicy(userId);
    let outcome:"approved"|"expired"|"stale";
    try{
      outcome=await this.database.withTenant(userId,async(transaction)=>{
        const current=await transaction.query<{status:string;expiresAt:string;proposal:TradeProposal;agentStatus:string;agentDeletedAt:Date|null}>(
          `SELECT proposal.status,proposal.expires_at::text AS "expiresAt",proposal.proposal,
             agent.status AS "agentStatus",agent.deleted_at AS "agentDeletedAt"
           FROM trade_proposals AS proposal
           JOIN agent_runs AS run ON run.id=proposal.agent_run_id AND run.user_id=proposal.user_id
           JOIN user_agents AS agent ON agent.id=run.user_agent_id AND agent.user_id=proposal.user_id
           WHERE proposal.id=$1 AND proposal.user_id=$2 AND proposal.environment='paper'
           FOR UPDATE OF proposal,agent`,
          [id,userId]
        );
        const row=current.rows[0];
        if(row===undefined)throw new DomainError("PROPOSAL_NOT_FOUND","Proposal was not found",404);
        if(row.status!=="AWAITING_USER_APPROVAL")throw new DomainError("PROPOSAL_NOT_ACTIONABLE","Proposal is no longer actionable",409);
        if(row.agentDeletedAt!==null||!["monitoring","waiting_approval","automatic"].includes(row.agentStatus))throw new DomainError("AGENT_PAUSED","The agent was paused before approval; this proposal cannot be submitted",409);
        if(Date.parse(row.expiresAt)<=Date.parse(approvedAt)){
          await transaction.query("UPDATE trade_proposals SET status='EXPIRED',version=version+1,updated_at=$3 WHERE id=$1 AND user_id=$2",[id,userId,approvedAt]);
          await transaction.query(`INSERT INTO trade_proposal_events(proposal_id,user_id,from_status,to_status,actor_type,actor_id,reason_code,correlation_id,idempotency_key,occurred_at)
            VALUES($1,$2,'AWAITING_USER_APPROVAL','EXPIRED','system','api','PROPOSAL_EXPIRED_BEFORE_APPROVAL','api',$3,$4)`,[id,userId,`${idempotencyKey}:expired`,approvedAt]);
          return "expired" as const;
        }
        const approvalInstant=Date.parse(approvedAt);const quoteInstant=Date.parse(row.proposal.quoteTimestamp);const dataInstant=Date.parse(row.proposal.dataTimestamp);const maximumAgeMs=policy.maximumQuoteAgeSeconds*1_000;
        if(!Number.isFinite(approvalInstant)||!Number.isFinite(quoteInstant)||!Number.isFinite(dataInstant)||quoteInstant>approvalInstant+5_000||dataInstant>approvalInstant+5_000||approvalInstant-quoteInstant>maximumAgeMs||approvalInstant-dataInstant>maximumAgeMs){
          await transaction.query("UPDATE trade_proposals SET status='EXPIRED',version=version+1,updated_at=$3 WHERE id=$1 AND user_id=$2",[id,userId,approvedAt]);
          await transaction.query(`INSERT INTO trade_proposal_events(proposal_id,user_id,from_status,to_status,actor_type,actor_id,reason_code,correlation_id,idempotency_key,occurred_at)
            VALUES($1,$2,'AWAITING_USER_APPROVAL','EXPIRED','system','api','PROPOSAL_DATA_STALE_BEFORE_APPROVAL','api',$3,$4)`,[id,userId,`${idempotencyKey}:stale`,approvedAt]);
          return "stale" as const;
        }
        const deviceId=await this.#deviceIdForSession(transaction,userId,verification.sessionId,verification.deviceId);
        await transaction.query(`INSERT INTO approval_requests(proposal_id,user_id,status,idempotency_key,requested_at,expires_at,acted_at,approving_device_id,authentication_verification_id,authentication_context)
          VALUES($1,$2,'approved',$3,$4,$5,$4,$6,$7,$8)`,[id,userId,idempotencyKey,approvedAt,row.expiresAt,deviceId,verification.verificationId,{actorType:"user",authenticatedUserId:userId,authenticationContextId:verification.sessionId,method:verification.method,sessionId:verification.sessionId,authenticatedAt:verification.authenticatedAt,action:verification.action,resourceId:verification.resourceId}]);
        await transaction.query("UPDATE trade_proposals SET status='APPROVED',version=version+1,updated_at=$3 WHERE id=$1 AND user_id=$2",[id,userId,approvedAt]);
        await transaction.query(`INSERT INTO trade_proposal_events(proposal_id,user_id,from_status,to_status,actor_type,actor_id,reason_code,correlation_id,idempotency_key,occurred_at)
          VALUES($1,$2,'AWAITING_USER_APPROVAL','APPROVED','user',$5,'USER_STEP_UP_APPROVED','api',$3,$4)`,[id,userId,`${idempotencyKey}:event`,approvedAt,userId]);
        const dispatch=await transaction.query(`INSERT INTO queue_jobs(queue_name,user_id,job_type,payload,idempotency_key,available_at)
          VALUES('execution',$1,'submit_approved',$2::jsonb,$3,$4)
          ON CONFLICT(queue_name,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
          WHERE queue_jobs.user_id=EXCLUDED.user_id AND queue_jobs.job_type=EXCLUDED.job_type AND queue_jobs.payload=EXCLUDED.payload
          RETURNING id`,[userId,JSON.stringify({proposalId:id,idempotencyKey:`submit:${id}`,correlationId:`approval:${verification.verificationId}`}),`submit:${id}`,approvedAt]);
        if(dispatch.rowCount!==1)throw new DomainError("EXECUTION_DISPATCH_CONFLICT","Approved proposal execution dispatch conflicts with an existing durable job",409);
        return "approved" as const;
      });
    }catch(error){
      if(typeof error==="object"&&error!==null&&(error as{code?:string}).code==="23505")throw new DomainError("STEP_UP_PROOF_REPLAYED","The authentication proof or approval idempotency key was already used",409);
      throw error;
    }
    if(outcome==="expired")throw new DomainError("PROPOSAL_EXPIRED","Proposal has expired",409);
    if(outcome==="stale")throw new DomainError("PROPOSAL_REAPPROVAL_REQUIRED","Proposal data is stale; wait for a newly analyzed proposal and review its current terms",409);
    return await this.proposal(userId,id);
  }
  public async approvalForProposal(userId:string,proposalId:string):Promise<ApprovalRecord>{return await this.database.withTenant(userId,async(transaction)=>{const result=await transaction.query<{id:string;userId:string;proposalId:string;deviceId:string;sessionId:string;method:ApprovalRecord["authenticationMethod"];verificationId:string;authenticatedAt:string;approvedAt:string;idempotencyKey:string}>(`SELECT ar.id::text,ar.user_id::text AS "userId",ar.proposal_id::text AS "proposalId",d.public_identifier::text AS "deviceId",ar.authentication_context->>'sessionId' AS "sessionId",ar.authentication_context->>'method' AS method,ar.authentication_verification_id AS "verificationId",ar.authentication_context->>'authenticatedAt' AS "authenticatedAt",ar.acted_at::text AS "approvedAt",ar.idempotency_key AS "idempotencyKey" FROM approval_requests ar LEFT JOIN devices d ON d.id=ar.approving_device_id AND d.user_id=ar.user_id WHERE ar.proposal_id=$1 AND ar.user_id=$2 AND ar.status='approved' ORDER BY ar.acted_at DESC LIMIT 1`,[proposalId,userId]);const row=result.rows[0];if(row===undefined)throw new DomainError("APPROVAL_NOT_FOUND","Proposal approval was not found",404);return Object.freeze({id:row.id,userId:row.userId,proposalId:row.proposalId,status:"approved",approvingDeviceId:row.deviceId,sessionId:row.sessionId,authenticationMethod:row.method,authenticationVerificationId:row.verificationId,authenticatedAt:row.authenticatedAt,approvedAt:iso(row.approvedAt),idempotencyKey:row.idempotencyKey});});}
  async #orderRows(userId:string,id?:string):Promise<readonly OrderRecord[]>{
    return await this.database.withTenant(userId,async(transaction)=>{
      const result=await transaction.query<{
        id:string;userId:string;proposalId:string;status:string;symbol:string;side:string;
        quantity:number;filledQuantity:number;averageFillPrice:number|null;brokerOrderId:string|null;
        instrumentType:string;orderType:string;limitPrice:number|null;timeInForce:string;
        submittedAt:string|null;terminalAt:string|null;statusReason:string|null;
        reconciliationStatus:string;fills:unknown;auditTimeline:unknown;updatedAt:string;
      }>(
        `SELECT o.id::text,o.user_id::text AS "userId",o.proposal_id::text AS "proposalId",
           upper(o.status::text) AS status,p.symbol,p.proposal->>'side' AS side,
           (p.proposal->>'quantity')::numeric::float8 AS quantity,
           COALESCE((SELECT sum(fill.quantity)::float8 FROM fills AS fill
             WHERE fill.order_id=o.id AND fill.user_id=o.user_id),0) AS "filledQuantity",
           (SELECT (sum(fill.quantity*fill.price)/NULLIF(sum(fill.quantity),0))::float8
             FROM fills AS fill WHERE fill.order_id=o.id AND fill.user_id=o.user_id) AS "averageFillPrice",
           o.broker_order_id AS "brokerOrderId",o.instrument_type AS "instrumentType",
           p.proposal->>'orderType' AS "orderType",
           NULLIF(p.proposal->>'limitPrice','')::numeric::float8 AS "limitPrice",
           p.proposal->>'timeInForce' AS "timeInForce",o.submitted_at::text AS "submittedAt",
           o.terminal_at::text AS "terminalAt",
           COALESCE(
             (SELECT reconciliation.last_error_code FROM reconciliation_jobs AS reconciliation
               WHERE reconciliation.order_id=o.id AND reconciliation.user_id=o.user_id
                 AND reconciliation.last_error_code IS NOT NULL
               ORDER BY reconciliation.updated_at DESC,reconciliation.id DESC LIMIT 1),
             (SELECT event.payload->>'reasonCode' FROM order_events AS event
               WHERE event.order_id=o.id AND event.user_id=o.user_id
                 AND event.payload ? 'reasonCode'
               ORDER BY event.occurred_at DESC,event.id DESC LIMIT 1)
           ) AS "statusReason",
           COALESCE(
             (SELECT lower(reconciliation.status::text) FROM reconciliation_jobs AS reconciliation
               WHERE reconciliation.order_id=o.id AND reconciliation.user_id=o.user_id
               ORDER BY reconciliation.updated_at DESC,reconciliation.id DESC LIMIT 1),
             CASE WHEN o.status IN ('filled','canceled','rejected') THEN 'reconciled' ELSE 'not_scheduled' END
           ) AS "reconciliationStatus",
           COALESCE((SELECT jsonb_agg(jsonb_build_object(
             'id',fill.id::text,'timestamp',fill.occurred_at,'quantity',fill.quantity::float8,
             'price',fill.price::float8,'fees',fill.fees::float8
           ) ORDER BY fill.occurred_at,fill.id) FROM fills AS fill
             WHERE fill.order_id=o.id AND fill.user_id=o.user_id),'[]'::jsonb) AS fills,
           COALESCE((SELECT jsonb_agg(jsonb_build_object(
             'status',upper(event.status::text),'occurredAt',event.occurred_at,
             'reasonCode',event.payload->>'reasonCode'
           ) ORDER BY event.occurred_at,event.id) FROM order_events AS event
             WHERE event.order_id=o.id AND event.user_id=o.user_id),'[]'::jsonb) AS "auditTimeline",
           o.updated_at::text AS "updatedAt"
         FROM orders AS o
         JOIN trade_proposals AS p ON p.id=o.proposal_id AND p.user_id=o.user_id
         WHERE o.user_id=$1 AND p.environment='paper'${id===undefined?"":" AND o.id=$2"}
         ORDER BY o.updated_at DESC`,
        id===undefined?[userId]:[userId,id]
      );
      return Object.freeze(result.rows.map((row)=>{
        const quantity=numberValue(row.quantity);
        const filledQuantity=numberValue(row.filledQuantity);
        const averageFillPrice=row.averageFillPrice===null?null:numberValue(row.averageFillPrice);
        const limitPrice=row.limitPrice===null?null:numberValue(row.limitPrice);
        if(!Number.isFinite(quantity)||quantity<=0||!Number.isFinite(filledQuantity)||filledQuantity<0||filledQuantity>quantity+0.00000001||
          (averageFillPrice!==null&&(!Number.isFinite(averageFillPrice)||averageFillPrice<0))||
          (limitPrice!==null&&(!Number.isFinite(limitPrice)||limitPrice<=0))){
          throw new DomainError("ORDER_RECORD_INVALID","Persisted Paper order numeric fields are invalid",500);
        }
        if(row.side!=="buy"&&row.side!=="sell")throw new DomainError("ORDER_RECORD_INVALID","Persisted Paper order side is invalid",500);
        if(row.instrumentType!=="equity"&&row.instrumentType!=="option")throw new DomainError("ORDER_RECORD_INVALID","Persisted Paper order instrument type is invalid",500);
        if(row.orderType.length===0||row.timeInForce.length===0)throw new DomainError("ORDER_RECORD_INVALID","Persisted Paper order instructions are incomplete",500);
        const fills=Object.freeze((Array.isArray(row.fills)?row.fills:[]).map((value)=>{
          const fill=jsonObject(value);const fillQuantity=numberValue(fill.quantity);const price=numberValue(fill.price);const fees=fill.fees===null?null:numberValue(fill.fees);
          if(typeof fill.id!=="string"||fill.id.length===0||!Number.isFinite(fillQuantity)||fillQuantity<=0||!Number.isFinite(price)||price<0||(fees!==null&&(!Number.isFinite(fees)||fees<0)))throw new DomainError("ORDER_RECORD_INVALID","Persisted Paper fill record is invalid",500);
          return Object.freeze({id:fill.id,timestamp:iso(fill.timestamp),quantity:fillQuantity,price,fees});
        }));
        const auditTimeline=Object.freeze((Array.isArray(row.auditTimeline)?row.auditTimeline:[]).map((value)=>{
          const event=jsonObject(value);if(typeof event.status!=="string"||event.status.length===0)throw new DomainError("ORDER_RECORD_INVALID","Persisted Paper order event is invalid",500);
          return Object.freeze({status:event.status,occurredAt:iso(event.occurredAt),reasonCode:typeof event.reasonCode==="string"?event.reasonCode:null});
        }));
        return Object.freeze({id:row.id,userId:row.userId,proposalId:row.proposalId,status:row.status,symbol:row.symbol,side:row.side,quantity,filledQuantity,remainingQuantity:Math.max(0,quantity-filledQuantity),averageFillPrice,brokerOrderId:row.brokerOrderId,instrumentType:row.instrumentType,orderType:row.orderType,limitPrice,timeInForce:row.timeInForce,submittedAt:row.submittedAt===null?null:iso(row.submittedAt),terminalAt:row.terminalAt===null?null:iso(row.terminalAt),statusReason:row.statusReason,reconciliationStatus:row.reconciliationStatus,fills,auditTimeline,mode:"paper" as const,dataClassification:"paper" as const,updatedAt:iso(row.updatedAt)});
      }));
    });
  }
  public async orders(userId:string):Promise<readonly OrderRecord[]>{return await this.#orderRows(userId);}
  public async order(userId:string,id:string):Promise<OrderRecord>{const value=(await this.#orderRows(userId,id))[0];if(value===undefined)throw new DomainError("ORDER_NOT_FOUND","Order was not found",404);return value;}
  public async cancelOrder(userId:string,id:string,now:string):Promise<OrderRecord>{
    await this.database.withTenant(userId,async(transaction)=>{
      const current=await transaction.query<{
        orderStatus:string;brokerOrderId:string|null;proposalId:string;proposalStatus:string;
      }>(
        `SELECT orders.status::text AS "orderStatus",orders.broker_order_id AS "brokerOrderId",
           proposal.id::text AS "proposalId",proposal.status::text AS "proposalStatus"
         FROM orders JOIN trade_proposals AS proposal ON proposal.id=orders.proposal_id AND proposal.user_id=orders.user_id
         WHERE orders.id=$1 AND orders.user_id=$2 AND proposal.environment='paper'
         FOR UPDATE OF orders,proposal`,
        [id,userId]
      );
      const row=current.rows[0];
      if(row===undefined)throw new DomainError("ORDER_NOT_FOUND","Order was not found",404);
      if(row.orderStatus==="canceled")return;
      if(!["pending","submitted","partially_filled"].includes(row.orderStatus))throw new DomainError("ORDER_NOT_CANCELABLE","A terminal Paper order cannot be canceled",409);
      if(!["APPROVED","SUBMITTING","SUBMITTED","PARTIALLY_FILLED","RECONCILIATION_ERROR"].includes(row.proposalStatus)){
        throw new DomainError("ORDER_PROPOSAL_STATE_CONFLICT","Paper order and proposal states are inconsistent",409);
      }
      await transaction.query(
        `UPDATE orders SET status='canceled',terminal_at=$3::timestamptz,updated_at=$3::timestamptz
         WHERE id=$1 AND user_id=$2 AND status IN ('pending','submitted','partially_filled')`,
        [id,userId,now]
      );
      await transaction.query(
        `UPDATE trade_proposals SET status='CANCELED',version=version+1,updated_at=$3::timestamptz
         WHERE id=$1 AND user_id=$2 AND status=$4::proposal_status`,
        [row.proposalId,userId,now,row.proposalStatus]
      );
      await transaction.query(
        `UPDATE reconciliation_jobs SET status='succeeded',leased_until=NULL,last_error_code=NULL,updated_at=$3::timestamptz
         WHERE order_id=$1 AND user_id=$2 AND status IN ('queued','failed','leased')`,
        [id,userId,now]
      );
      await transaction.query(
        `UPDATE capital_reservations SET released_at=COALESCE(released_at,$3::timestamptz)
         WHERE user_id=$1 AND proposal_id=$2 AND released_at IS NULL`,
        [userId,row.proposalId,now]
      );
      await transaction.query(
        `UPDATE queue_jobs SET status='dead_letter',last_error_code='USER_CANCELED_ORDER',leased_by=NULL,leased_until=NULL
         WHERE user_id=$1 AND status IN ('queued','failed') AND payload->>'proposalId'=$2`,
        [userId,row.proposalId]
      );
      await transaction.query(
        `INSERT INTO order_events(order_id,user_id,status,broker_event_id,occurred_at,payload,idempotency_key)
         VALUES($1,$2,'canceled',$3,$4::timestamptz,
           '{"source":"authenticated_user_cancel","reasonCode":"USER_CANCELED_PAPER_ORDER"}'::jsonb,$5)
         ON CONFLICT(idempotency_key) DO NOTHING`,
        [id,userId,row.brokerOrderId,now,`cancel-order:${id}`]
      );
      await transaction.query(
        `INSERT INTO trade_proposal_events(
           proposal_id,user_id,from_status,to_status,actor_type,actor_id,reason_code,
           correlation_id,idempotency_key,metadata,occurred_at
         ) VALUES($1,$2,$3::proposal_status,'CANCELED','user',$4,'USER_CANCELED_PAPER_ORDER','api',$5,
           '{"source":"authenticated_user_cancel"}'::jsonb,$6::timestamptz)
         ON CONFLICT(idempotency_key) DO NOTHING`,
        [row.proposalId,userId,row.proposalStatus,userId,`cancel-order:${id}:proposal`,now]
      );
    });
    return await this.order(userId,id);
  }
  public async notifications(userId:string):Promise<readonly NotificationRecord[]>{return await this.database.withTenant(userId,async(transaction)=>{const result=await transaction.query<{id:string;userId:string;type:string;title:string;createdAt:string;readAt:string|null}>(`SELECT id::text,user_id::text AS "userId",notification_type AS type,title,created_at::text AS "createdAt",read_at::text AS "readAt" FROM notifications WHERE user_id=$1 ORDER BY scheduled_at DESC`,[userId]);return Object.freeze(result.rows.map((row)=>Object.freeze({id:row.id,userId:row.userId,type:row.type,title:row.title,createdAt:iso(row.createdAt),...(row.readAt===null?{}:{readAt:iso(row.readAt)})})));});}
  public async readNotification(userId:string,id:string,now:string):Promise<NotificationRecord>{await this.database.withTenant(userId,async(transaction)=>{const result=await transaction.query("UPDATE notifications SET status='read',read_at=COALESCE(read_at,$3) WHERE id=$1 AND user_id=$2",[id,userId,now]);if(result.rowCount!==1)throw new DomainError("NOTIFICATION_NOT_FOUND","Notification was not found",404);});return (await this.notifications(userId)).find((item)=>item.id===id)!;}
  public async pauseAll(userId:string,now:string):Promise<Readonly<Record<string,unknown>>>{await this.database.withTenant(userId,async(transaction)=>{
    await this.#lockUserAgentMutation(transaction,userId);
    const agents=await transaction.query<{id:string}>(
      "SELECT id::text FROM user_agents WHERE user_id=$1 AND deleted_at IS NULL FOR UPDATE",
      [userId]
    );
    const ids=agents.rows.map((row)=>row.id);
    await transaction.query("UPDATE user_agents SET status='paused',updated_at=$2 WHERE user_id=$1 AND deleted_at IS NULL",[userId,now]);
    await cancelUnsubmittedAgentWork(transaction,userId,ids,now,"ALL_AGENTS_PAUSED");
    await recordPauseConfirmation(transaction,userId,"account_automation",userId,now);
  });return Object.freeze({paused:true,occurredAt:now,positionsUntouched:true});}
  public async resumeAll(userId:string,now:string):Promise<Readonly<Record<string,unknown>>>{await this.database.withTenant(userId,async(transaction)=>{
    await this.#lockUserAgentMutation(transaction,userId);
    const result=await transaction.query<{id:string;agentId:string;agentVersionId:string;configuration:Readonly<Record<string,unknown>>|null}>(`SELECT ua.id::text,ad.agent_key AS "agentId",av.id::text AS "agentVersionId",ac.configuration FROM user_agents ua JOIN agent_versions av ON av.id=ua.agent_version_id JOIN agent_definitions ad ON ad.id=av.agent_definition_id LEFT JOIN LATERAL (SELECT configuration FROM agent_configurations WHERE user_agent_id=ua.id AND user_id=ua.user_id AND superseded_at IS NULL ORDER BY effective_at DESC LIMIT 1) ac ON true WHERE ua.user_id=$1 AND ua.deleted_at IS NULL FOR UPDATE OF ua`,[userId]);
    if(result.rows.length===0)return;
    const assignmentScope=await this.#currentUserAgentAssignmentScope(transaction,userId);
    await this.#assertUserAgentCountWithinLimit(transaction,userId,assignmentScope.maximumActiveAgents);
    for(const row of result.rows){
      const assignment=await this.#assertAgentVersionMapped(transaction,userId,row.agentVersionId);
      if(assignment.planId!==assignmentScope.planId)throw new DomainError("AGENT_NOT_ENTITLED","The authoritative current plan does not include this agent version",403,{agentId:row.id});
      if(row.configuration===null)throw new DomainError("AGENT_CONFIGURATION_REQUIRED","Every agent requires a persisted configuration before resume",409,{agentId:row.id});
      const configuration=agentConfiguration(row.agentId,row.configuration);
      assertConfigurationResearchUniverse(configuration,assignment.researchUniverse,row.agentId);
    }
    await transaction.query("UPDATE user_agents SET status='monitoring',updated_at=$2 WHERE user_id=$1 AND deleted_at IS NULL",[userId,now]);
  });return Object.freeze({resumed:true,occurredAt:now,positionsUntouched:true});}
  public async idempotentAsync<T>(userId:string,key:string,payload:unknown,operation:()=>Promise<T>):Promise<T>{
    const fingerprint=createHash("sha256").update(canonicalJson(payload)).digest("hex");
    const claimedAt=new Date();
    const leaseExpiresAt=new Date(claimedAt.getTime()+2*60_000).toISOString();
    const claim=await this.database.withTenant(userId,async(transaction)=>{
      const inserted=await transaction.query<{claimed:boolean}>(`INSERT INTO api_idempotency_records(user_id,idempotency_key,request_fingerprint,status,lease_expires_at) VALUES($1,$2,$3,'processing',$4) ON CONFLICT DO NOTHING RETURNING true AS claimed`,[userId,key,fingerprint,leaseExpiresAt]);
      if(inserted.rows[0]?.claimed===true)return {kind:"claimed" as const};
      const prior=await transaction.query<{fingerprint:string;status:string;response:unknown;leaseExpiresAt:string}>(`SELECT request_fingerprint AS fingerprint,status,response,lease_expires_at::text AS "leaseExpiresAt" FROM api_idempotency_records WHERE user_id=$1 AND idempotency_key=$2 FOR UPDATE`,[userId,key]);
      const row=prior.rows[0];
      if(row===undefined)return {kind:"retry" as const};
      if(row.fingerprint!==fingerprint)return {kind:"mismatch" as const};
      if(row.status==="completed")return {kind:"completed" as const,response:row.response as T};
      return {kind:Date.parse(row.leaseExpiresAt)<=claimedAt.getTime()?"stale" as const:"processing" as const};
    });
    if(claim.kind==="mismatch")throw new DomainError("IDEMPOTENCY_KEY_REUSED","Idempotency key was reused with a different payload",409);
    if(claim.kind==="completed")return reexecutesSensitiveResponse(claim.response)?await operation():claim.response;
    if(claim.kind==="processing")throw new DomainError("IDEMPOTENCY_IN_PROGRESS","An operation with this idempotency key is still processing",409);
    if(claim.kind==="stale")throw new DomainError("IDEMPOTENCY_RECOVERY_REQUIRED","The prior operation has an unknown outcome and must be reconciled before this key can be retried",503);
    if(claim.kind==="retry")return await this.idempotentAsync(userId,key,payload,operation);
    const value=await operation();
    const persisted=persistenceSafeResponse(value);
    await this.database.withTenant(userId,async(transaction)=>{const updated=await transaction.query("UPDATE api_idempotency_records SET status='completed',response=$3::jsonb,lease_expires_at=$4 WHERE user_id=$1 AND idempotency_key=$2 AND request_fingerprint=$5 AND status='processing'",[userId,key,JSON.stringify(persisted??null),new Date(Date.now()+24*60*60_000).toISOString(),fingerprint]);if(updated.rowCount!==1)throw new DomainError("IDEMPOTENCY_COMMIT_FAILED","The operation outcome could not be recorded safely",503);});
    return value;
  }
  public async createSupportTicket(userId:string,input:Readonly<Record<string,unknown>>,now:string):Promise<Readonly<Record<string,unknown>>>{const id=randomUUID();const subject=String(input.subject??"Support request").trim().slice(0,200);if(subject==="")throw new DomainError("SUPPORT_SUBJECT_REQUIRED","Support subject is required",422);await this.database.withTenant(userId,async(transaction)=>{await transaction.query("INSERT INTO support_tickets(id,user_id,status,category,subject,created_at,updated_at) VALUES($1,$2,'open',$3,$4,$5,$5)",[id,userId,String(input.category??"general").slice(0,80),subject,now]);});return Object.freeze({id,status:"open",subject,createdAt:now});}
  public async closeAccount(userId:string):Promise<Readonly<Record<string,unknown>>>{
    let brokerRevocationPending=false;
    await this.database.withTenant(userId,async(transaction)=>{
      const owner=await transaction.query<{id:string}>("SELECT id::text FROM users WHERE id=$1 FOR UPDATE",[userId]);
      if(owner.rows[0]===undefined)throw new DomainError("USER_NOT_FOUND","User was not found",404);
      const open=await transaction.query<{exists:boolean}>("SELECT EXISTS(SELECT 1 FROM orders WHERE user_id=$1 AND status IN ('pending','submitted','partially_filled','unknown')) AS exists",[userId]);
      if(open.rows[0]?.exists===true)throw new DomainError("OPEN_ORDERS_EXIST","Cancel or resolve open orders before deleting the account",409);
      const connections=await transaction.query<{id:string;hasBinding:boolean}>("SELECT id::text,(credential_handle IS NOT NULL OR token_envelope IS NOT NULL) AS \"hasBinding\" FROM broker_connections WHERE user_id=$1 FOR UPDATE",[userId]);
      await transaction.query("SELECT id FROM connection_pairings WHERE user_id=$1 AND status IN ('pending','authorizing','connected') FOR UPDATE",[userId]);
      const sagas=await transaction.query<{id:string;connectionId:string;status:string}>("SELECT id::text,connection_id::text AS \"connectionId\",status FROM broker_authorization_sagas WHERE user_id=$1 AND status<>'revoked' FOR UPDATE",[userId]);
      const exchanges=await transaction.query<{exchangeTransactionId:string}>("SELECT exchange_transaction_id::text AS \"exchangeTransactionId\" FROM broker_authorization_exchange_attempts WHERE user_id=$1 AND status IN ('exchange_pending','revoke_pending') FOR UPDATE",[userId]);
      if(connections.rows.some((connection)=>connection.hasBinding&&!sagas.rows.some((saga)=>saga.connectionId===connection.id)))throw new DomainError("BROKER_REVOCATION_UNAVAILABLE","Account closure requires a durable provider revocation binding",503);
      for(const exchange of exchanges.rows){
        brokerRevocationPending=true;
        const staged=await transaction.query<{generation:number}>("UPDATE broker_authorization_exchange_attempts SET status='revoke_pending',revocation_requested_at=COALESCE(revocation_requested_at,GREATEST(clock_timestamp(),created_at)),recovery_generation=recovery_generation+1,last_error_code='ACCOUNT_CLOSED' WHERE user_id=$1 AND exchange_transaction_id=$2 AND status IN ('exchange_pending','revoke_pending') RETURNING recovery_generation AS generation",[userId,exchange.exchangeTransactionId]);
        const generation=staged.rows[0]?.generation;if(generation===undefined)throw new DomainError("BROKER_AUTHORIZATION_EXCHANGE_INVALID","Broker authorization exchange could not enter account-close revocation",409);
        const recovery=await transaction.query<{id:string}>(`INSERT INTO queue_jobs(queue_name,user_id,job_type,payload,idempotency_key,priority,max_attempts) VALUES('broker-sync',$1,'reconcile_broker_authorization_exchange',$2::jsonb,$3,1,25) ON CONFLICT(queue_name,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key WHERE queue_jobs.user_id=EXCLUDED.user_id AND queue_jobs.job_type=EXCLUDED.job_type AND queue_jobs.payload=EXCLUDED.payload RETURNING id::text`,[userId,JSON.stringify({exchangeTransactionId:exchange.exchangeTransactionId}),`broker-auth-exchange-revoke:${exchange.exchangeTransactionId}:${generation}`]);
        if(recovery.rows[0]?.id===undefined)throw new DomainError("BROKER_AUTHORIZATION_RECOVERY_IDEMPOTENCY_REUSED","Broker authorization exchange revocation key was reused",409);
      }
      for(const saga of sagas.rows){
        brokerRevocationPending=true;
        const staged=await transaction.query<{generation:number}>("UPDATE broker_authorization_sagas SET status='revoke_pending',revocation_requested_at=COALESCE(revocation_requested_at,clock_timestamp()),recovery_generation=recovery_generation+1,last_error_code='ACCOUNT_CLOSED' WHERE id=$1 AND user_id=$2 AND status IN ('confirm_pending','confirmed','revoke_pending') RETURNING recovery_generation AS generation",[saga.id,userId]);
        const generation=staged.rows[0]?.generation;if(generation===undefined)throw new DomainError("BROKER_AUTHORIZATION_SAGA_INVALID","Broker authorization could not enter account-close revocation",409);
        const recovery=await transaction.query<{id:string}>(`INSERT INTO queue_jobs(queue_name,user_id,job_type,payload,idempotency_key,priority,max_attempts) VALUES('broker-sync',$1,'reconcile_broker_authorization',$2::jsonb,$3,1,25) ON CONFLICT(queue_name,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key WHERE queue_jobs.user_id=EXCLUDED.user_id AND queue_jobs.job_type=EXCLUDED.job_type AND queue_jobs.payload=EXCLUDED.payload RETURNING id::text`,[userId,JSON.stringify({authorizationSagaId:saga.id}),`broker-auth-revoke:${saga.id}:${generation}`]);
        if(recovery.rows[0]?.id===undefined)throw new DomainError("BROKER_AUTHORIZATION_RECOVERY_IDEMPOTENCY_REUSED","Broker authorization revocation key was reused",409);
      }
      await transaction.query("UPDATE broker_connections SET status='revoked',revoked_at=clock_timestamp(),token_envelope=NULL,token_key_id=NULL,token_expires_at=NULL,credential_handle=NULL,credential_bound_at=NULL,credential_confirmed_at=NULL WHERE user_id=$1",[userId]);
      await transaction.query("UPDATE connection_pairings SET status='canceled',consumed_at=COALESCE(consumed_at,clock_timestamp()),oauth_state_digest=NULL,oauth_nonce_digest=NULL,pkce_verifier_envelope=NULL,oauth_state_expires_at=NULL,oauth_flow=NULL,oauth_redirect_uri=NULL,mobile_return_uri=NULL WHERE user_id=$1 AND status IN ('pending','authorizing','connected')",[userId]);
      await transaction.query("UPDATE queue_jobs SET status='dead_letter',leased_by=NULL,leased_until=NULL,last_error_code='ACCOUNT_CLOSED' WHERE user_id=$1 AND queue_name='broker-sync' AND job_type='hydrate_broker_account' AND status IN ('queued','failed')",[userId]);
      await transaction.query("UPDATE device_tokens SET invalidated_at=COALESCE(invalidated_at,clock_timestamp()) WHERE user_id=$1",[userId]);
      await transaction.query("UPDATE sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE user_id=$1",[userId]);
      await transaction.query("UPDATE devices SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE user_id=$1",[userId]);
      await transaction.query("UPDATE users SET status='closed',deleted_at=clock_timestamp() WHERE id=$1",[userId]);
    });
    return Object.freeze({deletionRequested:true,brokerRevocationPending,retentionNotice:"Records subject to legal retention are preserved and access is restricted."});
  }
  async #latestPortfolio(userId:string):Promise<{readonly snapshot:Readonly<Record<string,unknown>>;readonly positions:readonly Readonly<Record<string,unknown>>[]}>{return await this.database.withTenant(userId,async(transaction)=>{const snapshotResult=await transaction.query<{id:string;accountId:string;asOf:string;totalValue:number;buyingPower:number;cash:number|null;classification:string}>(`SELECT ps.id::text,ps.broker_account_id::text AS "accountId",ps.source_timestamp::text AS "asOf",ps.total_value::float8 AS "totalValue",ps.buying_power::float8 AS "buyingPower",ps.cash_value::float8 AS cash,ps.data_classification AS classification FROM portfolio_snapshots ps JOIN broker_accounts ba ON ba.id=ps.broker_account_id AND ba.user_id=ps.user_id JOIN broker_connections bc ON bc.id=ba.connection_id AND bc.user_id=ba.user_id WHERE ps.user_id=$1 AND ps.environment='paper' AND ps.data_classification='paper' AND ps.valid_until>transaction_timestamp() AND ba.active AND ba.is_agentic_account AND ba.verified_for_trading_at IS NOT NULL AND bc.provider='robinhood_mcp' AND bc.status='connected' AND bc.last_sync_at>=ps.source_timestamp ORDER BY ps.source_timestamp DESC LIMIT 1`,[userId]);const snapshot=snapshotResult.rows[0];if(snapshot===undefined)throw new DomainError("PAPER_MARKET_DATA_UNAVAILABLE","No fresh verified Paper portfolio snapshot is available; Demo fixtures are never relabeled",503);const positionsResult=await transaction.query<{id:string;symbol:string;instrumentType:string;quantity:number;averageCost:number|null;marketValue:number;unrealizedPnl:number|null;details:Readonly<Record<string,unknown>>}>(`SELECT id::text,symbol,instrument_type AS "instrumentType",quantity::float8,average_cost::float8 AS "averageCost",market_value::float8 AS "marketValue",unrealized_pnl::float8 AS "unrealizedPnl",details FROM position_snapshots WHERE user_id=$1 AND portfolio_snapshot_id=$2 ORDER BY symbol`,[userId,snapshot.id]);return {snapshot:Object.freeze(snapshot),positions:Object.freeze(positionsResult.rows.map((position)=>Object.freeze({...position,...position.details,dataClassification:"paper"})))};});}
  public async dashboard(userId:string):Promise<Readonly<Record<string,unknown>>>{const portfolio=await this.#latestPortfolio(userId);const agents=await this.userAgents(userId);const proposals=await this.proposals(userId);const latestValue=numberValue(portfolio.snapshot.totalValue);const asOf=iso(portfolio.snapshot.asOf);const dayStart=new Date(asOf);dayStart.setUTCHours(0,0,0,0);const metrics=await this.database.withTenant(userId,async(transaction)=>{const baseline=await transaction.query<{value:number}>(`SELECT total_value::float8 AS value FROM portfolio_snapshots WHERE user_id=$1 AND environment='paper' AND data_classification<>'demo' AND source_timestamp>=$2 AND source_timestamp<=$3 ORDER BY source_timestamp LIMIT 1`,[userId,dayStart.toISOString(),asOf]);const halted=await transaction.query<{halted:boolean}>("SELECT EXISTS(SELECT 1 FROM user_agents WHERE user_id=$1 AND deleted_at IS NULL AND status='risk_halt') AS halted",[userId]);return {baseline:numberValue(baseline.rows[0]?.value??latestValue),halted:halted.rows[0]?.halted===true};});const todayChange=latestValue-metrics.baseline;const todayChangePercent=metrics.baseline>0?todayChange/metrics.baseline:0;const policy=await this.riskPolicy(userId);const dailyLossUsed=Math.max(0,-todayChange);const grossAllocation=portfolio.positions.reduce((total,position)=>total+Math.abs(numberValue(position.marketValue)),0);const allocationUsed=latestValue>0?Math.min(1,Math.max(0,grossAllocation/latestValue)):0;const buyingPower=numberValue(portfolio.snapshot.buyingPower);const buyingPowerReserve=latestValue>0?Math.min(1,Math.max(0,buyingPower/latestValue)):0;const riskState=metrics.halted||dailyLossUsed>=policy.maximumDailyLoss?"risk_halt":dailyLossUsed>=policy.maximumDailyLoss*0.8?"warning":"within_limits";return Object.freeze({mode:"paper",dataClassification:"paper",portfolio:{value:latestValue,todayChange,todayChangePercent,asOf,dataClassification:"paper"},agentStatus:{activeAgents:agents,pendingProposals:proposals.filter((item)=>item.status==="AWAITING_USER_APPROVAL").length,riskState,connectionHealth:(await this.brokerConnection(userId)).status},risk:{dailyLossUsed,dailyLossLimit:policy.maximumDailyLoss,allocationUsed,buyingPowerReserve},positions:portfolio.positions,recentActivity:(await this.activity(userId)).slice(0,5)});}
  public async portfolio(userId:string):Promise<Readonly<Record<string,unknown>>>{const value=await this.#latestPortfolio(userId);return Object.freeze({accountId:value.snapshot.accountId,mode:"paper",asOf:value.snapshot.asOf,totalValue:numberValue(value.snapshot.totalValue),cash:numberValue(value.snapshot.cash),buyingPower:numberValue(value.snapshot.buyingPower),positions:value.positions,dataClassification:"paper"});}
  public async portfolioHistory(userId:string):Promise<Readonly<Record<string,unknown>>>{return await this.database.withTenant(userId,async(transaction)=>{const result=await transaction.query<{timestamp:string;value:number}>(`SELECT source_timestamp::text AS timestamp,total_value::float8 AS value FROM portfolio_snapshots WHERE user_id=$1 AND environment='paper' AND data_classification<>'demo' ORDER BY source_timestamp`,[userId]);if(result.rows.length===0)throw new DomainError("PAPER_MARKET_DATA_UNAVAILABLE","No approved Paper portfolio history is available",503);return Object.freeze({mode:"paper",range:"available",data:Object.freeze(result.rows),benchmark:null,dataClassification:"paper"});});}
  public async positions(userId:string):Promise<readonly Readonly<Record<string,unknown>>[]>{return (await this.#latestPortfolio(userId)).positions;}
  public async position(userId:string,id:string):Promise<Readonly<Record<string,unknown>>>{const value=(await this.positions(userId)).find((item)=>item.id===id);if(value===undefined)throw new DomainError("POSITION_NOT_FOUND","Position was not found",404);return value;}
  public async performance(_userId:string):Promise<Readonly<Record<string,unknown>>>{throw new DomainError("PERFORMANCE_CALCULATION_UNAVAILABLE","Paper performance requires an approved calculation and cash-flow methodology",503);}
  public async agentRuns(userId:string,id:string):Promise<readonly Readonly<Record<string,unknown>>[]>{return await this.database.withTenant(userId,async(transaction)=>{const owned=await transaction.query<{exists:boolean}>("SELECT EXISTS(SELECT 1 FROM user_agents WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL) AS exists",[id,userId]);if(owned.rows[0]?.exists!==true)throw new DomainError("USER_AGENT_NOT_FOUND","Agent was not found",404);const result=await transaction.query(`SELECT id::text,started_at AS "startedAt",completed_at AS "completedAt",status,strategy_version AS "deterministicStrategyVersion",structured_outcome AS outcome,error_code AS "errorCode",data_sources AS "dataSources" FROM agent_runs WHERE user_id=$1 AND user_agent_id=$2 ORDER BY started_at DESC`,[userId,id]);return Object.freeze(result.rows.map((row)=>Object.freeze(row)));});}
  public async riskEvents(userId:string):Promise<readonly Readonly<Record<string,unknown>>[]>{return await this.database.withTenant(userId,async(transaction)=>{const result=await transaction.query(`SELECT id::text,event_type AS type,severity,environment AS mode,occurred_at AS "occurredAt",reason_code AS reason,structured_details AS details FROM risk_events WHERE user_id=$1 AND environment='paper' ORDER BY occurred_at DESC`,[userId]);return Object.freeze(result.rows.map((row)=>Object.freeze(row)));});}
  public async brokerConnection(userId:string):Promise<Readonly<Record<string,unknown>>>{return await this.database.withTenant(userId,async(transaction)=>{const result=await transaction.query<{status:string;summary:Readonly<Record<string,unknown>>;lastSync:string|null}>(`SELECT status,connection_summary AS summary,last_sync_at::text AS "lastSync" FROM broker_connections WHERE user_id=$1 AND provider='robinhood_mcp'`,[userId]);const row=result.rows[0];if(row===undefined)return Object.freeze({status:"disconnected",capabilities:[],equityTradingAvailable:false,optionsTradingAvailable:false});return Object.freeze({...row.summary,status:row.status==="revoked"?"disconnected":row.status,lastSuccessfulSync:row.lastSync??undefined});});}
  public async activity(userId:string):Promise<readonly (ProposalRecord|OrderRecord)[]>{const values:Array<ProposalRecord|OrderRecord>=[...await this.proposals(userId),...await this.orders(userId)];return Object.freeze(values.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)));}
  public async settings(userId:string):Promise<Readonly<Record<string,unknown>>>{const account=await this.getUser(userId);return await this.database.withTenant(userId,async(transaction)=>{const result=await transaction.query<{profile:Readonly<Record<string,unknown>>}>("SELECT profile FROM user_profiles WHERE user_id=$1",[userId]);const profile=jsonObject(result.rows[0]?.profile);const preferences=jsonObject(profile.settings);const notificationPreferences=jsonObject(profile.notificationPreferences);return Object.freeze({privacyMode:preferences.privacyMode===true,appearance:["system","light","dark"].includes(String(preferences.appearance))?preferences.appearance:"system",notificationPreviews:notificationPreferences.detailedPreviewsEnabled===true?"detailed":"private",notificationPreferences,accountMode:account.accountMode});});}
  public async patchSettings(userId:string,input:Readonly<Record<string,unknown>>,now:string):Promise<Readonly<Record<string,unknown>>>{const current=await this.settings(userId);const privacyMode=input.privacyMode===undefined?current.privacyMode:input.privacyMode;if(typeof privacyMode!=="boolean")throw new DomainError("SETTINGS_INVALID","privacyMode must be a boolean",422);const appearance=input.appearance===undefined?current.appearance:input.appearance;if(!["system","light","dark"].includes(String(appearance)))throw new DomainError("SETTINGS_INVALID","appearance is invalid",422);const requestedNotifications=jsonObject(input.notificationPreferences);const existingNotifications=jsonObject(current.notificationPreferences);const detailed=input.notificationPreviews===undefined?(requestedNotifications.detailedPreviewsEnabled??existingNotifications.detailedPreviewsEnabled):input.notificationPreviews==="detailed";const critical=requestedNotifications.criticalNotificationsEnabled??existingNotifications.criticalNotificationsEnabled??false;if(typeof detailed!=="boolean"||typeof critical!=="boolean")throw new DomainError("SETTINGS_INVALID","Notification preferences must be boolean",422);let quietHours:Readonly<Record<string,unknown>>|undefined;const clearsQuietHours=Object.prototype.hasOwnProperty.call(requestedNotifications,"quietHours")&&requestedNotifications.quietHours===null;const rawQuiet=clearsQuietHours?undefined:requestedNotifications.quietHours??existingNotifications.quietHours;if(rawQuiet!==undefined){quietHours=jsonObject(rawQuiet);for(const[key,min,max]of [["startMinute",0,1439],["endMinute",0,1439],["utcOffsetMinutes",-840,840]] as const){const value=quietHours[key];if(typeof value!=="number"||!Number.isInteger(value)||value<min||value>max)throw new DomainError("SETTINGS_INVALID",`${key} is invalid`,422);}}const notificationPreferences=Object.freeze({detailedPreviewsEnabled:detailed,criticalNotificationsEnabled:critical,...(quietHours===undefined?{}:{quietHours})});await this.database.withTenant(userId,async(transaction)=>{await transaction.query(`UPDATE user_profiles SET profile=jsonb_set(jsonb_set(profile,'{settings}',$2::jsonb,true),'{notificationPreferences}',$3::jsonb,true),profile_version=profile_version+1,updated_at=$4 WHERE user_id=$1`,[userId,JSON.stringify({privacyMode,appearance}),JSON.stringify(notificationPreferences),now]);});return await this.settings(userId);}
  public async registerPushToken(userId:string,input:Readonly<Record<string,unknown>>):Promise<Readonly<Record<string,unknown>>>{if(this.options.deviceTokenEncryptionKey===undefined)throw new DomainError("PUSH_TOKEN_STORAGE_UNAVAILABLE","Encrypted APNs token storage is not configured",503);const token=typeof input.token==="string"?input.token.trim():"";const environment=input.environment;const deviceId=typeof input.deviceId==="string"?input.deviceId:"";if(token.length<32||token.length>4096||!/^[A-Fa-f0-9]+$/.test(token)||!['sandbox','production'].includes(String(environment))||deviceId==="")throw new DomainError("PUSH_TOKEN_INVALID","APNs token, environment, and authenticated device are required",422);const key=createHash("sha256").update(this.options.deviceTokenEncryptionKey).digest();const iv=randomBytes(12);const cipher=createCipheriv("aes-256-gcm",key,iv);const ciphertext=Buffer.concat([cipher.update(token,"utf8"),cipher.final()]);const envelope={v:1,iv:iv.toString("base64url"),ciphertext:ciphertext.toString("base64url"),tag:cipher.getAuthTag().toString("base64url")};const tokenDigest=createHmac("sha256",key).update(token).digest("hex");await this.database.withTenant(userId,async(transaction)=>{const device=await transaction.query<{id:string}>("SELECT id::text FROM devices WHERE user_id=$1 AND client_identifier_digest=$2 AND revoked_at IS NULL",[userId,this.#deviceDigest(deviceId)]);const storedDeviceId=device.rows[0]?.id;if(storedDeviceId===undefined)throw new DomainError("SESSION_DEVICE_MISMATCH","Authenticated device was not found",403);await transaction.query(`INSERT INTO device_tokens(user_id,device_id,token_digest,token_envelope,environment) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(device_id,environment) DO UPDATE SET token_digest=EXCLUDED.token_digest,token_envelope=EXCLUDED.token_envelope,invalidated_at=NULL,updated_at=clock_timestamp()`,[userId,storedDeviceId,tokenDigest,envelope,environment]);});return Object.freeze({registered:true,environment,detailsStored:true});}
  public async unregisterPushToken(userId:string,deviceId:string):Promise<Readonly<Record<string,unknown>>>{if(deviceId==="")throw new DomainError("SESSION_DEVICE_MISMATCH","Authenticated device is required",403);await this.database.withTenant(userId,async(transaction)=>{await transaction.query(`UPDATE device_tokens SET invalidated_at=COALESCE(invalidated_at,clock_timestamp()) WHERE user_id=$1 AND device_id IN (SELECT id FROM devices WHERE user_id=$1 AND client_identifier_digest=$2)`,[userId,this.#deviceDigest(deviceId)]);});return Object.freeze({unregistered:true});}
  public async dataExportStatus(userId:string):Promise<Readonly<Record<string,unknown>>>{await this.getUser(userId);return Object.freeze({status:"not_requested",capability:"export_adapter_unconfigured"});}
  public async requestDataExport(userId:string,_input:Readonly<Record<string,unknown>>,_now:string):Promise<Readonly<Record<string,unknown>>>{await this.getUser(userId);throw new DomainError("DATA_EXPORT_ADAPTER_UNAVAILABLE","Data export generation and secure delivery are not configured",503);}
  public async healthy():Promise<boolean>{return await this.database.ready();}
}
