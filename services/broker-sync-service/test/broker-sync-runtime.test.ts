import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryDurableJobQueue, type QueueJob } from "@whox/agent-orchestrator";
import {
  DomainError,
  type ApprovedBrokerAuthorizationLifecycleConnector,
  type ApprovedBrokerConnectorIdentity,
  type BrokerAuthorizationExchangeOperation,
  type BrokerAuthorizationExchangeWork,
  type BrokerAuthorizationSagaOperation,
  type BrokerAuthorizationSagaWork,
  type BrokerHydrationRequest
} from "@whox/contracts";
import {
  BrokerSyncLagMonitor,
  processBrokerSyncQueueJob,
  type BrokerAuthorizationRuntimePersistence,
  type BrokerSyncJobProcessor
} from "../src/runtime.js";

const userId = "11111111-1111-4111-8111-111111111111";
const pairingId = "22222222-2222-4222-8222-222222222222";
const connectionId = "33333333-3333-4333-8333-333333333333";
const sagaId = "44444444-4444-4444-8444-444444444444";
const exchangeTransactionId = "55555555-5555-4555-8555-555555555555";
const jobId = "66666666-6666-4666-8666-666666666666";
const runtimeNow = new Date("2026-08-01T14:00:30.000Z");
const identity: ApprovedBrokerConnectorIdentity = Object.freeze({
  provider: "robinhood_mcp",
  adapterId: "approved-runtime-test",
  approvalReference: "review:runtime-test",
  authorizationIssuer: "https://auth.runtime.test/",
  resourceUri: "https://mcp.runtime.test/trading",
  protocolVersion: "test-1"
});

class RecoveryPersistence implements BrokerAuthorizationRuntimePersistence {
  public exchangeOperation: BrokerAuthorizationExchangeOperation = "exchange_pending";
  public exchangeRevocationRequests = 0;
  public exchangeAcknowledgements = 0;
  public initialRevocationCodes: string[] = [];

  public async loadAuthorizationExchange(): Promise<BrokerAuthorizationExchangeWork> {
    return Object.freeze({
      userId,
      pairingId,
      exchangeTransactionId,
      operation: this.exchangeOperation,
      identity,
      cleanupAfter: "2026-08-01T14:00:20.000Z"
    });
  }

  public async requestAuthorizationExchangeRevocation(): Promise<"revoke_pending" | "revoked" | "completed"> {
    this.exchangeRevocationRequests += 1;
    if (this.exchangeOperation === "completed" || this.exchangeOperation === "revoked") return this.exchangeOperation;
    this.exchangeOperation = "revoke_pending";
    return "revoke_pending";
  }

  public async acknowledgeAuthorizationExchangeRevocation(): Promise<"revoked" | "completed"> {
    this.exchangeAcknowledgements += 1;
    if (this.exchangeOperation === "completed") return "completed";
    this.exchangeOperation = "revoked";
    return "revoked";
  }

  public async loadAuthorizationSaga(): Promise<BrokerAuthorizationSagaWork> {
    throw new DomainError("UNEXPECTED_SAGA_LOAD", "Saga load was not expected", 500);
  }

  public async requestAuthorizationRevocation(): Promise<"revoke_pending" | "revoked"> {
    return "revoke_pending";
  }

  public async acknowledgeAuthorizationConfirmation(): Promise<BrokerAuthorizationSagaOperation> {
    return "confirmed";
  }

  public async acknowledgeAuthorizationRevocation(): Promise<"revoked"> {
    return "revoked";
  }

  public async requestInitialAuthorizationRevocation(
    _request: BrokerHydrationRequest,
    _pairingId: string,
    _authorizationSagaId: string | undefined,
    errorCode: string
  ): Promise<void> {
    this.initialRevocationCodes.push(errorCode);
  }
}

function job(jobType: string, payload: Readonly<Record<string, unknown>>, attempts = 0, maxAttempts = 3): QueueJob<Readonly<Record<string, unknown>>> {
  return Object.freeze({
    id: jobId,
    queueName: "broker-sync",
    userId,
    jobType,
    payload,
    attempts,
    maxAttempts,
    leasedBy: "runtime-test-worker",
    leasedUntil: "2026-08-01T14:01:30.000Z"
  });
}

function lifecycleConnector(revoke: (transactionId: string, signal?: AbortSignal) => Promise<void>): ApprovedBrokerAuthorizationLifecycleConnector {
  return Object.freeze({
    identity,
    async confirmAuthorizationPersistence(): Promise<void> {},
    revokeAuthorization: revoke
  });
}

const unusedProcessor: BrokerSyncJobProcessor = Object.freeze({
  async process(): Promise<never> {
    throw new DomainError("UNEXPECTED_HYDRATION", "Hydration was not expected", 500);
  }
});

const hasCode = (code: string) => (error: unknown): boolean => error instanceof DomainError && error.code === code;

