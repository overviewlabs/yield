import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AGENT_CATALOG } from "@whox/agent-definitions";
import { DomainError, reconcileBrokerAuthorizationExchange, reconcileBrokerAuthorizationSaga, type ApiErrorBody, type ApprovedMobileBrokerAuthorizationConnector, type BrokerAuthorizationCompletion, type BrokerConnectionSummary, type MobileBrokerAuthorizationStartRequest } from "@whox/contracts";
import { parseRuntimeMode, type RuntimeMode } from "@whox/shared-config";
import {
  CsrfManager,
  DevelopmentAppleIdentityVerifier,
  SessionManager,
  SlidingWindowRateLimiter,
  type AccessClaims,
  type AppleIdentityVerifier,
  type SessionService
} from "./security.js";
import { PairingService, type PairingServiceContract } from "./pairings.js";
import { prepareRiskPolicyUpdate } from "./risk-policy-step-up.js";
import { MemoryDataStore, type ApiDataStore } from "./store.js";
import { UnavailableStepUpAuthenticationVerifier, requireSensitiveOperationStepUp, type StepUpAction, type StepUpAuthenticationVerifier, type VerifiedStepUpAuthentication } from "./step-up.js";
import { UnavailableStoreKitTransactionVerifier, type StoreKitSyncRequest, type StoreKitTransactionVerifier } from "./storekit.js";
import { rateLimitClientKey, trustedClientAddress, type ApiRateLimiter } from "./distributed-rate-limit.js";
import { UnavailableStoreKitServerNotificationHandler, type AppStoreServerNotificationHandler } from "./storekit-notifications.js";
import { MOBILE_BROKER_RETURN_URI, connectorIdentitiesMatch, sanitizedMobileReturn, validateAuthorizationDestination, validateAuthorizationExchange, validateMobileBrokerConnector } from "./mobile-broker-authorization.js";

type Json = unknown;

interface HttpResult {
  readonly status?: number;
  readonly body?: Json;
  readonly headers?: Readonly<Record<string, string>>;
}

interface Context {
  readonly request: IncomingMessage;
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, unknown>>;
  readonly claims?: AccessClaims;
  readonly userId?: string;
  readonly authFromCookie: boolean;
  readonly correlationId: string;
}

type Handler = (context: Context) => Promise<HttpResult> | HttpResult;
interface Route { readonly method: string; readonly pattern: RegExp; readonly names: readonly string[]; readonly authenticated: boolean; readonly handler: Handler; }

export interface ApiServerOptions {
  readonly mode?: RuntimeMode;
  readonly authSigningKey?: Buffer;
  readonly pairingHashPepper?: Buffer;
  readonly connectionWebUrl?: URL;
  readonly publicApiUrl?: URL;
  readonly allowedCorsOrigins?: ReadonlySet<string>;
  readonly appleVerifier?: AppleIdentityVerifier;
  readonly storeKitVerifier?: StoreKitTransactionVerifier;
  readonly stepUpVerifier?: StepUpAuthenticationVerifier;
  readonly dataStore?: ApiDataStore;
  readonly now?: () => Date;
  readonly sessionManager?: SessionService;
  readonly pairingService?: PairingServiceContract;
  readonly rateLimiter?: ApiRateLimiter;
  readonly rateLimitKeySecret?: Buffer;
  readonly trustedProxyHops?: number;
  readonly storeKitNotificationHandlers?: ReadonlyMap<"Sandbox" | "Production", AppStoreServerNotificationHandler>;
  readonly readinessChecks?: readonly (() => boolean | Promise<boolean>)[];
  readonly mobileBrokerAuthorizationConnector?: ApprovedMobileBrokerAuthorizationConnector;
  readonly brokerConnectorTimeoutMs?: number;
}

function compilePath(path: string): { pattern: RegExp; names: string[] } {
  const names: string[] = [];
  const escaped = path.split("/").map((part) => {
    if (part.startsWith(":")) { names.push(part.slice(1)); return "([^/]+)"; }
    return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("/");
  return { pattern: new RegExp(`^${escaped}$`), names };
}

function parseCookies(header: string | undefined): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const pair of (header ?? "").split(";")) {
    const index = pair.indexOf("=");
    if (index > 0) result[pair.slice(0, index).trim()] = decodeURIComponent(pair.slice(index + 1).trim());
  }
  return result;
}

async function readJson(request: IncomingMessage): Promise<Readonly<Record<string, unknown>>> {
  if (request.method === "GET" || request.method === "HEAD") return {};
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_048_576) throw new DomainError("BODY_TOO_LARGE", "Request body exceeds one megabyte", 413);
    chunks.push(buffer);
  }
  if (size === 0) return {};
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new DomainError("JSON_INVALID", "Request body must be valid JSON", 400); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new DomainError("JSON_INVALID", "Request body must be a JSON object", 400);
  return value as Readonly<Record<string, unknown>>;
}

const user = (context: Context): string => {
  if (context.userId === undefined) throw new DomainError("AUTH_REQUIRED", "Authentication is required", 401);
  return context.userId;
};

function pairingIdBody(body: Readonly<Record<string, unknown>>): string {
  if (Object.keys(body).length !== 1 || !Object.prototype.hasOwnProperty.call(body, "pairingId") || typeof body.pairingId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.pairingId)) {
    throw new DomainError("PAIRING_ID_INVALID", "A request containing only a valid pairing identifier is required", 422);
  }
  return body.pairingId;
}

const idempotency = (context: Context): string => {
  const value = context.request.headers["idempotency-key"];
  if (typeof value !== "string" || value.length < 8 || value.length > 200) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "A valid Idempotency-Key header is required", 400);
  return `${context.request.method ?? "UNKNOWN"}:${context.url.pathname}:${value}`;
};

function safeCorrelationId(value: string | string[] | undefined): string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{8,128}$/.test(value) ? value : randomUUID();
}

async function withBrokerConnectorTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new DomainError("BROKER_CONNECTOR_TIMEOUT", "Broker authorization provider did not respond in time", 503));
    }, timeoutMs);
  });
  try { return await Promise.race([operation(controller.signal), deadline]); }
  finally { if (timeout !== undefined) clearTimeout(timeout); }
}

