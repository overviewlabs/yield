import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  paperPlanCycleId,
  parseAgentRunJobPayload,
  parsePlanResearchJobPayload,
  planAgentAssignmentId,
  scheduledPlanRunIdempotencyKey
} from "../src/plan-cycle.js";

const planId = "01000000-0000-4000-8000-000000000001";
const catalogVersionId = "02000000-0000-4000-8000-000000000001";
const agentVersionId = "31000000-0000-4000-8000-000000000001";
const userAgentId = "60000000-0000-4000-8000-000000000001";
const researchArtifactId = "51000000-0000-4000-8000-000000000001";

describe("plan-cycle job boundary", () => {
  it("accepts a digest-bound non-secret research reference", () => {
    const planCycleId = paperPlanCycleId(
      planId,
      catalogVersionId,
      agentVersionId,
      1_785_542_400,
      1_785_592_800
    );
    const payload = parseAgentRunJobPayload({
      userAgentId,
      runIdempotencyKey: scheduledPlanRunIdempotencyKey(userAgentId, planCycleId),
      planCycle: {
        planCycleId,
        planId,
        planCatalogVersionId: catalogVersionId,
        planAgentAssignmentId: planAgentAssignmentId(catalogVersionId, agentVersionId),
        agentVersionId,
        deterministicStrategyVersion: "foundation-equity-rules-1.0.0",
        asOf: "2026-08-01T14:00:00.000Z",
        researchArtifactId,
        researchArtifactDigest: "a".repeat(64)
      }
    });
    assert.equal(payload.planCycle?.researchArtifactId, researchArtifactId);
    assert.equal(Object.hasOwn(payload.planCycle ?? {}, "brokerToken"), false);
  });

  it("rejects a mismatched assignment, malformed digest, or partial context", () => {
    const base = {
      userAgentId,
      runIdempotencyKey: "placeholder",
      planCycle: {
        planCycleId: paperPlanCycleId(
          planId,
          catalogVersionId,
          agentVersionId,
          1_785_542_400,
          1_785_592_800
        ),
        planId,
        planCatalogVersionId: catalogVersionId,
        planAgentAssignmentId: planAgentAssignmentId(catalogVersionId, agentVersionId),
        agentVersionId,
        deterministicStrategyVersion: "foundation-equity-rules-1.0.0",
        asOf: "2026-08-01T14:00:00.000Z",
        researchArtifactId,
        researchArtifactDigest: "a".repeat(64)
      }
    };
    base.runIdempotencyKey = scheduledPlanRunIdempotencyKey(userAgentId, base.planCycle.planCycleId);
    assert.throws(
      () => parseAgentRunJobPayload({ ...base, planCycle: { ...base.planCycle, planAgentAssignmentId: "tampered" } }),
      /plan-cycle research reference is invalid/
    );
    assert.throws(
      () => parseAgentRunJobPayload({ ...base, planCycle: { ...base.planCycle, researchArtifactDigest: "nope" } }),
      /plan-cycle research reference is invalid/
    );
    assert.throws(
      () => parseAgentRunJobPayload({ userAgentId, runIdempotencyKey: base.runIdempotencyKey, planCycle: { planId } }),
      /plan-cycle research reference is invalid/
    );
    assert.throws(
      () => parseAgentRunJobPayload({ ...base, brokerToken: "must-never-pass" }),
      /plan-cycle research reference is invalid/
    );
    assert.throws(
      () => parseAgentRunJobPayload({ ...base, runIdempotencyKey: "scheduled-paper-plan-run:tampered" }),
      /plan-cycle research reference is invalid/
    );
  });

  it("strictly validates a singleton non-tenant research job", () => {
    const planCycleId = paperPlanCycleId(
      planId,
      catalogVersionId,
      agentVersionId,
      1_785_542_400,
      1_785_592_800
    );
    const payload = parsePlanResearchJobPayload({
      planCycleId,
      planId,
      planCatalogVersionId: catalogVersionId,
      planAgentAssignmentId: planAgentAssignmentId(catalogVersionId, agentVersionId),
      agentVersionId,
      deterministicStrategyVersion: "foundation-equity-rules-1.0.0",
      asOf: "2026-08-01T14:00:00.000Z"
    });
    assert.equal(payload.planCycleId, planCycleId);
    assert.throws(
      () => parsePlanResearchJobPayload({ ...payload, userId: "must-never-pass" }),
      /plan-cycle research reference is invalid/
    );
  });
});
