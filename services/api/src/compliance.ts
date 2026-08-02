import { DomainError } from "@whox/contracts";

export const ELIGIBILITY_ASSESSMENT_VERSION = "eligibility-v1";
export const RISK_SCORING_VERSION = "investor-profile-v1";

export type EligibilityStatus = "eligible" | "ineligible" | "review_required";
export type AdviserClientClassification = "self_directed" | "adviser_client" | "needs_review";

export interface EligibilityReason {
  readonly code: string;
  readonly message: string;
}

export interface EligibilityRecord {
  readonly id: string;
  readonly userId: string;
  readonly country: string;
  readonly region: string;
  readonly ageEligible: boolean;
  readonly individualAccount: boolean;
  readonly understandsNotBankOrBroker: boolean;
  readonly adviserClientClassification: AdviserClientClassification;
  readonly status: EligibilityStatus;
  readonly eligible: boolean;
  readonly reasons: readonly EligibilityReason[];
  readonly assessmentVersion: string;
  readonly recordedAt: string;
}

export type InvestorRiskClassification = "conservative" | "moderate" | "growth" | "aggressive";
export type OptionsInvestorClassification = "options_restricted" | "options_eligible_pending_broker_permission";

export interface RiskAssessmentFactor {
  readonly questionId: string;
  readonly answer: string | number | boolean;
  readonly points: number;
  readonly reason: string;
}

export interface RiskAssessmentAnswers {
  readonly objective: "capital_preservation" | "income" | "long_term_growth" | "aggressive_growth";
  readonly holdingPeriod: "under_1_year" | "one_to_three_years" | "three_to_five_years" | "more_than_5_years";
  readonly tradingExperience: "none" | "limited" | "some_experience" | "extensive";
  readonly stockExperience: "none" | "limited" | "some_experience" | "extensive";
  readonly optionsExperience: "none" | "limited" | "some_experience" | "extensive";
  readonly maximumAcceptableDrawdownPercent: number;
  readonly dependsOnInvestedFunds: boolean;
  readonly liquidityNeed: "high" | "moderate" | "low";
  readonly volatilityComfort: "low" | "some" | "high";
  readonly confirmationPreference: "observe" | "confirm_every_trade" | "automatic_if_approved";
  readonly understandsOptionsPremiumLoss: boolean;
  readonly answersAcknowledged: true;
}

export interface RiskAssessmentRecord {
  readonly id: string;
  readonly userId: string;
  readonly classification: InvestorRiskClassification;
  readonly optionsClassification: OptionsInvestorClassification;
  readonly score: number;
  readonly factors: readonly RiskAssessmentFactor[];
  readonly rationale: readonly string[];
  readonly explanation: string;
  readonly answers: RiskAssessmentAnswers;
  readonly scoringVersion: string;
  readonly status: "current";
  readonly recordedAt: string;
}

export interface LegalDocumentDefinition {
  readonly key: string;
  readonly version: string;
  readonly required: boolean;
  readonly productionApproved: false;
}

export const LEGAL_DOCUMENTS: readonly LegalDocumentDefinition[] = Object.freeze([
  { key: "terms", version: "DEMO-2026.08", required: true, productionApproved: false },
  { key: "privacy", version: "DEMO-2026.08", required: true, productionApproved: false },
  { key: "ai-risk", version: "DEMO-2026.08", required: true, productionApproved: false },
  { key: "broker", version: "DEMO-2026.08", required: true, productionApproved: false },
  { key: "options", version: "DEMO-2026.08", required: false, productionApproved: false },
  { key: "subscription", version: "DEMO-2026.08", required: true, productionApproved: false },
  { key: "advisory", version: "DEMO-2026.08", required: false, productionApproved: false },
  { key: "electronic", version: "DEMO-2026.08", required: true, productionApproved: false },
  { key: "performance", version: "DEMO-2026.08", required: true, productionApproved: false },
  { key: "ai-data", version: "DEMO-2026.08", required: true, productionApproved: false }
]);

export interface LegalConsentRecord {
  readonly id: string;
  readonly userId: string;
  readonly documentKey: string;
  readonly documentVersion: string;
  readonly acceptedAt: string;
  readonly sessionId: string;
  readonly deviceId: string;
}

