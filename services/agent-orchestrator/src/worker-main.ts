import { DomainError } from "@whox/contracts";
import { parseRuntimeMode, readReleaseGates } from "@whox/shared-config";
import {
  AgentRunRegistry,
  PlanCycleResearchService,
  PostgresAgentPipeline,
  PostgresPaperAgentScheduler,
  PostgresPlanResearchRepository,
  assertAgentPipelineConfigured,
  combineAgentOrchestratorHealth,
  createHermesResearchProviderFromEnvironment,
  parseAgentRunJobPayload,
  parsePlanResearchJobPayload
} from "./index.js";
import { InMemoryCoordinationAdapter, RedisCoordinationAdapter, type CoordinationAdapter } from "./coordination.js";
import { InMemoryDurableJobQueue, PostgresDurableJobQueue, type DurableJobQueue } from "./durable-queue.js";
import { PollingWorker, startWorkerHealthServer } from "./worker-runtime.js";

function positivePort(raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new DomainError("WORKER_PORT_INVALID", "HEALTH_PORT must be an integer from 1 through 65535", 500);
  }
  return value;
}

function queueForRuntime(mode: "demo" | "paper" | "live", databaseUrl: string | undefined): DurableJobQueue {
  if (databaseUrl !== undefined) return PostgresDurableJobQueue.connect(databaseUrl);
  if (mode !== "demo") throw new DomainError("DATABASE_URL_REQUIRED", "Paper and Live workers require PostgreSQL durable queues", 500);
  return new InMemoryDurableJobQueue();
}

async function coordinationForRuntime(
  mode: "demo" | "paper" | "live",
  redisUrl: string | undefined
): Promise<CoordinationAdapter> {
  if (redisUrl !== undefined) return RedisCoordinationAdapter.connect(redisUrl, "whox-agent");
  if (mode !== "demo") throw new DomainError("REDIS_URL_REQUIRED", "Paper and Live workers require Redis coordination", 500);
  return new InMemoryCoordinationAdapter();
}

function approvedProviders(): readonly string[] {
  const providers = (process.env.APPROVED_MARKET_DATA_PROVIDERS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (providers.length === 0 || providers.some((value) => !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value))) {
    throw new DomainError(
      "APPROVED_MARKET_DATA_PROVIDERS_REQUIRED",
      "APPROVED_MARKET_DATA_PROVIDERS must name at least one explicitly approved provider",
      500
    );
  }
  return Object.freeze([...new Set(providers)]);
}

function configuredProviderId(providers: readonly string[]): string {
  const providerId = process.env.MARKET_DATA_PROVIDER_ID?.trim() ?? "";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(providerId) || !providers.includes(providerId)) {
    throw new DomainError(
      "MARKET_PROVIDER_NOT_APPROVED",
      "MARKET_DATA_PROVIDER_ID must be present in APPROVED_MARKET_DATA_PROVIDERS",
      500
    );
  }
  return providerId;
}

function schedulerInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value)) {
    throw new DomainError("PAPER_SCHEDULER_CONFIGURATION_INVALID", `${name} must be an integer`, 500);
  }
  return value;
}

