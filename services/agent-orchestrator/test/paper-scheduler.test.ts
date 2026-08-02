import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import { Pool } from "pg";
import { PostgresPaperAgentScheduler } from "../src/paper-scheduler.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const pool = databaseUrl === undefined ? undefined : new Pool({ connectionString: databaseUrl });
after(async () => pool?.end());

interface EligibleSchedulerUserFixture {
  readonly userId: string;
  readonly userAgentId: string;
  readonly connectionId: string;
  readonly accountId: string;
  readonly planId: string;
  readonly suffix: string;
  readonly now: Date;
  readonly before: string;
  readonly legalDocumentIds: readonly string[];
  readonly monitoringFrequencyOverride?: number;
  readonly nextDueAt?: string;
}

async function insertEligibleSchedulerUser(fixture: EligibleSchedulerUserFixture): Promise<void> {
  const {
    userId,userAgentId,connectionId,accountId,planId,suffix,now,before,legalDocumentIds,
    monitoringFrequencyOverride,nextDueAt
  } = fixture;
  await pool!.query(`INSERT INTO users(id,status,account_mode,onboarding_step) VALUES($1,'active','paper',14)`, [userId]);
  await pool!.query(
    `INSERT INTO subscriptions(user_id,plan_id,original_transaction_id,status,environment,effective_at)
     VALUES($1,$2,$3,'active','sandbox',$4::timestamptz)`,
    [userId, planId, `cadence-subscription-${suffix}`, before]
  );
  await pool!.query(
    `INSERT INTO eligibility_profiles(
       user_id,country,region,age_eligible,own_individual_account,understands_not_bank_or_broker,
       adviser_client_classification,eligibility_status,assessment_version,assessed_at
     ) VALUES($1,'US','NY',true,true,true,'self_directed','eligible','cadence-v1',$2::timestamptz)`,
    [userId, before]
  );
  await pool!.query(
    `INSERT INTO risk_assessments(
       user_id,classification,options_classification,score,factors,rationale,scoring_version,explanation,completed_at
     ) VALUES($1,'growth','options_restricted',1,'[]'::jsonb,'[]'::jsonb,'cadence-v1','Cadence fixture',$2::timestamptz)`,
    [userId, before]
  );
  if (monitoringFrequencyOverride !== undefined) {
    await pool!.query(
      `INSERT INTO entitlements(user_id,feature_key,value,effective_at)
       VALUES($1,'monitoringFrequencyMinutes',$2::jsonb,$3::timestamptz)`,
      [userId, JSON.stringify(monitoringFrequencyOverride), before]
    );
  }
  await pool!.query(
    `INSERT INTO broker_connections(id,user_id,provider,status,connected_at,last_sync_at)
     VALUES($1,$2,'robinhood_mcp','connected',$3::timestamptz,$3::timestamptz)`,
    [connectionId, userId, now.toISOString()]
  );
  await pool!.query(
    `INSERT INTO broker_accounts(
       id,connection_id,user_id,opaque_broker_id,account_type,is_agentic_account,verified_for_trading_at,active
     ) VALUES($1,$2,$3,$4,'individual',true,$5::timestamptz,true)`,
    [accountId, connectionId, userId, `cadence-account-${suffix}`, before]
  );
  for (const capability of ["get_equity_quotes", "get_equity_tradability", "review_equity_order"]) {
    await pool!.query(
      `INSERT INTO broker_capabilities(connection_id,tool_name,input_schema,protocol_version,discovered_at,last_seen_at)
       VALUES($1,$2,'{}'::jsonb,'cadence-test',$3::timestamptz,$3::timestamptz)`,
      [connectionId, capability, now.toISOString()]
    );
  }
  await pool!.query(
    `INSERT INTO user_agents(
       id,user_id,agent_version_id,status,environment,allocation_limit,approval_mode,created_at,updated_at
     ) VALUES($1,$2,'31000000-0000-4000-8000-000000000001','monitoring','paper',0.2,'observe',$3,$3)`,
    [userAgentId, userId, before]
  );
  await pool!.query(
    `INSERT INTO agent_configurations(user_agent_id,user_id,version,configuration,effective_at)
     VALUES($1,$2,1,'{"symbol":"AAPL","targetOrderAmount":100}'::jsonb,$3::timestamptz)`,
    [userAgentId, userId, before]
  );
  await pool!.query(
    `INSERT INTO risk_policies(user_id,version,limits,exclusions,effective_at)
     VALUES($1,1,'{"maximumQuoteAgeSeconds":60,"maximumAccountSnapshotAgeSeconds":600}'::jsonb,'{}'::jsonb,$2)`,
    [userId, before]
  );
  await pool!.query(
    `INSERT INTO portfolio_snapshots(
       user_id,broker_account_id,environment,total_value,buying_power,cash_value,
       source_timestamp,valid_until,data_classification
     ) VALUES($1,$2,'paper',10000,5000,5000,$3,$4,'paper')`,
    [userId, accountId, now.toISOString(), new Date(now.getTime() + 10 * 60_000).toISOString()]
  );
  for (const legalDocumentId of legalDocumentIds) {
    await pool!.query(
      `INSERT INTO legal_consents(user_id,legal_document_id,accepted_at) VALUES($1,$2,$3)`,
      [userId, legalDocumentId, before]
    );
  }
  if (nextDueAt !== undefined) {
    await pool!.query(
      `INSERT INTO paper_agent_schedule_states(
         user_agent_id,user_id,monitoring_frequency_minutes,symbol,next_due_at,last_evaluated_at,block_reason
       ) VALUES($1,$2,30,'AAPL',$3::timestamptz,$4::timestamptz,'NOT_DUE')`,
      [userAgentId, userId, nextDueAt, before]
    );
  }
}

