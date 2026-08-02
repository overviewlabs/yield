import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DomainError } from "@whox/contracts";
import { DeferJobError, InMemoryDurableJobQueue, type ProposalAggregate, type ProposalStore, type TransitionCommand } from "@whox/agent-orchestrator";
import { DEMO_EQUITY_PROPOSAL } from "@whox/test-fixtures";
import { executionMarketDataProviderId, handleExecutionPrerequisiteFailure } from "../src/execution-prerequisites.js";

const now="2026-08-01T14:01:00.000Z";
const proposal={...DEMO_EQUITY_PROPOSAL,environment:"paper" as const,dataTimestamp:now,quoteTimestamp:now,expirationTimestamp:"2026-08-01T14:05:00.000Z"};
const aggregate:ProposalAggregate=Object.freeze({proposal,status:"APPROVED",version:7,transitions:Object.freeze([]),createdAt:now,updatedAt:now});

function transitionStore(onTransition:(command:TransitionCommand)=>void=()=>{}):Pick<ProposalStore,"transition">{
  return {async transition(_proposalId,_version,command){onTransition(command);return Object.freeze({...aggregate,status:command.toStatus,version:aggregate.version+1});}};
}

describe("execution prerequisite recovery",()=>{
  it("enqueues one provider-bound quote refresh and durably defers a refreshable miss",async()=>{
    const clock=Date.parse(now);
    const queue=new InMemoryDurableJobQueue(()=>clock);
    const operation=handleExecutionPrerequisiteFailure({
      error:new DomainError("AUTHORITATIVE_MARKET_QUOTE_REQUIRED","missing",503,{refreshable:true,reason:"missing"}),
      queue,store:transitionStore(),aggregate,userId:proposal.userId,providerId:"approved-provider",
      correlationId:"execution-correlation",now
    });
    await assert.rejects(operation,(error:unknown)=>error instanceof DeferJobError&&error.availableAt==="2026-08-01T14:01:02.000Z");
    const job=await queue.claim<{symbols:string[];providerId:string;source:string;proposalId:string}>("market-data","test-worker",30_000);
    assert.ok(job);
    assert.equal(job.userId,proposal.userId);
    assert.equal(job.jobType,"refresh_quotes");
    assert.deepEqual(job.payload,{symbols:["AAPL"],providerId:"approved-provider",source:"execution-worker",proposalId:proposal.proposalId});
  });

  it("expires an immutable stale approved proposal without retrying",async()=>{
    const queue=new InMemoryDurableJobQueue(()=>Date.parse(now));
    let transition:TransitionCommand|undefined;
    const outcome=await handleExecutionPrerequisiteFailure({
      error:new DomainError("PROPOSAL_REAPPROVAL_REQUIRED","stale",409,{nonRetryable:true}),
      queue,store:transitionStore((command)=>{transition=command;}),aggregate,userId:proposal.userId,
      providerId:"approved-provider",correlationId:"execution-correlation",now
    });
    assert.equal(outcome,"expired");
    assert.equal(transition?.toStatus,"EXPIRED");
    assert.equal(transition?.reasonCode,"PROPOSAL_DATA_STALE_REAPPROVAL_REQUIRED");
    assert.equal(await queue.claim("market-data","test-worker",30_000),undefined);
  });

  it("preserves malformed and binding failures without enqueuing work",async()=>{
    const queue=new InMemoryDurableJobQueue(()=>Date.parse(now));
    const malformed=new DomainError("AUTHORITATIVE_MARKET_QUOTE_INVALID","malformed",503);
    await assert.rejects(handleExecutionPrerequisiteFailure({error:malformed,queue,store:transitionStore(),aggregate,userId:proposal.userId,providerId:"approved-provider",correlationId:"execution-correlation",now}),(error:unknown)=>error===malformed);
    assert.equal(await queue.claim("market-data","test-worker",30_000),undefined);
  });

  it("requires MARKET_DATA_PROVIDER_ID to be in the approved allowlist",()=>{
    assert.equal(executionMarketDataProviderId("paper",["approved-provider"],{MARKET_DATA_PROVIDER_ID:"approved-provider"}),"approved-provider");
    assert.throws(()=>executionMarketDataProviderId("paper",["approved-provider"],{MARKET_DATA_PROVIDER_ID:"other-provider"}),(error:unknown)=>typeof error==="object"&&error!==null&&"code" in error&&error.code==="MARKET_DATA_PROVIDER_BINDING_INVALID");
  });
});
