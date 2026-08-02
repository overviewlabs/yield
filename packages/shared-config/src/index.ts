export const runtimeModes = ["demo", "paper", "live"] as const;
export type RuntimeMode = (typeof runtimeModes)[number];

export const releaseGateNames = [
  "LIVE_TRADING_ENABLED",
  "ROBINHOOD_PRODUCTION_APPROVED",
  "LEGAL_DOCUMENTS_APPROVED",
  "ADVISORY_COMPLIANCE_APPROVED",
  "APP_STORE_FINANCIAL_ENTITY_APPROVED",
  "OPTIONS_LIVE_TRADING_ENABLED",
  "AUTONOMOUS_MODE_ENABLED",
] as const;

export type ReleaseGateName = (typeof releaseGateNames)[number];
export type ReleaseGates = Readonly<Record<ReleaseGateName, boolean>>;

export const lockedReleaseGates: ReleaseGates = Object.freeze({
  LIVE_TRADING_ENABLED: false,
  ROBINHOOD_PRODUCTION_APPROVED: false,
  LEGAL_DOCUMENTS_APPROVED: false,
  ADVISORY_COMPLIANCE_APPROVED: false,
  APP_STORE_FINANCIAL_ENTITY_APPROVED: false,
  OPTIONS_LIVE_TRADING_ENABLED: false,
  AUTONOMOUS_MODE_ENABLED: false,
});

export interface BrandConfiguration {
  readonly appName: string;
  readonly descriptor: string;
  readonly tagline: string;
  readonly legalEntityName: string;
  readonly supportEmail: string;
  readonly bundleIdentifier: string;
  readonly apiURL: URL;
  readonly connectionURL: URL;
  readonly privacyURL: URL;
  readonly termsURL: URL;
}

export const defaultBrandConfiguration: BrandConfiguration = Object.freeze({
  appName: "Yield",
  descriptor: "Automated Strategy Control",
  tagline: "Put strategy within limits.",
  legalEntityName: "Yield (development configuration)",
  supportEmail: "support@whox.ai",
  bundleIdentifier: "ai.whox.yield",
  apiURL: new URL("https://api.whox.ai"),
  connectionURL: new URL("https://connect.whox.ai"),
  privacyURL: new URL("https://whox.ai/privacy"),
  termsURL: new URL("https://whox.ai/terms"),
});

export const robinhoodMcpEndpoint = new URL(
  "https://agent.robinhood.com/mcp/trading",
);

function parseStrictBoolean(name: ReleaseGateName, value: string | undefined): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`${name} must be exactly \"true\" or \"false\"`);
}

export function parseRuntimeMode(value: string | undefined): RuntimeMode {
  const candidate = value ?? "demo";
  if (runtimeModes.includes(candidate as RuntimeMode)) return candidate as RuntimeMode;
  throw new Error(`APP_ENV must be one of ${runtimeModes.join(", ")}`);
}

export function readReleaseGates(
  environment: Readonly<Record<string, string | undefined>>,
): ReleaseGates {
  return Object.freeze(
    Object.fromEntries(
      releaseGateNames.map((name) => [name, parseStrictBoolean(name, environment[name])]),
    ) as unknown as Record<ReleaseGateName, boolean>,
  );
}

export interface LiveTradingDecision {
  readonly allowed: boolean;
  readonly missingGates: readonly ReleaseGateName[];
  readonly reason: string;
}

export function evaluateLiveTradingGates(
  mode: RuntimeMode,
  gates: ReleaseGates,
  optionsOrder: boolean,
  autonomous: boolean,
): LiveTradingDecision {
  if (mode !== "live") {
    return {
      allowed: false,
      missingGates: [],
      reason: `${mode[0]?.toUpperCase()}${mode.slice(1)} mode cannot route orders to a broker.`,
    };
  }

  const applicable: ReleaseGateName[] = [
    "LIVE_TRADING_ENABLED",
    "ROBINHOOD_PRODUCTION_APPROVED",
    "LEGAL_DOCUMENTS_APPROVED",
    "ADVISORY_COMPLIANCE_APPROVED",
    "APP_STORE_FINANCIAL_ENTITY_APPROVED",
  ];
  if (optionsOrder) applicable.push("OPTIONS_LIVE_TRADING_ENABLED");
  if (autonomous) applicable.push("AUTONOMOUS_MODE_ENABLED");

  const missingGates = applicable.filter((name) => !gates[name]);
  return {
    allowed: missingGates.length === 0,
    missingGates,
    reason:
      missingGates.length === 0
        ? "All applicable server-side release gates are enabled."
        : `Live submission is locked by ${missingGates.join(", ")}.`,
  };
}

export function liveTradingGatesSatisfied(
  gates: ReleaseGates,
  instrumentType: "equity" | "option",
  approvalMode: "observe" | "confirm_every_trade" | "automatic_within_limits",
): boolean {
  return evaluateLiveTradingGates(
    "live",
    gates,
    instrumentType === "option",
    approvalMode === "automatic_within_limits",
  ).allowed;
}
