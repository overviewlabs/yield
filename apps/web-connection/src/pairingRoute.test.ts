import { describe, expect, it } from "vitest";
import { parsePairingRoute } from "./pairingRoute";

describe("pairing route", () => {
  it("prefills and removes the iOS Demo deep-link code on /pair", () => {
    expect(parsePairingRoute("http://localhost:4173/pair?pairing_code=SAFE-482K")).toEqual({
      callbackPairingId: null,
      desktopCompletion: null,
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
        initialCode: "",
        sanitizedPath: "/pair#status",
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
});
