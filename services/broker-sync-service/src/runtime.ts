import { createServer, type Server } from "node:http";
import {
  DeferJobError,
  PollingWorker,
  PostgresDurableJobQueue,
  type DurableJobQueue,
  type QueueJob,
  type WorkerHealth
} from "@whox/agent-orchestrator";
import {
  DomainError,
  reconcileBrokerAuthorizationExchange,
  reconcileBrokerAuthorizationSaga,
  type ApprovedBrokerAuthorizationLifecycleConnector,
  type ApprovedBrokerSnapshotConnector,
  type BrokerAuthorizationExchangePersistence,
  type BrokerAuthorizationSagaPersistence,
  type BrokerHydrationRequest
} from "@whox/contracts";
import {
  BrokerSyncProcessor,
  brokerSyncFailureCode,
  isTerminalInitialHydrationError,
  parseBrokerSyncJob,
  requireApprovedBrokerConnector,
  type BrokerSyncJobPayload
} from "./broker-sync.js";
import { PostgresBrokerSyncPersistence, type BrokerSyncLagStatus } from "./persistence.js";

export interface BrokerSyncRuntimeOptions {
  readonly connector?: ApprovedBrokerSnapshotConnector;
  readonly authorizationLifecycleConnector?: ApprovedBrokerAuthorizationLifecycleConnector;
  readonly databaseUrl: string;
  readonly queue?: DurableJobQueue;
  readonly persistence?: PostgresBrokerSyncPersistence;
  readonly maximumSnapshotAgeSeconds?: number;
  readonly refreshIntervalSeconds?: number;
  readonly connectorTimeoutSeconds?: number;
  readonly healthPort?: number;
  readonly now?: () => Date;
}

export interface NextBrokerSyncDispatch {
  readonly scheduleBucket: number;
  readonly availableAt: string;
  readonly idempotencyKey: string;
  readonly payload: BrokerSyncJobPayload;
}

export interface BrokerAuthorizationRuntimePersistence extends BrokerAuthorizationSagaPersistence, BrokerAuthorizationExchangePersistence {
  requestInitialAuthorizationRevocation(
    request: BrokerHydrationRequest,
    pairingId: string,
    authorizationSagaId: string | undefined,
    errorCode: string,
    now: string
  ): Promise<void>;
}

export type BrokerSyncJobProcessor = Pick<BrokerSyncProcessor, "process">;

interface LagHealth {
  readonly checkedAt: string;
  readonly ready: boolean;
  readonly status?: BrokerSyncLagStatus;
  readonly errorCode?: string;
}

export interface BrokerSyncHealthPersistence {
  healthy(): Promise<boolean>;
  requeueStuckAuthorizationSagas(): Promise<number>;
  lagStatus(): Promise<BrokerSyncLagStatus>;
}

export class BrokerSyncLagMonitor {
  #health: LagHealth = Object.freeze({ checkedAt: new Date(0).toISOString(), ready: false, errorCode: "BROKER_SYNC_HEALTH_NOT_CHECKED" });
  #refreshing = false;

  public constructor(
    private readonly persistence: BrokerSyncHealthPersistence,
    private readonly authorizationConnector: ApprovedBrokerAuthorizationLifecycleConnector,
    private readonly connectorTimeoutMs: number
  ) {}

  public health(): LagHealth {
    return this.#health;
  }

  public async refresh(): Promise<void> {
    if (this.#refreshing) return;
    this.#refreshing = true;
    try {
      const storageReady = await this.persistence.healthy();
      let lifecycleReady = true;
      if (this.authorizationConnector.healthy !== undefined) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          lifecycleReady = await Promise.race([
            Promise.resolve(this.authorizationConnector.healthy()),
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(() => reject(new DomainError("BROKER_CONNECTOR_TIMEOUT", "Broker authorization connector health check timed out", 503)), this.connectorTimeoutMs);
            })
          ]);
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
        }
      }
      if (storageReady) await this.persistence.requeueStuckAuthorizationSagas();
      const status = storageReady ? await this.persistence.lagStatus() : undefined;
      const ready = storageReady && lifecycleReady && status !== undefined && status.credentialUnboundCount === 0 && status.laggedCount === 0 && status.stuckAuthorizationCount === 0;
      this.#health = Object.freeze({
        checkedAt: new Date().toISOString(),
        ready,
        ...(status === undefined ? {} : { status }),
        ...(!storageReady ? { errorCode: "BROKER_SYNC_STORAGE_NOT_READY" } : !lifecycleReady ? { errorCode: "BROKER_AUTHORIZATION_CONNECTOR_NOT_READY" } : {})
      });
    } catch (error) {
      this.#health = Object.freeze({
        checkedAt: new Date().toISOString(),
        ready: false,
        errorCode: error instanceof DomainError ? error.code : "BROKER_SYNC_HEALTH_UNAVAILABLE"
      });
    } finally {
      this.#refreshing = false;
    }
  }
}

