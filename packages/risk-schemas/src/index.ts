import { createHash } from "node:crypto";
import {
  liveTradingGatesSatisfied,
  type Entitlements,
  type ReleaseGates,
  type RiskCheckResult,
  type RiskEvaluation,
  type RiskPolicy,
  type RiskPolicyLimits,
  type TradeProposal
} from "@whox/contracts";

export const PLATFORM_RISK_LIMITS: RiskPolicyLimits = Object.freeze({
  maximumAccountAllocation: 0.8,
  maximumPositionAmount: 50_000,
  maximumNewOrderAmount: 10_000,
  maximumDailyLoss: 5_000,
  maximumPortfolioDrawdown: 0.2,
  minimumBuyingPowerReserve: 0.1,
  maximumSimultaneousPositions: 30,
  maximumSymbolConcentration: 0.2,
  maximumSectorConcentration: 0.4,
  maximumTradesPerDay: 20,
  maximumDailyTurnover: 1,
  maximumOptionsExposure: 0.2,
  maximumOptionRiskPerTrade: 2_500,
  maximumContractsPerTrade: 10,
  minimumDaysToExpiration: 14,
  maximumDaysToExpiration: 365,
  maximumBidAskSpreadRatio: 0.1,
  maximumQuoteAgeSeconds: 30,
  maximumAccountSnapshotAgeSeconds: 60,
  maximumPriceDeviationRatio: 0.03
});
export const MAX_CLOCK_SKEW_SECONDS = 5;

export interface RiskContext {
  readonly now: string;
  readonly releaseGates: ReleaseGates;
  readonly userStatus: "active" | "suspended" | "closed";
  readonly currentLegalConsents: boolean;
  readonly entitlements: Entitlements;
  readonly accountConnectionHealthy: boolean;
  readonly verifiedAgenticAccountId: string;
  readonly strategyEnabled: boolean;
  readonly agentVersionEnabled: boolean;
  readonly tradingPermission: boolean;
  readonly marketSession: "open" | "extended" | "closed";
  readonly criticalServicesHealthy: boolean;
  readonly securityHalt: boolean;
  readonly accountValue: number;
  readonly buyingPower: number;
  readonly reservedBuyingPower: number;
  readonly currentAllocatedValue: number;
  readonly currentPositionValue: number;
  readonly currentHeldQuantity?:number;
  readonly currentSectorValue: number;
  readonly openPositionCount: number;
  readonly dailyLoss: number;
  readonly drawdownRatio: number;
  readonly agentAllocatedValue: number;
  readonly agentAllocationLimit: number;
  readonly otherAgentReservations: number;
  readonly duplicateProposal: boolean;
  readonly duplicateOpenOrder: boolean;
  readonly symbolSector?: string;
  readonly tradable: boolean;
  readonly fractionalSupported: boolean;
  readonly liquiditySufficient: boolean;
  readonly volatilityHalt: boolean;
  readonly tradingHalt: boolean;
  readonly corporateActionRestricted: boolean;
  readonly earningsWindow: boolean;
  readonly cooldownActive: boolean;
  readonly tradesToday: number;
  readonly turnoverToday: number;
  readonly accountSnapshotTimestamp: string;
  readonly quotePrice: number;
  readonly expectedExecutionPrice: number;
  readonly optionDaysToExpiration?: number;
  readonly optionBidAskSpreadRatio?: number;
  readonly openOptionsExposure?: number;
  readonly optionsPermission?: boolean;
  readonly optionCoverageVerified?: boolean;
  readonly brokerWarningSeverity: "none" | "informational" | "blocking";
  readonly approvalExpiresAt?: string;
  /** Supplied only by the trusted position/approval service after a fresh position lookup. */
  readonly riskReducingExit?: {
    readonly verifiedBy: "position-service";
    readonly accountId: string;
    readonly symbol: string;
    readonly instrumentType: "equity" | "option";
    readonly maximumClosableQuantity: number;
    readonly verifiedAt: string;
    readonly userApprovalId: string;
  };
}

