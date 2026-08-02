import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import { evaluateRisk } from "@whox/risk-schemas";
import { DEMO_EQUITY_PROPOSAL } from "@whox/test-fixtures";
import { Pool } from "pg";
import { PostgresExecutionRepository } from "../src/persistence.js";

const databaseUrl=process.env.TEST_DATABASE_URL;
const pool=databaseUrl===undefined?undefined:new Pool({connectionString:databaseUrl});
after(async()=>pool?.end());

const gates={LIVE_TRADING_ENABLED:false,ROBINHOOD_PRODUCTION_APPROVED:false,LEGAL_DOCUMENTS_APPROVED:false,ADVISORY_COMPLIANCE_APPROVED:false,APP_STORE_FINANCIAL_ENTITY_APPROVED:false,OPTIONS_LIVE_TRADING_ENABLED:false,AUTONOMOUS_MODE_ENABLED:false} as const;
const limits={maximumAccountAllocation:0.8,maximumPositionAmount:5_000,maximumNewOrderAmount:2_000,maximumDailyLoss:500,maximumPortfolioDrawdown:0.1,minimumBuyingPowerReserve:0.1,maximumSimultaneousPositions:10,maximumSymbolConcentration:0.2,maximumSectorConcentration:0.4,maximumTradesPerDay:10,maximumDailyTurnover:0.5,maximumOptionsExposure:0.1,maximumOptionRiskPerTrade:500,maximumContractsPerTrade:2,minimumDaysToExpiration:14,maximumDaysToExpiration:180,maximumBidAskSpreadRatio:0.08,maximumQuoteAgeSeconds:30,maximumAccountSnapshotAgeSeconds:60,maximumPriceDeviationRatio:0.03};
const exclusions={excludedSymbols:[],excludedSectors:[],fractionalSharesPermitted:true,extendedHoursPermitted:false,earningsTradesPermitted:false,coveredCallsPermitted:false,protectivePutsPermitted:false,definedRiskSpreadsPermitted:false};

function hasCode(code:string):(error:unknown)=>boolean{return(error)=>typeof error==="object"&&error!==null&&"code" in error&&error.code===code;}