describe("broker authorization recovery runtime", () => {
  it("processes the strict pre-exchange cleanup job through terminal provider revocation", async () => {
    const persistence = new RecoveryPersistence();
    const revoked: string[] = [];
    await processBrokerSyncQueueJob(
      job("reconcile_broker_authorization_exchange", { exchangeTransactionId }),
      unusedProcessor,
      persistence,
      lifecycleConnector(async (transactionId) => { revoked.push(transactionId); }),
      new InMemoryDurableJobQueue(),
      45,
      () => runtimeNow,
      new AbortController().signal,
      20
    );
    assert.deepEqual(revoked, [exchangeTransactionId]);
    assert.equal(persistence.exchangeRevocationRequests, 1);
    assert.equal(persistence.exchangeAcknowledgements, 1);
    assert.equal(persistence.exchangeOperation, "revoked");
  });

  it("bounds a hung lifecycle call and keeps final-attempt cleanup in durable revocation", async () => {
    const persistence = new RecoveryPersistence();
    const connector = lifecycleConnector(async () => await new Promise<void>(() => {}));
    const queue = new InMemoryDurableJobQueue();
    await assert.rejects(
      processBrokerSyncQueueJob(
        job("reconcile_broker_authorization_exchange", { exchangeTransactionId }, 0, 2),
        unusedProcessor,
        persistence,
        connector,
        queue,
        45,
        () => runtimeNow,
        new AbortController().signal,
        5
      ),
      hasCode("BROKER_CONNECTOR_TIMEOUT")
    );
    await processBrokerSyncQueueJob(
      job("reconcile_broker_authorization_exchange", { exchangeTransactionId }, 1, 2),
      unusedProcessor,
      persistence,
      connector,
      queue,
      45,
      () => runtimeNow,
      new AbortController().signal,
      5
    );
    assert.equal(persistence.exchangeOperation, "revoke_pending");
    assert.ok(persistence.exchangeRevocationRequests >= 2);
    assert.equal(persistence.exchangeAcknowledgements, 0);
  });

  it("rejects any extra exchange-job field before persistence or provider access", async () => {
    const persistence = new RecoveryPersistence();
    let providerCalls = 0;
    await assert.rejects(
      processBrokerSyncQueueJob(
        job("reconcile_broker_authorization_exchange", { exchangeTransactionId, credentialHandle: "must-not-be-queued" }),
        unusedProcessor,
        persistence,
        lifecycleConnector(async () => { providerCalls += 1; }),
        new InMemoryDurableJobQueue(),
        45,
        () => runtimeNow,
        new AbortController().signal,
        20
      ),
      hasCode("BROKER_AUTHORIZATION_EXCHANGE_JOB_INVALID")
    );
    assert.equal(providerCalls, 0);
    assert.equal(persistence.exchangeRevocationRequests, 0);
  });

  it("revokes deterministic initial-hydration schema failures immediately and transient failures only at exhaustion", async () => {
    const terminalCodes = [
      "BROKER_CAPABILITIES_INVALID",
      "BROKER_POSITION_INVALID",
      "BROKER_POSITION_DUPLICATE",
      "BROKER_POSITIONS_LIMIT_EXCEEDED",
      "BROKER_PROVIDER_UNAPPROVED"
    ];
    const payload = { connectionId, pairingId, authorizationSagaId: sagaId, provider: "robinhood_mcp", trigger: "authorization_completed" };
    const connector = lifecycleConnector(async () => {});
    for (const code of terminalCodes) {
      const persistence = new RecoveryPersistence();
      const processor: BrokerSyncJobProcessor = { async process(): Promise<never> { throw new DomainError(code, "invalid provider schema", 422); } };
      await processBrokerSyncQueueJob(job("hydrate_broker_account", payload), processor, persistence, connector, new InMemoryDurableJobQueue(), 45, () => runtimeNow, new AbortController().signal, 20);
      assert.deepEqual(persistence.initialRevocationCodes, [code]);
    }

    const transientPersistence = new RecoveryPersistence();
    const transient: BrokerSyncJobProcessor = { async process(): Promise<never> { throw new DomainError("BROKER_CONNECTOR_TIMEOUT", "provider timeout", 503); } };
    await assert.rejects(
      processBrokerSyncQueueJob(job("hydrate_broker_account", payload, 0, 2), transient, transientPersistence, connector, new InMemoryDurableJobQueue(), 45, () => runtimeNow, new AbortController().signal, 20),
      hasCode("BROKER_CONNECTOR_TIMEOUT")
    );
    assert.deepEqual(transientPersistence.initialRevocationCodes, []);
    await processBrokerSyncQueueJob(job("hydrate_broker_account", payload, 1, 2), transient, transientPersistence, connector, new InMemoryDurableJobQueue(), 45, () => runtimeNow, new AbortController().signal, 20);
    assert.deepEqual(transientPersistence.initialRevocationCodes, ["INITIAL_HYDRATION_RETRIES_EXHAUSTED"]);
  });

  it("times out connector readiness and prevents overlapping health refreshes", async () => {
    let storageChecks = 0;
    const monitor = new BrokerSyncLagMonitor({
      async healthy() { storageChecks += 1; return true; },
      async requeueStuckAuthorizationSagas() { return 0; },
      async lagStatus() { return { connectedCount: 0, credentialUnboundCount: 0, laggedCount: 0, pendingAuthorizationCount: 0, stuckAuthorizationCount: 0 }; }
    }, {
      identity,
      async confirmAuthorizationPersistence() {},
      async revokeAuthorization() {},
      async healthy() { return await new Promise<boolean>(() => {}); }
    }, 5);
    await Promise.all([monitor.refresh(), monitor.refresh()]);
    assert.equal(storageChecks, 1);
    assert.equal(monitor.health().ready, false);
    assert.equal(monitor.health().errorCode, "BROKER_CONNECTOR_TIMEOUT");
  });
});
