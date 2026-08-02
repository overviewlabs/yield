import { describe, expect, it } from "vitest";
import { parsePairingRoute } from "./pairingRoute";

describe("pairing route", () => {
  it("prefills and removes the iOS Demo deep-link code on /pair", () => {
    expect(parsePairingRoute("http://localhost:4173/pair?pairing_code=SAFE-482K")).toEqual({
      callbackPairingId: null,
      initialCode: "SAFE-482K",
      sanitizedPath: "/pair",
      containsSensitiveQuery: true,
    });
  });

  it("retains an opaque callback identifier only in memory", () => {
    expect(parsePairingRoute("https://connect.whox.ai/pair?result=connected&pairingId=opaque-pairing#status"))
      .toEqual({
        callbackPairingId: "opaque-pairing",
        initialCode: "",
        sanitizedPath: "/pair#status",
        containsSensitiveQuery: true,
      });
  });
});
