import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { PairingService } from "../src/pairings.js";
import { parsePlanAgentAssignments } from "../src/postgres-store.js";
import { prepareRiskPolicyUpdate } from "../src/risk-policy-step-up.js";
import { SessionManager } from "../src/security.js";
import { createApiServer } from "../src/server.js";
import { MemoryDataStore, demoDashboard } from "../src/store.js";
import { UnavailableStepUpAuthenticationVerifier, type StepUpAuthenticationVerifier, type StepUpVerificationContext, type VerifiedStepUpAuthentication } from "../src/step-up.js";

const now="2026-08-01T14:00:00.000Z";const connection={status:"connected" as const,capabilities:["demo"],equityTradingAvailable:false,optionsTradingAvailable:false};

describe("desktop pairing security",()=>{
  it("emits the web-consumed one-time code URL and validates OAuth state byte-for-byte",()=>{const service=new PairingService(new URL("https://connect.whox.ai"),Buffer.alloc(32,9));const created=service.create("user-1","ios-session",now);const setup=new URL(created.setupUrl);assert.equal(setup.searchParams.get("pairing_code"),created.code);assert.equal(setup.searchParams.has("pairingId"),false);service.claim("user-1","desktop-session",created.code,"attempt-1",now);const state=service.beginAuthorization("user-1","desktop-session",created.pairingId,now);assert.throws(()=>service.completeForSession("user-1","desktop-session",created.pairingId,`${state}-`,connection,"2026-08-01T14:01:00.000Z"),/invalid or expired/);service.completeForSession("user-1","desktop-session",created.pairingId,state,connection,"2026-08-01T14:01:00.000Z");assert.throws(()=>service.completeForSession("user-1","desktop-session",created.pairingId,state,connection,"2026-08-01T14:01:01.000Z"),/invalid or expired/);});
  it("prevents cross-user claim and pairing-code replay",()=>{const service=new PairingService(new URL("https://connect.whox.ai"),Buffer.alloc(32,8));const created=service.create("user-1","ios-session",now);assert.throws(()=>service.claim("user-2","desktop-session",created.code,"attempt-cross",now),/invalid or expired/);service.claim("user-1","desktop-session",created.code,"attempt-owner",now);assert.throws(()=>service.claim("user-1","other-session",created.code,"attempt-replay",now),/cannot be reused/);});
});