export function createApiServer(options: ApiServerOptions = {}): Server {
  const mode = options.mode ?? parseRuntimeMode(process.env.APP_ENV);
  const store: ApiDataStore = options.dataStore ?? new MemoryDataStore();
  const sessions: SessionService = options.sessionManager ?? new SessionManager(options.authSigningKey ?? randomBytes(48));
  const csrf = new CsrfManager();
  const connectionWebUrl = options.connectionWebUrl ?? new URL("http://localhost:5173");
  const allowedCorsOrigins = options.allowedCorsOrigins ?? new Set([connectionWebUrl.origin]);
  const pairings: PairingServiceContract = options.pairingService ?? new PairingService(connectionWebUrl, options.pairingHashPepper ?? randomBytes(48));
  if (mode !== "demo" && (store.persistenceKind !== "persistent" || sessions.persistenceKind !== "persistent" || pairings.persistenceKind !== "persistent")) {
    throw new DomainError("PERSISTENT_STATE_REQUIRED", "Paper and Live API modes refuse ephemeral data, session, and pairing stores", 503);
  }
  const mobileBrokerAuthorizationConnector = options.mobileBrokerAuthorizationConnector;
  const mobileBrokerMetadata = mobileBrokerAuthorizationConnector === undefined ? undefined : validateMobileBrokerConnector(mobileBrokerAuthorizationConnector);
  if (mobileBrokerMetadata !== undefined && !connectorIdentitiesMatch(pairings.approvedConnectorIdentity, mobileBrokerMetadata.identity)) {
    throw new DomainError("MOBILE_BROKER_CONNECTOR_IDENTITY_MISMATCH", "Mobile authorization connector does not match the approved pairing boundary", 503);
  }
  const apple = options.appleVerifier ?? new DevelopmentAppleIdentityVerifier(mode === "demo");
  const storeKitVerifier = options.storeKitVerifier ?? new UnavailableStoreKitTransactionVerifier();
  const stepUpVerifier = options.stepUpVerifier ?? new UnavailableStepUpAuthenticationVerifier();
  const globalRate: ApiRateLimiter = options.rateLimiter ?? new SlidingWindowRateLimiter(240, 60_000);
  const rateLimitKeySecret = options.rateLimitKeySecret ?? randomBytes(48);
  const trustedProxyHops = options.trustedProxyHops ?? 0;
  const storeKitNotificationHandlers = options.storeKitNotificationHandlers ?? new Map();
  const now = options.now ?? (() => new Date());
  const brokerConnectorTimeoutMs = options.brokerConnectorTimeoutMs ?? 15_000;
  if (!Number.isInteger(brokerConnectorTimeoutMs) || brokerConnectorTimeoutMs < 1 || brokerConnectorTimeoutMs > 60_000) throw new DomainError("BROKER_CONNECTOR_TIMEOUT_INVALID", "Broker connector timeout is invalid", 500);
  const routes: Route[] = [];
  const add = (method: string, path: string, authenticated: boolean, handler: Handler): void => {
    const { pattern, names } = compilePath(path);
    routes.push({ method, pattern, names, authenticated, handler });
  };
  const mutate = async <T>(context: Context, operation: () => Promise<T> | T): Promise<T> => await store.idempotentAsync(user(context), idempotency(context), context.body, async () => await operation());
  const requireStepUp = async (context: Context, action: StepUpAction, resourceId: string, verificationNow: Date): Promise<VerifiedStepUpAuthentication> => {
    const userId = user(context);
    return await requireSensitiveOperationStepUp({
      verifier: stepUpVerifier,
      userId,
      sessionId: context.claims!.sessionId,
      authenticatedDeviceId: context.claims!.deviceId,
      action,
      resourceId,
      body: context.body,
      now: verificationNow,
      consume: async (verification) => await store.consumeStepUpAuthentication(userId, verification, verificationNow.toISOString())
    });
  };
  const disconnectBrokerAuthorization = async (context: Context): Promise<Readonly<Record<string, unknown>>> => {
    const verificationNow = now();
    const userId = user(context);
    await requireStepUp(context, "disconnect_broker_connection", "robinhood_mcp", verificationNow);
    if (pairings.authorizationRevocationTarget === undefined) {
      if (mode === "demo") return Object.freeze({ status: "disconnected", tokensRevoked: true });
      throw new DomainError("ROBINHOOD_DISCONNECT_UNAVAILABLE", "Provider authorization ownership is not available in this runtime", 503);
    }
    const sagaPersistence = pairings.loadAuthorizationSaga !== undefined && pairings.requestAuthorizationRevocation !== undefined && pairings.acknowledgeAuthorizationConfirmation !== undefined && pairings.acknowledgeAuthorizationRevocation !== undefined
      ? {
          loadAuthorizationSaga: async (ownerUserId: string, sagaId: string, recoveryNow: string) => await pairings.loadAuthorizationSaga!(ownerUserId, sagaId, recoveryNow),
          requestAuthorizationRevocation: async (ownerUserId: string, sagaId: string, errorCode: string, recoveryNow: string) => await pairings.requestAuthorizationRevocation!(ownerUserId, sagaId, errorCode, recoveryNow),
          acknowledgeAuthorizationConfirmation: async (ownerUserId: string, sagaId: string, recoveryNow: string) => await pairings.acknowledgeAuthorizationConfirmation!(ownerUserId, sagaId, recoveryNow),
          acknowledgeAuthorizationRevocation: async (ownerUserId: string, sagaId: string, recoveryNow: string) => await pairings.acknowledgeAuthorizationRevocation!(ownerUserId, sagaId, recoveryNow)
        }
      : undefined;
    const exchangePersistence = pairings.loadAuthorizationExchange !== undefined && pairings.requestAuthorizationExchangeRevocation !== undefined && pairings.acknowledgeAuthorizationExchangeRevocation !== undefined
      ? {
          loadAuthorizationExchange: async (ownerUserId: string, exchangeTransactionId: string, recoveryNow: string) => await pairings.loadAuthorizationExchange!(ownerUserId, exchangeTransactionId, recoveryNow),
          requestAuthorizationExchangeRevocation: async (ownerUserId: string, exchangeTransactionId: string, errorCode: string, recoveryNow: string) => await pairings.requestAuthorizationExchangeRevocation!(ownerUserId, exchangeTransactionId, errorCode, recoveryNow),
          acknowledgeAuthorizationExchangeRevocation: async (ownerUserId: string, exchangeTransactionId: string, recoveryNow: string) => await pairings.acknowledgeAuthorizationExchangeRevocation!(ownerUserId, exchangeTransactionId, recoveryNow)
        }
      : undefined;
    for (let transition = 0; transition < 3; transition += 1) {
      const recoveryNow = now().toISOString();
      const target = await pairings.authorizationRevocationTarget(userId, recoveryNow);
      if (target.kind === "none") return Object.freeze({ status: "disconnected", tokensRevoked: true });
      if (target.kind === "demo") {
        if (mode !== "demo" || pairings.disconnectDemoAuthorization === undefined) throw new DomainError("BROKER_REVOCATION_BINDING_UNAVAILABLE", "Broker authorization has no provider revocation binding", 503);
        await pairings.disconnectDemoAuthorization(userId, recoveryNow);
        return Object.freeze({ status: "disconnected", tokensRevoked: true });
      }
      if (target.kind === "unmanaged") throw new DomainError("BROKER_REVOCATION_BINDING_UNAVAILABLE", "Broker authorization has no durable provider revocation binding", 503);
      if (mobileBrokerAuthorizationConnector === undefined) throw new DomainError("ROBINHOOD_DISCONNECT_UNAVAILABLE", "Provider token revocation requires the approved isolated connection adapter", 503);
      try {
        if (target.kind === "saga") {
          if (sagaPersistence === undefined) throw new DomainError("ROBINHOOD_DISCONNECT_UNAVAILABLE", "Broker authorization recovery persistence is unavailable", 503);
          const staged = await sagaPersistence.requestAuthorizationRevocation(userId, target.authorizationSagaId, "USER_REQUESTED_DISCONNECT", recoveryNow);
          if (staged === "revoked") continue;
          const operation = await reconcileBrokerAuthorizationSaga(sagaPersistence, mobileBrokerAuthorizationConnector, userId, target.authorizationSagaId, recoveryNow, undefined, () => now().toISOString(), brokerConnectorTimeoutMs);
          if (operation !== "revoked") throw new DomainError("BROKER_REVOCATION_PENDING", "Broker authorization revocation is still pending", 503);
          continue;
        }
        if (exchangePersistence === undefined) throw new DomainError("ROBINHOOD_DISCONNECT_UNAVAILABLE", "Broker exchange recovery persistence is unavailable", 503);
        const staged = await exchangePersistence.requestAuthorizationExchangeRevocation(userId, target.exchangeTransactionId, "USER_REQUESTED_DISCONNECT", recoveryNow);
        if (staged === "completed" || staged === "revoked") continue;
        const operation = await reconcileBrokerAuthorizationExchange(exchangePersistence, mobileBrokerAuthorizationConnector, userId, target.exchangeTransactionId, recoveryNow, undefined, brokerConnectorTimeoutMs);
        if (operation !== "revoked") throw new DomainError("BROKER_REVOCATION_PENDING", "Broker authorization revocation is still pending", 503);
      } catch (error) {
        if (error instanceof DomainError && ["ROBINHOOD_DISCONNECT_UNAVAILABLE", "BROKER_REVOCATION_PENDING"].includes(error.code)) throw error;
        throw new DomainError("BROKER_REVOCATION_PENDING", "The provider revocation outcome is not yet known; durable recovery will retry it", 503);
      }
    }
    throw new DomainError("BROKER_REVOCATION_PENDING", "Broker authorization revocation has not reached a terminal acknowledgment", 503);
  };

  add("GET", "/healthz", false, () => ({ body: { status: "ok", mode, liveTradingReachable: false } }));
  add("GET", "/readyz", false, async () => {
    const checks = await Promise.all([
      store.healthy(),
      sessions.healthy(),
      pairings.healthy(),
      globalRate.healthy?.() ?? true,
      mobileBrokerAuthorizationConnector?.healthy?.() ?? true,
      ...(options.readinessChecks ?? []).map(async (check) => await check())
    ]);
    if (checks.some((healthy) => !healthy)) throw new DomainError("RUNTIME_NOT_READY", "A required persistent runtime dependency is unavailable or not migrated", 503);
    return { body: { status: "ready", mode, persistent: store.persistenceKind === "persistent", liveTradingReachable: false } };
  });
  add("GET", "/openapi.json", false, async () => ({ body: JSON.parse(await readFile(new URL("../../../packages/contracts/openapi.json", import.meta.url), "utf8")) }));

  add("POST", "/v1/auth/apple", false, async (context) => {
    const token = typeof context.body.identityToken === "string" ? context.body.identityToken : "";
    const deviceId = typeof context.body.deviceId === "string" ? context.body.deviceId.trim() : "";
    const nonce = typeof context.body.nonce === "string" ? context.body.nonce : undefined;
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(deviceId)) throw new DomainError("DEVICE_ID_INVALID", "A valid device identifier is required", 422);
    if (mode !== "demo" && (nonce === undefined || nonce.length < 16 || nonce.length > 256)) throw new DomainError("APPLE_NONCE_REQUIRED", "A valid raw Sign in with Apple nonce is required", 422);
    const identity = await apple.verify(token, { ...(nonce === undefined ? {} : { nonce }), now: now() });
    if (mode !== "demo") {
      if (identity.assertionDigest === undefined || identity.assertionExpiresAt === undefined) throw new DomainError("APPLE_IDENTITY_INVALID", "Verified Apple identity is missing replay-binding metadata", 401);
      await store.consumeAppleIdentityAssertion(identity.assertionDigest, identity.assertionExpiresAt, now().toISOString());
    }
    const account = await store.userForAppleSubject(identity.appleSubject, identity.emailVerified ? identity.email : undefined, identity.displayName);
    const issued = await sessions.create(account.userId, deviceId, now());
    return {
      status: 200,
      headers: { "set-cookie": `whox_session=${encodeURIComponent(issued.accessToken)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=900` },
      body: { userID: account.userId, displayName: account.name, email: account.email, accessToken: issued.accessToken, accessTokenExpiresAt: issued.accessExpiresAt, refreshToken: issued.refreshToken, refreshTokenExpiresAt: issued.refreshExpiresAt, sessionID: issued.sessionId }
    };
  });
  add("POST", "/v1/auth/refresh", false, async (context) => ({ body: await sessions.rotate(String(context.body.sessionId ?? ""), String(context.body.refreshToken ?? ""), now()) }));
  add("POST", "/v1/auth/logout", true, async (context) => {
    await sessions.revoke(context.claims!.sessionId, now(), user(context));
    return { status: 204, headers: { "set-cookie": "whox_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0" } };
  });
  add("GET", "/v1/auth/csrf", true, (context) => ({ body: { csrfToken: csrf.issue(context.claims!.sessionId, now().getTime()) } }));
  add("GET", "/v1/sessions", true, async (context) => ({ body: { data: await sessions.list(user(context)) } }));
  add("DELETE", "/v1/sessions/:id", true, async (context) => {
    const target = context.params.id!;
    const owned = (await sessions.list(user(context))).some((item) => item.sessionId === target);
    if (!owned) throw new DomainError("SESSION_NOT_FOUND", "Session was not found", 404);
    await sessions.revoke(target, now(), user(context));
    return { status: 204 };
  });

  add("GET", "/v1/me", true, async (context) => ({ body: await store.getUser(user(context)) }));
  add("PATCH", "/v1/me", true, async (context) => ({ body: await mutate(context, async () => await store.patchUser(user(context), context.body)) }));
  add("GET", "/v1/onboarding", true, async (context) => ({ body: await store.onboarding(user(context)) }));
  add("PATCH", "/v1/onboarding/step", true, async (context) => ({ body: await mutate(context, async () => await store.updateOnboarding(user(context), Number(context.body.step))) }));
  add("POST", "/v1/eligibility", true, async (context) => ({ body: await mutate(context, async () => await store.recordEligibility(user(context), context.body, now().toISOString())) }));
  add("POST", "/v1/risk-assessments", true, async (context) => ({ body: await mutate(context, async () => await store.createRiskAssessment(user(context), context.body, now().toISOString())) }));
  add("GET", "/v1/risk-assessments/current", true, async (context) => ({ body: await store.currentRiskAssessment(user(context)) }));
  add("GET", "/v1/legal-documents", true, async (context) => ({ body: { data: await store.legalDocuments(user(context)) } }));
  add("POST", "/v1/legal-consents", true, async (context) => ({ body: await mutate(context, async () => await store.recordLegalConsents(user(context), context.body, context.claims!.sessionId, context.claims!.deviceId, now().toISOString())) }));

  add("GET", "/v1/plans", true, async (context) => ({ body: { data: await store.plans(user(context)), priceSource: "StoreKit; display prices must be supplied by the client StoreKit response" } }));
  add("GET", "/v1/subscription", true, async (context) => ({ body: await store.subscription(user(context)) }));
  add("POST", "/v1/subscription/sync", true, async (context) => ({ body: await mutate(context, async () => {
    const request = { productID: String(context.body.productID ?? ""), transactionID: String(context.body.transactionID ?? ""), originalTransactionID: String(context.body.originalTransactionID ?? ""), signedTransactionJWS: String(context.body.signedTransactionJWS ?? "") } satisfies StoreKitSyncRequest;
    const verified = await storeKitVerifier.verify(request, user(context));
    await store.syncVerifiedSubscription(user(context), verified);
    return { entitledProductIDs: await store.entitledProductIds(user(context)), reconciledAt: now().toISOString() };
  }) }));
  add("GET", "/v1/entitlements", true, async (context) => ({ body: await store.entitlements(user(context)) }));
  for (const [pathEnvironment, environment] of [["sandbox", "Sandbox"], ["production", "Production"]] as const) {
    add("POST", `/v1/storekit/notifications/${pathEnvironment}`, false, async (context) => {
      const handler = storeKitNotificationHandlers.get(environment) ?? new UnavailableStoreKitServerNotificationHandler(environment);
      const signedPayload = typeof context.body.signedPayload === "string" ? context.body.signedPayload : "";
      return { body: await handler.process(signedPayload) };
    });
  }

  add("POST", "/v1/brokers/robinhood/pairings", true, async (context) => ({ status: 201, body: await mutate(context, async () => await pairings.create(user(context), context.claims!.sessionId, now().toISOString())) }));
  add("POST", "/v1/brokers/robinhood/pairings/claim", true, async (context) => ({ body: await pairings.claim(user(context), context.claims!.sessionId, String(context.body.code ?? ""), `${context.request.socket.remoteAddress ?? "unknown"}:${user(context)}`, now().toISOString()) }));
  add("GET", "/v1/brokers/robinhood/pairings/:id", true, async (context) => ({ body: await pairings.get(user(context), context.claims!.sessionId, context.params.id!, now().toISOString()) }));
  add("DELETE", "/v1/brokers/robinhood/pairings/:id", true, async (context) => { await pairings.cancel(user(context), context.claims!.sessionId, context.params.id!, now().toISOString()); return { status: 204 }; });
  add("POST", "/v1/brokers/robinhood/oauth/start", true, async (context) => {
    if (mode !== "demo") throw new DomainError("ROBINHOOD_AUTHORIZATION_UNAVAILABLE", "Robinhood production authorization requires an approved provider contract and isolated connection-service adapter", 503);
    const pairingId = String(context.body.pairingId ?? "");
    const authorizationState = await pairings.beginAuthorization(user(context), context.claims!.sessionId, pairingId, now().toISOString());
    const authorizationUrl = new URL("/v1/brokers/robinhood/oauth/demo-complete", options.publicApiUrl ?? new URL("http://127.0.0.1:8080"));
    authorizationUrl.searchParams.set("pairingId", pairingId);
    authorizationUrl.searchParams.set("state", authorizationState);
    return { body: { authorizationUrl: authorizationUrl.href } };
  });
  add("GET", "/v1/brokers/robinhood/oauth/demo-complete", true, async (context) => {
    if (mode !== "demo") throw new DomainError("ROUTE_NOT_FOUND", "Route was not found", 404);
    const pairingId = context.url.searchParams.get("pairingId") ?? "";
    const authorizationState = context.url.searchParams.get("state") ?? "";
    const connection: BrokerConnectionSummary = { status: "connected", maskedAccountIdentifier: "Demo Agentic account •••• 2841", lastSuccessfulSync: now().toISOString(), capabilities: ["get_accounts", "get_portfolio", "get_equity_quotes", "review_equity_order"], equityTradingAvailable: false, optionsTradingAvailable: false };
    await pairings.completeForSession(user(context), context.claims!.sessionId, pairingId, authorizationState, connection, now().toISOString());
    const redirect = new URL(connectionWebUrl);
    redirect.searchParams.set("result", "connected");
    redirect.searchParams.set("pairingId", pairingId);
    return { status: 302, headers: { location: redirect.href, "cache-control": "no-store" } };
  });
  add("GET", "/v1/brokers/robinhood/oauth/callback", false, () => { throw new DomainError("ROBINHOOD_AUTHORIZATION_UNAVAILABLE", "OAuth callback exchange is delegated to the isolated connection service and is not configured", 503); });
  add("POST", "/v1/brokers/robinhood/mobile-oauth/start", true, async (context) => ({ body: await mutate(context, async () => {
    if (mobileBrokerAuthorizationConnector === undefined || mobileBrokerMetadata === undefined || pairings.beginMobileAuthorization === undefined || pairings.resetMobileAuthorization === undefined || pairings.mobileCallbackSecrets === undefined || pairings.beginMobileExchangeForSession === undefined || pairings.completeMobileForSession === undefined || pairings.loadAuthorizationExchange === undefined || pairings.requestAuthorizationExchangeRevocation === undefined || pairings.acknowledgeAuthorizationExchangeRevocation === undefined || pairings.loadAuthorizationSaga === undefined || pairings.requestAuthorizationRevocation === undefined || pairings.acknowledgeAuthorizationConfirmation === undefined || pairings.acknowledgeAuthorizationRevocation === undefined || pairings.concludeMobileWithoutConnection === undefined) {
      throw new DomainError("ROBINHOOD_MOBILE_OAUTH_UNAVAILABLE", "Mobile authorization is disabled until an approved provider OAuth contract and callback exchange adapter are configured", 503);
    }
    const pairingId = pairingIdBody(context.body);
    const userId = user(context);
    const sessionId = context.claims!.sessionId;
    const authorization = await pairings.beginMobileAuthorization(userId, sessionId, pairingId, mobileBrokerMetadata.redirectUri, MOBILE_BROKER_RETURN_URI, now().toISOString());
    const request: MobileBrokerAuthorizationStartRequest = Object.freeze({
      state: authorization.state,
      ...(mobileBrokerMetadata.oidcNonceRequired ? { nonce: authorization.nonce } : {}),
      codeChallenge: authorization.codeChallenge,
      codeChallengeMethod: "S256",
      clientId: mobileBrokerMetadata.clientId,
      scopes: Object.freeze([...mobileBrokerMetadata.allowedScopes]),
      redirectUri: mobileBrokerMetadata.redirectUri,
      resourceUri: mobileBrokerMetadata.identity.resourceUri
    });
    try {
      const started = await withBrokerConnectorTimeout(async (signal) => await mobileBrokerAuthorizationConnector.beginAuthorization(request, signal), brokerConnectorTimeoutMs);
      const authorizationUrl = validateAuthorizationDestination(started.authorizationUrl, mobileBrokerMetadata, request);
      return { authorizationUrl, callbackScheme: "metis", returnUrl: MOBILE_BROKER_RETURN_URI, pairingId, expiresAt: authorization.expiresAt };
    } catch (error) {
      if (!authorization.resumed) await pairings.resetMobileAuthorization(userId, sessionId, pairingId, authorization.state, now().toISOString());
      if (error instanceof DomainError) throw error;
      throw new DomainError("BROKER_AUTHORIZATION_PROVIDER_UNAVAILABLE", "Broker authorization provider is temporarily unavailable", 503);
    }
  }) }));
  add("POST", "/v1/brokers/robinhood/mobile-oauth/abort", true, async (context) => ({ body: await mutate(context, async () => {
    if (pairings.abortMobileAuthorization === undefined) throw new DomainError("ROBINHOOD_MOBILE_OAUTH_UNAVAILABLE", "Mobile authorization state cannot be managed by this runtime", 503);
    const pairingId = pairingIdBody(context.body);
    await pairings.abortMobileAuthorization(user(context), context.claims!.sessionId, pairingId, now().toISOString());
    return { pairingId, status: "pending" };
  }) }));
  add("GET", "/v1/brokers/robinhood/mobile-oauth/callback", false, async (context) => {
    if (mobileBrokerAuthorizationConnector === undefined || mobileBrokerMetadata === undefined || pairings.mobileCallbackSecrets === undefined || pairings.beginMobileExchangeForSession === undefined || pairings.completeMobileForSession === undefined || pairings.loadAuthorizationExchange === undefined || pairings.requestAuthorizationExchangeRevocation === undefined || pairings.acknowledgeAuthorizationExchangeRevocation === undefined || pairings.loadAuthorizationSaga === undefined || pairings.requestAuthorizationRevocation === undefined || pairings.acknowledgeAuthorizationConfirmation === undefined || pairings.acknowledgeAuthorizationRevocation === undefined || pairings.concludeMobileWithoutConnection === undefined) {
      throw new DomainError("ROBINHOOD_MOBILE_OAUTH_UNAVAILABLE", "Mobile authorization callback exchange is not configured", 503);
    }
    const callbackKeys = [...new Set(context.url.searchParams.keys())];
    const sensitiveCallbackKeys = new Set(["access_token", "refresh_token", "id_token", "token"]);
    if (callbackKeys.some((key) => sensitiveCallbackKeys.has(key))) throw new DomainError("MOBILE_OAUTH_ARTIFACT_REJECTED", "Authorization artifacts are not accepted in callback URLs", 400);
    const allowedCallbackKeys = new Set(["code", "state", "iss", "error", "error_description", "error_uri"]);
    if (callbackKeys.some((key) => !allowedCallbackKeys.has(key))) throw new DomainError("MOBILE_OAUTH_CALLBACK_INVALID", "Mobile authorization callback contains an unexpected parameter", 400);
    const states = context.url.searchParams.getAll("state");
    const codes = context.url.searchParams.getAll("code");
    const providerErrors = context.url.searchParams.getAll("error");
    const providerErrorDescriptions = context.url.searchParams.getAll("error_description");
    const providerErrorUris = context.url.searchParams.getAll("error_uri");
    const issuers = context.url.searchParams.getAll("iss");
    if (states.length !== 1 || states[0] === "" || states[0]!.length > 2_048 || codes.length > 1 || providerErrors.length > 1 || providerErrorDescriptions.length > 1 || providerErrorUris.length > 1 || issuers.length > 1 || (codes.length === 1) === (providerErrors.length === 1) || (providerErrors.length === 0 && (providerErrorDescriptions.length !== 0 || providerErrorUris.length !== 0))) {
      throw new DomainError("MOBILE_OAUTH_CALLBACK_INVALID", "Mobile authorization callback is invalid or expired", 400);
    }
    if (providerErrorDescriptions.some((value) => value.length > 512 || /[\u0000-\u001f\u007f]/.test(value))) throw new DomainError("MOBILE_OAUTH_CALLBACK_INVALID", "Mobile authorization callback contains invalid error metadata", 400);
    if (providerErrorUris.length === 1) {
      let errorUri: URL;
      try { errorUri = new URL(providerErrorUris[0]!); }
      catch { throw new DomainError("MOBILE_OAUTH_CALLBACK_INVALID", "Mobile authorization callback contains invalid error metadata", 400); }
      if (providerErrorUris[0]!.length > 2_048 || errorUri.protocol !== "https:" || errorUri.username !== "" || errorUri.password !== "" || errorUri.hash !== "") throw new DomainError("MOBILE_OAUTH_CALLBACK_INVALID", "Mobile authorization callback contains invalid error metadata", 400);
    }
    if ((mobileBrokerMetadata.authorizationResponseIssuerRequired && issuers.length !== 1) || (issuers.length === 1 && issuers[0] !== mobileBrokerMetadata.identity.authorizationIssuer)) {
      throw new DomainError("MOBILE_OAUTH_ISSUER_INVALID", "Mobile authorization response issuer is invalid", 400);
    }
    const state = states[0]!;
    const secrets = await pairings.mobileCallbackSecrets(state, now().toISOString());
    if (secrets.redirectUri !== mobileBrokerMetadata.redirectUri || secrets.mobileReturnUri !== MOBILE_BROKER_RETURN_URI) {
      await pairings.concludeMobileWithoutConnection(secrets.ownerUserId, secrets.creatorSessionId, secrets.pairingId, state, "error", now().toISOString());
      throw new DomainError("MOBILE_OAUTH_CALLBACK_INVALID", "Mobile authorization callback binding is invalid", 400);
    }
    const redirect = (result: "verification_pending" | "canceled" | "failed"): HttpResult => ({ status: 302, headers: { location: sanitizedMobileReturn(result, secrets.pairingId), "cache-control": "no-store", "referrer-policy": "no-referrer" } });
    if (providerErrors.length === 1) {
      const providerError = providerErrors[0]!;
      if (providerError === "" || providerError.length > 200 || /[\u0000-\u001f\u007f]/.test(providerError)) {
        await pairings.concludeMobileWithoutConnection(secrets.ownerUserId, secrets.creatorSessionId, secrets.pairingId, state, "error", now().toISOString());
        return redirect("failed");
      }
      const canceled = providerError === "access_denied";
      await pairings.concludeMobileWithoutConnection(secrets.ownerUserId, secrets.creatorSessionId, secrets.pairingId, state, canceled ? "canceled" : "error", now().toISOString());
      return redirect(canceled ? "canceled" : "failed");
    }
    const code = codes[0]!;
    if (code === "" || code.length > 4_096 || /[\u0000-\u001f\u007f]/.test(code)) {
      await pairings.concludeMobileWithoutConnection(secrets.ownerUserId, secrets.creatorSessionId, secrets.pairingId, state, "error", now().toISOString());
      return redirect("failed");
    }
    const exchangeTransactionId = randomUUID();
    const exchangeStartedAt = now();
    const cleanupAfter = new Date(exchangeStartedAt.getTime() + brokerConnectorTimeoutMs + 5_000).toISOString();
    try {
      await pairings.beginMobileExchangeForSession(secrets.ownerUserId, secrets.creatorSessionId, secrets.pairingId, state, exchangeTransactionId, cleanupAfter, exchangeStartedAt.toISOString());
    } catch {
      try { await pairings.concludeMobileWithoutConnection(secrets.ownerUserId, secrets.creatorSessionId, secrets.pairingId, state, "error", now().toISOString()); }
      catch { /* No provider call occurred; the consumed callback simply expires closed. */ }
      return redirect("failed");
    }
    const exchangePersistence = {
      loadAuthorizationExchange: async (userId: string, transactionId: string, recoveryNow: string) => await pairings.loadAuthorizationExchange!(userId, transactionId, recoveryNow),
      requestAuthorizationExchangeRevocation: async (userId: string, transactionId: string, errorCode: string, recoveryNow: string) => await pairings.requestAuthorizationExchangeRevocation!(userId, transactionId, errorCode, recoveryNow),
      acknowledgeAuthorizationExchangeRevocation: async (userId: string, transactionId: string, recoveryNow: string) => await pairings.acknowledgeAuthorizationExchangeRevocation!(userId, transactionId, recoveryNow)
    };
    const revokeExchange = async (errorCode: string): Promise<void> => {
      const recoveryNow = now().toISOString();
      try {
        await pairings.requestAuthorizationExchangeRevocation!(secrets.ownerUserId, exchangeTransactionId, errorCode, recoveryNow);
        await reconcileBrokerAuthorizationExchange(exchangePersistence, mobileBrokerAuthorizationConnector, secrets.ownerUserId, exchangeTransactionId, recoveryNow, undefined, brokerConnectorTimeoutMs);
      } catch { /* The durable immediate/delayed recovery jobs retain ownership. */ }
    };
    let rawExchange: unknown;
    try {
      rawExchange = await withBrokerConnectorTimeout(async (signal) => await mobileBrokerAuthorizationConnector.exchangeAuthorizationCode(Object.freeze({
        exchangeTransactionId,
        code,
        codeVerifier: secrets.codeVerifier,
        ...(mobileBrokerMetadata.oidcNonceRequired ? { nonce: secrets.nonce } : {}),
        ...(issuers.length === 1 ? { issuer: issuers[0] } : {}),
        redirectUri: secrets.redirectUri,
        resourceUri: mobileBrokerMetadata.identity.resourceUri
      }), signal), brokerConnectorTimeoutMs);
    } catch {
      await revokeExchange("AUTHORIZATION_EXCHANGE_FAILED");
      return redirect("failed");
    }
    let completion: BrokerAuthorizationCompletion;
    try { completion = validateAuthorizationExchange(rawExchange, mobileBrokerMetadata.identity, exchangeTransactionId).completion; }
    catch {
      await revokeExchange("AUTHORIZATION_EXCHANGE_INVALID");
      return redirect("failed");
    }
    let authorizationSagaId:string;
    try {
      const persistedAt=now();
      const provisionalCredentialExpiresAt=new Date(persistedAt.getTime()+mobileBrokerMetadata.provisionalCredentialTtlSeconds*1_000).toISOString();
      authorizationSagaId=(await pairings.completeMobileForSession(secrets.ownerUserId,secrets.creatorSessionId,secrets.pairingId,state,exchangeTransactionId,provisionalCredentialExpiresAt,completion,persistedAt.toISOString())).authorizationSagaId;
    } catch {
      await revokeExchange("AUTHORIZATION_EXCHANGE_PERSISTENCE_FAILED");
      return redirect("failed");
    }
    const sagaPersistence={
      loadAuthorizationSaga:async(userId:string,sagaId:string,recoveryNow:string)=>await pairings.loadAuthorizationSaga!(userId,sagaId,recoveryNow),
      requestAuthorizationRevocation:async(userId:string,sagaId:string,errorCode:string,recoveryNow:string)=>await pairings.requestAuthorizationRevocation!(userId,sagaId,errorCode,recoveryNow),
      acknowledgeAuthorizationConfirmation:async(userId:string,sagaId:string,recoveryNow:string)=>await pairings.acknowledgeAuthorizationConfirmation!(userId,sagaId,recoveryNow),
      acknowledgeAuthorizationRevocation:async(userId:string,sagaId:string,recoveryNow:string)=>await pairings.acknowledgeAuthorizationRevocation!(userId,sagaId,recoveryNow)
    };
    try { await reconcileBrokerAuthorizationSaga(sagaPersistence,mobileBrokerAuthorizationConnector,secrets.ownerUserId,authorizationSagaId,now().toISOString(),undefined,()=>now().toISOString(),brokerConnectorTimeoutMs); }
    catch { /* Durable recovery job owns every unknown confirmation outcome. */ }
    return redirect("verification_pending");
  });
  add("GET", "/v1/brokers/robinhood/connection", true, async (context) => ({ body: await store.brokerConnection(user(context)) }));
  add("POST", "/v1/brokers/robinhood/reconnect", true, async (context) => ({ body: await mutate(context, async () => Object.freeze({ ...await disconnectBrokerAuthorization(context), reconnectReady: true })) }));
  add("DELETE", "/v1/brokers/robinhood/connection", true, async (context) => ({ body: await mutate(context, async () => await disconnectBrokerAuthorization(context)) }));

  add("GET", "/v1/dashboard", true, async (context) => ({ body: await store.dashboard(user(context)) }));
  add("GET", "/v1/portfolio", true, async (context) => ({ body: await store.portfolio(user(context)) }));
  add("GET", "/v1/portfolio/history", true, async (context) => ({ body: await store.portfolioHistory(user(context)) }));
  add("GET", "/v1/positions", true, async (context) => ({ body: { data: await store.positions(user(context)), nextCursor: null } }));
  add("GET", "/v1/positions/:id", true, async (context) => ({ body: await store.position(user(context), context.params.id!) }));
  add("GET", "/v1/performance", true, async (context) => ({ body: await store.performance(user(context)) }));

  add("GET", "/v1/agents", true, () => ({ body: { data: AGENT_CATALOG } }));
  add("GET", "/v1/agents/:id", true, (context) => {
    const agent = AGENT_CATALOG.find((item) => item.agentId === context.params.id);
    if (agent === undefined) throw new DomainError("AGENT_NOT_FOUND", "Agent was not found", 404);
    return { body: agent };
  });
  add("GET", "/v1/user-agents", true, async (context) => ({ body: { data: await store.userAgents(user(context)) } }));
  add("POST", "/v1/user-agents", true, async (context) => ({ status: 201, body: await mutate(context, async () => await store.addUserAgent(user(context), context.body, now().toISOString())) }));
  add("PATCH", "/v1/user-agents/:id", true, async (context) => ({ body: await mutate(context, async () => await store.patchUserAgent(user(context), context.params.id!, context.body, now().toISOString())) }));
  add("POST", "/v1/user-agents/:id/pause", true, async (context) => ({ body: await mutate(context, async () => await store.setAgentStatus(user(context), context.params.id!, "paused", now().toISOString())) }));
  add("POST", "/v1/user-agents/:id/resume", true, async (context) => ({ body: await mutate(context, async () => {
    const verificationNow = now();
    await requireStepUp(context, "resume_user_agent", context.params.id!, verificationNow);
    return await store.setAgentStatus(user(context), context.params.id!, "monitoring", verificationNow.toISOString());
  }) }));
  add("DELETE", "/v1/user-agents/:id", true, async (context) => { await mutate(context, async () => await store.deleteUserAgent(user(context), context.params.id!, now().toISOString())); return { status: 204 }; });
  add("GET", "/v1/user-agents/:id/runs", true, async (context) => ({ body: { data: await store.agentRuns(user(context), context.params.id!) } }));

  add("GET", "/v1/risk-policy", true, async (context) => ({ body: await store.riskPolicy(user(context)) }));
  add("POST", "/v1/risk-policy/preview", true, async (context) => {
    const userId = user(context);
    const current = await store.riskPolicy(userId);
    const prepared = prepareRiskPolicyUpdate(current, context.body, userId, now().toISOString());
    return { body: {
      relaxationRequired: prepared.relaxationRequired,
      stepUpResourceId: prepared.stepUpResourceId,
      currentPolicyId: current.policyId,
      currentVersion: current.version
    } };
  });
  add("PATCH", "/v1/risk-policy", true, async (context) => ({ body: await mutate(context, async () => {
    const userId = user(context);
    const verificationNow = now();
    const current = await store.riskPolicy(userId);
    const prepared = prepareRiskPolicyUpdate(current, context.body, userId, verificationNow.toISOString());
    if (prepared.relaxationRequired) await requireStepUp(context, "relax_risk_policy", prepared.stepUpResourceId, verificationNow);
    return await store.setRiskPolicy(userId, prepared.candidate);
  }) }));
  add("GET", "/v1/risk-events", true, async (context) => ({ body: { data: await store.riskEvents(user(context)) } }));
  add("POST", "/v1/risk/pause-all", true, async (context) => ({ body: await mutate(context, async () => await store.pauseAll(user(context), now().toISOString())) }));
  add("POST", "/v1/risk/resume-all", true, async (context) => ({ body: await mutate(context, async () => {
    const userId = user(context);
    const verificationNow = now();
    await requireStepUp(context, "resume_all_user_agents", userId, verificationNow);
    return await store.resumeAll(userId, verificationNow.toISOString());
  }) }));

  add("GET", "/v1/proposals", true, async (context) => ({ body: { data: await store.proposals(user(context)), nextCursor: null } }));
  add("GET", "/v1/proposals/:id", true, async (context) => ({ body: await store.proposal(user(context), context.params.id!) }));
  add("POST", "/v1/proposals/:id/approve", true, async (context) => {
    const userId = user(context);
    const proposalId = context.params.id!;
    const key = idempotency(context);
    return { body: await store.idempotentAsync(userId, key, context.body, async () => {
      const proposal = await store.proposal(userId, proposalId);
      if (context.body.mode !== undefined && context.body.mode !== proposal.proposal.environment) throw new DomainError("PROPOSAL_MODE_MISMATCH", "The approval mode does not match the proposal environment", 409);
      const verificationNow = now();
      const verification = await requireStepUp(context, "approve_trade_proposal", proposalId, verificationNow);
      return await store.approveProposal(userId, proposalId, verification, key, verificationNow.toISOString());
    }) };
  });
  add("POST", "/v1/proposals/:id/reject", true, async (context) => ({ body: await mutate(context, async () => await store.proposalAction(user(context), context.params.id!, "USER_REJECTED", now().toISOString())) }));
  add("GET", "/v1/orders", true, async (context) => ({ body: { data: await store.orders(user(context)), nextCursor: null } }));
  add("GET", "/v1/orders/:id", true, async (context) => ({ body: await store.order(user(context), context.params.id!) }));
  add("POST", "/v1/orders/:id/cancel", true, async (context) => ({ body: await mutate(context, async () => await store.cancelOrder(user(context), context.params.id!, now().toISOString())) }));
  add("POST", "/v1/positions/close-review", true, async (context) => ({ body: await mutate(context, async () => ({ reviewId: randomUUID(), status: "review_only", orders: [], warnings: ["No closing order is submitted until explicit authenticated approval."] })) }));

  add("GET", "/v1/activity", true, async (context) => ({ body: { data: await store.activity(user(context)), nextCursor: null } }));
  add("GET", "/v1/notifications", true, async (context) => ({ body: { data: await store.notifications(user(context)), nextCursor: null } }));
  add("PATCH", "/v1/notifications/:id/read", true, async (context) => ({ body: await mutate(context, async () => await store.readNotification(user(context), context.params.id!, now().toISOString())) }));
  add("POST", "/v1/devices/push-token", true, async (context) => ({ body: await mutate(context, async () => await store.registerPushToken(user(context), { ...context.body, deviceId: context.claims!.deviceId })) }));
  add("DELETE", "/v1/devices/push-token", true, async (context) => ({ body: await mutate(context, async () => await store.unregisterPushToken(user(context), context.claims!.deviceId)) }));
  add("GET", "/v1/settings", true, async (context) => ({ body: await store.settings(user(context)) }));
  add("PATCH", "/v1/settings", true, async (context) => ({ body: await mutate(context, async () => await store.patchSettings(user(context), context.body, now().toISOString())) }));
  add("GET", "/v1/data-export", true, async (context) => ({ body: await store.dataExportStatus(user(context)) }));
  add("POST", "/v1/data-export", true, async (context) => ({ status: 202, body: await mutate(context, async () => await store.requestDataExport(user(context), context.body, now().toISOString())) }));
  add("DELETE", "/v1/account", true, async (context) => ({ status: 202, body: await mutate(context, async () => {
    const userId = user(context);
    const verificationNow = now();
    await requireStepUp(context, "delete_account", userId, verificationNow);
    return await store.closeAccount(userId);
  }) }));
  add("GET", "/v1/help", false, () => ({ body: { supportEmail: "support@whox.ai", topics: ["Connection troubleshooting", "Emergency pause", "Subscriptions", "Data and privacy"] } }));
  add("POST", "/v1/support-tickets", true, async (context) => ({ status: 201, body: await mutate(context, async () => await store.createSupportTicket(user(context), context.body, now().toISOString())) }));

  return createServer(async (request, response) => {
    const correlationId = safeCorrelationId(request.headers["x-correlation-id"]);
    try {
      const url = new URL(request.url ?? "/", "http://api.local");
      if (url.pathname !== "/healthz" && url.pathname !== "/readyz") {
        const address = trustedClientAddress(request.socket.remoteAddress, request.headers["x-forwarded-for"], trustedProxyHops);
        const limit = await globalRate.consume(rateLimitClientKey(address, rateLimitKeySecret), now().getTime());
        response.setHeader("RateLimit-Limit", "240");
        response.setHeader("RateLimit-Remaining", String(limit.remaining));
        response.setHeader("RateLimit-Reset", String(Math.ceil(limit.resetAt / 1000)));
      }
      response.setHeader("X-Correlation-ID", correlationId);
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
      const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
      if (origin !== undefined) {
        if (!allowedCorsOrigins.has(origin)) throw new DomainError("ORIGIN_NOT_ALLOWED", "Request origin is not allowed", 403);
        response.setHeader("Access-Control-Allow-Origin", origin);
        response.setHeader("Access-Control-Allow-Credentials", "true");
        response.setHeader("Vary", "Origin");
      }
      if (request.method === "OPTIONS") {
        if (origin === undefined) throw new DomainError("ORIGIN_REQUIRED", "CORS preflight requires an allowed Origin", 403);
        response.writeHead(204, { "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Authorization,Content-Type,Idempotency-Key,X-CSRF-Token,X-Correlation-ID" });
        response.end();
        return;
      }
      const matched = routes.find((route) => route.method === (request.method ?? "GET") && route.pattern.test(url.pathname));
      if (matched === undefined) throw new DomainError("ROUTE_NOT_FOUND", "Route was not found", 404);
      const values = matched.pattern.exec(url.pathname);
      const params = Object.fromEntries(matched.names.map((name, index) => [name, decodeURIComponent(values?.[index + 1] ?? "")]));
      const cookies = parseCookies(request.headers.cookie);
      const authorization = request.headers.authorization;
      const token = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7) : cookies.whox_session;
      const authFromCookie = authorization === undefined && token !== undefined;
      let claims: AccessClaims | undefined;
      if (matched.authenticated) {
        if (token === undefined) throw new DomainError("AUTH_REQUIRED", "Authentication is required", 401);
        claims = await sessions.verify(token, now());
        const unsafe = !["GET", "HEAD", "OPTIONS"].includes(request.method ?? "GET");
        if (unsafe && authFromCookie) csrf.verify(claims.sessionId, typeof request.headers["x-csrf-token"] === "string" ? request.headers["x-csrf-token"] : undefined, now().getTime());
      }
      const body = await readJson(request);
      const result = await matched.handler({ request, url, params, body, ...(claims === undefined ? {} : { claims, userId: claims.sub }), authFromCookie, correlationId });
      send(response, result.status ?? 200, result.body, result.headers);
    } catch (error) {
      const domain = error instanceof DomainError ? error : new DomainError("INTERNAL_ERROR", "The request could not be completed", 500);
      const body: ApiErrorBody = { error: { code: domain.code, message: domain.httpStatus >= 500 ? "The service could not complete the request." : domain.message, correlationId, ...(domain.details === undefined ? {} : { details: domain.details }) } };
      if (domain.httpStatus === 429 && typeof domain.details?.retryAfterSeconds === "number") response.setHeader("Retry-After", String(domain.details.retryAfterSeconds));
      send(response, domain.httpStatus, body);
    }
  });
}

function send(response: ServerResponse, status: number, body: Json, headers: Readonly<Record<string, string>> = {}): void {
  for (const [key, value] of Object.entries(headers)) response.setHeader(key, value);
  if (body === undefined) { response.writeHead(status); response.end(); return; }
  const json = JSON.stringify(body);
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(json));
  response.writeHead(status);
  response.end(json);
}
