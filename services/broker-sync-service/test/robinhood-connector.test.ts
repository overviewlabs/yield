import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { RobinhoodConnector } from "../src/robinhood-connector.js";

const originalFetch = globalThis.fetch;
const directories: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(directories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

describe("Robinhood isolated authorization connector", () => {
  it("discovers provider metadata, emits exact PKCE authorization, and encrypts each provisional token record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yield-robinhood-"));
    directories.push(directory);
    const requests: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.includes(".well-known")) return new Response(JSON.stringify({
        issuer: "https://agent.robinhood.com/mcp/trading",
        authorization_endpoint: "https://robinhood.com/oauth",
        token_endpoint: "https://tokens.test/exchange",
        code_challenge_methods_supported: ["S256"]
      }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === "https://tokens.test/exchange") return new Response(JSON.stringify({
        access_token: "opaque-access-token",
        refresh_token: "opaque-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "internal"
      }), { status: 200, headers: { "content-type": "application/json" } });
      throw new Error(`Unexpected request ${url}`);
    }) as typeof fetch;
    const connector = new RobinhoodConnector({
      clientId: "public-client-id",
      redirectUri: "https://api.whox.ai/v1/brokers/robinhood/mobile-oauth/callback",
      vaultDirectory: directory,
      vaultKey: Buffer.alloc(32, 19),
      databaseUrl: "postgresql://unused"
    });
    try {
      const start = await connector.beginAuthorization({
        state: "opaque-state", codeChallenge: "opaque-challenge", codeChallengeMethod: "S256",
        clientId: "public-client-id", scopes: ["internal"], redirectUri: connector.metadata.redirectUri,
        resourceUri: connector.identity.resourceUri
      });
      const destination = new URL(start.authorizationUrl);
      assert.equal(destination.href.startsWith("https://robinhood.com/oauth?"), true);
      assert.equal(destination.searchParams.get("state"), "opaque-state");
      assert.equal(destination.searchParams.get("code_challenge"), "opaque-challenge");
      const transactionId = "11111111-1111-4111-8111-111111111111";
      const exchange = await connector.exchangeAuthorizationCode({
        exchangeTransactionId: transactionId, code: "one-time-code", codeVerifier: "verifier",
        redirectUri: connector.metadata.redirectUri, resourceUri: connector.identity.resourceUri
      });
      assert.equal(exchange.completion.credentialHandle, `vault://robinhood/${transactionId}`);
      const stored = await readFile(join(directory, `${transactionId}.json`), "utf8");
      assert.equal(stored.includes("opaque-access-token"), false);
      assert.equal(stored.includes("opaque-refresh-token"), false);
      await connector.confirmAuthorizationPersistence(transactionId, exchange.completion);
      assert.equal(JSON.parse(await readFile(join(directory, `${transactionId}.json`), "utf8")).status, "confirmed");
      assert.deepEqual(requests, [
        "https://agent.robinhood.com/.well-known/oauth-authorization-server/mcp/trading",
        "https://agent.robinhood.com/.well-known/oauth-authorization-server/mcp/trading",
        "https://tokens.test/exchange"
      ]);
    } finally {
      await connector.close();
    }
  });
});