function healthServer(worker: { health(): WorkerHealth }, lag: BrokerSyncLagMonitor, port: number): Server {
  const server = createServer((request, response) => {
    if (request.url !== "/healthz" && request.url !== "/readyz") {
      response.writeHead(404);
      response.end();
      return;
    }
    const workerHealth = worker.health();
    const lagHealth = lag.health();
    const live = workerHealth.state !== "degraded" && workerHealth.state !== "stopping";
    const ready = live && workerHealth.state === "ready" && lagHealth.ready;
    const successful = request.url === "/healthz" ? live : ready;
    const body = JSON.stringify({
      status: successful ? (request.url === "/healthz" ? "ok" : "ready") : "degraded",
      worker: workerHealth,
      brokerSync: lagHealth
    });
    response.writeHead(successful ? 200 : 503, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store"
    });
    response.end(body);
  });
  server.listen(port, "0.0.0.0");
  return server;
}

function integer(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new DomainError("BROKER_SYNC_CONFIGURATION_INVALID", `${name} is invalid`, 500);
  }
  return resolved;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sameConnectorIdentity(left: ApprovedBrokerSnapshotConnector["identity"], right: ApprovedBrokerAuthorizationLifecycleConnector["identity"]): boolean {
  return left.provider === right.provider
    && left.adapterId === right.adapterId
    && left.approvalReference === right.approvalReference
    && left.authorizationIssuer === right.authorizationIssuer
    && left.resourceUri === right.resourceUri
    && left.protocolVersion === right.protocolVersion;
}

export function requireApprovedAuthorizationLifecycleConnector(
  connector: ApprovedBrokerAuthorizationLifecycleConnector | undefined,
  snapshotConnector: ApprovedBrokerSnapshotConnector
): ApprovedBrokerAuthorizationLifecycleConnector {
  if (connector === undefined) throw new DomainError("APPROVED_BROKER_AUTHORIZATION_LIFECYCLE_REQUIRED", "Broker sync refuses to start without the approved authorization lifecycle connector", 503);
  if (!sameConnectorIdentity(snapshotConnector.identity, connector.identity)) throw new DomainError("BROKER_CONNECTOR_IDENTITY_MISMATCH", "Snapshot and authorization lifecycle connectors do not share the approved identity", 503);
  return connector;
}

function sagaIdHint(payload: Readonly<Record<string, unknown>>): string | undefined {
  const value = payload.authorizationSagaId;
  return typeof value === "string" && uuidPattern.test(value) ? value : undefined;
}

function exchangeTransactionIdHint(payload: Readonly<Record<string, unknown>>): string | undefined {
  const value = payload.exchangeTransactionId;
  return typeof value === "string" && uuidPattern.test(value) ? value : undefined;
}

function parseAuthorizationSagaJob(job: QueueJob<Readonly<Record<string, unknown>>>): string {
  if (job.userId === undefined || !uuidPattern.test(job.userId) || Object.keys(job.payload).length !== 1) {
    throw new DomainError("BROKER_AUTHORIZATION_JOB_INVALID", "Authorization recovery requires a strict tenant-bound saga payload", 422);
  }
  const sagaId = sagaIdHint(job.payload);
  if (sagaId === undefined) throw new DomainError("BROKER_AUTHORIZATION_JOB_INVALID", "Authorization recovery saga ID is invalid", 422);
  return sagaId;
}

function parseAuthorizationExchangeJob(job: QueueJob<Readonly<Record<string, unknown>>>): string {
  if (job.userId === undefined || !uuidPattern.test(job.userId) || Object.keys(job.payload).length !== 1) {
    throw new DomainError("BROKER_AUTHORIZATION_EXCHANGE_JOB_INVALID", "Authorization exchange recovery requires a strict tenant-bound payload", 422);
  }
  const exchangeTransactionId = exchangeTransactionIdHint(job.payload);
  if (exchangeTransactionId === undefined) throw new DomainError("BROKER_AUTHORIZATION_EXCHANGE_JOB_INVALID", "Authorization exchange recovery transaction ID is invalid", 422);
  return exchangeTransactionId;
}