const smallerIsStricter: readonly (keyof RiskPolicyLimits)[] = [
  "maximumAccountAllocation", "maximumPositionAmount", "maximumNewOrderAmount", "maximumDailyLoss",
  "maximumPortfolioDrawdown", "maximumSimultaneousPositions", "maximumSymbolConcentration",
  "maximumSectorConcentration", "maximumTradesPerDay", "maximumDailyTurnover", "maximumOptionsExposure",
  "maximumOptionRiskPerTrade", "maximumContractsPerTrade", "maximumDaysToExpiration",
  "maximumBidAskSpreadRatio", "maximumQuoteAgeSeconds", "maximumAccountSnapshotAgeSeconds",
  "maximumPriceDeviationRatio"
];

export function validateUserPolicyAgainstPlatform(policy: RiskPolicy): readonly string[] {
  const violations = new Set<string>();
  const ratioKeys:readonly (keyof RiskPolicyLimits)[]=["maximumAccountAllocation","maximumPortfolioDrawdown","minimumBuyingPowerReserve","maximumSymbolConcentration","maximumSectorConcentration","maximumDailyTurnover","maximumOptionsExposure","maximumBidAskSpreadRatio","maximumPriceDeviationRatio"];
  for(const key of Object.keys(PLATFORM_RISK_LIMITS) as (keyof RiskPolicyLimits)[]){const value=policy[key];if(typeof value!=="number"||!Number.isFinite(value)||value<0)violations.add(key);}
  for(const key of ratioKeys)if(policy[key]>1)violations.add(key);
  for(const key of ["maximumSimultaneousPositions","maximumTradesPerDay","maximumContractsPerTrade","minimumDaysToExpiration","maximumDaysToExpiration","maximumQuoteAgeSeconds","maximumAccountSnapshotAgeSeconds"] as const)if(!Number.isInteger(policy[key]))violations.add(key);
  for (const key of smallerIsStricter) {
    if (policy[key] > PLATFORM_RISK_LIMITS[key]) violations.add(key);
  }
  if (policy.minimumBuyingPowerReserve < PLATFORM_RISK_LIMITS.minimumBuyingPowerReserve) {
    violations.add("minimumBuyingPowerReserve");
  }
  if (policy.minimumDaysToExpiration < PLATFORM_RISK_LIMITS.minimumDaysToExpiration) {
    violations.add("minimumDaysToExpiration");
  }
  if(policy.minimumDaysToExpiration>policy.maximumDaysToExpiration)violations.add("minimumDaysToExpiration");
  return Object.freeze([...violations]);
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function proposalFingerprint(proposal: TradeProposal): string {
  return createHash("sha256").update(canonicalize(proposal)).digest("hex");
}

function check(
  code: string,
  passed: boolean,
  message: string,
  observed?: number | string | boolean,
  limit?: number | string | boolean,
  severity: RiskCheckResult["severity"] = "blocking"
): RiskCheckResult {
  const result: RiskCheckResult = { code, passed, severity, message };
  return Object.freeze({
    ...result,
    ...(observed === undefined ? {} : { observed }),
    ...(limit === undefined ? {} : { limit })
  });
}

function ageSeconds(now: number, timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? (now - parsed) / 1_000 : Number.POSITIVE_INFINITY;
}

export function evaluateRisk(proposal: TradeProposal, policy: RiskPolicy, context: RiskContext): RiskEvaluation {
  const now = Date.parse(context.now);
  if (!Number.isFinite(now)) throw new TypeError("RiskContext.now must be an ISO-8601 timestamp");
  const policyViolations = validateUserPolicyAgainstPlatform(policy);
  const isOption = proposal.instrumentType === "option";
  const equitySale=proposal.instrumentType==="equity"&&proposal.side==="sell";
  const exitScope=context.riskReducingExit;
  const exitDirectionValid=equitySale||(isOption&&proposal.optionLegs.length>0&&proposal.optionLegs.every((leg)=>leg.positionEffect==="close"));
  const exitScopeMatches=exitScope!==undefined&&exitScope.verifiedBy==="position-service"&&exitScope.accountId===proposal.accountId&&exitScope.symbol.toUpperCase()===proposal.symbol.toUpperCase()&&exitScope.instrumentType===proposal.instrumentType&&Number.isFinite(exitScope.maximumClosableQuantity)&&exitScope.maximumClosableQuantity>0&&proposal.quantity<=exitScope.maximumClosableQuantity&&exitScope.userApprovalId.trim()!==""&&ageSeconds(now,exitScope.verifiedAt)<=policy.maximumAccountSnapshotAgeSeconds&&exitDirectionValid;
  const riskReducingExit=exitScopeMatches;
  const allocationDirection=riskReducingExit||equitySale?-1:1;
  const isFractional = !Number.isInteger(proposal.quantity);
  const allocationAfter = context.accountValue > 0
    ? Math.max(0,context.currentAllocatedValue + allocationDirection*proposal.notionalEstimate) / context.accountValue
    : Number.POSITIVE_INFINITY;
  const positionAfter = Math.max(0,context.currentPositionValue + allocationDirection*proposal.notionalEstimate);
  const symbolConcentration = context.accountValue > 0 ? positionAfter / context.accountValue : Number.POSITIVE_INFINITY;
  const sectorConcentration = context.accountValue > 0
    ? Math.max(0,context.currentSectorValue + allocationDirection*proposal.notionalEstimate) / context.accountValue
    : Number.POSITIVE_INFINITY;
  const reserveAfter = context.accountValue > 0
    ? (context.buyingPower - context.reservedBuyingPower - context.otherAgentReservations - (equitySale?0:proposal.notionalEstimate)) / context.accountValue
    : Number.NEGATIVE_INFINITY;
  const quoteAge = ageSeconds(now, proposal.quoteTimestamp);
  const dataAge = ageSeconds(now, proposal.dataTimestamp);
  const accountAge = ageSeconds(now, context.accountSnapshotTimestamp);
  const priceDeviation = context.quotePrice > 0
    ? Math.abs(context.expectedExecutionPrice - context.quotePrice) / context.quotePrice
    : Number.POSITIVE_INFINITY;
  const dte = context.optionDaysToExpiration ?? -1;
  const spread = context.optionBidAskSpreadRatio ?? Number.POSITIVE_INFINITY;
  const optionsExposureAfter = Math.max(0,(context.openOptionsExposure ?? 0) + (riskReducingExit?-proposal.riskAmount:proposal.riskAmount));
  const optionsExposureRatio = context.accountValue > 0 ? optionsExposureAfter / context.accountValue : Number.POSITIVE_INFINITY;
  const contractCount = proposal.optionLegs.reduce((total, leg) => total + Math.abs(leg.ratioQuantity * proposal.quantity), 0);
  const approvalExpired = context.approvalExpiresAt !== undefined && Date.parse(context.approvalExpiresAt) <= now;
  const clockDriftSeconds=Math.max(...[proposal.quoteTimestamp,proposal.dataTimestamp,context.accountSnapshotTimestamp,...(exitScope===undefined?[]:[exitScope.verifiedAt])].map((timestamp)=>{const parsed=Date.parse(timestamp);return Number.isFinite(parsed)?(parsed-now)/1_000:Number.POSITIVE_INFINITY;}));

  const checks: RiskCheckResult[] = [
    check("POLICY_WITHIN_PLATFORM_CAPS", policyViolations.length === 0, "User policy cannot exceed platform limits", policyViolations.join(",") || "none", "none"),
    check("POLICY_USER_BINDING", policy.userId === proposal.userId, "Risk policy must belong to the proposal owner", policy.userId, proposal.userId),
    check("LIVE_RELEASE_GATES", proposal.environment !== "live" || liveTradingGatesSatisfied(context.releaseGates, proposal.instrumentType, proposal.requiredApprovalMode), "All applicable live release gates must be enabled"),
    check("USER_ACTIVE", context.userStatus === "active", "User account must be active", context.userStatus, "active"),
    check("LEGAL_CONSENTS_CURRENT", context.currentLegalConsents, "Required legal consents must be current"),
    check("ENTITLEMENT", riskReducingExit || (isOption ? context.entitlements.optionsTrading : context.entitlements.stockTrading), "Subscription must entitle new exposure; verified protective exits remain available"),
    check("ACCOUNT_CONNECTION", context.accountConnectionHealthy, "Broker connection must be healthy"),
    check("AGENTIC_ACCOUNT_BINDING", proposal.accountId === context.verifiedAgenticAccountId, "Proposal must target the verified Agentic Account"),
    check("STRATEGY_ENABLED", riskReducingExit || (context.strategyEnabled && context.agentVersionEnabled), "Strategy and agent version must be enabled for new exposure"),
    check("TRADING_PERMISSION", context.tradingPermission, "Broker trading permission must be present"),
    check("MARKET_SESSION", context.marketSession === "open" || (context.marketSession === "extended" && policy.extendedHoursPermitted), "Market session must be permitted", context.marketSession),
    check("CRITICAL_SERVICES_HEALTHY", context.criticalServicesHealthy, "Critical services must be healthy"),
    check("SECURITY_HALT_CLEAR", riskReducingExit || !context.securityHalt, "Security halt blocks new exposure but not a verified, user-approved protective exit"),
    check("NO_DUPLICATE_PROPOSAL", !context.duplicateProposal, "Proposal must not duplicate a prior proposal"),
    check("NO_DUPLICATE_OPEN_ORDER", !context.duplicateOpenOrder, "No matching open order may exist"),
    check("RISK_REDUCING_EXIT_SCOPE", exitScope===undefined||exitScopeMatches, "Protective exit scope must match a fresh server-verified position and user approval"),
    check("EQUITY_LONG_ONLY", !equitySale || proposal.quantity <= (context.currentHeldQuantity??0), "Equity sell quantity cannot exceed verified held quantity", proposal.quantity, context.currentHeldQuantity??0),
    check("ORDER_AMOUNT", riskReducingExit || proposal.notionalEstimate <= policy.maximumNewOrderAmount, "New-exposure order amount must not exceed limit", proposal.notionalEstimate, policy.maximumNewOrderAmount),
    check("POSITION_AMOUNT", riskReducingExit || positionAfter <= policy.maximumPositionAmount, "Position amount after new exposure must not exceed limit", positionAfter, policy.maximumPositionAmount),
    check("SYMBOL_CONCENTRATION", riskReducingExit || symbolConcentration <= policy.maximumSymbolConcentration, "New symbol concentration must not exceed limit", symbolConcentration, policy.maximumSymbolConcentration),
    check("SECTOR_CONCENTRATION", riskReducingExit || sectorConcentration <= policy.maximumSectorConcentration, "New sector concentration must not exceed limit", sectorConcentration, policy.maximumSectorConcentration),
    check("ACCOUNT_ALLOCATION", riskReducingExit || allocationAfter <= policy.maximumAccountAllocation, "New account allocation must not exceed limit", allocationAfter, policy.maximumAccountAllocation),
    check("POSITION_COUNT", riskReducingExit || context.openPositionCount + (!equitySale&&context.currentPositionValue === 0 ? 1 : 0) <= policy.maximumSimultaneousPositions, "New exposure must not exceed the position-count limit"),
    check("BUYING_POWER", riskReducingExit||equitySale||context.buyingPower - context.reservedBuyingPower - context.otherAgentReservations >= proposal.notionalEstimate, "Available buying power must cover new exposure"),
    check("BUYING_POWER_RESERVE", riskReducingExit || reserveAfter >= policy.minimumBuyingPowerReserve, "New exposure must preserve the buying-power reserve", reserveAfter, policy.minimumBuyingPowerReserve),
    check("DAILY_LOSS", riskReducingExit || context.dailyLoss < policy.maximumDailyLoss, "Daily loss halt blocks new exposure", context.dailyLoss, policy.maximumDailyLoss),
    check("DRAWDOWN", riskReducingExit || context.drawdownRatio < policy.maximumPortfolioDrawdown, "Portfolio drawdown halt blocks new exposure", context.drawdownRatio, policy.maximumPortfolioDrawdown),
    check("AGENT_ALLOCATION", riskReducingExit || Math.max(0,context.agentAllocatedValue + allocationDirection*proposal.notionalEstimate) <= context.agentAllocationLimit, "New agent allocation must not be exceeded"),
    check("SYMBOL_NOT_EXCLUDED", riskReducingExit || !policy.excludedSymbols.includes(proposal.symbol.toUpperCase()), "Excluded symbols cannot receive new exposure"),
    check("SECTOR_NOT_EXCLUDED", riskReducingExit || context.symbolSector === undefined || !policy.excludedSectors.includes(context.symbolSector), "Excluded sectors cannot receive new exposure"),
    check("TRADABLE", context.tradable, "Instrument must be tradable"),
    check("FRACTIONAL_SUPPORTED", !isFractional || (policy.fractionalSharesPermitted && context.fractionalSupported), "Fractional quantity must be permitted and supported"),
    check("LIQUIDITY", context.liquiditySufficient, "Liquidity requirements must be met"),
    check("VOLATILITY_HALT_CLEAR", !context.volatilityHalt, "Volatility halt must be clear"),
    check("TRADING_HALT_CLEAR", !context.tradingHalt, "Trading halt must be clear"),
    check("CORPORATE_ACTION_CLEAR", !context.corporateActionRestricted, "Corporate-action restriction must be clear"),
    check("EARNINGS_RULE", riskReducingExit || !context.earningsWindow || policy.earningsTradesPermitted, "Earnings-window rules block new exposure"),
    check("COOLDOWN_CLEAR", riskReducingExit || !context.cooldownActive, "Loss/re-entry cooldown blocks new exposure"),
    check("DAILY_TRADES", riskReducingExit || context.tradesToday < policy.maximumTradesPerDay, "Daily trade limit blocks new exposure", context.tradesToday, policy.maximumTradesPerDay),
    check("DAILY_TURNOVER", riskReducingExit || context.turnoverToday + proposal.notionalEstimate / Math.max(context.accountValue, 1) <= policy.maximumDailyTurnover, "Daily turnover limit blocks new exposure"),
    check("CLOCK_DRIFT", clockDriftSeconds <= MAX_CLOCK_SKEW_SECONDS, "Market, account, and position-verification timestamps cannot be materially in the future", clockDriftSeconds, MAX_CLOCK_SKEW_SECONDS),
    check("QUOTE_FRESHNESS", quoteAge <= policy.maximumQuoteAgeSeconds, "Quote must be fresh", quoteAge, policy.maximumQuoteAgeSeconds),
    check("DATA_FRESHNESS", dataAge <= policy.maximumQuoteAgeSeconds, "Proposal data must be fresh", dataAge, policy.maximumQuoteAgeSeconds),
    check("ACCOUNT_FRESHNESS", accountAge <= policy.maximumAccountSnapshotAgeSeconds, "Account snapshot must be fresh", accountAge, policy.maximumAccountSnapshotAgeSeconds),
    check("PRICE_DEVIATION", priceDeviation <= policy.maximumPriceDeviationRatio, "Expected price deviation must not exceed limit", priceDeviation, policy.maximumPriceDeviationRatio),
    check("SUPPORTED_ORDER_TYPE", proposal.orderType !== "market" || !isOption, "Options market orders are not permitted at initial release"),
    check("BROKER_WARNING", context.brokerWarningSeverity !== "blocking", "Broker review must not contain a blocking warning"),
    check("APPROVAL_CURRENT", !approvalExpired && Date.parse(proposal.expirationTimestamp) > now, "Proposal and approval must not be expired"),
    check("OPTION_PERMISSION", !isOption || riskReducingExit || context.optionsPermission === true, "Options permission is required for new option exposure"),
    check("OPTION_MAX_LOSS", !isOption || riskReducingExit || (proposal.maximumLoss !== undefined && proposal.maximumLoss <= policy.maximumOptionRiskPerTrade), "New option maximum loss must be known and within limit", proposal.maximumLoss, policy.maximumOptionRiskPerTrade),
    check("OPTION_EXPOSURE", !isOption || riskReducingExit || optionsExposureRatio <= policy.maximumOptionsExposure, "New total options exposure must remain within limit", optionsExposureRatio, policy.maximumOptionsExposure),
    check("OPTION_CONTRACTS", !isOption || contractCount <= policy.maximumContractsPerTrade, "Option contracts must remain within limit", contractCount, policy.maximumContractsPerTrade),
    check("OPTION_DTE", !isOption || riskReducingExit || (dte >= policy.minimumDaysToExpiration && dte <= policy.maximumDaysToExpiration), "New option exposure must use a permitted expiration", dte, `${policy.minimumDaysToExpiration}-${policy.maximumDaysToExpiration}`),
    check("OPTION_SPREAD", !isOption || spread <= policy.maximumBidAskSpreadRatio, "Option bid-ask spread must be within limit", spread, policy.maximumBidAskSpreadRatio),
    check("OPTION_COVERAGE", !isOption || riskReducingExit || context.optionCoverageVerified === true, "New option exposure requires verified collateral or share coverage")
  ];

  return Object.freeze({
    passed: checks.every((result) => result.passed || result.severity !== "blocking"),
    evaluatedAt: new Date(now).toISOString(),
    policyVersion: policy.version,
    proposalFingerprint: proposalFingerprint(proposal),
    checks: Object.freeze(checks)
  });
}
