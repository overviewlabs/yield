import { describe, expect, it } from "vitest";
import { applyAdminAction, can, initialAdminState, requiredReleaseFlags } from "./domain";

describe("administrative authorization", () => {
  it("enforces least privilege", () => {
    expect(can("Support", "control:kill-switch")).toBe(false);
    expect(can("Administrator", "control:kill-switch")).toBe(true);
  });

  it("rejects an under-specified reason", () => {
    const result = applyAdminAction(initialAdminState, { type: "SET_USER_PAUSE", paused: true }, {
      actor: "compliance@example.com",
      role: "Compliance",
      reason: "pause",
    });
    expect(result.error).toMatch(/at least 12/);
    expect(result.state).toBe(initialAdminState);
  });

  it("records before, after, actor, reason, timestamp, and correlation id", () => {
    const result = applyAdminAction(initialAdminState, { type: "SET_USER_PAUSE", paused: true }, {
      actor: "compliance@example.com",
      role: "Compliance",
      reason: "Complaint review initiated",
      now: "2026-08-01T08:00:00.000Z",
      correlationId: "corr-test",
    });
    expect(result.error).toBeNull();
    expect(result.state.auditEvents[0]).toMatchObject({
      actor: "compliance@example.com",
      role: "Compliance",
      before: "monitoring",
      after: "paused",
      correlationId: "corr-test",
    });
  });

  it("keeps all required live gates false by default", () => {
    for (const flag of requiredReleaseFlags) expect(initialAdminState.releaseFlags[flag]).toBe(false);
  });
});
