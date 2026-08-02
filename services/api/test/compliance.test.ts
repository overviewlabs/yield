import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { LEGAL_DOCUMENTS } from "../src/compliance.js";
import { createApiServer } from "../src/server.js";
import { MemoryDataStore } from "../src/store.js";

const recordedAt = "2026-08-01T14:00:00.000Z";
const eligibleAnswers = Object.freeze({
  country: "United States",
  state: "New York",
  minimumAgeStatus: "meetsRequirement",
  individualAccountStatus: "actingForOwnAccount",
  understandsNotBroker: true,
  adviserClientClassification: "selfDirected"
});
const growthAnswers = Object.freeze({
  objective: "Aggressive growth",
  holdingPeriod: "More than 5 years",
  experience: "Extensive",
  stockExperience: "Extensive",
  optionsExperience: "Extensive",
  lossTolerance: 30,
  dependsOnFunds: false,
  liquidityNeed: "Low",
  volatilityComfort: "High",
  confirmationPreference: "Automation only if separately approved",
  understandsOptionsPremiumLoss: true,
  investorProfileAcknowledged: true
});

describe("eligibility persistence and onboarding gates",()=>{
  it("validates every required answer and blocks progression until eligibility is approved",()=>{const store=new MemoryDataStore();const account=store.userForAppleSubject("eligibility-test-subject");assert.throws(()=>store.recordEligibility(account.userId,{country:"US"},recordedAt),(error:unknown)=>(error as {code?:string}).code==="ELIGIBILITY_INPUT_INVALID");assert.throws(()=>store.recordEligibility(account.userId,{...eligibleAnswers,state:"not-a-state"},recordedAt),(error:unknown)=>(error as {code?:string}).code==="ELIGIBILITY_REGION_INVALID");assert.throws(()=>store.updateOnboarding(account.userId,4),(error:unknown)=>(error as {code?:string}).code==="ELIGIBILITY_REQUIRED");const review=store.recordEligibility(account.userId,{...eligibleAnswers,country:"Canada",state:"Ontario",adviserClientClassification:"needsReview"},recordedAt);assert.equal(review.status,"review_required");assert.ok(review.reasons.some((reason)=>reason.code==="JURISDICTION_REVIEW_REQUIRED"));assert.ok(review.reasons.some((reason)=>reason.code==="ADVISER_CLASSIFICATION_REVIEW_REQUIRED"));assert.throws(()=>store.updateOnboarding(account.userId,4),(error:unknown)=>(error as {code?:string}).code==="ELIGIBILITY_NOT_APPROVED");const ineligible=store.recordEligibility(account.userId,{...eligibleAnswers,minimumAgeStatus:"doesNotMeetRequirement"},recordedAt);assert.equal(ineligible.status,"ineligible");assert.ok(ineligible.reasons.some((reason)=>reason.code==="MINIMUM_AGE_NOT_MET"));const eligible=store.recordEligibility(account.userId,eligibleAnswers,recordedAt);assert.equal(eligible.region,"NY");assert.equal(eligible.status,"eligible");assert.equal(eligible.eligible,true);assert.equal(store.eligibility(account.userId)?.id,eligible.id);assert.equal(store.updateOnboarding(account.userId,4).currentStep,4);});
});

describe("deterministic investor assessment",()=>{
  it("rejects incomplete answers, explains every scored factor, and returns the persisted current result",()=>{const store=new MemoryDataStore();const account=store.userForAppleSubject("risk-test-subject");store.recordEligibility(account.userId,eligibleAnswers,recordedAt);assert.throws(()=>store.createRiskAssessment(account.userId,{objective:"Aggressive growth"},recordedAt),(error:unknown)=>(error as {code?:string}).code==="RISK_ASSESSMENT_INPUT_INVALID");const assessment=store.createRiskAssessment(account.userId,growthAnswers,recordedAt);assert.equal(assessment.classification,"aggressive");assert.equal(assessment.optionsClassification,"options_eligible_pending_broker_permission");assert.equal(assessment.score,15);assert.ok(assessment.factors.length>=9);assert.equal(assessment.factors.reduce((sum,factor)=>sum+factor.points,0),assessment.score);assert.match(assessment.explanation,/not brokerage options approval/i);assert.equal(store.currentRiskAssessment(account.userId).id,assessment.id);});
});

