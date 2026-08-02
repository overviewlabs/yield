import { createHash } from "node:crypto";
import { DomainError, type RiskPolicy, type RiskPolicyLimits } from "@whox/contracts";
import { validateUserPolicyAgainstPlatform } from "@whox/risk-schemas";

const MAXIMUM_LIMIT_KEYS = Object.freeze([
  "maximumAccountAllocation", "maximumPositionAmount", "maximumNewOrderAmount", "maximumDailyLoss",
  "maximumPortfolioDrawdown", "maximumSimultaneousPositions", "maximumSymbolConcentration",
  "maximumSectorConcentration", "maximumTradesPerDay", "maximumDailyTurnover", "maximumOptionsExposure",
  "maximumOptionRiskPerTrade", "maximumContractsPerTrade", "maximumDaysToExpiration",
  "maximumBidAskSpreadRatio", "maximumQuoteAgeSeconds", "maximumAccountSnapshotAgeSeconds",
  "maximumPriceDeviationRatio"
] as const satisfies readonly (keyof RiskPolicyLimits)[]);

const MINIMUM_LIMIT_KEYS = Object.freeze([
  "minimumBuyingPowerReserve", "minimumDaysToExpiration"
] as const satisfies readonly (keyof RiskPolicyLimits)[]);

const PERMISSION_KEYS = Object.freeze([
  "fractionalSharesPermitted", "extendedHoursPermitted", "earningsTradesPermitted",
  "coveredCallsPermitted", "protectivePutsPermitted", "definedRiskSpreadsPermitted"
] as const satisfies readonly (keyof RiskPolicy)[]);

export const RISK_POLICY_MUTABLE_KEYS = Object.freeze([
  ...MAXIMUM_LIMIT_KEYS,
  ...MINIMUM_LIMIT_KEYS,
  "excludedSymbols",
  "excludedSectors",
  ...PERMISSION_KEYS
] as const satisfies readonly (keyof RiskPolicy)[]);

const METADATA_KEYS = new Set(["policyId", "userId", "version", "updatedAt"]);
const STEP_UP_CONTROL_KEYS = new Set(["deviceId", "deviceContext", "stepUpProof", "authenticationProof"]);
const MUTABLE_KEY_SET = new Set<string>(RISK_POLICY_MUTABLE_KEYS);

export interface PreparedRiskPolicyUpdate {
  readonly candidate: RiskPolicy;
  readonly relaxationRequired: boolean;
  readonly stepUpResourceId: string;
}

const canonicalize = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.entries(value as Readonly<Record<string, unknown>>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`).join(",")}}`;
};

function normalizeExclusions(value: unknown, kind: "symbol" | "sector"): readonly string[] {
  if (!Array.isArray(value)) throw new DomainError("RISK_POLICY_FIELD_INVALID", `${kind === "symbol" ? "Excluded symbols" : "Excluded sectors"} must be an array`, 422);
  const normalized = value.map((entry) => {
    if (typeof entry !== "string") throw new DomainError("RISK_POLICY_FIELD_INVALID", `Every excluded ${kind} must be a string`, 422);
    const trimmed = entry.trim();
    if (kind === "symbol") {
      const symbol = trimmed.toUpperCase();
      if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol)) throw new DomainError("RISK_POLICY_FIELD_INVALID", "Every excluded symbol must be a valid ticker", 422);
      return symbol;
    }
    if (trimmed.length === 0 || trimmed.length > 80 || /[\u0000-\u001f\u007f]/.test(trimmed)) throw new DomainError("RISK_POLICY_FIELD_INVALID", "Every excluded sector must be a valid label", 422);
    return trimmed;
  });
  return Object.freeze([...new Set(normalized)].sort((left, right) => left.localeCompare(right)));
}

function policyPatch(body: Readonly<Record<string, unknown>>): Readonly<Partial<RiskPolicy>> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (METADATA_KEYS.has(key) || STEP_UP_CONTROL_KEYS.has(key)) continue;
    if (!MUTABLE_KEY_SET.has(key)) throw new DomainError("RISK_POLICY_FIELD_INVALID", `Risk policy field '${key}' cannot be changed`, 422);
    if ((PERMISSION_KEYS as readonly string[]).includes(key)) {
      if (typeof value !== "boolean") throw new DomainError("RISK_POLICY_FIELD_INVALID", `Risk policy field '${key}' must be boolean`, 422);
      patch[key] = value;
    } else if (key === "excludedSymbols") {
      patch[key] = normalizeExclusions(value, "symbol");
    } else if (key === "excludedSectors") {
      patch[key] = normalizeExclusions(value, "sector");
    } else {
      patch[key] = value;
    }
  }
  if (Object.keys(patch).length === 0) throw new DomainError("RISK_POLICY_PATCH_EMPTY", "At least one risk policy control must be changed", 422);
  return Object.freeze(patch) as Readonly<Partial<RiskPolicy>>;
}

function removesExclusion(current: readonly string[], candidate: readonly string[]): boolean {
  const next = new Set(candidate);
  return current.some((entry) => !next.has(entry));
}

function requiresStepUp(current: RiskPolicy, candidate: RiskPolicy): boolean {
  if (MAXIMUM_LIMIT_KEYS.some((key) => candidate[key] > current[key])) return true;
  if (MINIMUM_LIMIT_KEYS.some((key) => candidate[key] < current[key])) return true;
  if (PERMISSION_KEYS.some((key) => current[key] === false && candidate[key] === true)) return true;
  return removesExclusion(current.excludedSymbols, candidate.excludedSymbols)
    || removesExclusion(current.excludedSectors, candidate.excludedSectors);
}

export function prepareRiskPolicyUpdate(current: RiskPolicy, body: Readonly<Record<string, unknown>>, userId: string, updatedAt: string): PreparedRiskPolicyUpdate {
  const patch = policyPatch(body);
  const candidate = Object.freeze({
    ...current,
    ...patch,
    userId,
    policyId: current.policyId,
    version: current.version + 1,
    updatedAt
  }) as RiskPolicy;
  const violations = validateUserPolicyAgainstPlatform(candidate);
  if (violations.length > 0) throw new DomainError("RISK_POLICY_EXCEEDS_PLATFORM", "Risk policy exceeds platform caps", 422, { fields: violations });
  const boundPolicy = Object.fromEntries(RISK_POLICY_MUTABLE_KEYS.map((key) => [key, candidate[key]]));
  const digest = createHash("sha256").update(canonicalize(boundPolicy)).digest("hex");
  return Object.freeze({
    candidate,
    relaxationRequired: requiresStepUp(current, candidate),
    stepUpResourceId: `risk-policy:${current.policyId}:v${current.version}:${digest}`
  });
}