const supportedUnitedStatesNames = new Set(["united states", "united states of america", "u.s.", "u.s.a.", "us", "usa"]);
const knownCountryCodes:Readonly<Record<string,string>>=Object.freeze({canada:"CA",mexico:"MX","united kingdom":"GB",australia:"AU",france:"FR",germany:"DE",italy:"IT",spain:"ES",japan:"JP",india:"IN"});
const unitedStatesRegions: Readonly<Record<string, string>> = Object.freeze({
  al:"AL",alabama:"AL",ak:"AK",alaska:"AK",az:"AZ",arizona:"AZ",ar:"AR",arkansas:"AR",ca:"CA",california:"CA",co:"CO",colorado:"CO",ct:"CT",connecticut:"CT",de:"DE",delaware:"DE",fl:"FL",florida:"FL",ga:"GA",georgia:"GA",hi:"HI",hawaii:"HI",id:"ID",idaho:"ID",il:"IL",illinois:"IL",in:"IN",indiana:"IN",ia:"IA",iowa:"IA",ks:"KS",kansas:"KS",ky:"KY",kentucky:"KY",la:"LA",louisiana:"LA",me:"ME",maine:"ME",md:"MD",maryland:"MD",ma:"MA",massachusetts:"MA",mi:"MI",michigan:"MI",mn:"MN",minnesota:"MN",ms:"MS",mississippi:"MS",mo:"MO",missouri:"MO",mt:"MT",montana:"MT",ne:"NE",nebraska:"NE",nv:"NV",nevada:"NV",nh:"NH","new hampshire":"NH",nj:"NJ","new jersey":"NJ",nm:"NM","new mexico":"NM",ny:"NY","new york":"NY",nc:"NC","north carolina":"NC",nd:"ND","north dakota":"ND",oh:"OH",ohio:"OH",ok:"OK",oklahoma:"OK",or:"OR",oregon:"OR",pa:"PA",pennsylvania:"PA",ri:"RI","rhode island":"RI",sc:"SC","south carolina":"SC",sd:"SD","south dakota":"SD",tn:"TN",tennessee:"TN",tx:"TX",texas:"TX",ut:"UT",utah:"UT",vt:"VT",vermont:"VT",va:"VA",virginia:"VA",wa:"WA",washington:"WA",wv:"WV","west virginia":"WV",wi:"WI",wisconsin:"WI",wy:"WY",wyoming:"WY",dc:"DC","district of columbia":"DC"
});

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function requiredBoolean(input: Readonly<Record<string, unknown>>, keys: readonly string[], field: string, issues: string[]): boolean | undefined {
  for (const key of keys) {
    if (typeof input[key] === "boolean") return input[key];
  }
  issues.push(`${field} must be a boolean`);
  return undefined;
}

function ageEligibility(input: Readonly<Record<string, unknown>>, issues: string[]): boolean | undefined {
  const direct = requiredBooleanWithoutIssue(input, ["ageEligible"]);
  if (direct !== undefined) return direct;
  switch (input.minimumAgeStatus) {
    case "meetsRequirement": return true;
    case "doesNotMeetRequirement": return false;
    default: issues.push("ageEligible or minimumAgeStatus must confirm minimum-age eligibility"); return undefined;
  }
}

function individualAccount(input: Readonly<Record<string, unknown>>, issues: string[]): boolean | undefined {
  const direct = requiredBooleanWithoutIssue(input, ["individualAccount", "ownIndividualAccount"]);
  if (direct !== undefined) return direct;
  switch (input.individualAccountStatus) {
    case "actingForOwnAccount": return true;
    case "actingForAnotherParty": return false;
    default: issues.push("individualAccount or individualAccountStatus must identify the account capacity"); return undefined;
  }
}

