import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  DomainError,
  type ApprovedBrokerConnectorIdentity,
  type ApprovedBrokerSnapshotConnector,
  type ApprovedMobileBrokerAuthorizationConnector,
  type BrokerAuthorizationCompletion,
  type BrokerHydrationRequest,
  type BrokerHydrationSnapshot,
  type MobileBrokerAuthorizationExchangeRequest,
  type MobileBrokerAuthorizationExchangeResult,
  type MobileBrokerAuthorizationStartRequest
} from "@whox/contracts";
import { McpStreamableHttpClient, StaticTokenKeyProvider, TokenVault, parseTokenSet, type EncryptedTokenEnvelope, type OAuthTokenSet } from "@whox/execution-worker";
import { Pool } from "pg";

export const ROBINHOOD_CONNECTOR_IDENTITY: ApprovedBrokerConnectorIdentity = Object.freeze({
  provider: "robinhood_mcp",
  adapterId: "whox-robinhood-connection-v1",
  approvalReference: "provider-metadata:dcr-2026-08-02",
  authorizationIssuer: "https://agent.robinhood.com/mcp/trading",
  resourceUri: "https://agent.robinhood.com/mcp/trading",
  protocolVersion: "mcp-2025-06-18"
});

interface StoredCredential {
  readonly exchangeTransactionId: string;
  readonly credentialHandle: string;
  readonly status: "provisional" | "confirmed" | "revoked";
  readonly envelope: EncryptedTokenEnvelope;
  readonly expiresAt: string;
}

interface RobinhoodConnectorOptions {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly vaultDirectory: string;
  readonly vaultKey: Buffer;
  readonly databaseUrl: string;
}

const authorizationEndpoint = "https://robinhood.com/oauth";
const resourceUri = ROBINHOOD_CONNECTOR_IDENTITY.resourceUri;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

async function oauthEndpoints(signal?: AbortSignal): Promise<{ readonly authorizationEndpoint: string; readonly tokenEndpoint: string }> {
  const issuer = new URL(ROBINHOOD_CONNECTOR_IDENTITY.authorizationIssuer);
  const path = issuer.pathname.replace(/^\//, "");
  const metadataUrl = new URL(issuer.origin);
  metadataUrl.pathname = `/.well-known/oauth-authorization-server/${path}`;
  const response = await fetch(metadataUrl, { headers: { accept: "application/json" }, redirect: "error", ...(signal === undefined ? {} : { signal }) });
  if (!response.ok) throw new DomainError("OAUTH_SERVER_DISCOVERY_FAILED", "Robinhood authorization metadata is unavailable", 502);
  const metadata = record(await response.json());
  if (metadata?.issuer !== ROBINHOOD_CONNECTOR_IDENTITY.authorizationIssuer || typeof metadata.token_endpoint !== "string" || typeof metadata.authorization_endpoint !== "string") {
    throw new DomainError("OAUTH_METADATA_INVALID", "Robinhood authorization metadata is invalid", 502);
  }
  const token = new URL(metadata.token_endpoint);
  const authorization = new URL(metadata.authorization_endpoint);
  if (token.protocol !== "https:" || authorization.href !== authorizationEndpoint || !Array.isArray(metadata.code_challenge_methods_supported) || !metadata.code_challenge_methods_supported.includes("S256")) {
    throw new DomainError("OAUTH_METADATA_INVALID", "Robinhood authorization metadata changed outside the approved profile", 502);
  }
  return Object.freeze({ authorizationEndpoint: authorization.href, tokenEndpoint: token.href });
}

function scalar(root: unknown, names: readonly string[]): unknown {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      for (const item of value) { const found = visit(item); if (found !== undefined) return found; }
      return undefined;
    }
    const object = record(value);
    if (object === undefined) return undefined;
    for (const [key, item] of Object.entries(object)) if (wanted.has(key.toLowerCase()) && (typeof item === "string" || typeof item === "number" || typeof item === "boolean")) return item;
    for (const item of Object.values(object)) { const found = visit(item); if (found !== undefined) return found; }
    return undefined;
  };
  return visit(root);
}

