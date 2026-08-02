import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import { Pool } from "pg";
import { hermesResearchRequestId, parseSanitizedHermesResearchArtifact } from "../src/hermes-research.js";
import { paperPlanCycleId } from "../src/plan-cycle.js";
import { PostgresPlanResearchRepository } from "../src/plan-research.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const pool = databaseUrl === undefined ? undefined : new Pool({ connectionString: databaseUrl });
after(async () => pool?.end());

describe("immutable PostgreSQL plan research", { skip: databaseUrl === undefined }, () => {
  it("freezes one public context and idempotently records one digest-bound artifact", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const planId = randomUUID();
    const catalogVersionId = randomUUID();
    const agentVersionId = "31000000-0000-4000-8000-000000000001";
    const provider = `research-${suffix}`;
    const evaluation = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    const quoteTime = new Date(evaluation.getTime() - 1_000);
    const bucket = new Date(Date.UTC(
      evaluation.getUTCFullYear(),
      evaluation.getUTCMonth(),
      evaluation.getUTCDate()
    ));
    const planCycleId = paperPlanCycleId(
      planId,
      catalogVersionId,
      agentVersionId,
      Math.floor(bucket.getTime() / 1_000),
      Math.floor(evaluation.getTime() / 1_000)
    );

    await pool!.query(
      `INSERT INTO plans(id,plan_key,display_name,product_id,features,active)
       VALUES($1,$2,'Research isolation plan',$3,$4::jsonb,false)`,
      [
        planId,
        `research-${suffix}`,
        `research.product.${suffix}`,
        JSON.stringify({
          stockTrading: true,
          optionsTrading: false,
          multiLegOptions: false,
          maximumActiveAgents: 1,
          automaticMode: false,
          monitoringFrequencyMinutes: 1440,
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
       VALUES($1,$2,1,ARRAY['AAPL','MSFT','VTI']::text[])`,
      [catalogVersionId, agentVersionId]
    );
    await pool!.query(
      `UPDATE plan_agent_catalog_versions
       SET activated_at=$2::timestamptz-interval '2 seconds' WHERE id=$1`,
      [catalogVersionId, evaluation]
    );
    await pool!.query(`UPDATE plans SET active=true WHERE id=$1`, [planId]);
    for (const symbol of ["AAPL", "MSFT", "VTI"]) {
      await pool!.query(
        `INSERT INTO market_data_snapshots(provider,symbol,data_type,payload,source_timestamp)
         VALUES($1,$2,'quote',$3::jsonb,$4)`,
        [provider, symbol, JSON.stringify({
          bid: 99,
          ask: 100,
          last: 100,
          sector: "Technology",
          marketSession: "open",
          liquiditySufficient: true,
          volatilityHalt: false,
          tradingHalt: false
        }), quoteTime]
      );
    }
    await pool!.query(
      `INSERT INTO paper_plan_cycles(
         id,plan_id,catalog_version_id,agent_version_id,plan_agent_assignment_id,
         schedule_bucket_started_at,evaluation_as_of,strategy_version
       ) VALUES($1,$2,$3,$4,$5,$6,$7,'foundation-equity-rules-1.0.0')`,
      [
        planCycleId,
        planId,
        catalogVersionId,
        agentVersionId,
        `plan-agent-assignment:${catalogVersionId}:${agentVersionId}`,
        bucket,
        evaluation
      ]
    );

    const repository = new PostgresPlanResearchRepository(databaseUrl!, provider, 60);
    try {
      const context = await repository.claimContext(planCycleId);
      assert.ok(context);
      assert.equal(context.sourceAsOf, evaluation.toISOString());
      assert.equal(context.symbols[0]?.sourceTimestamp, quoteTime.toISOString());
      assert.notEqual(context.sourceAsOf, context.symbols[0]?.sourceTimestamp);

      const requestId = hermesResearchRequestId(planCycleId);
      const requestDigest = "d".repeat(64);
      const sanitizedDecision = parseSanitizedHermesResearchArtifact({
        schemaVersion: "whox.hermes-plan-research-artifact.v1",
        requestId,
        responseId: `response-${suffix}`,
        responseCreatedAt: evaluation.toISOString(),
        receivedAt: evaluation.toISOString(),
        requestDigest,
        analysis: {
          schemaVersion: "whox.foundation-equity-research.v1",
          requestId,
          analyses: ["AAPL", "MSFT", "VTI"].map((symbol) => ({
            symbol,
            assessment: "mixed",
            summary: "Bound public-market research fixture.",
            riskFactors: [],
            dataLimitations: ["Test fixture"]
          }))
        }
      });
      const command = {
        provider: "hermes" as const,
        model: "treasury-bot" as const,
        sourceAsOf: context.sourceAsOf,
        contextDigest: context.contextDigest,
        requestDigest,
        sanitizedDecision
      };
      const artifact = await repository.saveArtifact(planCycleId, command);
      assert.deepEqual(await repository.saveArtifact(planCycleId, command), artifact);
      assert.deepEqual(await repository.findByCycle(planCycleId), artifact);
      const directRecord = async (decision: unknown): Promise<unknown> => await pool!.query(
        `SELECT * FROM app.record_paper_plan_research_artifact($1,'hermes','treasury-bot',$2,$3,$4,$5::jsonb)`,
        [planCycleId, context.sourceAsOf, context.contextDigest, requestDigest, JSON.stringify(decision)]
      );
      const overlongSummary = JSON.parse(JSON.stringify(sanitizedDecision)) as {
        analysis: { analyses: { summary: string }[] };
      };
      overlongSummary.analysis.analyses[0]!.summary = "x".repeat(241);
      await assert.rejects(directRecord(overlongSummary), /text bounds/);
      const invalidProvenance = {
        ...sanitizedDecision,
        responseId: "contains an unsafe space"
      };
      await assert.rejects(directRecord(invalidProvenance), /provenance is invalid/);
      const conflictingRequestDigest = "e".repeat(64);
      const conflictingDecision = parseSanitizedHermesResearchArtifact({
        ...sanitizedDecision,
        requestDigest: conflictingRequestDigest
      });
      await assert.rejects(
        repository.saveArtifact(planCycleId, {
          ...command,
          requestDigest: conflictingRequestDigest,
          sanitizedDecision: conflictingDecision
        }),
        /idempotency conflict/
      );
    } finally {
      try {
        await repository.close();
      } finally {
        await pool!.query("UPDATE plans SET active=false WHERE id=$1", [planId]);
      }
    }
  });

  it("rejects invalid, duplicate, unsorted, or implicit catalog research universes", async () => {
    const catalogId = randomUUID();
    const version = 100_000 + Math.floor(Math.random() * 100_000);
    await pool!.query(
      `INSERT INTO plan_agent_catalog_versions(id,plan_id,version)
       VALUES($1,'01000000-0000-4000-8000-000000000001',$2)`,
      [catalogId, version]
    );
    for (const universe of [
      ["aapl"],
      ["AAPL", "AAPL"],
      ["MSFT", "AAPL"],
      ["BRK.B", "BRK-B"]
    ]) {
      await assert.rejects(
        pool!.query(
          `INSERT INTO plan_agent_catalog_entries(catalog_version_id,agent_version_id,position,research_universe)
           VALUES($1,'31000000-0000-4000-8000-000000000001',1,$2::text[])`,
          [catalogId, universe]
        ),
        /plan_agent_research_universe_bounded/
      );
    }
    await assert.rejects(
      pool!.query(
        `INSERT INTO plan_agent_catalog_entries(catalog_version_id,agent_version_id,position)
         VALUES($1,'31000000-0000-4000-8000-000000000001',1)`,
        [catalogId]
      ),
      /research_universe/
    );
  });
});
