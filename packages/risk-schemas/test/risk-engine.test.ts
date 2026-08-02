import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Entitlements, RiskPolicy, TradeProposal } from "@whox/contracts";
import { evaluateRisk, PLATFORM_RISK_LIMITS, proposalFingerprint, type RiskContext } from "../src/index.js";

const now = "2026-08-01T14:00:00.000Z";
const proposal: TradeProposal = {
  proposalId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002",
  accountId: "00000000-0000-4000-8000-000000000003", agentDefinitionId: "00000000-0000-4000-8000-000000000004",
  agentVersion: "1.0.0", environment: "paper", instrumentType: "equity", symbol: "AAPL", optionLegs: [], side: "buy",
  quantity: 10, notionalEstimate: 1_000, orderType: "limit", limitPrice: 100, timeInForce: "day",
  strategyType: "foundation_equity", entryReason: "Fixture", exitPlan: "Rule exit", invalidationCondition: "Rule invalidated",
  dataTimestamp: now, quoteTimestamp: now, maximumLoss: 1_000, breakevens: [], estimatedPortfolioAllocationAfter: 0.2,
  riskAmount: 1_000, confidenceCategoryWithoutProbabilityClaims: "moderate", requiredApprovalMode: "confirm_every_trade",
  expirationTimestamp: "2026-08-01T14:05:00.000Z", evidenceReferences: [], warnings: [], deterministicStrategyVersion: "1.0.0"
};
const entitlements: Entitlements = {
  stockTrading: true, optionsTrading: false, multiLegOptions: false, maximumActiveAgents: 1, automaticMode: false,
  monitoringFrequencyMinutes: 1440, advancedAnalytics: false, customWatchlists: false, scannerAccess: false,
  agentCatalog: ["foundation-equity"], prioritySupport: false
};
const policy: RiskPolicy = {
  ...PLATFORM_RISK_LIMITS, maximumPositionAmount: 20_000, maximumNewOrderAmount: 5_000, maximumDailyLoss: 1_000,
  policyId: "00000000-0000-4000-8000-000000000010", userId: proposal.userId, excludedSymbols: [], excludedSectors: [],
  fractionalSharesPermitted: true, extendedHoursPermitted: false, earningsTradesPermitted: false,
  coveredCallsPermitted: false, protectivePutsPermitted: false, definedRiskSpreadsPermitted: false,
  updatedAt: now, version: 1
};
const context: RiskContext = {
  now, releaseGates: {LIVE_TRADING_ENABLED:false,ROBINHOOD_PRODUCTION_APPROVED:false,LEGAL_DOCUMENTS_APPROVED:false,
    ADVISORY_COMPLIANCE_APPROVED:false,APP_STORE_FINANCIAL_ENTITY_APPROVED:false,OPTIONS_LIVE_TRADING_ENABLED:false,AUTONOMOUS_MODE_ENABLED:false},
  userStatus: "active", currentLegalConsents: true, entitlements, accountConnectionHealthy: true,
  verifiedAgenticAccountId: proposal.accountId, strategyEnabled: true, agentVersionEnabled: true, tradingPermission: true,
  marketSession: "open", criticalServicesHealthy: true, securityHalt: false, accountValue: 10_000, buyingPower: 5_000,
  reservedBuyingPower: 0, currentAllocatedValue: 1_000, currentPositionValue: 0, currentSectorValue: 0,
  openPositionCount: 1, dailyLoss: 0, drawdownRatio: 0, agentAllocatedValue: 0, agentAllocationLimit: 5_000,
  otherAgentReservations: 0, duplicateProposal: false, duplicateOpenOrder: false, symbolSector: "Technology",
  tradable: true, fractionalSupported: true, liquiditySufficient: true, volatilityHalt: false, tradingHalt: false,
  corporateActionRestricted: false, earningsWindow: false, cooldownActive: false, tradesToday: 0, turnoverToday: 0,
  accountSnapshotTimestamp: now, quotePrice: 100, expectedExecutionPrice: 100, brokerWarningSeverity: "none"
};

