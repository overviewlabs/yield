import { createHash } from "node:crypto";
import {
  DomainError,
  type ApprovedBrokerConnectorIdentity,
  type ApprovedBrokerSnapshotConnector,
  type BrokerCapability,
  type BrokerHydrationRequest,
  type BrokerHydrationSnapshot,
  type BrokerPositionHydration,
  type BrokerProvider
} from "@whox/contracts";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const connectorNamePattern = /^[a-z0-9][a-z0-9._-]{2,99}$/;
const protocolPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const symbolPattern = /^[A-Z][A-Z0-9.-]{0,19}$/;
const hydrationCapabilities = Object.freeze(["get_accounts", "get_portfolio"]);
const equityReviewCapability = "review_equity_order";

export type BrokerSyncTrigger = "authorization_completed" | "scheduled";

export interface BrokerSyncJobPayload extends Readonly<Record<string, unknown>> {
  readonly connectionId: string;
  readonly provider: BrokerProvider;
  readonly trigger: BrokerSyncTrigger;
  readonly pairingId?: string;
  readonly authorizationSagaId?: string;
  readonly scheduleBucket?: number;
}

export interface BrokerSyncCommand {
  readonly jobId: string;
  readonly userId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ValidatedBrokerHydration {
  readonly snapshot: BrokerHydrationSnapshot;
  readonly validUntil: string;
  readonly snapshotFingerprint: string;
}

export interface PersistBrokerHydrationCommand {
  readonly jobId: string;
  readonly request: BrokerHydrationRequest;
  readonly trigger: BrokerSyncTrigger;
  readonly pairingId?: string;
  readonly authorizationSagaId?: string;
  readonly hydration: ValidatedBrokerHydration;
  readonly completedAt: string;
}

export interface PersistBrokerHydrationResult {
  readonly accountId: string;
  readonly portfolioSnapshotId: string;
  readonly sourceTimestamp: string;
  readonly completedAt: string;
  readonly replayed: boolean;
}

export interface BrokerSyncPersistence {
  requireReadyConnection(
    request: BrokerHydrationRequest,
    identity: ApprovedBrokerConnectorIdentity,
    trigger: BrokerSyncTrigger,
    pairingId?: string,
    authorizationSagaId?: string
  ): Promise<void>;
  persistHydration(command: PersistBrokerHydrationCommand): Promise<PersistBrokerHydrationResult>;
}

export interface BrokerSyncOptions {
  readonly maximumSnapshotAgeSeconds?: number;
  readonly connectorTimeoutMs?: number;
  readonly now?: () => Date;
}

async function fetchWithTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, parentSignal: AbortSignal | undefined, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const parentAbort = (): void => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted === true) parentAbort();
  else parentSignal?.addEventListener("abort", parentAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DomainError("BROKER_CONNECTOR_TIMEOUT", "Broker snapshot provider did not respond in time", 503));
    }, timeoutMs);
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    if (controller.signal.aborted) reject(new DomainError("BROKER_CONNECTOR_ABORTED", "Broker snapshot operation was aborted", 503));
    else controller.signal.addEventListener("abort", () => {
      if (parentSignal?.aborted === true) reject(new DomainError("BROKER_CONNECTOR_ABORTED", "Broker snapshot operation was aborted", 503));
    }, { once: true });
  });
  try { return await Promise.race([operation(controller.signal), timeout, aborted]); }
  finally {
    if (timer !== undefined) clearTimeout(timer);
    parentSignal?.removeEventListener("abort", parentAbort);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new DomainError("BROKER_SNAPSHOT_INVALID", "Broker snapshot contains a non-finite number", 422);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new DomainError("BROKER_SNAPSHOT_INVALID", "Broker snapshot must contain plain JSON objects", 422);
    }
    const record = value as Readonly<Record<string, unknown>>;
    const keys = Object.keys(record).sort();
    if (keys.some((key) => record[key] === undefined)) throw new DomainError("BROKER_SNAPSHOT_INVALID", "Broker snapshot contains an undefined value", 422);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new DomainError("BROKER_SNAPSHOT_INVALID", "Broker snapshot must contain JSON-compatible values", 422);
}

function objectValue(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("BROKER_SNAPSHOT_INVALID", `Broker snapshot ${field} must be an object`, 422);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new DomainError("BROKER_SNAPSHOT_INVALID", `Broker snapshot ${field} must be a plain object`, 422);
  }
  return value as Readonly<Record<string, unknown>>;
}

