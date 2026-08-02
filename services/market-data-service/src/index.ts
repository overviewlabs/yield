import { DomainError } from "@whox/contracts";
import type { Pool } from "pg";

const PROVIDER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLACEHOLDER_SECRET_PATTERN = /(replace|change[_ -]?me|example|placeholder|not[_ -]?for[_ -]?production|local[_ -]?only|development[_ -]?key|dummy)/i;
export const MARKET_PROVIDER_MAX_RESPONSE_BYTES = 128 * 1_024;
const BOOLEAN_CONTEXT_KEYS = [
  "tradable",
  "fractionalSupported",
  "liquiditySufficient",
  "volatilityHalt",
  "tradingHalt",
  "corporateActionRestricted",
  "earningsWindow"
] as const;

export interface MarketQuote {
  readonly symbol: string;
  readonly bid: number;
  readonly ask: number;
  readonly last: number;
  readonly sourceTimestamp: string;
  readonly provider: string;
  readonly delayedBySeconds: number;
  readonly tradable: boolean;
  readonly fractionalSupported: boolean;
  readonly liquiditySufficient: boolean;
  readonly marketSession: "open" | "extended" | "closed";
  readonly volatilityHalt: boolean;
  readonly tradingHalt: boolean;
  readonly corporateActionRestricted: boolean;
  readonly earningsWindow: boolean;
  readonly sector: string;
  readonly brokerWarningSeverity: "none" | "informational" | "blocking";
  readonly dataClassification: "demo" | "market_provider";
}

export interface MarketDataProvider {
  quotes(symbols: readonly string[]): Promise<readonly MarketQuote[]>;
}

export interface MarketSnapshotRepository {
  save(quotes: readonly MarketQuote[]): Promise<number>;
}

export class DemoMarketDataProvider implements MarketDataProvider {
  readonly #prices: Readonly<Record<string, number>> = Object.freeze({ AAPL: 200, MSFT: 450, SPY: 650 });

  public constructor(private readonly now: () => Date = () => new Date()) {}

  public async quotes(symbols: readonly string[]): Promise<readonly MarketQuote[]> {
    return Object.freeze(symbols.map((raw) => {
      const symbol = validateSymbol(raw);
      const last = this.#prices[symbol] ?? 100;
      return Object.freeze({
        symbol,
        bid: Number((last * 0.9995).toFixed(4)),
        ask: Number((last * 1.0005).toFixed(4)),
        last,
        sourceTimestamp: this.now().toISOString(),
        provider: "whox-demo-fixture",
        delayedBySeconds: 0,
        tradable: true,
        fractionalSupported: true,
        liquiditySufficient: true,
        marketSession: "open" as const,
        volatilityHalt: false,
        tradingHalt: false,
        corporateActionRestricted: false,
        earningsWindow: false,
        sector: "Demo",
        brokerWarningSeverity: "none" as const,
        dataClassification: "demo" as const
      });
    }));
  }
}

export class HttpMarketDataProvider implements MarketDataProvider {
  readonly #providerId: string;
  readonly #bearerToken: string;

  public constructor(
    private readonly baseUrl: URL,
    bearerToken: string,
    providerId: string,
    private readonly request: typeof fetch = fetch
  ) {
    if (
      baseUrl.protocol !== "https:" ||
      baseUrl.hostname === "" ||
      baseUrl.username !== "" ||
      baseUrl.password !== "" ||
      baseUrl.hash !== "" ||
      baseUrl.search !== "" ||
      baseUrl.href.includes("?") ||
      baseUrl.href.includes("#")
    ) {
      throw new TypeError("Market-data provider URL must be canonical HTTPS without credentials, query, or fragment");
    }
    const normalizedToken = bearerToken.trim();
    if (
      normalizedToken.length < 32 ||
      normalizedToken.length > 4096 ||
      normalizedToken !== bearerToken ||
      !/^[\x21-\x7e]+$/.test(normalizedToken) ||
      PLACEHOLDER_SECRET_PATTERN.test(normalizedToken)
    ) {
      throw new TypeError("Market-data provider token must be a non-placeholder managed secret");
    }
    this.#bearerToken = normalizedToken;
    this.#providerId = validateProviderId(providerId);
  }

