export const ACCOUNT_ENVIRONMENTS = ["demo", "paper", "live"] as const;
export type AccountEnvironment = (typeof ACCOUNT_ENVIRONMENTS)[number];

export const APPROVAL_MODES = ["observe", "confirm_every_trade", "automatic_within_limits"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export const INSTRUMENT_TYPES = ["equity", "option"] as const;
export type InstrumentType = (typeof INSTRUMENT_TYPES)[number];

export const PROPOSAL_STATUSES = [
  "DRAFT",
  "ANALYZED",
  "SCHEMA_VALIDATED",
  "RISK_CHECKED",
  "RISK_REJECTED",
  "BROKER_REVIEWED",
  "BROKER_REJECTED",
  "AWAITING_USER_APPROVAL",
  "USER_REJECTED",
  "APPROVED",
  "SUBMITTING",
  "SUBMITTED",
  "PARTIALLY_FILLED",
  "FILLED",
  "CANCELED",
  "REJECTED",
  "EXPIRED",
  "RECONCILIATION_ERROR"
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const TERMINAL_PROPOSAL_STATUSES: ReadonlySet<ProposalStatus> = new Set([
  "RISK_REJECTED",
  "BROKER_REJECTED",
  "USER_REJECTED",
  "FILLED",
  "CANCELED",
  "REJECTED",
  "EXPIRED"
]);

export interface OptionLeg {
  readonly optionInstrumentId?: string;
  readonly underlyingSymbol: string;
  readonly side: "buy" | "sell";
  readonly positionEffect: "open" | "close";
  readonly optionType: "call" | "put";
  readonly strikePrice: number;
  readonly expirationDate: string;
  readonly ratioQuantity: number;
}

export interface EvidenceReference {
  readonly kind: "quote" | "fundamental" | "technical" | "event" | "portfolio" | "strategy_rule";
  readonly source: string;
  readonly observedAt: string;
  readonly referenceId: string;
}

export interface TradeProposal {
  readonly proposalId: string;
  readonly userId: string;
  readonly accountId: string;
  readonly agentDefinitionId: string;
  readonly agentVersion: string;
  readonly environment: AccountEnvironment;
  readonly instrumentType: InstrumentType;
  readonly symbol: string;
  readonly optionLegs: readonly OptionLeg[];
  readonly side: "buy" | "sell";
  readonly quantity: number;
  readonly notionalEstimate: number;
  readonly orderType: "market" | "limit" | "stop" | "stop_limit";
  readonly limitPrice?: number;
  readonly stopPrice?: number;
  readonly timeInForce: "day" | "gtc";
  readonly strategyType: string;
  readonly entryReason: string;
  readonly exitPlan: string;
  readonly invalidationCondition: string;
  readonly dataTimestamp: string;
  readonly quoteTimestamp: string;
  readonly maximumLoss?: number;
  readonly maximumProfitWhenBounded?: number;
  readonly breakevens: readonly number[];
  readonly estimatedPortfolioAllocationAfter: number;
  readonly riskAmount: number;
  readonly confidenceCategoryWithoutProbabilityClaims: "low" | "moderate" | "high_evidence";
  readonly requiredApprovalMode: ApprovalMode;
  readonly expirationTimestamp: string;
  readonly evidenceReferences: readonly EvidenceReference[];
  readonly warnings: readonly string[];
  readonly modelVersion?: string;
  readonly promptVersion?: string;
  readonly deterministicStrategyVersion: string;
}

export interface ProposalTransition {
  readonly proposalId: string;
  readonly fromStatus: ProposalStatus;
  readonly toStatus: ProposalStatus;
  readonly actorType: "system" | "user" | "worker" | "broker" | "operator";
  readonly actorId: string;
  readonly reasonCode: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly occurredAt: string;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export {
  evaluateLiveTradingGates,
  liveTradingGatesSatisfied,
  lockedReleaseGates,
  lockedReleaseGates as LOCKED_RELEASE_GATES,
  readReleaseGates,
  readReleaseGates as loadReleaseGates
} from "@whox/shared-config";
export type { ReleaseGates } from "@whox/shared-config";

export interface RiskPolicyLimits {
  readonly maximumAccountAllocation: number;
  readonly maximumPositionAmount: number;
  readonly maximumNewOrderAmount: number;
  readonly maximumDailyLoss: number;
  readonly maximumPortfolioDrawdown: number;
  readonly minimumBuyingPowerReserve: number;
  readonly maximumSimultaneousPositions: number;
  readonly maximumSymbolConcentration: number;
  readonly maximumSectorConcentration: number;
  readonly maximumTradesPerDay: number;
  readonly maximumDailyTurnover: number;
  readonly maximumOptionsExposure: number;
  readonly maximumOptionRiskPerTrade: number;
  readonly maximumContractsPerTrade: number;
  readonly minimumDaysToExpiration: number;
  readonly maximumDaysToExpiration: number;
  readonly maximumBidAskSpreadRatio: number;
  readonly maximumQuoteAgeSeconds: number;
  readonly maximumAccountSnapshotAgeSeconds: number;
  readonly maximumPriceDeviationRatio: number;
}

export interface RiskPolicy extends RiskPolicyLimits {
  readonly policyId: string;
  readonly userId: string;
  readonly excludedSymbols: readonly string[];
  readonly excludedSectors: readonly string[];
  readonly fractionalSharesPermitted: boolean;
  readonly extendedHoursPermitted: boolean;
  readonly earningsTradesPermitted: boolean;
  readonly coveredCallsPermitted: boolean;
  readonly protectivePutsPermitted: boolean;
  readonly definedRiskSpreadsPermitted: boolean;
  readonly updatedAt: string;
  readonly version: number;
}

export type RiskCheckSeverity = "info" | "warning" | "blocking";

export interface RiskCheckResult {
  readonly code: string;
  readonly passed: boolean;
  readonly severity: RiskCheckSeverity;
  readonly message: string;
  readonly observed?: number | string | boolean;
  readonly limit?: number | string | boolean;
}

export interface RiskEvaluation {
  readonly passed: boolean;
  readonly evaluatedAt: string;
  readonly policyVersion: number;
  readonly proposalFingerprint: string;
  readonly checks: readonly RiskCheckResult[];
}

export interface Entitlements {
  readonly stockTrading: boolean;
  readonly optionsTrading: boolean;
  readonly multiLegOptions: boolean;
  readonly maximumActiveAgents: number;
  readonly automaticMode: boolean;
  readonly monitoringFrequencyMinutes: number;
  readonly advancedAnalytics: boolean;
  readonly customWatchlists: boolean;
  readonly scannerAccess: boolean;
  readonly agentCatalog: readonly string[];
  readonly prioritySupport: boolean;
}

export interface PlanAgentAssignment {
  readonly agentId: string;
  readonly displayName: string;
  readonly agentVersion: string;
  readonly catalogPosition: 1 | 2 | 3;
  readonly releaseStatus: "draft" | "paper" | "limited_rollout" | "live" | "paused" | "retired";
  readonly deterministicStrategyVersion: string;
  /** Closed, immutable symbol set published with this exact plan-catalog assignment. */
  readonly researchUniverse: readonly string[];
}

export interface SubscriptionPlanCatalog {
  readonly id: string;
  readonly name: string;
  readonly productId: string;
  readonly features: Entitlements;
  readonly agentCatalogVersion: number;
  readonly agents: readonly PlanAgentAssignment[];
}

export interface BrokerCapability {
  readonly toolName: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly discoveredAt: string;
  readonly protocolVersion: string;
}

export interface BrokerConnectionSummary {
  readonly status: "disconnected" | "pending" | "connected" | "expired" | "error";
  readonly maskedAccountIdentifier?: string;
  readonly lastSuccessfulSync?: string;
  readonly capabilities: readonly string[];
  readonly equityTradingAvailable: boolean;
  readonly optionsTradingAvailable: boolean;
}

export const BROKER_PROVIDERS = ["robinhood_mcp"] as const;
export type BrokerProvider = (typeof BROKER_PROVIDERS)[number];

/**
 * Identifies an internally injected connector implementation that has passed a
 * named review. It is configuration metadata, never a broker credential.
 */
export interface ApprovedBrokerConnectorIdentity {
  readonly provider: BrokerProvider;
  readonly adapterId: string;
  readonly approvalReference: string;
  readonly authorizationIssuer: string;
  readonly resourceUri: string;
  readonly protocolVersion: string;
}

/**
 * Result passed from an approved authorization boundary into pairing
 * persistence. OAuth codes, access tokens, refresh tokens, and verifier
 * material are deliberately absent.
 */
export interface BrokerAuthorizationCompletion {
  readonly identity: ApprovedBrokerConnectorIdentity;
  readonly connection: BrokerConnectionSummary;
  /** Opaque server-side vault handle. It is never returned to clients or queued. */
  readonly credentialHandle: string;
  readonly resourceUri: string;
}

/**
 * Provider-reviewed metadata for the optional in-app authorization surface.
 * Merely constructing this object does not enable the route: an approved
 * connector implementation must also be injected into the API runtime.
 */
export interface ApprovedMobileBrokerAuthorizationMetadata {
  readonly identity: ApprovedBrokerConnectorIdentity;
  readonly mobileInAppAuthorizationApproved: true;
  /** True only when the reviewed provider flow is OIDC rather than OAuth-only. */
  readonly oidcNonceRequired: boolean;
  /** Derived from reviewed authorization-server metadata. */
  readonly authorizationResponseIssuerRequired: boolean;
  readonly clientId: string;
  readonly allowedScopes: readonly string[];
  /** Unconfirmed vault bindings must remain unreadable and auto-expire. */
  readonly provisionalCredentialTtlSeconds: number;
  readonly authorizationEndpoint: string;
  readonly redirectUri: string;
  readonly mobileReturnUri: string;
}

export interface MobileBrokerAuthorizationStartRequest {
  readonly state: string;
  readonly nonce?: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: "S256";
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly redirectUri: string;
  readonly resourceUri: string;
}

export interface MobileBrokerAuthorizationExchangeRequest {
  /**
   * Caller-generated idempotency key for the provisional vault transaction.
   * The connector must honor a revoke tombstone issued before a late exchange
   * completes, and unconfirmed material must remain unreadable and auto-expire.
   */
  readonly exchangeTransactionId: string;
  readonly code: string;
  readonly codeVerifier: string;
  readonly nonce?: string;
  readonly issuer?: string;
  readonly redirectUri: string;
  readonly resourceUri: string;
}

export interface MobileBrokerAuthorizationExchangeResult {
  /** Nonsecret identifier used only to confirm or discard the provisional vault transaction. */
  readonly exchangeTransactionId: string;
  readonly completion: BrokerAuthorizationCompletion;
}

export type BrokerAuthorizationSagaOperation = "confirm_pending" | "confirmed" | "revoke_pending" | "revoked";

/**
 * Immutable authorization binding loaded only by trusted server workers. The
 * transaction identifier is nonsecret correlation metadata, but it and the
 * vault handle remain tenant-scoped and must never enter client responses or
 * ordinary logs.
 */
export interface BrokerAuthorizationSagaWork {
  readonly sagaId: string;
  readonly userId: string;
  readonly pairingId: string;
  readonly connectionId: string;
  readonly exchangeTransactionId: string;
  readonly operation: BrokerAuthorizationSagaOperation;
  readonly identity: ApprovedBrokerConnectorIdentity;
  readonly confirmationDeadlineAt: string;
  readonly completion?: BrokerAuthorizationCompletion;
}

export interface ApprovedBrokerAuthorizationLifecycleConnector {
  readonly identity: ApprovedBrokerConnectorIdentity;
  /** Must be idempotent by exchangeTransactionId; timeout means outcome unknown and is retried. */
  confirmAuthorizationPersistence(exchangeTransactionId: string, completion: BrokerAuthorizationCompletion, signal?: AbortSignal): Promise<void>;
  /** Must be idempotent before or after confirmation, and terminal-wins over a concurrent late confirmation. */
  revokeAuthorization(exchangeTransactionId: string, signal?: AbortSignal): Promise<void>;
  healthy?(): boolean | Promise<boolean>;
}

export interface BrokerAuthorizationSagaPersistence {
  loadAuthorizationSaga(userId: string, sagaId: string, now: string): Promise<BrokerAuthorizationSagaWork>;
  requestAuthorizationRevocation(userId: string, sagaId: string, errorCode: string, now: string): Promise<"revoke_pending" | "revoked">;
  acknowledgeAuthorizationConfirmation(userId: string, sagaId: string, now: string): Promise<BrokerAuthorizationSagaOperation>;
  acknowledgeAuthorizationRevocation(userId: string, sagaId: string, now: string): Promise<"revoked">;
}

export type BrokerAuthorizationExchangeOperation = "exchange_pending" | "completed" | "revoke_pending" | "revoked";

export interface BrokerAuthorizationExchangeWork {
  readonly userId: string;
  readonly pairingId: string;
  readonly exchangeTransactionId: string;
  readonly operation: BrokerAuthorizationExchangeOperation;
  readonly identity: ApprovedBrokerConnectorIdentity;
  readonly cleanupAfter: string;
}

export interface BrokerAuthorizationExchangePersistence {
  loadAuthorizationExchange(userId: string, exchangeTransactionId: string, now: string): Promise<BrokerAuthorizationExchangeWork>;
  requestAuthorizationExchangeRevocation(userId: string, exchangeTransactionId: string, errorCode: string, now: string): Promise<"revoke_pending" | "revoked" | "completed">;
  acknowledgeAuthorizationExchangeRevocation(userId: string, exchangeTransactionId: string, now: string): Promise<"revoked" | "completed">;
}

function sameBrokerConnectorIdentity(left: ApprovedBrokerConnectorIdentity, right: ApprovedBrokerConnectorIdentity): boolean {
  return left.provider === right.provider && left.adapterId === right.adapterId && left.approvalReference === right.approvalReference && left.authorizationIssuer === right.authorizationIssuer && left.resourceUri === right.resourceUri && left.protocolVersion === right.protocolVersion;
}

async function runBrokerLifecycleOperation<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal | undefined,
  timeoutMs: number
): Promise<T> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new DomainError("BROKER_CONNECTOR_TIMEOUT_INVALID", "Broker connector timeout is invalid", 500);
  const controller = new AbortController();
  const parentAbort = (): void => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted === true) parentAbort();
  else parentSignal?.addEventListener("abort", parentAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(new DomainError("BROKER_CONNECTOR_TIMEOUT", "Broker authorization provider did not respond in time", 503));
      reject(new DomainError("BROKER_CONNECTOR_TIMEOUT", "Broker authorization provider did not respond in time", 503));
    }, timeoutMs);
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    if (controller.signal.aborted) reject(new DomainError("BROKER_CONNECTOR_ABORTED", "Broker authorization operation was aborted", 503));
    else controller.signal.addEventListener("abort", () => {
      if (parentSignal?.aborted === true) reject(new DomainError("BROKER_CONNECTOR_ABORTED", "Broker authorization operation was aborted", 503));
    }, { once: true });
  });
  try { return await Promise.race([operation(controller.signal), timeout, aborted]); }
  finally {
    if (timer !== undefined) clearTimeout(timer);
    parentSignal?.removeEventListener("abort", parentAbort);
  }
}

