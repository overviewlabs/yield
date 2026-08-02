import { createHash } from "node:crypto";
import { DomainError } from "@whox/contracts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const STRATEGY_VERSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
const PLAN_CYCLE_PREFIX = "paper-plan-cycle";

export interface ScheduledPlanCycleContext {
  readonly planCycleId: string;
  readonly planId: string;
  readonly planCatalogVersionId: string;
  readonly planAgentAssignmentId: string;
  readonly agentVersionId: string;
  readonly deterministicStrategyVersion: string;
  readonly asOf: string;
  readonly researchArtifactId: string;
  readonly researchArtifactDigest: string;
}

export interface ParsedAgentRunJobPayload {
  readonly userAgentId: string;
  readonly runIdempotencyKey: string;
  readonly planCycle?: ScheduledPlanCycleContext;
}

export interface ParsedPlanResearchJobPayload {
  readonly planCycleId: string;
  readonly planId: string;
  readonly planCatalogVersionId: string;
  readonly planAgentAssignmentId: string;
  readonly agentVersionId: string;
  readonly deterministicStrategyVersion: string;
  readonly asOf: string;
}

export function planAgentAssignmentId(planCatalogVersionId: string, agentVersionId: string): string {
  return `plan-agent-assignment:${planCatalogVersionId}:${agentVersionId}`;
}

export function paperPlanCycleId(
  planId: string,
  planCatalogVersionId: string,
  agentVersionId: string,
  scheduleBucketEpoch: number,
  asOfEpoch: number
): string {
  return `${PLAN_CYCLE_PREFIX}:${planId}:${planCatalogVersionId}:${agentVersionId}:${scheduleBucketEpoch}:${asOfEpoch}`;
}

export function scheduledPlanRunIdempotencyKey(userAgentId: string, planCycleId: string): string {
  return `scheduled-paper-plan-run:${createHash("sha256").update(`${userAgentId}:${planCycleId}`).digest("hex")}`;
}

export function planResearchJobIdempotencyKey(planCycleId: string): string {
  return `paper-plan-research:${createHash("sha256").update(planCycleId).digest("hex")}`;
}

export function parsePlanResearchJobPayload(value: unknown): ParsedPlanResearchJobPayload {
  const payload = record(value);
  assertExactKeys(payload, [
    "planCycleId",
    "planId",
    "planCatalogVersionId",
    "planAgentAssignmentId",
    "agentVersionId",
    "deterministicStrategyVersion",
    "asOf"
  ]);
  const parsed = Object.freeze({
    planCycleId: requiredString(payload.planCycleId),
    planId: requiredString(payload.planId),
    planCatalogVersionId: requiredString(payload.planCatalogVersionId),
    planAgentAssignmentId: requiredString(payload.planAgentAssignmentId),
    agentVersionId: requiredString(payload.agentVersionId),
    deterministicStrategyVersion: requiredString(payload.deterministicStrategyVersion),
    asOf: requiredString(payload.asOf)
  });
  const parts = parsed.planCycleId.split(":");
  const bucketEpoch = Number(parts[4]);
  const asOfEpoch = Number(parts[5]);
  const asOfMilliseconds = Date.parse(parsed.asOf);
  if (
    !UUID_PATTERN.test(parsed.planId) ||
    !UUID_PATTERN.test(parsed.planCatalogVersionId) ||
    !UUID_PATTERN.test(parsed.agentVersionId) ||
    !STRATEGY_VERSION_PATTERN.test(parsed.deterministicStrategyVersion) ||
    parsed.planAgentAssignmentId !== planAgentAssignmentId(parsed.planCatalogVersionId, parsed.agentVersionId) ||
    parts.length !== 6 ||
    parts[0] !== PLAN_CYCLE_PREFIX ||
    parts[1] !== parsed.planId ||
    parts[2] !== parsed.planCatalogVersionId ||
    parts[3] !== parsed.agentVersionId ||
    !Number.isSafeInteger(bucketEpoch) ||
    bucketEpoch < 0 ||
    !Number.isSafeInteger(asOfEpoch) ||
    asOfEpoch < bucketEpoch ||
    !Number.isFinite(asOfMilliseconds) ||
    asOfMilliseconds % 1_000 !== 0 ||
    asOfMilliseconds / 1_000 !== asOfEpoch ||
    parsed.planCycleId !== paperPlanCycleId(
      parsed.planId,
      parsed.planCatalogVersionId,
      parsed.agentVersionId,
      bucketEpoch,
      asOfEpoch
    )
  ) {
    throw invalidPayload();
  }
  return parsed;
}

