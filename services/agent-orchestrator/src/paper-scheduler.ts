import { DomainError } from "@whox/contracts";
import { Pool } from "pg";
import { errorCode, type WorkerHealth } from "./worker-runtime.js";

const PROVIDER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;

export interface PaperSchedulerTick {
  readonly lockAcquired: boolean;
  readonly evaluatedAgents: number;
  readonly dueAgents: number;
  readonly refreshJobsEnqueued: number;
  readonly researchJobsEnqueued: number;
  readonly agentRunsEnqueued: number;
  readonly researchBlockedAgents: number;
  readonly backpressureBlockedAgents: number;
  readonly quoteBlockedAgents: number;
  readonly otherBlockedAgents: number;
  readonly maxSchedulingLagSeconds: number;
  readonly oldestDueAt?: string;
}

export interface PaperSchedulerHealth {
  readonly state: "starting" | "ready" | "lagging" | "degraded" | "stopping";
  readonly lastTickAt?: string;
  readonly lastSuccessAt?: string;
  readonly lastErrorCode?: string;
  readonly lockContentions: number;
  readonly evaluatedAgents: number;
  readonly dueAgents: number;
  readonly refreshJobsEnqueued: number;
  readonly researchJobsEnqueued: number;
  readonly agentRunsEnqueued: number;
  readonly researchBlockedAgents: number;
  readonly backpressureBlockedAgents: number;
  readonly quoteBlockedAgents: number;
  readonly otherBlockedAgents: number;
  readonly maxSchedulingLagSeconds: number;
  readonly lagAlertThresholdSeconds: number;
  readonly oldestDueAt?: string;
}

export interface PaperSchedulerOptions {
  readonly approvedMarketDataProviders: readonly string[];
  readonly marketDataProviderId: string;
  readonly autonomousModeEnabled: boolean;
  readonly intervalMs?: number;
  readonly lagAlertThresholdSeconds?: number;
  readonly batchSize?: number;
  readonly maxOutstandingJobs?: number;
  readonly onTick?: (tick: PaperSchedulerTick) => void;
  readonly onError?: (code: string) => void;
}

export type AgentOrchestratorHealth = WorkerHealth & { readonly scheduler?: PaperSchedulerHealth };

export function combineAgentOrchestratorHealth(
  workerHealth: WorkerHealth,
  schedulerHealth?: PaperSchedulerHealth
): AgentOrchestratorHealth {
  const schedulerUnhealthy = schedulerHealth?.state === "degraded" || schedulerHealth?.state === "lagging";
  return Object.freeze({
    ...workerHealth,
    state: schedulerUnhealthy ? "degraded" : workerHealth.state,
    ...(schedulerHealth === undefined ? {} : { scheduler: schedulerHealth })
  });
}

interface SchedulerRow {
  lock_acquired: boolean;
  evaluated_agents: number;
  due_agents: number;
  refresh_jobs_enqueued: number;
  research_jobs_enqueued: number;
  agent_runs_enqueued: number;
  research_blocked_agents: number;
  backpressure_blocked_agents: number;
  quote_blocked_agents: number;
  other_blocked_agents: number;
  max_scheduling_lag_seconds: number;
  oldest_due_at: Date | null;
}