describe("deterministic risk engine", () => {
  it("passes a permitted paper equity proposal", () => assert.equal(evaluateRisk(proposal, policy, context).passed, true));
  it("is deterministic and fingerprints property-order independently", () => {
    const reordered = Object.fromEntries(Object.entries(proposal).reverse()) as unknown as TradeProposal;
    assert.equal(proposalFingerprint(proposal), proposalFingerprint(reordered));
  });
  it("rejects stale quotes", () => {
    const result = evaluateRisk({...proposal, quoteTimestamp:"2026-08-01T13:00:00.000Z"}, policy, context);
    assert.equal(result.passed, false);
    assert.equal(result.checks.find((item) => item.code === "QUOTE_FRESHNESS")?.passed, false);
  });
  it("rejects the wrong brokerage account", () => {
    const result = evaluateRisk({...proposal, accountId:"00000000-0000-4000-8000-000000000099"}, policy, context);
    assert.equal(result.checks.find((item) => item.code === "AGENTIC_ACCOUNT_BINDING")?.passed, false);
  });
  it("fails live orders closed while release flags are locked", () => {
    const result = evaluateRisk({...proposal, environment:"live"}, policy, context);
    assert.equal(result.checks.find((item) => item.code === "LIVE_RELEASE_GATES")?.passed, false);
  });
  it("rejects platform-limit loosening", () => {
    const result = evaluateRisk(proposal, {...policy, maximumNewOrderAmount:100_000}, context);
    assert.equal(result.checks.find((item) => item.code === "POLICY_WITHIN_PLATFORM_CAPS")?.passed, false);
  });
  it("rejects a policy belonging to another user", () => {
    const result = evaluateRisk(proposal, {...policy, userId:"00000000-0000-4000-8000-000000000099"}, context);
    assert.equal(result.passed, false);
    assert.equal(result.checks.find((item)=>item.code==="POLICY_USER_BINDING")?.passed, false);
  });
  it("allows a fresh server-verified, user-approved protective equity exit through entry halts", () => {
    const exit={...proposal,side:"sell" as const,quantity:10,notionalEstimate:1_000};
    const result=evaluateRisk(exit,{...policy,excludedSymbols:["AAPL"]},{...context,currentHeldQuantity:10,currentPositionValue:4_000,currentAllocatedValue:9_000,currentSectorValue:9_000,agentAllocatedValue:8_000,dailyLoss:policy.maximumDailyLoss,drawdownRatio:policy.maximumPortfolioDrawdown,securityHalt:true,strategyEnabled:false,entitlements:{...entitlements,stockTrading:false},riskReducingExit:{verifiedBy:"position-service",accountId:proposal.accountId,symbol:"AAPL",instrumentType:"equity",maximumClosableQuantity:10,verifiedAt:now,userApprovalId:"approval-verified-1"}});
    assert.equal(result.passed,true,result.checks.filter((item)=>!item.passed).map((item)=>item.code).join(","));
  });
  it("rejects an equity protective exit above the verified position", () => {
    const result=evaluateRisk({...proposal,side:"sell",quantity:11},{...policy},{...context,currentHeldQuantity:10,riskReducingExit:{verifiedBy:"position-service",accountId:proposal.accountId,symbol:"AAPL",instrumentType:"equity",maximumClosableQuantity:10,verifiedAt:now,userApprovalId:"approval-verified-2"}});
    assert.equal(result.checks.find((item)=>item.code==="RISK_REDUCING_EXIT_SCOPE")?.passed,false);
    assert.equal(result.checks.find((item)=>item.code==="EQUITY_LONG_ONLY")?.passed,false);
  });
  it("preserves a verified option close after entitlement loss but rejects over-close", () => {
    const option:TradeProposal={...proposal,instrumentType:"option",side:"sell",quantity:1,notionalEstimate:200,riskAmount:200,maximumLoss:200,optionLegs:[{underlyingSymbol:"AAPL",side:"sell",positionEffect:"close",optionType:"put",strikePrice:190,expirationDate:"2026-09-18",ratioQuantity:1}]};
    const exitContext:RiskContext={...context,entitlements:{...entitlements,optionsTrading:false},securityHalt:true,dailyLoss:policy.maximumDailyLoss,drawdownRatio:policy.maximumPortfolioDrawdown,optionBidAskSpreadRatio:0.02,optionDaysToExpiration:48,optionsPermission:false,optionCoverageVerified:false,openOptionsExposure:500,riskReducingExit:{verifiedBy:"position-service",accountId:proposal.accountId,symbol:"AAPL",instrumentType:"option",maximumClosableQuantity:1,verifiedAt:now,userApprovalId:"approval-option-1"}};
    assert.equal(evaluateRisk(option,policy,exitContext).passed,true);
    const over=evaluateRisk({...option,quantity:2},policy,exitContext);
    assert.equal(over.checks.find((item)=>item.code==="RISK_REDUCING_EXIT_SCOPE")?.passed,false);
  });
  it("rejects materially future quote and account timestamps", () => {
    const future="2026-08-01T14:01:00.000Z";
    const result=evaluateRisk({...proposal,quoteTimestamp:future},policy,{...context,accountSnapshotTimestamp:future});
    assert.equal(result.checks.find((item)=>item.code==="CLOCK_DRIFT")?.passed,false);
  });
});