/** Reconciles a pre-exchange tombstone that was persisted before any provider call. */
export async function reconcileBrokerAuthorizationExchange(
  persistence: BrokerAuthorizationExchangePersistence,
  connector: ApprovedBrokerAuthorizationLifecycleConnector,
  userId: string,
  exchangeTransactionId: string,
  now: string,
  signal?: AbortSignal,
  connectorTimeoutMs = 15_000
): Promise<BrokerAuthorizationExchangeOperation> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuid.test(userId) || !uuid.test(exchangeTransactionId) || !Number.isFinite(Date.parse(now)) || new Date(Date.parse(now)).toISOString() !== now) throw new DomainError("BROKER_AUTHORIZATION_EXCHANGE_INVALID", "Broker authorization exchange recovery command is invalid", 422);
  let work = await persistence.loadAuthorizationExchange(userId, exchangeTransactionId, now);
  if (work.userId !== userId || work.exchangeTransactionId !== exchangeTransactionId || !sameBrokerConnectorIdentity(work.identity, connector.identity)) throw new DomainError("BROKER_AUTHORIZATION_EXCHANGE_INVALID", "Broker authorization exchange recovery binding is invalid", 403);
  const cleanupAfterMs = Date.parse(work.cleanupAfter);
  if (!Number.isFinite(cleanupAfterMs) || new Date(cleanupAfterMs).toISOString() !== work.cleanupAfter) throw new DomainError("BROKER_AUTHORIZATION_EXCHANGE_INVALID", "Broker authorization exchange cleanup deadline is invalid", 500);
  if (work.operation === "completed" || work.operation === "revoked") return work.operation;
  if (work.operation === "exchange_pending") {
    if (cleanupAfterMs > Date.parse(now)) throw new DomainError("BROKER_AUTHORIZATION_EXCHANGE_NOT_DUE", "Broker authorization exchange cleanup is not due", 409);
    const operation = await persistence.requestAuthorizationExchangeRevocation(userId, exchangeTransactionId, "AUTHORIZATION_EXCHANGE_OUTCOME_UNKNOWN", now);
    if (operation === "completed" || operation === "revoked") return operation;
    work = await persistence.loadAuthorizationExchange(userId, exchangeTransactionId, now);
    if (work.operation === "completed" || work.operation === "revoked") return work.operation;
  }
  if (work.operation !== "revoke_pending") throw new DomainError("BROKER_AUTHORIZATION_EXCHANGE_INVALID", "Broker authorization exchange recovery transition is invalid", 500);
  await runBrokerLifecycleOperation(async (operationSignal) => await connector.revokeAuthorization(exchangeTransactionId, operationSignal), signal, connectorTimeoutMs);
  return await persistence.acknowledgeAuthorizationExchangeRevocation(userId, exchangeTransactionId, now);
}

