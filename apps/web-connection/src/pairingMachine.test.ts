import { describe, expect, it } from "vitest";
import {
  formatPairingCode,
  initialPairingState,
  isValidPairingCode,
  pairingReducer,
  secondsUntil,
} from "./pairingMachine";

const session = {
  id: "pairing-1",
  displayCode: "SAFE-482K",
  expiresAt: "2030-01-01T00:05:00.000Z",
  identityHint: "u***@example.com",
  accountMode: "Demo" as const,
};

describe("pairing code", () => {
  it("normalizes a pasted code without keeping extra characters", () => {
    expect(formatPairingCode(" safe 482k secret ")).toBe("SAFE-482K");
  });

  it("rejects ambiguous and short codes", () => {
    expect(isValidPairingCode("ABCI-1234")).toBe(false);
    expect(isValidPairingCode("SAFE-482")).toBe(false);
    expect(isValidPairingCode("SAFE-482K")).toBe(true);
  });

  it("never returns a negative countdown", () => {
    expect(secondsUntil("2028-01-01T00:00:00.000Z", Date.parse("2029-01-01T00:00:00.000Z"))).toBe(0);
  });
});

describe("pairing state machine", () => {
  it("accepts only ordered transitions", () => {
    const accepted = pairingReducer(initialPairingState, { type: "CODE_ACCEPTED", session });
    expect(accepted.stage).toBe("identity");
    expect(pairingReducer(accepted, { type: "AUTHORIZATION_STARTED" })).toEqual(accepted);
    const verified = pairingReducer(accepted, { type: "IDENTITY_VERIFIED" });
    expect(pairingReducer(verified, { type: "AUTHORIZATION_STARTED" }).stage).toBe("authorizing");
  });

  it("invalidates an unfinished expired session", () => {
    const accepted = pairingReducer(initialPairingState, { type: "CODE_ACCEPTED", session });
    expect(pairingReducer(accepted, { type: "EXPIRED" }).stage).toBe("expired");
  });
});
