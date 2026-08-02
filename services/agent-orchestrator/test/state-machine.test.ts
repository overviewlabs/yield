import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProposalStatus, ProposalTransition, TradeProposal } from "@whox/contracts";
import { DEMO_EQUITY_PROPOSAL } from "@whox/test-fixtures";
import { CapitalReservationBook, createProposalAggregate, InMemoryProposalStore, transitionProposal, type ProposalAggregate, type TransitionCommand } from "../src/index.js";

const command = (toStatus:"ANALYZED"|"SCHEMA_VALIDATED", key:string, at="2026-08-01T14:00:01.000Z") => ({
  toStatus, actorType:"worker" as const, actorId:"orchestrator", reasonCode:"TEST", correlationId:"correlation-1",
  idempotencyKey:key, occurredAt:at
});

function advance(
  aggregate: ProposalAggregate,
  toStatus: ProposalStatus,
  actorType: ProposalTransition["actorType"],
  key: string,
  additions: Partial<TransitionCommand> = {}
): ProposalAggregate {
  return transitionProposal(aggregate, {
    toStatus,
    actorType,
    actorId: actorType === "user" ? aggregate.proposal.userId : "test-worker",
    reasonCode: "TEST",
    correlationId: "correlation-approval",
    idempotencyKey: key,
    occurredAt: "2026-08-01T14:00:01.000Z",
    ...additions
  });
}

function brokerReviewed(proposal: TradeProposal): ProposalAggregate {
  let aggregate=createProposalAggregate(proposal,"2026-08-01T14:00:00.000Z");
  aggregate=advance(aggregate,"ANALYZED","worker","approval-analyzed");
  aggregate=advance(aggregate,"SCHEMA_VALIDATED","worker","approval-schema");
  aggregate=advance(aggregate,"RISK_CHECKED","worker","approval-risk");
  return advance(aggregate,"BROKER_REVIEWED","broker","approval-broker");
}

describe("immutable proposal state machine", () => {
  it("creates a frozen draft and returns a new aggregate", () => {
    const draft=createProposalAggregate(DEMO_EQUITY_PROPOSAL,"2026-08-01T14:00:00.000Z");
    const analyzed=transitionProposal(draft,command("ANALYZED","transition-1"));
    assert.equal(draft.status,"DRAFT"); assert.equal(analyzed.status,"ANALYZED"); assert.notEqual(draft,analyzed); assert.ok(Object.isFrozen(analyzed));
  });
  it("rejects skipped transitions", () => {
    const draft=createProposalAggregate(DEMO_EQUITY_PROPOSAL,"2026-08-01T14:00:00.000Z");
    assert.throws(()=>transitionProposal(draft,command("SCHEMA_VALIDATED","skip-1")),/cannot transition/);
  });
  it("deduplicates creation and transitions", async () => {
    const store=new InMemoryProposalStore();
    const first=await store.create(DEMO_EQUITY_PROPOSAL,"create-key-1","2026-08-01T14:00:00.000Z");
    assert.equal(await store.create(DEMO_EQUITY_PROPOSAL,"create-key-1"),first);
    const analyzed=await store.transition(first.proposal.proposalId,0,command("ANALYZED","event-key-1"));
    assert.equal(await store.transition(first.proposal.proposalId,0,command("ANALYZED","event-key-1")),analyzed);
  });
  it("rejects idempotency-key reuse with different payloads", async () => {
    const store=new InMemoryProposalStore();await store.create(DEMO_EQUITY_PROPOSAL,"create-reuse","2026-08-01T14:00:00.000Z");
    await assert.rejects(store.create({...DEMO_EQUITY_PROPOSAL,symbol:"MSFT"},"create-reuse"),/different proposal/);
  });
  it("expires instead of advancing after proposal expiry", () => {
    const draft=createProposalAggregate(DEMO_EQUITY_PROPOSAL,"2026-08-01T14:00:00.000Z");
    assert.throws(()=>transitionProposal(draft,command("ANALYZED","late","2026-08-01T14:06:00.000Z")),/Expired proposal/);
  });
  it("requires the authenticated owner for confirm-every-trade approval", () => {
    const reviewed=brokerReviewed(DEMO_EQUITY_PROPOSAL);
    const awaiting=advance(reviewed,"AWAITING_USER_APPROVAL","worker","approval-awaiting");
    const forged={userAuthentication:{authenticatedUserId:DEMO_EQUITY_PROPOSAL.userId,authenticationContextId:"auth-context-1",authenticatedAt:"2026-08-01T14:00:00.000Z"}} as const;
    assert.throws(()=>advance(awaiting,"APPROVED","worker","approval-forged-worker",forged),/authenticated proposal owner/);
    assert.throws(()=>advance(awaiting,"APPROVED","user","approval-missing-auth"),/authenticated proposal owner/);
    const approved=advance(awaiting,"APPROVED","user","approval-authenticated",forged);
    assert.equal(approved.status,"APPROVED");
    assert.equal(approved.transitions.at(-1)?.metadata.approvalActorAuthenticated,true);
  });
  it("never approves Observe mode", () => {
    const proposal={...DEMO_EQUITY_PROPOSAL,requiredApprovalMode:"observe" as const};
    const reviewed=brokerReviewed(proposal);
    assert.throws(()=>advance(reviewed,"APPROVED","worker","observe-forged",{automaticAuthorization:{source:"server-release-gates",autonomousModeEnabled:true,authorizedAt:"2026-08-01T14:00:00.000Z"}}),/Observe-mode/);
  });
  it("gates automatic worker approval with server authorization", () => {
    const proposal={...DEMO_EQUITY_PROPOSAL,requiredApprovalMode:"automatic_within_limits" as const};
    const reviewed=brokerReviewed(proposal);
    assert.throws(()=>advance(reviewed,"APPROVED","worker","automatic-ungated"),/autonomous gate/);
    const approved=advance(reviewed,"APPROVED","worker","automatic-gated",{actorId:"agent-orchestrator",automaticAuthorization:{source:"server-release-gates",autonomousModeEnabled:true,authorizedAt:"2026-08-01T14:00:00.000Z"}});
    assert.equal(approved.status,"APPROVED");
    assert.equal(approved.transitions.at(-1)?.metadata.automaticModeAuthorized,true);
  });
});

