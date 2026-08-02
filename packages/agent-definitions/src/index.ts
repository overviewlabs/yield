import type { AccountEnvironment, Entitlements, InstrumentType } from "@whox/contracts";

export type SubscriptionPlan = "equity" | "equity_pro" | "options" | "options_pro";
export type AgentReleaseStatus = "draft" | "paper" | "limited_rollout" | "live" | "paused" | "retired";

export interface AgentDefinition {
  readonly agentId: string;
  readonly displayName: string;
  readonly version: string;
  readonly strategyCategory: string;
  readonly requiredSubscription: SubscriptionPlan;
  readonly permittedAccountModes: readonly AccountEnvironment[];
  readonly permittedInstruments: readonly InstrumentType[];
  readonly requiredBrokerageCapabilities: readonly string[];
  readonly riskClassification: "conservative" | "moderate" | "growth" | "aggressive" | "options_restricted";
  readonly typicalHoldingPeriod: string;
  readonly analysisSchedule: string;
  readonly entryCriteria: readonly string[];
  readonly exitCriteria: readonly string[];
  readonly dataDependencies: readonly string[];
  readonly hardRiskRequirements: readonly string[];
  readonly restrictedMarketConditions: readonly string[];
  readonly promptVersion?: string;
  readonly deterministicStrategyVersion: string;
  readonly status: AgentReleaseStatus;
  readonly disclosureText: string;
  readonly changeLog: readonly { readonly version: string; readonly date: string; readonly summary: string }[];
}

const commonDisclosure = "Investing involves loss risk. Strategy rules can fail, and neither paper nor historical results predict future results.";

