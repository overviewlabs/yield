import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  HermesResearchProvider,
  createSanitizedHermesResearchArtifact,
  createHermesResearchProviderFromEnvironment,
  hermesResearchForSymbol,
  parseSanitizedHermesResearchArtifact,
  type FoundationEquityResearchRequest
} from "../src/index.js";

const receivedAt = "2026-08-01T18:00:00.000Z";
const created = Date.parse(receivedAt) / 1_000;
const apiKey = "k".repeat(64);
const request: FoundationEquityResearchRequest = Object.freeze({
  requestId: "71000000-0000-4000-8000-000000000001",
  planCycleId:
    "paper-plan-cycle:11000000-0000-4000-8000-000000000001:21000000-0000-4000-8000-000000000001:31000000-0000-4000-8000-000000000001:1785607200:1785607200",
  planId: "11000000-0000-4000-8000-000000000001",
  planCatalogVersionId: "21000000-0000-4000-8000-000000000001",
  agentVersionId: "31000000-0000-4000-8000-000000000001",
  agentKey: "foundation-equity",
  agentVersion: "1.0.0",
  deterministicStrategyVersion: "foundation-equity-v1",
  sourceAsOf: receivedAt,
  contextDigest: "c".repeat(64),
  symbols: Object.freeze([
    Object.freeze({
      symbol: "AAPL",
      sector: "Technology",
      bid: 199.5,
      ask: 200,
      last: 199.8,
      sourceTimestamp: receivedAt,
      marketSession: "open" as const,
      liquiditySufficient: true,
      volatilityHalt: false,
      tradingHalt: false
    }),
    Object.freeze({
      symbol: "MSFT",
      sector: "Technology",
      bid: 449.5,
      ask: 450,
      last: 449.8,
      sourceTimestamp: receivedAt,
      marketSession: "open" as const,
      liquiditySufficient: true,
      volatilityHalt: false,
      tradingHalt: false
    })
  ])
});

function analysis(value: FoundationEquityResearchRequest = request): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: "whox.foundation-equity-research.v1",
    requestId: value.requestId,
    analyses: value.symbols.map((quote) => Object.freeze({
      symbol: quote.symbol,
      assessment: "cautionary",
      summary: `${quote.symbol} public-market conditions warrant independent deterministic review.`,
      riskFactors: Object.freeze(["Market conditions may change."]),
      dataLimitations: Object.freeze(["Only the supplied public quote context was evaluated."])
    }))
  });
}

function completion(
  content: unknown = analysis(),
  overrides: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id: "chatcmpl-hermes-research-1",
    object: "chat.completion",
    created,
    model: "treasury-bot",
    choices: Object.freeze([
      Object.freeze({
        index: 0,
        message: Object.freeze({ role: "assistant", content: JSON.stringify(content) }),
        finish_reason: "stop"
      })
    ]),
    ...overrides
  });
}

function jsonResponse(value: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  });
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean =>
    typeof error === "object" && error !== null && "code" in error && error.code === code;
}