function deferredCleanup(runtimeNow: Date): DeferJobError {
  return new DeferJobError(new Date(runtimeNow.getTime() + 30_000).toISOString());
}

export async function processBrokerSyncQueueJob(
  job: QueueJob<Readonly<Record<string, unknown>>>,
  processor: BrokerSyncJobProcessor,
  persistence: BrokerAuthorizationRuntimePersistence,
  authorizationConnector: ApprovedBrokerAuthorizationLifecycleConnector,
  queue: DurableJobQueue,
  refreshIntervalSeconds: number,
  now: () => Date,
  signal: AbortSignal,
  connectorTimeoutMs = 15_000
): Promise<void> {
  if (job.userId === undefined) throw new DomainError("BROKER_SYNC_JOB_INVALID", "Broker sync requires a tenant-bound job", 422);
  if (job.jobType === "reconcile_broker_authorization_exchange") {
    const exchangeTransactionId = parseAuthorizationExchangeJob(job);
    const reconciliationNow = now();
    try {
      await reconcileBrokerAuthorizationExchange(persistence, authorizationConnector, job.userId, exchangeTransactionId, reconciliationNow.toISOString(), signal, connectorTimeoutMs);
    } catch (error) {
      if (job.attempts + 1 < job.maxAttempts) throw error;
      try {
        await persistence.requestAuthorizationExchangeRevocation(job.userId, exchangeTransactionId, "AUTHORIZATION_EXCHANGE_RECOVERY_RETRIES_EXHAUSTED", reconciliationNow.toISOString());
      } catch {
        throw deferredCleanup(reconciliationNow);
      }
    }
    return;
  }
  if (job.jobType === "reconcile_broker_authorization") {
    const sagaId = parseAuthorizationSagaJob(job);
    const reconciliationNow = now();
    try {
      await reconcileBrokerAuthorizationSaga(persistence, authorizationConnector, job.userId, sagaId, reconciliationNow.toISOString(), signal, () => now().toISOString(), connectorTimeoutMs);
    } catch (error) {
      if (job.attempts + 1 < job.maxAttempts) throw error;
      try {
        await persistence.requestAuthorizationRevocation(job.userId, sagaId, "AUTHORIZATION_RECOVERY_RETRIES_EXHAUSTED", reconciliationNow.toISOString());
      } catch {
        throw deferredCleanup(reconciliationNow);
      }
    }
    return;
  }
  if (job.jobType !== "hydrate_broker_account") throw new DomainError("BROKER_SYNC_JOB_INVALID", "Broker sync job type is invalid", 422);
  let parsed: ReturnType<typeof parseBrokerSyncJob> | undefined;
  try {
    parsed = parseBrokerSyncJob({ jobId: job.id, userId: job.userId, payload: job.payload });
    const result = await processor.process({ jobId: job.id, userId: job.userId, payload: job.payload }, signal);
    const dispatch = nextBrokerSyncDispatch(job.payload as BrokerSyncJobPayload, result.completedAt, now(), refreshIntervalSeconds);
    await queue.enqueue({
      queueName: "broker-sync",
      userId: job.userId,
      jobType: "hydrate_broker_account",
      payload: dispatch.payload,
      idempotencyKey: dispatch.idempotencyKey,
      availableAt: dispatch.availableAt,
      priority: 50,
      maxAttempts: 10
    });
  } catch (error) {
    const terminal = isTerminalInitialHydrationError(error);
    const exhausted = job.attempts + 1 >= job.maxAttempts;
    const sagaHint = sagaIdHint(job.payload);
    const isInitial = parsed?.trigger === "authorization_completed" || sagaHint !== undefined;
    if (!isInitial || (!terminal && !exhausted)) throw error;
    const failureCode = terminal ? brokerSyncFailureCode(error) : "INITIAL_HYDRATION_RETRIES_EXHAUSTED";
    const cleanupNow = now();
    try {
      if (parsed?.trigger === "authorization_completed" && parsed.pairingId !== undefined) {
        await persistence.requestInitialAuthorizationRevocation(parsed.request, parsed.pairingId, parsed.authorizationSagaId, failureCode, cleanupNow.toISOString());
      } else if (sagaHint !== undefined) {
        await persistence.requestAuthorizationRevocation(job.userId, sagaHint, failureCode, cleanupNow.toISOString());
      } else {
        throw new DomainError("BROKER_AUTHORIZATION_SAGA_NOT_FOUND", "Initial broker authorization recovery binding is unavailable", 503);
      }
    } catch {
      throw deferredCleanup(cleanupNow);
    }
  }
}

