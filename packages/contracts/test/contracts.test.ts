import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import {
  LOCKED_RELEASE_GATES,
  liveTradingGatesSatisfied,
  loadReleaseGates,
  validateTradeProposal
} from "../src/index.js";

const proposal = {
  proposalId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  accountId: "00000000-0000-4000-8000-000000000003",
  agentDefinitionId: "00000000-0000-4000-8000-000000000004",
  agentVersion: "1.0.0",
  environment: "paper",
  instrumentType: "equity",
  symbol: "aapl",
  optionLegs: [],
  side: "buy",
  quantity: 1,
  notionalEstimate: 100,
  orderType: "limit",
  limitPrice: 100,
  timeInForce: "day",
  strategyType: "foundation_equity",
  entryReason: "Deterministic fixture",
  exitPlan: "Exit on invalidation",
  invalidationCondition: "Rule no longer passes",
  dataTimestamp: "2026-08-01T14:00:00.000Z",
  quoteTimestamp: "2026-08-01T14:00:00.000Z",
  maximumLoss: 100,
  breakevens: [],
  estimatedPortfolioAllocationAfter: 0.1,
  riskAmount: 100,
  confidenceCategoryWithoutProbabilityClaims: "moderate",
  requiredApprovalMode: "confirm_every_trade",
  expirationTimestamp: "2026-08-01T14:05:00.000Z",
  evidenceReferences: [],
  warnings: [],
  deterministicStrategyVersion: "1.0.0"
} as const;

describe("contracts", () => {
  it("normalizes and validates proposals", () => {
    assert.equal(validateTradeProposal(proposal).symbol, "AAPL");
  });

  it("rejects option proposals without legs", () => {
    assert.throws(() => validateTradeProposal({ ...proposal, instrumentType: "option" }), /at least one leg/);
  });

  it("defaults every release gate to false", () => {
    assert.deepEqual(loadReleaseGates({}), LOCKED_RELEASE_GATES);
    assert.equal(liveTradingGatesSatisfied(LOCKED_RELEASE_GATES, "equity", "confirm_every_trade"), false);
  });

  it("requires the options and autonomous gates when applicable", () => {
    const baseline = {
      LIVE_TRADING_ENABLED: true,
      ROBINHOOD_PRODUCTION_APPROVED: true,
      LEGAL_DOCUMENTS_APPROVED: true,
      ADVISORY_COMPLIANCE_APPROVED: true,
      APP_STORE_FINANCIAL_ENTITY_APPROVED: true,
      OPTIONS_LIVE_TRADING_ENABLED: false,
      AUTONOMOUS_MODE_ENABLED: false
    } as const;
    assert.equal(liveTradingGatesSatisfied(baseline, "equity", "confirm_every_trade"), true);
    assert.equal(liveTradingGatesSatisfied(baseline, "option", "confirm_every_trade"), false);
    assert.equal(liveTradingGatesSatisfied(baseline, "equity", "automatic_within_limits"), false);
  });
  it("publishes OpenAPI 3.1 coverage for every required API surface",async()=>{const document=JSON.parse(await readFile(new URL("../openapi.json",import.meta.url),"utf8")) as {openapi:string;paths:Record<string,Record<string,{operationId?:string}>>;components:{schemas:Record<string,unknown>}};assert.match(document.openapi,/^3\.1\./);assert.equal(Object.keys(document.paths).length,66);for(const path of ["/v1/auth/apple","/v1/legal-documents","/v1/subscription/sync","/v1/storekit/notifications/sandbox","/v1/storekit/notifications/production","/v1/brokers/robinhood/pairings","/v1/brokers/robinhood/oauth/start","/v1/brokers/robinhood/mobile-oauth/start","/v1/brokers/robinhood/desktop-link/email","/v1/brokers/robinhood/mobile-oauth/abort","/v1/brokers/robinhood/mobile-oauth/callback","/v1/dashboard","/v1/risk-policy/preview","/v1/risk/pause-all","/v1/proposals/{id}/approve","/v1/orders/{id}/cancel","/v1/account"])assert.ok(document.paths[path],`missing ${path}`);for(const [path,operations] of Object.entries(document.paths))for(const [method,operation] of Object.entries(operations))assert.ok(operation.operationId,`${method.toUpperCase()} ${path} is missing operationId`);for(const schema of ["ApiError","AuthSession","Pairing","MobileBrokerAuthorizationStart","MobileBrokerAuthorizationAbort","BrokerDisconnectResponse","BrokerReconnectResponse","AccountDeletionResponse","StoreKitSyncRequest","StoreKitSyncResponse","LegalDocument","RiskPolicy","RiskPolicyUpdatePreview","Entitlements","PlanAgentAssignment","SubscriptionPlanCatalog","PlanListResponse","Order","OrderFill","OrderTimelineEvent"])assert.ok(document.components.schemas[schema],`missing schema ${schema}`);});
  it("publishes each plan assignment's closed research universe",async()=>{const document=JSON.parse(await readFile(new URL("../openapi.json",import.meta.url),"utf8")) as {components:{schemas:{PlanAgentAssignment:{required:string[];properties:{researchUniverse:{type:string;readOnly:boolean;minItems:number;maxItems:number;uniqueItems:boolean;items:{pattern:string}}}}}}};const schema=document.components.schemas.PlanAgentAssignment;assert.equal(schema.required.includes("researchUniverse"),true);assert.deepEqual(schema.properties.researchUniverse,{type:"array",description:"Closed, canonical-lexically-sorted available-symbol set published centrally and immutably with this exact plan catalog assignment. Only symbols in this set may be configured.",readOnly:true,minItems:1,maxItems:50,uniqueItems:true,items:{type:"string",pattern:"^[A-Z][A-Z0-9.-]{0,14}$"}});});
});
