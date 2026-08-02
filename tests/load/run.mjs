#!/usr/bin/env node

import assert from "node:assert/strict";
import { once } from "node:events";
import { performance } from "node:perf_hooks";

const FIXED_NOW = "2026-08-01T14:00:00.000Z";
const PRIVATE_NOTIFICATION_BODY = "AAPL moved through the configured private threshold.";
const SAFE_NOTIFICATION_BODY = "Open Metis to view this notification.";

const PROFILES = Object.freeze({
  smoke: Object.freeze({
    http: Object.freeze({requests: 180, concurrency: 24, embeddedShards: 1}),
    notifications: Object.freeze({jobs: 300, concurrency: 24}),
    schedules: Object.freeze({jobs: 2_000, concurrency: 32}),
    backlog: Object.freeze({jobs: 500, concurrency: 24}),
    requestTimeoutMs: 5_000,
    scenarioTimeoutMs: 30_000,
    maximumHttpP95Ms: 2_000
  }),
  heavy: Object.freeze({
    http: Object.freeze({requests: 2_000, concurrency: 120, embeddedShards: 10}),
    notifications: Object.freeze({jobs: 5_000, concurrency: 64}),
    schedules: Object.freeze({jobs: 20_000, concurrency: 96}),
    backlog: Object.freeze({jobs: 10_000, concurrency: 64}),
    requestTimeoutMs: 10_000,
    scenarioTimeoutMs: 120_000,
    maximumHttpP95Ms: 5_000
  })
});

const SCENARIO_NAMES = Object.freeze([
  "market-open",
  "connection-polling",
  "notification-burst",
  "agent-schedules",
  "reconciliation-polling",
  "queue-backlog-recovery"
]);

function usage() {
  return [
    "Usage: node tests/load/run.mjs [--profile smoke|heavy] [--scenario name[,name...]]",
    "",
    "Defaults to the CI-safe smoke profile and an embedded compiled Demo API.",
    "Set LOAD_BASE_URL and LOAD_AUTH_TOKEN to exercise an already-running API.",
    `Scenarios: ${SCENARIO_NAMES.join(", ")}`
  ].join("\n");
}

function option(name) {
  const exact = process.argv.find((value) => value.startsWith(`${name}=`));
  if (exact !== undefined) return exact.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}

const profileName = option("--profile") ?? process.env.LOAD_PROFILE ?? "smoke";
const profile = PROFILES[profileName];
if (profile === undefined) throw new Error(`Unknown load profile: ${profileName}`);

const requestedScenarios = new Set((option("--scenario") ?? SCENARIO_NAMES.join(",")).split(",").filter(Boolean));
for (const scenario of requestedScenarios) {
  if (!SCENARIO_NAMES.includes(scenario)) throw new Error(`Unknown load scenario: ${scenario}`);
}

function percentile(values, percentileValue) {
  assert.ok(values.length > 0, "A latency sample is required");
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
  return sorted[index];
}

function round(value) {
  return Number(value.toFixed(2));
}

function metrics(startedAt, completed, latencies = []) {
  const durationMs = performance.now() - startedAt;
  const base = {
    operations: completed,
    durationMs: round(durationMs),
    operationsPerSecond: round(completed / Math.max(durationMs / 1_000, 0.001))
  };
  if (latencies.length === 0) return base;
  return {
    ...base,
    latencyMs: {
      p50: round(percentile(latencies, 0.5)),
      p95: round(percentile(latencies, 0.95)),
      p99: round(percentile(latencies, 0.99)),
      maximum: round(Math.max(...latencies))
    }
  };
}

async function runPool(total, concurrency, operation) {
  let next = 0;
  const workerCount = Math.min(total, concurrency);
  await Promise.all(Array.from({length: workerCount}, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= total) return;
      await operation(index);
    }
  }));
}