export const AGENT_CATALOG: readonly AgentDefinition[] = Object.freeze([
  {
    agentId: "foundation-equity", displayName: "Foundation Equity", version: "1.0.0", strategyCategory: "diversified_long_only",
    requiredSubscription: "equity", permittedAccountModes: ["demo", "paper"], permittedInstruments: ["equity"],
    requiredBrokerageCapabilities: ["get_equity_quotes", "get_equity_tradability", "review_equity_order"],
    riskClassification: "moderate", typicalHoldingPeriod: "Weeks to months", analysisSchedule: "0 20 * * 1-5",
    entryCriteria: ["liquid stock or ETF", "diversification target passes", "tradability and risk checks pass"],
    exitCriteria: ["allocation rebalance", "deterministic risk exit", "instrument no longer eligible"],
    dataDependencies: ["portfolio snapshot", "equity quote", "tradability", "fundamentals"],
    hardRiskRequirements: ["long only", "no margin dependency", "no penny stocks", "portfolio allocation reservation"],
    restrictedMarketConditions: ["stale data", "trading halt", "extreme dislocation"],
    deterministicStrategyVersion: "foundation-equity-rules-1.0.0", status: "paper", disclosureText: commonDisclosure,
    changeLog: [{version:"1.0.0",date:"2026-08-01",summary:"Initial paper release"}]
  },
  {
    agentId: "equity-momentum", displayName: "Equity Momentum", version: "1.0.0", strategyCategory: "momentum_long_only",
    requiredSubscription: "equity_pro", permittedAccountModes: ["demo", "paper"], permittedInstruments: ["equity"],
    requiredBrokerageCapabilities: ["get_equity_quotes", "get_equity_technical_indicators", "get_equity_tradability", "review_equity_order"],
    riskClassification: "growth", typicalHoldingPeriod: "Days to weeks", analysisSchedule: "*/30 14-20 * * 1-5",
    entryCriteria: ["minimum liquidity", "trend and volume confirmation", "price dislocation guard passes"],
    exitCriteria: ["trend invalidation", "deterministic trailing exit", "time stop"],
    dataDependencies: ["quotes", "historicals", "technical indicators", "tradability"],
    hardRiskRequirements: ["long only", "no short selling", "no averaging down", "deterministic trailing control"],
    restrictedMarketConditions: ["volatility halt", "extreme gap", "insufficient liquidity"],
    deterministicStrategyVersion: "equity-momentum-rules-1.0.0", status: "draft", disclosureText: commonDisclosure,
    changeLog: [{version:"1.0.0",date:"2026-08-01",summary:"Draft specification; persistent runtime pipeline not implemented"}]
  },
  {
    agentId: "quality-swing", displayName: "Quality Swing", version: "1.0.0", strategyCategory: "quality_technical_swing",
    requiredSubscription: "equity_pro", permittedAccountModes: ["demo", "paper"], permittedInstruments: ["equity"],
    requiredBrokerageCapabilities: ["get_financials", "get_earnings_calendar", "get_equity_technical_indicators", "review_equity_order"],
    riskClassification: "growth", typicalHoldingPeriod: "Several days to several weeks", analysisSchedule: "0 */2 14-20 * * 1-5",
    entryCriteria: ["financial-quality screen", "technical confirmation", "event-risk policy passes"],
    exitCriteria: ["technical invalidation", "quality screen deterioration", "risk or time stop"],
    dataDependencies: ["financials", "earnings calendar", "quotes", "technical indicators"],
    hardRiskRequirements: ["long only", "earnings restriction", "position concentration cap"],
    restrictedMarketConditions: ["unverified earnings data", "market halt", "stale fundamentals"],
    deterministicStrategyVersion: "quality-swing-rules-1.0.0", status: "draft", disclosureText: commonDisclosure,
    changeLog: [{version:"1.0.0",date:"2026-08-01",summary:"Draft specification; persistent runtime pipeline not implemented"}]
  },
  {
    agentId: "directional-options", displayName: "Directional Options", version: "1.0.0", strategyCategory: "long_premium_directional",
    requiredSubscription: "options", permittedAccountModes: ["demo", "paper"], permittedInstruments: ["option"],
    requiredBrokerageCapabilities: ["get_option_chains", "get_option_quotes", "get_option_positions", "review_option_order"],
    riskClassification: "aggressive", typicalHoldingPeriod: "Days to weeks", analysisSchedule: "*/30 14-20 * * 1-5",
    entryCriteria: ["long call or put", "liquidity thresholds pass", "defined premium at risk", "at least 14 DTE"],
    exitCriteria: ["premium-loss limit", "thesis invalidation", "pre-expiration control"],
    dataDependencies: ["option chains", "option quotes", "underlying quotes", "earnings calendar"],
    hardRiskRequirements: ["limit order", "no 0DTE", "no averaging down", "known maximum loss"],
    restrictedMarketConditions: ["wide spread", "low liquidity", "earnings when restricted"],
    deterministicStrategyVersion: "directional-options-rules-1.0.0", status: "draft", disclosureText: `${commonDisclosure} Options can lose the entire premium quickly.`,
    changeLog: [{version:"1.0.0",date:"2026-08-01",summary:"Draft specification; persistent runtime pipeline not implemented"}]
  },
  {
    agentId: "covered-strategy", displayName: "Covered Strategy", version: "1.0.0", strategyCategory: "covered_calls_protective_puts",
    requiredSubscription: "options", permittedAccountModes: ["demo", "paper"], permittedInstruments: ["option"],
    requiredBrokerageCapabilities: ["get_equity_positions", "get_option_chains", "get_option_quotes", "review_option_order"],
    riskClassification: "growth", typicalHoldingPeriod: "Weeks", analysisSchedule: "0 */2 14-20 * * 1-5",
    entryCriteria: ["share coverage verified for calls", "collateral and permissions verified", "liquidity thresholds pass"],
    exitCriteria: ["coverage changes", "assignment-risk rule", "pre-expiration control"],
    dataDependencies: ["equity positions", "option chains", "option quotes", "dividend calendar"],
    hardRiskRequirements: ["no uncovered calls", "share coverage", "assignment and dividend warning"],
    restrictedMarketConditions: ["unverified coverage", "wide spread", "corporate action"],
    deterministicStrategyVersion: "covered-strategy-rules-1.0.0", status: "draft", disclosureText: `${commonDisclosure} Options may be assigned before expiration.`,
    changeLog: [{version:"1.0.0",date:"2026-08-01",summary:"Draft specification; persistent runtime pipeline not implemented"}]
  },
  {
    agentId: "defined-risk-spreads", displayName: "Defined-Risk Spreads", version: "1.0.0", strategyCategory: "defined_risk_multileg",
    requiredSubscription: "options_pro", permittedAccountModes: ["demo", "paper"], permittedInstruments: ["option"],
    requiredBrokerageCapabilities: ["get_option_chains", "get_option_quotes", "review_option_order"],
    riskClassification: "aggressive", typicalHoldingPeriod: "Days to weeks", analysisSchedule: "*/30 14-20 * * 1-5",
    entryCriteria: ["supported debit or limited-risk credit spread", "known maximum loss", "all legs liquid"],
    exitCriteria: ["spread risk limit", "thesis invalidation", "pre-expiration control"],
    dataDependencies: ["option chains", "option quotes", "underlying quote", "broker permissions"],
    hardRiskRequirements: ["defined maximum loss", "no naked short options", "atomic multi-leg support required"],
    restrictedMarketConditions: ["unsupported structure", "wide leg spread", "partial-fill risk"],
    deterministicStrategyVersion: "defined-risk-spreads-rules-1.0.0", status: "draft", disclosureText: `${commonDisclosure} Multi-leg orders have execution and assignment risks.`,
    changeLog: [{version:"1.0.0",date:"2026-08-01",summary:"Draft specification; persistent runtime pipeline not implemented"}]
  },
  {
    agentId: "range-volatility", displayName: "Range and Volatility", version: "1.0.0", strategyCategory: "limited_risk_range",
    requiredSubscription: "options_pro", permittedAccountModes: ["demo", "paper"], permittedInstruments: ["option"],
    requiredBrokerageCapabilities: ["get_option_chains", "get_option_quotes", "review_option_order"],
    riskClassification: "aggressive", typicalHoldingPeriod: "Days to weeks", analysisSchedule: "*/30 14-20 * * 1-5",
    entryCriteria: ["limited-risk range structure", "compliance approval", "event and liquidity filters pass"],
    exitCriteria: ["range invalidation", "maximum-loss rule", "pre-expiration control"],
    dataDependencies: ["option chains", "option quotes", "earnings calendar", "broker permissions"],
    hardRiskRequirements: ["defined risk", "strategy-specific approval", "assignment controls"],
    restrictedMarketConditions: ["strategy approval absent", "earnings event", "wide spreads"],
    deterministicStrategyVersion: "range-volatility-rules-1.0.0", status: "draft", disclosureText: `${commonDisclosure} This strategy is unavailable pending strategy-specific approval.`,
    changeLog: [{version:"1.0.0",date:"2026-08-01",summary:"Initial draft; live activation prohibited"}]
  }
]);