function onlyKeys(record: Readonly<Record<string, unknown>>, allowed: readonly string[], field: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(record).some((key) => !allowedSet.has(key))) {
    throw new DomainError("BROKER_SNAPSHOT_INVALID", `Broker snapshot ${field} contains an unexpected field`, 422);
  }
}

function textValue(record: Readonly<Record<string, unknown>>, key: string, field: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new DomainError("BROKER_SNAPSHOT_INVALID", `Broker snapshot ${field} must be text`, 422);
  return value;
}

function booleanValue(record: Readonly<Record<string, unknown>>, key: string, field: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new DomainError("BROKER_SNAPSHOT_INVALID", `Broker snapshot ${field} must be boolean`, 422);
  return value;
}

function arrayValue(record: Readonly<Record<string, unknown>>, key: string, field: string): readonly unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) throw new DomainError("BROKER_SNAPSHOT_INVALID", `Broker snapshot ${field} must be an array`, 422);
  return value;
}

function exactHttps(value: string, field: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new DomainError("BROKER_CONNECTOR_IDENTITY_INVALID", `${field} is not a valid URL`, 500);
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.hash !== "" || parsed.href !== value) {
    throw new DomainError("BROKER_CONNECTOR_IDENTITY_INVALID", `${field} must be an exact canonical HTTPS URL`, 500);
  }
  return parsed.href;
}

export function validateApprovedConnectorIdentity(identity: ApprovedBrokerConnectorIdentity): ApprovedBrokerConnectorIdentity {
  const record = objectValue(identity, "connector identity");
  onlyKeys(record, ["provider", "adapterId", "approvalReference", "authorizationIssuer", "resourceUri", "protocolVersion"], "connector identity");
  const provider = textValue(record, "provider", "connector provider");
  const adapterId = textValue(record, "adapterId", "connector adapterId");
  const approvalReference = textValue(record, "approvalReference", "connector approvalReference");
  const authorizationIssuer = textValue(record, "authorizationIssuer", "connector authorizationIssuer");
  const resourceUri = textValue(record, "resourceUri", "connector resourceUri");
  const protocolVersion = textValue(record, "protocolVersion", "connector protocolVersion");
  if (provider !== "robinhood_mcp") throw new DomainError("BROKER_PROVIDER_UNAPPROVED", "Only the explicitly approved broker provider is accepted", 500);
  if (!connectorNamePattern.test(adapterId)) throw new DomainError("BROKER_CONNECTOR_IDENTITY_INVALID", "Approved connector adapter ID is invalid", 500);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$/.test(approvalReference)) throw new DomainError("BROKER_CONNECTOR_IDENTITY_INVALID", "Approved connector review reference is invalid", 500);
  if (!protocolPattern.test(protocolVersion)) throw new DomainError("BROKER_CONNECTOR_IDENTITY_INVALID", "Approved connector protocol version is invalid", 500);
  exactHttps(authorizationIssuer, "authorizationIssuer");
  exactHttps(resourceUri, "resourceUri");
  return Object.freeze({ provider, adapterId, approvalReference, authorizationIssuer, resourceUri, protocolVersion });
}

function identityMatches(actual: ApprovedBrokerConnectorIdentity, expected: ApprovedBrokerConnectorIdentity): boolean {
  return actual.provider === expected.provider
    && actual.adapterId === expected.adapterId
    && actual.approvalReference === expected.approvalReference
    && actual.authorizationIssuer === expected.authorizationIssuer
    && actual.resourceUri === expected.resourceUri
    && actual.protocolVersion === expected.protocolVersion;
}

function finite(value: unknown, field: string, minimum?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || (minimum !== undefined && value < minimum)) {
    throw new DomainError("BROKER_SNAPSHOT_INVALID", `Broker snapshot ${field} is invalid`, 422);
  }
  return value;
}

function boundedText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") throw new DomainError("BROKER_SNAPSHOT_INVALID", `Broker snapshot ${field} is invalid`, 422);
  const normalized = value.trim();
  if (normalized === "" || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new DomainError("BROKER_SNAPSHOT_INVALID", `Broker snapshot ${field} is invalid`, 422);
  }
  return normalized;
}