async function withTimeout(label, milliseconds, operation) {
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds} ms`)), milliseconds);
        timer.unref();
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

async function authenticate(baseUrl) {
  const response = await fetch(new URL("/v1/auth/apple", baseUrl), {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({identityToken: "demo-apple-identity-token", deviceId: "load-harness"}),
    signal: AbortSignal.timeout(profile.requestTimeoutMs)
  });
  assert.equal(response.status, 200, `Embedded Demo authentication returned ${response.status}`);
  const body = await response.json();
  assert.equal(typeof body.accessToken, "string", "Embedded Demo authentication did not return an access token");
  return body.accessToken;
}

async function openApiTargets() {
  const configuredBaseUrl = process.env.LOAD_BASE_URL?.trim();
  if (configuredBaseUrl !== undefined && configuredBaseUrl !== "") {
    const token = process.env.LOAD_AUTH_TOKEN?.trim();
    if (token === undefined || token === "") {
      throw new Error("LOAD_AUTH_TOKEN is required when LOAD_BASE_URL is set; the harness never invents production credentials");
    }
    return {
      targets: Object.freeze([{baseUrl: new URL(configuredBaseUrl), accessToken: token}]),
      close: async () => {}
    };
  }

  let apiModule;
  try {
    apiModule = await import("../../services/api/dist/server.js");
  } catch (error) {
    throw new Error("Compiled API not found. Run `npm run build` before the load profile.", {cause: error});
  }

  const servers = [];
  const targets = [];
  try {
    for (let index = 0; index < profile.http.embeddedShards; index += 1) {
      const server = apiModule.createApiServer({
        mode: "demo",
        authSigningKey: Buffer.alloc(48, index + 1),
        pairingHashPepper: Buffer.alloc(48, 101 + index)
      });
      servers.push(server);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert.ok(address !== null && typeof address === "object", "Embedded API did not expose a TCP address");
      const baseUrl = new URL(`http://127.0.0.1:${address.port}`);
      targets.push({baseUrl, accessToken: await authenticate(baseUrl)});
    }
    return {
      targets: Object.freeze(targets),
      close: async () => Promise.all(servers.map(closeServer)).then(() => {})
    };
  } catch (error) {
    await Promise.all(servers.map(closeServer));
    throw error;
  }
}

async function runHttpScenario(name, endpoints) {
  const opened = await openApiTargets();
  const latencies = [];
  let completed = 0;
  const startedAt = performance.now();
  try {
    await runPool(profile.http.requests, profile.http.concurrency, async (index) => {
      const target = opened.targets[index % opened.targets.length];
      const endpoint = endpoints[index % endpoints.length];
      const requestStarted = performance.now();
      const response = await fetch(new URL(endpoint.path, target.baseUrl), {
        headers: {
          authorization: `Bearer ${target.accessToken}`,
          "x-correlation-id": `load-${name}-${String(index).padStart(8, "0")}`
        },
        signal: AbortSignal.timeout(profile.requestTimeoutMs)
      });
      const latency = performance.now() - requestStarted;
      const body = await response.json();
      assert.equal(response.status, 200, `${name} ${endpoint.path} returned ${response.status}`);
      endpoint.validate(body);
      latencies.push(latency);
      completed += 1;
    });
  } finally {
    await opened.close();
  }
  assert.equal(completed, profile.http.requests, `${name} lost HTTP responses`);
  const result = metrics(startedAt, completed, latencies);
  assert.ok(result.latencyMs.p95 <= profile.maximumHttpP95Ms,
    `${name} p95 ${result.latencyMs.p95} ms exceeded ${profile.maximumHttpP95Ms} ms`);
  return {...result, errors: 0, targetKind: process.env.LOAD_BASE_URL ? "configured" : "embedded-demo"};
}

async function loadQueueModule() {
  try {
    return await import("../../services/agent-orchestrator/dist/index.js");
  } catch (error) {
    throw new Error("Compiled orchestrator not found. Run `npm run build` before the load profile.", {cause: error});
  }
}

