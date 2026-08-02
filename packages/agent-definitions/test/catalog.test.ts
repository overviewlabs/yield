import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Entitlements } from "@whox/contracts";
import { AGENT_CATALOG, evaluateAgentAvailability } from "../src/index.js";

const all: Entitlements = {stockTrading:true,optionsTrading:true,multiLegOptions:true,maximumActiveAgents:3,automaticMode:true,
  monitoringFrequencyMinutes:15,advancedAnalytics:true,customWatchlists:true,scannerAccess:true,agentCatalog:[],prioritySupport:true};

describe("agent catalog", () => {
  it("contains seven unique versioned definitions", () => {
    assert.equal(AGENT_CATALOG.length, 7);
    assert.equal(new Set(AGENT_CATALOG.map((agent) => `${agent.agentId}@${agent.version}`)).size, 7);
  });
  it("keeps every initial definition out of live mode", () => {
    assert.equal(AGENT_CATALOG.some((agent) => agent.permittedAccountModes.includes("live")), false);
  });
  it("keeps range and volatility disabled pending approval", () => {
    const definition = AGENT_CATALOG.find((agent) => agent.agentId === "range-volatility");
    assert.equal(definition?.status, "draft");
  });
  it("publishes only Foundation Equity as Paper-capable until another persistent pipeline exists", () => {
    assert.deepEqual(AGENT_CATALOG.filter((agent) => agent.status === "paper").map((agent) => agent.agentId), ["foundation-equity"]);
    assert.equal(AGENT_CATALOG.filter((agent) => agent.agentId !== "foundation-equity").every((agent) => agent.status === "draft"), true);
  });
  it("reports each missing runtime broker capability", () => {
    const definition = AGENT_CATALOG[0];
    assert.ok(definition);
    const result = evaluateAgentAvailability(definition, "paper", all, new Set());
    assert.equal(result.available, false);
    assert.ok(result.reasons.every((reason) => reason.startsWith("BROKER_CAPABILITY_MISSING:")));
  });
});
