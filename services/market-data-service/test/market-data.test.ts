import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import { Pool } from "pg";
import {
  DemoMarketDataProvider,
  HttpMarketDataProvider,
  MARKET_PROVIDER_MAX_RESPONSE_BYTES,
  MarketDataRefreshService,
  MemoryMarketSnapshotRepository,
  PostgresMarketSnapshotRepository,
  validateApprovedProviderConfiguration,
  validatePlanResearchQuoteJob,
  validateProviderQuote,
  validateRefreshQuoteJob
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const pool = databaseUrl === undefined ? undefined : new Pool({ connectionString: databaseUrl });
after(async () => pool?.end());

const receivedAt = Date.parse("2026-08-01T14:00:00.000Z");
const providerId = "approved-provider";
const providerSecret = "4f6e38d85a474e84ac4d0199a75e80cb";
const completeQuote = Object.freeze({
  symbol: "AAPL",
  bid: 199,
  ask: 201,
  last: 200,
  sourceTimestamp: "2026-08-01T14:00:00.000Z",
  provider: providerId,
  delayedBySeconds: 0,
  tradable: true,
  fractionalSupported: true,
  liquiditySufficient: true,
  marketSession: "open",
  volatilityHalt: false,
  tradingHalt: false,
  corporateActionRestricted: false,
  earningsWindow: false,
  sector: "Technology",
  brokerWarningSeverity: "none"
});

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => typeof error === "object" && error !== null && "code" in error && error.code === code;
}