async function runNotificationBurst() {
  const [{InMemoryDurableJobQueue, PollingWorker}, notificationModule] = await Promise.all([
    loadQueueModule(),
    import("../../services/notification-worker/dist/index.js")
  ]);
  const queue = new InMemoryDurableJobQueue(() => Date.parse(FIXED_NOW));
  const repository = new notificationModule.MemoryNotificationRepository();
  const provider = new notificationModule.InMemoryPushProvider();
  const processor = new notificationModule.NotificationProcessor(repository, provider);
  const commands = Array.from({length: profile.notifications.jobs}, (_, index) => {
    return Object.freeze({
      queueName: "notifications",
      userId: `load-user-${index % 100}`,
      jobType: "deliver_push",
      payload: Object.freeze({
        notificationType: index % 10 === 0 ? "risk_threshold" : "agent_update",
        priority: index % 10 === 0 ? "time_sensitive" : "normal",
        title: "Treasury update",
        privateBody: PRIVATE_NOTIFICATION_BODY,
        publicBody: SAFE_NOTIFICATION_BODY,
        // Queue-supplied preference fields are deliberately hostile input; the
        // processor must use only the server-stored user policy.
        detailedPreviewsEnabled: index % 4 === 0,
        criticalNotificationsEnabled: false,
        occurredAt: FIXED_NOW,
        notificationIdempotencyKey: `load-notification-${index}`,
        deepLink: index % 2 === 0 ? "metis://dashboard" : "metis://proposals"
      }),
      idempotencyKey: `load-notification-job-${index}`
    });
  });
  const startedAt = performance.now();
  const ids = new Array(commands.length);
  await runPool(commands.length, profile.notifications.concurrency, async (index) => {
    ids[index] = await queue.enqueue(commands[index]);
  });

  const replayCount = Math.max(1, Math.floor(commands.length / 10));
  await runPool(replayCount, profile.notifications.concurrency, async (index) => {
    assert.equal(await queue.enqueue(commands[index]), ids[index], "Notification enqueue replay created duplicate work");
  });

  const workers = Array.from({length: profile.notifications.concurrency}, (_, index) => new PollingWorker(
    "notification-load",
    queue,
    "notifications",
    async (job) => {
      assert.equal(job.jobType, "deliver_push");
      assert.equal(typeof job.userId, "string");
      await processor.process(job.userId, job.payload, FIXED_NOW);
    },
    1,
    30_000,
    `notification-load-${index}`
  ));

  await drainWorkers(workers, profile.notifications.jobs);
  assert.equal(provider.deliveries.length, profile.notifications.jobs, "Notification burst did not deliver every unique job exactly once");
  assert.equal(new Set(provider.deliveries.map((delivery) => delivery.collapseId)).size, profile.notifications.jobs,
    "Notification burst produced duplicate collapse identifiers");
  for (const delivery of provider.deliveries) {
    const source = commands.find((command) => command.payload.notificationIdempotencyKey === delivery.collapseId);
    assert.ok(source !== undefined, "Notification delivery did not map to a queued job");
    assert.equal(delivery.body, SAFE_NOTIFICATION_BODY,
      "A queue-supplied preview override leaked a private notification body under burst load");
  }
  await queue.close();
  return {...metrics(startedAt, profile.notifications.jobs), replayedEnqueues: replayCount, errors: 0};
}

async function drainWorkers(workers, expected) {
  let handled = 0;
  let emptyRounds = 0;
  while (handled < expected) {
    const outcomes = await Promise.all(workers.map((worker) => worker.runOnce(new AbortController().signal)));
    const progressed = outcomes.filter(Boolean).length;
    handled += progressed;
    emptyRounds = progressed === 0 ? emptyRounds + 1 : 0;
    if (emptyRounds >= 2) throw new Error(`Queue stalled after ${handled} of ${expected} jobs`);
  }
  const finalOutcomes = await Promise.all(workers.map((worker) => worker.runOnce(new AbortController().signal)));
  assert.ok(finalOutcomes.every((value) => value === false), "Queue was not empty after the expected drain");
  assert.equal(workers.reduce((sum, worker) => sum + worker.health().processed, 0), expected,
    "Worker health counters did not match the drained backlog");
}

async function runAgentSchedules() {
  const {InMemoryDurableJobQueue, PollingWorker} = await loadQueueModule();
  const queue = new InMemoryDurableJobQueue(() => Date.parse(FIXED_NOW));
  const commands = Array.from({length: profile.schedules.jobs}, (_, index) => Object.freeze({
    queueName: "agent-runs",
    userId: `load-user-${index % 500}`,
    jobType: "agent_run",
    payload: Object.freeze({
      userAgentId: `user-agent-${index % 1_000}`,
      runIdempotencyKey: `scheduled-run-${index}`,
      scheduledFor: FIXED_NOW
    }),
    idempotencyKey: `agent-schedule-${index}`,
    priority: index % 25 === 0 ? 50 : 100
  }));
  const startedAt = performance.now();
  const ids = new Array(commands.length);
  await runPool(commands.length, profile.schedules.concurrency, async (index) => {
    ids[index] = await queue.enqueue(commands[index]);
  });
  const replayCount = Math.max(1, Math.floor(commands.length / 20));
  await runPool(replayCount, profile.schedules.concurrency, async (index) => {
    assert.equal(await queue.enqueue(commands[index]), ids[index], "Agent schedule replay created duplicate work");
  });

  const processedRunKeys = new Set();
  const workers = Array.from({length: profile.schedules.concurrency}, (_, index) => new PollingWorker(
    "agent-schedule-load",
    queue,
    "agent-runs",
    async (job) => {
      assert.equal(job.jobType, "agent_run");
      assert.equal(typeof job.payload.runIdempotencyKey, "string");
      assert.equal(processedRunKeys.has(job.payload.runIdempotencyKey), false, "An agent schedule executed more than once");
      processedRunKeys.add(job.payload.runIdempotencyKey);
    },
    1,
    30_000,
    `agent-schedule-load-${index}`
  ));
  await drainWorkers(workers, profile.schedules.jobs);
  assert.equal(processedRunKeys.size, profile.schedules.jobs, "Not every concurrent agent schedule was processed");
  await queue.close();
  return {...metrics(startedAt, processedRunKeys.size), replayedEnqueues: replayCount, errors: 0};
}