export function nextBrokerSyncDispatch(
  current: BrokerSyncJobPayload,
  completedAt: string,
  runtimeNow: Date,
  refreshIntervalSeconds: number
): NextBrokerSyncDispatch {
  const completedMs = Date.parse(completedAt);
  const nowMs = runtimeNow.getTime();
  if (!Number.isFinite(completedMs) || new Date(completedMs).toISOString() !== completedAt || !Number.isFinite(nowMs)) {
    throw new DomainError("BROKER_SYNC_CLOCK_INVALID", "Broker sync completion or runtime clock is invalid", 500);
  }
  if (!Number.isInteger(refreshIntervalSeconds) || refreshIntervalSeconds < 1) {
    throw new DomainError("BROKER_SYNC_CONFIGURATION_INVALID", "refreshIntervalSeconds is invalid", 500);
  }
  const intervalMs = refreshIntervalSeconds * 1_000;
  const completionBucket = Math.floor(Math.max(completedMs, nowMs) / intervalMs) + 1;
  const currentBucket = current.trigger === "scheduled" && Number.isSafeInteger(current.scheduleBucket)
    ? current.scheduleBucket as number
    : 0;
  const scheduleBucket = Math.max(completionBucket, currentBucket + 1);
  const scheduledMs = scheduleBucket * intervalMs;
  if (!Number.isSafeInteger(scheduleBucket) || !Number.isFinite(scheduledMs) || scheduledMs <= nowMs) {
    throw new DomainError("BROKER_SYNC_SCHEDULE_INVALID", "Broker sync could not derive a strictly future refresh bucket", 500);
  }
  const payload: BrokerSyncJobPayload = Object.freeze({
    connectionId: current.connectionId,
    provider: "robinhood_mcp",
    trigger: "scheduled",
    scheduleBucket
  });
  return Object.freeze({
    scheduleBucket,
    availableAt: new Date(scheduledMs).toISOString(),
    idempotencyKey: `broker-sync:${current.connectionId}:${scheduleBucket}`,
    payload
  });
}

export async function runBrokerSyncRuntime(options: BrokerSyncRuntimeOptions, signal: AbortSignal): Promise<void> {
  const connector = requireApprovedBrokerConnector(options.connector);
  const authorizationConnector = requireApprovedAuthorizationLifecycleConnector(options.authorizationLifecycleConnector, connector);
  const maximumAge = integer(options.maximumSnapshotAgeSeconds, 60, 15, 300, "maximumSnapshotAgeSeconds");
  const refreshInterval = integer(options.refreshIntervalSeconds, 45, 10, maximumAge - 5, "refreshIntervalSeconds");
  const connectorTimeoutSeconds = integer(options.connectorTimeoutSeconds, 15, 1, 60, "connectorTimeoutSeconds");
  const healthPort = integer(options.healthPort, 9105, 1, 65_535, "healthPort");
  const now = options.now ?? (() => new Date());
  const persistence = options.persistence ?? new PostgresBrokerSyncPersistence(options.databaseUrl);
  const queue = options.queue ?? PostgresDurableJobQueue.connect(options.databaseUrl);
  const processor = new BrokerSyncProcessor(connector, persistence, { maximumSnapshotAgeSeconds: maximumAge, connectorTimeoutMs: connectorTimeoutSeconds * 1_000, now });
  const worker = new PollingWorker<Readonly<Record<string, unknown>>>(
    "broker-sync-service",
    queue,
    "broker-sync",
    async (job: QueueJob<Readonly<Record<string, unknown>>>, jobSignal: AbortSignal) =>
      await processBrokerSyncQueueJob(job, processor, persistence, authorizationConnector, queue, refreshInterval, now, jobSignal, connectorTimeoutSeconds * 1_000),
    750,
    60_000
  );
  const lag = new BrokerSyncLagMonitor(persistence, authorizationConnector, connectorTimeoutSeconds * 1_000);
  await lag.refresh();
  const monitor = setInterval(() => { void lag.refresh(); }, 10_000);
  monitor.unref();
  const server = healthServer(worker, lag, healthPort);
  process.stdout.write(JSON.stringify({ event: "worker_started", service: "broker-sync-service", mode: "paper", healthPort }) + "\n");
  try {
    await worker.run(signal);
  } finally {
    clearInterval(monitor);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await worker.stop();
    await persistence.close();
  }
}
