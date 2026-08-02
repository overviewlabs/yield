import { DomainError } from "@whox/contracts";
import {
  InMemoryCoordinationAdapter,
  InMemoryDurableJobQueue,
  PollingWorker,
  PostgresDurableJobQueue,
  RedisCoordinationAdapter,
  startWorkerHealthServer,
  type CoordinationAdapter,
  type DurableJobQueue
} from "@whox/agent-orchestrator";
import { parseRuntimeMode } from "@whox/shared-config";
import { Pool } from "pg";
import {
  DemoMarketDataProvider,
  HttpMarketDataProvider,
  MarketDataRefreshService,
  MemoryMarketSnapshotRepository,
  PostgresMarketSnapshotRepository,
  validateApprovedProviderConfiguration,
  validatePlanResearchQuoteJob,
  validateRefreshQuoteJob
} from "./index.js";

function port(): number {
  const value = Number(process.env.HEALTH_PORT ?? 9104);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new DomainError("WORKER_PORT_INVALID", "HEALTH_PORT is invalid", 500);
  }
  return value;
}

async function main(): Promise<void> {
  const mode = parseRuntimeMode(process.env.APP_ENV);
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const redisUrl = process.env.REDIS_URL?.trim();
  if (mode !== "demo" && !databaseUrl) {
    throw new DomainError("DATABASE_URL_REQUIRED", "Paper and Live market-data services require PostgreSQL", 500);
  }
  if (mode !== "demo" && !redisUrl) {
    throw new DomainError("REDIS_URL_REQUIRED", "Paper and Live market-data services require Redis", 500);
  }
  const queue: DurableJobQueue = databaseUrl
    ? PostgresDurableJobQueue.connect(databaseUrl)
    : new InMemoryDurableJobQueue();
  const coordination: CoordinationAdapter = redisUrl
    ? await RedisCoordinationAdapter.connect(redisUrl, "whox-market")
    : new InMemoryCoordinationAdapter();
  const pool = databaseUrl
    ? new Pool({ connectionString: databaseUrl, application_name: "whox-market-data", max: 4 })
    : undefined;
  const endpoint = process.env.MARKET_DATA_PROVIDER_URL?.trim();
  const token = process.env.MARKET_DATA_PROVIDER_TOKEN?.trim();
  const configured = mode === "demo"
    ? { providerId: "whox-demo-fixture", approvedProviders: Object.freeze(["whox-demo-fixture"]) }
    : validateApprovedProviderConfiguration(
        process.env.MARKET_DATA_PROVIDER_ID?.trim() ?? "",
        (process.env.APPROVED_MARKET_DATA_PROVIDERS ?? "").split(",").map((value) => value.trim()).filter(Boolean)
      );
  if (mode !== "demo" && (!endpoint || !token)) {
    throw new DomainError("MARKET_DATA_PROVIDER_REQUIRED", "Paper and Live market data require a configured provider", 500);
  }
  const provider = mode === "demo"
    ? new DemoMarketDataProvider()
    : new HttpMarketDataProvider(new URL(endpoint!), token!, configured.providerId);
  const repository = pool
    ? new PostgresMarketSnapshotRepository(pool)
    : new MemoryMarketSnapshotRepository();
  const service = new MarketDataRefreshService(provider, repository);
  const worker = new PollingWorker("market-data-service", queue, "market-data", async (job) => {
    const lock = await coordination.acquireLock(`job:${job.id}`, 30_000);
    if (lock === undefined) throw new DomainError("MARKET_JOB_LOCKED", "Market-data job is already locked", 409);
    try {
      if (job.jobType !== "refresh_quotes" && job.jobType !== "refresh_plan_research_quotes") {
        throw new DomainError("MARKET_JOB_INVALID", "Market-data refresh job or provider binding is invalid", 422);
      }
      const symbols = job.jobType === "refresh_plan_research_quotes"
        ? validatePlanResearchQuoteJob(job.payload, job.userId, mode !== "demo", configured.providerId)
        : validateRefreshQuoteJob(job.payload, job.userId, mode !== "demo", configured.providerId);
      await service.refresh(symbols);
    } finally {
      await coordination.releaseLock(lock);
    }
  });
  const healthPort = port();
  const health = startWorkerHealthServer(worker, healthPort);
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.stdout.write(JSON.stringify({
    event: "worker_started",
    service: "market-data-service",
    mode,
    healthPort,
    providerId: configured.providerId
  }) + "\n");
  await worker.run(controller.signal);
  await new Promise<void>((resolve) => health.close(() => resolve()));
  await worker.stop();
  await coordination.close();
  if (pool) await pool.end();
}

void main().catch((error: unknown) => {
  process.stderr.write(JSON.stringify({
    event: "worker_start_failed",
    service: "market-data-service",
    code: error instanceof DomainError ? error.code : "WORKER_START_FAILED"
  }) + "\n");
  process.exitCode = 1;
});