async function runQueueBacklogRecovery() {
  const {InMemoryDurableJobQueue, PollingWorker} = await loadQueueModule();
  let virtualNow = Date.parse(FIXED_NOW);
  const queue = new InMemoryDurableJobQueue(() => virtualNow);
  const commands = Array.from({length: profile.backlog.jobs}, (_, index) => Object.freeze({
    queueName: "recovery-load",
    jobType: "transient_work",
    payload: Object.freeze({sequence: index}),
    idempotencyKey: `recovery-job-${index}`,
    maxAttempts: 4
  }));
  const startedAt = performance.now();
  await runPool(commands.length, profile.backlog.concurrency, async (index) => queue.enqueue(commands[index]));

  const failedIds = new Set();
  await runPool(commands.length, profile.backlog.concurrency, async (index) => {
    const workerId = `outage-worker-${index % profile.backlog.concurrency}`;
    const job = await queue.claim("recovery-load", workerId, 30_000);
    assert.ok(job !== undefined, "Backlog could not be leased before the simulated outage");
    failedIds.add(job.id);
    assert.equal(await queue.fail(job.id, workerId, "TRANSIENT_UPSTREAM", 1_000), "retry");
  });
  assert.equal(failedIds.size, profile.backlog.jobs, "Initial outage handling did not touch each queued job once");
  assert.equal(await queue.claim("recovery-load", "too-early-worker", 30_000), undefined,
    "Retry backlog became visible before its retry delay");

  virtualNow += 1_001;
  const recoveredIds = new Set();
  const workers = Array.from({length: profile.backlog.concurrency}, (_, index) => new PollingWorker(
    "backlog-recovery-load",
    queue,
    "recovery-load",
    async (job) => {
      assert.equal(job.attempts, 1, "Recovered job did not retain its retry attempt count");
      assert.equal(recoveredIds.has(job.id), false, "Recovered backlog job ran twice");
      recoveredIds.add(job.id);
    },
    1,
    30_000,
    `recovery-worker-${index}`
  ));
  await drainWorkers(workers, profile.backlog.jobs);
  assert.deepEqual(recoveredIds, failedIds, "Recovered backlog differed from the failed backlog");
  await queue.close();
  return {...metrics(startedAt, recoveredIds.size), transientFailures: failedIds.size, errors: 0};
}

const arrayData = (body) => assert.ok(Array.isArray(body?.data), "Expected a paginated data array");
const scenarios = new Map([
  ["market-open", () => runHttpScenario("market-open", [
    {path: "/v1/dashboard", validate: (body) => assert.equal(body?.mode, "demo")},
    {path: "/v1/portfolio", validate: (body) => assert.ok(Array.isArray(body?.positions))},
    {path: "/v1/positions", validate: arrayData},
    {path: "/v1/portfolio/history", validate: (body) => assert.ok(Array.isArray(body?.data))},
    {path: "/v1/performance", validate: (body) => assert.equal(body?.classification, "demo")},
    {path: "/v1/proposals", validate: arrayData},
    {path: "/v1/activity", validate: arrayData}
  ])],
  ["connection-polling", () => runHttpScenario("connection-polling", [
    {path: "/v1/brokers/robinhood/connection", validate: (body) => {
      assert.ok(body?.status === "connected" || body?.status === "disconnected");
      assert.equal(typeof body?.equityTradingAvailable, "boolean");
    }}
  ])],
  ["notification-burst", runNotificationBurst],
  ["agent-schedules", runAgentSchedules],
  ["reconciliation-polling", () => runHttpScenario("reconciliation-polling", [
    {path: "/v1/orders", validate: arrayData},
    {path: "/v1/proposals", validate: arrayData},
    {path: "/v1/activity", validate: arrayData}
  ])],
  ["queue-backlog-recovery", runQueueBacklogRecovery]
]);

const suiteStartedAt = performance.now();
const results = [];
try {
  for (const [name, scenario] of scenarios) {
    if (!requestedScenarios.has(name)) continue;
    process.stdout.write(`${JSON.stringify({type: "load_scenario_start", profile: profileName, scenario: name})}\n`);
    const result = await withTimeout(name, profile.scenarioTimeoutMs, scenario);
    results.push({name, ...result});
    process.stdout.write(`${JSON.stringify({type: "load_scenario_pass", profile: profileName, scenario: name, ...result})}\n`);
  }
  const summary = {
    type: "load_suite_pass",
    profile: profileName,
    scenarios: results.length,
    operations: results.reduce((sum, result) => sum + result.operations, 0),
    durationMs: round(performance.now() - suiteStartedAt),
    results
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({type: "load_suite_fail", profile: profileName, message})}\n`);
  process.exitCode = 1;
}