  public async quotes(symbols: readonly string[]): Promise<readonly MarketQuote[]> {
    const normalized = [...new Set(symbols.map(validateSymbol))];
    if (normalized.length === 0 || normalized.length > 100) {
      throw new DomainError("MARKET_SYMBOLS_INVALID", "One through 100 symbols are required", 422);
    }
    const url = new URL("quotes", this.baseUrl.href.endsWith("/") ? this.baseUrl : new URL(`${this.baseUrl.href}/`));
    url.searchParams.set("symbols", normalized.join(","));
    const response = await this.request(url, {
      headers: { accept: "application/json", authorization: `Bearer ${this.#bearerToken}` },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
      throw new DomainError("MARKET_PROVIDER_FAILED", `Market-data provider returned HTTP ${response.status}`, 502);
    }
    let value: unknown;
    try {
      value = JSON.parse(await readBoundedProviderBody(response));
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("MARKET_PROVIDER_INVALID", "Market-data provider returned invalid JSON", 502);
    }
    if (typeof value !== "object" || value === null || !Array.isArray((value as Record<string, unknown>).data)) {
      throw new DomainError("MARKET_PROVIDER_INVALID", "Market-data response schema is invalid", 502);
    }
    const receivedAt = Date.now();
    const quotes = (value as { data: unknown[] }).data.map((quote) =>
      validateProviderQuote(quote, this.#providerId, receivedAt)
    );
    const returned = new Set(quotes.map((quote) => quote.symbol));
    if (quotes.length !== normalized.length || returned.size !== quotes.length || normalized.some((symbol) => !returned.has(symbol))) {
      throw new DomainError("MARKET_PROVIDER_INCOMPLETE", "Market-data provider omitted or duplicated a requested symbol", 502);
    }
    return Object.freeze(quotes);
  }
}

async function readBoundedProviderBody(response: Response): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(declaredLength)) {
      await cancelResponseBody(response);
      throw new DomainError("MARKET_PROVIDER_INVALID", "Market-data provider returned an invalid content length", 502);
    }
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength > MARKET_PROVIDER_MAX_RESPONSE_BYTES) {
      await cancelResponseBody(response);
      throw new DomainError(
        "MARKET_PROVIDER_RESPONSE_TOO_LARGE",
        "Market-data provider response exceeded 128 KiB",
        502
      );
    }
  }
  if (response.body === null) {
    throw new DomainError("MARKET_PROVIDER_INVALID", "Market-data provider response body is missing", 502);
  }

  const reader = response.body.getReader();
  const bytes = new Uint8Array(MARKET_PROVIDER_MAX_RESPONSE_BYTES);
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const nextTotal = total + next.value.byteLength;
      if (nextTotal > MARKET_PROVIDER_MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The bounded failure remains authoritative even if transport cancellation fails.
        }
        throw new DomainError(
          "MARKET_PROVIDER_RESPONSE_TOO_LARGE",
          "Market-data provider response exceeded 128 KiB",
          502
        );
      }
      bytes.set(next.value, total);
      total = nextTotal;
    }
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError("MARKET_PROVIDER_INVALID", "Market-data provider response could not be read", 502);
  } finally {
    reader.releaseLock();
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, total));
  } catch {
    throw new DomainError("MARKET_PROVIDER_INVALID", "Market-data provider response is not valid UTF-8", 502);
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (response.body === null) return;
  try {
    await response.body.cancel();
  } catch {
    // Size and framing validation fail closed even if transport cancellation fails.
  }
}

export class MemoryMarketSnapshotRepository implements MarketSnapshotRepository {
  public readonly quotes = new Map<string, MarketQuote>();
  public async save(quotes: readonly MarketQuote[]): Promise<number> {
    for (const quote of quotes) this.quotes.set(quote.symbol, quote);
    return quotes.length;
  }
}

export class PostgresMarketSnapshotRepository implements MarketSnapshotRepository {
  public constructor(private readonly pool: Pool) {}

  public async save(quotes: readonly MarketQuote[]): Promise<number> {
    let saved = 0;
    for (const quote of quotes) {
      const result = await this.pool.query(
        `INSERT INTO market_data_snapshots(provider,symbol,data_type,payload,source_timestamp,delayed_by_seconds)
         VALUES($1,$2,'quote',$3::jsonb,$4::timestamptz,$5)
         ON CONFLICT(provider,symbol,data_type,source_timestamp) DO NOTHING`,
        [quote.provider, quote.symbol, JSON.stringify(quote), quote.sourceTimestamp, quote.delayedBySeconds]
      );
      saved += result.rowCount ?? 0;
    }
    return saved;
  }
}