function timestamp(value: unknown, field: string): number {
  if (typeof value !== "string") throw new DomainError("BROKER_SNAPSHOT_INVALID", `Broker snapshot ${field} must be canonical ISO-8601`, 422);
  const instant = Date.parse(value);
  if (!Number.isFinite(instant) || new Date(instant).toISOString() !== value) {
    throw new DomainError("BROKER_SNAPSHOT_INVALID", `Broker snapshot ${field} must be canonical ISO-8601`, 422);
  }
  return instant;
}

function validateCapability(value: unknown, now: number): BrokerCapability {
  const capability = objectValue(value, "capability");
  onlyKeys(capability, ["toolName", "inputSchema", "outputSchema", "discoveredAt", "protocolVersion"], "capability");
  const toolName = textValue(capability, "toolName", "capability toolName");
  const protocolVersion = textValue(capability, "protocolVersion", "capability protocolVersion");
  const discoveredAt = textValue(capability, "discoveredAt", "capability discoveredAt");
  const inputSchema = objectValue(capability.inputSchema, "capability inputSchema");
  const outputSchema = Object.prototype.hasOwnProperty.call(capability, "outputSchema")
    ? objectValue(capability.outputSchema, "capability outputSchema")
    : undefined;
  if (!connectorNamePattern.test(toolName) || !protocolPattern.test(protocolVersion)) {
    throw new DomainError("BROKER_CAPABILITIES_INVALID", "Broker capability identity is invalid", 422);
  }
  const discovered = timestamp(discoveredAt, "capability discoveredAt");
  if (discovered > now + 5_000 || now - discovered > 5 * 60_000) {
    throw new DomainError("BROKER_CAPABILITIES_STALE", "Broker capabilities must be freshly discovered", 503);
  }
  if (canonicalJson(inputSchema).length > 64_000 || (outputSchema !== undefined && canonicalJson(outputSchema).length > 64_000)) {
    throw new DomainError("BROKER_CAPABILITIES_INVALID", "Broker capability schema is too large", 422);
  }
  return Object.freeze({
    toolName,
    inputSchema: Object.freeze({ ...inputSchema }),
    ...(outputSchema === undefined ? {} : { outputSchema: Object.freeze({ ...outputSchema }) }),
    discoveredAt,
    protocolVersion
  });
}

function validatePosition(value: unknown): BrokerPositionHydration {
  const position = objectValue(value, "position");
  onlyKeys(position, ["brokerPositionId", "symbol", "instrumentType", "quantity", "averageCost", "marketValue", "unrealizedPnl", "details"], "position");
  const symbol = textValue(position, "symbol", "position symbol").trim().toUpperCase();
  const instrumentType = textValue(position, "instrumentType", "position instrumentType");
  if (!symbolPattern.test(symbol) || (instrumentType !== "equity" && instrumentType !== "option")) {
    throw new DomainError("BROKER_POSITION_INVALID", "Broker position symbol or instrument type is invalid", 422);
  }
  const detailsValue = objectValue(position.details, "position details");
  const details = canonicalJson(detailsValue);
  if (details.length > 32_000) throw new DomainError("BROKER_POSITION_INVALID", "Broker position details are too large", 422);
  return Object.freeze({
    brokerPositionId: boundedText(position.brokerPositionId, "position identifier", 255),
    symbol,
    instrumentType,
    quantity: finite(position.quantity, "position quantity"),
    ...(Object.prototype.hasOwnProperty.call(position, "averageCost") ? { averageCost: finite(position.averageCost, "position average cost", 0) } : {}),
    marketValue: finite(position.marketValue, "position market value"),
    ...(Object.prototype.hasOwnProperty.call(position, "unrealizedPnl") ? { unrealizedPnl: finite(position.unrealizedPnl, "position unrealized P&L") } : {}),
    details: Object.freeze({ ...detailsValue })
  });
}

