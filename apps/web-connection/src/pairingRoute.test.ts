import { describe, expect, it } from "vitest";
import { isMobileBrowser, parsePairingRoute, validatedDesktopAuthorizationUrl } from "./pairingRoute";

describe("pairing route", () => {
  it("prefills and removes the iOS Demo deep-link code on /pair", () => {
    expect(parsePairingRoute("http://localhost:4173/pair?pairing_code=SAFE-482K")).toEqual({
      callbackPairingId: null,
      desktopCompletion: null,
      desktopAuthorizationUrl: null,
      initialCode: "SAFE-482K",
      sanitizedPath: "/pair",
      containsSensitiveQuery: true,
    });
  });

  it("retains an opaque callback identifier only in memory", () => {
    expect(parsePairingRoute("https://connect.whox.ai/pair?result=connected&pairingId=opaque-pairing#status"))
      .toEqual({
        callbackPairingId: "opaque-pairing",
      desktopCompletion: null,
      desktopAuthorizationUrl: null,
        initialCode: "",
        sanitizedPath: "/pair#status",
        containsSensitiveQuery: true,
      });
  });

  it("extracts and sanitizes a private desktop authorization fragment", () => {
    const authorization = "https://robinhood.com/oauth?state=opaque&code_challenge=safe";
    const href = `https://connect.whox.ai/desktop#${new URLSearchParams({ authorization })}`;
    expect(parsePairingRoute(href)).toMatchObject({
      desktopAuthorizationUrl: authorization,
      sanitizedPath: "/desktop",
      containsSensitiveQuery: true,
    });
  });

  it("recognizes a token-free desktop completion page", () => {
    expect(parsePairingRoute("https://connect.whox.ai/pair#desktop-complete")).toMatchObject({
      callbackPairingId: null,
      desktopCompletion: "complete",
      containsSensitiveQuery: false,
    });
  });

  it("allows only Robinhood HTTPS destinations and detects mobile browsers", () => {
    expect(validatedDesktopAuthorizationUrl("https://robinhood.com/oauth?state=opaque"))
      .toBe("https://robinhood.com/oauth?state=opaque");
    expect(validatedDesktopAuthorizationUrl("https://robinhood.com.attacker.test/oauth")).toBeNull();
    expect(validatedDesktopAuthorizationUrl("javascript:alert(1)")).toBeNull();
    expect(isMobileBrowser("Mozilla/5.0 (iPhone; CPU iPhone OS)", "iPhone", 5)).toBe(true);
    expect(isMobileBrowser("Mozilla/5.0 (Macintosh; Intel Mac OS X)", "MacIntel", 0)).toBe(false);
    expect(isMobileBrowser("Mozilla/5.0 (Macintosh; Intel Mac OS X)", "MacIntel", 5)).toBe(true);
  });
});
