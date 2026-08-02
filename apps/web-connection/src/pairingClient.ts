import type { ConnectionReceipt, PairingSession } from "./pairingMachine";

export type PairingClient = {
  claim(code: string): Promise<PairingSession>;
  verifyIdentity(sessionId: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  getCompletedConnection(sessionId: string): Promise<{
    readonly session: PairingSession;
    readonly receipt: ConnectionReceipt;
  }>;
  beginAuthorization(sessionId: string): Promise<
    | { readonly kind: "redirect"; readonly url: string }
    | { readonly kind: "connected"; readonly receipt: ConnectionReceipt }
  >;
};

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

const demoReceipt: ConnectionReceipt = {
  maskedAccountIdentifier: "Agentic account •••• 2841",
  accountType: "Demo individual Agentic account",
  lastSuccessfulSync: new Date().toISOString(),
  capabilities: [
    {
      label: "Portfolio read access",
      status: "available",
      detail: "Demo portfolio and activity are available.",
    },
    {
      label: "Equity order tools",
      status: "restricted",
      detail: "Review is simulated; no order can reach a broker.",
    },
    {
      label: "Options order tools",
      status: "unavailable",
      detail: "Requires broker permission and separately approved live gates.",
    },
  ],
};

export function createMockPairingClient(): PairingClient {
  let failedAttempts = 0;
  let used = false;

  return {
    async claim(code) {
      await delay(360);
      if (failedAttempts >= 5) {
        throw new Error("Too many attempts. Wait before trying another pairing code.");
      }
      if (code !== "SAFE-482K") {
        failedAttempts += 1;
        throw new Error("That demo pairing code is not recognized. Check the code and try again.");
      }
      if (used) {
        throw new Error("That demo pairing code has already been used. Create a new session in the app.");
      }
      return {
        id: "demo-pairing-2841",
        displayCode: code,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        identityHint: "reviewer@privaterelay.example",
        accountMode: "Demo",
      };
    },
    async verifyIdentity() {
      await delay(420);
    },
    async cancel() {
      await delay(120);
    },
    async getCompletedConnection() {
      await delay(200);
      if (!used) throw new Error("The demo connection has not completed.");
      return {
        session: {
          id: "demo-pairing-2841",
          displayCode: "USED-PAIR",
          expiresAt: new Date().toISOString(),
          identityHint: "reviewer@privaterelay.example",
          accountMode: "Demo",
        },
        receipt: { ...demoReceipt, lastSuccessfulSync: new Date().toISOString() },
      };
    },
    async beginAuthorization() {
      await delay(900);
      used = true;
      return {
        kind: "connected",
        receipt: { ...demoReceipt, lastSuccessfulSync: new Date().toISOString() },
      };
    },
  };
}

type ApiClientOptions = {
  readonly apiBaseUrl: string;
  readonly allowedAuthorizationOrigins: readonly string[];
  readonly accountMode: "Demo" | "Paper" | "Live";
};

type ApiPairing = {
  readonly pairingId: string;
  readonly code: string;
  readonly expiresAt: string;
  readonly status: "pending" | "authorizing" | "connected" | "expired" | "canceled";
  readonly connection?: {
    readonly maskedAccountIdentifier?: string;
    readonly capabilities: readonly string[];
    readonly accountType?: string;
    readonly lastSuccessfulSync?: string;
    readonly equityTradingAvailable?: boolean;
    readonly optionsTradingAvailable?: boolean;
  };
};

function safeAuthorizationUrl(
  value: string,
  allowedOrigins: readonly string[],
  accountMode: ApiClientOptions["accountMode"],
): string {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  const secureTransport = url.protocol === "https:"
    || (url.protocol === "http:" && loopback && accountMode === "Demo");
  if (!secureTransport || !allowedOrigins.includes(url.origin)) {
    throw new Error("The authorization server returned an unexpected destination. Connection was stopped.");
  }
  return url.toString();
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const fallback = response.status === 401
      ? "An existing authenticated WHOX browser session is required. Sign in through the configured WHOX identity service, then retry; this pairing page does not start sign-in."
      : response.status === 429
        ? "Too many attempts. Wait before trying again."
        : "The secure connection service could not complete that request.";
    throw new Error(fallback);
  }
  return (await response.json()) as T;
}