export function validateBrokerHydration(
  value: BrokerHydrationSnapshot,
  expectedIdentity: ApprovedBrokerConnectorIdentity,
  now: Date,
  maximumSnapshotAgeSeconds: number
): ValidatedBrokerHydration {
  const root = objectValue(value, "response");
  onlyKeys(root, ["identity", "account", "capabilities", "portfolio"], "response");
  const identity = validateApprovedConnectorIdentity(root.identity as ApprovedBrokerConnectorIdentity);
  if (!identityMatches(identity, expectedIdentity)) throw new DomainError("BROKER_CONNECTOR_IDENTITY_MISMATCH", "Hydration response does not match the injected approved connector", 403);
  const accountValue = objectValue(root.account, "account");
  onlyKeys(accountValue, ["opaqueBrokerId", "maskedIdentifier", "accountType", "isAgenticAccount", "equityTradingAvailable", "optionsTradingAvailable", "optionsPermission", "verifiedForTradingAt"], "account");
  const portfolioValue = objectValue(root.portfolio, "portfolio");
  onlyKeys(portfolioValue, ["sourceTimestamp", "totalValue", "buyingPower", "cashValue", "positions"], "portfolio");
  const capabilityValues = arrayValue(root, "capabilities", "capabilities");
  const positionValues = arrayValue(portfolioValue, "positions", "portfolio positions");
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new DomainError("BROKER_SYNC_CLOCK_INVALID", "Broker sync clock is invalid", 500);
  const sourceTimestamp = textValue(portfolioValue, "sourceTimestamp", "portfolio sourceTimestamp");
  const sourceMs = timestamp(sourceTimestamp, "portfolio sourceTimestamp");
  if (sourceMs > nowMs + 5_000 || nowMs - sourceMs > maximumSnapshotAgeSeconds * 1_000) {
    throw new DomainError("BROKER_SNAPSHOT_STALE", "Broker portfolio snapshot is stale or from the future", 503);
  }
  const verifiedForTradingAt = textValue(accountValue, "verifiedForTradingAt", "account verifiedForTradingAt");
  const verifiedAt = timestamp(verifiedForTradingAt, "account verifiedForTradingAt");
  if (verifiedAt > nowMs + 5_000) throw new DomainError("BROKER_ACCOUNT_VERIFICATION_INVALID", "Agentic Account verification is from the future", 422);
  const isAgenticAccount = booleanValue(accountValue, "isAgenticAccount", "account isAgenticAccount");
  const connectorEquityTradingAvailable = booleanValue(accountValue, "equityTradingAvailable", "account equityTradingAvailable");
  const connectorOptionsTradingAvailable = booleanValue(accountValue, "optionsTradingAvailable", "account optionsTradingAvailable");
  if (!isAgenticAccount) {
    throw new DomainError("VERIFIED_AGENTIC_ACCOUNT_REQUIRED", "The approved connector must verify an Agentic Account", 403);
  }
  if (capabilityValues.length === 0 || capabilityValues.length > 100) throw new DomainError("BROKER_CAPABILITIES_INVALID", "Broker capability set is empty or too large", 422);
  const capabilities = capabilityValues.map((capability) => validateCapability(capability, nowMs));
  const toolNames = capabilities.map((capability) => capability.toolName);
  if (new Set(toolNames).size !== toolNames.length || hydrationCapabilities.some((tool) => !toolNames.includes(tool))) {
    throw new DomainError("BROKER_CAPABILITIES_REQUIRED", "Agentic Account hydration requires current account and portfolio capabilities", 503);
  }
  if (positionValues.length > 2_000) throw new DomainError("BROKER_POSITIONS_LIMIT_EXCEEDED", "Broker snapshot contains too many positions", 422);
  const positions = positionValues.map(validatePosition);
  const positionIds = positions.map((position) => position.brokerPositionId);
  if (new Set(positionIds).size !== positionIds.length) throw new DomainError("BROKER_POSITION_DUPLICATE", "Broker position identifiers must be unique within a snapshot", 422);
  const equityTradingAvailable = connectorEquityTradingAvailable && toolNames.includes(equityReviewCapability);
  const account = Object.freeze({
    opaqueBrokerId: boundedText(accountValue.opaqueBrokerId, "account identifier", 255),
    maskedIdentifier: boundedText(accountValue.maskedIdentifier, "masked account identifier", 120),
    accountType: boundedText(accountValue.accountType, "account type", 80),
    isAgenticAccount: true,
    equityTradingAvailable,
    optionsTradingAvailable: equityTradingAvailable && connectorOptionsTradingAvailable,
    ...(Object.prototype.hasOwnProperty.call(accountValue, "optionsPermission") ? { optionsPermission: boundedText(accountValue.optionsPermission, "options permission", 80) } : {}),
    verifiedForTradingAt
  });
  const snapshot: BrokerHydrationSnapshot = Object.freeze({
    identity,
    account,
    capabilities: Object.freeze(capabilities),
    portfolio: Object.freeze({
      sourceTimestamp,
      totalValue: finite(portfolioValue.totalValue, "portfolio total value", 0),
      buyingPower: finite(portfolioValue.buyingPower, "portfolio buying power", 0),
      cashValue: finite(portfolioValue.cashValue, "portfolio cash value"),
      positions: Object.freeze(positions)
    })
  });
  const validUntil = new Date(sourceMs + maximumSnapshotAgeSeconds * 1_000).toISOString();
  if (Date.parse(validUntil) <= nowMs) throw new DomainError("BROKER_SNAPSHOT_STALE", "Broker snapshot validity has already expired", 503);
  return Object.freeze({
    snapshot,
    validUntil,
    snapshotFingerprint: createHash("sha256").update(canonicalJson(snapshot)).digest("hex")
  });
}