/** Reconciles one durable operation. Safe to invoke from both the callback and a queue worker. */
export async function reconcileBrokerAuthorizationSaga(
  persistence: BrokerAuthorizationSagaPersistence,
  connector: ApprovedBrokerAuthorizationLifecycleConnector,
  userId: string,
  sagaId: string,
  now: string,
  signal?: AbortSignal,
  currentTime?: () => string,
  connectorTimeoutMs = 15_000
): Promise<BrokerAuthorizationSagaOperation> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuid.test(userId) || !uuid.test(sagaId) || !Number.isFinite(Date.parse(now)) || new Date(Date.parse(now)).toISOString() !== now) throw new DomainError("BROKER_AUTHORIZATION_SAGA_INVALID", "Broker authorization recovery command is invalid", 422);
  let work = await persistence.loadAuthorizationSaga(userId, sagaId, now);
  if (work.userId !== userId || work.sagaId !== sagaId) throw new DomainError("BROKER_AUTHORIZATION_SAGA_INVALID", "Broker authorization recovery binding is invalid", 500);
  if (!sameBrokerConnectorIdentity(work.identity, connector.identity)) throw new DomainError("BROKER_AUTHORIZATION_SAGA_INVALID", "Broker authorization recovery connector is invalid", 403);
  const confirmationDeadlineMs = Date.parse(work.confirmationDeadlineAt);
  if (!Number.isFinite(confirmationDeadlineMs) || new Date(confirmationDeadlineMs).toISOString() !== work.confirmationDeadlineAt) throw new DomainError("BROKER_AUTHORIZATION_SAGA_INVALID", "Broker authorization recovery deadline is invalid", 500);
  if (work.operation === "revoked" || work.operation === "confirmed") return work.operation;
  if (work.operation === "confirm_pending" && confirmationDeadlineMs <= Date.parse(now)) {
    const operation = await persistence.requestAuthorizationRevocation(userId, sagaId, "AUTHORIZATION_CONFIRMATION_DEADLINE_EXCEEDED", now);
    if (operation === "revoked") return operation;
    work = await persistence.loadAuthorizationSaga(userId, sagaId, now);
    if (work.userId !== userId || work.sagaId !== sagaId || !sameBrokerConnectorIdentity(work.identity, connector.identity)) throw new DomainError("BROKER_AUTHORIZATION_SAGA_INVALID", "Expired broker authorization binding changed", 500);
    if (work.operation === "revoked") return "revoked";
    if (work.operation !== "revoke_pending") throw new DomainError("BROKER_AUTHORIZATION_SAGA_INVALID", "Expired broker authorization did not enter revocation", 500);
  }
  if (work.operation === "confirm_pending") {
    if (work.completion === undefined || !sameBrokerConnectorIdentity(work.completion.identity, work.identity)) throw new DomainError("BROKER_AUTHORIZATION_SAGA_INVALID", "Broker authorization confirmation binding is invalid", 500);
    await runBrokerLifecycleOperation(async (operationSignal) => await connector.confirmAuthorizationPersistence(work.exchangeTransactionId, work.completion!, operationSignal), signal, connectorTimeoutMs);
    const acknowledgmentNow = currentTime?.() ?? now;
    if (!Number.isFinite(Date.parse(acknowledgmentNow)) || new Date(Date.parse(acknowledgmentNow)).toISOString() !== acknowledgmentNow) throw new DomainError("BROKER_AUTHORIZATION_SAGA_INVALID", "Broker authorization acknowledgment clock is invalid", 500);
    const operation = await persistence.acknowledgeAuthorizationConfirmation(userId, sagaId, acknowledgmentNow);
    if (operation === "confirmed" || operation === "revoked") return operation;
    work = await persistence.loadAuthorizationSaga(userId, sagaId, now);
    if (work.userId !== userId || work.sagaId !== sagaId || !sameBrokerConnectorIdentity(work.identity, connector.identity)) throw new DomainError("BROKER_AUTHORIZATION_SAGA_INVALID", "Broker authorization recovery binding changed", 500);
    if (work.operation === "revoked") return "revoked";
  }
  if (work.operation !== "revoke_pending") throw new DomainError("BROKER_AUTHORIZATION_SAGA_INVALID", "Broker authorization recovery transition is invalid", 500);
  await runBrokerLifecycleOperation(async (operationSignal) => await connector.revokeAuthorization(work.exchangeTransactionId, operationSignal), signal, connectorTimeoutMs);
  const revocationNow = currentTime?.() ?? now;
  if (!Number.isFinite(Date.parse(revocationNow)) || new Date(Date.parse(revocationNow)).toISOString() !== revocationNow) throw new DomainError("BROKER_AUTHORIZATION_SAGA_INVALID", "Broker authorization revocation clock is invalid", 500);
  return await persistence.acknowledgeAuthorizationRevocation(userId, sagaId, revocationNow);
}

