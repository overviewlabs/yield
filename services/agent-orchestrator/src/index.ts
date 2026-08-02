import { randomUUID } from "node:crypto";
import {
  DomainError,
  TERMINAL_PROPOSAL_STATUSES,
  validateTradeProposal,
  type ProposalStatus,
  type ProposalTransition,
  type TradeProposal
} from "@whox/contracts";

export * from "./durable-queue.js";
export * from "./worker-runtime.js";
export * from "./coordination.js";
export * from "./hermes-research.js";
export * from "./persistent-pipeline.js";
export * from "./paper-scheduler.js";
export * from "./plan-cycle.js";
export * from "./plan-research.js";
export * from "./plan-research-service.js";

export function assertAgentPipelineConfigured(
  mode: "demo" | "paper" | "live",
  persistentPipelineConfigured = false
): void {
  if (mode === "live" || (mode === "paper" && !persistentPipelineConfigured)) {
    throw new DomainError(
      "AGENT_PIPELINE_UNCONFIGURED",
      "The persistent strategy, proposal, and approval pipeline is not configured",
      503
    );
  }
}

export interface ProposalAggregate {
  readonly proposal: TradeProposal;
  readonly status: ProposalStatus;
  readonly version: number;
  readonly transitions: readonly ProposalTransition[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

const stateSet=(...values:ProposalStatus[]):ReadonlySet<ProposalStatus>=>new Set(values);
const actorSet=(...values:ProposalTransition["actorType"][]):ReadonlySet<ProposalTransition["actorType"]>=>new Set(values);

export const ALLOWED_PROPOSAL_TRANSITIONS: Readonly<Record<ProposalStatus, ReadonlySet<ProposalStatus>>> = Object.freeze({
  DRAFT: stateSet("ANALYZED", "CANCELED", "EXPIRED"),
  ANALYZED: stateSet("SCHEMA_VALIDATED", "REJECTED", "EXPIRED"),
  SCHEMA_VALIDATED: stateSet("RISK_CHECKED", "RISK_REJECTED", "EXPIRED"),
  RISK_CHECKED: stateSet("BROKER_REVIEWED", "BROKER_REJECTED", "EXPIRED"),
  RISK_REJECTED: stateSet(),
  BROKER_REVIEWED: stateSet("AWAITING_USER_APPROVAL", "APPROVED", "BROKER_REJECTED", "EXPIRED"),
  BROKER_REJECTED: stateSet(),
  AWAITING_USER_APPROVAL: stateSet("APPROVED", "USER_REJECTED", "EXPIRED", "CANCELED"),
  USER_REJECTED: stateSet(),
  APPROVED: stateSet("SUBMITTING", "CANCELED", "EXPIRED"),
  SUBMITTING: stateSet("SUBMITTED", "REJECTED", "RECONCILIATION_ERROR"),
  SUBMITTED: stateSet("PARTIALLY_FILLED", "FILLED", "CANCELED", "REJECTED", "RECONCILIATION_ERROR"),
  PARTIALLY_FILLED: stateSet("PARTIALLY_FILLED", "FILLED", "CANCELED", "REJECTED", "RECONCILIATION_ERROR"),
  FILLED: stateSet(), CANCELED: stateSet(), REJECTED: stateSet(), EXPIRED: stateSet(),
  RECONCILIATION_ERROR: stateSet("SUBMITTING", "SUBMITTED", "PARTIALLY_FILLED", "FILLED", "CANCELED", "REJECTED")
});

const actorAuthorization: Readonly<Record<ProposalStatus, ReadonlySet<ProposalTransition["actorType"]>>> = Object.freeze({
  DRAFT:actorSet(), ANALYZED:actorSet("system","worker"), SCHEMA_VALIDATED:actorSet("system","worker"),
  RISK_CHECKED:actorSet("worker"), RISK_REJECTED:actorSet("worker"), BROKER_REVIEWED:actorSet("worker","broker"),
  BROKER_REJECTED:actorSet("worker","broker"), AWAITING_USER_APPROVAL:actorSet("worker"), USER_REJECTED:actorSet("user"),
  APPROVED:actorSet("user","worker"), SUBMITTING:actorSet("worker"), SUBMITTED:actorSet("worker","broker"),
  PARTIALLY_FILLED:actorSet("worker","broker"), FILLED:actorSet("worker","broker"), CANCELED:actorSet("user","worker","broker","operator"),
  REJECTED:actorSet("worker","broker"), EXPIRED:actorSet("system","worker"), RECONCILIATION_ERROR:actorSet("worker")
});

export interface TransitionCommand {
  readonly toStatus: ProposalStatus;
  readonly actorType: ProposalTransition["actorType"];
  readonly actorId: string;
  readonly reasonCode: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly occurredAt: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
  /** Non-secret evidence from the API's authenticated user session. */
  readonly userAuthentication?: {
    readonly authenticatedUserId: string;
    readonly authenticationContextId: string;
    readonly authenticatedAt: string;
  };
  /** Evidence that the trusted orchestrator evaluated the autonomous gate. */
  readonly automaticAuthorization?: {
    readonly source: "server-release-gates";
    readonly autonomousModeEnabled: true;
    readonly authorizedAt: string;
  };
}

export function createProposalAggregate(value: unknown, now = new Date().toISOString()): ProposalAggregate {
  const proposal = validateTradeProposal(value);
  return Object.freeze({proposal, status:"DRAFT", version:0, transitions:Object.freeze([]), createdAt:now, updatedAt:now});
}

export function transitionProposal(aggregate: ProposalAggregate, command: TransitionCommand): ProposalAggregate {
  if (TERMINAL_PROPOSAL_STATUSES.has(aggregate.status)) {
    throw new DomainError("PROPOSAL_TERMINAL", `Proposal is terminal in ${aggregate.status}`, 409);
  }
  if (!ALLOWED_PROPOSAL_TRANSITIONS[aggregate.status].has(command.toStatus)) {
    throw new DomainError("PROPOSAL_TRANSITION_INVALID", `${aggregate.status} cannot transition to ${command.toStatus}`, 409);
  }
  if (!actorAuthorization[command.toStatus].has(command.actorType)) {
    throw new DomainError("PROPOSAL_ACTOR_UNAUTHORIZED", `${command.actorType} cannot transition to ${command.toStatus}`, 403);
  }
  const occurred = Date.parse(command.occurredAt);
  if (!Number.isFinite(occurred) || occurred < Date.parse(aggregate.updatedAt)) {
    throw new DomainError("PROPOSAL_EVENT_TIME_INVALID", "Transition time must be valid and monotonic", 409);
  }
  const reconciliationState = ["SUBMITTING", "SUBMITTED", "PARTIALLY_FILLED", "RECONCILIATION_ERROR"].includes(aggregate.status);
  if (Date.parse(aggregate.proposal.expirationTimestamp) <= occurred && command.toStatus !== "EXPIRED" && !reconciliationState) {
    throw new DomainError("PROPOSAL_EXPIRED", "Expired proposal can only transition to EXPIRED", 409);
  }
  assertApprovalAuthorization(aggregate, command, occurred);
  const approvalMetadata: Readonly<Record<string, string | number | boolean | null>> =
    command.toStatus === "APPROVED" && command.userAuthentication !== undefined
      ? {
          approvalActorAuthenticated: true,
          authenticationContextId: command.userAuthentication.authenticationContextId
        }
      : command.toStatus === "APPROVED" && command.automaticAuthorization !== undefined
        ? {
            automaticModeAuthorized: true,
            authorizationSource: command.automaticAuthorization.source
          }
        : {};
  const event: ProposalTransition = Object.freeze({
    proposalId:aggregate.proposal.proposalId, fromStatus:aggregate.status, toStatus:command.toStatus,
    actorType:command.actorType, actorId:command.actorId, reasonCode:command.reasonCode,
    correlationId:command.correlationId, idempotencyKey:command.idempotencyKey, occurredAt:command.occurredAt,
    metadata:Object.freeze({...command.metadata,...approvalMetadata})
  });
  return Object.freeze({...aggregate,status:command.toStatus,version:aggregate.version+1,
    transitions:Object.freeze([...aggregate.transitions,event]),updatedAt:command.occurredAt});
}

function assertApprovalAuthorization(
  aggregate: ProposalAggregate,
  command: TransitionCommand,
  occurredAt: number
): void {
  if (command.toStatus !== "APPROVED") return;
  const mode = aggregate.proposal.requiredApprovalMode;
  if (mode === "observe") {
    throw new DomainError("OBSERVE_MODE_EXECUTION_FORBIDDEN", "Observe-mode proposals can never be approved for execution", 403);
  }
  if (mode === "confirm_every_trade") {
    const authentication = command.userAuthentication;
    const authenticatedAt = Date.parse(authentication?.authenticatedAt ?? "");
    const authenticated =
      aggregate.status === "AWAITING_USER_APPROVAL" &&
      command.actorType === "user" &&
      command.actorId === aggregate.proposal.userId &&
      authentication?.authenticatedUserId === aggregate.proposal.userId &&
      authentication.authenticationContextId.trim() !== "" &&
      Number.isFinite(authenticatedAt) &&
      authenticatedAt <= occurredAt;
    if (!authenticated) {
      throw new DomainError(
        "USER_APPROVAL_AUTHENTICATION_REQUIRED",
        "Confirm-every-trade approval requires the authenticated proposal owner",
        403
      );
    }
    return;
  }
  const authorization = command.automaticAuthorization;
  const authorizedAt = Date.parse(authorization?.authorizedAt ?? "");
  const authorized =
    aggregate.status === "BROKER_REVIEWED" &&
    command.actorType === "worker" &&
    command.actorId === "agent-orchestrator" &&
    authorization?.source === "server-release-gates" &&
    authorization.autonomousModeEnabled === true &&
    Number.isFinite(authorizedAt) &&
    authorizedAt <= occurredAt;
  if (!authorized) {
    throw new DomainError(
      "AUTOMATIC_APPROVAL_NOT_AUTHORIZED",
      "Automatic approval requires the trusted server-side autonomous gate",
      403
    );
  }
}

export interface ProposalStore {
  create(proposal: unknown, idempotencyKey: string, now?: string): Promise<ProposalAggregate>;
  get(proposalId: string): Promise<ProposalAggregate | undefined>;
  transition(proposalId: string, expectedVersion: number, command: TransitionCommand): Promise<ProposalAggregate>;
}

export class InMemoryProposalStore implements ProposalStore {
  readonly #proposals = new Map<string, ProposalAggregate>();
  readonly #creationKeys = new Map<string, string>();
  readonly #transitionKeys = new Map<string, {readonly aggregate:ProposalAggregate;readonly fingerprint:string}>();
  readonly #locks = new Map<string, Promise<void>>();

  async #exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued=previous.then(() => current);this.#locks.set(key, queued);
    await previous;
    try { return await operation(); }
    finally { release(); if (this.#locks.get(key) === queued) this.#locks.delete(key); }
  }

  public async create(proposal: unknown, idempotencyKey: string, now?: string): Promise<ProposalAggregate> {
    if (idempotencyKey.length < 8) throw new DomainError("IDEMPOTENCY_KEY_INVALID", "Idempotency key is required", 400);
    return this.#exclusive(`create:${idempotencyKey}`, async () => {
      const priorId = this.#creationKeys.get(idempotencyKey);
      if (priorId !== undefined) {
        const validated=validateTradeProposal(proposal);const prior=this.#proposals.get(priorId)!;
        if(stableValue(validated)!==stableValue(prior.proposal))throw new DomainError("IDEMPOTENCY_KEY_REUSED","Idempotency key was already used with a different proposal",409);
        return prior;
      }
      const aggregate = createProposalAggregate(proposal, now);
      if (this.#proposals.has(aggregate.proposal.proposalId)) throw new DomainError("PROPOSAL_EXISTS", "Proposal ID already exists", 409);
      this.#proposals.set(aggregate.proposal.proposalId, aggregate);
      this.#creationKeys.set(idempotencyKey, aggregate.proposal.proposalId);
      return aggregate;
    });
  }

  public async get(proposalId: string): Promise<ProposalAggregate | undefined> { return this.#proposals.get(proposalId); }

  public async transition(proposalId: string, expectedVersion: number, command: TransitionCommand): Promise<ProposalAggregate> {
    return this.#exclusive(`proposal:${proposalId}`, async () => {
      const idempotencyScope = `${proposalId}:${command.idempotencyKey}`;
      const prior = this.#transitionKeys.get(idempotencyScope);
      const commandFingerprint=stableValue(command);
      if (prior !== undefined) {if(prior.fingerprint!==commandFingerprint)throw new DomainError("IDEMPOTENCY_KEY_REUSED","Idempotency key was already used with a different transition",409);return prior.aggregate;}
      const aggregate = this.#proposals.get(proposalId);
      if (aggregate === undefined) throw new DomainError("PROPOSAL_NOT_FOUND", "Proposal was not found", 404);
      if (aggregate.version !== expectedVersion) throw new DomainError("PROPOSAL_VERSION_CONFLICT", "Proposal changed concurrently", 409);
      const next = transitionProposal(aggregate, command);
      this.#proposals.set(proposalId, next);
      this.#transitionKeys.set(idempotencyScope, {aggregate:next,fingerprint:commandFingerprint});
      return next;
    });
  }
}

export interface CapitalReservation {
  readonly reservationId: string;
  readonly accountId: string;
  readonly proposalId: string;
  readonly agentId: string;
  readonly symbol: string;
  readonly side: "buy" | "sell";
  readonly amount: number;
  readonly expiresAt: string;
}

export class CapitalReservationBook {
  readonly #reservations = new Map<string, CapitalReservation>();
  readonly #idempotency = new Map<string, {readonly reservationId:string;readonly fingerprint:string;released:boolean}>();