export class MarketDataRefreshService {
  public constructor(
    private readonly provider: MarketDataProvider,
    private readonly repository: MarketSnapshotRepository
  ) {}

  public async refresh(symbols: readonly string[]): Promise<readonly MarketQuote[]> {
    const quotes = await this.provider.quotes(symbols);
    if (quotes.length === 0) throw new DomainError("MARKET_PROVIDER_EMPTY", "Market-data provider returned no quotes", 502);
    await this.repository.save(quotes);
    return quotes;
  }
}

export function validateSymbol(value: string): string {
  const symbol = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol)) {
    throw new DomainError("MARKET_SYMBOL_INVALID", "Market symbol is invalid", 422);
  }
  return symbol;
}

export function validateProviderId(value: string): string {
  const providerId = value.trim();
  if (!PROVIDER_ID_PATTERN.test(providerId)) {
    throw new DomainError("MARKET_PROVIDER_ID_INVALID", "Market-data provider ID is invalid", 500);
  }
  return providerId;
}

export function validateApprovedProviderConfiguration(
  providerIdValue: string,
  approvedProviderValues: readonly string[]
): { readonly providerId: string; readonly approvedProviders: readonly string[] } {
  const providerId = validateProviderId(providerIdValue);
  const approvedProviders = [...new Set(approvedProviderValues.map((value) => validateProviderId(value)))];
  if (approvedProviders.length === 0 || !approvedProviders.includes(providerId)) {
    throw new DomainError(
      "MARKET_PROVIDER_NOT_APPROVED",
      "Configured market-data provider ID must be present in APPROVED_MARKET_DATA_PROVIDERS",
      500
    );
  }
  return Object.freeze({ providerId, approvedProviders: Object.freeze(approvedProviders) });
}

export function validateRefreshQuoteJob(
  payload: Readonly<Record<string, unknown>>,
  userId: string | undefined,
  persistent: boolean,
  configuredProviderId: string
): readonly string[] {
  const allowedKeys = new Set([
    "symbols",
    "providerId",
    "userAgentId",
    "scheduleBucket",
    "source",
    "proposalId",
    "correlationId"
  ]);
  if (Object.keys(payload).some((key) => !allowedKeys.has(key))) {
    throw new DomainError("MARKET_JOB_INVALID", "Market-data refresh payload contains an unsupported field", 422);
  }
  const symbols = payload.symbols;
  if (!Array.isArray(symbols) || symbols.length === 0 || symbols.length > 100 || symbols.some((value) => typeof value !== "string")) {
    throw new DomainError("MARKET_JOB_INVALID", "Market-data refresh symbols are invalid", 422);
  }
  if (persistent && (userId === undefined || payload.providerId !== configuredProviderId)) {
    throw new DomainError("MARKET_JOB_INVALID", "Persistent market-data refresh tenant or provider binding is invalid", 422);
  }
  if (payload.providerId !== undefined && payload.providerId !== configuredProviderId) {
    throw new DomainError("MARKET_JOB_INVALID", "Market-data refresh provider binding is invalid", 422);
  }
  for (const key of ["userAgentId", "proposalId", "correlationId"] as const) {
    if (payload[key] !== undefined && (typeof payload[key] !== "string" || !UUID_PATTERN.test(payload[key]))) {
      throw new DomainError("MARKET_JOB_INVALID", `Market-data refresh ${key} is invalid`, 422);
    }
  }
  if (
    payload.scheduleBucket !== undefined &&
    (typeof payload.scheduleBucket !== "string" || !Number.isFinite(Date.parse(payload.scheduleBucket)))
  ) {
    throw new DomainError("MARKET_JOB_INVALID", "Market-data refresh scheduleBucket is invalid", 422);
  }
  if (
    payload.source !== undefined &&
    !["paper-agent-scheduler", "execution-worker"].includes(String(payload.source))
  ) {
    throw new DomainError("MARKET_JOB_INVALID", "Market-data refresh source is invalid", 422);
  }
  return Object.freeze([...new Set((symbols as string[]).map(validateSymbol))]);
}