describe("market data provenance", () => {
  it("labels complete deterministic fixtures only as Demo", async () => {
    const service = new MarketDataRefreshService(
      new DemoMarketDataProvider(() => new Date("2026-08-01T14:00:00.000Z")),
      new MemoryMarketSnapshotRepository()
    );
    const quotes = await service.refresh(["aapl"]);
    assert.equal(quotes[0]?.symbol, "AAPL");
    assert.equal(quotes[0]?.dataClassification, "demo");
    assert.equal(quotes[0]?.provider, "whox-demo-fixture");
    assert.equal(quotes[0]?.tradable, true);
    assert.equal(quotes[0]?.marketSession, "open");
    assert.equal(quotes[0]?.brokerWarningSeverity, "none");
  });

  it("requires the configured provider ID to be explicitly approved", () => {
    assert.deepEqual(
      validateApprovedProviderConfiguration(providerId, [providerId, "historical-approved-provider"]),
      { providerId, approvedProviders: [providerId, "historical-approved-provider"] }
    );
    assert.throws(
      () => validateApprovedProviderConfiguration(providerId, ["some-other-provider"]),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "MARKET_PROVIDER_NOT_APPROVED"
    );
  });

  it("binds persistent refresh jobs to both tenant and configured provider", () => {
    assert.deepEqual(
      validateRefreshQuoteJob({ symbols: ["aapl"], providerId }, "user-id", true, providerId),
      ["AAPL"]
    );
    assert.throws(
      () => validateRefreshQuoteJob({ symbols: ["AAPL"], providerId: "other-provider" }, "user-id", true, providerId),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "MARKET_JOB_INVALID"
    );
    assert.throws(
      () => validateRefreshQuoteJob({ symbols: ["AAPL"], providerId }, undefined, true, providerId),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "MARKET_JOB_INVALID"
    );
    assert.throws(
      () => validateRefreshQuoteJob(
        { symbols: ["AAPL"], providerId, bearerToken: "this-must-never-enter-a-durable-job" },
        "user-id",
        true,
        providerId
      ),
      /unsupported field/
    );
  });

  it("accepts only a strict tenant-free central plan research refresh", () => {
    const planCycleId = "paper-plan-cycle:01000000-0000-4000-8000-000000000001:32000000-0000-4000-8000-000000000001:31000000-0000-4000-8000-000000000001:1785542400:1785592800";
    assert.deepEqual(
      validatePlanResearchQuoteJob(
        { symbols: ["AAPL", "MSFT", "VTI"], providerId, planCycleId },
        undefined,
        true,
        providerId
      ),
      ["AAPL", "MSFT", "VTI"]
    );
    assert.throws(
      () => validatePlanResearchQuoteJob(
        { symbols: ["MSFT", "AAPL"], providerId, planCycleId },
        undefined,
        true,
        providerId
      ),
      /sorted and distinct/
    );
    assert.throws(
      () => validatePlanResearchQuoteJob(
        { symbols: ["AAPL"], providerId, planCycleId, userId: "leak" },
        undefined,
        true,
        providerId
      ),
      /invalid/
    );
    assert.throws(
      () => validatePlanResearchQuoteJob(
        { symbols: ["AAPL"], providerId, planCycleId },
        "tenant-must-not-own-plan-research",
        true,
        providerId
      ),
      /invalid/
    );
  });

  it("requires canonical HTTPS and a non-placeholder managed provider token", () => {
    assert.doesNotThrow(() => new HttpMarketDataProvider(new URL("https://market.vendor.invalid/v1/"), providerSecret, providerId));
    assert.throws(
      () => new HttpMarketDataProvider(new URL("http://127.0.0.1:9999/"), providerSecret, providerId),
      /canonical HTTPS/
    );
    assert.throws(
      () => new HttpMarketDataProvider(new URL("https://user:pass@market.vendor.invalid/v1/"), providerSecret, providerId),
      /canonical HTTPS/
    );
    assert.throws(
      () => new HttpMarketDataProvider(new URL("https://market.vendor.invalid/v1/?tenant=x"), providerSecret, providerId),
      /canonical HTTPS/
    );
    assert.throws(
      () => new HttpMarketDataProvider(new URL("https://market.vendor.invalid/v1/#fragment"), providerSecret, providerId),
      /canonical HTTPS/
    );
    assert.throws(
      () => new HttpMarketDataProvider(
        new URL("https://market.vendor.invalid/v1/"),
        "replace-with-provider-token-123456789",
        providerId
      ),
      /non-placeholder/
    );
  });

  it("rejects an oversized declared provider response before reading or persisting it", async () => {
    let canceled = false;
    const provider = new HttpMarketDataProvider(
      new URL("https://market.vendor.invalid/v1/"),
      providerSecret,
      providerId,
      async () => new Response(new ReadableStream<Uint8Array>({
        cancel() {
          canceled = true;
        }
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": String(MARKET_PROVIDER_MAX_RESPONSE_BYTES + 1)
        }
      })
    );
    const repository = new MemoryMarketSnapshotRepository();

    await assert.rejects(
      new MarketDataRefreshService(provider, repository).refresh(["AAPL"]),
      hasCode("MARKET_PROVIDER_RESPONSE_TOO_LARGE")
    );
    assert.equal(canceled, true);
    assert.equal(repository.quotes.size, 0);
  });

  it("rejects an oversized streamed provider response before parsing or persisting it", async () => {
    let emitted = 0;
    const provider = new HttpMarketDataProvider(
      new URL("https://market.vendor.invalid/v1/"),
      providerSecret,
      providerId,
      async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (emitted === 0) {
            controller.enqueue(new Uint8Array(MARKET_PROVIDER_MAX_RESPONSE_BYTES));
          } else if (emitted === 1) {
            controller.enqueue(new Uint8Array(1));
          } else {
            controller.close();
          }
          emitted += 1;
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const repository = new MemoryMarketSnapshotRepository();

    await assert.rejects(
      new MarketDataRefreshService(provider, repository).refresh(["AAPL"]),
      hasCode("MARKET_PROVIDER_RESPONSE_TOO_LARGE")
    );
    assert.equal(repository.quotes.size, 0);
  });

  it("rejects materially future provider timestamps", () => {
    assert.throws(
      () => validateProviderQuote(
        { ...completeQuote, sourceTimestamp: "2026-08-01T14:01:00.000Z" },
        providerId,
        receivedAt
      ),
      /materially in the future/
    );
  });

  it("rejects crossed markets and non-finite prices", () => {
    assert.throws(
      () => validateProviderQuote({ ...completeQuote, bid: 202, ask: 201 }, providerId, receivedAt),
      /provenance are invalid/
    );
  });

  it("rejects response provenance that differs from configured provider", () => {
    assert.throws(
      () => validateProviderQuote({ ...completeQuote, provider: "untrusted-provider" }, providerId, receivedAt),
      /configured-provider provenance/
    );
  });

  it("requires every context field consumed by the deterministic agent pipeline", () => {
    for (const field of [
      "tradable",
      "fractionalSupported",
      "liquiditySufficient",
      "volatilityHalt",
      "tradingHalt",
      "corporateActionRestricted",
      "earningsWindow"
    ]) {
      const incomplete = { ...completeQuote } as Record<string, unknown>;
      delete incomplete[field];
      assert.throws(() => validateProviderQuote(incomplete, providerId, receivedAt), new RegExp(field));
    }
    assert.throws(
      () => validateProviderQuote({ ...completeQuote, marketSession: "unknown" }, providerId, receivedAt),
      /marketSession/
    );
    assert.throws(
      () => validateProviderQuote({ ...completeQuote, brokerWarningSeverity: "unknown" }, providerId, receivedAt),
      /broker warning/
    );
    assert.throws(
      () => validateProviderQuote({ ...completeQuote, sector: "" }, providerId, receivedAt),
      /sector/
    );
  });
});

describe("PostgreSQL market quote context", { skip: databaseUrl === undefined }, () => {
  it("persists the full configured-provider context consumed by the agent pipeline", async () => {
    const uniqueProvider = `market-test-${randomUUID().replaceAll("-", "")}`;
    const sourceTimestamp = new Date().toISOString();
    const quote = validateProviderQuote(
      { ...completeQuote, provider: uniqueProvider, sourceTimestamp },
      uniqueProvider
    );
    const repository = new PostgresMarketSnapshotRepository(pool!);
    assert.equal(await repository.save([quote]), 1);
    const stored = await pool!.query<{ provider: string; payload: Record<string, unknown> }>(
      `SELECT provider,payload FROM market_data_snapshots
       WHERE provider=$1 AND symbol='AAPL' AND source_timestamp=$2::timestamptz`,
      [uniqueProvider, sourceTimestamp]
    );
    assert.equal(stored.rows[0]?.provider, uniqueProvider);
    assert.equal(stored.rows[0]?.payload.provider, uniqueProvider);
    assert.equal(stored.rows[0]?.payload.tradable, true);
    assert.equal(stored.rows[0]?.payload.fractionalSupported, true);
    assert.equal(stored.rows[0]?.payload.liquiditySufficient, true);
    assert.equal(stored.rows[0]?.payload.marketSession, "open");
    assert.equal(stored.rows[0]?.payload.sector, "Technology");
    assert.equal(stored.rows[0]?.payload.brokerWarningSeverity, "none");
  });
});