describe("ephemeral-state safety",()=>{
  it("refuses ephemeral stores outside Demo",()=>{assert.throws(()=>createApiServer({mode:"paper",authSigningKey:Buffer.alloc(32,1),pairingHashPepper:Buffer.alloc(32,2)}),/refuse ephemeral/);});
  it("never relabels Demo fixture balances as Paper",()=>{const store=new MemoryDataStore();const user=store.userForAppleSubject("new-subject");assert.equal(user.accountMode,"demo");assert.throws(()=>store.patchUser(user.userId,{accountMode:"paper"}),/cannot represent Paper/);assert.equal(demoDashboard(store,user.userId).mode,"demo");});
  it("publishes and enforces the exact plan-assignment research universe",()=>{const store=new MemoryDataStore();const assignment=store.plans().find((plan)=>plan.id==="equity")?.agents[0];const otherAssignment=store.plans().find((plan)=>plan.id==="equity_pro")?.agents[0];assert.deepEqual(assignment?.researchUniverse,["AAPL","MSFT","VTI"]);assert.equal(Object.isFrozen(assignment?.researchUniverse),true);assert.notEqual(assignment?.researchUniverse,otherAssignment?.researchUniverse,"each assignment owns a frozen universe copy");const newUser=store.userForAppleSubject("research-universe-user");assert.throws(()=>store.addUserAgent(newUser.userId,{agentId:"foundation-equity",configuration:{symbol:"tsla",targetOrderAmount:100}},now),(error:unknown)=>(error as{code?:string}).code==="AGENT_SYMBOL_NOT_ALLOWED");assert.equal(store.userAgents(newUser.userId).length,0);const demoUser="10000000-0000-4000-8000-000000000001";const agent=store.userAgents(demoUser)[0]!;const configurationVersion=agent.configurationVersion;assert.throws(()=>store.patchUserAgent(demoUser,agent.id,{configuration:{symbol:"TSLA"}},now),(error:unknown)=>(error as{code?:string}).code==="AGENT_SYMBOL_NOT_ALLOWED");assert.equal(agent.configuration.symbol,"MSFT");assert.equal(agent.configurationVersion,configurationVersion);store.setAgentStatus(demoUser,agent.id,"paused",now);agent.configuration=Object.freeze({...agent.configuration,symbol:"TSLA"});assert.throws(()=>store.setAgentStatus(demoUser,agent.id,"monitoring",now),(error:unknown)=>(error as{code?:string}).code==="AGENT_SYMBOL_NOT_ALLOWED");assert.throws(()=>store.resumeAll(demoUser,now),(error:unknown)=>(error as{code?:string}).code==="AGENT_SYMBOL_NOT_ALLOWED");assert.equal(agent.status,"paused");});
  it("rejects malformed plan-assignment research universes from persistence",()=>{const row=(universe:unknown)=>({agentId:"foundation-equity",displayName:"Foundation Equity",agentVersion:"1.0.0",catalogPosition:1,releaseStatus:"paper",deterministicStrategyVersion:"foundation-equity-rules-1.0.0",researchUniverse:universe});const rejects=(universe:unknown)=>assert.throws(()=>parsePlanAgentAssignments([row(universe)]),(error:unknown)=>(error as{code?:string;httpStatus?:number}).code==="PLAN_AGENT_CATALOG_INVALID"&&(error as{httpStatus?:number}).httpStatus===503);rejects(["MSFT","AAPL"]);rejects(["AAPL","AAPL"]);rejects(Array.from({length:51},(_,index)=>`A${String(index).padStart(2,"0")}`));});
  it("binds signed sessions to their stored device and rejects rotated refresh replay",()=>{const sessions=new SessionManager(Buffer.alloc(32,3));const issued=sessions.create("user-1","device-1",new Date(now));assert.equal(sessions.verify(issued.accessToken,new Date(now)).deviceId,"device-1");sessions.rotate(issued.sessionId,issued.refreshToken,new Date("2026-08-01T14:01:00.000Z"));assert.throws(()=>sessions.rotate(issued.sessionId,issued.refreshToken,new Date("2026-08-01T14:02:00.000Z")),/already rotated/);});
  it("keeps the default server-side step-up adapter unavailable",async()=>{const verifier=new UnavailableStepUpAuthenticationVerifier();await assert.rejects(verifier.verify({userId:"user-1",sessionId:"session-1",deviceId:"device-1",action:"approve_trade_proposal",resourceId:"proposal-1",proof:{assertion:"opaque"},now:new Date(now)}),(error:unknown)=>(error as{code?:string;httpStatus?:number}).code==="STEP_UP_VERIFICATION_UNAVAILABLE"&&(error as{httpStatus?:number}).httpStatus===503);});
  it("rejects a risk update bound to a superseded policy version",()=>{const store=new MemoryDataStore();const current=store.riskPolicy("10000000-0000-4000-8000-000000000001");const first=prepareRiskPolicyUpdate(current,{maximumDailyLoss:current.maximumDailyLoss-1},current.userId,"2026-08-01T14:00:01.000Z");const stale=prepareRiskPolicyUpdate(current,{maximumPositionAmount:current.maximumPositionAmount-1},current.userId,"2026-08-01T14:00:02.000Z");store.setRiskPolicy(current.userId,first.candidate);assert.throws(()=>store.setRiskPolicy(current.userId,stale.candidate),(error:unknown)=>(error as{code?:string}).code==="RISK_POLICY_VERSION_CONFLICT");});
});