function numeric(root: unknown, names: readonly string[], fallback = 0): number {
  const value = scalar(root, names);
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(/[$,]/g, "")) : NaN;
  return Number.isFinite(number) ? number : fallback;
}

function toolPayload(result: Readonly<Record<string, unknown>>): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      const value = record(item);
      if (value?.type === "text" && typeof value.text === "string") {
        try { return JSON.parse(value.text); } catch { return { text: value.text }; }
      }
    }
  }
  return result;
}

function toolArguments(schema: Readonly<Record<string, unknown>>, accountIdentifier: string): Readonly<Record<string, unknown>> {
  const properties = record(schema.properties) ?? {};
  const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
  const args: Record<string, unknown> = {};
  for (const name of required) {
    const property = record(properties[name]);
    if (property?.type === "string" && /account/i.test(name)) args[name] = accountIdentifier;
    else if (property?.type === "boolean") args[name] = false;
    else if (property?.type === "integer" || property?.type === "number") args[name] = 0;
    else if (property?.type === "array") args[name] = [];
    else throw new DomainError("BROKER_TOOL_SCHEMA_UNSUPPORTED", `Required broker argument ${name} cannot be derived safely`, 503);
  }
  return Object.freeze(args);
}

export class RobinhoodConnector implements ApprovedMobileBrokerAuthorizationConnector, ApprovedBrokerSnapshotConnector {
  public readonly identity = ROBINHOOD_CONNECTOR_IDENTITY;
  public readonly metadata;
  readonly #vault: TokenVault;
  readonly #pool: Pool;
  readonly #directory: string;
  readonly #clientId: string;

  public constructor(options: RobinhoodConnectorOptions) {
    if (options.vaultKey.length !== 32) throw new DomainError("BROKER_VAULT_KEY_INVALID", "Broker vault key must contain exactly 32 bytes", 500);
    this.#clientId = options.clientId;
    this.#directory = options.vaultDirectory;
    this.#vault = new TokenVault(new StaticTokenKeyProvider("yield-robinhood-v1", options.vaultKey));
    this.#pool = new Pool({ connectionString: options.databaseUrl, application_name: "whox-robinhood-connector", max: 2 });
    this.metadata = Object.freeze({
      identity: this.identity,
      mobileInAppAuthorizationApproved: true as const,
      oidcNonceRequired: false,
      authorizationResponseIssuerRequired: false,
      clientId: options.clientId,
      allowedScopes: Object.freeze(["internal"]),
      provisionalCredentialTtlSeconds: 300,
      authorizationEndpoint,
      redirectUri: options.redirectUri,
      mobileReturnUri: "yield://broker-connection/callback"
    });
  }