export class PostgresPaperAgentScheduler {
  readonly #pool: Pool;
  readonly #providers: readonly string[];
  readonly #providerId: string;
  readonly #autonomousModeEnabled: boolean;
  readonly #intervalMs: number;
  readonly #lagAlertThresholdSeconds: number;
  readonly #batchSize: number;
  readonly #maxOutstandingJobs: number;
  readonly #onTick: ((tick: PaperSchedulerTick) => void) | undefined;
  readonly #onError: ((code: string) => void) | undefined;
  #state: PaperSchedulerHealth["state"] = "starting";
  #lastTickAt: string | undefined;
  #lastSuccessAt: string | undefined;
  #lastErrorCode: string | undefined;
  #lockContentions = 0;
  #lastTick: PaperSchedulerTick = Object.freeze({
    lockAcquired: false,
    evaluatedAgents: 0,
    dueAgents: 0,
    refreshJobsEnqueued: 0,
    researchJobsEnqueued: 0,
    agentRunsEnqueued: 0,
    researchBlockedAgents: 0,
    backpressureBlockedAgents: 0,
    quoteBlockedAgents: 0,
    otherBlockedAgents: 0,
    maxSchedulingLagSeconds: 0
  });

  public constructor(databaseUrl: string, options: PaperSchedulerOptions) {
    if (databaseUrl.trim() === "") throw new TypeError("DATABASE_URL is required");
    const providers = [...new Set(options.approvedMarketDataProviders.map((value) => value.trim()).filter(Boolean))];
    if (providers.length === 0 || providers.some((provider) => !PROVIDER_PATTERN.test(provider))) {
      throw new DomainError(
        "APPROVED_MARKET_DATA_PROVIDERS_REQUIRED",
        "Paper scheduling requires an explicit approved market-data provider allowlist",
        500
      );
    }
    const providerId = options.marketDataProviderId.trim();
    if (!PROVIDER_PATTERN.test(providerId) || !providers.includes(providerId)) {
      throw new DomainError(
        "MARKET_PROVIDER_NOT_APPROVED",
        "MARKET_DATA_PROVIDER_ID must be present in APPROVED_MARKET_DATA_PROVIDERS",
        500
      );
    }
    this.#intervalMs = boundedInteger(options.intervalMs ?? 15_000, 1_000, 300_000, "AGENT_SCHEDULER_POLL_MS");
    this.#lagAlertThresholdSeconds = boundedInteger(
      options.lagAlertThresholdSeconds ?? 300,
      30,
      86_400,
      "AGENT_SCHEDULER_LAG_ALERT_SECONDS"
    );
    this.#batchSize = boundedInteger(options.batchSize ?? 250, 1, 1_000, "AGENT_SCHEDULER_BATCH_SIZE");
    this.#maxOutstandingJobs = boundedInteger(
      options.maxOutstandingJobs ?? 1_000,
      1,
      10_000,
      "AGENT_SCHEDULER_MAX_OUTSTANDING_JOBS"
    );
    this.#providers = Object.freeze(providers);
    this.#providerId = providerId;
    this.#autonomousModeEnabled = options.autonomousModeEnabled;
    this.#onTick = options.onTick;
    this.#onError = options.onError;
    this.#pool = new Pool({
      connectionString: databaseUrl,
      application_name: "whox-paper-agent-scheduler",
      max: 2
    });
  }

  public health(): PaperSchedulerHealth {
    return Object.freeze({
      state: this.#state,
      ...(this.#lastTickAt === undefined ? {} : { lastTickAt: this.#lastTickAt }),
      ...(this.#lastSuccessAt === undefined ? {} : { lastSuccessAt: this.#lastSuccessAt }),
      ...(this.#lastErrorCode === undefined ? {} : { lastErrorCode: this.#lastErrorCode }),
      lockContentions: this.#lockContentions,
      evaluatedAgents: this.#lastTick.evaluatedAgents,
      dueAgents: this.#lastTick.dueAgents,
      refreshJobsEnqueued: this.#lastTick.refreshJobsEnqueued,
      researchJobsEnqueued: this.#lastTick.researchJobsEnqueued,
      agentRunsEnqueued: this.#lastTick.agentRunsEnqueued,
      researchBlockedAgents: this.#lastTick.researchBlockedAgents,
      backpressureBlockedAgents: this.#lastTick.backpressureBlockedAgents,
      quoteBlockedAgents: this.#lastTick.quoteBlockedAgents,
      otherBlockedAgents: this.#lastTick.otherBlockedAgents,
      maxSchedulingLagSeconds: this.#lastTick.maxSchedulingLagSeconds,
      lagAlertThresholdSeconds: this.#lagAlertThresholdSeconds,
      ...(this.#lastTick.oldestDueAt === undefined ? {} : { oldestDueAt: this.#lastTick.oldestDueAt })
    });
  }

  public async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.runOnce();
      } catch (error) {
        this.#lastTickAt = new Date().toISOString();
        this.#lastErrorCode = errorCode(error);
        this.#state = "degraded";
        this.#onError?.(this.#lastErrorCode);
      }
      if (!signal.aborted) await wait(this.#intervalMs, signal);
    }
    this.#state = "stopping";
  }

  public async runOnce(): Promise<PaperSchedulerTick> {
    this.#lastTickAt = new Date().toISOString();
    const result = await this.#pool.query<SchedulerRow>(
      `SELECT lock_acquired,evaluated_agents,due_agents,refresh_jobs_enqueued,research_jobs_enqueued,
         agent_runs_enqueued,research_blocked_agents,backpressure_blocked_agents,
         quote_blocked_agents,other_blocked_agents,max_scheduling_lag_seconds,oldest_due_at
       FROM app.schedule_paper_agent_jobs($1::text[],$2::text,$3::integer,$4::boolean,$5::integer)`,
      [
        this.#providers,
        this.#providerId,
        this.#batchSize,
        this.#autonomousModeEnabled,
        this.#maxOutstandingJobs
      ]
    );
    const row = result.rows[0];
    if (row === undefined || result.rows.length !== 1) {
      throw new DomainError("PAPER_SCHEDULER_RESULT_INVALID", "Paper scheduler returned an invalid result", 500);
    }
    if (!row.lock_acquired) {
      this.#lockContentions += 1;
      this.#lastSuccessAt = this.#lastTickAt;
      this.#lastErrorCode = undefined;
      this.#state = "ready";
      const contentionTick = Object.freeze({
        lockAcquired: false,
        evaluatedAgents: 0,
        dueAgents: 0,
        refreshJobsEnqueued: 0,
        researchJobsEnqueued: 0,
        agentRunsEnqueued: 0,
        researchBlockedAgents: 0,
        backpressureBlockedAgents: 0,
        quoteBlockedAgents: 0,
        otherBlockedAgents: 0,
        maxSchedulingLagSeconds: 0
      });
      this.#lastTick = contentionTick;
      return contentionTick;
    }
    const tick = Object.freeze({
      lockAcquired: true,
      evaluatedAgents: integer(row.evaluated_agents, "evaluated_agents"),
      dueAgents: integer(row.due_agents, "due_agents"),
      refreshJobsEnqueued: integer(row.refresh_jobs_enqueued, "refresh_jobs_enqueued"),
      researchJobsEnqueued: integer(row.research_jobs_enqueued, "research_jobs_enqueued"),
      agentRunsEnqueued: integer(row.agent_runs_enqueued, "agent_runs_enqueued"),
      researchBlockedAgents: integer(row.research_blocked_agents, "research_blocked_agents"),
      backpressureBlockedAgents: integer(row.backpressure_blocked_agents, "backpressure_blocked_agents"),
      quoteBlockedAgents: integer(row.quote_blocked_agents, "quote_blocked_agents"),
      otherBlockedAgents: integer(row.other_blocked_agents, "other_blocked_agents"),
      maxSchedulingLagSeconds: integer(row.max_scheduling_lag_seconds, "max_scheduling_lag_seconds"),
      ...(row.oldest_due_at === null ? {} : { oldestDueAt: new Date(row.oldest_due_at).toISOString() })
    });
    this.#lastTick = tick;
    this.#lastSuccessAt = this.#lastTickAt;
    this.#lastErrorCode = undefined;
    this.#state = tick.maxSchedulingLagSeconds > this.#lagAlertThresholdSeconds ? "lagging" : "ready";
    this.#onTick?.(tick);
    return tick;
  }

  public async close(): Promise<void> {
    this.#state = "stopping";
    await this.#pool.end();
  }
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new DomainError("PAPER_SCHEDULER_CONFIGURATION_INVALID", `${name} must be an integer from ${minimum} through ${maximum}`, 500);
  }
  return value;
}

function integer(value: number, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new DomainError("PAPER_SCHEDULER_RESULT_INVALID", `Paper scheduler ${name} is invalid`, 500);
  }
  return parsed;
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      signal.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
