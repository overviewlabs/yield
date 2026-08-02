import { DomainError } from "@whox/contracts";
import {
  createSanitizedHermesResearchArtifact,
  hermesResearchRequestId,
  type FoundationEquityResearchProvider
} from "./hermes-research.js";
import { parsePlanResearchJobPayload } from "./plan-cycle.js";
import type {
  PlanResearchArtifact,
  PlanResearchContext,
  SavePlanResearchArtifactCommand
} from "./plan-research.js";

export interface PlanResearchArtifactRepository {
  findByCycle(planCycleId: string): Promise<PlanResearchArtifact | undefined>;
  claimContext(planCycleId: string): Promise<PlanResearchContext | undefined>;
  saveArtifact(planCycleId: string, command: SavePlanResearchArtifactCommand): Promise<PlanResearchArtifact>;
}

/**
 * Produces one shared, sanitized Hermes artifact for a canonical plan cycle.
 * Tenant jobs only reference the resulting immutable artifact and never invoke
 * Hermes themselves.
 */
export class PlanCycleResearchService {
  public constructor(
    private readonly provider: FoundationEquityResearchProvider,
    private readonly repository: PlanResearchArtifactRepository
  ) {}

  public async process(value: unknown): Promise<PlanResearchArtifact> {
    const payload = parsePlanResearchJobPayload(value);
    const existing = await this.repository.findByCycle(payload.planCycleId);
    if (existing !== undefined) return existing;

    const context = await this.repository.claimContext(payload.planCycleId);
    if (context === undefined) {
      throw new DomainError(
        "PLAN_RESEARCH_CONTEXT_UNAVAILABLE",
        "The bounded public-market plan context is not ready",
        503
      );
    }
    assertContextMatchesJob(context, payload);
    if (context.agentKey !== "foundation-equity" || context.agentVersion !== "1.0.0") {
      throw new DomainError(
        "DETERMINISTIC_STRATEGY_UNIMPLEMENTED",
        "Hermes research is composed only for Foundation Equity v1",
        503
      );
    }

    const requestId = hermesResearchRequestId(context.planCycleId);
    const result = await this.provider.research(Object.freeze({
      requestId,
      planCycleId: context.planCycleId,
      planId: context.planId,
      planCatalogVersionId: context.planCatalogVersionId,
      agentVersionId: context.agentVersionId,
      agentKey: "foundation-equity",
      agentVersion: "1.0.0",
      deterministicStrategyVersion: context.deterministicStrategyVersion,
      sourceAsOf: context.sourceAsOf,
      contextDigest: context.contextDigest,
      symbols: context.symbols
    }));
    if (
      result.provider !== "hermes" ||
      result.model !== "treasury-bot" ||
      result.requestId !== requestId ||
      result.contextDigest !== context.contextDigest
    ) {
      throw new DomainError("PLAN_RESEARCH_ARTIFACT_INVALID", "Hermes research context provenance changed", 500);
    }
    const artifact = await this.repository.saveArtifact(context.planCycleId, Object.freeze({
      provider: "hermes",
      model: "treasury-bot",
      sourceAsOf: context.sourceAsOf,
      contextDigest: context.contextDigest,
      requestDigest: result.requestDigest,
      sanitizedDecision: createSanitizedHermesResearchArtifact(result)
    }));
    if (
      artifact.planCycleId !== context.planCycleId ||
      artifact.provider !== "hermes" ||
      artifact.model !== "treasury-bot" ||
      artifact.sourceAsOf !== context.sourceAsOf ||
      artifact.contextDigest !== context.contextDigest ||
      artifact.requestDigest !== result.requestDigest
    ) {
      throw new DomainError("PLAN_RESEARCH_ARTIFACT_INVALID", "Recorded Hermes research provenance changed", 500);
    }
    return artifact;
  }
}

function assertContextMatchesJob(
  context: PlanResearchContext,
  payload: ReturnType<typeof parsePlanResearchJobPayload>
): void {
  if (
    context.planCycleId !== payload.planCycleId ||
    context.planId !== payload.planId ||
    context.planCatalogVersionId !== payload.planCatalogVersionId ||
    context.planAgentAssignmentId !== payload.planAgentAssignmentId ||
    context.agentVersionId !== payload.agentVersionId ||
    context.deterministicStrategyVersion !== payload.deterministicStrategyVersion ||
    context.asOf !== payload.asOf
  ) {
    throw new DomainError("PLAN_RESEARCH_CONTEXT_UNAVAILABLE", "Plan research context does not match its job", 503);
  }
}