export function parseAgentRunJobPayload(value: unknown): ParsedAgentRunJobPayload {
  const payload = record(value);
  assertExactKeys(payload, ["userAgentId", "runIdempotencyKey", "planCycle"]);
  const userAgentId = requiredString(payload.userAgentId);
  const runIdempotencyKey = requiredString(payload.runIdempotencyKey);
  if (!UUID_PATTERN.test(userAgentId) || runIdempotencyKey.length < 8 || runIdempotencyKey.length > 200) {
    throw invalidPayload();
  }
  if (payload.planCycle === undefined) {
    return Object.freeze({ userAgentId, runIdempotencyKey });
  }

  const rawContext = record(payload.planCycle);
  assertExactKeys(rawContext, [
    "planCycleId",
    "planId",
    "planCatalogVersionId",
    "planAgentAssignmentId",
    "agentVersionId",
    "deterministicStrategyVersion",
    "asOf",
    "researchArtifactId",
    "researchArtifactDigest"
  ]);
  const context = Object.freeze({
    planCycleId: requiredString(rawContext.planCycleId),
    planId: requiredString(rawContext.planId),
    planCatalogVersionId: requiredString(rawContext.planCatalogVersionId),
    planAgentAssignmentId: requiredString(rawContext.planAgentAssignmentId),
    agentVersionId: requiredString(rawContext.agentVersionId),
    deterministicStrategyVersion: requiredString(rawContext.deterministicStrategyVersion),
    asOf: requiredString(rawContext.asOf),
    researchArtifactId: requiredString(rawContext.researchArtifactId),
    researchArtifactDigest: requiredString(rawContext.researchArtifactDigest)
  });
  if (
    !UUID_PATTERN.test(context.planId) ||
    !UUID_PATTERN.test(context.planCatalogVersionId) ||
    !UUID_PATTERN.test(context.agentVersionId) ||
    !UUID_PATTERN.test(context.researchArtifactId) ||
    !DIGEST_PATTERN.test(context.researchArtifactDigest) ||
    !STRATEGY_VERSION_PATTERN.test(context.deterministicStrategyVersion) ||
    !Number.isFinite(Date.parse(context.asOf)) ||
    context.planAgentAssignmentId !== planAgentAssignmentId(context.planCatalogVersionId, context.agentVersionId)
  ) {
    throw invalidPayload();
  }
  const parts = context.planCycleId.split(":");
  const bucketEpoch = Number(parts[4]);
  const asOfEpoch = Number(parts[5]);
  const asOfMilliseconds = Date.parse(context.asOf);
  if (
    parts.length !== 6 ||
    parts[0] !== PLAN_CYCLE_PREFIX ||
    parts[1] !== context.planId ||
    parts[2] !== context.planCatalogVersionId ||
    parts[3] !== context.agentVersionId ||
    !Number.isSafeInteger(bucketEpoch) ||
    bucketEpoch < 0 ||
    !Number.isSafeInteger(asOfEpoch) ||
    asOfEpoch < bucketEpoch ||
    asOfMilliseconds % 1_000 !== 0 ||
    asOfMilliseconds / 1_000 !== asOfEpoch ||
    context.planCycleId !== paperPlanCycleId(
      context.planId,
      context.planCatalogVersionId,
      context.agentVersionId,
      bucketEpoch,
      asOfEpoch
    )
  ) {
    throw invalidPayload();
  }
  if (runIdempotencyKey !== scheduledPlanRunIdempotencyKey(userAgentId, context.planCycleId)) throw invalidPayload();
  return Object.freeze({ userAgentId, runIdempotencyKey, planCycle: context });
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidPayload();
  return value as Readonly<Record<string, unknown>>;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw invalidPayload();
  return value;
}

function assertExactKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) throw invalidPayload();
}

function invalidPayload(): DomainError {
  return new DomainError(
    "AGENT_JOB_PAYLOAD_INVALID",
    "The tenant-bound agent run payload or its plan-cycle research reference is invalid",
    422
  );
}
