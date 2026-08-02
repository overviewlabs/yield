import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DomainError,
  type ApprovedBrokerConnectorIdentity,
  type ApprovedBrokerSnapshotConnector,
  type BrokerHydrationSnapshot
} from "@whox/contracts";
import {
  BrokerSyncProcessor,
  requireApprovedBrokerConnector,
  type BrokerSyncPersistence,
  type PersistBrokerHydrationCommand,
  type PersistBrokerHydrationResult
} from "../src/broker-sync.js";
import { nextBrokerSyncDispatch } from "../src/runtime.js";

const userId = "11111111-1111-4111-8111-111111111111";
const connectionId = "22222222-2222-4222-8222-222222222222";
const pairingId = "33333333-3333-4333-8333-333333333333";
const jobId = "44444444-4444-4444-8444-444444444444";
const now = new Date("2026-08-01T14:00:30.000Z");
const identity: ApprovedBrokerConnectorIdentity = Object.freeze({
  provider: "robinhood_mcp",
  adapterId: "approved-fake-adapter",
  approvalReference: "review:test-broker-sync",
  authorizationIssuer: "https://auth.fake-broker.test/",
  resourceUri: "https://mcp.fake-broker.test/",
  protocolVersion: "test-1"
});

function snapshot(overrides: Partial<BrokerHydrationSnapshot> = {}): BrokerHydrationSnapshot {
  return {
    identity,
    account: {
      opaqueBrokerId: "opaque-account-1",
      maskedIdentifier: "Agentic account •••• 1234",
      accountType: "individual_agentic",
      isAgenticAccount: true,
      equityTradingAvailable: true,
      optionsTradingAvailable: true,
      verifiedForTradingAt: "2026-08-01T13:00:00.000Z"
    },
    capabilities: ["get_accounts", "get_portfolio"].map((toolName) => ({
      toolName,
      inputSchema: {},
      discoveredAt: now.toISOString(),
      protocolVersion: "test-1"
    })),
    portfolio: {
      sourceTimestamp: "2026-08-01T14:00:20.000Z",
      totalValue: 25_000,
      buyingPower: 8_000,
      cashValue: 5_000,
      positions: [{
        brokerPositionId: "position-1",
        symbol: "aapl",
        instrumentType: "equity",
        quantity: 10,
        averageCost: 190,
        marketValue: 2_000,
        unrealizedPnl: 100,
        details: { source: "approved-fake-adapter" }
      }]
    },
    ...overrides
  };
}

function connector(value: BrokerHydrationSnapshot, calls: string[]): ApprovedBrokerSnapshotConnector {
  return Object.freeze({
    identity,
    async fetchHydrationSnapshot(): Promise<BrokerHydrationSnapshot> {
      calls.push("connector");
      return value;
    }
  });
}

function persistence(calls: string[], captured: PersistBrokerHydrationCommand[]): BrokerSyncPersistence {
  return {
    async requireReadyConnection(): Promise<void> {
      calls.push("connection");
    },
    async persistHydration(command): Promise<PersistBrokerHydrationResult> {
      calls.push("persist");
      captured.push(command);
      return {
        accountId: "55555555-5555-4555-8555-555555555555",
        portfolioSnapshotId: "66666666-6666-4666-8666-666666666666",
        sourceTimestamp: command.hydration.snapshot.portfolio.sourceTimestamp,
        completedAt: command.completedAt,
        replayed: false
      };
    }
  };
}

const initialCommand = Object.freeze({
  jobId,
  userId,
  payload: Object.freeze({ connectionId, pairingId, provider: "robinhood_mcp", trigger: "authorization_completed" })
});

const hasCode = (code: string) => (error: unknown): boolean => error instanceof DomainError && error.code === code;