describe("authoritative PostgreSQL Paper execution risk context",{skip:databaseUrl===undefined},()=>{
  it("loads the current tenant graph and fails closed for expiry, stale sync/capabilities, malformed quotes, and active halts",async()=>{
    const suffix=randomUUID().replaceAll("-","");
    const userId=randomUUID();
    const connectionId=randomUUID();
    const accountId=randomUUID();
    const userAgentId=randomUUID();
    const pausedAgentId=randomUUID();
    const configurationId=randomUUID();
    const runId=randomUUID();
    const oldRunId=randomUUID();
    const proposalId=randomUUID();
    const oldProposalId=randomUUID();
    const approvalId=randomUUID();
    const portfolioId=randomUUID();
    const openingPortfolioId=randomUUID();
    const unreceiptedPortfolioId=randomUUID();
    const quoteId=randomUUID();
    const orderId=randomUUID();
    const incidentId=randomUUID();
    const unmappedPlanId=randomUUID();
    const unmappedCatalogId=randomUUID();
    const provider=`execution-risk-${suffix}`;
    const now="2095-08-01T14:01:00.000Z";
    const before="2095-08-01T14:00:00.000Z";
    const portfolioSource="2095-08-01T14:00:30.000Z";
    const validUntil="2095-08-01T14:02:00.000Z";
    const expiresAt="2095-08-01T14:05:00.000Z";

    await pool!.query(`INSERT INTO users(id,status,account_mode,onboarding_step) VALUES($1,'active','paper',14)`,[userId]);
    await pool!.query(
      `INSERT INTO subscriptions(user_id,plan_id,original_transaction_id,status,environment,effective_at)
       VALUES($1,'01000000-0000-4000-8000-000000000001',$2,'active','sandbox',$3::timestamptz)`,
      [userId,`execution-risk-subscription-${suffix}`,before]
    );
    await pool!.query(
      `INSERT INTO plans(id,plan_key,display_name,product_id,features,active)
       VALUES($1,$2,'Execution Unmapped Test',$3,$4::jsonb,false)`,
      [unmappedPlanId,`execution-unmapped-${suffix}`,`ai.whox.metis.execution-unmapped-${suffix}`,JSON.stringify({stockTrading:true,optionsTrading:false,multiLegOptions:false,maximumActiveAgents:1,automaticMode:false,monitoringFrequencyMinutes:60,advancedAnalytics:false,customWatchlists:false,scannerAccess:false,agentCatalog:["equity-momentum"],prioritySupport:false})]
    );
    await pool!.query(
      `INSERT INTO plan_agent_catalog_versions(id,plan_id,version) VALUES($1,$2,1)`,
      [unmappedCatalogId,unmappedPlanId]
    );
    await pool!.query(
      `INSERT INTO plan_agent_catalog_entries(catalog_version_id,agent_version_id,position,research_universe)
       VALUES($1,'31000000-0000-4000-8000-000000000002',1,ARRAY['AAPL','MSFT','VTI']::text[])`,
      [unmappedCatalogId]
    );
    await pool!.query(`UPDATE plan_agent_catalog_versions SET activated_at=clock_timestamp() WHERE id=$1`,[unmappedCatalogId]);
    await pool!.query(`UPDATE plans SET active=true WHERE id=$1`,[unmappedPlanId]);
    await pool!.query(
      `INSERT INTO broker_connections(id,user_id,provider,status,connected_at,last_sync_at)
       VALUES($1,$2,'robinhood_mcp','connected',$3::timestamptz,$4::timestamptz)`,
      [connectionId,userId,before,now]
    );
    await pool!.query(
      `INSERT INTO broker_accounts(id,connection_id,user_id,opaque_broker_id,account_type,is_agentic_account,verified_for_trading_at,active)
       VALUES($1,$2,$3,$4,'individual',true,$5::timestamptz,true)`,
      [accountId,connectionId,userId,`execution-risk-account-${suffix}`,before]
    );
    for(const capability of ["get_equity_quotes","get_equity_tradability","review_equity_order"]){
      await pool!.query(
        `INSERT INTO broker_capabilities(connection_id,tool_name,input_schema,protocol_version,discovered_at,last_seen_at)
         VALUES($1,$2,'{}'::jsonb,'2026-11-25',$3::timestamptz,$3::timestamptz)`,
        [connectionId,capability,now]
      );
    }
    await pool!.query(
      `INSERT INTO user_agents(id,user_id,agent_version_id,status,environment,allocation_limit,approval_mode)
       VALUES($1,$2,'31000000-0000-4000-8000-000000000001','monitoring','paper',0.4,'confirm_every_trade'),
             ($3,$2,'31000000-0000-4000-8000-000000000002','paused','paper',0.1,'observe')`,
      [userAgentId,userId,pausedAgentId]
    );
    await pool!.query(
      `INSERT INTO agent_configurations(id,user_agent_id,user_id,version,configuration,effective_at)
       VALUES($1,$2,$3,1,'{"symbol":"AAPL","targetOrderAmount":1000}'::jsonb,$4::timestamptz)`,
      [configurationId,userAgentId,userId,before]
    );
    await pool!.query(
      `INSERT INTO risk_policies(user_id,version,limits,exclusions,effective_at)
       VALUES($1,1,$2::jsonb,$3::jsonb,$4::timestamptz)`,
      [userId,JSON.stringify(limits),JSON.stringify(exclusions),before]
    );
    await pool!.query(
      `INSERT INTO portfolio_snapshots(id,user_id,broker_account_id,environment,total_value,buying_power,cash_value,source_timestamp,valid_until,data_classification)
       VALUES($1,$2,$3,'paper',10000,5000,5000,$4::timestamptz,$5::timestamptz,'paper'),
             ($6,$2,$3,'paper',10000,5000,5000,$7::timestamptz,$5::timestamptz,'paper'),
             ($8,$2,$3,'paper',999999,999999,999999,'2095-08-01T14:00:15Z',$5::timestamptz,'paper')`,
      [portfolioId,userId,accountId,portfolioSource,validUntil,openingPortfolioId,before,unreceiptedPortfolioId]
    );
    await pool!.query(
      `INSERT INTO broker_sync_runs(user_id,connection_id,portfolio_snapshot_id,idempotency_key,snapshot_fingerprint,source_timestamp,completed_at)
       VALUES($1,$2,$3,$4,$5,$6::timestamptz,$7::timestamptz),
             ($1,$2,$8,$9,$10,$11::timestamptz,$11::timestamptz)`,
      [userId,connectionId,portfolioId,`execution-risk-sync-${suffix}`,"c".repeat(64),portfolioSource,now,
        openingPortfolioId,`execution-risk-opening-sync-${suffix}`,"d".repeat(64),before]
    );
    await pool!.query(
      `INSERT INTO position_snapshots(portfolio_snapshot_id,user_id,broker_position_id,symbol,instrument_type,quantity,average_cost,market_value,details)
       VALUES($1,$2,$3,'AAPL','equity',10,90,1000,'{"sector":"Technology"}'::jsonb),
             ($1,$2,$4,'MSFT','equity',5,90,500,'{"sector":"Technology"}'::jsonb)`,
      [portfolioId,userId,`aapl-${suffix}`,`msft-${suffix}`]
    );
    const quote={symbol:"AAPL",bid:99.5,ask:100,last:100,tradable:true,fractionalSupported:true,liquiditySufficient:true,marketSession:"open",volatilityHalt:false,tradingHalt:false,corporateActionRestricted:false,earningsWindow:false,sector:"Technology",brokerWarningSeverity:"none"};
    await pool!.query(
      `INSERT INTO market_data_snapshots(id,provider,symbol,data_type,payload,source_timestamp,received_at,delayed_by_seconds)
       VALUES($1,$2,'AAPL','quote',$3::jsonb,$4::timestamptz,$4::timestamptz,0)`,
      [quoteId,provider,JSON.stringify(quote),now]
    );
    for(const [index,key] of ["terms","privacy","ai-risk"].entries()){
      const documentId=randomUUID();
      await pool!.query(
        `INSERT INTO legal_documents(id,document_key,version,title,content_uri,content_sha256,production_approved,published_at)
         VALUES($1,$2,$3,$4,$5,$6,true,$7::timestamptz)`,
        [documentId,key,`execution-risk-${suffix}`,`${key} execution test`,`https://legal.invalid/${key}/${suffix}`,String(index+1).repeat(64),before]
      );
      await pool!.query(`INSERT INTO legal_consents(user_id,legal_document_id,accepted_at) VALUES($1,$2,$3::timestamptz)`,[userId,documentId,before]);
    }
    await pool!.query(
      `INSERT INTO agent_runs(id,user_id,user_agent_id,status,idempotency_key,started_at,completed_at,strategy_version)
       VALUES($1,$2,$3,'completed',$4,$5::timestamptz,$5::timestamptz,'foundation-equity-rules-1.0.0'),
             ($6,$2,$3,'completed',$7,$5::timestamptz,$5::timestamptz,'foundation-equity-rules-1.0.0')`,
      [runId,userId,userAgentId,`execution-risk-run-${suffix}`,before,oldRunId,`execution-risk-old-run-${suffix}`]
    );
    const proposal={...DEMO_EQUITY_PROPOSAL,proposalId,userId,accountId,environment:"paper" as const,quantity:10,notionalEstimate:1_000,limitPrice:100,dataTimestamp:now,quoteTimestamp:now,expirationTimestamp:expiresAt,warnings:["Paper environment only"]};
    const oldProposal={...proposal,proposalId:oldProposalId,expirationTimestamp:before};
    await pool!.query(
      `INSERT INTO trade_proposals(id,user_id,broker_account_id,agent_run_id,agent_version_id,environment,status,version,symbol,instrument_type,proposal,proposal_fingerprint,idempotency_key,expires_at,created_at,updated_at)
       VALUES($1,$2,$3,$4,'31000000-0000-4000-8000-000000000001','paper','APPROVED',7,'AAPL','equity',$5::jsonb,$6,$7,$8::timestamptz,$9::timestamptz,$9::timestamptz),
             ($10,$2,$3,$11,'31000000-0000-4000-8000-000000000001','paper','FILLED',10,'AAPL','equity',$12::jsonb,$13,$14,$9::timestamptz,$9::timestamptz,$9::timestamptz)`,
      [proposalId,userId,accountId,runId,JSON.stringify(proposal),"a".repeat(64),`execution-risk-proposal-${suffix}`,expiresAt,before,oldProposalId,oldRunId,JSON.stringify(oldProposal),"b".repeat(64),`execution-risk-old-proposal-${suffix}`]
    );
    const authentication={actorType:"user",authenticatedUserId:userId,authenticationContextId:`session-${suffix}`,sessionId:`session-${suffix}`,method:"app_attest",action:"approve_trade_proposal",resourceId:proposalId,authenticatedAt:"2095-08-01T14:00:40.000Z"};
    await pool!.query(
      `INSERT INTO approval_requests(id,proposal_id,user_id,status,idempotency_key,requested_at,expires_at,acted_at,authentication_context)
       VALUES($1,$2,$3,'approved',$4,'2095-08-01T14:00:30Z',$5::timestamptz,'2095-08-01T14:00:45Z',$6::jsonb)`,
      [approvalId,proposalId,userId,`execution-risk-approval-${suffix}`,expiresAt,JSON.stringify(authentication)]
    );
    await pool!.query(
      `INSERT INTO capital_reservations(user_id,broker_account_id,user_agent_id,proposal_id,symbol,side,amount,idempotency_key,expires_at)
       VALUES($1,$2,$3,$4,'AAPL','buy',1000,$5,$6::timestamptz),
             ($1,$2,$3,NULL,'TSLA','buy',100,$7,$6::timestamptz),
             ($1,$2,$8,NULL,'NVDA','buy',50,$9,$6::timestamptz)`,
      [userId,accountId,userAgentId,proposalId,`execution-risk-current-reservation-${suffix}`,expiresAt,`execution-risk-own-reservation-${suffix}`,pausedAgentId,`execution-risk-other-reservation-${suffix}`]
    );
    await pool!.query(
      `INSERT INTO orders(id,user_id,proposal_id,broker_account_id,broker_order_id,instrument_type,status,submission_idempotency_key,submitted_at,terminal_at)
       VALUES($1,$2,$3,$4,$5,'equity','filled',$6,$7::timestamptz,$7::timestamptz)`,
      [orderId,userId,oldProposalId,accountId,`paper-old-${suffix}`,`execution-risk-old-order-${suffix}`,before]
    );
    await pool!.query(
      `INSERT INTO fills(order_id,user_id,broker_fill_id,quantity,price,fees,occurred_at)
       VALUES($1,$2,$3,2,100,0,$4::timestamptz)`,
      [orderId,userId,`paper-old-fill-${suffix}`,before]
    );

    const repository=new PostgresExecutionRepository(databaseUrl!);
    try{
      const authorized=await repository.proposalStore(userId).loadApproved(proposalId,now,gates,[provider]);
      await pool!.query(`UPDATE broker_connections SET revoked_at=$2::timestamptz WHERE id=$1 AND status='connected'`,[connectionId,now]);
      await assert.rejects(
        repository.proposalStore(userId).loadApproved(proposalId,now,gates,[provider]),
        hasCode("BROKER_ACCOUNT_BINDING_INVALID")
      );
      await assert.rejects(
        repository.loadAuthoritativeRiskContext(userId,authorized,now),
        hasCode("AGENTIC_ACCOUNT_BINDING_INVALID")
      );
      await pool!.query(`UPDATE broker_connections SET revoked_at=NULL WHERE id=$1`,[connectionId]);
      await pool!.query(`UPDATE subscriptions SET plan_id=$2 WHERE user_id=$1`,[userId,unmappedPlanId]);
      await assert.rejects(
        repository.proposalStore(userId).loadApproved(proposalId,now,gates,[provider]),
        hasCode("EXECUTION_ENTITLEMENT_BINDING_INVALID")
      );
      await assert.rejects(
        repository.loadAuthoritativeRiskContext(userId,authorized,now),
        hasCode("EXECUTION_ENTITLEMENT_BINDING_INVALID")
      );
      await pool!.query(`UPDATE subscriptions SET plan_id='01000000-0000-4000-8000-000000000001' WHERE user_id=$1`,[userId]);
      const context=await repository.loadAuthoritativeRiskContext(userId,authorized,now);
      assert.deepEqual({
        accountValue:context.accountValue,buyingPower:context.buyingPower,reservedBuyingPower:context.reservedBuyingPower,
        currentAllocatedValue:context.currentAllocatedValue,currentPositionValue:context.currentPositionValue,
        currentHeldQuantity:context.currentHeldQuantity,currentSectorValue:context.currentSectorValue,
        openPositionCount:context.openPositionCount,otherAgentReservations:context.otherAgentReservations,
        tradesToday:context.tradesToday,turnoverToday:context.turnoverToday,quotePrice:context.quotePrice,
        expectedExecutionPrice:context.expectedExecutionPrice,currentLegalConsents:context.currentLegalConsents
      },{accountValue:10_000,buyingPower:5_000,reservedBuyingPower:100,currentAllocatedValue:1_500,currentPositionValue:1_000,currentHeldQuantity:10,currentSectorValue:1_500,openPositionCount:2,otherAgentReservations:50,tradesToday:1,turnoverToday:0.02,quotePrice:100,expectedExecutionPrice:100,currentLegalConsents:true});
      assert.equal(context.dailyLoss,0);
      assert.equal(context.drawdownRatio,0);
      assert.equal(evaluateRisk(authorized.aggregate.proposal,authorized.policy,context).passed,true);
      await pool!.query(`UPDATE position_snapshots SET details='{}'::jsonb WHERE portfolio_snapshot_id=$1 AND symbol='MSFT'`,[portfolioId]);
      await assert.rejects(repository.loadAuthoritativeRiskContext(userId,authorized,now),hasCode("AUTHORITATIVE_ACCOUNT_SNAPSHOT_REQUIRED"));
      await pool!.query(`UPDATE position_snapshots SET details='{"sector":"Technology"}'::jsonb WHERE portfolio_snapshot_id=$1 AND symbol='MSFT'`,[portfolioId]);
      await pool!.query(
        `UPDATE approval_requests SET authentication_context=jsonb_set(authentication_context,'{action}','"approve_other"'::jsonb) WHERE id=$1`,
        [approvalId]
      );
      await assert.rejects(
        repository.proposalStore(userId).loadApproved(proposalId,now,gates,[provider]),
        hasCode("AUTHENTICATED_APPROVAL_REQUIRED")
      );
      await pool!.query(`UPDATE approval_requests SET authentication_context=$2::jsonb WHERE id=$1`,[approvalId,JSON.stringify(authentication)]);
      await assert.rejects(
        repository.proposalStore(userId).loadApproved(proposalId,"2095-08-01T14:01:31.000Z",gates,[provider]),
        hasCode("PROPOSAL_REAPPROVAL_REQUIRED")
      );

      await pool!.query(`UPDATE portfolio_snapshots SET valid_until=$2::timestamptz WHERE id=$1`,[portfolioId,now]);
      await assert.rejects(repository.loadAuthoritativeRiskContext(userId,authorized,now),hasCode("AUTHORITATIVE_ACCOUNT_SNAPSHOT_REQUIRED"));
      await pool!.query(`UPDATE portfolio_snapshots SET valid_until=$2::timestamptz WHERE id=$1`,[portfolioId,validUntil]);
      await pool!.query(`UPDATE portfolio_snapshots SET source_timestamp='2095-08-01T13:59:00Z',valid_until=$2::timestamptz WHERE id=ANY($1::uuid[])`,[[portfolioId,openingPortfolioId],validUntil]);
      await assert.rejects(repository.loadAuthoritativeRiskContext(userId,authorized,now),hasCode("AUTHORITATIVE_ACCOUNT_SNAPSHOT_REQUIRED"));
      await pool!.query(`UPDATE portfolio_snapshots SET source_timestamp=$2::timestamptz,valid_until=$3::timestamptz WHERE id=$1`,[portfolioId,portfolioSource,validUntil]);
      await pool!.query(`UPDATE portfolio_snapshots SET source_timestamp=$2::timestamptz,valid_until=$3::timestamptz WHERE id=$1`,[openingPortfolioId,before,validUntil]);

      await pool!.query(`UPDATE broker_connections SET last_sync_at='2095-08-01T13:55:59Z' WHERE id=$1`,[connectionId]);
      await assert.rejects(repository.loadAuthoritativeRiskContext(userId,authorized,now),hasCode("AGENTIC_ACCOUNT_BINDING_INVALID"));
      await pool!.query(`UPDATE broker_connections SET last_sync_at=$2::timestamptz WHERE id=$1`,[connectionId,now]);
      await pool!.query(`UPDATE broker_capabilities SET unavailable_at=$2::timestamptz WHERE connection_id=$1 AND tool_name='review_equity_order'`,[connectionId,now]);
      await assert.rejects(repository.loadAuthoritativeRiskContext(userId,authorized,now),hasCode("BROKER_CAPABILITY_BINDING_INVALID"));
      await pool!.query(`UPDATE broker_capabilities SET unavailable_at=NULL WHERE connection_id=$1`,[connectionId]);

      await pool!.query(`UPDATE market_data_snapshots SET payload=jsonb_set(payload,'{tradable}','"yes"'::jsonb) WHERE id=$1`,[quoteId]);
      await assert.rejects(repository.loadAuthoritativeRiskContext(userId,authorized,now),hasCode("AUTHORITATIVE_MARKET_CONTEXT_REQUIRED"));
      await pool!.query(`UPDATE market_data_snapshots SET payload=$2::jsonb WHERE id=$1`,[quoteId,JSON.stringify(quote)]);

      await pool!.query(
        `UPDATE risk_policies SET limits=jsonb_set(limits,'{maximumQuoteAgeSeconds}','31'::jsonb) WHERE user_id=$1`,
        [userId]
      );
      await assert.rejects(
        repository.proposalStore(userId).loadApproved(proposalId,now,gates,[provider]),
        hasCode("PERSISTED_RISK_POLICY_INVALID")
      );
      await pool!.query(
        `UPDATE risk_policies SET limits=jsonb_set(limits,'{maximumQuoteAgeSeconds}','30'::jsonb) WHERE user_id=$1`,
        [userId]
      );

      await pool!.query(
        `INSERT INTO risk_events(user_id,broker_account_id,environment,event_type,severity,reason_code,structured_details,occurred_at)
         VALUES($1,$2,'paper','risk_halt','blocking','TEST_ACTIVE_RISK_HALT','{"active":true}'::jsonb,$3::timestamptz)`,
        [userId,accountId,now]
      );
      await pool!.query(
        `INSERT INTO security_events(user_id,event_type,severity,structured_details,occurred_at)
         VALUES($1,'security_halt','critical','{"active":true}'::jsonb,$2::timestamptz)`,
        [userId,now]
      );
      await pool!.query(
        `INSERT INTO system_incidents(id,environment,severity,status,public_message,started_at)
         VALUES($1,'paper','critical','identified','Execution test incident',$2::timestamptz)`,
        [incidentId,now]
      );
      try{
        const halted=await repository.loadAuthoritativeRiskContext(userId,authorized,now);
        assert.equal(halted.cooldownActive,true);
        assert.equal(halted.securityHalt,true);
        assert.equal(halted.criticalServicesHealthy,false);
        const failedCodes=evaluateRisk(authorized.aggregate.proposal,authorized.policy,halted).checks.filter((check)=>!check.passed).map((check)=>check.code);
        assert.equal(failedCodes.includes("COOLDOWN_CLEAR"),true);
        assert.equal(failedCodes.includes("SECURITY_HALT_CLEAR"),true);
        assert.equal(failedCodes.includes("CRITICAL_SERVICES_HEALTHY"),true);
      }finally{
        await pool!.query(`UPDATE system_incidents SET status='resolved',resolved_at=$2::timestamptz WHERE id=$1`,[incidentId,now]);
      }
    }finally{
      try{
        await repository.close();
      }finally{
        await pool!.query(`UPDATE plans SET active=false WHERE id=$1`,[unmappedPlanId]);
      }
    }
  });
});
