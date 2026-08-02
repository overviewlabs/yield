import {
  DomainError,
  type ApprovedBrokerConnectorIdentity,
  type ApprovedMobileBrokerAuthorizationConnector,
  type ApprovedMobileBrokerAuthorizationMetadata,
  type BrokerAuthorizationCompletion,
  type MobileBrokerAuthorizationExchangeResult,
  type MobileBrokerAuthorizationStartRequest
} from "@whox/contracts";

export const MOBILE_BROKER_RETURN_URI = "whoxtreasury://broker-connection/callback";

function exactHttps(value: string, field: string, allowQuery = false): URL {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new DomainError("MOBILE_BROKER_METADATA_INVALID", `${field} must be an absolute HTTPS URL`, 500); }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== "" ||
    (!allowQuery && parsed.search !== "") ||
    parsed.href !== value
  ) {
    throw new DomainError("MOBILE_BROKER_METADATA_INVALID", `${field} must be an exact canonical HTTPS URL`, 500);
  }
  return parsed;
}

function validIdentity(identity: ApprovedBrokerConnectorIdentity): boolean {
  return identity.provider === "robinhood_mcp" &&
    /^[a-z0-9][a-z0-9._-]{2,99}$/.test(identity.adapterId) &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$/.test(identity.approvalReference) &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(identity.protocolVersion);
}

export function connectorIdentitiesMatch(
  left: ApprovedBrokerConnectorIdentity | undefined,
  right: ApprovedBrokerConnectorIdentity
): boolean {
  return left !== undefined &&
    left.provider === right.provider &&
    left.adapterId === right.adapterId &&
    left.approvalReference === right.approvalReference &&
    left.authorizationIssuer === right.authorizationIssuer &&
    left.resourceUri === right.resourceUri &&
    left.protocolVersion === right.protocolVersion;
}

export function validateMobileBrokerConnector(
  connector: ApprovedMobileBrokerAuthorizationConnector
): ApprovedMobileBrokerAuthorizationMetadata {
  const metadata = connector.metadata;
  const scopes = metadata?.allowedScopes;
  if (metadata === null || typeof metadata !== "object" || metadata.mobileInAppAuthorizationApproved !== true || typeof metadata.oidcNonceRequired !== "boolean" || typeof metadata.authorizationResponseIssuerRequired !== "boolean" || typeof metadata.clientId !== "string" || metadata.clientId.length < 1 || metadata.clientId.length > 200 || /[\u0000-\u0020\u007f]/.test(metadata.clientId) || !Array.isArray(scopes) || scopes.length < 1 || scopes.length > 20 || scopes.some((scope) => typeof scope !== "string" || !/^[A-Za-z0-9._:/-]{1,128}$/.test(scope)) || new Set(scopes).size !== scopes.length || !Number.isInteger(metadata.provisionalCredentialTtlSeconds) || metadata.provisionalCredentialTtlSeconds < 30 || metadata.provisionalCredentialTtlSeconds > 600 || !validIdentity(metadata.identity)) {
    throw new DomainError("MOBILE_BROKER_CONNECTOR_NOT_APPROVED", "The injected mobile broker connector is not explicitly approved", 500);
  }
  exactHttps(metadata.identity.authorizationIssuer, "authorizationIssuer");
  exactHttps(metadata.identity.resourceUri, "resourceUri");
  exactHttps(metadata.authorizationEndpoint, "authorizationEndpoint");
  const redirect = exactHttps(metadata.redirectUri, "redirectUri");
  if (redirect.pathname !== "/v1/brokers/robinhood/mobile-oauth/callback") {
    throw new DomainError("MOBILE_BROKER_METADATA_INVALID", "redirectUri must target the reserved server callback", 500);
  }
  if (metadata.mobileReturnUri !== MOBILE_BROKER_RETURN_URI) {
    throw new DomainError("MOBILE_BROKER_METADATA_INVALID", "mobileReturnUri must use the fixed WHOX Treasury callback", 500);
  }
  if (!connectorIdentitiesMatch(connector.identity, metadata.identity)) {
    throw new DomainError("MOBILE_BROKER_CONNECTOR_NOT_APPROVED", "Authorization lifecycle identity does not match mobile connector metadata", 500);
  }
  return metadata;
}

function requireSingleParameter(url: URL, name: string, expected: string): void {
  const values = url.searchParams.getAll(name);
  if (values.length !== 1 || values[0] !== expected) {
    throw new DomainError("BROKER_AUTHORIZATION_URL_INVALID", `Approved authorization URL has an invalid ${name} binding`, 503);
  }
}