export function parseBrokerSyncJob(command: BrokerSyncCommand): {
  readonly request: BrokerHydrationRequest;
  readonly trigger: BrokerSyncTrigger;
  readonly pairingId?: string;
  readonly authorizationSagaId?: string;
  readonly scheduleBucket?: number;
} {
  if (typeof command.jobId !== "string" || typeof command.userId !== "string" || !uuidPattern.test(command.jobId) || !uuidPattern.test(command.userId)) {
    throw new DomainError("BROKER_SYNC_JOB_INVALID", "Broker sync job and tenant IDs must be UUIDs", 422);
  }
  if (command.payload === null || typeof command.payload !== "object" || Array.isArray(command.payload)) {
    throw new DomainError("BROKER_SYNC_JOB_INVALID", "Broker sync queue payload must be an object", 422);
  }
  const allowed = new Set(["connectionId", "provider", "trigger", "pairingId", "authorizationSagaId", "scheduleBucket"]);
  if (Object.keys(command.payload).some((key) => !allowed.has(key))) throw new DomainError("BROKER_SYNC_JOB_SECRET_MATERIAL", "Broker sync queue payload contains an unexpected or secret-bearing field", 422);
  const connectionId = command.payload.connectionId;
  const provider = command.payload.provider;
  const trigger = command.payload.trigger;
  const pairingId = command.payload.pairingId;
  const authorizationSagaId = command.payload.authorizationSagaId;
  const scheduleBucket = command.payload.scheduleBucket;
  if (typeof connectionId !== "string" || !uuidPattern.test(connectionId) || provider !== "robinhood_mcp" || (trigger !== "authorization_completed" && trigger !== "scheduled")) {
    throw new DomainError("BROKER_SYNC_JOB_INVALID", "Broker sync queue payload is invalid", 422);
  }
  if (trigger === "authorization_completed" && (typeof pairingId !== "string" || !uuidPattern.test(pairingId) || scheduleBucket !== undefined || (authorizationSagaId !== undefined && (typeof authorizationSagaId !== "string" || !uuidPattern.test(authorizationSagaId))))) {
    throw new DomainError("BROKER_SYNC_JOB_INVALID", "Initial broker sync must remain bound only to its pairing", 422);
  }
  if (trigger === "scheduled" && (pairingId !== undefined || authorizationSagaId !== undefined || !Number.isSafeInteger(scheduleBucket) || (scheduleBucket as number) < 1)) {
    throw new DomainError("BROKER_SYNC_JOB_INVALID", "Scheduled broker sync must carry only a valid deterministic schedule bucket", 422);
  }
  return {
    request: Object.freeze({ userId: command.userId, connectionId, provider }),
    trigger,
    ...(trigger === "authorization_completed" ? { pairingId: pairingId as string } : {}),
    ...(typeof authorizationSagaId === "string" ? { authorizationSagaId } : {}),
    ...(trigger === "scheduled" ? { scheduleBucket: scheduleBucket as number } : {})
  };
}

export class BrokerSyncProcessor {
  readonly #identity: ApprovedBrokerConnectorIdentity;
  readonly #maximumSnapshotAgeSeconds: number;
  readonly #connectorTimeoutMs: number;
  readonly #now: () => Date;