export function getAgentDefinition(agentId: string, version?: string): AgentDefinition | undefined {
  return AGENT_CATALOG.find((definition) => definition.agentId === agentId && (version === undefined || definition.version === version));
}

export function evaluateAgentAvailability(
  definition: AgentDefinition,
  environment: AccountEnvironment,
  entitlements: Entitlements,
  brokerCapabilities: ReadonlySet<string>
): { readonly available: boolean; readonly reasons: readonly string[] } {
  const reasons: string[] = [];
  if (!definition.permittedAccountModes.includes(environment)) reasons.push("ACCOUNT_MODE_NOT_PERMITTED");
  if (definition.status === "draft" || definition.status === "paused" || definition.status === "retired") reasons.push("AGENT_VERSION_NOT_ENABLED");
  if (definition.permittedInstruments.includes("option") && !entitlements.optionsTrading) reasons.push("OPTIONS_ENTITLEMENT_REQUIRED");
  if (definition.permittedInstruments.includes("equity") && !entitlements.stockTrading) reasons.push("EQUITY_ENTITLEMENT_REQUIRED");
  if (definition.requiredSubscription === "options_pro" && !entitlements.multiLegOptions) reasons.push("MULTI_LEG_ENTITLEMENT_REQUIRED");
  for (const capability of definition.requiredBrokerageCapabilities) {
    if (!brokerCapabilities.has(capability)) reasons.push(`BROKER_CAPABILITY_MISSING:${capability}`);
  }
  return Object.freeze({available: reasons.length === 0, reasons: Object.freeze(reasons)});
}
