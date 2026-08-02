import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import { Pool } from "pg";
import {
  PostgresAgentPipeline,
  PostgresPlanResearchRepository,
  hermesResearchRequestId,
  paperPlanCycleId,
  planAgentAssignmentId,
  scheduledPlanRunIdempotencyKey,
  type SanitizedHermesResearchArtifact
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const pool = databaseUrl === undefined ? undefined : new Pool({ connectionString: databaseUrl });
after(async () => pool?.end());

const gates = {
  LIVE_TRADING_ENABLED: false,
  ROBINHOOD_PRODUCTION_APPROVED: false,
  LEGAL_DOCUMENTS_APPROVED: false,
  ADVISORY_COMPLIANCE_APPROVED: false,
  APP_STORE_FINANCIAL_ENTITY_APPROVED: false,
  OPTIONS_LIVE_TRADING_ENABLED: false,
  AUTONOMOUS_MODE_ENABLED: false
} as const;

const limits = {
  maximumAccountAllocation: 0.8,
  maximumPositionAmount: 5_000,
  maximumNewOrderAmount: 2_000,
  maximumDailyLoss: 500,
  maximumPortfolioDrawdown: 0.1,
  minimumBuyingPowerReserve: 0.1,
  maximumSimultaneousPositions: 10,
  maximumSymbolConcentration: 0.2,
  maximumSectorConcentration: 0.4,
  maximumTradesPerDay: 10,
  maximumDailyTurnover: 0.5,
  maximumOptionsExposure: 0.1,
  maximumOptionRiskPerTrade: 500,
  maximumContractsPerTrade: 2,
  minimumDaysToExpiration: 14,
  maximumDaysToExpiration: 180,
  maximumBidAskSpreadRatio: 0.08,
  maximumQuoteAgeSeconds: 30,
  maximumAccountSnapshotAgeSeconds: 60,
  maximumPriceDeviationRatio: 0.03
};

const exclusions = {
  excludedSymbols: [],
  excludedSectors: [],
  fractionalSharesPermitted: true,
  extendedHoursPermitted: false,
  earningsTradesPermitted: false,
  coveredCallsPermitted: false,
  protectivePutsPermitted: false,
  definedRiskSpreadsPermitted: false
};

describe("persistent deterministic Paper agent pipeline", { skip: databaseUrl === undefined }, () => {
  it("atomically persists a reviewed proposal and fails closed when authoritative market context is absent", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const userId = randomUUID();
    const userAgentId = randomUUID();
    const connectionId = randomUUID();
    const accountId = randomUUID();
    const configurationId = randomUUID();
    const portfolioId = randomUUID();
    const provider = `pipeline-test-${suffix}`;
    const instantOffsetSeconds = Number(BigInt(`0x${suffix.slice(0, 12)}`) % 200_000_000_000n);
    const nowInstant = Date.UTC(2090, 0, 2, 15) + instantOffsetSeconds * 1_000;
    const now = new Date(nowInstant).toISOString();
    const before = new Date(nowInstant - 1_000).toISOString();
    const planId = "01000000-0000-4000-8000-000000000001";
    const catalogVersionId = "32000000-0000-4000-8000-000000000001";
    const agentVersionId = "31000000-0000-4000-8000-000000000001";
    const strategyVersion = "foundation-equity-rules-1.0.0";

    await pool!.query(
      `INSERT INTO users(id,status,account_mode,onboarding_step) VALUES($1,'active','paper',14)`,
      [userId]
    );
    await pool!.query(
      `INSERT INTO eligibility_profiles(
         user_id,country,region,age_eligible,own_individual_account,understands_not_bank_or_broker,
         adviser_client_classification,eligibility_status,assessment_version,assessed_at
       ) VALUES($1,'US','NY',true,true,true,'self_directed','eligible','pipeline-v1',$2::timestamptz)`,
      [userId, before]
    );
    await pool!.query(
      `INSERT INTO risk_assessments(
         user_id,classification,options_classification,score,factors,rationale,scoring_version,explanation,completed_at
       ) VALUES($1,'growth','options_restricted',1,'[]'::jsonb,'[]'::jsonb,'pipeline-v1','Pipeline fixture',$2::timestamptz)`,
      [userId, before]
    );
    await pool!.query(
      `INSERT INTO subscriptions(user_id,plan_id,original_transaction_id,status,environment,effective_at)
       VALUES($1,$2,$3,'active','sandbox',$4::timestamptz)`,
      [userId, planId, `pipeline-subscription-${suffix}`, before]
    );
    await pool!.query(
      `INSERT INTO broker_connections(id,user_id,provider,status,connected_at,last_sync_at)
       VALUES($1,$2,'robinhood_mcp','connected',$3::timestamptz,$3::timestamptz)`,
      [connectionId, userId, now]
    );
    await pool!.query(
      `INSERT INTO broker_accounts(id,connection_id,user_id,opaque_broker_id,account_type,is_agentic_account,verified_for_trading_at,active)
       VALUES($1,$2,$3,$4,'individual',true,$5::timestamptz,true)`,
      [accountId, connectionId, userId, `pipeline-account-${suffix}`, before]
    );
    for (const capability of ["get_equity_quotes", "get_equity_tradability", "review_equity_order"]) {
      await pool!.query(
        `INSERT INTO broker_capabilities(connection_id,tool_name,input_schema,protocol_version,discovered_at,last_seen_at)
         VALUES($1,$2,'{}'::jsonb,'2026-11-25',$3::timestamptz,$3::timestamptz)`,
        [connectionId, capability, now]
      );
    }
    await pool!.query(
      `INSERT INTO user_agents(id,user_id,agent_version_id,status,environment,allocation_limit,approval_mode)
       VALUES($1,$2,$3,'monitoring','paper',0.4,'confirm_every_trade')`,
      [userAgentId, userId, agentVersionId]
    );
    await pool!.query(
      `INSERT INTO agent_configurations(id,user_agent_id,user_id,version,configuration,effective_at)
       VALUES($1,$2,$3,1,$4::jsonb,$5::timestamptz)`,
      [configurationId, userAgentId, userId, JSON.stringify({ symbol: "AAPL", targetOrderAmount: 1_000 }), before]
    );
    await pool!.query(
      `INSERT INTO risk_policies(user_id,version,limits,exclusions,effective_at)
       VALUES($1,1,$2::jsonb,$3::jsonb,$4::timestamptz)`,
      [userId, JSON.stringify(limits), JSON.stringify(exclusions), before]
    );
    await pool!.query(
      `INSERT INTO portfolio_snapshots(
         id,user_id,broker_account_id,environment,total_value,buying_power,cash_value,
         source_timestamp,valid_until,data_classification
       ) VALUES($1,$2,$3,'paper',10000,5000,5000,$4::timestamptz,$4::timestamptz+interval '5 minutes','paper')`,
      [portfolioId, userId, accountId, now]
    );
    await pool!.query(
      `INSERT INTO broker_sync_runs(
         user_id,connection_id,portfolio_snapshot_id,idempotency_key,snapshot_fingerprint,source_timestamp,completed_at
       ) VALUES($1,$2,$3,$4,$5,$6::timestamptz,$6::timestamptz)`,
      [userId, connectionId, portfolioId, `pipeline-sync-${suffix}`, "e".repeat(64), now]
    );
    for (const [symbol, price] of [["AAPL", 100], ["MSFT", 200], ["VTI", 250]] as const) {
      const quote = {
        symbol,
        bid: price - 0.5,
        ask: price,
        last: price,
        tradable: true,
        fractionalSupported: true,
        liquiditySufficient: true,
        marketSession: "open",
        volatilityHalt: false,
        tradingHalt: false,
        corporateActionRestricted: false,
        earningsWindow: false,
        sector: symbol === "VTI" ? "Diversified" : "Technology",
        brokerWarningSeverity: "none"
      };
      await pool!.query(
        `INSERT INTO market_data_snapshots(provider,symbol,data_type,payload,source_timestamp)
         VALUES($1,$2,'quote',$3::jsonb,$4::timestamptz)`,
        [provider, symbol, JSON.stringify(quote), now]
      );
    }
    for (const [index, key] of ["terms", "privacy", "ai-risk"].entries()) {
      const documentId = randomUUID();
      await pool!.query(
        `INSERT INTO legal_documents(id,document_key,version,title,content_uri,content_sha256,production_approved,published_at)
         VALUES($1,$2,$3,$4,$5,$6,true,$7::timestamptz)`,
        [documentId, key, `pipeline-${suffix}`, `${key} test`, `https://legal.invalid/${key}/${suffix}`, String(index + 1).repeat(64), before]
      );
      await pool!.query(
        `INSERT INTO legal_consents(user_id,legal_document_id,accepted_at) VALUES($1,$2,$3::timestamptz)`,
        [userId, documentId, before]
      );
    }

    const researchRepository = new PostgresPlanResearchRepository(databaseUrl!, provider);
    const epoch = Date.parse(now) / 1_000;
    const createPlanCycle = async (bucketOffsetSeconds: number) => {
      const bucketEpoch = epoch - bucketOffsetSeconds;
      const planCycleId = paperPlanCycleId(planId, catalogVersionId, agentVersionId, bucketEpoch, epoch);
      await pool!.query(
        `INSERT INTO paper_plan_cycles(
           id,plan_id,catalog_version_id,agent_version_id,plan_agent_assignment_id,
           schedule_bucket_started_at,evaluation_as_of,strategy_version
         ) VALUES($1,$2,$3,$4,$5,to_timestamp($6),$7::timestamptz,$8)`,
        [
          planCycleId,
          planId,
          catalogVersionId,
          agentVersionId,
          planAgentAssignmentId(catalogVersionId, agentVersionId),
          bucketEpoch,
          now,
          strategyVersion
        ]
      );
      const researchContext = await researchRepository.claimContext(planCycleId);
      assert.ok(researchContext);
      assert.equal(researchContext.sourceAsOf, now);
      assert.equal(researchContext.symbols[0]?.sourceTimestamp, now);
      assert.deepEqual(researchContext.symbols.map((entry) => entry.symbol), ["AAPL", "MSFT", "VTI"]);
      const requestId = hermesResearchRequestId(planCycleId);
      const requestDigest = "f".repeat(64);
      const sanitizedDecision: SanitizedHermesResearchArtifact = Object.freeze({
        schemaVersion: "whox.hermes-plan-research-artifact.v1",
        requestId,
        responseId: `chatcmpl-${suffix}-${bucketOffsetSeconds}`,
        responseCreatedAt: now,
        receivedAt: now,
        requestDigest,
        analysis: Object.freeze({
          schemaVersion: "whox.foundation-equity-research.v1",
          requestId,
          analyses: Object.freeze(researchContext.symbols.map(({ symbol }) => Object.freeze({
            symbol,
            assessment: "cautionary" as const,
            summary: "Research remains advisory while deterministic controls evaluate this configured symbol.",
            riskFactors: Object.freeze(["Public market conditions may change."]),
            dataLimitations: Object.freeze(["No tenant financial data was supplied."])
          })))
        })
      });
      const researchArtifact = await researchRepository.saveArtifact(planCycleId, {
        provider: "hermes",
        model: "treasury-bot",
        sourceAsOf: researchContext.sourceAsOf,
        contextDigest: researchContext.contextDigest,
        requestDigest,
        sanitizedDecision
      });
      return Object.freeze({
        planCycleId,
        planId,
        planCatalogVersionId: catalogVersionId,
        planAgentAssignmentId: planAgentAssignmentId(catalogVersionId, agentVersionId),
        agentVersionId,
        deterministicStrategyVersion: strategyVersion,
        asOf: now,
        researchArtifactId: researchArtifact.id,
        researchArtifactDigest: researchArtifact.decisionDigest
      });
    };
    const planCycle = await createPlanCycle(0);

    const pipeline = new PostgresAgentPipeline(databaseUrl!, {
      mode: "paper",
      approvedMarketDataProviders: [provider],
      releaseGates: gates,
      clock: () => now
    });
    try {
      const command = {
        userId,
        userAgentId,
        runIdempotencyKey: scheduledPlanRunIdempotencyKey(userAgentId, planCycle.planCycleId),
        correlationId: `pipeline-correlation-${suffix}`,
        planCycle
      };
      const result = await pipeline.run(command);
      assert.equal(result.status, "completed");
      assert.equal(result.proposalStatus, "AWAITING_USER_APPROVAL");
      assert.ok(result.proposalId);

      const graph = await pool!.query<{
        status: string;
        proposal_status: string;
        approval_status: string;
        reservations: string;
        risk_failures: string;
        notifications: string;
        proposal_payload: unknown;
        rationale: unknown;
      }>(
        `SELECT run.status,proposal.status AS proposal_status,approval.status AS approval_status,
           proposal.proposal AS proposal_payload,candidate.structured_rationale AS rationale,
           (SELECT count(*)::text FROM capital_reservations WHERE proposal_id=proposal.id AND released_at IS NULL) AS reservations,
           (SELECT count(*)::text FROM risk_checks WHERE proposal_id=proposal.id AND NOT passed AND severity='blocking') AS risk_failures,
           (SELECT count(*)::text FROM queue_jobs WHERE queue_name='notifications' AND user_id=$1 AND payload->>'notificationIdempotencyKey'=$3) AS notifications
         FROM agent_runs AS run JOIN trade_proposals AS proposal ON proposal.agent_run_id=run.id
         JOIN agent_run_candidates AS candidate ON candidate.agent_run_id=run.id
         JOIN approval_requests AS approval ON approval.proposal_id=proposal.id
         WHERE run.id=$2`,
        [userId, result.runId, `proposal-ready:${result.proposalId}`]
      );
      assert.deepEqual(graph.rows[0], {
        status: "completed",
        proposal_status: "AWAITING_USER_APPROVAL",
        approval_status: "pending",
        reservations: "1",
        risk_failures: "0",
        notifications: "1",
        proposal_payload: graph.rows[0]!.proposal_payload,
        rationale: graph.rows[0]!.rationale
      });
      const proposalPayload = graph.rows[0]!.proposal_payload as Readonly<Record<string, unknown>>;
      assert.equal(proposalPayload.symbol, "AAPL");
      assert.equal(proposalPayload.side, "buy");
      assert.equal(proposalPayload.quantity, 10);
      assert.equal(proposalPayload.notionalEstimate, 1_000);
      assert.equal(proposalPayload.orderType, "limit");
      assert.equal(proposalPayload.limitPrice, 100);
      const rationale = graph.rows[0]!.rationale as {
        deterministic: boolean;
        hermesResearch: { authority: string; assessment: string; symbol: string };
      };
      assert.equal(rationale.deterministic, true);
      assert.equal(rationale.hermesResearch.authority, "research_only");
      assert.equal(rationale.hermesResearch.assessment, "cautionary");
      assert.equal(rationale.hermesResearch.symbol, "AAPL");
      const events = await pool!.query<{ to_status: string }>(
        `SELECT to_status FROM trade_proposal_events WHERE proposal_id=$1 ORDER BY occurred_at,id`,
        [result.proposalId]
      );
      assert.deepEqual(events.rows.map((row) => row.to_status), [
        "ANALYZED",
        "SCHEMA_VALIDATED",
        "RISK_CHECKED",
        "BROKER_REVIEWED",
        "AWAITING_USER_APPROVAL"
      ]);
      assert.deepEqual(await pipeline.run(command), result);

      await pool!.query(
        `UPDATE broker_connections SET revoked_at=$2::timestamptz WHERE id=$1 AND status='connected'`,
        [connectionId, now]
      );
      const revokedConnectionPlanCycle = await createPlanCycle(10);
      const revokedConnection = await pipeline.run({
        ...command,
        planCycle: revokedConnectionPlanCycle,
        runIdempotencyKey: scheduledPlanRunIdempotencyKey(userAgentId, revokedConnectionPlanCycle.planCycleId)
      });
      assert.equal(revokedConnection.status, "failed");
      assert.equal(revokedConnection.errorCode, "AGENTIC_ACCOUNT_BINDING_INVALID");
      await pool!.query(`UPDATE broker_connections SET revoked_at=NULL WHERE id=$1`, [connectionId]);

      await pool!.query(
        `UPDATE eligibility_profiles SET eligibility_status='ineligible'
         WHERE user_id=$1 AND superseded_at IS NULL`,
        [userId]
      );
      const ineligiblePlanCycle = await createPlanCycle(1);
      const ineligible = await pipeline.run({
        ...command,
        planCycle: ineligiblePlanCycle,
        runIdempotencyKey: scheduledPlanRunIdempotencyKey(userAgentId, ineligiblePlanCycle.planCycleId)
      });
      assert.equal(ineligible.status, "failed");
      assert.equal(ineligible.errorCode, "CURRENT_ELIGIBILITY_REQUIRED");
      await pool!.query(
        `UPDATE eligibility_profiles SET eligibility_status='eligible'
         WHERE user_id=$1 AND superseded_at IS NULL`,
        [userId]
      );

      const malformedPositionId = `missing-sector-${suffix}`;
      await pool!.query(
        `INSERT INTO position_snapshots(
           portfolio_snapshot_id,user_id,broker_position_id,symbol,instrument_type,quantity,average_cost,market_value,details
         ) VALUES($1,$2,$3,'AAPL','equity',1,100,100,'{}'::jsonb)`,
        [portfolioId, userId, malformedPositionId]
      );
      const missingSectorPlanCycle = await createPlanCycle(2);
      const missingSector = await pipeline.run({
        ...command,
        planCycle: missingSectorPlanCycle,
        runIdempotencyKey: scheduledPlanRunIdempotencyKey(userAgentId, missingSectorPlanCycle.planCycleId)
      });
      assert.equal(missingSector.status, "failed");
      assert.equal(missingSector.errorCode, "AUTHORITATIVE_ACCOUNT_SNAPSHOT_REQUIRED");
      await pool!.query(
        `DELETE FROM position_snapshots WHERE portfolio_snapshot_id=$1 AND user_id=$2 AND broker_position_id=$3`,
        [portfolioId, userId, malformedPositionId]
      );

      await pool!.query(
        `UPDATE risk_policies
         SET limits=jsonb_set(limits,'{maximumQuoteAgeSeconds}','31'::jsonb)
         WHERE user_id=$1 AND superseded_at IS NULL`,
        [userId]
      );
      const unsafePolicyPlanCycle = await createPlanCycle(3);
      const unsafePolicy = await pipeline.run({
        ...command,
        planCycle: unsafePolicyPlanCycle,
        runIdempotencyKey: scheduledPlanRunIdempotencyKey(userAgentId, unsafePolicyPlanCycle.planCycleId)
      });
      assert.equal(unsafePolicy.status, "failed");
      assert.equal(unsafePolicy.errorCode, "PERSISTED_RISK_POLICY_INVALID");
      await pool!.query(
        `UPDATE risk_policies
         SET limits=jsonb_set(limits,'{maximumQuoteAgeSeconds}','30'::jsonb)
         WHERE user_id=$1 AND superseded_at IS NULL`,
        [userId]
      );

      await pool!.query(
        `UPDATE agent_configurations SET superseded_at=$2::timestamptz WHERE id=$1`,
        [configurationId, now]
      );
      await pool!.query(
        `INSERT INTO agent_configurations(user_agent_id,user_id,version,configuration,effective_at)
         VALUES($1,$2,2,$3::jsonb,$4::timestamptz)`,
        [userAgentId, userId, JSON.stringify({ symbol: "MSFT", targetOrderAmount: 1_000 }), now]
      );
      const noMarketPlanCycle = await createPlanCycle(4);
      await pool!.query(
        `DELETE FROM market_data_snapshots WHERE provider=$1 AND symbol='MSFT'`,
        [provider]
      );
      const failed = await pipeline.run({
        ...command,
        planCycle: noMarketPlanCycle,
        runIdempotencyKey: scheduledPlanRunIdempotencyKey(userAgentId, noMarketPlanCycle.planCycleId)
      });
      assert.equal(failed.status, "failed");
      assert.equal(failed.errorCode, "AUTHORITATIVE_MARKET_CONTEXT_REQUIRED");
      const failedGraph = await pool!.query<{ status: string; error_code: string; proposals: string }>(
        `SELECT status,error_code,
           (SELECT count(*)::text FROM trade_proposals WHERE agent_run_id=agent_runs.id) AS proposals
         FROM agent_runs WHERE id=$1`,
        [failed.runId]
      );
      assert.deepEqual(failedGraph.rows[0], {
        status: "failed",
        error_code: "AUTHORITATIVE_MARKET_CONTEXT_REQUIRED",
        proposals: "0"
      });
    } finally {
      await pipeline.close();
      await researchRepository.close();
    }
  });
});