describe("Hermes plan-cycle research boundary", () => {
  it("sends one tool-free, tenant-free public-market request and returns bound provenance", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetcher: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return jsonResponse(completion());
    };
    const provider = new HermesResearchProvider(apiKey, fetcher, { clock: () => new Date(receivedAt) });
    const result = await provider.research(request);

    assert.equal(capturedUrl, "https://treasury-bot.whox.ai/v1/chat/completions");
    assert.equal(capturedInit?.redirect, "error");
    const serialized = String(capturedInit?.body);
    const body = JSON.parse(serialized) as {
      tools: unknown[];
      tool_choice: string;
      messages: readonly { role: string; content: string }[];
      response_format: { json_schema: { strict: boolean; schema: { additionalProperties: boolean } } };
    };
    assert.deepEqual(body.tools, []);
    assert.equal(body.tool_choice, "none");
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
    const publicContext = JSON.parse(body.messages[1]!.content) as Readonly<Record<string, unknown>>;
    assert.deepEqual(Object.keys(publicContext).sort(), [
      "agentKey",
      "agentVersion",
      "agentVersionId",
      "contextDigest",
      "deterministicStrategyVersion",
      "planCatalogVersionId",
      "planCycleId",
      "planId",
      "requestId",
      "sourceAsOf",
      "symbols"
    ]);
    for (const forbidden of [
      "tenant-user-id",
      "broker-account-id",
      "broker-connection-id",
      "oauth-token-secret",
      "portfolio-total-value",
      "position-quantity",
      "risk-policy-limit",
      "legal-consent-state"
    ]) {
      assert.equal(serialized.includes(forbidden), false);
    }
    assert.equal(serialized.includes(apiKey), false);
    assert.equal(result.model, "treasury-bot");
    assert.equal(result.requestId, request.requestId);
    assert.equal(result.responseId, "chatcmpl-hermes-research-1");
    assert.equal(result.analysis.analyses.length, 2);
    assert.equal(result.analysis.analyses[0]?.assessment, "cautionary");
    assert.equal(result.contextDigest, request.contextDigest);
    assert.equal(result.requestDigest, createHash("sha256").update(serialized).digest("hex"));
    const artifact = createSanitizedHermesResearchArtifact(result);
    assert.equal(hermesResearchForSymbol(artifact, "MSFT").symbol, "MSFT");
    assert.throws(() => hermesResearchForSymbol(artifact, "VTI"), hasCode("PLAN_RESEARCH_SYMBOL_REQUIRED"));
    assert.throws(
      () => parseSanitizedHermesResearchArtifact({ ...artifact, unknown: "rejected" }),
      hasCode("PLAN_RESEARCH_ARTIFACT_INVALID")
    );
  });

  it("requires the exact endpoint, model, managed key, and tool-free profile attestation", () => {
    assert.equal(createHermesResearchProviderFromEnvironment("demo", {}), undefined);
    assert.equal(createHermesResearchProviderFromEnvironment("demo", {
      HERMES_API_KEY: "",
      HERMES_RESEARCH_PROFILE_TOOLS_DISABLED: "false"
    }), undefined);
    assert.throws(
      () => createHermesResearchProviderFromEnvironment("paper", { HERMES_API_KEY: apiKey }),
      hasCode("HERMES_RESEARCH_PROFILE_UNSAFE")
    );
    assert.throws(
      () => createHermesResearchProviderFromEnvironment("demo", { HERMES_API_KEY: apiKey }),
      hasCode("HERMES_RESEARCH_PROFILE_UNSAFE")
    );
    assert.throws(
      () => createHermesResearchProviderFromEnvironment("paper", {
        HERMES_RESEARCH_PROFILE_TOOLS_DISABLED: "true"
      }),
      hasCode("HERMES_API_KEY_REQUIRED")
    );
    assert.throws(
      () => createHermesResearchProviderFromEnvironment("paper", {
        HERMES_API_KEY: "",
        HERMES_RESEARCH_PROFILE_TOOLS_DISABLED: "true"
      }),
      hasCode("HERMES_API_KEY_REQUIRED")
    );
    assert.throws(
      () => createHermesResearchProviderFromEnvironment("paper", {
        HERMES_BASE_URL: "https://treasury-bot.whox.ai/v1/",
        HERMES_API_KEY: apiKey,
        HERMES_RESEARCH_PROFILE_TOOLS_DISABLED: "true"
      }),
      hasCode("HERMES_BASE_URL_INVALID")
    );
    assert.throws(
      () => createHermesResearchProviderFromEnvironment("paper", {
        HERMES_MODEL: "different-model",
        HERMES_API_KEY: apiKey,
        HERMES_RESEARCH_PROFILE_TOOLS_DISABLED: "true"
      }),
      hasCode("HERMES_MODEL_INVALID")
    );
    assert.ok(createHermesResearchProviderFromEnvironment("paper", {
      HERMES_API_KEY: apiKey,
      HERMES_RESEARCH_PROFILE_TOOLS_DISABLED: "true"
    }));
  });

  it("fails closed on refusals, tool calls, incomplete symbol coverage, and unknown fields", async () => {
    const scenarios: readonly unknown[] = [
      completion(undefined, {
        choices: [{
          index: 0,
          message: { role: "assistant", content: JSON.stringify(analysis()), refusal: "I cannot comply" },
          finish_reason: "stop"
        }]
      }),
      completion(undefined, {
        choices: [{
          index: 0,
          message: { role: "assistant", content: JSON.stringify(analysis()), tool_calls: [{ id: "danger" }] },
          finish_reason: "tool_calls"
        }]
      }),
      completion({ ...analysis(), analyses: [(analysis().analyses as readonly unknown[])[0]] }),
      completion({ ...analysis(), unsupported: true })
    ];
    for (const scenario of scenarios) {
      const provider = new HermesResearchProvider(apiKey, async () => jsonResponse(scenario), {
        clock: () => new Date(receivedAt)
      });
      await assert.rejects(provider.research(request), hasCode("HERMES_RESEARCH_INVALID"));
    }
  });

  it("rejects prohibited input fields and the entire cycle above 50 symbols before HTTP", async () => {
    let calls = 0;
    const provider = new HermesResearchProvider(apiKey, async () => {
      calls += 1;
      return jsonResponse(completion());
    }, { clock: () => new Date(receivedAt) });
    await assert.rejects(
      provider.research({ ...request, userId: "tenant-data-must-not-cross" } as FoundationEquityResearchRequest),
      hasCode("HERMES_RESEARCH_REQUEST_INVALID")
    );
    const template = request.symbols[0]!;
    const oversized = Object.freeze({
      ...request,
      symbols: Object.freeze(Array.from({ length: 51 }, (_value, index) => Object.freeze({
        ...template,
        symbol: `A${String(index).padStart(3, "0")}`
      })))
    });
    await assert.rejects(provider.research(oversized), hasCode("HERMES_RESEARCH_REQUEST_INVALID"));
    assert.equal(calls, 0);
  });

  it("rejects non-string public quote fields before HTTP", async () => {
    let calls = 0;
    const provider = new HermesResearchProvider(apiKey, async () => {
      calls += 1;
      return jsonResponse(completion());
    }, { clock: () => new Date(receivedAt) });
    const template = request.symbols[0]!;
    for (const malformed of [
      Object.freeze({ ...template, sector: 7 }),
      Object.freeze({ ...template, sourceTimestamp: 1_785_607_200_000 })
    ]) {
      await assert.rejects(
        provider.research({
          ...request,
          symbols: Object.freeze([malformed])
        } as unknown as FoundationEquityResearchRequest),
        hasCode("HERMES_RESEARCH_REQUEST_INVALID")
      );
    }
    assert.equal(calls, 0);
  });

  it("fits one full 50-symbol cycle within the completion and byte budgets", async () => {
    const template = request.symbols[0]!;
    const maximumRequest: FoundationEquityResearchRequest = Object.freeze({
      ...request,
      symbols: Object.freeze(Array.from({ length: 50 }, (_value, index) => Object.freeze({
        ...template,
        symbol: `A${String(index).padStart(3, "0")}`
      })))
    });
    const responseValue = completion(analysis(maximumRequest));
    const responseBytes = Buffer.byteLength(JSON.stringify(responseValue));
    assert.ok(responseBytes < 64 * 1_024, `50-symbol fixture is ${responseBytes} bytes`);
    let requestBody: { max_tokens?: number } | undefined;
    const provider = new HermesResearchProvider(apiKey, async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as { max_tokens?: number };
      return jsonResponse(responseValue);
    }, { clock: () => new Date(receivedAt) });
    const result = await provider.research(maximumRequest);
    assert.equal(result.analysis.analyses.length, 50);
    assert.equal(requestBody?.max_tokens, 12_000);
  });

  it("bounds response bytes and rejects stale provenance timestamps", async () => {
    const oversized = new HermesResearchProvider(
      apiKey,
      async () => jsonResponse(completion(), { "content-length": "65537" }),
      { clock: () => new Date(receivedAt) }
    );
    await assert.rejects(oversized.research(request), hasCode("HERMES_RESEARCH_RESPONSE_TOO_LARGE"));

    const stale = new HermesResearchProvider(
      apiKey,
      async () => jsonResponse(completion(analysis(), { created: created - 901 })),
      { clock: () => new Date(receivedAt) }
    );
    await assert.rejects(stale.research(request), hasCode("HERMES_RESEARCH_INVALID"));
  });

  it("aborts a provider request at the hard timeout", async () => {
    const fetcher: typeof fetch = async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const keepAlive = setTimeout(() => reject(new Error("Abort signal was not delivered")), 100);
      if (signal?.aborted === true) {
        clearTimeout(keepAlive);
        reject(signal.reason);
        return;
      }
      signal?.addEventListener("abort", () => {
        clearTimeout(keepAlive);
        reject(signal.reason);
      }, { once: true });
    });
    const provider = new HermesResearchProvider(apiKey, fetcher, {
      timeoutMs: 5,
      clock: () => new Date(receivedAt)
    });
    await assert.rejects(provider.research(request), hasCode("HERMES_RESEARCH_UNAVAILABLE"));
  });
});