describe("approved broker hydration boundary", () => {
  it("refuses to start without an explicitly injected approved adapter", () => {
    assert.throws(() => requireApprovedBrokerConnector(undefined), hasCode("APPROVED_BROKER_CONNECTOR_REQUIRED"));
  });

  it("hydrates through the verified connection and degrades trading when review capability is absent", async () => {
    const calls: string[] = [];
    const captured: PersistBrokerHydrationCommand[] = [];
    const processor = new BrokerSyncProcessor(connector(snapshot(), calls), persistence(calls, captured), { now: () => now });
    const result = await processor.process(initialCommand);
    assert.deepEqual(calls, ["connection", "connector", "persist"], "credential and connector binding must be checked before any provider call");
    assert.equal(result.replayed, false);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.hydration.validUntil, "2026-08-01T14:01:20.000Z");
    assert.equal(captured[0]?.hydration.snapshot.account.equityTradingAvailable, false);
    assert.equal(captured[0]?.hydration.snapshot.account.optionsTradingAvailable, false);
    assert.deepEqual(captured[0]?.hydration.snapshot.capabilities.map((item) => item.toolName), ["get_accounts", "get_portfolio"]);
    assert.equal(captured[0]?.hydration.snapshot.portfolio.positions[0]?.symbol, "AAPL");
  });

  it("rejects secret-bearing queue fields before checking credentials or calling the connector", async () => {
    const calls: string[] = [];
    const processor = new BrokerSyncProcessor(connector(snapshot(), calls), persistence(calls, []), { now: () => now });
    await assert.rejects(processor.process({
      ...initialCommand,
      payload: { ...initialCommand.payload, accessToken: "must-never-be-queued" }
    }), hasCode("BROKER_SYNC_JOB_SECRET_MATERIAL"));
    assert.deepEqual(calls, []);
  });

  it("rejects malformed runtime shapes, mismatched resources, and stale snapshots without persistence", async () => {
    for (const [value, code] of [
      [{ ...snapshot(), account: { ...snapshot().account, isAgenticAccount: "true" } } as unknown as BrokerHydrationSnapshot, "BROKER_SNAPSHOT_INVALID"],
      [snapshot({ identity: { ...identity, resourceUri: "https://different.fake-broker.test/" } }), "BROKER_CONNECTOR_IDENTITY_MISMATCH"],
      [snapshot({ portfolio: { ...snapshot().portfolio, sourceTimestamp: "2026-08-01T13:58:00.000Z" } }), "BROKER_SNAPSHOT_STALE"]
    ] as const) {
      const calls: string[] = [];
      const processor = new BrokerSyncProcessor(connector(value, calls), persistence(calls, []), { now: () => now });
      await assert.rejects(processor.process(initialCommand), hasCode(code));
      assert.deepEqual(calls, ["connection", "connector"]);
    }
  });

  it("requires an Agentic Account and only the capabilities needed to hydrate it", async () => {
    const missingAccountTool = snapshot({ capabilities: snapshot().capabilities.filter((item) => item.toolName !== "get_accounts") });
    const nonAgentic = snapshot({ account: { ...snapshot().account, isAgenticAccount: false } });
    for (const [value, code] of [[missingAccountTool, "BROKER_CAPABILITIES_REQUIRED"], [nonAgentic, "VERIFIED_AGENTIC_ACCOUNT_REQUIRED"]] as const) {
      const calls: string[] = [];
      const processor = new BrokerSyncProcessor(connector(value, calls), persistence(calls, []), { now: () => now });
      await assert.rejects(processor.process(initialCommand), hasCode(code));
      assert.deepEqual(calls, ["connection", "connector"]);
    }
  });

  it("bounds a hung snapshot connector so the queue lease can be retried", async () => {
    const calls: string[] = [];
    const hung: ApprovedBrokerSnapshotConnector = Object.freeze({
      identity,
      async fetchHydrationSnapshot(): Promise<BrokerHydrationSnapshot> {
        calls.push("connector");
        return await new Promise<BrokerHydrationSnapshot>(() => {});
      }
    });
    const processor = new BrokerSyncProcessor(hung, persistence(calls, []), { now: () => now, connectorTimeoutMs: 5 });
    await assert.rejects(processor.process(initialCommand), hasCode("BROKER_CONNECTOR_TIMEOUT"));
    assert.deepEqual(calls, ["connection", "connector"]);
  });
});

describe("recurring broker sync buckets", () => {
  it("advances to a distinct future job when an unchanged provider timestamp replays", () => {
    const initial = nextBrokerSyncDispatch(initialCommand.payload, now.toISOString(), now, 45);
    const replay = nextBrokerSyncDispatch(initial.payload, now.toISOString(), now, 45);
    assert.ok(replay.scheduleBucket > initial.scheduleBucket);
    assert.notEqual(replay.idempotencyKey, initial.idempotencyKey);
    assert.ok(Date.parse(initial.availableAt) > now.getTime());
    assert.ok(Date.parse(replay.availableAt) > Date.parse(initial.availableAt));
    assert.deepEqual(Object.keys(replay.payload).sort(), ["connectionId", "provider", "scheduleBucket", "trigger"]);
  });
});
