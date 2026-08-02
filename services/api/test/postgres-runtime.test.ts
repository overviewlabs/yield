import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { DomainError, type ApprovedBrokerConnectorIdentity } from "@whox/contracts";
import { Pool } from "pg";
import { PostgresTenantDatabase } from "../src/database.js";
import { PostgresPairingService } from "../src/postgres-pairings.js";
import { PostgresSessionService } from "../src/postgres-session.js";
import { PostgresApiDataStore } from "../src/postgres-store.js";
import { createApiServer } from "../src/server.js";

const databaseUrl=process.env.TEST_DATABASE_URL;
const sessionKey=Buffer.alloc(32,41);
const pairingPepper=Buffer.alloc(32,42);
const tokenKey=Buffer.alloc(32,43);
const instant=new Date("2026-08-01T14:00:00.000Z");
const approvedTestConnector:ApprovedBrokerConnectorIdentity=Object.freeze({
  provider:"robinhood_mcp",
  adapterId:"approved-test-connector",
  approvalReference:"review:test-2026-08-01",
  authorizationIssuer:"https://auth.broker.test/",
  resourceUri:"https://mcp.broker.test/",
  protocolVersion:"test-1"
});

const hasCode=(code:string)=>(error:unknown):boolean=>error instanceof DomainError&&error.code===code;

async function cleanupAgentMutationFixture(admin:Pool,userId:string):Promise<void>{
  const client=await admin.connect();
  try{
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role=replica");
    await client.query("DELETE FROM trade_proposal_events WHERE user_id=$1",[userId]);
    await client.query("DELETE FROM audit_events WHERE user_id=$1",[userId]);
    await client.query("SET LOCAL session_replication_role=origin");
    await client.query("DELETE FROM queue_jobs WHERE user_id=$1",[userId]);
    await client.query("DELETE FROM approval_requests WHERE user_id=$1",[userId]);
    await client.query("DELETE FROM capital_reservations WHERE user_id=$1",[userId]);
    await client.query("DELETE FROM position_snapshots WHERE user_id=$1",[userId]);
    await client.query("DELETE FROM portfolio_snapshots WHERE user_id=$1",[userId]);
    await client.query("DELETE FROM trade_proposals WHERE user_id=$1",[userId]);
    await client.query("DELETE FROM agent_runs WHERE user_id=$1",[userId]);
    await client.query("DELETE FROM agent_configurations WHERE user_id=$1",[userId]);
    await client.query("DELETE FROM user_agents WHERE user_id=$1",[userId]);
    await client.query("DELETE FROM broker_accounts WHERE user_id=$1",[userId]);
    await client.query("DELETE FROM broker_connections WHERE user_id=$1",[userId]);
    await client.query("DELETE FROM risk_policies WHERE user_id=$1",[userId]);
    await client.query("DELETE FROM entitlements WHERE user_id=$1",[userId]);
    await client.query("DELETE FROM subscriptions WHERE user_id=$1",[userId]);
    await client.query("DELETE FROM users WHERE id=$1",[userId]);
    await client.query("COMMIT");
  }catch(error){
    await client.query("ROLLBACK");
    throw error;
  }finally{
    client.release();
  }
}