  public constructor(
    private readonly connector: ApprovedBrokerSnapshotConnector,
    private readonly persistence: BrokerSyncPersistence,
    options: BrokerSyncOptions = {}
  ) {
    this.#identity = validateApprovedConnectorIdentity(connector.identity);
    this.#maximumSnapshotAgeSeconds = options.maximumSnapshotAgeSeconds ?? 60;
    if (!Number.isInteger(this.#maximumSnapshotAgeSeconds) || this.#maximumSnapshotAgeSeconds < 15 || this.#maximumSnapshotAgeSeconds > 300) {
      throw new DomainError("BROKER_SNAPSHOT_MAX_AGE_INVALID", "Broker snapshot maximum age must be between 15 and 300 seconds", 500);
    }
    this.#connectorTimeoutMs = options.connectorTimeoutMs ?? 15_000;
    if (!Number.isInteger(this.#connectorTimeoutMs) || this.#connectorTimeoutMs < 1 || this.#connectorTimeoutMs > 60_000) throw new DomainError("BROKER_CONNECTOR_TIMEOUT_INVALID", "Broker snapshot connector timeout is invalid", 500);
    this.#now = options.now ?? (() => new Date());
  }

  public async process(command: BrokerSyncCommand, signal?: AbortSignal): Promise<PersistBrokerHydrationResult> {
    const parsed = parseBrokerSyncJob(command);
    await this.persistence.requireReadyConnection(parsed.request, this.#identity, parsed.trigger, parsed.pairingId, parsed.authorizationSagaId);
    const fetched = await fetchWithTimeout(async (operationSignal) => await this.connector.fetchHydrationSnapshot(parsed.request, operationSignal), signal, this.#connectorTimeoutMs);
    const completedAt = this.#now();
    const hydration = validateBrokerHydration(fetched, this.#identity, completedAt, this.#maximumSnapshotAgeSeconds);
    return await this.persistence.persistHydration({
      jobId: command.jobId,
      request: parsed.request,
      trigger: parsed.trigger,
      ...(parsed.pairingId === undefined ? {} : { pairingId: parsed.pairingId }),
      ...(parsed.authorizationSagaId === undefined ? {} : { authorizationSagaId: parsed.authorizationSagaId }),
      hydration,
      completedAt: completedAt.toISOString()
    });
  }
}

const terminalInitialHydrationCodes = new Set([
  "BROKER_SNAPSHOT_INVALID",
  "BROKER_ACCOUNT_VERIFICATION_INVALID",
  "BROKER_CAPABILITIES_INVALID",
  "BROKER_CONNECTOR_IDENTITY_INVALID",
  "BROKER_CONNECTOR_IDENTITY_MISMATCH",
  "BROKER_CONNECTOR_BINDING_MISMATCH",
  "BROKER_RESOURCE_URI_MISMATCH",
  "VERIFIED_AGENTIC_ACCOUNT_REQUIRED",
  "BROKER_CAPABILITIES_REQUIRED",
  "BROKER_POSITIONS_LIMIT_EXCEEDED",
  "BROKER_POSITION_DUPLICATE",
  "BROKER_POSITION_INVALID",
  "BROKER_PROVIDER_UNAPPROVED",
  "BROKER_SNAPSHOT_PRECEDES_AUTHORIZATION",
  "BROKER_SYNC_PAIRING_CHANGED",
  "BROKER_CONNECTION_CHANGED",
  "BROKER_AUTHORIZATION_NOT_CONFIRMED",
  "BROKER_SYNC_JOB_INVALID",
  "BROKER_SYNC_JOB_SECRET_MATERIAL"
]);

export function brokerSyncFailureCode(error: unknown): string {
  return error instanceof DomainError && /^[A-Z0-9_:-]{1,100}$/.test(error.code) ? error.code : "BROKER_SYNC_FAILED";
}

/** Invalid verified-account/schema/binding results cannot become valid by retrying the same authorization. */
export function isTerminalInitialHydrationError(error: unknown): boolean {
  return error instanceof DomainError && terminalInitialHydrationCodes.has(error.code);
}

export function requireApprovedBrokerConnector(
  connector: ApprovedBrokerSnapshotConnector | undefined
): ApprovedBrokerSnapshotConnector {
  if (connector === undefined) {
    throw new DomainError("APPROVED_BROKER_CONNECTOR_REQUIRED", "Broker sync refuses to start without an explicitly injected approved connector", 503);
  }
  validateApprovedConnectorIdentity(connector.identity);
  return connector;
}