describe("durable Paper agent scheduler", { skip: databaseUrl === undefined }, () => {
  it("enqueues tenant-bound quote refresh first, then exactly one run after an approved fresh quote", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const userId = randomUUID();
    const userAgentId = randomUUID();
    const connectionId = randomUUID();
    const accountId = randomUUID();
    const provider = `scheduler-${suffix}`;
    const now = new Date();
    const before = new Date(now.getTime() - 10 * 60_000).toISOString();
    const validUntil = new Date(now.getTime() + 10 * 60_000).toISOString();

    await pool!.query(
      `INSERT INTO users(id,status,account_mode,onboarding_step) VALUES($1,'active','paper',14)`,
      [userId]
    );
    await pool!.query(
      `INSERT INTO subscriptions(user_id,plan_id,original_transaction_id,status,environment,effective_at)
       VALUES($1,'01000000-0000-4000-8000-000000000001',$2,'active','sandbox',$3::timestamptz)`,
      [userId, `scheduler-subscription-${suffix}`, before]
    );
    await pool!.query(
      `INSERT INTO eligibility_profiles(
         user_id,country,region,age_eligible,own_individual_account,understands_not_bank_or_broker,
         adviser_client_classification,eligibility_status,assessment_version,assessed_at
       ) VALUES($1,'US','NY',true,true,true,'self_directed','eligible','scheduler-v1',$2::timestamptz)`,
      [userId, before]
    );
    await pool!.query(
      `INSERT INTO risk_assessments(
         user_id,classification,options_classification,score,factors,rationale,scoring_version,explanation,completed_at
       ) VALUES($1,'growth','options_restricted',1,'[]'::jsonb,'[]'::jsonb,'scheduler-v1','Scheduler fixture',$2::timestamptz)`,
      [userId, before]
    );
    await pool!.query(
      `INSERT INTO entitlements(user_id,feature_key,value,effective_at)
       VALUES($1,'monitoringFrequencyMinutes','2880'::jsonb,$2::timestamptz)`,
      [userId, before]
    );
    await pool!.query(
      `INSERT INTO broker_connections(id,user_id,provider,status,connected_at,last_sync_at)
       VALUES($1,$2,'robinhood_mcp','connected',$3::timestamptz,$3::timestamptz)`,
      [connectionId, userId, now.toISOString()]
    );
    await pool!.query(
      `INSERT INTO broker_accounts(id,connection_id,user_id,opaque_broker_id,account_type,is_agentic_account,verified_for_trading_at,active)
       VALUES($1,$2,$3,$4,'individual',true,$5::timestamptz,true)`,
      [accountId, connectionId, userId, `scheduler-account-${suffix}`, before]
    );
    for (const capability of ["get_equity_quotes", "get_equity_tradability", "review_equity_order_v2"]) {
      await pool!.query(
        `INSERT INTO broker_capabilities(connection_id,tool_name,input_schema,protocol_version,discovered_at,last_seen_at)
         VALUES($1,$2,'{}'::jsonb,'scheduler-test',$3::timestamptz,$3::timestamptz)`,
        [connectionId, capability, now.toISOString()]
      );
    }
    await pool!.query(
      `INSERT INTO user_agents(
         id,user_id,agent_version_id,status,environment,allocation_limit,approval_mode,created_at,updated_at
       ) VALUES(
         $1,$2,'31000000-0000-4000-8000-000000000001','monitoring','paper',0.4,'confirm_every_trade',
         $3::timestamptz,$3::timestamptz
       )`,
      [userAgentId, userId, before]
    );
    await pool!.query(
      `INSERT INTO agent_configurations(user_agent_id,user_id,version,configuration,effective_at)
       VALUES($1,$2,1,$3::jsonb,$4::timestamptz)`,
      [userAgentId, userId, JSON.stringify({ symbol: "AAPL", targetOrderAmount: 1_000 }), before]
    );
    await pool!.query(
      `INSERT INTO risk_policies(user_id,version,limits,exclusions,effective_at)
       VALUES($1,1,$2::jsonb,'{}'::jsonb,$3::timestamptz)`,
      [userId, JSON.stringify({ maximumQuoteAgeSeconds: 60, maximumAccountSnapshotAgeSeconds: 600 }), before]
    );
    for (const [index, documentKey] of ["terms", "privacy", "ai-risk"].entries()) {
      const legalDocumentId = randomUUID();
      await pool!.query(
        `INSERT INTO legal_documents(
           id,document_key,version,title,content_uri,content_sha256,production_approved,published_at
         ) VALUES($1,$2,$3,$4,$5,$6,true,$7::timestamptz)`,
        [
          legalDocumentId,
          documentKey,
          `scheduler-${suffix}`,
          `${documentKey} scheduler fixture`,
          `https://legal.invalid/${documentKey}/${suffix}`,
          String(index + 4).repeat(64),
          before
        ]
      );
      await pool!.query(
        `INSERT INTO legal_consents(user_id,legal_document_id,accepted_at) VALUES($1,$2,$3::timestamptz)`,
        [userId, legalDocumentId, before]
      );
    }
    await pool!.query(
      `INSERT INTO portfolio_snapshots(
         user_id,broker_account_id,environment,total_value,buying_power,cash_value,
         source_timestamp,valid_until,data_classification
       ) VALUES($1,$2,'paper',10000,5000,5000,$3::timestamptz,$4::timestamptz,'paper')`,
      [userId, accountId, now.toISOString(), validUntil]
    );

    const scheduler = new PostgresPaperAgentScheduler(databaseUrl!, {
      approvedMarketDataProviders: [provider],
      marketDataProviderId: provider,
      autonomousModeEnabled: false
    });
    try {
      const renamedCapability = await scheduler.runOnce();
      assert.equal(renamedCapability.agentRunsEnqueued, 0);
      const beforeCapabilityFix = await pool!.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM queue_jobs WHERE user_id=$1 AND queue_name IN ('market-data','agent-runs')`,
        [userId]
      );
      assert.equal(beforeCapabilityFix.rows[0]?.count, "0");
      await pool!.query(
        `INSERT INTO broker_capabilities(connection_id,tool_name,input_schema,protocol_version,discovered_at,last_seen_at)
         VALUES($1,'review_equity_order','{}'::jsonb,'scheduler-test',clock_timestamp(),clock_timestamp())`,
        [connectionId]
      );
      const stale = await scheduler.runOnce();
      assert.equal(stale.lockAcquired, true);
      assert.equal(stale.evaluatedAgents >= 1, true);
      // One singleton plan-universe refresh plus one tenant-bound symbol refresh.
      assert.equal(stale.refreshJobsEnqueued, 2);
      assert.equal(stale.researchJobsEnqueued, 1);
      assert.equal(stale.agentRunsEnqueued, 0);
      assert.equal(stale.researchBlockedAgents, 1);
      assert.equal(stale.quoteBlockedAgents, 0);

      const refresh = await pool!.query<{
        user_id: string | null;
        job_type: string;
        payload: { symbols: string[]; userAgentId: string };
      }>(
        `SELECT user_id::text,job_type,payload FROM queue_jobs
         WHERE queue_name='market-data' AND payload->>'userAgentId'=$1`,
        [userAgentId]
      );
      assert.equal(refresh.rows.length, 1);
      assert.equal(refresh.rows[0]?.user_id, userId);
      assert.equal(refresh.rows[0]?.job_type, "refresh_quotes");
      assert.deepEqual(refresh.rows[0]?.payload.symbols, ["AAPL"]);

      await pool!.query(
        `INSERT INTO market_data_snapshots(provider,symbol,data_type,payload,source_timestamp)
         VALUES($1,'AAPL','quote',$2::jsonb,clock_timestamp())`,
        [
          `not-approved-${suffix}`,
          JSON.stringify({ symbol: "AAPL", bid: 99, ask: 100, last: 100, provider: `not-approved-${suffix}` })
        ]
      );
      const unapproved = await scheduler.runOnce();
      assert.equal(unapproved.refreshJobsEnqueued, 0);
      assert.equal(unapproved.agentRunsEnqueued, 0);
      assert.equal(unapproved.researchBlockedAgents, 1);

      await pool!.query(
        `INSERT INTO market_data_snapshots(provider,symbol,data_type,payload,source_timestamp)
         VALUES($1,'AAPL','quote',$2::jsonb,clock_timestamp())`,
        [provider, JSON.stringify({
          symbol: "AAPL",
          bid: 99,
          ask: 100,
          last: 100,
          provider,
          delayedBySeconds: 0,
          tradable: true,
          fractionalSupported: true,
          liquiditySufficient: true,
          marketSession: "open",
          volatilityHalt: false,
          tradingHalt: false,
          corporateActionRestricted: false,
          earningsWindow: false,
          sector: "Technology",
          brokerWarningSeverity: "none"
        })]
      );
      const cycle = await pool!.query<{ id: string; evaluation_as_of: Date }>(
        `SELECT id,evaluation_as_of FROM paper_plan_cycles
         WHERE plan_id='01000000-0000-4000-8000-000000000001'
           AND agent_version_id='31000000-0000-4000-8000-000000000001'
         ORDER BY evaluation_as_of DESC LIMIT 1`
      );
      await pool!.query(
        `INSERT INTO paper_plan_research_artifacts(
           plan_cycle_id,provider_id,model_id,source_as_of,context_sha256,request_sha256,
           sanitized_decision,decision_sha256
         ) VALUES($1,'hermes','treasury-bot',$2,$3,$4,'{}'::jsonb,$5)`,
        [cycle.rows[0]!.id, cycle.rows[0]!.evaluation_as_of, "a".repeat(64), "b".repeat(64), "c".repeat(64)]
      );
      const fresh = await scheduler.runOnce();
      assert.equal(fresh.refreshJobsEnqueued, 0);
      assert.equal(fresh.agentRunsEnqueued, 1);
      assert.equal(fresh.quoteBlockedAgents, 0);

      const run = await pool!.query<{
        user_id: string | null;
        job_type: string;
        payload: { userAgentId: string; runIdempotencyKey: string };
      }>(
        `SELECT user_id::text,job_type,payload FROM queue_jobs
         WHERE queue_name='agent-runs' AND payload->>'userAgentId'=$1`,
        [userAgentId]
      );
      assert.equal(run.rows.length, 1);
      assert.equal(run.rows[0]?.user_id, userId);
      assert.equal(run.rows[0]?.job_type, "agent_run");
      assert.equal(run.rows[0]?.payload.userAgentId, userAgentId);
      assert.match(run.rows[0]?.payload.runIdempotencyKey ?? "", /^scheduled-paper-plan-run:/);

      const duplicate = await scheduler.runOnce();
      assert.equal(duplicate.refreshJobsEnqueued, 0);
      assert.equal(duplicate.agentRunsEnqueued, 0);
      const state = await pool!.query<{ block_reason: string | null; next_due_at: Date }>(
        `SELECT block_reason,next_due_at FROM paper_agent_schedule_states WHERE user_agent_id=$1 AND user_id=$2`,
        [userAgentId, userId]
      );
      assert.equal(state.rows[0]?.block_reason, "NOT_DUE");
      assert.equal((state.rows[0]?.next_due_at.getTime() ?? 0) > Date.now() + 47 * 60 * 60_000, true);

      await pool!.query(
        `UPDATE paper_agent_schedule_states
         SET next_due_at=clock_timestamp()-interval '1 minute',
           last_agent_run_enqueued_at=clock_timestamp()-interval '3 days'
         WHERE user_agent_id=$1 AND user_id=$2`,
        [userAgentId, userId]
      );
      const constrainedScheduler = new PostgresPaperAgentScheduler(databaseUrl!, {
        approvedMarketDataProviders: [provider],
        marketDataProviderId: provider,
        autonomousModeEnabled: false,
        maxOutstandingJobs: 1
      });
      try {
        const constrained = await constrainedScheduler.runOnce();
        assert.equal(constrained.agentRunsEnqueued, 0);
        assert.equal(constrained.backpressureBlockedAgents >= 1, true);
      } finally {
        await constrainedScheduler.close();
      }
    } finally {
      await scheduler.close();
    }
  });

  it("does not select a monitoring agent without an active subscription", async () => {
    const userId = randomUUID();
    const userAgentId = randomUUID();
    await pool!.query(`INSERT INTO users(id,status,account_mode,onboarding_step) VALUES($1,'active','paper',14)`, [userId]);
    await pool!.query(
      `INSERT INTO user_agents(id,user_id,agent_version_id,status,environment,allocation_limit,approval_mode)
       VALUES($1,$2,'31000000-0000-4000-8000-000000000001','monitoring','paper',0.2,'observe')`,
      [userAgentId, userId]
    );
    await pool!.query(
      `INSERT INTO agent_configurations(user_agent_id,user_id,version,configuration,effective_at)
       VALUES($1,$2,1,'{"symbol":"MSFT","targetOrderAmount":100}'::jsonb,clock_timestamp()-interval '1 minute')`,
      [userAgentId, userId]
    );
    const provider = `scheduler-${randomUUID().replaceAll("-", "")}`;
    const scheduler = new PostgresPaperAgentScheduler(databaseUrl!, {
      approvedMarketDataProviders: [provider],
      marketDataProviderId: provider,
      autonomousModeEnabled: false
    });
    try {
      await scheduler.runOnce();
      const jobs = await pool!.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM queue_jobs WHERE user_id=$1 AND queue_name IN ('market-data','agent-runs')`,
        [userId]
      );
      assert.equal(jobs.rows[0]?.count, "0");
    } finally {
      await scheduler.close();
    }
  });

  it("does not create plan research for a merely monitoring but ineligible tenant", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const planId = randomUUID();
    const catalogVersionId = randomUUID();
    const userId = randomUUID();
    const userAgentId = randomUUID();
    const provider = `scheduler-${suffix}`;
    const before = new Date(Date.now() - 60_000).toISOString();
    await pool!.query(
      `INSERT INTO plans(id,plan_key,display_name,product_id,features,active)
       VALUES($1,$2,'Ineligible isolation plan',$3,$4::jsonb,false)`,
      [
        planId,
        `ineligible-${suffix}`,
        `ineligible.product.${suffix}`,
        JSON.stringify({
          stockTrading: true,
          optionsTrading: false,
          multiLegOptions: false,
          maximumActiveAgents: 1,
          automaticMode: false,
          monitoringFrequencyMinutes: 30,
          advancedAnalytics: false,
          customWatchlists: false,
          scannerAccess: false,
          agentCatalog: ["foundation-equity"],
          prioritySupport: false
        })
      ]
    );
    await pool!.query(
      `INSERT INTO plan_agent_catalog_versions(id,plan_id,version) VALUES($1,$2,1)`,
      [catalogVersionId, planId]
    );
    await pool!.query(
      `INSERT INTO plan_agent_catalog_entries(catalog_version_id,agent_version_id,position,research_universe)
       VALUES($1,'31000000-0000-4000-8000-000000000001',1,ARRAY['AAPL','MSFT','VTI']::text[])`,
      [catalogVersionId]
    );
    await pool!.query(
      `UPDATE plan_agent_catalog_versions SET activated_at=$2::timestamptz WHERE id=$1`,
      [catalogVersionId, before]
    );
    await pool!.query(`UPDATE plans SET active=true WHERE id=$1`, [planId]);
    await pool!.query(`INSERT INTO users(id,status,account_mode,onboarding_step) VALUES($1,'active','paper',14)`, [userId]);
    await pool!.query(
      `INSERT INTO subscriptions(user_id,plan_id,original_transaction_id,status,environment,effective_at)
       VALUES($1,$2,$3,'active','sandbox',$4)`,
      [userId, planId, `ineligible-subscription-${suffix}`, before]
    );
    await pool!.query(
      `INSERT INTO user_agents(id,user_id,agent_version_id,status,environment,allocation_limit,approval_mode)
       VALUES($1,$2,'31000000-0000-4000-8000-000000000001','monitoring','paper',0.2,'observe')`,
      [userAgentId, userId]
    );
    await pool!.query(
      `INSERT INTO agent_configurations(user_agent_id,user_id,version,configuration,effective_at)
       VALUES($1,$2,1,'{"symbol":"AAPL","targetOrderAmount":100}'::jsonb,$3)`,
      [userAgentId, userId, before]
    );

    const scheduler = new PostgresPaperAgentScheduler(databaseUrl!, {
      approvedMarketDataProviders: [provider],
      marketDataProviderId: provider,
      autonomousModeEnabled: false
    });
    try {
      await scheduler.runOnce();
      const cycles = await pool!.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM paper_plan_cycles WHERE plan_id=$1`,
        [planId]
      );
      const researchJobs = await pool!.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM queue_jobs
         WHERE queue_name='plan-research' AND payload->>'planId'=$1`,
        [planId]
      );
      assert.equal(cycles.rows[0]?.count, "0");
      assert.equal(researchJobs.rows[0]?.count, "0");
    } finally {
      try {
        await scheduler.close();
      } finally {
        await pool!.query("UPDATE plans SET active=false WHERE id=$1", [planId]);
      }
    }
  });

  it("uses the fastest eligible cohort cadence without overscheduling a slower user", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const provider = `scheduler-${suffix}`;
    const planId = "01000000-0000-4000-8000-000000000002";
    const now = new Date();
    const before = new Date(now.getTime() - 60_000).toISOString();
    const legalDocumentIds: string[] = [];
    for (const [index, documentKey] of ["terms", "privacy", "ai-risk"].entries()) {
      const documentId = randomUUID();
      legalDocumentIds.push(documentId);
      await pool!.query(
        `INSERT INTO legal_documents(
           id,document_key,version,title,content_uri,content_sha256,production_approved,published_at
         ) VALUES($1,$2,$3,$4,$5,$6,true,$7)`,
        [
          documentId,
          documentKey,
          `cadence-${suffix}`,
          `${documentKey} cadence fixture`,
          `https://legal.invalid/${documentKey}/cadence-${suffix}`,
          String(index + 7).repeat(64),
          before
        ]
      );
    }
    const fastUserId = randomUUID();
    const fastUserAgentId = randomUUID();
    const slowUserId = randomUUID();
    const slowUserAgentId = randomUUID();
    const slowNextDue = new Date(now.getTime() + 20 * 60_000).toISOString();
    await insertEligibleSchedulerUser({
      userId: fastUserId,
      userAgentId: fastUserAgentId,
      connectionId: randomUUID(),
      accountId: randomUUID(),
      planId,
      suffix: `fast-${suffix}`,
      now,
      before,
      legalDocumentIds,
      monitoringFrequencyOverride: 15
    });
    await insertEligibleSchedulerUser({
      userId: slowUserId,
      userAgentId: slowUserAgentId,
      connectionId: randomUUID(),
      accountId: randomUUID(),
      planId,
      suffix: `slow-${suffix}`,
      now,
      before,
      legalDocumentIds,
      nextDueAt: slowNextDue
    });

    const scheduler = new PostgresPaperAgentScheduler(databaseUrl!, {
      approvedMarketDataProviders: [provider],
      marketDataProviderId: provider,
      autonomousModeEnabled: false
    });
    try {
      await scheduler.runOnce();
      const cycle = await pool!.query<{ schedule_bucket_started_at: Date; evaluation_as_of: Date }>(
        `SELECT schedule_bucket_started_at,evaluation_as_of FROM paper_plan_cycles
         WHERE plan_id=$1 AND agent_version_id='31000000-0000-4000-8000-000000000001'
         ORDER BY evaluation_as_of DESC LIMIT 1`,
        [planId]
      );
      const row = cycle.rows[0];
      assert.ok(row);
      const evaluationEpoch = Math.floor(row.evaluation_as_of.getTime() / 1_000);
      assert.equal(
        Math.floor(row.schedule_bucket_started_at.getTime() / 1_000),
        Math.floor(evaluationEpoch / (15 * 60)) * (15 * 60)
      );
      const tenantRefreshes = await pool!.query<{ user_id: string; count: string }>(
        `SELECT user_id::text,count(*)::text AS count FROM queue_jobs
         WHERE queue_name='market-data' AND job_type='refresh_quotes' AND user_id=ANY($1::uuid[])
         GROUP BY user_id`,
        [[fastUserId, slowUserId]]
      );
      assert.equal(tenantRefreshes.rows.find((entry) => entry.user_id === fastUserId)?.count, "1");
      assert.equal(tenantRefreshes.rows.find((entry) => entry.user_id === slowUserId), undefined);
      const slowState = await pool!.query<{ monitoring_frequency_minutes: number; next_due_at: Date; block_reason: string }>(
        `SELECT monitoring_frequency_minutes,next_due_at,block_reason
         FROM paper_agent_schedule_states WHERE user_agent_id=$1`,
        [slowUserAgentId]
      );
      assert.equal(slowState.rows[0]?.monitoring_frequency_minutes, 30);
      assert.equal(slowState.rows[0]?.next_due_at.toISOString(), slowNextDue);
      assert.equal(slowState.rows[0]?.block_reason, "NOT_DUE");
    } finally {
      await scheduler.close();
    }
  });

  it("reports advisory-lock contention instead of running a second replica", async () => {
    const provider = `scheduler-${randomUUID().replaceAll("-", "")}`;
    const lockOwner = await pool!.connect();
    const scheduler = new PostgresPaperAgentScheduler(databaseUrl!, {
      approvedMarketDataProviders: [provider],
      marketDataProviderId: provider,
      autonomousModeEnabled: false
    });
    try {
      const prior = await scheduler.runOnce();
      assert.equal(prior.lockAcquired, true);
      await lockOwner.query(`SELECT pg_advisory_lock(hashtextextended('whox:paper-agent-scheduler:v2',0))`);
      const tick = await scheduler.runOnce();
      assert.equal(tick.lockAcquired, false);
      assert.equal(tick.refreshJobsEnqueued, 0);
      assert.equal(tick.agentRunsEnqueued, 0);
      assert.equal(scheduler.health().lockContentions, 1);
      assert.equal(scheduler.health().refreshJobsEnqueued, 0);
    } finally {
      await lockOwner.query(`SELECT pg_advisory_unlock(hashtextextended('whox:paper-agent-scheduler:v2',0))`);
      lockOwner.release();
      await scheduler.close();
    }
  });

  it("exposes only the bounded scheduler function to the agent worker role", async () => {
    const provider = `scheduler-${randomUUID().replaceAll("-", "")}`;
    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE whox_agent_worker");
      const result = await client.query<{ lock_acquired: boolean }>(
        `SELECT lock_acquired
         FROM app.schedule_paper_agent_jobs($1::text[],$2::text,10,false)`,
        [[provider], provider]
      );
      assert.equal(result.rows[0]?.lock_acquired, true);
      await assert.rejects(
        client.query(`SELECT user_id FROM paper_agent_schedule_states LIMIT 1`),
        /permission denied/
      );
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
