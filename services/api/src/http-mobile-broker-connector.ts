import {
  DomainError,
  type ApprovedBrokerConnectorIdentity,
  type ApprovedMobileBrokerAuthorizationConnector,
  type ApprovedMobileBrokerAuthorizationMetadata,
  type BrokerAuthorizationCompletion,
  type MobileBrokerAuthorizationExchangeRequest,
  type MobileBrokerAuthorizationExchangeResult,
  type MobileBrokerAuthorizationStartRequest
} from "@whox/contracts";

interface HttpMobileBrokerConnectorOptions {
  readonly baseUrl: URL;
  readonly sharedSecret: string;
  readonly clientId: string;
  readonly publicApiUrl: URL;
  readonly timeoutMs?: number;
}

const resourceUri = "https://agent.robinhood.com/mcp/trading";
const authorizationIssuer = "https://agent.robinhood.com/mcp/trading";
const authorizationEndpoint = "https://robinhood.com/oauth";

export const ROBINHOOD_CONNECTOR_IDENTITY: ApprovedBrokerConnectorIdentity = Object.freeze({
  provider: "robinhood_mcp",
  adapterId: "whox-robinhood-connection-v1",
  approvalReference: "provider-metadata:dcr-2026-08-02",
  authorizationIssuer,
  resourceUri,
  protocolVersion: "mcp-2025-06-18"
});

export class HttpMobileBrokerAuthorizationConnector implements ApprovedMobileBrokerAuthorizationConnector {
  public readonly identity = ROBINHOOD_CONNECTOR_IDENTITY;
  public readonly metadata: ApprovedMobileBrokerAuthorizationMetadata;
  readonly #baseUrl: URL;
  readonly #sharedSecret: string;
  readonly #timeoutMs: number;

  public constructor(options: HttpMobileBrokerConnectorOptions) {
    if (options.baseUrl.protocol !== "http:" && options.baseUrl.protocol !== "https:") {
      throw new DomainError("BROKER_CONNECTOR_URL_INVALID", "Broker connector URL must use HTTP(S)", 500);
    }
    if (options.sharedSecret.length < 32) {
      throw new DomainError("BROKER_CONNECTOR_SECRET_INVALID", "Broker connector authentication is unavailable", 500);
    }
    this.#baseUrl = options.baseUrl;
    this.#sharedSecret = options.sharedSecret;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.metadata = Object.freeze({
      identity: this.identity,
      mobileInAppAuthorizationApproved: true,
      oidcNonceRequired: false,
      authorizationResponseIssuerRequired: false,
      clientId: options.clientId,
      allowedScopes: Object.freeze(["internal"]),
      provisionalCredentialTtlSeconds: 300,
      authorizationEndpoint,
      redirectUri: new URL("/v1/brokers/robinhood/mobile-oauth/callback", options.publicApiUrl).href,
      mobileReturnUri: "yield://broker-connection/callback"
    });
  }

  public async beginAuthorization(request: MobileBrokerAuthorizationStartRequest, signal?: AbortSignal): Promise<{ readonly authorizationUrl: string }> {
    return await this.#request("authorization/start", request, signal);
  }

  public async exchangeAuthorizationCode(request: MobileBrokerAuthorizationExchangeRequest, signal?: AbortSignal): Promise<MobileBrokerAuthorizationExchangeResult> {
    return await this.#request("authorization/exchange", request, signal);
  }

  public async confirmAuthorizationPersistence(exchangeTransactionId: string, completion: BrokerAuthorizationCompletion, signal?: AbortSignal): Promise<void> {
    await this.#request("authorization/confirm", { exchangeTransactionId, credentialHandle: completion.credentialHandle }, signal);
  }

  public async revokeAuthorization(exchangeTransactionId: string, signal?: AbortSignal): Promise<void> {
    await this.#request("authorization/revoke", { exchangeTransactionId }, signal);
  }

  public async healthy(): Promise<boolean> {
    try {
      const response = await fetch(new URL("healthz", this.#baseUrl), {
        headers: { authorization: `Bearer ${this.#sharedSecret}` },
        signal: AbortSignal.timeout(this.#timeoutMs)
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async #request<T>(path: string, body: unknown, parentSignal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const abort = (): void => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted === true) abort();
    else parentSignal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await fetch(new URL(path, this.#baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#sharedSecret}`,
          "content-type": "application/json",
          accept: "application/json"
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: "error"
      });
      if (!response.ok) {
        throw new DomainError("BROKER_CONNECTOR_UNAVAILABLE", "Robinhood connection service could not complete the request", 503);
      }
      return await response.json() as T;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("BROKER_CONNECTOR_UNAVAILABLE", "Robinhood connection service is unavailable", 503);
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abort);
    }
  }
}