export function createApiPairingClient(options: ApiClientOptions): PairingClient {
  const base = options.apiBaseUrl.replace(/\/$/, "");
  let csrfToken: string | null = null;

  const csrfHeaders = async (): Promise<Record<string, string>> => {
    if (csrfToken === null) {
      const response = await fetch(`${base}/v1/auth/csrf`, {
        method: "GET",
        credentials: "include",
        headers: { "X-WHOX-Client": "web-connection" },
      });
      const result = await parseResponse<{ readonly csrfToken: string }>(response);
      csrfToken = result.csrfToken;
    }
    return { "X-CSRF-Token": csrfToken };
  };

  const toSession = (pairing: ApiPairing): PairingSession => ({
    id: pairing.pairingId,
    displayCode: pairing.code,
    expiresAt: pairing.expiresAt,
    identityHint: "your authenticated WHOX identity",
    accountMode: options.accountMode,
  });

  const toReceipt = (pairing: ApiPairing): ConnectionReceipt => {
    if (pairing.connection === undefined || pairing.status !== "connected") {
      throw new Error("The broker connection has not completed. Return to the authorization page and try again.");
    }
    const discovered = new Set(pairing.connection.capabilities);
    const hydrated = pairing.connection.lastSuccessfulSync !== undefined;
    const capabilities: ConnectionReceipt["capabilities"] = !hydrated
      ? []
      : [
          {
            label: "Account and portfolio access",
            status: discovered.has("get_accounts") && discovered.has("get_portfolio")
              ? "available"
              : "unavailable",
            detail: discovered.has("get_accounts") && discovered.has("get_portfolio")
              ? "The verified Agentic Account can be monitored securely."
              : "Required broker account or portfolio access is unavailable.",
          },
          {
            label: "Equity order review",
            status: pairing.connection.equityTradingAvailable === true
              ? "available"
              : discovered.has("review_equity_order") ? "restricted" : "unavailable",
            detail: pairing.connection.equityTradingAvailable === true
              ? "Equity review is available; WHOX risk and approval controls still apply."
              : "Equity trading is not currently available for this account.",
          },
          {
            label: "Options order review",
            status: pairing.connection.optionsTradingAvailable === true
              ? "available"
              : discovered.has("review_option_order") ? "restricted" : "unavailable",
            detail: pairing.connection.optionsTradingAvailable === true
              ? "Options review is available; broker approval and WHOX controls still apply."
              : "Options require separate broker permission and WHOX release gates.",
          },
        ];
    return {
      maskedAccountIdentifier: pairing.connection.maskedAccountIdentifier ?? "Available after account sync",
      accountType: pairing.connection.accountType ?? "Verified Robinhood Agentic Account",
      ...(pairing.connection.lastSuccessfulSync === undefined
        ? {}
        : { lastSuccessfulSync: pairing.connection.lastSuccessfulSync }),
      capabilities,
    };
  };

  return {
    async claim(code) {
      const csrf = await csrfHeaders();
      const response = await fetch(`${base}/v1/brokers/robinhood/pairings/claim`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-WHOX-Client": "web-connection", ...csrf },
        body: JSON.stringify({ code }),
      });
      return toSession(await parseResponse<ApiPairing>(response));
    },
    async verifyIdentity(sessionId) {
      const response = await fetch(`${base}/v1/brokers/robinhood/pairings/${encodeURIComponent(sessionId)}`, {
        method: "GET",
        credentials: "include",
        headers: { "X-WHOX-Client": "web-connection" },
      });
      const pairing = await parseResponse<ApiPairing>(response);
      if (pairing.pairingId !== sessionId) throw new Error("Pairing ownership could not be verified.");
    },
    async cancel(sessionId) {
      const csrf = await csrfHeaders();
      const response = await fetch(`${base}/v1/brokers/robinhood/pairings/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
        credentials: "include",
        headers: { "X-WHOX-Client": "web-connection", ...csrf },
      });
      if (!response.ok) await parseResponse<never>(response);
    },
    async getCompletedConnection(sessionId) {
      const response = await fetch(`${base}/v1/brokers/robinhood/pairings/${encodeURIComponent(sessionId)}`, {
        method: "GET",
        credentials: "include",
        headers: { "X-WHOX-Client": "web-connection" },
      });
      const pairing = await parseResponse<ApiPairing>(response);
      return { session: toSession(pairing), receipt: toReceipt(pairing) };
    },
    async beginAuthorization(sessionId) {
      const csrf = await csrfHeaders();
      const response = await fetch(`${base}/v1/brokers/robinhood/oauth/start`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-WHOX-Client": "web-connection", ...csrf },
        body: JSON.stringify({ pairingId: sessionId }),
      });
      const result = await parseResponse<{ readonly authorizationUrl: string }>(response);
      return {
        kind: "redirect",
        url: safeAuthorizationUrl(
          result.authorizationUrl,
          [new URL(base).origin, ...options.allowedAuthorizationOrigins],
          options.accountMode,
        ),
      };
    },
  };
}
