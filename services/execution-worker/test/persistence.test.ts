import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import type { Entitlements } from "@whox/contracts";
import type { RiskContext } from "@whox/risk-schemas";
import { DEMO_EQUITY_PROPOSAL } from "@whox/test-fixtures";
import { Pool } from "pg";
import { PaperBroker } from "../src/brokers.js";
import { ExecutionWorker } from "../src/index.js";
import { PostgresExecutionRepository } from "../src/persistence.js";

const databaseUrl=process.env.TEST_DATABASE_URL;
const pool=databaseUrl?new Pool({connectionString:databaseUrl}):undefined;
after(async()=>{await pool?.end();});

const gates={LIVE_TRADING_ENABLED:false,ROBINHOOD_PRODUCTION_APPROVED:false,LEGAL_DOCUMENTS_APPROVED:false,ADVISORY_COMPLIANCE_APPROVED:false,APP_STORE_FINANCIAL_ENTITY_APPROVED:false,OPTIONS_LIVE_TRADING_ENABLED:false,AUTONOMOUS_MODE_ENABLED:false} as const;
const userId=DEMO_EQUITY_PROPOSAL.userId;
const accountId=DEMO_EQUITY_PROPOSAL.accountId;
const approvedAt="2026-08-01T14:00:30.000Z";
const executionAt="2026-08-01T14:01:00.000Z";

function riskContext(entitlements:Entitlements):RiskContext{return {now:executionAt,releaseGates:gates,userStatus:"active",currentLegalConsents:true,entitlements,accountConnectionHealthy:true,verifiedAgenticAccountId:accountId,strategyEnabled:true,agentVersionEnabled:true,tradingPermission:true,marketSession:"open",criticalServicesHealthy:true,securityHalt:false,accountValue:10_000,buyingPower:5_000,reservedBuyingPower:0,currentAllocatedValue:1_000,currentPositionValue:0,currentSectorValue:0,openPositionCount:1,dailyLoss:0,drawdownRatio:0,agentAllocatedValue:0,agentAllocationLimit:5_000,otherAgentReservations:0,duplicateProposal:false,duplicateOpenOrder:false,symbolSector:"Technology",tradable:true,fractionalSupported:true,liquiditySufficient:true,volatilityHalt:false,tradingHalt:false,corporateActionRestricted:false,earningsWindow:false,cooldownActive:false,tradesToday:0,turnoverToday:0,accountSnapshotTimestamp:executionAt,quotePrice:200,expectedExecutionPrice:200,brokerWarningSeverity:"none",approvalExpiresAt:"2026-08-01T14:04:00.000Z"};}

const policyLimits={maximumAccountAllocation:0.6,maximumPositionAmount:5_000,maximumNewOrderAmount:2_000,maximumDailyLoss:500,maximumPortfolioDrawdown:0.1,minimumBuyingPowerReserve:0.2,maximumSimultaneousPositions:10,maximumSymbolConcentration:0.15,maximumSectorConcentration:0.3,maximumTradesPerDay:5,maximumDailyTurnover:0.3,maximumOptionsExposure:0.1,maximumOptionRiskPerTrade:500,maximumContractsPerTrade:2,minimumDaysToExpiration:21,maximumDaysToExpiration:180,maximumBidAskSpreadRatio:0.08,maximumQuoteAgeSeconds:30,maximumAccountSnapshotAgeSeconds:60,maximumPriceDeviationRatio:0.02};
const exclusions={excludedSymbols:[],excludedSectors:[],fractionalSharesPermitted:true,extendedHoursPermitted:false,earningsTradesPermitted:false,coveredCallsPermitted:false,protectivePutsPermitted:false,definedRiskSpreadsPermitted:false};