function requiredBooleanWithoutIssue(input: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean | undefined {
  for (const key of keys) {
    if (typeof input[key] === "boolean") return input[key];
  }
  return undefined;
}

function adviserClassification(value: unknown, issues: string[]): AdviserClientClassification | undefined {
  switch (value) {
    case "selfDirected":
    case "self_directed": return "self_directed";
    case "adviserClient":
    case "adviser_client": return "adviser_client";
    case "needsReview":
    case "needs_review": return "needs_review";
    default: issues.push("adviserClientClassification must be selfDirected, adviserClient, or needsReview"); return undefined;
  }
}

export function assessEligibility(input: Readonly<Record<string, unknown>>, id: string, userId: string, recordedAt: string): EligibilityRecord {
  const issues: string[] = [];
  const countryInput = nonEmptyString(input.country ?? input.jurisdiction);
  const regionInput = nonEmptyString(input.region ?? input.state);
  if (countryInput === undefined) issues.push("country or jurisdiction is required");
  if (regionInput === undefined) issues.push("region or state is required");
  if (countryInput !== undefined && (countryInput.length > 100 || !/^[\p{L} .'-]+$/u.test(countryInput))) issues.push("country or jurisdiction is invalid");
  if (regionInput !== undefined && (regionInput.length > 100 || !/^[\p{L} .'-]+$/u.test(regionInput))) issues.push("region or state is invalid");
  const ageEligible = ageEligibility(input, issues);
  const ownAccount = individualAccount(input, issues);
  const understands = requiredBoolean(input, ["understandsNotBankOrBroker", "understandsNotBroker"], "understandsNotBankOrBroker", issues);
  const classification = adviserClassification(input.adviserClientClassification, issues);
  if (issues.length > 0 || countryInput === undefined || regionInput === undefined || ageEligible === undefined || ownAccount === undefined || understands === undefined || classification === undefined) {
    throw new DomainError("ELIGIBILITY_INPUT_INVALID", "Eligibility answers are incomplete or invalid", 422, { fields: issues });
  }

  const normalizedCountry = supportedUnitedStatesNames.has(countryInput.toLowerCase()) ? "US" : countryInput.length===2?countryInput.toUpperCase():knownCountryCodes[countryInput.toLowerCase()]??"ZZ";
  const normalizedRegion = normalizedCountry === "US" ? unitedStatesRegions[regionInput.toLowerCase()] : regionInput;
  if (normalizedRegion === undefined) throw new DomainError("ELIGIBILITY_REGION_INVALID", "State of residence is not a recognized United States state or the District of Columbia", 422, { field: "region" });
  const ineligibleReasons: EligibilityReason[] = [];
  const reviewReasons: EligibilityReason[] = [];
  if (!ageEligible) ineligibleReasons.push({ code: "MINIMUM_AGE_NOT_MET", message: "The minimum age requirement is not met." });
  if (!ownAccount) ineligibleReasons.push({ code: "INDIVIDUAL_ACCOUNT_REQUIRED", message: "This product supports only a person acting for their own individual account." });
  if (!understands) ineligibleReasons.push({ code: "ROLE_ACKNOWLEDGMENT_REQUIRED", message: "The user must acknowledge that Metis is not a bank or broker." });
  if (normalizedCountry !== "US") reviewReasons.push({ code: "JURISDICTION_REVIEW_REQUIRED", message: "Availability for this jurisdiction has not been approved and requires compliance review." });
  if (classification !== "self_directed") reviewReasons.push({ code: "ADVISER_CLASSIFICATION_REVIEW_REQUIRED", message: "The adviser-client classification requires compliance review before onboarding can continue." });
  const status: EligibilityStatus = ineligibleReasons.length > 0 ? "ineligible" : reviewReasons.length > 0 ? "review_required" : "eligible";
  const reasons = status === "ineligible" ? [...ineligibleReasons, ...reviewReasons] : reviewReasons;
  return Object.freeze({ id, userId, country: normalizedCountry, region: normalizedRegion, ageEligible, individualAccount: ownAccount, understandsNotBankOrBroker: understands, adviserClientClassification: classification, status, eligible: status === "eligible", reasons: Object.freeze(reasons), assessmentVersion: ELIGIBILITY_ASSESSMENT_VERSION, recordedAt });
}

const normalizedKey = (value: string): string => value.trim().toLowerCase().replace(/[–—]/g, "-").replace(/[\s-]+/g, "_");

function requiredChoice<T extends string>(input: Readonly<Record<string, unknown>>, key: string, aliases: Readonly<Record<string, T>>, issues: string[]): T | undefined {
  const raw = nonEmptyString(input[key]);
  if (raw === undefined) { issues.push(`${key} is required`); return undefined; }
  const value = aliases[normalizedKey(raw)];
  if (value === undefined) issues.push(`${key} is not an allowed answer`);
  return value;
}

const experienceAliases = Object.freeze({ none: "none", limited: "limited", some: "some_experience", some_experience: "some_experience", extensive: "extensive" } as const);
const objectiveAliases = Object.freeze({ capital_preservation: "capital_preservation", income: "income", long_term_growth: "long_term_growth", aggressive_growth: "aggressive_growth" } as const);
const holdingAliases = Object.freeze({ under_1_year: "under_1_year", "1_3_years": "one_to_three_years", one_to_three_years: "one_to_three_years", "3_5_years": "three_to_five_years", three_to_five_years: "three_to_five_years", more_than_5_years: "more_than_5_years" } as const);
const liquidityAliases = Object.freeze({ high: "high", moderate: "moderate", medium: "moderate", low: "low" } as const);
const volatilityAliases = Object.freeze({ low: "low", some: "some", moderate: "some", high: "high" } as const);
const confirmationAliases = Object.freeze({ observe: "observe", observe_only: "observe", confirm_every_trade: "confirm_every_trade", automatic_within_limits: "automatic_if_approved", automation_only_if_separately_approved: "automatic_if_approved", automatic_if_approved: "automatic_if_approved" } as const);

export function evaluateRiskAssessment(input: Readonly<Record<string, unknown>>, id: string, userId: string, recordedAt: string): RiskAssessmentRecord {
  const issues: string[] = [];
  const objective = requiredChoice(input, "objective", objectiveAliases, issues);
  const holdingPeriod = requiredChoice(input, "holdingPeriod", holdingAliases, issues);
  const tradingExperience = requiredChoice({ ...input, tradingExperience: input.tradingExperience ?? input.experience }, "tradingExperience", experienceAliases, issues);
  const stockExperience = requiredChoice(input, "stockExperience", experienceAliases, issues);
  const optionsExperience = requiredChoice(input, "optionsExperience", experienceAliases, issues);
  const liquidityNeed = requiredChoice(input, "liquidityNeed", liquidityAliases, issues);
  const volatilityComfort = requiredChoice(input, "volatilityComfort", volatilityAliases, issues);
  const confirmationPreference = requiredChoice(input, "confirmationPreference", confirmationAliases, issues);
  const maximumDrawdown = input.maximumAcceptableDrawdownPercent ?? input.lossTolerance;
  if (typeof maximumDrawdown !== "number" || !Number.isFinite(maximumDrawdown) || maximumDrawdown < 3 || maximumDrawdown > 30) issues.push("lossTolerance or maximumAcceptableDrawdownPercent must be between 3 and 30");
  const dependsOnFunds = requiredBoolean(input, ["dependsOnInvestedFunds", "dependsOnFunds"], "dependsOnInvestedFunds", issues);
  const understandsOptionsPremiumLoss = requiredBoolean(input, ["understandsOptionsPremiumLoss"], "understandsOptionsPremiumLoss", issues);
  if (input.investorProfileAcknowledged !== true && input.answersAcknowledged !== true) issues.push("investorProfileAcknowledged must be true after the answers are reviewed");
  if (issues.length > 0 || objective === undefined || holdingPeriod === undefined || tradingExperience === undefined || stockExperience === undefined || optionsExperience === undefined || liquidityNeed === undefined || volatilityComfort === undefined || confirmationPreference === undefined || typeof maximumDrawdown !== "number" || dependsOnFunds === undefined || understandsOptionsPremiumLoss === undefined) {
    throw new DomainError("RISK_ASSESSMENT_INPUT_INVALID", "Risk-assessment answers are incomplete or invalid", 422, { fields: issues });
  }

  const factors: RiskAssessmentFactor[] = [];
  const add = (questionId: string, answer: string | number | boolean, points: number, reason: string): void => { factors.push(Object.freeze({ questionId, answer, points, reason })); };
  const objectivePoints = { capital_preservation: -3, income: -1, long_term_growth: 1, aggressive_growth: 3 }[objective];
  add("objective", objective, objectivePoints, "Investment objective contributes directly to the internal risk score.");
  const holdingPoints = { under_1_year: -3, one_to_three_years: -1, three_to_five_years: 1, more_than_5_years: 2 }[holdingPeriod];
  add("holdingPeriod", holdingPeriod, holdingPoints, "Longer intended horizons can support greater tolerance for short-term variation.");
  const experiencePoints = { none: -2, limited: -1, some_experience: 1, extensive: 2 } as const;
  add("tradingExperience", tradingExperience, experiencePoints[tradingExperience], "Overall trading experience affects the classification.");
  add("stockExperience", stockExperience, experiencePoints[stockExperience], "Stock experience affects the classification independently of options access.");
  add("optionsExperience", optionsExperience, 0, "Options experience affects only the separate options restriction and never grants broker permission.");
  const drawdownPoints = maximumDrawdown <= 7 ? -3 : maximumDrawdown <= 12 ? -1 : maximumDrawdown >= 25 ? 3 : maximumDrawdown >= 18 ? 2 : 1;
  add("maximumAcceptableDrawdownPercent", maximumDrawdown, drawdownPoints, "The stated maximum acceptable drawdown is scored within the allowed 3% to 30% range.");
  add("dependsOnInvestedFunds", dependsOnFunds, dependsOnFunds ? -4 : 0, dependsOnFunds ? "Dependence on invested funds for near-term expenses lowers the classification." : "No near-term dependence adjustment was applied.");
  const liquidityPoints = { high: -3, moderate: -1, low: 1 }[liquidityNeed];
  add("liquidityNeed", liquidityNeed, liquidityPoints, "Greater liquidity needs lower the internal risk score.");
  const volatilityPoints = { low: -2, some: 0, high: 2 }[volatilityComfort];
  add("volatilityComfort", volatilityComfort, volatilityPoints, "Comfort with short-term volatility affects the internal risk score.");
  add("confirmationPreference", confirmationPreference, 0, "Approval preference does not increase financial risk capacity and therefore adds no score.");
  add("understandsOptionsPremiumLoss", understandsOptionsPremiumLoss, 0, "Premium-loss understanding affects only the separate options restriction.");
  const score = factors.reduce((total, factor) => total + factor.points, 0);
  const classification: InvestorRiskClassification = score <= -3 ? "conservative" : score <= 3 ? "moderate" : score <= 8 ? "growth" : "aggressive";
  const optionsEligible = optionsExperience !== "none" && understandsOptionsPremiumLoss && !dependsOnFunds && liquidityNeed !== "high";
  const optionsClassification: OptionsInvestorClassification = optionsEligible ? "options_eligible_pending_broker_permission" : "options_restricted";
  const rationale = factors.filter((factor) => factor.points !== 0).map((factor) => factor.reason);
  rationale.push(optionsEligible ? "Options knowledge and experience are recorded, but separate broker permission is still required." : "Options remain restricted because experience, premium-loss understanding, liquidity, or near-term-funds answers do not meet the internal threshold.");
  const answers: RiskAssessmentAnswers = Object.freeze({ objective, holdingPeriod, tradingExperience, stockExperience, optionsExperience, maximumAcceptableDrawdownPercent: maximumDrawdown, dependsOnInvestedFunds: dependsOnFunds, liquidityNeed, volatilityComfort, confirmationPreference, understandsOptionsPremiumLoss, answersAcknowledged: true });
  return Object.freeze({ id, userId, classification, optionsClassification, score, factors: Object.freeze(factors), rationale: Object.freeze(rationale), explanation: `Internal ${classification} classification from score ${score}; this is not brokerage options approval.`, answers, scoringVersion: RISK_SCORING_VERSION, status: "current", recordedAt });
}

export function validateLegalConsentVersions(input: Readonly<Record<string, unknown>>): Readonly<Record<string, string>> {
  if (input.accepted !== true) throw new DomainError("LEGAL_CONSENT_NOT_ACCEPTED", "Explicit acceptance is required", 422);
  const value = input.documentVersions;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new DomainError("LEGAL_CONSENT_INPUT_INVALID", "documentVersions must be an object", 422);
  const versions = value as Readonly<Record<string, unknown>>;
  const entries = Object.entries(versions);
  if (entries.length === 0) throw new DomainError("LEGAL_CONSENT_INPUT_INVALID", "At least one document version must be accepted", 422);
  const current = new Map(LEGAL_DOCUMENTS.map((document) => [document.key, document]));
  const unknown = entries.filter(([key]) => !current.has(key)).map(([key]) => key);
  if (unknown.length > 0) throw new DomainError("LEGAL_DOCUMENT_UNKNOWN", "One or more legal documents are not recognized", 422, { documentKeys: unknown });
  const stale = entries.filter(([key, version]) => typeof version !== "string" || version !== current.get(key)!.version).map(([key]) => key);
  if (stale.length > 0) throw new DomainError("LEGAL_DOCUMENT_VERSION_STALE", "One or more legal-document versions are not current", 409, { documentKeys: stale, currentVersions: Object.fromEntries(stale.map((key) => [key, current.get(key)!.version])) });
  return Object.freeze(Object.fromEntries(entries.map(([key, version]) => [key, String(version)])));
}