export function validatePlanResearchQuoteJob(
  payload: Readonly<Record<string, unknown>>,
  userId: string | undefined,
  persistent: boolean,
  configuredProviderId: string
): readonly string[] {
  const allowedKeys = new Set(["symbols", "providerId", "planCycleId"]);
  const symbols = payload.symbols;
  if (
    Object.keys(payload).some((key) => !allowedKeys.has(key)) ||
    !persistent ||
    userId !== undefined ||
    payload.providerId !== configuredProviderId ||
    typeof payload.planCycleId !== "string" ||
    !/^paper-plan-cycle:[0-9a-f-]{36}:[0-9a-f-]{36}:[0-9a-f-]{36}:[0-9]{1,12}:[0-9]{1,12}$/.test(payload.planCycleId) ||
    !Array.isArray(symbols) ||
    symbols.length < 1 ||
    symbols.length > 50 ||
    symbols.some((value) => typeof value !== "string")
  ) {
    throw new DomainError("PLAN_RESEARCH_MARKET_JOB_INVALID", "Plan research quote refresh is invalid", 422);
  }
  const parsed = (symbols as string[]).map(validateSymbol);
  const sorted = [...parsed].sort((left, right) => left.localeCompare(right));
  if (new Set(parsed).size !== parsed.length || parsed.some((symbol, index) => symbol !== sorted[index])) {
    throw new DomainError("PLAN_RESEARCH_MARKET_JOB_INVALID", "Plan research symbols must be sorted and distinct", 422);
  }
  return Object.freeze(parsed);
}

export function validateProviderQuote(value: unknown, expectedProviderId: string, receivedAt = Date.now()): MarketQuote {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError("MARKET_PROVIDER_INVALID", "Quote must be an object", 502);
  }
  const providerId = validateProviderId(expectedProviderId);
  const item = value as Record<string, unknown>;
  const symbol = validateSymbol(String(item.symbol ?? ""));
  for (const key of ["bid", "ask", "last", "delayedBySeconds"] as const) {
    if (typeof item[key] !== "number" || !Number.isFinite(item[key]) || item[key] < 0) {
      throw new DomainError("MARKET_PROVIDER_INVALID", `Quote ${key} is invalid`, 502);
    }
  }
  if (!Number.isInteger(item.delayedBySeconds)) {
    throw new DomainError("MARKET_PROVIDER_INVALID", "Quote delayedBySeconds must be a nonnegative integer", 502);
  }
  if (
    Number(item.bid) > Number(item.ask) ||
    Number(item.ask) <= 0 ||
    Number(item.last) <= 0 ||
    typeof item.sourceTimestamp !== "string" ||
    !Number.isFinite(Date.parse(item.sourceTimestamp)) ||
    item.provider !== providerId
  ) {
    throw new DomainError("MARKET_PROVIDER_INVALID", "Quote prices or configured-provider provenance are invalid", 502);
  }
  if (Date.parse(item.sourceTimestamp) > receivedAt + 5_000) {
    throw new DomainError("MARKET_PROVIDER_CLOCK_DRIFT", "Market-data timestamp is materially in the future", 502);
  }
  for (const key of BOOLEAN_CONTEXT_KEYS) {
    if (typeof item[key] !== "boolean") {
      throw new DomainError("MARKET_PROVIDER_INVALID", `Quote ${key} context is invalid`, 502);
    }
  }
  if (!["open", "extended", "closed"].includes(String(item.marketSession))) {
    throw new DomainError("MARKET_PROVIDER_INVALID", "Quote marketSession context is invalid", 502);
  }
  if (!["none", "informational", "blocking"].includes(String(item.brokerWarningSeverity))) {
    throw new DomainError("MARKET_PROVIDER_INVALID", "Quote broker warning context is invalid", 502);
  }
  const sector = typeof item.sector === "string" ? item.sector.trim() : "";
  if (sector.length === 0 || sector.length > 100) {
    throw new DomainError("MARKET_PROVIDER_INVALID", "Quote sector context is invalid", 502);
  }
  return Object.freeze({
    symbol,
    bid: Number(item.bid),
    ask: Number(item.ask),
    last: Number(item.last),
    sourceTimestamp: item.sourceTimestamp,
    provider: providerId,
    delayedBySeconds: Number(item.delayedBySeconds),
    tradable: item.tradable as boolean,
    fractionalSupported: item.fractionalSupported as boolean,
    liquiditySufficient: item.liquiditySufficient as boolean,
    marketSession: item.marketSession as MarketQuote["marketSession"],
    volatilityHalt: item.volatilityHalt as boolean,
    tradingHalt: item.tradingHalt as boolean,
    corporateActionRestricted: item.corporateActionRestricted as boolean,
    earningsWindow: item.earningsWindow as boolean,
    sector,
    brokerWarningSeverity: item.brokerWarningSeverity as MarketQuote["brokerWarningSeverity"],
    dataClassification: "market_provider"
  });
}