export function validateAuthorizationDestination(
  value: string,
  metadata: ApprovedMobileBrokerAuthorizationMetadata,
  request: MobileBrokerAuthorizationStartRequest
): string {
  if (value.length > 4_096) throw new DomainError("BROKER_AUTHORIZATION_URL_INVALID", "Approved authorization URL is too long", 503);
  const destination = exactHttps(value, "authorizationUrl", true);
  const endpoint = new URL(metadata.authorizationEndpoint);
  if (destination.origin !== endpoint.origin || destination.pathname !== endpoint.pathname) {
    throw new DomainError("BROKER_AUTHORIZATION_URL_INVALID", "Approved connector returned an authorization destination outside its allowlist", 503);
  }
  requireSingleParameter(destination, "response_type", "code");
  requireSingleParameter(destination, "client_id", request.clientId);
  requireSingleParameter(destination, "state", request.state);
  if (metadata.oidcNonceRequired) {
    if (request.nonce === undefined) throw new DomainError("BROKER_AUTHORIZATION_URL_INVALID", "Approved OIDC authorization is missing its nonce binding", 503);
    requireSingleParameter(destination, "nonce", request.nonce);
  } else if (destination.searchParams.has("nonce")) {
    throw new DomainError("BROKER_AUTHORIZATION_URL_INVALID", "OAuth-only authorization unexpectedly included an OIDC nonce", 503);
  }
  requireSingleParameter(destination, "code_challenge", request.codeChallenge);
  requireSingleParameter(destination, "code_challenge_method", "S256");
  requireSingleParameter(destination, "redirect_uri", request.redirectUri);
  requireSingleParameter(destination, "resource", request.resourceUri);
  const scopeValues = destination.searchParams.getAll("scope");
  const actualScopes = scopeValues.length === 1 ? scopeValues[0]!.split(" ") : [];
  if (actualScopes.some((scope) => scope === "") || actualScopes.length !== request.scopes.length || [...actualScopes].sort().some((scope, index) => scope !== [...request.scopes].sort()[index])) {
    throw new DomainError("BROKER_AUTHORIZATION_URL_INVALID", "Approved authorization URL has an invalid scope binding", 503);
  }
  for (const prohibited of ["code", "access_token", "refresh_token", "id_token"]) {
    if (destination.searchParams.has(prohibited)) {
      throw new DomainError("BROKER_AUTHORIZATION_URL_INVALID", "Approved connector returned authorization artifacts in its destination", 503);
    }
  }
  return destination.href;
}

function plainRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Readonly<Record<string, unknown>> : undefined;
}

export function provisionalExchangeTransactionId(value: unknown): string | undefined {
  const record = plainRecord(value);
  const transactionId = record?.exchangeTransactionId;
  return typeof transactionId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(transactionId) ? transactionId : undefined;
}

export function validateAuthorizationExchange(
  value: unknown,
  expected: ApprovedBrokerConnectorIdentity,
  expectedExchangeTransactionId: string
): MobileBrokerAuthorizationExchangeResult {
  const root = plainRecord(value);
  const exchangeTransactionId = provisionalExchangeTransactionId(value);
  const completion = plainRecord(root?.completion);
  const actualIdentity = plainRecord(completion?.identity);
  const connection = plainRecord(completion?.connection);
  const onlyKeys = (record: Readonly<Record<string, unknown>> | undefined, allowed: readonly string[]): boolean => record !== undefined && Object.keys(record).every((key) => allowed.includes(key));
  if (
    root === undefined || exchangeTransactionId === undefined || exchangeTransactionId !== expectedExchangeTransactionId || !onlyKeys(root, ["exchangeTransactionId", "completion"]) ||
    completion === undefined || !onlyKeys(completion, ["identity", "connection", "credentialHandle", "resourceUri"]) ||
    actualIdentity === undefined || !onlyKeys(actualIdentity, ["provider", "adapterId", "approvalReference", "authorizationIssuer", "resourceUri", "protocolVersion"]) ||
    actualIdentity.provider !== expected.provider || actualIdentity.adapterId !== expected.adapterId || actualIdentity.approvalReference !== expected.approvalReference || actualIdentity.authorizationIssuer !== expected.authorizationIssuer || actualIdentity.resourceUri !== expected.resourceUri || actualIdentity.protocolVersion !== expected.protocolVersion ||
    typeof completion.credentialHandle !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{15,254}$/.test(completion.credentialHandle) || completion.resourceUri !== expected.resourceUri ||
    connection === undefined || !onlyKeys(connection, ["status", "maskedAccountIdentifier", "capabilities", "equityTradingAvailable", "optionsTradingAvailable"]) || connection.status !== "connected" || !Array.isArray(connection.capabilities) || connection.capabilities.length !== 0 || connection.equityTradingAvailable !== false || connection.optionsTradingAvailable !== false ||
    (connection.maskedAccountIdentifier !== undefined && (typeof connection.maskedAccountIdentifier !== "string" || connection.maskedAccountIdentifier.trim() === "" || connection.maskedAccountIdentifier.length > 120))
  ) {
    throw new DomainError("BROKER_AUTHORIZATION_EXCHANGE_INVALID", "Approved connector returned an invalid provisional authorization receipt", 503);
  }
  const sanitizedCompletion: BrokerAuthorizationCompletion = Object.freeze({
    identity: expected,
    connection: Object.freeze({
      status: "connected",
      ...(typeof connection.maskedAccountIdentifier === "string" ? { maskedAccountIdentifier: connection.maskedAccountIdentifier } : {}),
      capabilities: Object.freeze([]),
      equityTradingAvailable: false,
      optionsTradingAvailable: false
    }),
    credentialHandle: completion.credentialHandle,
    resourceUri: expected.resourceUri
  });
  return Object.freeze({ exchangeTransactionId, completion: sanitizedCompletion });
}

export function sanitizedMobileReturn(
  result: "verification_pending" | "canceled" | "failed",
  pairingId: string
): string {
  const destination = new URL(MOBILE_BROKER_RETURN_URI);
  destination.searchParams.set("result", result);
  destination.searchParams.set("pairingId", pairingId);
  return destination.href;
}