  public async prepare(): Promise<void> { await mkdir(this.#directory, { recursive: true, mode: 0o700 }); }
  public async close(): Promise<void> { await this.#pool.end(); }
  public async healthy(): Promise<boolean> { try { await this.prepare(); return true; } catch { return false; } }

  public async beginAuthorization(request: MobileBrokerAuthorizationStartRequest): Promise<{ readonly authorizationUrl: string }> {
    const endpoints = await oauthEndpoints();
    const url = new URL(endpoints.authorizationEndpoint);
    const values: Record<string, string> = {
      response_type: "code", client_id: request.clientId, scope: request.scopes.join(" "), state: request.state,
      code_challenge: request.codeChallenge, code_challenge_method: request.codeChallengeMethod,
      redirect_uri: request.redirectUri, resource: request.resourceUri
    };
    if (request.loginHint !== undefined) values.login_hint = request.loginHint;
    for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
    return Object.freeze({ authorizationUrl: url.href });
  }

  public async exchangeAuthorizationCode(request: MobileBrokerAuthorizationExchangeRequest, signal?: AbortSignal): Promise<MobileBrokerAuthorizationExchangeResult> {
    if (!uuid.test(request.exchangeTransactionId)) throw new DomainError("BROKER_EXCHANGE_INVALID", "Broker exchange identifier is invalid", 422);
    const body = new URLSearchParams({ grant_type: "authorization_code", code: request.code, redirect_uri: request.redirectUri, client_id: this.#clientId, code_verifier: request.codeVerifier, resource: request.resourceUri });
    const endpoints = await oauthEndpoints(signal);
    const response = await fetch(endpoints.tokenEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body, redirect: "error", ...(signal === undefined ? {} : { signal }) });
    if (!response.ok) throw new DomainError("OAUTH_TOKEN_EXCHANGE_FAILED", "Robinhood authorization exchange failed", 502);
    const now = new Date().toISOString();
    const tokens = parseTokenSet(await response.json(), now, resourceUri);
    const credentialHandle = `vault://robinhood/${request.exchangeTransactionId}`;
    const envelope = await this.#vault.seal(request.exchangeTransactionId, request.exchangeTransactionId, tokens, now);
    const stored: StoredCredential = Object.freeze({ exchangeTransactionId: request.exchangeTransactionId, credentialHandle, status: "provisional", envelope, expiresAt: new Date(Date.now() + 300_000).toISOString() });
    await this.#write(stored);
    const completion: BrokerAuthorizationCompletion = Object.freeze({ identity: this.identity, credentialHandle, resourceUri, connection: Object.freeze({ status: "connected", maskedAccountIdentifier: "Robinhood Agentic account", capabilities: Object.freeze([]), equityTradingAvailable: false, optionsTradingAvailable: false }) });
    return Object.freeze({ exchangeTransactionId: request.exchangeTransactionId, completion });
  }

  public async confirmAuthorizationPersistence(exchangeTransactionId: string, completion: BrokerAuthorizationCompletion): Promise<void> {
    const stored = await this.#read(exchangeTransactionId);
    if (stored.status === "revoked") throw new DomainError("BROKER_AUTHORIZATION_REVOKED", "Broker authorization was revoked", 409);
    if (stored.credentialHandle !== completion.credentialHandle) throw new DomainError("BROKER_CREDENTIAL_HANDLE_INVALID", "Broker credential binding changed", 409);
    await this.#write(Object.freeze({ ...stored, status: "confirmed" }));
  }

  public async revokeAuthorization(exchangeTransactionId: string): Promise<void> {
    if (!uuid.test(exchangeTransactionId)) return;
    try { await unlink(this.#path(exchangeTransactionId)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const tombstone = join(this.#directory, `${exchangeTransactionId}.revoked`);
    await writeFile(tombstone, "revoked\n", { encoding: "utf8", mode: 0o600, flag: "a" });
  }

  public async fetchHydrationSnapshot(request: BrokerHydrationRequest): Promise<BrokerHydrationSnapshot> {
    const handleResult = await this.#pool.query<{ credential_handle: string }>("SELECT credential_handle FROM broker_connections WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL", [request.connectionId, request.userId]);
    const handle = handleResult.rows[0]?.credential_handle;
    const transactionId = handle?.startsWith("vault://robinhood/") ? handle.slice("vault://robinhood/".length) : "";
    if (!uuid.test(transactionId)) throw new DomainError("BROKER_CREDENTIAL_BINDING_REQUIRED", "Broker credential binding is unavailable", 503);
    const stored = await this.#read(transactionId);
    if (stored.status !== "confirmed") throw new DomainError("BROKER_CREDENTIAL_UNCONFIRMED", "Broker credential is not confirmed", 503);
    const tokens = await this.#vault.open(stored.envelope, transactionId);
    const client = new McpStreamableHttpClient({ endpoint: new URL(resourceUri), accessToken: async () => tokens.accessToken });
    const initialized = await client.initialize();
    const discoveredAt = new Date().toISOString();
    const capabilities = await client.discoverTools(discoveredAt);
    if (!client.hasTool("get_accounts") || !client.hasTool("get_portfolio")) throw new DomainError("BROKER_CAPABILITIES_REQUIRED", "Robinhood account and portfolio tools are unavailable", 503);
    const accountsResult = toolPayload(await client.callTool("get_accounts", {}));
    const accountIdentifier = String(scalar(accountsResult, ["account_number", "accountNumber", "account_id", "accountId", "id"]) ?? "");
    if (accountIdentifier === "") throw new DomainError("VERIFIED_AGENTIC_ACCOUNT_REQUIRED", "Robinhood did not return an Agentic Account", 403);
    const accountType = String(scalar(accountsResult, ["account_type", "accountType", "type"]) ?? "agentic");
    const accountText = JSON.stringify(accountsResult).toLowerCase();
    if (!accountText.includes("agentic")) throw new DomainError("VERIFIED_AGENTIC_ACCOUNT_REQUIRED", "The connected Robinhood account is not an Agentic Account", 403);
    const portfolioTool = client.tools.find((tool) => tool.name === "get_portfolio")!;
    const portfolioResult = toolPayload(await client.callTool("get_portfolio", toolArguments(portfolioTool.inputSchema, accountIdentifier)));
    const lastFour = accountIdentifier.replace(/\W/g, "").slice(-4).padStart(4, "•");
    const sourceTimestamp = new Date().toISOString();
    return Object.freeze({
      identity: this.identity,
      account: Object.freeze({
        opaqueBrokerId: createHash("sha256").update(accountIdentifier).digest("hex"),
        maskedIdentifier: `Robinhood Agentic •••• ${lastFour}`,
        accountType: accountType.slice(0, 80),
        isAgenticAccount: true,
        equityTradingAvailable: client.hasTool("review_equity_order"),
        optionsTradingAvailable: client.hasTool("review_option_order"),
        verifiedForTradingAt: sourceTimestamp
      }),
      capabilities,
      portfolio: Object.freeze({
        sourceTimestamp,
        totalValue: Math.max(0, numeric(portfolioResult, ["total_value", "totalValue", "equity", "portfolio_value"])),
        buyingPower: Math.max(0, numeric(portfolioResult, ["buying_power", "buyingPower"])),
        cashValue: numeric(portfolioResult, ["cash", "cash_value", "cashValue"]),
        positions: Object.freeze([])
      })
    });
  }

  #path(exchangeTransactionId: string): string { return join(this.#directory, `${exchangeTransactionId}.json`); }
  async #read(exchangeTransactionId: string): Promise<StoredCredential> {
    if (!uuid.test(exchangeTransactionId)) throw new DomainError("BROKER_CREDENTIAL_HANDLE_INVALID", "Broker credential handle is invalid", 422);
    const value = JSON.parse(await readFile(this.#path(exchangeTransactionId), "utf8")) as StoredCredential;
    if (value.exchangeTransactionId !== exchangeTransactionId || value.credentialHandle !== `vault://robinhood/${exchangeTransactionId}`) throw new DomainError("BROKER_CREDENTIAL_HANDLE_INVALID", "Broker credential record is invalid", 500);
    return value;
  }
  async #write(value: StoredCredential): Promise<void> {
    await this.prepare();
    const tombstone = join(this.#directory, `${value.exchangeTransactionId}.revoked`);
    try { await readFile(tombstone); throw new DomainError("BROKER_AUTHORIZATION_REVOKED", "Broker authorization was revoked", 409); } catch (error) { if (error instanceof DomainError) throw error; if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const path = this.#path(value.exchangeTransactionId);
    const temporary = join(dirname(path), `.${value.exchangeTransactionId}.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  }
}