/**
 * Implemented only by the isolated provider connection boundary. Token
 * exchange happens inside this adapter and only an opaque vault handle may
 * cross back into the API process.
 */
export interface ApprovedMobileBrokerAuthorizationConnector extends ApprovedBrokerAuthorizationLifecycleConnector {
  readonly metadata: ApprovedMobileBrokerAuthorizationMetadata;
  beginAuthorization(
    request: MobileBrokerAuthorizationStartRequest,
    signal?: AbortSignal
  ): Promise<{ readonly authorizationUrl: string }>;
  exchangeAuthorizationCode(
    request: MobileBrokerAuthorizationExchangeRequest,
    signal?: AbortSignal
  ): Promise<MobileBrokerAuthorizationExchangeResult>;
}

export interface BrokerAccountHydration {
  readonly opaqueBrokerId: string;
  readonly maskedIdentifier: string;
  readonly accountType: string;
  readonly isAgenticAccount: boolean;
  readonly equityTradingAvailable: boolean;
  readonly optionsTradingAvailable: boolean;
  readonly optionsPermission?: string;
  readonly verifiedForTradingAt: string;
}

export interface BrokerPositionHydration {
  readonly brokerPositionId: string;
  readonly symbol: string;
  readonly instrumentType: InstrumentType;
  readonly quantity: number;
  readonly averageCost?: number;
  readonly marketValue: number;
  readonly unrealizedPnl?: number;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface BrokerPortfolioHydration {
  readonly sourceTimestamp: string;
  readonly totalValue: number;
  readonly buyingPower: number;
  readonly cashValue: number;
  readonly positions: readonly BrokerPositionHydration[];
}

export interface BrokerHydrationSnapshot {
  readonly identity: ApprovedBrokerConnectorIdentity;
  readonly account: BrokerAccountHydration;
  readonly capabilities: readonly BrokerCapability[];
  readonly portfolio: BrokerPortfolioHydration;
}

export interface BrokerHydrationRequest {
  readonly userId: string;
  readonly connectionId: string;
  readonly provider: BrokerProvider;
}

/** Implementations live behind separately reviewed provider integrations. */
export interface ApprovedBrokerSnapshotConnector {
  readonly identity: ApprovedBrokerConnectorIdentity;
  fetchHydrationSnapshot(
    request: BrokerHydrationRequest,
    signal?: AbortSignal
  ): Promise<BrokerHydrationSnapshot>;
}

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly correlationId: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

export interface CursorPage<T> {
  readonly data: readonly T[];
  readonly nextCursor: string | null;
}

export class DomainError extends Error {
  public readonly code: string;
  public readonly httpStatus: number;
  public readonly details?: Readonly<Record<string, unknown>>;

