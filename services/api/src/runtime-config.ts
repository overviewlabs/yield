import { randomBytes } from "node:crypto";
import { DomainError } from "@whox/contracts";
import { parseRuntimeMode, type RuntimeMode } from "@whox/shared-config";
import { AppleIdentityTokenVerifier } from "./apple-identity.js";
import { PostgresTenantDatabase } from "./database.js";
import { RedisSlidingWindowRateLimiter } from "./distributed-rate-limit.js";
import { loadAppleStoreKitRuntime } from "./storekit-runtime.js";
import { PostgresPairingService } from "./postgres-pairings.js";
import { PostgresSessionService } from "./postgres-session.js";
import { PostgresApiDataStore } from "./postgres-store.js";
import type { ApiServerOptions } from "./server.js";

export interface ApiRuntimeConfiguration {
  readonly host: string;
  readonly port: number;
  readonly serverOptions: ApiServerOptions;
  close(): Promise<void>;
}

const placeholderPattern = /(replace|change[_ -]?me|example|placeholder|not[_ -]?for[_ -]?production|local[_ -]?only|development[_ -]?key)/i;

function absoluteUrl(name: string, raw: string): URL {
  let value: URL;
  try { value = new URL(raw); }
  catch { throw new DomainError("RUNTIME_URL_INVALID", `${name} must be an absolute HTTP(S) URL`, 500); }
  if (!['http:', 'https:'].includes(value.protocol) || value.username !== '' || value.password !== '') {
    throw new DomainError("RUNTIME_URL_INVALID", `${name} must be an absolute HTTP(S) URL without embedded credentials`, 500);
  }
  return value;
}

function urlFromEnvironment(name: string, fallback: string): URL {
  return absoluteUrl(name, process.env[name]?.trim() || fallback);
}

function persistentSecret(name: string, mode: RuntimeMode): Buffer {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length < 32 || placeholderPattern.test(raw)) {
    if (mode !== "demo") {
      throw new DomainError("RUNTIME_SECRET_REQUIRED", `${name} must be a distinct, non-placeholder secret of at least 32 bytes in ${mode}`, 500);
    }
    return randomBytes(48);
  }
  return Buffer.from(raw, "utf8");
}

function trustedProxyHops(): number {
  const raw = process.env.TRUSTED_PROXY_HOPS?.trim() || "0";
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 5) {
    throw new DomainError("TRUSTED_PROXY_HOPS_INVALID", "TRUSTED_PROXY_HOPS must be an integer from 0 through 5", 500);
  }
  return value;
}

export function loadApiRuntimeConfiguration(): ApiRuntimeConfiguration {
  const mode = parseRuntimeMode(process.env.APP_ENV);
  if (mode === "live") throw new DomainError("LIVE_RUNTIME_DISABLED", "The API runtime does not implement Live trading", 503);
  const port = Number(process.env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new DomainError("RUNTIME_PORT_INVALID", "PORT must be an integer from 1 through 65535", 500);
  const connectionWebUrl = urlFromEnvironment("CONNECT_WEB_URL", "http://localhost:4173");
  const publicApiUrl = urlFromEnvironment("PUBLIC_API_URL", `http://127.0.0.1:${port}`);
  const configuredOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const origins = new Set<string>([connectionWebUrl.origin]);
  for (const configured of configuredOrigins) origins.add(absoluteUrl("CORS_ALLOWED_ORIGINS", configured).origin);
  const adminUrl = process.env.ADMIN_WEB_URL?.trim();
  if (adminUrl) origins.add(absoluteUrl("ADMIN_WEB_URL", adminUrl).origin);
  const authSigningKey=persistentSecret("SESSION_SIGNING_SECRET",mode);const pairingHashPepper=persistentSecret("PAIRING_HASH_PEPPER",mode);const rateLimitKeySecret=persistentSecret("RATE_LIMIT_KEY_SECRET",mode);
  if(mode!=="demo"&&(authSigningKey.equals(pairingHashPepper)||authSigningKey.equals(rateLimitKeySecret)||pairingHashPepper.equals(rateLimitKeySecret)))throw new DomainError("RUNTIME_SECRETS_NOT_DISTINCT","Session signing, pairing hash, and rate-limit key secrets must be distinct",500);
  if(mode!=="demo"&&!process.env.REDIS_URL?.trim())throw new DomainError("REDIS_URL_REQUIRED","Paper and Live API runtimes require Redis coordination",500);
  if(mode==="demo")return Object.freeze({
    host: process.env.HOST?.trim() || "127.0.0.1",
    port,
    serverOptions: Object.freeze({mode,authSigningKey,pairingHashPepper,rateLimitKeySecret,trustedProxyHops:trustedProxyHops(),connectionWebUrl,publicApiUrl,allowedCorsOrigins:origins}),
    async close():Promise<void>{}
  });
  const databaseUrl=process.env.DATABASE_URL?.trim();
  if(!databaseUrl)throw new DomainError("DATABASE_URL_REQUIRED","Paper API runtime requires PostgreSQL durable state",500);
  const appleClientId=process.env.APPLE_CLIENT_ID?.trim();
  if(!appleClientId)throw new DomainError("APPLE_CLIENT_ID_REQUIRED","Paper authentication requires an approved Sign in with Apple client identifier",500);
  const storeKit=loadAppleStoreKitRuntime(mode);
  if(storeKit===undefined)throw new DomainError("STOREKIT_RUNTIME_CONFIGURATION_REQUIRED","Paper StoreKit runtime is unavailable",500);
  const deviceTokenEncryptionKey=persistentSecret("DEVICE_TOKEN_ENCRYPTION_KEY",mode);
  if(deviceTokenEncryptionKey.equals(authSigningKey)||deviceTokenEncryptionKey.equals(pairingHashPepper)||deviceTokenEncryptionKey.equals(rateLimitKeySecret))throw new DomainError("RUNTIME_SECRETS_NOT_DISTINCT","Device-token encryption, session signing, pairing hash, and rate-limit key secrets must be distinct",500);
  const database=new PostgresTenantDatabase(databaseUrl);
  const rateLimiter=RedisSlidingWindowRateLimiter.fromUrl(process.env.REDIS_URL!.trim(),240,60_000);
  return Object.freeze({
    host: process.env.HOST?.trim() || "127.0.0.1",
    port,
    serverOptions: Object.freeze({
      mode,
      connectionWebUrl,
      publicApiUrl,
      allowedCorsOrigins: origins,
      rateLimiter,
      rateLimitKeySecret,
      trustedProxyHops:trustedProxyHops(),
      appleVerifier:new AppleIdentityTokenVerifier({clientId:appleClientId}),
      storeKitVerifier:storeKit.transactionVerifier,
      storeKitNotificationHandlers:storeKit.notificationHandlers,
      readinessChecks:[()=>storeKit.healthy()],
      dataStore:new PostgresApiDataStore(database,{deviceBindingKey:authSigningKey,deviceTokenEncryptionKey}),
      sessionManager:new PostgresSessionService(database,authSigningKey),
      pairingService:new PostgresPairingService(database,connectionWebUrl,pairingHashPepper)
    }),
    async close():Promise<void>{await Promise.all([database.close(),rateLimiter.close(),storeKit.close()]);}
  });
}