describe("capital reservations", () => {
  it("prevents opposing agents from reserving the same symbol", () => {
    const book=new CapitalReservationBook();
    book.reserve({accountId:"account",proposalId:"p1",agentId:"a1",symbol:"AAPL",side:"buy",amount:100,expiresAt:"2026-08-01T14:10:00Z"},"reserve-1",500,"2026-08-01T14:00:00Z");
    assert.throws(()=>book.reserve({accountId:"account",proposalId:"p2",agentId:"a2",symbol:"AAPL",side:"sell",amount:100,expiresAt:"2026-08-01T14:10:00Z"},"reserve-2",500,"2026-08-01T14:00:00Z"),/opposing order/);
  });
  it("deduplicates reservation attempts", () => {
    const book=new CapitalReservationBook(); const input={accountId:"account",proposalId:"p1",agentId:"a1",symbol:"AAPL",side:"buy" as const,amount:100,expiresAt:"2026-08-01T14:10:00Z"};
    assert.equal(book.reserve(input,"reserve-key",500,"2026-08-01T14:00:00Z"),book.reserve(input,"reserve-key",500,"2026-08-01T14:00:00Z"));
  });
  it("never returns an undefined reservation after release and replay", () => {
    const book=new CapitalReservationBook();const input={accountId:"account",proposalId:"p1",agentId:"a1",symbol:"AAPL",side:"buy" as const,amount:100,expiresAt:"2026-08-01T14:10:00Z"};
    const reservation=book.reserve(input,"release-key",500,"2026-08-01T14:00:00Z");assert.equal(book.release(reservation.reservationId),true);
    assert.throws(()=>book.reserve(input,"release-key",500,"2026-08-01T14:00:00Z"),/cannot be replayed/);
  });
  it("rejects reservation key reuse with a different payload", () => {
    const book=new CapitalReservationBook();const input={accountId:"account",proposalId:"p1",agentId:"a1",symbol:"AAPL",side:"buy" as const,amount:100,expiresAt:"2026-08-01T14:10:00Z"};
    book.reserve(input,"payload-key",500,"2026-08-01T14:00:00Z");assert.throws(()=>book.reserve({...input,amount:101},"payload-key",500,"2026-08-01T14:00:00Z"),/different reservation/);
  });
});