async function main(): Promise<void> {
  const mode = parseRuntimeMode(process.env.APP_ENV);
  const databaseUrl = process.env.DATABASE_URL?.trim() || undefined;
  const redisUrl = process.env.REDIS_URL?.trim() || undefined;
  const persistentConfigured = mode === "paper" && databaseUrl !== undefined && redisUrl !== undefined;
  assertAgentPipelineConfigured(mode, persistentConfigured);

  const queue = queueForRuntime(mode, databaseUrl);
  const coordination = await coordinationForRuntime(mode, redisUrl);
  const releaseGates = readReleaseGates(process.env);
  const providerAllowlist = mode === "paper" ? approvedProviders() : Object.freeze([] as string[]);
  const marketDataProviderId = mode === "paper" ? configuredProviderId(providerAllowlist) : "whox-demo-fixture";
  const hermesResearchProvider = createHermesResearchProviderFromEnvironment(mode);
  if (mode === "paper" && hermesResearchProvider === undefined) {
    throw new DomainError("HERMES_API_KEY_REQUIRED", "Paper plan research requires Hermes", 500);
  }
  const planResearchRepository = mode === "paper"
    ? new PostgresPlanResearchRepository(databaseUrl!, marketDataProviderId)
    : undefined;
  const planResearchService = mode === "paper"
    ? new PlanCycleResearchService(hermesResearchProvider!, planResearchRepository!)
    : undefined;
  const pipeline = mode === "paper"
    ? new PostgresAgentPipeline(databaseUrl!, {
        mode: "paper",
        approvedMarketDataProviders: providerAllowlist,
        releaseGates
      })
    : undefined;
  const lagAlertThresholdSeconds = mode === "paper"
    ? schedulerInteger("AGENT_SCHEDULER_LAG_ALERT_SECONDS", 300)
    : 300;
  const scheduler = mode === "paper"
    ? new PostgresPaperAgentScheduler(databaseUrl!, {
        approvedMarketDataProviders: providerAllowlist,
        marketDataProviderId,
        autonomousModeEnabled: releaseGates.AUTONOMOUS_MODE_ENABLED,
        intervalMs: schedulerInteger("AGENT_SCHEDULER_POLL_MS", 15_000),
        lagAlertThresholdSeconds,
        batchSize: schedulerInteger("AGENT_SCHEDULER_BATCH_SIZE", 250),
        maxOutstandingJobs: schedulerInteger("AGENT_SCHEDULER_MAX_OUTSTANDING_JOBS", 1_000),
        onTick: (tick) => {
          if (tick.refreshJobsEnqueued > 0 || tick.researchJobsEnqueued > 0 || tick.agentRunsEnqueued > 0) {
            process.stdout.write(JSON.stringify({
              event: "paper_scheduler_jobs_enqueued",
              evaluatedAgents: tick.evaluatedAgents,
              refreshJobsEnqueued: tick.refreshJobsEnqueued,
              researchJobsEnqueued: tick.researchJobsEnqueued,
              agentRunsEnqueued: tick.agentRunsEnqueued
            }) + "\n");
          }
          if (tick.maxSchedulingLagSeconds > lagAlertThresholdSeconds) {
            process.stderr.write(JSON.stringify({
              event: "paper_scheduler_lag",
              maxSchedulingLagSeconds: tick.maxSchedulingLagSeconds,
              lagAlertThresholdSeconds,
              dueAgents: tick.dueAgents,
              quoteBlockedAgents: tick.quoteBlockedAgents,
              researchBlockedAgents: tick.researchBlockedAgents,
              backpressureBlockedAgents: tick.backpressureBlockedAgents,
              otherBlockedAgents: tick.otherBlockedAgents,
              oldestDueAt: tick.oldestDueAt ?? null
            }) + "\n");
          }
        },
        onError: (code) => process.stderr.write(JSON.stringify({
          event: "paper_scheduler_failed",
          code
        }) + "\n")
      })
    : undefined;
  const registry = new AgentRunRegistry();
  const worker = new PollingWorker("agent-orchestrator", queue, "agent-runs", async (job) => {
    const lock = await coordination.acquireLock(`job:${job.id}`, 30_000);
    if (lock === undefined) throw new DomainError("AGENT_JOB_LOCKED", "Agent job is already coordinated by another worker", 409);
    try {
      if (job.jobType !== "agent_run") throw new DomainError("AGENT_JOB_TYPE_INVALID", "Unsupported agent job type", 422);
      const payload = parseAgentRunJobPayload(job.payload);
      const { userAgentId, runIdempotencyKey: key } = payload;
      if (pipeline === undefined) {
        registry.start(userAgentId, key, new Date().toISOString());
        return;
      }
      if (payload.planCycle === undefined) {
        throw new DomainError(
          "PLAN_CYCLE_REQUIRED",
          "Persistent Paper agent runs require an immutable shared plan-cycle research reference",
          422
        );
      }
      if (job.userId === undefined) {
        throw new DomainError("AGENT_JOB_USER_REQUIRED", "Persistent agent runs must be tenant-bound by the durable job", 422);
      }
      await pipeline.run({
        userId: job.userId,
        userAgentId,
        runIdempotencyKey: key,
        correlationId: job.id,
        planCycle: payload.planCycle
      });
    } finally {
      await coordination.releaseLock(lock);
    }
  });
  const researchWorker = planResearchService === undefined
    ? undefined
    : new PollingWorker("plan-research", queue, "plan-research", async (job) => {
        if (job.jobType !== "plan_research" || job.userId !== undefined) {
          throw new DomainError(
            "PLAN_RESEARCH_JOB_INVALID",
            "Plan research jobs must be non-tenant shared-cycle jobs",
            422
          );
        }
        const payload = parsePlanResearchJobPayload(job.payload);
        const lock = await coordination.acquireLock(`plan-research:${payload.planCycleId}`, 30_000);
        if (lock === undefined) {
          throw new DomainError("PLAN_RESEARCH_JOB_LOCKED", "Plan research is already running for this cycle", 409);
        }
        try {
          await planResearchService.process(payload);
        } finally {
          await coordination.releaseLock(lock);
        }
      });
  const healthPort = positivePort(process.env.HEALTH_PORT, 9101);
  const health = startWorkerHealthServer({
    health: () => {
      const combined = combineAgentOrchestratorHealth(worker.health(), scheduler?.health());
      const research = researchWorker?.health();
      return Object.freeze({
        ...combined,
        state: research?.state === "degraded"
          ? "degraded" as const
          : research?.state === "starting" && combined.state === "ready"
            ? "starting" as const
            : combined.state,
        ...(research === undefined ? {} : { researchWorker: research })
      });
    }
  }, healthPort);
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.stdout.write(JSON.stringify({
    event: "worker_started",
    service: "agent-orchestrator",
    mode,
    healthPort,
    persistentScheduler: scheduler !== undefined,
    sharedHermesResearch: researchWorker !== undefined
  }) + "\n");
  await Promise.all([
    worker.run(controller.signal),
    ...(researchWorker === undefined ? [] : [researchWorker.run(controller.signal)]),
    ...(scheduler === undefined ? [] : [scheduler.run(controller.signal)])
  ]);
  await new Promise<void>((resolve, reject) => health.close((error) => error ? reject(error) : resolve()));
  await worker.stop();
  await scheduler?.close();
  await coordination.close();
  await pipeline?.close();
  await planResearchRepository?.close();
}

void main().catch((error: unknown) => {
  process.stderr.write(JSON.stringify({
    event: "worker_start_failed",
    service: "agent-orchestrator",
    code: error instanceof DomainError ? error.code : "WORKER_START_FAILED"
  }) + "\n");
  process.exitCode = 1;
});
