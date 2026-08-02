import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import {
  type ApprovedBrokerConnectorIdentity,
  type ApprovedMobileBrokerAuthorizationConnector,
  type BrokerAuthorizationCompletion,
  type MobileBrokerAuthorizationExchangeResult,
  type MobileBrokerAuthorizationExchangeRequest,
  type MobileBrokerAuthorizationStartRequest
} from "@whox/contracts";
import { PairingService } from "../src/pairings.js";
import { createApiServer } from "../src/server.js";

const now = "2026-08-01T14:00:00.000Z";
const identity: ApprovedBrokerConnectorIdentity = Object.freeze({
  provider: "robinhood_mcp",
  adapterId: "approved-mobile-test",
  approvalReference: "review:mobile-test-2026-08-01",
  authorizationIssuer: "https://auth.broker.test/",
  resourceUri: "https://mcp.broker.test/trading",
  protocolVersion: "test-1"
});

class TestMobileConnector implements ApprovedMobileBrokerAuthorizationConnector {
  public readonly identity = identity;
  public readonly metadata = Object.freeze({
    identity,
    mobileInAppAuthorizationApproved: true as const,
    oidcNonceRequired: false,
    authorizationResponseIssuerRequired: false,
    clientId: "treasury-agent-test-client",
    allowedScopes: Object.freeze(["account:read", "trade:review"]),
    provisionalCredentialTtlSeconds: 120,
    authorizationEndpoint: "https://auth.broker.test/authorize",
    redirectUri: "https://api.whox.test/v1/brokers/robinhood/mobile-oauth/callback",
    mobileReturnUri: "metis://broker-connection/callback"
  });
  public readonly starts: MobileBrokerAuthorizationStartRequest[] = [];
  public readonly exchanges: MobileBrokerAuthorizationExchangeRequest[] = [];
  public confirmations = 0;
  public revocations = 0;
  public destinationOrigin = "https://auth.broker.test";
  public clientIdOverride: string | undefined;
  public scopeOverride: string | undefined;
  public confirmationFails = false;
  public beginFails = false;
  public malformedExchange = false;
  public exchangeHangs = false;
  public revocationHangs = false;
  public readonly revokedTransactionIds: string[] = [];

  public async beginAuthorization(request: MobileBrokerAuthorizationStartRequest): Promise<{ readonly authorizationUrl: string }> {
    this.starts.push(request);
    if (this.beginFails) throw new Error("authorization launch failed");
    const destination = new URL("/authorize", this.destinationOrigin);
    destination.searchParams.set("response_type", "code");
    destination.searchParams.set("client_id", this.clientIdOverride ?? request.clientId);
    destination.searchParams.set("scope", this.scopeOverride ?? request.scopes.join(" "));
    destination.searchParams.set("state", request.state);
    destination.searchParams.set("code_challenge", request.codeChallenge);
    destination.searchParams.set("code_challenge_method", request.codeChallengeMethod);
    destination.searchParams.set("redirect_uri", request.redirectUri);
    destination.searchParams.set("resource", request.resourceUri);
    return { authorizationUrl: destination.href };
  }

  public async exchangeAuthorizationCode(request: MobileBrokerAuthorizationExchangeRequest): Promise<MobileBrokerAuthorizationExchangeResult> {
    this.exchanges.push(request);
    if (this.exchangeHangs) return await new Promise<MobileBrokerAuthorizationExchangeResult>(() => {});
    if (this.malformedExchange) return null as unknown as MobileBrokerAuthorizationExchangeResult;
    const completion: BrokerAuthorizationCompletion = Object.freeze({
      identity,
      connection: Object.freeze({
        status: "connected" as const,
        maskedAccountIdentifier: "Agentic account •••• 3921",
        capabilities: Object.freeze([]),
        equityTradingAvailable: false,
        optionsTradingAvailable: false
      }),
      credentialHandle: "vault://broker-bindings/mobile-test-binding",
      resourceUri: identity.resourceUri
    });
    return Object.freeze({ exchangeTransactionId: request.exchangeTransactionId, completion });
  }