describe("PostgreSQL Paper API runtime",{skip:databaseUrl===undefined},()=>{
  it("survives restart, enforces tenant RLS, rejects refresh replay, and consumes pairing material once",async()=>{
    const suffix=randomUUID();
    const firstDatabase=new PostgresTenantDatabase(databaseUrl!);
    const firstStore=new PostgresApiDataStore(firstDatabase,{deviceBindingKey:sessionKey,deviceTokenEncryptionKey:tokenKey});
    const firstSessions=new PostgresSessionService(firstDatabase,sessionKey);
    const firstPairings=new PostgresPairingService(firstDatabase,new URL("https://connect.whox.test"),pairingPepper,10*60_000,approvedTestConnector);
    const owner=await firstStore.userForAppleSubject(`paper-owner-${suffix}`,`owner-${suffix}@example.test`);
    const other=await firstStore.userForAppleSubject(`paper-other-${suffix}`,`other-${suffix}@example.test`);
      const creator=await firstSessions.create(owner.userId,"ios-persistent-device",instant);
      const desktop=await firstSessions.create(owner.userId,"desktop-persistent-device",instant);
      await firstStore.registerPushToken(owner.userId,{token:"cd".repeat(32),environment:"sandbox",deviceId:"ios-persistent-device"});
      const appleAssertionDigest=createHash("sha256").update(`apple-assertion-${suffix}`).digest("hex");
      await firstStore.consumeAppleIdentityAssertion(appleAssertionDigest,"2026-08-01T14:10:00.000Z",instant.toISOString());
    const pairingIdempotencyKey=`POST:/v1/brokers/robinhood/pairings:${suffix}`;
    const pairingPayload={purpose:"restart-persistence"};
    const created=await firstStore.idempotentAsync(owner.userId,pairingIdempotencyKey,pairingPayload,async()=>await firstPairings.create(owner.userId,creator.sessionId,instant.toISOString()));
    assert.notEqual(created.code,"");
    const rotated=await firstSessions.rotate(creator.sessionId,creator.refreshToken,new Date(instant.getTime()+60_000));
    const invisible=await firstDatabase.withTenant(owner.userId,async(transaction)=>(await transaction.query("SELECT id FROM users WHERE id=$1",[other.userId])).rowCount);
    assert.equal(invisible,0,"FORCE RLS must hide another tenant even when its UUID is known");
    await firstDatabase.close();

    const database=new PostgresTenantDatabase(databaseUrl!);
    const store=new PostgresApiDataStore(database,{deviceBindingKey:sessionKey,deviceTokenEncryptionKey:tokenKey});
    const sessions=new PostgresSessionService(database,sessionKey);
    const pairings=new PostgresPairingService(database,new URL("https://connect.whox.test"),pairingPepper,10*60_000,approvedTestConnector);
    try{
      const claims=await sessions.verify(rotated.accessToken,new Date(instant.getTime()+90_000));
      assert.equal(claims.sub,owner.userId);
      await assert.rejects(store.consumeAppleIdentityAssertion(appleAssertionDigest,"2026-08-01T14:10:00.000Z",new Date(instant.getTime()+90_000).toISOString()),hasCode("APPLE_IDENTITY_REPLAYED"));
      assert.equal((await sessions.list(owner.userId)).length,2);
      const restored=await pairings.get(owner.userId,creator.sessionId,created.pairingId,new Date(instant.getTime()+90_000).toISOString());
      assert.equal(restored.status,"pending");
      assert.equal(restored.code,"");
      assert.equal(new URL(restored.setupUrl).searchParams.has("pairing_code"),false,"a restart must not reconstruct the one-time plaintext code");
      const replayedCreation=await store.idempotentAsync(owner.userId,pairingIdempotencyKey,{purpose:"restart-persistence"},async()=>{throw new Error("completed idempotent operation must not execute again");});
      assert.equal((replayedCreation as typeof created).code,"");
      assert.equal(new URL((replayedCreation as typeof created).setupUrl).searchParams.has("pairing_code"),false,"the idempotency response must not persist the plaintext pairing code");

      const mobilePairing=await pairings.create(owner.userId,creator.sessionId,new Date(instant.getTime()+95_000).toISOString());
      const mobileAuthorization=await pairings.beginMobileAuthorization(owner.userId,creator.sessionId,mobilePairing.pairingId,"https://api.whox.test/v1/brokers/robinhood/mobile-oauth/callback","metis://broker-connection/callback",new Date(instant.getTime()+96_000).toISOString());
      assert.equal(mobileAuthorization.state.includes(owner.userId),false,"opaque state must not expose the tenant identifier");
      assert.equal(mobileAuthorization.state.includes(mobilePairing.pairingId),false,"opaque state must not expose the pairing identifier");
      const callbackSecrets=await pairings.mobileCallbackSecrets(mobileAuthorization.state,new Date(instant.getTime()+97_000).toISOString());
      assert.equal(callbackSecrets.ownerUserId,owner.userId);
      assert.equal(callbackSecrets.creatorSessionId,creator.sessionId);
      assert.equal(callbackSecrets.pairingId,mobilePairing.pairingId);
      assert.equal(createHash("sha256").update(callbackSecrets.codeVerifier,"ascii").digest("base64url"),mobileAuthorization.codeChallenge);
      await assert.rejects(pairings.mobileCallbackSecrets(mobileAuthorization.state,new Date(instant.getTime()+97_001).toISOString()),hasCode("MOBILE_OAUTH_CALLBACK_INVALID"));
      await pairings.concludeMobileWithoutConnection(owner.userId,creator.sessionId,mobilePairing.pairingId,mobileAuthorization.state,"canceled",new Date(instant.getTime()+98_000).toISOString());
      assert.equal((await pairings.get(owner.userId,creator.sessionId,mobilePairing.pairingId,new Date(instant.getTime()+98_001).toISOString())).status,"pending");
      const abortedAuthorization=await pairings.beginMobileAuthorization(owner.userId,creator.sessionId,mobilePairing.pairingId,"https://api.whox.test/v1/brokers/robinhood/mobile-oauth/callback","metis://broker-connection/callback",new Date(instant.getTime()+99_000).toISOString());
      await pairings.abortMobileAuthorization(owner.userId,creator.sessionId,mobilePairing.pairingId,new Date(instant.getTime()+99_001).toISOString());
      assert.equal((await pairings.get(owner.userId,creator.sessionId,mobilePairing.pairingId,new Date(instant.getTime()+99_002).toISOString())).status,"pending");
      await assert.rejects(pairings.mobileCallbackSecrets(abortedAuthorization.state,new Date(instant.getTime()+99_003).toISOString()),hasCode("MOBILE_OAUTH_CALLBACK_INVALID"));
      const callbackClaimedAuthorization=await pairings.beginMobileAuthorization(owner.userId,creator.sessionId,mobilePairing.pairingId,"https://api.whox.test/v1/brokers/robinhood/mobile-oauth/callback","metis://broker-connection/callback",new Date(instant.getTime()+99_010).toISOString());
      await pairings.mobileCallbackSecrets(callbackClaimedAuthorization.state,new Date(instant.getTime()+99_011).toISOString());
      await assert.rejects(pairings.cancel(owner.userId,creator.sessionId,mobilePairing.pairingId,new Date(instant.getTime()+99_012).toISOString()),hasCode("PAIRING_AUTHORIZATION_COMMITTED"));
      await pairings.concludeMobileWithoutConnection(owner.userId,creator.sessionId,mobilePairing.pairingId,callbackClaimedAuthorization.state,"canceled",new Date(instant.getTime()+99_013).toISOString());

      const revokedCallbackSession=await sessions.create(owner.userId,"revoked-mobile-callback-device",new Date(instant.getTime()+99_100));
      const revokedCallbackPairing=await pairings.create(owner.userId,revokedCallbackSession.sessionId,new Date(instant.getTime()+99_101).toISOString());
      const revokedCallbackAuthorization=await pairings.beginMobileAuthorization(owner.userId,revokedCallbackSession.sessionId,revokedCallbackPairing.pairingId,"https://api.whox.test/v1/brokers/robinhood/mobile-oauth/callback","metis://broker-connection/callback",new Date(instant.getTime()+99_102).toISOString());
      await sessions.revoke(revokedCallbackSession.sessionId,new Date(instant.getTime()+99_103),owner.userId);
      await assert.rejects(pairings.mobileCallbackSecrets(revokedCallbackAuthorization.state,new Date(instant.getTime()+99_104).toISOString()),hasCode("PAIRING_SESSION_INVALID"));

      const sensitiveReplayKey=`POST:/v1/brokers/robinhood/mobile-oauth/start:${suffix}`;
      const sensitiveReplayPayload={pairingId:mobilePairing.pairingId};
      const sensitiveStart={authorizationUrl:`https://auth.broker.test/authorize?state=${revokedCallbackAuthorization.state}`,callbackScheme:"metis",returnUrl:"metis://broker-connection/callback",pairingId:mobilePairing.pairingId,expiresAt:new Date(instant.getTime()+300_000).toISOString()};
      let sensitiveExecutions=0;
      await store.idempotentAsync(owner.userId,sensitiveReplayKey,sensitiveReplayPayload,async()=>{sensitiveExecutions+=1;return sensitiveStart;});
      const persistedSensitiveResponse=await database.withTenant(owner.userId,async(transaction)=>(await transaction.query<{response:unknown}>("SELECT response FROM api_idempotency_records WHERE user_id=$1 AND idempotency_key=$2",[owner.userId,sensitiveReplayKey])).rows[0]?.response);
      assert.equal(JSON.stringify(persistedSensitiveResponse).includes("authorizationUrl"),false);
      assert.equal(JSON.stringify(persistedSensitiveResponse).includes(revokedCallbackAuthorization.state),false);
      assert.deepEqual(await store.idempotentAsync(owner.userId,sensitiveReplayKey,sensitiveReplayPayload,async()=>{sensitiveExecutions+=1;return sensitiveStart;}),sensitiveStart);
      assert.equal(sensitiveExecutions,2,"a replay reconstructs sensitive authorization output instead of persisting it");

      await pairings.claim(owner.userId,desktop.sessionId,created.code,`valid-${suffix}`,new Date(instant.getTime()+100_000).toISOString());
      await assert.rejects(pairings.claim(owner.userId,desktop.sessionId,created.code,`replay-${suffix}`,new Date(instant.getTime()+101_000).toISOString()),hasCode("PAIRING_CODE_USED"));
      for(let attempt=0;attempt<5;attempt+=1)await assert.rejects(pairings.claim(owner.userId,desktop.sessionId,"ZZZZ-ZZZZ",`limited-${suffix}`,new Date(instant.getTime()+102_000+attempt).toISOString()),hasCode("PAIRING_CODE_INVALID"));
      await assert.rejects(pairings.claim(owner.userId,desktop.sessionId,"ZZZZ-ZZZZ",`limited-${suffix}`,new Date(instant.getTime()+108_000).toISOString()),hasCode("PAIRING_ATTEMPTS_EXCEEDED"));

      await assert.rejects(sessions.rotate(creator.sessionId,creator.refreshToken,new Date(instant.getTime()+120_000)),hasCode("REFRESH_REPLAYED"));
      await assert.rejects(sessions.verify(rotated.accessToken,new Date(instant.getTime()+121_000)),hasCode("AUTH_EXPIRED"));
      const replayRevocation=await database.withTenant(owner.userId,async(transaction)=>(await transaction.query<{invalidated:boolean;revoked:boolean}>(`SELECT dt.invalidated_at IS NOT NULL AS invalidated,d.revoked_at IS NOT NULL AS revoked FROM device_tokens dt JOIN devices d ON d.id=dt.device_id AND d.user_id=dt.user_id WHERE dt.user_id=$1 AND dt.environment='sandbox'`,[owner.userId])).rows[0]);
      assert.deepEqual(replayRevocation,{invalidated:true,revoked:true});

      const expiringSession=await sessions.create(owner.userId,"expiring-pairing-device",new Date(instant.getTime()+130_000));
      const expiringPairings=new PostgresPairingService(database,new URL("https://connect.whox.test"),pairingPepper,1,approvedTestConnector);
      const expiring=await expiringPairings.create(owner.userId,expiringSession.sessionId,new Date(instant.getTime()+130_000).toISOString());
      assert.equal((await expiringPairings.get(owner.userId,expiringSession.sessionId,expiring.pairingId,new Date(instant.getTime()+130_002).toISOString())).status,"expired");

      const server=createApiServer({mode:"paper",dataStore:store,sessionManager:sessions,pairingService:pairings});
      server.listen(0,"127.0.0.1");
      await once(server,"listening");
      try{
        const response=await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/readyz`);
        assert.equal(response.status,200);
        assert.equal(((await response.json())as{status:string}).status,"ready");
        const missingNonce=await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/auth/apple`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({identityToken:"signed-assertion",deviceId:"paper-ios-device"})});
        assert.equal(missingNonce.status,422);
        assert.equal(((await missingNonce.json())as{error:{code:string}}).error.code,"APPLE_NONCE_REQUIRED");
      }finally{await new Promise<void>((resolve)=>server.close(()=>resolve()));}
    }finally{await database.close();}
  });

  it("serializes concurrent plan-agent assignment and rejects a duplicate current agent",async()=>{
    const suffix=randomUUID();
    const database=new PostgresTenantDatabase(databaseUrl!);
    const admin=new Pool({connectionString:databaseUrl});
    const store=new PostgresApiDataStore(database,{deviceBindingKey:sessionKey,deviceTokenEncryptionKey:tokenKey});
    const now="2026-08-01T14:00:00.000Z";
    let accountId:string|undefined;
    try{
      const account=await store.userForAppleSubject(`assignment-race-${suffix}`,`assignment-race-${suffix}@example.test`);
      accountId=account.userId;
      await admin.query(`INSERT INTO subscriptions(user_id,plan_id,original_transaction_id,status,environment,effective_at,expires_at)
        SELECT $1,plan.id,$2,'active','sandbox',$3,$4 FROM plans AS plan WHERE plan.plan_key='equity'`,
      [account.userId,`assignment-race-original-${suffix}`,"2026-08-01T13:59:00.000Z","2099-09-01T14:00:00.000Z"]);
      const input={agentId:"foundation-equity",allocation:0.1,approvalMode:"observe",configuration:{symbol:"AAPL",targetOrderAmount:500}};
      const results=await Promise.allSettled([
        store.addUserAgent(account.userId,input,now),
        store.addUserAgent(account.userId,input,now)
      ]);
      const outcomes=results.map((result)=>result.status==="fulfilled"?"fulfilled":result.reason instanceof DomainError?result.reason.code:result.reason instanceof Error?`${result.reason.name}:${result.reason.message}`:"unknown_error");
      assert.equal(results.filter((result)=>result.status==="fulfilled").length,1,`unexpected concurrent assignment outcomes: ${outcomes.join(",")}`);
      const rejected=results.find((result)=>result.status==="rejected");
      assert.ok(rejected?.status==="rejected");
      assert.equal(hasCode("AGENT_ALREADY_ASSIGNED")(rejected.reason),true);
      assert.equal((await store.userAgents(account.userId)).length,1);
      const persisted=await database.withTenant(account.userId,async(transaction)=>(await transaction.query<{count:number;distinctVersions:number}>(
        `SELECT count(*)::integer AS count,count(DISTINCT agent_version_id)::integer AS "distinctVersions"
         FROM user_agents WHERE user_id=$1 AND deleted_at IS NULL`,[account.userId]
      )).rows[0]);
      assert.deepEqual(persisted,{count:1,distinctVersions:1});
    }finally{
      try{
        if(accountId!==undefined){
          const client=await admin.connect();
          try{
            await client.query("BEGIN");
            await client.query("DELETE FROM agent_configurations WHERE user_id=$1",[accountId]);
            await client.query("DELETE FROM user_agents WHERE user_id=$1",[accountId]);
            await client.query("DELETE FROM risk_policies WHERE user_id=$1",[accountId]);
            await client.query("DELETE FROM subscriptions WHERE user_id=$1",[accountId]);
            await client.query("DELETE FROM users WHERE id=$1",[accountId]);
            await client.query("COMMIT");
          }catch(error){
            await client.query("ROLLBACK");
            throw error;
          }finally{
            client.release();
          }
        }
      }finally{
        await database.close();
        await admin.end();
      }
    }
  });

  it("anchors agent lookup to the latest authoritative active subscription before matching",async()=>{
    const suffix=randomUUID();
    const database=new PostgresTenantDatabase(databaseUrl!);
    const admin=new Pool({connectionString:databaseUrl});
    const store=new PostgresApiDataStore(database,{deviceBindingKey:sessionKey,deviceTokenEncryptionKey:tokenKey});
    let accountId:string|undefined;
    try{
      const account=await store.userForAppleSubject(`assignment-authority-${suffix}`,`assignment-authority-${suffix}@example.test`);
      accountId=account.userId;
      await admin.query(`INSERT INTO subscriptions(user_id,plan_id,original_transaction_id,status,environment,effective_at,expires_at)
        SELECT $1,plan.id,$2,'active','sandbox',$3,$4 FROM plans AS plan WHERE plan.plan_key='equity_pro'`,
      [account.userId,`assignment-authority-older-${suffix}`,"2026-08-01T13:00:00.000Z","2099-09-01T14:00:00.000Z"]);
      await admin.query(`INSERT INTO subscriptions(user_id,plan_id,original_transaction_id,status,environment,effective_at,expires_at)
        SELECT $1,plan.id,$2,'active','sandbox',$3,$4 FROM plans AS plan WHERE plan.plan_key='equity'`,
      [account.userId,`assignment-authority-latest-${suffix}`,"2026-08-01T13:30:00.000Z","2099-09-01T14:00:00.000Z"]);
      const expectedPlanId=(await admin.query<{id:string}>("SELECT id::text FROM plans WHERE plan_key='equity'")).rows[0]!.id;
      const momentumVersionId=(await admin.query<{id:string}>(`SELECT version.id::text FROM agent_versions AS version JOIN agent_definitions AS definition ON definition.id=version.agent_definition_id WHERE definition.agent_key='equity-momentum' AND version.version='1.0.0'`)).rows[0]!.id;
      const resolved=await database.withTenant(account.userId,async(transaction)=>{
        const latest=await transaction.query<{planId:string}>(`SELECT assignment.plan_id::text AS "planId" FROM app.lock_current_plan_agent_assignment($1,'foundation-equity',NULL::uuid) AS assignment`,[account.userId]);
        const staleByKey=await transaction.query(`SELECT 1 FROM app.lock_current_plan_agent_assignment($1,'equity-momentum',NULL::uuid)`,[account.userId]);
        const staleByVersion=await transaction.query(`SELECT 1 FROM app.lock_current_plan_agent_assignment($1,NULL::text,$2::uuid)`,[account.userId,momentumVersionId]);
        return {latestPlanId:latest.rows[0]?.planId,staleByKey:staleByKey.rowCount,staleByVersion:staleByVersion.rowCount};
      });
      assert.deepEqual(resolved,{latestPlanId:expectedPlanId,staleByKey:0,staleByVersion:0});
    }finally{
      try{if(accountId!==undefined)await cleanupAgentMutationFixture(admin,accountId);}
      finally{await database.close();await admin.end();}
    }
  });

  it("refuses monitoring and resume after a plan downgrade until the over-limit assignment is removed",async()=>{
    const suffix=randomUUID();
    const database=new PostgresTenantDatabase(databaseUrl!);
    const admin=new Pool({connectionString:databaseUrl});
    const store=new PostgresApiDataStore(database,{deviceBindingKey:sessionKey,deviceTokenEncryptionKey:tokenKey});
    const foundationId=randomUUID();
    const momentumId=randomUUID();
    let accountId:string|undefined;
    try{
      const account=await store.userForAppleSubject(`assignment-downgrade-${suffix}`,`assignment-downgrade-${suffix}@example.test`);
      accountId=account.userId;
      await admin.query(`INSERT INTO subscriptions(user_id,plan_id,original_transaction_id,status,environment,effective_at,expires_at)
        SELECT $1,plan.id,$2,'active','sandbox',$3,$4 FROM plans AS plan WHERE plan.plan_key='equity_pro'`,
      [account.userId,`assignment-downgrade-older-${suffix}`,"2026-08-01T13:00:00.000Z","2099-09-01T14:00:00.000Z"]);
      await admin.query(`INSERT INTO subscriptions(user_id,plan_id,original_transaction_id,status,environment,effective_at,expires_at)
        SELECT $1,plan.id,$2,'active','sandbox',$3,$4 FROM plans AS plan WHERE plan.plan_key='equity'`,
      [account.userId,`assignment-downgrade-latest-${suffix}`,"2026-08-01T13:30:00.000Z","2099-09-01T14:00:00.000Z"]);
      const versions=await admin.query<{id:string;agentId:string}>(`SELECT version.id::text,definition.agent_key AS "agentId" FROM agent_versions AS version JOIN agent_definitions AS definition ON definition.id=version.agent_definition_id WHERE definition.agent_key=ANY($1::text[]) AND version.version='1.0.0'`,[["foundation-equity","equity-momentum"]]);
      const versionByAgent=new Map(versions.rows.map((row)=>[row.agentId,row.id]));
      await admin.query(`INSERT INTO user_agents(id,user_id,agent_version_id,status,environment,allocation_limit,approval_mode,created_at,updated_at) VALUES
        ($1,$3,$4,'monitoring','paper',0.1,'observe',$6,$6),
        ($2,$3,$5,'paused','paper',0.1,'observe',$6,$6)`,
      [foundationId,momentumId,account.userId,versionByAgent.get("foundation-equity"),versionByAgent.get("equity-momentum"),"2026-08-01T13:40:00.000Z"]);
      await admin.query(`INSERT INTO agent_configurations(user_agent_id,user_id,version,configuration,effective_at) VALUES
        ($1,$3,1,$4::jsonb,$6),($2,$3,1,$5::jsonb,$6)`,
      [foundationId,momentumId,account.userId,JSON.stringify({symbol:"AAPL",targetOrderAmount:500}),JSON.stringify({mode:"test"}),"2026-08-01T13:40:00.000Z"]);

      assert.equal((await store.setAgentStatus(account.userId,foundationId,"paused","2026-08-01T14:00:00.000Z")).status,"paused","pause must remain available after downgrade");
      await assert.rejects(store.setAgentStatus(account.userId,foundationId,"monitoring","2026-08-01T14:00:01.000Z"),hasCode("AGENT_LIMIT_REACHED"));
      await assert.rejects(store.resumeAll(account.userId,"2026-08-01T14:00:02.000Z"),hasCode("AGENT_LIMIT_REACHED"));
      assert.deepEqual((await store.userAgents(account.userId)).map((agent)=>agent.status),["paused","paused"]);

      await store.deleteUserAgent(account.userId,momentumId,"2026-08-01T14:00:03.000Z");
      assert.equal((await store.setAgentStatus(account.userId,foundationId,"monitoring","2026-08-01T14:00:04.000Z")).status,"monitoring");
      assert.equal((await store.setAgentStatus(account.userId,foundationId,"paused","2026-08-01T14:00:05.000Z")).status,"paused");
      assert.equal((await store.resumeAll(account.userId,"2026-08-01T14:00:06.000Z")).resumed,true);
      assert.equal((await store.userAgents(account.userId))[0]?.status,"monitoring");
    }finally{
      try{if(accountId!==undefined)await cleanupAgentMutationFixture(admin,accountId);}
      finally{await database.close();await admin.end();}
    }
  });

  it("removes an agent by canceling unsubmitted work, releasing reservations, auditing the control, and preserving positions",async()=>{
    const suffix=randomUUID();
    const database=new PostgresTenantDatabase(databaseUrl!);
    const admin=new Pool({connectionString:databaseUrl});
    const store=new PostgresApiDataStore(database,{deviceBindingKey:sessionKey,deviceTokenEncryptionKey:tokenKey});
    const ids={connection:randomUUID(),account:randomUUID(),snapshot:randomUUID(),position:randomUUID(),run:randomUUID(),proposal:randomUUID(),approval:randomUUID(),reservation:randomUUID(),orphanReservation:randomUUID()};
    const deleteAt="2026-08-01T14:10:00.000Z";
    let accountId:string|undefined;
    try{
      const account=await store.userForAppleSubject(`assignment-delete-${suffix}`,`assignment-delete-${suffix}@example.test`);
      accountId=account.userId;
      await admin.query(`INSERT INTO subscriptions(user_id,plan_id,original_transaction_id,status,environment,effective_at,expires_at)
        SELECT $1,plan.id,$2,'active','sandbox',$3,$4 FROM plans AS plan WHERE plan.plan_key='equity'`,
      [account.userId,`assignment-delete-${suffix}`,"2026-08-01T13:30:00.000Z","2099-09-01T14:00:00.000Z"]);
      const agent=await store.addUserAgent(account.userId,{agentId:"foundation-equity",allocation:0.1,approvalMode:"observe",configuration:{symbol:"AAPL",targetOrderAmount:500}},"2026-08-01T13:40:00.000Z");
      await store.setAgentStatus(account.userId,agent.id,"monitoring","2026-08-01T13:41:00.000Z");
      const versionId=(await admin.query<{id:string}>("SELECT agent_version_id::text AS id FROM user_agents WHERE id=$1",[agent.id])).rows[0]!.id;
      await admin.query(`INSERT INTO broker_connections(id,user_id,provider,status,connected_at,last_sync_at) VALUES($1,$2,'robinhood_mcp','connected',$3,$3)`,[ids.connection,account.userId,"2026-08-01T13:35:00.000Z"]);
      await admin.query(`INSERT INTO broker_accounts(id,connection_id,user_id,opaque_broker_id,masked_identifier,account_type,is_agentic_account,verified_for_trading_at,active) VALUES($1,$2,$3,$4,'Paper account test','individual_agentic',true,$5,true)`,[ids.account,ids.connection,account.userId,`delete-account-${suffix}`,"2026-08-01T13:35:00.000Z"]);
      await admin.query(`INSERT INTO portfolio_snapshots(id,user_id,broker_account_id,environment,total_value,buying_power,cash_value,source_timestamp,valid_until,data_classification) VALUES($1,$2,$3,'paper',10000,5000,5000,$4,$5,'paper')`,[ids.snapshot,account.userId,ids.account,"2026-08-01T13:55:00.000Z","2099-09-01T14:00:00.000Z"]);
      await admin.query(`INSERT INTO position_snapshots(id,portfolio_snapshot_id,user_id,broker_position_id,symbol,instrument_type,quantity,average_cost,market_value,unrealized_pnl,details) VALUES($1,$2,$3,$4,'AAPL','equity',5,180,1000,100,'{}'::jsonb)`,[ids.position,ids.snapshot,account.userId,`delete-position-${suffix}`]);
      await admin.query(`INSERT INTO agent_runs(id,user_id,user_agent_id,status,idempotency_key,started_at,completed_at,strategy_version,structured_outcome) VALUES($1,$2,$3,'completed',$4,$5,$5,'foundation-equity-rules-1.0.0','{}'::jsonb)`,[ids.run,account.userId,agent.id,`delete-run-${suffix}`,"2026-08-01T13:56:00.000Z"]);
      await admin.query(`INSERT INTO trade_proposals(id,user_id,broker_account_id,agent_run_id,agent_version_id,environment,status,version,symbol,instrument_type,proposal,proposal_fingerprint,idempotency_key,expires_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'paper','AWAITING_USER_APPROVAL',1,'AAPL','equity','{}'::jsonb,$6,$7,$8,$9,$9)`,[ids.proposal,account.userId,ids.account,ids.run,versionId,"f".repeat(64),`delete-proposal-${suffix}`,"2099-09-01T14:00:00.000Z","2026-08-01T13:57:00.000Z"]);
      await admin.query(`INSERT INTO approval_requests(id,proposal_id,user_id,status,idempotency_key,requested_at,expires_at) VALUES($1,$2,$3,'pending',$4,$5,$6)`,[ids.approval,ids.proposal,account.userId,`delete-approval-${suffix}`,"2026-08-01T13:58:00.000Z","2099-09-01T14:00:00.000Z"]);
      await admin.query(`INSERT INTO capital_reservations(id,user_id,broker_account_id,user_agent_id,proposal_id,symbol,side,amount,idempotency_key,expires_at) VALUES
        ($1,$3,$4,$5,$6,'AAPL','buy',500,$7,$9),
        ($2,$3,$4,$5,NULL,'MSFT','buy',250,$8,$9)`,
      [ids.reservation,ids.orphanReservation,account.userId,ids.account,agent.id,ids.proposal,`delete-reservation-${suffix}`,`delete-orphan-reservation-${suffix}`,"2099-09-01T14:00:00.000Z"]);
      const controlledQueueKeys=[`delete-run-job-${suffix}`,`delete-market-job-${suffix}`,`submit:${ids.proposal}`,`proposal-ready:${ids.proposal}`];
      await admin.query(`INSERT INTO queue_jobs(queue_name,user_id,job_type,payload,idempotency_key,status) VALUES
        ('agent-runs',$1,'run_agent',$2::jsonb,$6,'queued'),
        ('market-data',$1,'hydrate_market',$3::jsonb,$7,'queued'),
        ('execution',$1,'submit_approved',$4::jsonb,$8,'queued'),
        ('notifications',$1,'deliver_notification',$5::jsonb,$9,'queued')`,
      [account.userId,JSON.stringify({userAgentId:agent.id}),JSON.stringify({userAgentId:agent.id}),JSON.stringify({proposalId:ids.proposal}),JSON.stringify({proposalId:ids.proposal}),...controlledQueueKeys]);

      await store.deleteUserAgent(account.userId,agent.id,deleteAt);
      const state=await database.withTenant(account.userId,async(transaction)=>{
        const removed=await transaction.query<{paused:boolean;deletedAtMatches:boolean}>("SELECT status='paused' AS paused,deleted_at=$3::timestamptz AS \"deletedAtMatches\" FROM user_agents WHERE id=$1 AND user_id=$2",[agent.id,account.userId,deleteAt]);
        const proposal=await transaction.query<{status:string;version:number;updatedAtMatches:boolean}>("SELECT status::text,version,updated_at=$3::timestamptz AS \"updatedAtMatches\" FROM trade_proposals WHERE id=$1 AND user_id=$2",[ids.proposal,account.userId,deleteAt]);
        const approval=await transaction.query<{status:string;actedAtMatches:boolean}>("SELECT status,acted_at=$3::timestamptz AS \"actedAtMatches\" FROM approval_requests WHERE id=$1 AND user_id=$2",[ids.approval,account.userId,deleteAt]);
        const reservations=await transaction.query<{count:number;released:number}>("SELECT count(*)::integer AS count,count(*) FILTER (WHERE released_at=$2::timestamptz)::integer AS released FROM capital_reservations WHERE user_id=$1",[account.userId,deleteAt]);
        const jobs=await transaction.query<{count:number;deadLettered:number;reasoned:number}>("SELECT count(*)::integer AS count,count(*) FILTER (WHERE status='dead_letter')::integer AS \"deadLettered\",count(*) FILTER (WHERE last_error_code='AGENT_REMOVED')::integer AS reasoned FROM queue_jobs WHERE user_id=$1 AND idempotency_key=ANY($2::text[])",[account.userId,controlledQueueKeys]);
        const event=await transaction.query<{reasonCode:string;source:string}>("SELECT reason_code AS \"reasonCode\",metadata->>'source' AS source FROM trade_proposal_events WHERE proposal_id=$1 AND user_id=$2 ORDER BY occurred_at DESC LIMIT 1",[ids.proposal,account.userId]);
        const audit=await transaction.query<{action:string;positionsUntouched:boolean}>("SELECT action,(after_state->>'positionsUntouched')::boolean AS \"positionsUntouched\" FROM audit_events WHERE user_id=$1 AND resource_id=$2 ORDER BY occurred_at DESC LIMIT 1",[account.userId,agent.id]);
        const position=await transaction.query<{count:number;quantity:number}>("SELECT count(*)::integer AS count,COALESCE(sum(quantity),0)::float8 AS quantity FROM position_snapshots WHERE user_id=$1",[account.userId]);
        const notification=await transaction.query<{positionsUntouched:boolean}>("SELECT payload->>'privateBody' LIKE '%positions were not changed%' AS \"positionsUntouched\" FROM queue_jobs WHERE user_id=$1 AND idempotency_key=$2",[account.userId,`agent-removed:${agent.id}:${deleteAt}`]);
        return {removed:removed.rows[0],proposal:proposal.rows[0],approval:approval.rows[0],reservations:reservations.rows[0],jobs:jobs.rows[0],event:event.rows[0],audit:audit.rows[0],position:position.rows[0],notification:notification.rows[0]};
      });
      assert.deepEqual(state.removed,{paused:true,deletedAtMatches:true});
      assert.deepEqual(state.proposal,{status:"CANCELED",version:2,updatedAtMatches:true});
      assert.deepEqual(state.approval,{status:"canceled",actedAtMatches:true});
      assert.deepEqual(state.reservations,{count:2,released:2});
      assert.deepEqual(state.jobs,{count:4,deadLettered:4,reasoned:4});
      assert.deepEqual(state.event,{reasonCode:"AGENT_REMOVED",source:"authoritative_agent_removal"});
      assert.deepEqual(state.audit,{action:"remove_agent",positionsUntouched:true});
      assert.deepEqual(state.position,{count:1,quantity:5});
      assert.deepEqual(state.notification,{positionsUntouched:true});
      assert.equal((await store.userAgents(account.userId)).length,0);
    }finally{
      try{if(accountId!==undefined)await cleanupAgentMutationFixture(admin,accountId);}
      finally{await database.close();await admin.end();}
    }
  });

  it("serves persisted Paper onboarding, entitlements, settings, portfolio, agents, approvals, orders, and notifications without Demo fixtures",async()=>{
    const suffix=randomUUID();
    const database=new PostgresTenantDatabase(databaseUrl!);
    const admin=new Pool({connectionString:databaseUrl});
    const store=new PostgresApiDataStore(database,{deviceBindingKey:sessionKey,deviceTokenEncryptionKey:tokenKey});
    const sessions=new PostgresSessionService(database,sessionKey);
    const pairings=new PostgresPairingService(database,new URL("https://connect.whox.test"),pairingPepper,10*60_000,approvedTestConnector);
    const now="2026-08-01T14:00:00.000Z";
    try{
      const account=await store.userForAppleSubject(`paper-surface-${suffix}`,`surface-${suffix}@example.test`);
      const mobile=await sessions.create(account.userId,"surface-mobile-device",new Date(now));
      const desktop=await sessions.create(account.userId,"surface-desktop-device",new Date(now));
      const allPlans=await store.plans(account.userId);
      const canonicalPlanIds=new Set(["equity","equity_pro","options","options_pro"]);
      const plans=allPlans.filter((plan)=>canonicalPlanIds.has(plan.id));
      assert.equal(plans.length,4);
      assert.equal(plans.every((plan)=>plan.agents.length>=1&&plan.agents.length<=3&&plan.features.maximumActiveAgents<=3),true);
      assert.equal(plans.every((plan)=>plan.agents.every((agent)=>agent.researchUniverse.length>=1&&agent.researchUniverse.length<=50)),true);
      assert.deepEqual(plans.find((plan)=>plan.id==="equity")?.agents[0]?.researchUniverse,["AAPL","MSFT","VTI"]);
      assert.deepEqual(plans.find((plan)=>plan.id==="options")?.agents.map((agent)=>agent.agentId),["foundation-equity","directional-options","covered-strategy"]);
      assert.deepEqual(plans.find((plan)=>plan.id==="options_pro")?.agents.map((agent)=>agent.agentId),["foundation-equity","defined-risk-spreads","range-volatility"]);
      assert.equal(plans.find((plan)=>plan.id==="options_pro")?.features.maximumActiveAgents,3);
      assert.equal(plans.find((plan)=>plan.id==="equity_pro")?.agents.find((agent)=>agent.agentId==="equity-momentum")?.releaseStatus,"draft");
      await store.recordEligibility(account.userId,{country:"US",state:"NY",minimumAgeStatus:"meetsRequirement",individualAccountStatus:"actingForOwnAccount",understandsNotBroker:true,adviserClientClassification:"selfDirected"},now);
      await store.createRiskAssessment(account.userId,{objective:"long_term_growth",holdingPeriod:"more_than_5_years",tradingExperience:"some",stockExperience:"some",optionsExperience:"none",maximumAcceptableDrawdownPercent:18,dependsOnInvestedFunds:false,liquidityNeed:"low",volatilityComfort:"some",confirmationPreference:"confirm_every_trade",understandsOptionsPremiumLoss:false,answersAcknowledged:true},now);

      const legalVersion=`PAPER-TEST-${suffix}`;
      const legalPublishedAt=new Date().toISOString();
      const requiredKeys=["terms","privacy","ai-risk","broker","subscription","electronic","performance","ai-data"];
      for(const key of requiredKeys)await admin.query(`INSERT INTO legal_documents(document_key,version,title,content_uri,content_sha256,production_approved,published_at) VALUES($1,$2,$3,$4,$5,true,$6)`,[key,legalVersion,`${key} test document`,`https://legal.whox.test/${key}/${legalVersion}`,"a".repeat(64),legalPublishedAt]);
      const currentLegalDocuments=await store.legalDocuments(account.userId);
      assert.equal(currentLegalDocuments.length,requiredKeys.length);
      assert.equal(currentLegalDocuments.every((document)=>document.productionApproved===true&&String(document.contentURI).startsWith("https://")),true);
      await store.recordLegalConsents(account.userId,{accepted:true,documentVersions:Object.fromEntries(requiredKeys.map((key)=>[key,legalVersion]))},mobile.sessionId,"surface-mobile-device",legalPublishedAt);
      assert.equal(await store.hasAllRequiredLegalConsents(account.userId),true);

      const verifiedSubscription={productID:"ai.whox.metis.equity.monthly",transactionID:`transaction-${suffix}`,originalTransactionID:`original-${suffix}`,environment:"Sandbox" as const,signedPayloadDigest:"c".repeat(64),appAccountToken:account.userId,purchasedAt:"2026-08-01T13:59:00.000Z",expiresAt:"2026-09-01T14:00:00.000Z",signedAt:"2026-08-01T14:00:00.000Z"};
      await store.syncVerifiedSubscription(account.userId,verifiedSubscription);
      assert.equal((await store.entitlements(account.userId)).stockTrading,true);
      const draftAccount=await store.userForAppleSubject(`paper-draft-${suffix}`,`draft-${suffix}@example.test`);
      await store.syncVerifiedSubscription(draftAccount.userId,{...verifiedSubscription,productID:"ai.whox.metis.equitypro.monthly",transactionID:`draft-transaction-${suffix}`,originalTransactionID:`draft-original-${suffix}`,signedPayloadDigest:"e".repeat(64),appAccountToken:draftAccount.userId});
      await admin.query(`INSERT INTO entitlements(user_id,subscription_id,feature_key,value,effective_at)
        SELECT $1,subscription.id,override.feature_key,override.value,override.effective_at
        FROM subscriptions AS subscription
        CROSS JOIN (VALUES
          ('maximumActiveAgents','2'::jsonb,'2026-08-01T13:58:00.000Z'::timestamptz),
          ('maximumActiveAgents','1'::jsonb,'2026-08-01T13:59:00.000Z'::timestamptz),
          ('monitoringFrequencyMinutes','60'::jsonb,'2026-08-01T13:59:00.000Z'::timestamptz),
          ('automaticMode','false'::jsonb,'2026-08-01T13:59:00.000Z'::timestamptz),
          ('agentCatalog','["equity-momentum"]'::jsonb,'2026-08-01T13:59:00.000Z'::timestamptz)
        ) AS override(feature_key,value,effective_at)
        WHERE subscription.user_id=$1 AND subscription.original_transaction_id=$2`,[draftAccount.userId,`draft-original-${suffix}`]);
      const overriddenEntitlements=await store.entitlements(draftAccount.userId);
      assert.equal(overriddenEntitlements.maximumActiveAgents,1);
      assert.equal(overriddenEntitlements.monitoringFrequencyMinutes,60);
      assert.equal(overriddenEntitlements.automaticMode,false);
      assert.deepEqual(overriddenEntitlements.agentCatalog,["foundation-equity","equity-momentum","quality-swing"],"normalized current catalog must override any entitlement JSON mirror");
      await assert.rejects(store.addUserAgent(draftAccount.userId,{agentId:"equity-momentum",configuration:{symbol:"TSLA",targetOrderAmount:500}},now),hasCode("AGENT_VERSION_UNAVAILABLE"),"draft availability rejection must take precedence over research-universe membership");
      await admin.query(`UPDATE plans SET features=jsonb_set(features,'{agentCatalog}','["foundation-equity","equity-momentum"]'::jsonb) WHERE plan_key='equity'`);
      try{
        assert.deepEqual((await store.entitlements(account.userId)).agentCatalog,["foundation-equity"],"normalized plan mapping must override a stale legacy JSON mirror");
        await assert.rejects(store.addUserAgent(account.userId,{agentId:"equity-momentum",configuration:{symbol:"MSFT",targetOrderAmount:500}},now),hasCode("AGENT_NOT_ENTITLED"));
      }finally{
        await admin.query(`UPDATE plans SET features=jsonb_set(features,'{agentCatalog}','["foundation-equity"]'::jsonb) WHERE plan_key='equity'`);
      }
      await assert.rejects(store.addUserAgent(account.userId,{agentId:"foundation-equity",allocation:0.2,approvalMode:"confirm_every_trade",configuration:{symbol:"tsla",targetOrderAmount:1000}},now),hasCode("AGENT_SYMBOL_NOT_ALLOWED"));
      assert.equal((await store.userAgents(account.userId)).length,0);
      const userAgent=await store.addUserAgent(account.userId,{agentId:"foundation-equity",allocation:0.2,approvalMode:"confirm_every_trade",configuration:{symbol:"aapl",targetOrderAmount:1000}},now);
      assert.equal(userAgent.configurationVersion,1);
      assert.deepEqual(userAgent.configuration,{symbol:"AAPL",targetOrderAmount:1000});
      const patchedAgent=await store.patchUserAgent(account.userId,userAgent.id,{configuration:{targetOrderAmount:1250}},"2026-08-01T14:00:01.000Z");
      assert.equal(patchedAgent.configurationVersion,2);
      assert.deepEqual(patchedAgent.configuration,{symbol:"AAPL",targetOrderAmount:1250});
      await assert.rejects(store.patchUserAgent(account.userId,userAgent.id,{allocation:0.25,configuration:{symbol:"TSLA"}},"2026-08-01T14:00:01.500Z"),hasCode("AGENT_SYMBOL_NOT_ALLOWED"));
      const unchangedAgent=(await store.userAgents(account.userId)).find((agent)=>agent.id===userAgent.id)!;
      assert.equal(unchangedAgent.allocation,0.2);
      assert.equal(unchangedAgent.configurationVersion,2);
      assert.deepEqual(unchangedAgent.configuration,{symbol:"AAPL",targetOrderAmount:1250});
      assert.equal((await store.setAgentStatus(account.userId,userAgent.id,"monitoring","2026-08-01T14:00:02.000Z")).status,"monitoring");
      assert.equal((await store.setAgentStatus(account.userId,userAgent.id,"paused","2026-08-01T14:00:03.000Z")).status,"paused");
      await database.withTenant(account.userId,async(transaction)=>{await transaction.query(`UPDATE agent_configurations SET configuration=jsonb_set(configuration,'{symbol}','"TSLA"'::jsonb) WHERE user_agent_id=$1 AND user_id=$2 AND superseded_at IS NULL`,[userAgent.id,account.userId]);});
      await assert.rejects(store.setAgentStatus(account.userId,userAgent.id,"monitoring","2026-08-01T14:00:03.500Z"),hasCode("AGENT_SYMBOL_NOT_ALLOWED"));
      await assert.rejects(store.resumeAll(account.userId,"2026-08-01T14:00:03.600Z"),hasCode("AGENT_SYMBOL_NOT_ALLOWED"));
      assert.equal((await store.userAgents(account.userId))[0]?.status,"paused");
      await database.withTenant(account.userId,async(transaction)=>{await transaction.query(`UPDATE agent_configurations SET configuration=jsonb_set(configuration,'{symbol}','"AAPL"'::jsonb) WHERE user_agent_id=$1 AND user_id=$2 AND superseded_at IS NULL`,[userAgent.id,account.userId]);});
      assert.equal((await store.setAgentStatus(account.userId,userAgent.id,"monitoring","2026-08-01T14:00:04.000Z")).status,"monitoring");
      const originalPolicy=await store.riskPolicy(account.userId);
      const updatedPolicy=await store.setRiskPolicy(account.userId,{...originalPolicy,maximumDailyLoss:450,version:originalPolicy.version+1,updatedAt:"2026-08-01T14:00:01.000Z"});
      assert.equal(updatedPolicy.version,originalPolicy.version+1);
      assert.equal(updatedPolicy.maximumDailyLoss,450);

      const settings=await store.patchSettings(account.userId,{privacyMode:true,appearance:"dark",notificationPreferences:{detailedPreviewsEnabled:false,criticalNotificationsEnabled:true,quietHours:{startMinute:1320,endMinute:420,utcOffsetMinutes:-240}}},now);
      assert.equal(settings.privacyMode,true);
      const clearedSettings=await store.patchSettings(account.userId,{notificationPreferences:{quietHours:null}},"2026-08-01T14:00:04.000Z");
      assert.equal(Object.hasOwn(clearedSettings.notificationPreferences as object,"quietHours"),false);
      await store.registerPushToken(account.userId,{token:"ab".repeat(32),environment:"sandbox",deviceId:"surface-mobile-device"});
      const tokenServer=createApiServer({mode:"paper",dataStore:store,sessionManager:sessions,pairingService:pairings,now:()=>new Date(now)});
      tokenServer.listen(0,"127.0.0.1");
      await once(tokenServer,"listening");
      try{const unregister=await fetch(`http://127.0.0.1:${(tokenServer.address() as AddressInfo).port}/v1/devices/push-token`,{method:"DELETE",headers:{authorization:`Bearer ${mobile.accessToken}`,"idempotency-key":`push-delete-${suffix}`}});assert.equal(unregister.status,200);assert.deepEqual(await unregister.json(),{unregistered:true});}finally{await new Promise<void>((resolve)=>tokenServer.close(()=>resolve()));}
      assert.equal(await database.withTenant(account.userId,async(transaction)=>(await transaction.query<{invalidated:boolean}>("SELECT invalidated_at IS NOT NULL AS invalidated FROM device_tokens WHERE user_id=$1",[account.userId])).rows[0]?.invalidated),true);
      await store.registerPushToken(account.userId,{token:"ab".repeat(32),environment:"sandbox",deviceId:"surface-mobile-device"});

      const pairing=await pairings.create(account.userId,mobile.sessionId,now);
      await pairings.claim(account.userId,desktop.sessionId,pairing.code,`surface-${suffix}`,now);
      const state=await pairings.beginAuthorization(account.userId,desktop.sessionId,pairing.pairingId,now);
      await pairings.completeForSession(account.userId,desktop.sessionId,pairing.pairingId,state,{
        identity:approvedTestConnector,
        credentialHandle:`vault:test-broker-credential:${suffix}`,
        resourceUri:approvedTestConnector.resourceUri,
        connection:{status:"connected",maskedAccountIdentifier:"Paper account •••• 1234",capabilities:[],equityTradingAvailable:false,optionsTradingAvailable:false}
      },now);
      const initialHydration=await database.withTenant(account.userId,async(transaction)=>(await transaction.query<{lastSyncIsNull:boolean;credentialBound:boolean;credentialConfirmed:boolean;connectionStatus:string;pairingStatus:string;payload:Readonly<Record<string,unknown>>}>(`SELECT bc.last_sync_at IS NULL AS "lastSyncIsNull",bc.credential_handle IS NOT NULL AS "credentialBound",bc.credential_confirmed_at IS NOT NULL AS "credentialConfirmed",bc.status AS "connectionStatus",pairing.status AS "pairingStatus",q.payload FROM broker_connections bc JOIN queue_jobs q ON q.user_id=bc.user_id AND q.queue_name='broker-sync' AND q.idempotency_key=$2 JOIN connection_pairings pairing ON pairing.id=$3 AND pairing.user_id=bc.user_id WHERE bc.user_id=$1 AND bc.provider='robinhood_mcp'`,[account.userId,`initial-broker-sync:${pairing.pairingId}`,pairing.pairingId])).rows[0]);
      assert.ok(initialHydration);
      assert.deepEqual(initialHydration,{lastSyncIsNull:true,credentialBound:true,credentialConfirmed:true,connectionStatus:"pending",pairingStatus:"authorizing",payload:{connectionId:initialHydration.payload.connectionId,pairingId:pairing.pairingId,provider:"robinhood_mcp",trigger:"authorization_completed"}});
      assert.equal(typeof initialHydration.payload.connectionId,"string");
      assert.equal(/credential|token|secret|verifier/i.test(JSON.stringify(initialHydration.payload)),false,"broker-sync queue payload must contain no credential reference or secret material");

      await database.withTenant(account.userId,async(transaction)=>{
        await transaction.query("UPDATE broker_connections SET status='connected',connected_at=$2,connection_summary=$3::jsonb WHERE user_id=$1 AND provider='robinhood_mcp'",[account.userId,now,JSON.stringify({status:"connected",maskedAccountIdentifier:"Paper account •••• 1234",capabilities:[],equityTradingAvailable:false,optionsTradingAvailable:false})]);
        await transaction.query("UPDATE connection_pairings SET status='connected' WHERE id=$1 AND user_id=$2",[pairing.pairingId,account.userId]);
      });

      const ids={account:randomUUID(),baselineSnapshot:randomUUID(),snapshot:randomUUID(),position:randomUUID(),run:randomUUID(),proposal:randomUUID(),notification:randomUUID(),riskEvent:randomUUID(),order:randomUUID()};
      await database.withTenant(account.userId,async(transaction)=>{
        const connection=(await transaction.query<{id:string}>("SELECT id::text FROM broker_connections WHERE user_id=$1 AND status='connected'",[account.userId])).rows[0]!.id;
        const version=(await transaction.query<{id:string}>("SELECT agent_version_id::text AS id FROM user_agents WHERE id=$1 AND user_id=$2",[userAgent.id,account.userId])).rows[0]!.id;
        await transaction.query(`INSERT INTO broker_accounts(id,connection_id,user_id,opaque_broker_id,masked_identifier,account_type,is_agentic_account,verified_for_trading_at,active) VALUES($1,$2,$3,$4,'Paper account •••• 1234','individual_agentic',true,$5,true)`,[ids.account,connection,account.userId,`opaque-${suffix}`,now]);
        await transaction.query(`INSERT INTO portfolio_snapshots(id,user_id,broker_account_id,environment,total_value,buying_power,cash_value,source_timestamp,valid_until,data_classification) VALUES($1,$2,$3,'paper',25400,8400,5400,$4,'2099-01-01T00:00:00.000Z','paper')`,[ids.baselineSnapshot,account.userId,ids.account,"2026-08-01T13:00:00.000Z"]);
        await transaction.query(`INSERT INTO portfolio_snapshots(id,user_id,broker_account_id,environment,total_value,buying_power,cash_value,source_timestamp,valid_until,data_classification) VALUES($1,$2,$3,'paper',25000,8000,5000,$4,'2099-01-01T00:00:00.000Z','paper')`,[ids.snapshot,account.userId,ids.account,now]);
        await transaction.query("UPDATE broker_connections SET last_sync_at=$2 WHERE id=$1 AND user_id=$3",[connection,now,account.userId]);
        await transaction.query(`INSERT INTO position_snapshots(id,portfolio_snapshot_id,user_id,broker_position_id,symbol,instrument_type,quantity,average_cost,market_value,unrealized_pnl,details) VALUES($1,$2,$3,$4,'AAPL','equity',10,190,2000,100,'{"source":"broker"}')`,[ids.position,ids.snapshot,account.userId,`position-${suffix}`]);
        await transaction.query(`INSERT INTO agent_runs(id,user_id,user_agent_id,status,idempotency_key,started_at,completed_at,strategy_version,structured_outcome) VALUES($1,$2,$3,'completed',$4,$5,$5,'foundation-equity-rules-1.0.0','{"outcome":"proposal_created"}')`,[ids.run,account.userId,userAgent.id,`run-${suffix}`,now]);
        const proposal={proposalId:ids.proposal,userId:account.userId,accountId:ids.account,agentDefinitionId:"30000000-0000-4000-8000-000000000001",agentVersion:"1.0.0",environment:"paper",instrumentType:"equity",symbol:"AAPL",optionLegs:[],side:"buy",quantity:1,notionalEstimate:200,orderType:"limit",limitPrice:200,timeInForce:"day",strategyType:"foundation_equity",entryReason:"Test deterministic entry",exitPlan:"Test deterministic exit",invalidationCondition:"Test invalidation",dataTimestamp:now,quoteTimestamp:now,maximumLoss:200,breakevens:[],estimatedPortfolioAllocationAfter:0.1,riskAmount:200,confidenceCategoryWithoutProbabilityClaims:"moderate",requiredApprovalMode:"confirm_every_trade",expirationTimestamp:"2026-08-01T14:05:00.000Z",evidenceReferences:[],warnings:[],deterministicStrategyVersion:"foundation-equity-rules-1.0.0",dataClassification:"broker_snapshot"};
        await transaction.query(`INSERT INTO trade_proposals(id,user_id,broker_account_id,agent_run_id,agent_version_id,environment,status,version,symbol,instrument_type,proposal,proposal_fingerprint,idempotency_key,expires_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'paper','AWAITING_USER_APPROVAL',1,'AAPL','equity',$6,$7,$8,$9,$10,$10)`,[ids.proposal,account.userId,ids.account,ids.run,version,proposal,"b".repeat(64),`proposal-${suffix}`,proposal.expirationTimestamp,now]);
        await transaction.query(`INSERT INTO notifications(id,user_id,notification_type,priority,title,private_body,status,idempotency_key,scheduled_at) VALUES($1,$2,'proposal_ready','normal','Paper proposal ready','Open Metis to review.','queued',$3,$4)`,[ids.notification,account.userId,`notification-${suffix}`,now]);
        await transaction.query(`INSERT INTO risk_events(id,user_id,broker_account_id,proposal_id,environment,event_type,severity,reason_code,structured_details,occurred_at) VALUES($1,$2,$3,$4,'paper','policy_check','info','WITHIN_LIMITS','{"source":"deterministic"}',$5)`,[ids.riskEvent,account.userId,ids.account,ids.proposal,now]);
      });

      const dashboard=await store.dashboard(account.userId);
      assert.equal(dashboard.dataClassification,"paper");
      assert.deepEqual(dashboard.portfolio,{value:25000,todayChange:-400,todayChangePercent:-400/25400,asOf:now,dataClassification:"paper"});
      assert.deepEqual(dashboard.risk,{dailyLossUsed:400,dailyLossLimit:450,allocationUsed:0.08,buyingPowerReserve:0.32});
      assert.equal((dashboard.agentStatus as{riskState:string}).riskState,"warning");
      assert.equal((await store.portfolio(account.userId)).dataClassification,"paper");
      assert.equal((await store.positions(account.userId))[0]?.dataClassification,"paper");
      assert.equal((await store.agentRuns(account.userId,userAgent.id)).length,1);
      assert.equal((await store.riskEvents(account.userId)).length,1);
      assert.equal((await store.notifications(account.userId)).length,1);
      const approvalVerification={verificationId:`verification-${suffix}`,userId:account.userId,sessionId:mobile.sessionId,deviceId:"surface-mobile-device",action:"approve_trade_proposal" as const,resourceId:ids.proposal,method:"app_attest" as const,authenticatedAt:"2026-08-01T14:00:10.000Z",expiresAt:"2026-08-01T14:04:10.000Z"};
      await store.consumeStepUpAuthentication(account.userId,approvalVerification,"2026-08-01T14:00:20.000Z");
      await assert.rejects(store.consumeStepUpAuthentication(account.userId,{...approvalVerification,action:"resume_all_user_agents",resourceId:account.userId},"2026-08-01T14:00:21.000Z"),hasCode("STEP_UP_PROOF_REPLAYED"));
      const approved=await store.approveProposal(account.userId,ids.proposal,approvalVerification,`approval-${suffix}`,"2026-08-01T14:00:20.000Z");
      assert.equal(approved.status,"APPROVED");
      const approvalDispatch=await database.withTenant(account.userId,async(transaction)=>{
        const result=await transaction.query<{queueName:string;jobType:string;payload:Readonly<Record<string,unknown>>;context:Readonly<Record<string,unknown>>}>(`SELECT q.queue_name AS "queueName",q.job_type AS "jobType",q.payload,a.authentication_context AS context FROM queue_jobs q JOIN approval_requests a ON a.proposal_id=(q.payload->>'proposalId')::uuid AND a.user_id=q.user_id WHERE q.user_id=$1 AND q.idempotency_key=$2`,[account.userId,`submit:${ids.proposal}`]);
        return result.rows[0];
      });
      assert.deepEqual(approvalDispatch,{queueName:"execution",jobType:"submit_approved",payload:{proposalId:ids.proposal,idempotencyKey:`submit:${ids.proposal}`,correlationId:`approval:verification-${suffix}`},context:{actorType:"user",authenticatedUserId:account.userId,authenticationContextId:mobile.sessionId,method:"app_attest",sessionId:mobile.sessionId,authenticatedAt:"2026-08-01T14:00:10.000Z",action:"approve_trade_proposal",resourceId:ids.proposal}});
      await database.withTenant(account.userId,async(transaction)=>{await transaction.query(`INSERT INTO orders(id,user_id,proposal_id,broker_account_id,broker_order_id,instrument_type,status,submission_idempotency_key,submitted_at) VALUES($1,$2,$3,$4,$5,'equity','pending',$6,$7)`,[ids.order,account.userId,ids.proposal,ids.account,`paper-order-${suffix}`,`submit-${suffix}`,now]);});
      const orders=await store.orders(account.userId);
      assert.equal(orders.length,1);
      assert.equal(orders[0]?.mode,"paper");
      assert.equal(orders[0]?.dataClassification,"paper");
      assert.equal(orders[0]?.status,"PENDING");
      assert.equal(orders[0]?.side,"buy");
      assert.equal(orders[0]?.quantity,1);
      assert.equal(orders[0]?.filledQuantity,0);
      assert.equal(orders[0]?.remainingQuantity,1);
      assert.equal(orders[0]?.averageFillPrice,null);
      assert.equal(orders[0]?.instrumentType,"equity");
      assert.equal(orders[0]?.orderType,"limit");
      assert.equal(orders[0]?.limitPrice,200);
      assert.equal(orders[0]?.timeInForce,"day");
      assert.equal(orders[0]?.submittedAt,now);
      assert.equal(orders[0]?.terminalAt,null);
      assert.equal(orders[0]?.reconciliationStatus,"not_scheduled");
      assert.deepEqual(orders[0]?.fills,[]);
      assert.deepEqual(orders[0]?.auditTimeline,[]);
      const canceledOrder=await store.cancelOrder(account.userId,ids.order,"2026-08-01T14:00:25.000Z");
      assert.equal(canceledOrder.status,"CANCELED");
      assert.equal(canceledOrder.remainingQuantity,1);
      assert.equal(canceledOrder.statusReason,"USER_CANCELED_PAPER_ORDER");
      assert.equal(canceledOrder.reconciliationStatus,"reconciled");
      assert.deepEqual(canceledOrder.auditTimeline,[{status:"CANCELED",occurredAt:"2026-08-01T14:00:25.000Z",reasonCode:"USER_CANCELED_PAPER_ORDER"}]);
      assert.equal((await store.proposal(account.userId,ids.proposal)).status,"CANCELED");
      const canceledDispatch=await database.withTenant(account.userId,async(transaction)=>(await transaction.query<{status:string;code:string|null}>("SELECT status,last_error_code AS code FROM queue_jobs WHERE user_id=$1 AND idempotency_key=$2",[account.userId,`submit:${ids.proposal}`])).rows[0]);
      assert.deepEqual(canceledDispatch,{status:"dead_letter",code:"USER_CANCELED_ORDER"});
      assert.equal((await store.activity(account.userId)).length,2);
      assert.equal((await store.readNotification(account.userId,ids.notification,"2026-08-01T14:00:30.000Z")).readAt,"2026-08-01T14:00:30.000Z");
      const tokenRow=await database.withTenant(account.userId,async(transaction)=>(await transaction.query<{token_envelope:Record<string,unknown>}>("SELECT token_envelope FROM device_tokens WHERE user_id=$1",[account.userId])).rows[0]);
      assert.equal(typeof tokenRow?.token_envelope.ciphertext,"string");
      assert.notEqual(tokenRow?.token_envelope.ciphertext,"ab".repeat(32));
      await sessions.revoke(mobile.sessionId,new Date("2026-08-01T14:00:40.000Z"),account.userId);
      const logoutRevocation=await database.withTenant(account.userId,async(transaction)=>(await transaction.query<{invalidated:boolean;revoked:boolean}>(`SELECT dt.invalidated_at IS NOT NULL AS invalidated,d.revoked_at IS NOT NULL AS revoked FROM device_tokens dt JOIN devices d ON d.id=dt.device_id AND d.user_id=dt.user_id WHERE dt.user_id=$1 AND dt.environment='sandbox'`,[account.userId])).rows[0]);
      assert.deepEqual(logoutRevocation,{invalidated:true,revoked:true});
      await assert.rejects(store.performance(account.userId),hasCode("PERFORMANCE_CALCULATION_UNAVAILABLE"));
      await store.syncVerifiedSubscription(account.userId,{...verifiedSubscription,transactionID:`expired-${suffix}`,signedPayloadDigest:"d".repeat(64),expiresAt:"2026-08-01T14:30:00.000Z",signedAt:"2026-08-01T15:00:00.000Z"});
      assert.equal((await store.subscription(account.userId)).status,"expired");
      assert.deepEqual(await store.entitledProductIds(account.userId),[]);
      await store.syncVerifiedSubscription(account.userId,verifiedSubscription);
      assert.equal((await store.subscription(account.userId)).status,"expired","an older signed transaction must not reactivate newer expired state");
      const subscriptionEvents=await database.withTenant(account.userId,async(transaction)=>(await transaction.query<{count:string}>("SELECT count(*)::text AS count FROM subscription_events WHERE subscription_id=(SELECT id FROM subscriptions WHERE user_id=$1 AND original_transaction_id=$2)",[account.userId,verifiedSubscription.originalTransactionID])).rows[0]?.count);
      assert.equal(subscriptionEvents,"2");
    }finally{await admin.end();await database.close();}
  });

  it("revokes every session, device, APNs token, broker binding, pairing, and queued sync when an account is closed",async()=>{
    const suffix=randomUUID();
    const database=new PostgresTenantDatabase(databaseUrl!);
    const store=new PostgresApiDataStore(database,{deviceBindingKey:sessionKey,deviceTokenEncryptionKey:tokenKey});
    const sessions=new PostgresSessionService(database,sessionKey);
    const pairings=new PostgresPairingService(database,new URL("https://connect.whox.test"),pairingPepper,10*60_000,approvedTestConnector);
    try{
      const closeInstant=new Date(Date.now()-10_000);
      const account=await store.userForAppleSubject(`paper-close-${suffix}`,`close-${suffix}@example.test`);
      const session=await sessions.create(account.userId,"closing-ios-device",closeInstant);
      await store.registerPushToken(account.userId,{token:"ef".repeat(32),environment:"sandbox",deviceId:"closing-ios-device"});
      const completedPairing=await pairings.create(account.userId,session.sessionId,closeInstant.toISOString());
      const completedAuthorization=await pairings.beginMobileAuthorization(account.userId,session.sessionId,completedPairing.pairingId,"https://api.whox.test/v1/brokers/robinhood/mobile-oauth/callback","metis://broker-connection/callback",new Date(closeInstant.getTime()+1).toISOString());
      await pairings.mobileCallbackSecrets(completedAuthorization.state,new Date(closeInstant.getTime()+2).toISOString());
      const danglingPairing=await pairings.create(account.userId,session.sessionId,new Date(closeInstant.getTime()+3).toISOString());
      const danglingAuthorization=await pairings.beginMobileAuthorization(account.userId,session.sessionId,danglingPairing.pairingId,"https://api.whox.test/v1/brokers/robinhood/mobile-oauth/callback","metis://broker-connection/callback",new Date(closeInstant.getTime()+4).toISOString());
      const credentialHandle=`vault:close-test:${suffix}`;
      const exchangeTransactionId=randomUUID();
      await pairings.beginMobileExchangeForSession(account.userId,session.sessionId,completedPairing.pairingId,completedAuthorization.state,exchangeTransactionId,new Date(closeInstant.getTime()+60_000).toISOString(),new Date(closeInstant.getTime()+5).toISOString());
      const completed=await pairings.completeMobileForSession(account.userId,session.sessionId,completedPairing.pairingId,completedAuthorization.state,exchangeTransactionId,new Date(closeInstant.getTime()+120_000).toISOString(),{identity:approvedTestConnector,credentialHandle,resourceUri:approvedTestConnector.resourceUri,connection:{status:"connected",capabilities:[],equityTradingAvailable:false,optionsTradingAvailable:false}},new Date(closeInstant.getTime()+6).toISOString());
      assert.equal(await pairings.acknowledgeAuthorizationConfirmation(account.userId,completed.authorizationSagaId,new Date(closeInstant.getTime()+7).toISOString()),"confirmed");
      await pairings.mobileCallbackSecrets(danglingAuthorization.state,new Date(closeInstant.getTime()+8).toISOString());
      const danglingExchangeTransactionId=randomUUID();
      await pairings.beginMobileExchangeForSession(account.userId,session.sessionId,danglingPairing.pairingId,danglingAuthorization.state,danglingExchangeTransactionId,new Date(closeInstant.getTime()+60_000).toISOString(),new Date(closeInstant.getTime()+9).toISOString());
      assert.equal((await store.closeAccount(account.userId)).deletionRequested,true);
      await assert.rejects(sessions.verify(session.accessToken,new Date(closeInstant.getTime()+1000)),hasCode("AUTH_EXPIRED"));
      await assert.rejects(pairings.mobileCallbackSecrets(danglingAuthorization.state,new Date(closeInstant.getTime()+1001).toISOString()),hasCode("PAIRING_SESSION_INVALID"));
      const lifecycle=await database.withTenant(account.userId,async(transaction)=>(await transaction.query<{sessionRevoked:boolean;deviceRevoked:boolean;tokenInvalidated:boolean;credentialCleared:boolean;connectionRevoked:boolean;pairingsCanceled:boolean;syncDeadLettered:boolean;revocationQueued:boolean;exchangeRevocationStaged:boolean;exchangeRevocationQueued:boolean}>(`SELECT s.revoked_at IS NOT NULL AS "sessionRevoked",d.revoked_at IS NOT NULL AS "deviceRevoked",dt.invalidated_at IS NOT NULL AS "tokenInvalidated",bc.credential_handle IS NULL AND bc.credential_bound_at IS NULL AND bc.credential_confirmed_at IS NULL AS "credentialCleared",bc.status='revoked' AS "connectionRevoked",NOT EXISTS(SELECT 1 FROM connection_pairings pairing WHERE pairing.user_id=s.user_id AND pairing.status IN ('pending','authorizing')) AS "pairingsCanceled",NOT EXISTS(SELECT 1 FROM queue_jobs job WHERE job.user_id=s.user_id AND job.queue_name='broker-sync' AND job.job_type NOT IN ('reconcile_broker_authorization','reconcile_broker_authorization_exchange') AND job.status IN ('queued','failed')) AS "syncDeadLettered",EXISTS(SELECT 1 FROM queue_jobs job WHERE job.user_id=s.user_id AND job.queue_name='broker-sync' AND job.job_type='reconcile_broker_authorization' AND job.status IN ('queued','failed')) AS "revocationQueued",EXISTS(SELECT 1 FROM broker_authorization_exchange_attempts attempt WHERE attempt.user_id=s.user_id AND attempt.exchange_transaction_id::text=$2 AND attempt.status='revoke_pending' AND attempt.last_error_code='ACCOUNT_CLOSED') AS "exchangeRevocationStaged",EXISTS(SELECT 1 FROM queue_jobs job WHERE job.user_id=s.user_id AND job.queue_name='broker-sync' AND job.job_type='reconcile_broker_authorization_exchange' AND job.payload->>'exchangeTransactionId'=$2 AND job.idempotency_key LIKE 'broker-auth-exchange-revoke:%' AND job.status IN ('queued','failed')) AS "exchangeRevocationQueued" FROM sessions s JOIN devices d ON d.id=s.device_id AND d.user_id=s.user_id JOIN device_tokens dt ON dt.device_id=d.id AND dt.user_id=d.user_id JOIN broker_connections bc ON bc.user_id=s.user_id AND bc.provider='robinhood_mcp' WHERE s.user_id=$1`,[account.userId,danglingExchangeTransactionId])).rows[0]);
      assert.deepEqual(lifecycle,{sessionRevoked:true,deviceRevoked:true,tokenInvalidated:true,credentialCleared:true,connectionRevoked:true,pairingsCanceled:true,syncDeadLettered:true,revocationQueued:true,exchangeRevocationStaged:true,exchangeRevocationQueued:true});
    }finally{await database.close();}
  });

  it("keeps PostgreSQL replacement blocked until the durable provider revocation is acknowledged",async()=>{
    const suffix=randomUUID();
    const database=new PostgresTenantDatabase(databaseUrl!);
    const store=new PostgresApiDataStore(database,{deviceBindingKey:sessionKey,deviceTokenEncryptionKey:tokenKey});
    const sessions=new PostgresSessionService(database,sessionKey);
    const pairings=new PostgresPairingService(database,new URL("https://connect.whox.test"),pairingPepper,10*60_000,approvedTestConnector);
    try{
      const authorizationInstant=new Date();
      const account=await store.userForAppleSubject(`paper-reconnect-${suffix}`,`reconnect-${suffix}@example.test`);
      const session=await sessions.create(account.userId,"reconnect-ios-device",authorizationInstant);
      const pairing=await pairings.create(account.userId,session.sessionId,authorizationInstant.toISOString());
      const authorization=await pairings.beginMobileAuthorization(account.userId,session.sessionId,pairing.pairingId,"https://api.whox.test/v1/brokers/robinhood/mobile-oauth/callback","metis://broker-connection/callback",new Date(authorizationInstant.getTime()+1).toISOString());
      await pairings.mobileCallbackSecrets(authorization.state,new Date(authorizationInstant.getTime()+2).toISOString());
      const exchangeTransactionId=randomUUID();
      await pairings.beginMobileExchangeForSession(account.userId,session.sessionId,pairing.pairingId,authorization.state,exchangeTransactionId,new Date(authorizationInstant.getTime()+60_000).toISOString(),new Date(authorizationInstant.getTime()+3).toISOString());
      const completed=await pairings.completeMobileForSession(account.userId,session.sessionId,pairing.pairingId,authorization.state,exchangeTransactionId,new Date(authorizationInstant.getTime()+120_000).toISOString(),{identity:approvedTestConnector,credentialHandle:`vault:reconnect-test:${suffix}`,resourceUri:approvedTestConnector.resourceUri,connection:{status:"connected",capabilities:[],equityTradingAvailable:false,optionsTradingAvailable:false}},new Date(authorizationInstant.getTime()+4).toISOString());
      assert.equal(await pairings.acknowledgeAuthorizationConfirmation(account.userId,completed.authorizationSagaId,new Date(authorizationInstant.getTime()+5).toISOString()),"confirmed");
      assert.deepEqual(await pairings.authorizationRevocationTarget(account.userId,new Date(authorizationInstant.getTime()+6).toISOString()),{kind:"saga",authorizationSagaId:completed.authorizationSagaId});
      assert.equal(await pairings.requestAuthorizationRevocation(account.userId,completed.authorizationSagaId,"USER_REQUESTED_DISCONNECT",new Date(authorizationInstant.getTime()+7).toISOString()),"revoke_pending");
      await assert.rejects(pairings.beginMobileAuthorization(account.userId,session.sessionId,(await pairings.create(account.userId,session.sessionId,new Date(authorizationInstant.getTime()+8).toISOString())).pairingId,"https://api.whox.test/v1/brokers/robinhood/mobile-oauth/callback","metis://broker-connection/callback",new Date(authorizationInstant.getTime()+9).toISOString()),hasCode("BROKER_CONNECTION_REPLACEMENT_REQUIRES_REVOCATION"));
      assert.equal(await pairings.acknowledgeAuthorizationRevocation(account.userId,completed.authorizationSagaId,new Date(authorizationInstant.getTime()+10).toISOString()),"revoked");
      assert.deepEqual(await pairings.authorizationRevocationTarget(account.userId,new Date(authorizationInstant.getTime()+11).toISOString()),{kind:"none"});
      const connection=await database.withTenant(account.userId,async(transaction)=>(await transaction.query<{status:string;credentialCleared:boolean}>("SELECT status,credential_handle IS NULL AND credential_bound_at IS NULL AND credential_confirmed_at IS NULL AS \"credentialCleared\" FROM broker_connections WHERE user_id=$1 AND provider='robinhood_mcp'",[account.userId])).rows[0]);
      assert.deepEqual(connection,{status:"revoked",credentialCleared:true});
      const replacement=await pairings.create(account.userId,session.sessionId,new Date(authorizationInstant.getTime()+12).toISOString());
      assert.equal((await pairings.beginMobileAuthorization(account.userId,session.sessionId,replacement.pairingId,"https://api.whox.test/v1/brokers/robinhood/mobile-oauth/callback","metis://broker-connection/callback",new Date(authorizationInstant.getTime()+13).toISOString())).resumed,false);
    }finally{await database.close();}
  });
});