  public constructor(
    code: string,
    message: string,
    httpStatus = 400,
    details?: Readonly<Record<string, unknown>>
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.httpStatus = httpStatus;
    if (details !== undefined) this.details = details;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,9}$/;

function requireRecord(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError("SCHEMA_INVALID", `${name} must be an object`);
  }
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DomainError("SCHEMA_INVALID", `${key} must be a non-empty string`);
  }
  return value;
}

function requireFinitePositive(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new DomainError("SCHEMA_INVALID", `${key} must be a finite positive number`);
  }
  return value;
}

function requireEnum<T extends string>(record:Record<string,unknown>,key:string,values:readonly T[]):T {const value=requireString(record,key);if(!values.includes(value as T))throw new DomainError("SCHEMA_INVALID",`${key} is invalid`);return value as T;}
function requireIso(record:Record<string,unknown>,key:string):string{const value=requireString(record,key);if(!Number.isFinite(Date.parse(value)))throw new DomainError("SCHEMA_INVALID",`${key} must be an ISO-8601 timestamp`);return value;}
function requireStringArray(record:Record<string,unknown>,key:string):readonly string[]{const value=record[key];if(!Array.isArray(value)||!value.every((item)=>typeof item==="string"))throw new DomainError("SCHEMA_INVALID",`${key} must be a string array`);return value;}

