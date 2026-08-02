import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateLiveTradingGates,
  lockedReleaseGates,
  readReleaseGates,
} from "../dist/index.js";

test("all release gates are false by default", () => {
  assert.deepEqual(readReleaseGates({}), lockedReleaseGates);
});

test("demo and paper can never route a live order", () => {
  const enabled = Object.fromEntries(
    Object.keys(lockedReleaseGates).map((name) => [name, true]),
  );
  assert.equal(evaluateLiveTradingGates("demo", enabled, false, false).allowed, false);
  assert.equal(evaluateLiveTradingGates("paper", enabled, false, false).allowed, false);
});

test("a live options automation request requires all seven gates", () => {
  const decision = evaluateLiveTradingGates("live", lockedReleaseGates, true, true);
  assert.equal(decision.allowed, false);
  assert.equal(decision.missingGates.length, 7);
});

test("configuration rejects ambiguous booleans", () => {
  assert.throws(() => readReleaseGates({ LIVE_TRADING_ENABLED: "1" }));
});
