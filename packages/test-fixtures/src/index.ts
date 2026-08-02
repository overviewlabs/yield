import type { Entitlements, RiskPolicy, TradeProposal } from "@whox/contracts";
export * from "./wire.js";

export const FIXTURE_NOW = "2026-08-01T14:00:00.000Z";
export const DEMO_USER_ID = "10000000-0000-4000-8000-000000000001";
export const DEMO_ACCOUNT_ID = "20000000-0000-4000-8000-000000000001";
export const FOUNDATION_AGENT_DEFINITION_ID = "30000000-0000-4000-8000-000000000001";

export const DEMO_EQUITY_ENTITLEMENTS: Entitlements = Object.freeze({
  stockTrading:true, optionsTrading:false, multiLegOptions:false, maximumActiveAgents:1, automaticMode:false,
  monitoringFrequencyMinutes:1440, advancedAnalytics:false, customWatchlists:false, scannerAccess:false,
  agentCatalog:["foundation-equity"], prioritySupport:false
});

export const DEMO_RISK_POLICY: RiskPolicy = Object.freeze({
  policyId:"40000000-0000-4000-8000-000000000001", userId:DEMO_USER_ID,
  maximumAccountAllocation:0.6, maximumPositionAmount:5_000, maximumNewOrderAmount:2_000, maximumDailyLoss:500,
  maximumPortfolioDrawdown:0.1, minimumBuyingPowerReserve:0.2, maximumSimultaneousPositions:10,
  maximumSymbolConcentration:0.15, maximumSectorConcentration:0.3, maximumTradesPerDay:5, maximumDailyTurnover:0.3,
  maximumOptionsExposure:0.1, maximumOptionRiskPerTrade:500, maximumContractsPerTrade:2,
  minimumDaysToExpiration:21, maximumDaysToExpiration:180, maximumBidAskSpreadRatio:0.08,
  maximumQuoteAgeSeconds:30, maximumAccountSnapshotAgeSeconds:60, maximumPriceDeviationRatio:0.02,
  excludedSymbols:[], excludedSectors:[], fractionalSharesPermitted:true, extendedHoursPermitted:false,
  earningsTradesPermitted:false, coveredCallsPermitted:false, protectivePutsPermitted:false,
  definedRiskSpreadsPermitted:false, updatedAt:FIXTURE_NOW, version:1
});

export const DEMO_EQUITY_PROPOSAL: TradeProposal = Object.freeze({
  proposalId:"50000000-0000-4000-8000-000000000001", userId:DEMO_USER_ID, accountId:DEMO_ACCOUNT_ID,
  agentDefinitionId:FOUNDATION_AGENT_DEFINITION_ID, agentVersion:"1.0.0", environment:"demo", instrumentType:"equity",
  symbol:"AAPL", optionLegs:[], side:"buy", quantity:5, notionalEstimate:1000, orderType:"limit", limitPrice:200,
  timeInForce:"day", strategyType:"foundation_equity", entryReason:"Demo diversification rule passed",
  exitPlan:"Rebalance or deterministic loss limit", invalidationCondition:"Instrument leaves the eligible universe",
  dataTimestamp:FIXTURE_NOW, quoteTimestamp:FIXTURE_NOW, maximumLoss:1000, breakevens:[],
  estimatedPortfolioAllocationAfter:0.2, riskAmount:1000, confidenceCategoryWithoutProbabilityClaims:"moderate",
  requiredApprovalMode:"confirm_every_trade", expirationTimestamp:"2026-08-01T14:05:00.000Z",
  evidenceReferences:[{kind:"strategy_rule" as const,source:"fixture",observedAt:FIXTURE_NOW,referenceId:"demo-rule-1"}],
  warnings:["Demo order only"], deterministicStrategyVersion:"foundation-equity-rules-1.0.0"
});
