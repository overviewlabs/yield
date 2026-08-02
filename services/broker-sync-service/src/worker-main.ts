import { DomainError } from "@whox/contracts";
import { parseRuntimeMode } from "@whox/shared-config";
import { runBrokerSyncRuntime } from "./runtime.js";

function positiveInteger(value: string | undefined, fallback: number): number {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(resolved) || resolved <= 0) throw new DomainError("BROKER_SYNC_CONFIGURATION_INVALID", "Broker sync numeric configuration is invalid", 500);
  return resolved;
}

async function main(): Promise<void> {
  const mode = parseRuntimeMode(process.env.APP_ENV);
  if (mode !== "paper") throw new DomainError("BROKER_SYNC_MODE_INVALID", "Broker sync runs only in the Paper environment until Live is separately approved", 503);
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl === undefined || databaseUrl === "") throw new DomainError("DATABASE_URL_REQUIRED", "Paper broker sync requires PostgreSQL", 500);
  // No provider implementation is linked into the default artifact. A reviewed
  // integration supplies its own composition root and injects the connector
  // into runBrokerSyncRuntime; environment strings cannot dynamically load code.
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  await runBrokerSyncRuntime({
    databaseUrl,
    maximumSnapshotAgeSeconds: positiveInteger(process.env.BROKER_SNAPSHOT_MAX_AGE_SECONDS, 60),
    refreshIntervalSeconds: positiveInteger(process.env.BROKER_SYNC_INTERVAL_SECONDS, 45),
    healthPort: positiveInteger(process.env.HEALTH_PORT, 9105)
  }, controller.signal);
}

void main().catch((error: unknown) => {
  process.stderr.write(JSON.stringify({
    event: "worker_start_failed",
    service: "broker-sync-service",
    code: error instanceof DomainError ? error.code : "WORKER_START_FAILED"
  }) + "\n");
  process.exitCode = 1;
});
