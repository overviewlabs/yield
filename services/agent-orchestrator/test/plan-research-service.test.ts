import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PlanCycleResearchService,
  createSanitizedHermesResearchArtifact,
  hermesResearchRequestId,
  planAgentAssignmentId,
  type FoundationEquityResearchProvider,
  type FoundationEquityResearchRequest,
  type FoundationEquityResearchResult,
  type PlanResearchArtifact,
  type PlanResearchArtifactRepository,
  type PlanResearchContext,
  type SavePlanResearchArtifactCommand
} from "../src/index.js";

const asOf = "2026-08-01T18:00:00.000Z";
const epoch = Date.parse(asOf) / 1_000;
const planId = "11000000-0000-4000-8000-000000000001";
const catalogId = "21000000-0000-4000-8000-000000000001";
const agentVersionId = "31000000-0000-4000-8000-000000000001";
const planCycleId = `paper-plan-cycle:${planId}:${catalogId}:${agentVersionId}:${epoch}:${epoch}`;
const contextDigest = "c".repeat(64);

const payload = Object.freeze({
  planCycleId,
  planId,
  planCatalogVersionId: catalogId,
  planAgentAssignmentId: planAgentAssignmentId(catalogId, agentVersionId),
  agentVersionId,
  deterministicStrategyVersion: "foundation-equity-v1",
  asOf
});

const context: PlanResearchContext = Object.freeze({
  ...payload,
  planKey: "foundation",
  agentKey: "foundation-equity",
  agentVersion: "1.0.0",
  sourceAsOf: asOf,
  contextDigest,
  symbols: Object.freeze([Object.freeze({
    symbol: "AAPL",
    sector: "Technology",
    bid: 199.5,
    ask: 200,
    last: 199.8,
    sourceTimestamp: "2026-08-01T17:59:30.000Z",
    marketSession: "open" as const,
    liquiditySufficient: true,
    volatilityHalt: false,
    tradingHalt: false
  })])
});

class MemoryResearchRepository implements PlanResearchArtifactRepository {
  public stored: PlanResearchArtifact | undefined;
  public saves = 0;

  public constructor(private readonly contextValue: PlanResearchContext | undefined) {}

  public async findByCycle(cycleId: string): Promise<PlanResearchArtifact | undefined> {
    return this.stored?.planCycleId === cycleId ? this.stored : undefined;
  }

  public async claimContext(cycleId: string): Promise<PlanResearchContext | undefined> {
    return this.contextValue?.planCycleId === cycleId ? this.contextValue : undefined;
  }

  public async saveArtifact(
    cycleId: string,
    command: SavePlanResearchArtifactCommand
  ): Promise<PlanResearchArtifact> {
    this.saves += 1;
    this.stored = Object.freeze({
      id: "51000000-0000-4000-8000-000000000001",
      planCycleId: cycleId,
      provider: command.provider,
      model: command.model,
      sourceAsOf: command.sourceAsOf,
      contextDigest: command.contextDigest,
      requestDigest: command.requestDigest,
      decisionDigest: "d".repeat(64),
      sanitizedDecision: command.sanitizedDecision,
      createdAt: asOf
    });
    return this.stored;
  }
}

class CapturingResearchProvider implements FoundationEquityResearchProvider {
  public calls = 0;
  public request: FoundationEquityResearchRequest | undefined;

  public async research(request: FoundationEquityResearchRequest): Promise<FoundationEquityResearchResult> {
    this.calls += 1;
    this.request = request;
    return Object.freeze({
      provider: "hermes",
      model: "treasury-bot",
      requestId: request.requestId,
      responseId: "chatcmpl-plan-cycle-1",
      responseCreatedAt: asOf,
      receivedAt: asOf,
      contextDigest: request.contextDigest,
      requestDigest: "e".repeat(64),
      analysis: Object.freeze({
        schemaVersion: "whox.foundation-equity-research.v1",
        requestId: request.requestId,
        analyses: Object.freeze(request.symbols.map((quote) => Object.freeze({
          symbol: quote.symbol,
          assessment: "cautionary" as const,
          summary: "Public-market research is advisory and warrants deterministic review.",
          riskFactors: Object.freeze(["Conditions may change."]),
          dataLimitations: Object.freeze(["No tenant or account data was evaluated."])
        })))
      })
    });
  }
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean =>
    typeof error === "object" && error !== null && "code" in error && error.code === code;
}

describe("shared plan-cycle Hermes research", () => {
  it("calls Hermes once and reuses one immutable artifact for subsequent fan-out", async () => {
    const provider = new CapturingResearchProvider();
    const repository = new MemoryResearchRepository(context);
    const service = new PlanCycleResearchService(provider, repository);

    const first = await service.process(payload);
    const replay = await service.process(payload);

    assert.deepEqual(replay, first);
    assert.equal(provider.calls, 1);
    assert.equal(repository.saves, 1);
    assert.equal(provider.request?.requestId, hermesResearchRequestId(planCycleId));
    assert.equal(provider.request?.contextDigest, contextDigest);
    assert.deepEqual(provider.request?.symbols.map((quote) => quote.symbol), ["AAPL"]);
    assert.equal(provider.request?.sourceAsOf, asOf);
    assert.equal(provider.request?.symbols[0]?.sourceTimestamp, "2026-08-01T17:59:30.000Z");
    assert.equal(Object.hasOwn(provider.request ?? {}, "userId"), false);
    assert.equal(Object.hasOwn(provider.request ?? {}, "accountId"), false);
    assert.equal(first.sanitizedDecision.analysis.analyses[0]?.assessment, "cautionary");
    assert.deepEqual(first.sanitizedDecision, createSanitizedHermesResearchArtifact({
      provider: "hermes",
      model: "treasury-bot",
      requestId: hermesResearchRequestId(planCycleId),
      responseId: "chatcmpl-plan-cycle-1",
      responseCreatedAt: asOf,
      receivedAt: asOf,
      contextDigest,
      requestDigest: "e".repeat(64),
      analysis: first.sanitizedDecision.analysis
    }));
  });

  it("fails before Hermes when shared context is unavailable or mismatched", async () => {
    const missingProvider = new CapturingResearchProvider();
    await assert.rejects(
      new PlanCycleResearchService(missingProvider, new MemoryResearchRepository(undefined)).process(payload),
      hasCode("PLAN_RESEARCH_CONTEXT_UNAVAILABLE")
    );
    assert.equal(missingProvider.calls, 0);

    const mismatchedProvider = new CapturingResearchProvider();
    const mismatched = Object.freeze({ ...context, deterministicStrategyVersion: "different-v1" });
    await assert.rejects(
      new PlanCycleResearchService(mismatchedProvider, new MemoryResearchRepository(mismatched)).process(payload),
      hasCode("PLAN_RESEARCH_CONTEXT_UNAVAILABLE")
    );
    assert.equal(mismatchedProvider.calls, 0);
  });
});
