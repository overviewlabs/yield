import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";
import { DomainError } from "@whox/contracts";
import { AppleIdentityTokenVerifier } from "../src/apple-identity.js";

const encode=(value:unknown):string=>Buffer.from(JSON.stringify(value)).toString("base64url");

describe("official Apple identity verification",()=>{
  it("verifies a SHA-256-bound raw nonce and rejects missing, mismatched, and replayed assertions",async()=>{
    const {privateKey,publicKey}=generateKeyPairSync("rsa",{modulusLength:2048});
    const jwk={...publicKey.export({format:"jwk"}),kid:"test-apple-key",alg:"RS256",use:"sig"};
    const now=new Date("2026-08-01T14:00:00.000Z");
    const header=encode({alg:"RS256",kid:jwk.kid,typ:"JWT"});
    const rawNonce="raw-client-nonce-0123456789abcdef";
    const payload=encode({iss:"https://appleid.apple.com",aud:"ai.whox.yield",sub:"apple-production-subject",iat:Math.floor(now.getTime()/1000)-10,exp:Math.floor(now.getTime()/1000)+300,nonce:createHash("sha256").update(rawNonce).digest("hex"),email:"relay@example.test",email_verified:"true"});
    const input=`${header}.${payload}`;
    const token=`${input}.${sign("RSA-SHA256",Buffer.from(input),privateKey).toString("base64url")}`;
    const verifier=new AppleIdentityTokenVerifier({clientId:"ai.whox.yield",fetcher:async()=>new Response(JSON.stringify({keys:[jwk]}),{status:200,headers:{"content-type":"application/json"}})});
    await assert.rejects(verifier.verify(token,{now}),(error:unknown)=>error instanceof DomainError&&error.code==="APPLE_NONCE_REQUIRED");
    await assert.rejects(verifier.verify(token,{nonce:"different-raw-nonce-0123456789",now}),(error:unknown)=>error instanceof DomainError&&error.code==="APPLE_IDENTITY_INVALID");
    const identity=await verifier.verify(token,{nonce:rawNonce,now});
    assert.equal(identity.appleSubject,"apple-production-subject");
    assert.equal(identity.emailVerified,true);
    assert.equal(identity.assertionDigest,createHash("sha256").update(token).digest("hex"));
    assert.equal(identity.assertionExpiresAt,"2026-08-01T14:05:00.000Z");
    await assert.rejects(verifier.verify(token,{nonce:rawNonce,now}),(error:unknown)=>error instanceof DomainError&&error.code==="APPLE_IDENTITY_REPLAYED");
  });
});