  public async confirmAuthorizationPersistence(): Promise<void> { this.confirmations += 1; if (this.confirmationFails) throw new Error("provisional binding confirmation failed"); }
  public async revokeAuthorization(exchangeTransactionId: string): Promise<void> {
    this.revocations += 1;
    this.revokedTransactionIds.push(exchangeTransactionId);
    if (this.revocationHangs) await new Promise<void>(() => {});
  }
}

const servers: ReturnType<typeof createApiServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function startServer(connector?: TestMobileConnector, brokerConnectorTimeoutMs?: number) {
  const pairings = new PairingService(new URL("https://connect.whox.test"), Buffer.alloc(32, 72), 10 * 60_000, connector === undefined ? undefined : identity);
  let stepUpSequence = 0;
  const server = createApiServer({
    mode: "demo",
    pairingService: pairings,
    stepUpVerifier: {
      async verify(context) {
        stepUpSequence += 1;
        return Object.freeze({
          verificationId: `mobile-step-up-${stepUpSequence}`,
          userId: context.userId,
          sessionId: context.sessionId,
          deviceId: context.deviceId,
          action: context.action,
          resourceId: context.resourceId,
          method: "app_attest" as const,
          authenticatedAt: "2026-08-01T13:59:30.000Z",
          expiresAt: "2026-08-01T14:04:30.000Z"
        });
      }
    },
    ...(connector === undefined ? {} : { mobileBrokerAuthorizationConnector: connector }),
    ...(brokerConnectorTimeoutMs === undefined ? {} : { brokerConnectorTimeoutMs }),
    now: () => new Date(now)
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function login(base: string, deviceId: string): Promise<string> {
  const response = await fetch(`${base}/v1/auth/apple`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identityToken: "demo-apple-identity-token", deviceId })
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { accessToken: string }).accessToken;
}

async function createPairing(base: string, accessToken: string, key: string) {
  const response = await fetch(`${base}/v1/brokers/robinhood/pairings`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", "idempotency-key": key },
    body: "{}"
  });
  assert.equal(response.status, 201);
  return await response.json() as { pairingId: string; code: string; status: string };
}

async function startMobile(base: string, accessToken: string, pairingId: string, key: string): Promise<Response> {
  return await fetch(`${base}/v1/brokers/robinhood/mobile-oauth/start`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ pairingId })
  });
}

async function disconnect(base: string, accessToken: string, deviceId: string, key: string): Promise<Response> {
  return await fetch(`${base}/v1/brokers/robinhood/connection`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ deviceId, stepUpProof: { assertion: "server-verifiable-test-proof" } })
  });
}