describe("PostgreSQL execution persistence",{skip:databaseUrl===undefined},()=>{
  it("reclaims an expired reconciliation lease and updates order/proposal/fills atomically",async()=>{
    const proposalId=randomUUID();const orderId=randomUUID();const jobId=randomUUID();const restingProposalId=randomUUID();const restingOrderId=randomUUID();const restingJobId=randomUUID();const suffix=randomUUID();const provider=`reconciliation-${String(suffix).replaceAll("-","")}`;const proposal={...DEMO_EQUITY_PROPOSAL,proposalId,environment:"paper" as const,quantity:4,notionalEstimate:800,limitPrice:200};
    await pool!.query(`INSERT INTO trade_proposals(id,user_id,broker_account_id,agent_run_id,agent_version_id,environment,status,version,symbol,instrument_type,proposal,proposal_fingerprint,idempotency_key,expires_at) VALUES($1,$2,$3,'51000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000001','paper','PARTIALLY_FILLED',10,'AAPL','equity',$4::jsonb,$5,$6,'2030-08-01T14:00:00Z')`,[proposalId,userId,accountId,JSON.stringify(proposal),"a".repeat(64),`persistence-proposal-${suffix}`]);
    await pool!.query(`INSERT INTO orders(id,user_id,proposal_id,broker_account_id,broker_order_id,instrument_type,status,submission_idempotency_key,submitted_at) VALUES($1,$2,$3,$4,$5,'equity','partially_filled',$6,'2026-08-01T14:00:00Z')`,[orderId,userId,proposalId,accountId,`paper-${suffix}`,`persistence-submit-${suffix}`]);
    await pool!.query(`INSERT INTO fills(order_id,user_id,broker_fill_id,quantity,price,fees,occurred_at) VALUES($1,$2,$3,1,200,0,'2026-08-01T14:00:00Z')`,[orderId,userId,`paper-${suffix}:initial`]);
    await pool!.query(`INSERT INTO reconciliation_jobs(id,order_id,user_id,status,idempotency_key,run_after,leased_until) VALUES($1,$2,$3,'leased',$4,clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 minute')`,[jobId,orderId,userId,`persistence-reconcile-${suffix}`]);
    await pool!.query(`INSERT INTO market_data_snapshots(provider,symbol,data_type,payload,source_timestamp,received_at,delayed_by_seconds) VALUES($1,'AAPL','quote',$2::jsonb,'2026-08-01T14:01:00Z','2026-08-01T14:01:00Z',0)`,[provider,JSON.stringify({symbol:"AAPL",bid:199,ask:200,last:200,tradable:true,liquiditySufficient:true,marketSession:"open",volatilityHalt:false,tradingHalt:false,corporateActionRestricted:false,brokerWarningSeverity:"none"})]);
    const repository=new PostgresExecutionRepository(databaseUrl!);
    try{
      const reclaimed=await repository.claimDueReconciliations(100);
      assert.equal(reclaimed.some((item)=>item.jobId===jobId),true);
      assert.deepEqual(await repository.reconcilePaperOrder(userId,jobId,orderId,"2026-08-01T14:01:00Z",[provider]),{resolution:"completed"});
      const result=await pool!.query<{order_status:string;proposal_status:string;version:number;fills:string;events:string}>(`SELECT orders.status AS order_status,trade_proposals.status AS proposal_status,trade_proposals.version,(SELECT sum(quantity)::text FROM fills WHERE order_id=orders.id) AS fills,(SELECT count(*)::text FROM trade_proposal_events WHERE proposal_id=trade_proposals.id AND to_status='FILLED') AS events FROM orders JOIN trade_proposals ON trade_proposals.id=orders.proposal_id WHERE orders.id=$1`,[orderId]);
      assert.deepEqual(result.rows[0],{order_status:"filled",proposal_status:"FILLED",version:11,fills:"4.00000000",events:"1"});

      const restingProposal={...proposal,proposalId:restingProposalId,quantity:2,notionalEstimate:380,limitPrice:190};
      await pool!.query(`INSERT INTO trade_proposals(id,user_id,broker_account_id,agent_run_id,agent_version_id,environment,status,version,symbol,instrument_type,proposal,proposal_fingerprint,idempotency_key,expires_at) VALUES($1,$2,$3,'51000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000001','paper','SUBMITTED',8,'AAPL','equity',$4::jsonb,$5,$6,'2030-08-01T14:00:00Z')`,[restingProposalId,userId,accountId,JSON.stringify(restingProposal),"f".repeat(64),`resting-proposal-${suffix}`]);
      await pool!.query(`INSERT INTO orders(id,user_id,proposal_id,broker_account_id,broker_order_id,instrument_type,status,submission_idempotency_key,submitted_at) VALUES($1,$2,$3,$4,$5,'equity','submitted',$6,'2026-08-01T14:00:00Z')`,[restingOrderId,userId,restingProposalId,accountId,`paper-resting-${suffix}`,`resting-submit-${suffix}`]);
      await pool!.query(`INSERT INTO reconciliation_jobs(id,order_id,user_id,status,idempotency_key,run_after,leased_until) VALUES($1,$2,$3,'leased',$4,'2026-08-01T14:00:00Z','2026-08-01T14:02:00Z')`,[restingJobId,restingOrderId,userId,`resting-reconcile-${suffix}`]);
      assert.deepEqual(await repository.reconcilePaperOrder(userId,restingJobId,restingOrderId,"2026-08-01T14:01:00Z",[provider]),{resolution:"deferred",retryAt:"2026-08-01T14:01:15.000Z",reasonCode:"PAPER_RECONCILIATION_LIMIT_NOT_MARKETABLE"});
      const resting=await pool!.query<{order_status:string;proposal_status:string;fills:string;job_status:string;error_code:string}>(`SELECT orders.status AS order_status,trade_proposals.status AS proposal_status,(SELECT count(*)::text FROM fills WHERE order_id=orders.id) AS fills,reconciliation_jobs.status AS job_status,reconciliation_jobs.last_error_code AS error_code FROM orders JOIN trade_proposals ON trade_proposals.id=orders.proposal_id JOIN reconciliation_jobs ON reconciliation_jobs.order_id=orders.id WHERE orders.id=$1`,[restingOrderId]);
      assert.deepEqual(resting.rows[0],{order_status:"submitted",proposal_status:"SUBMITTED",fills:"0",job_status:"queued",error_code:"PAPER_RECONCILIATION_LIMIT_NOT_MARKETABLE"});
      assert.equal(await repository.proposalStore("10000000-0000-4000-8000-000000000002").get(proposalId),undefined);
    }finally{await repository.close();}
  });

  it("requires authenticated current approval and recovers a crash after terminal transition from a durable receipt",async()=>{
    const proposalId=randomUUID();const approvalId=randomUUID();const suffix=randomUUID();const proposal={...DEMO_EQUITY_PROPOSAL,proposalId,dataTimestamp:approvedAt,quoteTimestamp:approvedAt};
    const previous=await pool!.query<{limits:unknown;exclusions:unknown}>(`SELECT limits,exclusions FROM risk_policies WHERE id='40000000-0000-4000-8000-000000000001'`);
    await pool!.query(`UPDATE risk_policies SET limits=$1::jsonb,exclusions=$2::jsonb WHERE id='40000000-0000-4000-8000-000000000001'`,[JSON.stringify(policyLimits),JSON.stringify(exclusions)]);
    await pool!.query(`INSERT INTO trade_proposals(id,user_id,broker_account_id,agent_run_id,agent_version_id,environment,status,version,symbol,instrument_type,proposal,proposal_fingerprint,idempotency_key,expires_at,created_at,updated_at) VALUES($1,$2,$3,'51000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000001','demo','APPROVED',7,'AAPL','equity',$4::jsonb,$5,$6,'2026-08-01T14:05:00Z','2026-08-01T14:00:00Z',$7::timestamptz)`,[proposalId,userId,accountId,JSON.stringify(proposal),"b".repeat(64),`approved-proposal-${suffix}`,approvedAt]);
    const authentication={actorType:"user",authenticatedUserId:userId,authenticationContextId:"session-reference",sessionId:"session-reference",method:"app_attest",action:"approve_trade_proposal",resourceId:proposalId,authenticatedAt:"2026-08-01T14:00:20Z"};
    await pool!.query(`INSERT INTO approval_requests(id,proposal_id,user_id,status,idempotency_key,requested_at,expires_at,acted_at,authentication_context) VALUES($1,$2,$3,'approved',$4,'2026-08-01T14:00:00Z','2026-08-01T14:04:00Z',$5::timestamptz,$6::jsonb)`,[approvalId,proposalId,userId,`approval-${suffix}`,approvedAt,JSON.stringify(authentication)]);
    const repository=new PostgresExecutionRepository(databaseUrl!);
    try{
      const store=repository.proposalStore(userId);let loaded=await store.loadApproved(proposalId,executionAt,gates,["whox-demo-fixture"]);assert.equal(loaded.authorization.authorizationKind,"authenticated_user");assert.equal(loaded.policy.userId,userId);
      await pool!.query(`UPDATE approval_requests SET authentication_context=$2::jsonb WHERE id=$1`,[approvalId,JSON.stringify({...authentication,actorType:"worker"})]);
      await assert.rejects(store.loadApproved(proposalId,executionAt,gates,["whox-demo-fixture"]),(error:unknown)=>typeof error==="object"&&error!==null&&"code" in error&&error.code==="AUTHENTICATED_APPROVAL_REQUIRED");
      await pool!.query(`UPDATE approval_requests SET authentication_context=$2::jsonb,expires_at='2026-08-01T14:00:59Z' WHERE id=$1`,[approvalId,JSON.stringify(authentication)]);
      await assert.rejects(store.loadApproved(proposalId,executionAt,gates,["whox-demo-fixture"]),(error:unknown)=>typeof error==="object"&&error!==null&&"code" in error&&error.code==="APPROVAL_NOT_CURRENT");
      await pool!.query(`UPDATE approval_requests SET expires_at='2026-08-01T14:04:00Z' WHERE id=$1`,[approvalId]);
      loaded=await store.loadApproved(proposalId,executionAt,gates,["whox-demo-fixture"]);
      const submissionKey=`durable-boundary-${suffix}`;const firstWorker=new ExecutionWorker(store,new PaperBroker("demo"),repository);const unpersisted=await firstWorker.submitApproved({aggregate:loaded.aggregate,policy:loaded.policy,riskContext:riskContext(loaded.authorization.entitlements),authorization:loaded.authorization,idempotencyKey:submissionKey,correlationId:"before-crash",now:executionAt});assert.equal(unpersisted.aggregate.status,"FILLED");
      const receipt=await pool!.query<{status:string;broker_order_id:string|null;fills:string}>(`SELECT status,broker_order_id,(SELECT count(*)::text FROM fills WHERE order_id=orders.id) AS fills FROM orders WHERE proposal_id=$1`,[proposalId]);assert.deepEqual(receipt.rows[0],{status:"pending",broker_order_id:null,fills:"0"});
      const restartedRepository=new PostgresExecutionRepository(databaseUrl!);
      try{const restartedStore=restartedRepository.proposalStore(userId);const recovered=await restartedStore.loadRecoverable(proposalId,"2026-08-01T14:01:01Z",gates,["whox-demo-fixture"]);const restartedWorker=new ExecutionWorker(restartedStore,new PaperBroker("demo"),restartedRepository);const outcome=await restartedWorker.submitApproved({aggregate:recovered.aggregate,policy:recovered.policy,riskContext:riskContext(recovered.authorization.entitlements),authorization:recovered.authorization,idempotencyKey:submissionKey,correlationId:"after-restart",now:"2026-08-01T14:01:01Z"});await assert.rejects(restartedRepository.persistOutcome(userId,outcome,`${submissionKey}-forged`),(error:unknown)=>typeof error==="object"&&error!==null&&"code" in error&&error.code==="PERSISTENT_PLACEMENT_RECEIPT_REQUIRED");await restartedRepository.persistOutcome(userId,outcome,submissionKey);}finally{await restartedRepository.close();}
      const persisted=await pool!.query<{status:string;broker_order_id:string|null;fills:string}>(`SELECT status,broker_order_id,(SELECT sum(quantity)::text FROM fills WHERE order_id=orders.id) AS fills FROM orders WHERE proposal_id=$1`,[proposalId]);assert.equal(persisted.rows[0]?.status,"filled");assert.ok(persisted.rows[0]?.broker_order_id?.startsWith("paper-"));assert.equal(persisted.rows[0]?.fills,"5.00000000");
    }finally{await repository.close();const old=previous.rows[0];if(old!==undefined)await pool!.query(`UPDATE risk_policies SET limits=$1::jsonb,exclusions=$2::jsonb WHERE id='40000000-0000-4000-8000-000000000001'`,[JSON.stringify(old.limits),JSON.stringify(old.exclusions)]);}
  });
});