const servers:ReturnType<typeof createApiServer>[]=[];afterEach(async()=>{await Promise.all(servers.splice(0).map((server)=>new Promise<void>((resolve)=>server.close(()=>resolve()))));});
describe("HTTP security controls",()=>{
  it("rejects disallowed origins and requires CSRF for unsafe cookie requests",async()=>{const server=createApiServer({mode:"demo",authSigningKey:Buffer.alloc(32,4),pairingHashPepper:Buffer.alloc(32,5),allowedCorsOrigins:new Set(["https://connect.whox.ai"]),now:()=>new Date(now)});servers.push(server);server.listen(0,"127.0.0.1");await once(server,"listening");const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;const blocked=await fetch(`${base}/healthz`,{headers:{origin:"https://evil.example"}});assert.equal(blocked.status,403);const login=await fetch(`${base}/v1/auth/apple`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({identityToken:"demo-apple-identity-token",deviceId:"device-web"})});const auth=await login.json() as {accessToken:string};const cookie=login.headers.get("set-cookie")!.split(";")[0]!;const unsafe=await fetch(`${base}/v1/risk/pause-all`,{method:"POST",headers:{cookie,"idempotency-key":"pause-without-csrf","content-type":"application/json"},body:"{}"});assert.equal(unsafe.status,403);const csrfResponse=await fetch(`${base}/v1/auth/csrf`,{headers:{authorization:`Bearer ${auth.accessToken}`}});const csrf=await csrfResponse.json() as {csrfToken:string};const allowed=await fetch(`${base}/v1/risk/pause-all`,{method:"POST",headers:{cookie,"x-csrf-token":csrf.csrfToken,"idempotency-key":"pause-with-valid-csrf","content-type":"application/json"},body:"{}"});assert.equal(allowed.status,200);});
  it("fails sensitive operations closed when no server verifier is composed",async()=>{const server=createApiServer({mode:"demo",authSigningKey:Buffer.alloc(32,14),pairingHashPepper:Buffer.alloc(32,15),now:()=>new Date(now)});servers.push(server);server.listen(0,"127.0.0.1");await once(server,"listening");const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;const login=await fetch(`${base}/v1/auth/apple`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({identityToken:"demo-apple-identity-token",deviceId:"unavailable-device"})});const auth=await login.json() as {accessToken:string};const response=await fetch(`${base}/v1/risk/resume-all`,{method:"POST",headers:{authorization:`Bearer ${auth.accessToken}`,"content-type":"application/json","idempotency-key":"unavailable-step-up"},body:JSON.stringify({deviceId:"unavailable-device",stepUpProof:{assertion:"opaque"}})});assert.equal(response.status,503);assert.equal(((await response.json())as{error:{code:string}}).error.code,"STEP_UP_VERIFICATION_UNAVAILABLE");});
  it("fails proposal approval closed without a fresh server-verified proof bound to the signed session device",async()=>{const store=new MemoryDataStore();const verifier:StepUpAuthenticationVerifier={async verify(context:StepUpVerificationContext):Promise<VerifiedStepUpAuthentication>{const kind=String(context.proof.kind??"");return Object.freeze({verificationId:kind==="valid"||kind==="replay"?"verification-valid-1":`verification-${kind}`,userId:context.userId,sessionId:context.sessionId,deviceId:kind==="wrong-context"?"different-device":context.deviceId,action:context.action,resourceId:context.resourceId,method:"app_attest",authenticatedAt:kind==="stale"?"2026-08-01T13:50:00.000Z":"2026-08-01T13:59:30.000Z",expiresAt:"2026-08-01T14:04:30.000Z"});}};const server=createApiServer({mode:"demo",authSigningKey:Buffer.alloc(32,6),pairingHashPepper:Buffer.alloc(32,7),dataStore:store,stepUpVerifier:verifier,now:()=>new Date(now)});servers.push(server);server.listen(0,"127.0.0.1");await once(server,"listening");const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;const login=await fetch(`${base}/v1/auth/apple`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({identityToken:"demo-apple-identity-token",deviceId:"approval-device"})});const auth=await login.json() as {accessToken:string;userID:string};const proposalId="50000000-0000-4000-8000-000000000001";const approve=async(key:string,body:Readonly<Record<string,unknown>>):Promise<Response>=>await fetch(`${base}/v1/proposals/${proposalId}/approve`,{method:"POST",headers:{authorization:`Bearer ${auth.accessToken}`,"content-type":"application/json","idempotency-key":key},body:JSON.stringify(body)});const missing=await approve("approval-missing-proof",{deviceId:"approval-device"});assert.equal(missing.status,403);assert.equal(((await missing.json())as {error:{code:string}}).error.code,"STEP_UP_PROOF_REQUIRED");const wrongDevice=await approve("approval-wrong-device",{deviceId:"other-device",stepUpProof:{kind:"valid"}});assert.equal(wrongDevice.status,403);assert.equal(((await wrongDevice.json())as {error:{code:string}}).error.code,"STEP_UP_DEVICE_MISMATCH");const stale=await approve("approval-stale-proof",{deviceId:"approval-device",stepUpProof:{kind:"stale"}});assert.equal(stale.status,403);assert.equal(((await stale.json())as {error:{code:string}}).error.code,"STEP_UP_PROOF_STALE");const wrongContext=await approve("approval-wrong-context",{deviceId:"approval-device",stepUpProof:{kind:"wrong-context"}});assert.equal(wrongContext.status,403);assert.equal(((await wrongContext.json())as {error:{code:string}}).error.code,"STEP_UP_CONTEXT_MISMATCH");const approved=await approve("approval-valid-proof",{deviceId:"approval-device",stepUpProof:{kind:"valid"}});assert.equal(approved.status,200);assert.equal(((await approved.json())as {status:string}).status,"APPROVED");const record=store.approvalForProposal(auth.userID,proposalId);assert.equal(record.approvingDeviceId,"approval-device");assert.equal(record.sessionId.length>0,true);assert.equal(record.authenticationVerificationId,"verification-valid-1");const replay=await approve("approval-replayed-proof",{deviceId:"approval-device",stepUpProof:{kind:"replay"}});assert.equal(replay.status,409);assert.equal(((await replay.json())as {error:{code:string}}).error.code,"STEP_UP_PROOF_REPLAYED");});
  it("requires exact, fresh, one-time step-up proofs for every sensitive recovery or destructive operation",async()=>{
    const store=new MemoryDataStore();
    const observed:StepUpVerificationContext[]=[];
    const verifier:StepUpAuthenticationVerifier={async verify(context):Promise<VerifiedStepUpAuthentication>{
      observed.push(context);
      const kind=String(context.proof.kind??"");
      const verificationId=kind==="resume-valid"||kind==="replay"?"verification-sensitive-shared":`verification-sensitive-${kind}`;
      return Object.freeze({
        verificationId,
        userId:context.userId,
        sessionId:context.sessionId,
        deviceId:context.deviceId,
        action:context.action,
        resourceId:kind==="wrong-context"?`${context.resourceId}:different`:context.resourceId,
        method:"app_attest",
        authenticatedAt:kind==="stale"?"2026-08-01T13:50:00.000Z":"2026-08-01T13:59:30.000Z",
        expiresAt:"2026-08-01T14:04:30.000Z"
      });
    }};
    const server=createApiServer({mode:"demo",authSigningKey:Buffer.alloc(32,16),pairingHashPepper:Buffer.alloc(32,17),dataStore:store,stepUpVerifier:verifier,now:()=>new Date(now)});
    servers.push(server);server.listen(0,"127.0.0.1");await once(server,"listening");
    const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login=await fetch(`${base}/v1/auth/apple`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({identityToken:"demo-apple-identity-token",deviceId:"sensitive-device"})});
    const auth=await login.json() as {accessToken:string;userID:string};
    let requestNumber=0;
    const request=async(method:string,path:string,body:Readonly<Record<string,unknown>>):Promise<Response>=>await fetch(`${base}${path}`,{method,headers:{authorization:`Bearer ${auth.accessToken}`,"content-type":"application/json","idempotency-key":`sensitive-operation-${++requestNumber}`},body:JSON.stringify(body)});
    const proof=(kind:string):Readonly<Record<string,unknown>>=>({deviceId:"sensitive-device",stepUpProof:{kind}});
    const errorCode=async(response:Response):Promise<string>=>((await response.json())as{error:{code:string}}).error.code;
    const agentId="60000000-0000-4000-8000-000000000001";

    const missing=await request("POST",`/v1/user-agents/${agentId}/resume`,{deviceId:"sensitive-device"});
    assert.equal(missing.status,403);assert.equal(await errorCode(missing),"STEP_UP_PROOF_REQUIRED");
    const stale=await request("POST",`/v1/user-agents/${agentId}/resume`,proof("stale"));
    assert.equal(stale.status,403);assert.equal(await errorCode(stale),"STEP_UP_PROOF_STALE");
    const wrongContext=await request("POST",`/v1/user-agents/${agentId}/resume`,proof("wrong-context"));
    assert.equal(wrongContext.status,403);assert.equal(await errorCode(wrongContext),"STEP_UP_CONTEXT_MISMATCH");
    assert.equal((await request("POST",`/v1/user-agents/${agentId}/resume`,proof("resume-valid"))).status,200);

    const replay=await request("POST","/v1/risk/resume-all",proof("replay"));
    assert.equal(replay.status,409);assert.equal(await errorCode(replay),"STEP_UP_PROOF_REPLAYED");
    assert.equal((await request("POST","/v1/risk/resume-all",proof("resume-all-valid"))).status,200);
    assert.equal((await request("DELETE","/v1/brokers/robinhood/connection",proof("disconnect-valid"))).status,200);

    const initialPolicy=await (await fetch(`${base}/v1/risk-policy`,{headers:{authorization:`Bearer ${auth.accessToken}`}})).json() as {maximumDailyLoss:number;excludedSymbols:string[]};
    const tightened=await request("PATCH","/v1/risk-policy",{maximumDailyLoss:initialPolicy.maximumDailyLoss-1});
    assert.equal(tightened.status,200,"risk tightening must remain available without step-up");
    const exclusionAdded=await request("PATCH","/v1/risk-policy",{excludedSymbols:[...initialPolicy.excludedSymbols,"GME"]});
    assert.equal(exclusionAdded.status,200,"adding an exclusion must remain available without step-up");
    const preview=await request("POST","/v1/risk-policy/preview",{excludedSymbols:[]});
    assert.equal(preview.status,200);
    const previewBody=await preview.json() as {relaxationRequired:boolean;stepUpResourceId:string;currentPolicyId:string;currentVersion:number};
    assert.equal(previewBody.relaxationRequired,true);
    assert.match(previewBody.stepUpResourceId,/^risk-policy:[0-9a-f-]+:v\d+:[0-9a-f]{64}$/);
    assert.equal(previewBody.currentPolicyId.length>0,true);assert.equal(previewBody.currentVersion>0,true);
    const relaxationMissing=await request("PATCH","/v1/risk-policy",{excludedSymbols:[],deviceId:"sensitive-device"});
    assert.equal(relaxationMissing.status,403);assert.equal(await errorCode(relaxationMissing),"STEP_UP_PROOF_REQUIRED");
    assert.equal((await request("PATCH","/v1/risk-policy",{excludedSymbols:[],...proof("risk-relax-valid")})).status,200);

    const deleteMissing=await request("DELETE","/v1/account",{deviceId:"sensitive-device"});
    assert.equal(deleteMissing.status,403);assert.equal(await errorCode(deleteMissing),"STEP_UP_PROOF_REQUIRED");
    const deletion=await request("DELETE","/v1/account",proof("delete-valid"));
    assert.equal(deletion.status,202);
    assert.deepEqual(await deletion.json(),{deletionRequested:true,brokerRevocationPending:false,retentionNotice:"Records subject to legal retention are preserved and access is restricted."});

    assert.equal(observed.find((context)=>context.action==="resume_user_agent")?.resourceId,agentId);
    assert.equal(observed.find((context)=>context.action==="resume_all_user_agents")?.resourceId,auth.userID);
    assert.equal(observed.find((context)=>context.action==="disconnect_broker_connection")?.resourceId,"robinhood_mcp");
    assert.equal(observed.find((context)=>context.action==="relax_risk_policy")?.resourceId,previewBody.stepUpResourceId);
    assert.equal(observed.find((context)=>context.action==="delete_account")?.resourceId,auth.userID);
  });
});
