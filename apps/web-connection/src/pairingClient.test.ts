import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiPairingClient } from "./pairingClient";

afterEach(() => vi.unstubAllGlobals());

describe("API pairing client", () => {
  it("bootstraps a same-origin CSRF token before claiming a code", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: "csrf-one-use" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        pairingId: "pairing-1",
        code: "SAFE-482K",
        expiresAt: "2030-01-01T00:05:00.000Z",
        status: "pending",
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createApiPairingClient({
      apiBaseUrl: "https://api.whox.example",
      allowedAuthorizationOrigins: ["https://agent.robinhood.com"],
      accountMode: "Paper",
    });

    await expect(client.claim("SAFE-482K")).resolves.toMatchObject({ accountMode: "Paper" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({ "X-CSRF-Token": "csrf-one-use" });
    expect(fetchMock.mock.calls[1]?.[1]?.credentials).toBe("include");
  });

  it("starts authorization through a CSRF-protected POST and accepts only an allowlisted destination", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: "csrf-start" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        authorizationUrl: "https://agent.robinhood.com/authorize?request=opaque",
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createApiPairingClient({
      apiBaseUrl: "https://api.whox.example",
      allowedAuthorizationOrigins: ["https://agent.robinhood.com"],
      accountMode: "Paper",
    });
    await expect(client.beginAuthorization("pairing-safe")).resolves.toEqual({
      kind: "redirect",
      url: "https://agent.robinhood.com/authorize?request=opaque",
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST", credentials: "include" });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({ "X-CSRF-Token": "csrf-start" });
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ pairingId: "pairing-safe" }));
  });

  it("cancels an API-backed pairing through a CSRF-protected DELETE", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: "csrf-cancel" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createApiPairingClient({
      apiBaseUrl: "https://api.whox.example",
      allowedAuthorizationOrigins: ["https://agent.robinhood.com"],
      accountMode: "Paper",
    });

    await expect(client.cancel("pairing-cancel")).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.whox.example/v1/brokers/robinhood/pairings/pairing-cancel");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE", credentials: "include" });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({ "X-CSRF-Token": "csrf-cancel" });
  });

  it("does not fabricate account identity, capabilities, or a successful sync while hydration is pending", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      pairingId: "pairing-hydrating",
      code: "",
      expiresAt: "2030-01-01T00:05:00.000Z",
      status: "connected",
      connection: {
        capabilities: [],
      },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createApiPairingClient({
      apiBaseUrl: "https://api.whox.example",
      allowedAuthorizationOrigins: ["https://agent.robinhood.com"],
      accountMode: "Paper",
    });

    const result = await client.getCompletedConnection("pairing-hydrating");

    expect(result.receipt.maskedAccountIdentifier).toBe("Available after account sync");
    expect(result.receipt.capabilities).toEqual([]);
    expect(result.receipt).not.toHaveProperty("lastSuccessfulSync");
  });

  it("translates discovered broker tools into user-facing capability states", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      pairingId: "pairing-hydrated",
      code: "",
      expiresAt: "2030-01-01T00:05:00.000Z",
      status: "connected",
      connection: {
        maskedAccountIdentifier: "Agentic account •••• 2048",
        lastSuccessfulSync: "2026-08-01T14:00:00.000Z",
        capabilities: ["get_accounts", "get_portfolio", "review_equity_order"],
        equityTradingAvailable: true,
        optionsTradingAvailable: false,
      },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createApiPairingClient({
      apiBaseUrl: "https://api.whox.example",
      allowedAuthorizationOrigins: ["https://agent.robinhood.com"],
      accountMode: "Paper",
    });

    const result = await client.getCompletedConnection("pairing-hydrated");

    expect(result.receipt.capabilities).toMatchObject([
      { label: "Account and portfolio access", status: "available" },
      { label: "Equity order review", status: "available" },
      { label: "Options order review", status: "unavailable" },
    ]);
    expect(result.receipt.capabilities.map((capability) => capability.label)).not.toContain("get_accounts");
  });

  it("permits explicitly configured HTTP loopback for local Demo only", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: "csrf-loopback" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        authorizationUrl: "http://127.0.0.1:8080/v1/brokers/robinhood/oauth/demo-complete?state=opaque",
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createApiPairingClient({
      apiBaseUrl: "http://127.0.0.1:8080",
      allowedAuthorizationOrigins: ["https://agent.robinhood.com"],
      accountMode: "Demo",
    });
    await expect(client.beginAuthorization("pairing-local")).resolves.toEqual({
      kind: "redirect",
      url: "http://127.0.0.1:8080/v1/brokers/robinhood/oauth/demo-complete?state=opaque",
    });
  });

  it("rejects allowlisted non-loopback HTTP authorization destinations", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: "csrf-bad-http" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ authorizationUrl: "http://auth.example/authorize" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createApiPairingClient({
      apiBaseUrl: "https://api.whox.example",
      allowedAuthorizationOrigins: ["http://auth.example"],
      accountMode: "Paper",
    });
    await expect(client.beginAuthorization("pairing-unsafe")).rejects.toThrow(/unexpected destination/);
  });

  it("rejects HTTP loopback outside Demo mode", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: "csrf-paper-loopback" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        authorizationUrl: "http://127.0.0.1:8080/v1/brokers/robinhood/oauth/demo-complete",
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createApiPairingClient({
      apiBaseUrl: "https://api.whox.example",
      allowedAuthorizationOrigins: ["http://127.0.0.1:8080"],
      accountMode: "Paper",
    });
    await expect(client.beginAuthorization("pairing-paper")).rejects.toThrow(/unexpected destination/);
  });
});