describe("server-driven mobile broker authorization", () => {
  it("binds PKCE and opaque state, exchanges only on the server, and returns a token-free app callback", async () => {
    const connector = new TestMobileConnector();
    const base = await startServer(connector);
    const accessToken = await login(base, "mobile-oauth-device");
    const pairing = await createPairing(base, accessToken, "create-mobile-pairing");

    const first = await startMobile(base, accessToken, pairing.pairingId, "start-mobile-authorization");
    assert.equal(first.status, 200);
    const started = await first.json() as { authorizationUrl: string; callbackScheme: string; returnUrl: string; pairingId: string; expiresAt: string };
    assert.equal(started.callbackScheme, "metis");
    assert.equal(started.returnUrl, "metis://broker-connection/callback");
    assert.equal(started.pairingId, pairing.pairingId);
    assert.equal(connector.starts.length, 1);
    assert.equal(connector.starts[0]!.nonce, undefined, "OAuth-only metadata must not invent an OIDC nonce");
    const destination = new URL(started.authorizationUrl);
    assert.equal(destination.origin, "https://auth.broker.test");
    assert.equal(destination.searchParams.get("client_id"), "treasury-agent-test-client");
    assert.equal(destination.searchParams.get("scope"), "account:read trade:review");
    assert.equal(destination.searchParams.get("code_challenge_method"), "S256");
    assert.equal(destination.searchParams.has("nonce"), false);

    const replayedStart = await startMobile(base, accessToken, pairing.pairingId, "start-mobile-authorization");
    assert.equal(replayedStart.status, 200);
    assert.deepEqual(await replayedStart.json(), started);
    assert.equal(connector.starts.length, 1, "idempotent replay must not generate new OAuth state");

    const callback = new URL(`${base}/v1/brokers/robinhood/mobile-oauth/callback`);
    callback.searchParams.set("code", "one-time-provider-code");
    callback.searchParams.set("state", destination.searchParams.get("state")!);
    callback.searchParams.set("pairingId", "00000000-0000-4000-8000-000000000000");
    const untrustedIdentifier = await fetch(callback, { redirect: "manual" });
    assert.equal(untrustedIdentifier.status, 400, "callback must never accept identity context from query parameters");
    assert.equal(connector.exchanges.length, 0);
    callback.searchParams.delete("pairingId");
    const completed = await fetch(callback, { redirect: "manual" });
    assert.equal(completed.status, 302);
    const appReturn = new URL(completed.headers.get("location")!);
    assert.equal(appReturn.protocol, "metis:");
    assert.deepEqual([...appReturn.searchParams.keys()].sort(), ["pairingId", "result"]);
    assert.equal(appReturn.searchParams.get("result"), "verification_pending");
    assert.equal(appReturn.searchParams.get("pairingId"), pairing.pairingId);
    assert.equal(connector.exchanges.length, 1);
    assert.equal(connector.exchanges[0]!.code, "one-time-provider-code");
    assert.match(connector.exchanges[0]!.exchangeTransactionId, /^[0-9a-f-]{36}$/i);
    assert.notEqual(connector.exchanges[0]!.codeVerifier, destination.searchParams.get("code_challenge"));
    assert.equal(connector.exchanges[0]!.nonce, undefined);
    assert.equal(connector.confirmations, 1);
    assert.equal(connector.revocations, 0);

    const status = await fetch(`${base}/v1/brokers/robinhood/pairings/${pairing.pairingId}`, { headers: { authorization: `Bearer ${accessToken}` } });
    const pending = await status.json() as { status: string; connection?: { status: string } };
    assert.equal(pending.status, "authorizing");
    assert.equal(pending.connection?.status, "pending");
    const replayedCallback = await fetch(callback, { redirect: "manual" });
    assert.equal(replayedCallback.status, 400);
    assert.equal(connector.exchanges.length, 1, "callback state and verifier are one-time use");
  });

  it("restores pending state after app cancellation so the same pairing can use desktop fallback", async () => {
    const connector = new TestMobileConnector();
    const base = await startServer(connector);
    const mobileToken = await login(base, "mobile-cancel-device");
    const pairing = await createPairing(base, mobileToken, "create-abort-pairing");
    const started = await startMobile(base, mobileToken, pairing.pairingId, "start-before-abort");
    assert.equal(started.status, 200);
    const staleState = new URL(((await started.json()) as { authorizationUrl: string }).authorizationUrl).searchParams.get("state")!;

    const abort = await fetch(`${base}/v1/brokers/robinhood/mobile-oauth/abort`, {
      method: "POST",
      headers: { authorization: `Bearer ${mobileToken}`, "content-type": "application/json", "idempotency-key": "abort-mobile-authorization" },
      body: JSON.stringify({ pairingId: pairing.pairingId })
    });
    assert.equal(abort.status, 200);
    assert.deepEqual(await abort.json(), { pairingId: pairing.pairingId, status: "pending" });

    const staleCallback = new URL(`${base}/v1/brokers/robinhood/mobile-oauth/callback`);
    staleCallback.searchParams.set("code", "stale-code");
    staleCallback.searchParams.set("state", staleState);
    assert.equal((await fetch(staleCallback, { redirect: "manual" })).status, 400);
    assert.equal(connector.exchanges.length, 0);

    const desktopToken = await login(base, "desktop-fallback-device");
    const claimed = await fetch(`${base}/v1/brokers/robinhood/pairings/claim`, {
      method: "POST",
      headers: { authorization: `Bearer ${desktopToken}`, "content-type": "application/json" },
      body: JSON.stringify({ code: pairing.code })
    });
    assert.equal(claimed.status, 200);
    const desktopStart = await fetch(`${base}/v1/brokers/robinhood/oauth/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${desktopToken}`, "content-type": "application/json" },
      body: JSON.stringify({ pairingId: pairing.pairingId })
    });
    assert.equal(desktopStart.status, 200);
  });

  it("preserves the original OAuth state when a resumed launch attempt fails", async () => {
    const connector = new TestMobileConnector();
    const base = await startServer(connector);
    const accessToken = await login(base, "resumed-launch-device");
    const pairing = await createPairing(base, accessToken, "create-resumed-launch-pairing");
    const first = await startMobile(base, accessToken, pairing.pairingId, "start-resumed-launch-first");
    assert.equal(first.status, 200);
    const destination = new URL(((await first.json()) as { authorizationUrl: string }).authorizationUrl);

    connector.beginFails = true;
    const failedResume = await startMobile(base, accessToken, pairing.pairingId, "start-resumed-launch-second");
    assert.equal(failedResume.status, 503);
    connector.beginFails = false;

    const callback = new URL(`${base}/v1/brokers/robinhood/mobile-oauth/callback`);
    callback.searchParams.set("code", "original-state-code");
    callback.searchParams.set("state", destination.searchParams.get("state")!);
    const completed = await fetch(callback, { redirect: "manual" });
    assert.equal(completed.status, 302);
    assert.equal(new URL(completed.headers.get("location")!).searchParams.get("result"), "verification_pending");
    assert.equal(connector.exchanges.length, 1, "failed resume must not invalidate the original callback state");
  });

  it("fails closed without an approved connector and rolls back an out-of-allowlist destination", async () => {
    const unavailableBase = await startServer();
    const unavailableToken = await login(unavailableBase, "unavailable-mobile-device");
    const unavailablePairing = await createPairing(unavailableBase, unavailableToken, "create-unavailable-pairing");
    const unavailable = await startMobile(unavailableBase, unavailableToken, unavailablePairing.pairingId, "start-unavailable-mobile");
    assert.equal(unavailable.status, 503);
    assert.equal(((await unavailable.json()) as { error: { code: string } }).error.code, "ROBINHOOD_MOBILE_OAUTH_UNAVAILABLE");

    const connector = new TestMobileConnector();
    connector.destinationOrigin = "https://evil.example";
    const base = await startServer(connector);
    const accessToken = await login(base, "allowlist-mobile-device");
    const pairing = await createPairing(base, accessToken, "create-allowlist-pairing");
    const rejected = await startMobile(base, accessToken, pairing.pairingId, "start-allowlist-mobile");
    assert.equal(rejected.status, 503);
    assert.equal(((await rejected.json()) as { error: { code: string } }).error.code, "BROKER_AUTHORIZATION_URL_INVALID");
    const status = await fetch(`${base}/v1/brokers/robinhood/pairings/${pairing.pairingId}`, { headers: { authorization: `Bearer ${accessToken}` } });
    assert.equal(((await status.json()) as { status: string }).status, "pending", "failed start must not strand the pairing in authorizing");

    const wrongScopeConnector = new TestMobileConnector();
    wrongScopeConnector.scopeOverride = "trade:execute";
    const wrongScopeBase = await startServer(wrongScopeConnector);
    const wrongScopeToken = await login(wrongScopeBase, "scope-mobile-device");
    const wrongScopePairing = await createPairing(wrongScopeBase, wrongScopeToken, "create-scope-pairing");
    const wrongScope = await startMobile(wrongScopeBase, wrongScopeToken, wrongScopePairing.pairingId, "start-scope-mobile");
    assert.equal(wrongScope.status, 503);
    assert.equal(((await wrongScope.json()) as { error: { code: string } }).error.code, "BROKER_AUTHORIZATION_URL_INVALID");
  });

  it("keeps durable recovery pending when the provisional confirmation outcome is unknown", async () => {
    const connector = new TestMobileConnector();
    connector.confirmationFails = true;
    const base = await startServer(connector);
    const accessToken = await login(base, "confirmation-failure-device");
    const pairing = await createPairing(base, accessToken, "create-confirmation-pairing");
    const start = await startMobile(base, accessToken, pairing.pairingId, "start-confirmation-pairing");
    const destination = new URL(((await start.json()) as { authorizationUrl: string }).authorizationUrl);
    const callback = new URL(`${base}/v1/brokers/robinhood/mobile-oauth/callback`);
    callback.searchParams.set("code", "confirmation-failure-code");
    callback.searchParams.set("state", destination.searchParams.get("state")!);
    const response = await fetch(callback, { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.equal(new URL(response.headers.get("location")!).searchParams.get("result"), "verification_pending");
    assert.equal(connector.confirmations, 1);
    assert.equal(connector.revocations, 0, "an unknown confirm outcome must remain owned by durable recovery");
    const status = await fetch(`${base}/v1/brokers/robinhood/pairings/${pairing.pairingId}`, { headers: { authorization: `Bearer ${accessToken}` } });
    assert.equal(((await status.json()) as { status: string }).status, "authorizing");
  });

  it("rejects malformed exchange output without dereferencing it or exposing provider artifacts", async () => {
    const connector = new TestMobileConnector();
    connector.malformedExchange = true;
    const base = await startServer(connector);
    const accessToken = await login(base, "malformed-exchange-device");
    const pairing = await createPairing(base, accessToken, "create-malformed-pairing");
    const start = await startMobile(base, accessToken, pairing.pairingId, "start-malformed-pairing");
    const destination = new URL(((await start.json()) as { authorizationUrl: string }).authorizationUrl);
    const callback = new URL(`${base}/v1/brokers/robinhood/mobile-oauth/callback`);
    callback.searchParams.set("code", "malformed-exchange-code");
    callback.searchParams.set("state", destination.searchParams.get("state")!);
    const response = await fetch(callback, { redirect: "manual" });
    assert.equal(response.status, 302);
    const appReturn = new URL(response.headers.get("location")!);
    assert.equal(appReturn.searchParams.get("result"), "failed");
    assert.deepEqual([...appReturn.searchParams.keys()].sort(), ["pairingId", "result"]);
    assert.equal(connector.confirmations, 0);
    assert.equal(connector.revocations, 1, "the caller-generated tombstone must revoke even malformed provider output");
    assert.equal(connector.revokedTransactionIds[0], connector.exchanges[0]!.exchangeTransactionId);
  });

  it("times out a hung exchange and revokes it by the pre-persisted caller transaction ID", async () => {
    const connector = new TestMobileConnector();
    connector.exchangeHangs = true;
    const base = await startServer(connector, 5);
    const accessToken = await login(base, "hung-exchange-device");
    const pairing = await createPairing(base, accessToken, "create-hung-exchange-pairing");
    const start = await startMobile(base, accessToken, pairing.pairingId, "start-hung-exchange-pairing");
    const destination = new URL(((await start.json()) as { authorizationUrl: string }).authorizationUrl);
    const callback = new URL(`${base}/v1/brokers/robinhood/mobile-oauth/callback`);
    callback.searchParams.set("code", "hung-exchange-code");
    callback.searchParams.set("state", destination.searchParams.get("state")!);
    const response = await fetch(callback, { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.equal(new URL(response.headers.get("location")!).searchParams.get("result"), "failed");
    assert.equal(connector.exchanges.length, 1);
    assert.equal(connector.revocations, 1);
    assert.equal(connector.revokedTransactionIds[0], connector.exchanges[0]!.exchangeTransactionId);
    const status = await fetch(`${base}/v1/brokers/robinhood/pairings/${pairing.pairingId}`, { headers: { authorization: `Bearer ${accessToken}` } });
    assert.equal(((await status.json()) as { status: string }).status, "error");
  });

  it("revokes through the provider before acknowledging disconnect and permits a fresh connection", async () => {
    const connector = new TestMobileConnector();
    const base = await startServer(connector);
    const deviceId = "mobile-disconnect-device";
    const accessToken = await login(base, deviceId);
    const pairing = await createPairing(base, accessToken, "create-disconnect-pairing");
    const start = await startMobile(base, accessToken, pairing.pairingId, "start-disconnect-pairing");
    const destination = new URL(((await start.json()) as { authorizationUrl: string }).authorizationUrl);
    const callback = new URL(`${base}/v1/brokers/robinhood/mobile-oauth/callback`);
    callback.searchParams.set("code", "disconnect-provider-code");
    callback.searchParams.set("state", destination.searchParams.get("state")!);
    assert.equal((await fetch(callback, { redirect: "manual" })).status, 302);

    const response = await disconnect(base, accessToken, deviceId, "disconnect-confirmed-authorization");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "disconnected", tokensRevoked: true });
    assert.equal(connector.revocations, 1);

    const replacement = await createPairing(base, accessToken, "create-replacement-pairing");
    assert.equal((await startMobile(base, accessToken, replacement.pairingId, "start-replacement-pairing")).status, 200);
  });

  it("keeps replacement blocked while a timed-out provider revocation remains durably pending", async () => {
    const connector = new TestMobileConnector();
    const base = await startServer(connector, 5);
    const deviceId = "mobile-revocation-timeout-device";
    const accessToken = await login(base, deviceId);
    const pairing = await createPairing(base, accessToken, "create-revocation-timeout-pairing");
    const start = await startMobile(base, accessToken, pairing.pairingId, "start-revocation-timeout-pairing");
    const destination = new URL(((await start.json()) as { authorizationUrl: string }).authorizationUrl);
    const callback = new URL(`${base}/v1/brokers/robinhood/mobile-oauth/callback`);
    callback.searchParams.set("code", "revocation-timeout-provider-code");
    callback.searchParams.set("state", destination.searchParams.get("state")!);
    assert.equal((await fetch(callback, { redirect: "manual" })).status, 302);

    connector.revocationHangs = true;
    const unknown = await disconnect(base, accessToken, deviceId, "disconnect-with-unknown-outcome");
    assert.equal(unknown.status, 503);
    assert.equal(((await unknown.json()) as { error: { code: string } }).error.code, "BROKER_REVOCATION_PENDING");
    const replacement = await createPairing(base, accessToken, "create-blocked-replacement-pairing");
    const blocked = await startMobile(base, accessToken, replacement.pairingId, "start-blocked-replacement-pairing");
    assert.equal(blocked.status, 409);
    assert.equal(((await blocked.json()) as { error: { code: string } }).error.code, "BROKER_CONNECTION_REPLACEMENT_REQUIRES_REVOCATION");

    connector.revocationHangs = false;
    const retried = await disconnect(base, accessToken, deviceId, "retry-disconnect-after-timeout");
    assert.equal(retried.status, 200);
    assert.deepEqual(await retried.json(), { status: "disconnected", tokensRevoked: true });
    assert.equal((await startMobile(base, accessToken, replacement.pairingId, "start-unblocked-replacement-pairing")).status, 200);
  });
});
