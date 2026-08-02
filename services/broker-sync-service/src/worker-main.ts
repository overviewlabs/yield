import { DomainError } from "@whox/contracts";
import { parseRuntimeMode } from "@whox/shared-config";
import { readFileSync } from "node:fs";
import { runBrokerSyncRuntime } from "./runtime.js";
import { RobinhoodConnector } from "./robinhood-connector.js";
import { startConnectorRpcServer } from "./connector-rpc.js";

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct=environment[name]?.trim();
  const file=environment[`${name}_FILE`]?.trim();
  if(direct!==undefined&&direct!==""&&file!==undefined&&file!=="")throw new DomainError("RUNTIME_SECRET_SOURCE_INVALID",`${name} cannot be configured directly and by file`,500);
  if(file!==undefined&&file!=="")return readFileSync(file,"utf8").trim();
  return direct===undefined||direct===""?undefined:direct;
}

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
  const clientId=environmentValue(process.env,"ROBINHOOD_OAUTH_CLIENT_ID");
  const redirectUri=environmentValue(process.env,"ROBINHOOD_OAUTH_REDIRECT_URI");
  const sharedSecret=environmentValue(process.env,"BROKER_CONNECTOR_SHARED_SECRET");
  const vaultKeyValue=environmentValue(process.env,"BROKER_VAULT_ENCRYPTION_KEY");
  const vaultDirectory=process.env.BROKER_VAULT_DIRECTORY?.trim()||"/var/lib/yield-broker-vault";
  if(clientId===undefined||redirectUri===undefined||sharedSecret===undefined||vaultKeyValue===undefined)throw new DomainError("BROKER_CONNECTOR_CONFIGURATION_REQUIRED","Paper broker connector configuration is incomplete",500);
  const vaultKey=Buffer.from(vaultKeyValue,"base64");
  const connector=new RobinhoodConnector({clientId,redirectUri,vaultDirectory,vaultKey,databaseUrl});
  await connector.prepare();
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const rpc=startConnectorRpcServer(connector,sharedSecret,positiveInteger(process.env.CONNECTOR_RPC_PORT,9205));
  try{
    await runBrokerSyncRuntime({
      databaseUrl,
      connector,
      authorizationLifecycleConnector:connector,
      maximumSnapshotAgeSeconds: positiveInteger(process.env.BROKER_SNAPSHOT_MAX_AGE_SECONDS, 60),
      refreshIntervalSeconds: positiveInteger(process.env.BROKER_SYNC_INTERVAL_SECONDS, 45),
      healthPort: positiveInteger(process.env.HEALTH_PORT, 9105)
    }, controller.signal);
  }finally{
    await new Promise<void>((resolve)=>rpc.close(()=>resolve()));
    await connector.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(JSON.stringify({
    event: "worker_start_failed",
    service: "broker-sync-service",
    code: error instanceof DomainError ? error.code : "WORKER_START_FAILED"
  }) + "\n");
  process.exitCode = 1;
});