  public reserve(input: Omit<CapitalReservation,"reservationId">, idempotencyKey: string, availableAmount: number, now: string): CapitalReservation {
    const fingerprint=stableValue(input);const prior = this.#idempotency.get(idempotencyKey);
    if (prior !== undefined) {if(prior.fingerprint!==fingerprint)throw new DomainError("IDEMPOTENCY_KEY_REUSED","Idempotency key was already used with a different reservation",409);if(prior.released)throw new DomainError("IDEMPOTENCY_KEY_RETIRED","Released reservation idempotency key cannot be replayed",409);return this.#reservations.get(prior.reservationId)!;}
    this.releaseExpired(now);
    const active = [...this.#reservations.values()].filter((item) => item.accountId === input.accountId);
    const conflicting = active.find((item) => item.symbol === input.symbol && item.side !== input.side && item.agentId !== input.agentId);
    if (conflicting !== undefined) throw new DomainError("AGENT_ORDER_CONFLICT", "Another agent has reserved an opposing order", 409);
    const reserved = active.reduce((sum,item) => sum + item.amount,0);
    if (input.amount <= 0 || reserved + input.amount > availableAmount) throw new DomainError("CAPITAL_RESERVATION_INSUFFICIENT", "Insufficient unreserved capital", 409);
    const reservation = Object.freeze({...input,reservationId:randomUUID()});
    this.#reservations.set(reservation.reservationId,reservation);
    this.#idempotency.set(idempotencyKey,{reservationId:reservation.reservationId,fingerprint,released:false});
    return reservation;
  }

  public release(reservationId: string): boolean { const deleted=this.#reservations.delete(reservationId);if(deleted)for(const entry of this.#idempotency.values())if(entry.reservationId===reservationId)entry.released=true;return deleted; }
  public releaseExpired(now: string): number {
    const instant = Date.parse(now); let released = 0;
    for (const [id,reservation] of this.#reservations) if (Date.parse(reservation.expiresAt) <= instant) {this.release(id);released += 1;}
    return released;
  }
  public list(accountId: string): readonly CapitalReservation[] { return Object.freeze([...this.#reservations.values()].filter((item)=>item.accountId===accountId)); }
}

function stableValue(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(stableValue).join(",")}]`;
  if(value!==null&&typeof value==="object")return `{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${stableValue(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

export interface AgentRunRecord {
  readonly runId: string; readonly userAgentId: string; readonly idempotencyKey: string;
  readonly status: "started"|"completed"|"failed"; readonly startedAt: string; readonly completedAt?: string;
}

export class AgentRunRegistry {
  readonly #runs = new Map<string, AgentRunRecord>();
  public start(userAgentId:string,idempotencyKey:string,startedAt:string):AgentRunRecord {
    const scope=`${userAgentId}:${idempotencyKey}`; const prior=this.#runs.get(scope); if(prior!==undefined)return prior;
    const run=Object.freeze({runId:randomUUID(),userAgentId,idempotencyKey,status:"started" as const,startedAt}); this.#runs.set(scope,run); return run;
  }
}