export function validateTradeProposal(value: unknown): TradeProposal {
  requireRecord(value, "proposal");
  for (const key of ["proposalId", "userId", "accountId", "agentDefinitionId"] as const) {
    if (!UUID_PATTERN.test(requireString(value, key))) {
      throw new DomainError("SCHEMA_INVALID", `${key} must be a UUID`);
    }
  }
  const symbol = requireString(value, "symbol").toUpperCase();
  if (!SYMBOL_PATTERN.test(symbol)) throw new DomainError("SCHEMA_INVALID", "symbol is invalid");
  requireFinitePositive(value, "quantity");
  requireFinitePositive(value, "notionalEstimate");
  requireFinitePositive(value, "riskAmount");
  const environment = requireString(value, "environment");
  if (!(ACCOUNT_ENVIRONMENTS as readonly string[]).includes(environment)) {
    throw new DomainError("SCHEMA_INVALID", "environment is invalid");
  }
  const instrumentType = requireString(value, "instrumentType");
  if (!(INSTRUMENT_TYPES as readonly string[]).includes(instrumentType)) {
    throw new DomainError("SCHEMA_INVALID", "instrumentType is invalid");
  }
  requireString(value,"agentVersion");requireString(value,"strategyType");requireString(value,"entryReason");requireString(value,"exitPlan");requireString(value,"invalidationCondition");requireString(value,"deterministicStrategyVersion");
  requireEnum(value,"side",["buy","sell"] as const);const orderType=requireEnum(value,"orderType",["market","limit","stop","stop_limit"] as const);requireEnum(value,"timeInForce",["day","gtc"] as const);
  requireEnum(value,"requiredApprovalMode",APPROVAL_MODES);requireEnum(value,"confidenceCategoryWithoutProbabilityClaims",["low","moderate","high_evidence"] as const);
  const expires=Date.parse(requireIso(value,"expirationTimestamp"));const quote=Date.parse(requireIso(value,"quoteTimestamp"));const data=Date.parse(requireIso(value,"dataTimestamp"));
  if(expires<=Math.max(quote,data))throw new DomainError("SCHEMA_INVALID","expirationTimestamp must be after proposal data timestamps");
  if (!Array.isArray(value.optionLegs) || !Array.isArray(value.evidenceReferences) || !Array.isArray(value.warnings)) {
    throw new DomainError("SCHEMA_INVALID", "proposal array fields are invalid");
  }
  if (instrumentType === "option" && value.optionLegs.length === 0) {
    throw new DomainError("SCHEMA_INVALID", "option proposals require at least one leg");
  }
  if(instrumentType==="equity"&&value.optionLegs.length!==0)throw new DomainError("SCHEMA_INVALID","equity proposals cannot include option legs");
  for(const [index,legValue]of value.optionLegs.entries()){requireRecord(legValue,`optionLegs[${index}]`);requireString(legValue,"underlyingSymbol");requireEnum(legValue,"side",["buy","sell"] as const);requireEnum(legValue,"positionEffect",["open","close"] as const);requireEnum(legValue,"optionType",["call","put"] as const);requireFinitePositive(legValue,"strikePrice");const ratio=requireFinitePositive(legValue,"ratioQuantity");if(!Number.isInteger(ratio))throw new DomainError("SCHEMA_INVALID","option leg ratioQuantity must be an integer");const expiration=requireString(legValue,"expirationDate");if(!/^\d{4}-\d{2}-\d{2}$/.test(expiration)||!Number.isFinite(Date.parse(`${expiration}T00:00:00Z`)))throw new DomainError("SCHEMA_INVALID","option leg expirationDate is invalid");}
  for(const [index,evidenceValue]of value.evidenceReferences.entries()){requireRecord(evidenceValue,`evidenceReferences[${index}]`);requireEnum(evidenceValue,"kind",["quote","fundamental","technical","event","portfolio","strategy_rule"] as const);requireString(evidenceValue,"source");requireIso(evidenceValue,"observedAt");requireString(evidenceValue,"referenceId");}
  requireStringArray(value,"warnings");const breakevens=value.breakevens;if(!Array.isArray(breakevens)||!breakevens.every((item)=>typeof item==="number"&&Number.isFinite(item)&&item>=0))throw new DomainError("SCHEMA_INVALID","breakevens must contain finite nonnegative numbers");
  for(const key of ["estimatedPortfolioAllocationAfter"] as const){const number=value[key];if(typeof number!=="number"||!Number.isFinite(number)||number<0||number>1)throw new DomainError("SCHEMA_INVALID",`${key} must be between zero and one`);}
  for(const key of ["maximumLoss","maximumProfitWhenBounded","limitPrice","stopPrice"] as const){const number=value[key];if(number!==undefined&&(typeof number!=="number"||!Number.isFinite(number)||number<0))throw new DomainError("SCHEMA_INVALID",`${key} must be finite and nonnegative`);}
  if(instrumentType==="option"&&(typeof value.maximumLoss!=="number"||value.maximumLoss<=0))throw new DomainError("SCHEMA_INVALID","option proposals require a positive known maximumLoss");
  if ((orderType === "limit"||orderType==="stop_limit") && (typeof value.limitPrice !== "number" || value.limitPrice <= 0)) {
    throw new DomainError("SCHEMA_INVALID", "limit orders require a positive limitPrice");
  }
  if((orderType==="stop"||orderType==="stop_limit")&&(typeof value.stopPrice!=="number"||value.stopPrice<=0))throw new DomainError("SCHEMA_INVALID","stop orders require a positive stopPrice");
  return Object.freeze({ ...value, symbol }) as unknown as TradeProposal;
}