describe("versioned legal consent persistence",()=>{
  it("requires explicit acceptance, rejects stale versions, and tracks completion only for every current required document",()=>{const store=new MemoryDataStore();const account=store.userForAppleSubject("consent-test-subject");store.recordEligibility(account.userId,eligibleAnswers,recordedAt);store.createRiskAssessment(account.userId,growthAnswers,recordedAt);assert.throws(()=>store.updateOnboarding(account.userId,14),(error:unknown)=>(error as {code?:string}).code==="LEGAL_CONSENTS_REQUIRED");assert.throws(()=>store.recordLegalConsents(account.userId,{accepted:false,documentVersions:{terms:"DEMO-2026.08"}},"session-1","device-1",recordedAt),(error:unknown)=>(error as {code?:string}).code==="LEGAL_CONSENT_NOT_ACCEPTED");assert.throws(()=>store.recordLegalConsents(account.userId,{accepted:true,documentVersions:{terms:"old-version"}},"session-1","device-1",recordedAt),(error:unknown)=>(error as {code?:string}).code==="LEGAL_DOCUMENT_VERSION_STALE");const partial=store.recordLegalConsents(account.userId,{accepted:true,documentVersions:{terms:"DEMO-2026.08"}},"session-1","device-1",recordedAt);assert.equal(partial.allRequiredCurrentDocumentsAccepted,false);assert.equal(store.legalConsents(account.userId).length,1);const documentVersions=Object.fromEntries(LEGAL_DOCUMENTS.map((document)=>[document.key,document.version]));const complete=store.recordLegalConsents(account.userId,{accepted:true,documentVersions},"session-1","device-1",recordedAt);assert.equal(complete.allRequiredCurrentDocumentsAccepted,true);assert.equal(store.legalConsents(account.userId).length,LEGAL_DOCUMENTS.length);assert.equal(store.updateOnboarding(account.userId,14).completed,true);});
});

describe("HTTP compliance contract",()=>{
  it("routes eligibility, risk scoring, current retrieval, and versioned consent through the store",async()=>{const store=new MemoryDataStore();const server=createApiServer({mode:"demo",dataStore:store,authSigningKey:Buffer.alloc(32,21),pairingHashPepper:Buffer.alloc(32,22),now:()=>new Date(recordedAt)});server.listen(0,"127.0.0.1");await once(server,"listening");try{const base=`http://127.0.0.1:${(server.address()as AddressInfo).port}`;const login=await fetch(`${base}/v1/auth/apple`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({identityToken:"demo-apple-identity-token",deviceId:"compliance-device"})});const auth=await login.json()as{accessToken:string};const headers={authorization:`Bearer ${auth.accessToken}`};const post=async(path:string,key:string,body:unknown):Promise<Response>=>await fetch(`${base}${path}`,{method:"POST",headers:{...headers,"content-type":"application/json","idempotency-key":key},body:JSON.stringify(body)});const eligibility=await post("/v1/eligibility","http-eligibility",eligibleAnswers);assert.equal(eligibility.status,200);assert.equal(((await eligibility.json())as{status:string}).status,"eligible");const risk=await post("/v1/risk-assessments","http-risk-assessment",growthAnswers);assert.equal(risk.status,200);const created=await risk.json()as{id:string;classification:string;score:number};assert.equal(created.classification,"aggressive");assert.equal(created.score,15);const current=await fetch(`${base}/v1/risk-assessments/current`,{headers});assert.equal(current.status,200);assert.equal(((await current.json())as{id:string}).id,created.id);const documents=await fetch(`${base}/v1/legal-documents`,{headers});assert.equal(documents.status,200);const documentBody=await documents.json()as{data:readonly{productionApproved:boolean}[]};assert.equal(documentBody.data.length>0,true);assert.equal(documentBody.data.every((document)=>document.productionApproved===false),true);const consent=await post("/v1/legal-consents","http-legal-consent",{accepted:true,documentVersions:{terms:"DEMO-2026.08"}});assert.equal(consent.status,200);assert.equal(((await consent.json())as{accepted:boolean}).accepted,true);}finally{await new Promise<void>((resolve)=>server.close(()=>resolve()));}});
});
