import { DomainError } from "@whox/contracts";
import { DeferJobError, type DurableJobQueue, type ProposalAggregate, type ProposalStore } from "@whox/agent-orchestrator";

const PROVIDER_PATTERN=/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
const REFRESH_DEFER_MILLISECONDS=2_000;
const REFRESH_BUCKET_MILLISECONDS=5_000;

export function executionMarketDataProviderId(
  mode:"demo"|"paper"|"live",
  approvedProviders:readonly string[],
  environment:NodeJS.ProcessEnv=process.env
):string{
  if(mode==="demo")return "whox-demo-fixture";
  const providerId=environment.MARKET_DATA_PROVIDER_ID?.trim()??"";
  if(!PROVIDER_PATTERN.test(providerId)||!approvedProviders.includes(providerId))throw new DomainError(
    "MARKET_DATA_PROVIDER_BINDING_INVALID",
    "MARKET_DATA_PROVIDER_ID must name one explicitly approved market-data provider",
    500
  );
  return providerId;
}

export interface ExecutionPrerequisiteFailureInput {
  readonly error:unknown;
  readonly queue:DurableJobQueue;
  readonly store:Pick<ProposalStore,"transition">;
  readonly aggregate:ProposalAggregate;
  readonly userId:string;
  readonly providerId:string;
  readonly correlationId:string;
  readonly now:string;
}

/**
 * Handles only the two safe prerequisite outcomes: expire an immutable stale
 * proposal, or request a new provider-bound quote and durably defer the same
 * execution job. Every malformed/binding/halt failure is rethrown untouched.
 */
export async function handleExecutionPrerequisiteFailure(input:ExecutionPrerequisiteFailureInput):Promise<"expired">{
  const {error,aggregate}=input;
  if(error instanceof DomainError&&error.code==="PROPOSAL_REAPPROVAL_REQUIRED"){
    if(aggregate.status!=="APPROVED")throw error;
    await expireForReapproval(input);
    return "expired";
  }
  if(!(error instanceof DomainError)||error.details?.refreshable!==true)throw error;
  const nowInstant=Date.parse(input.now);
  const proposalExpiry=Date.parse(aggregate.proposal.expirationTimestamp);
  if(!Number.isFinite(nowInstant)||!Number.isFinite(proposalExpiry))throw new DomainError("EXECUTION_TIME_INVALID","Execution prerequisite timestamps are invalid",422);
  const availableAt=nowInstant+REFRESH_DEFER_MILLISECONDS;
  if(aggregate.status==="APPROVED"&&availableAt>=proposalExpiry){
    await expireForReapproval(input);
    return "expired";
  }
  const bucket=Math.floor(nowInstant/REFRESH_BUCKET_MILLISECONDS);
  await input.queue.enqueue({
    queueName:"market-data",
    userId:input.userId,
    jobType:"refresh_quotes",
    payload:{
      symbols:[aggregate.proposal.symbol],
      providerId:input.providerId,
      source:"execution-worker",
      proposalId:aggregate.proposal.proposalId
    },
    idempotencyKey:`execution-quote-refresh:${aggregate.proposal.proposalId}:${input.providerId}:${bucket}`,
    priority:10,
    maxAttempts:3
  });
  throw new DeferJobError(new Date(availableAt).toISOString());
}

async function expireForReapproval(input:ExecutionPrerequisiteFailureInput):Promise<void>{
  const proposal=input.aggregate.proposal;
  await input.store.transition(proposal.proposalId,input.aggregate.version,{
    toStatus:"EXPIRED",
    actorType:"worker",
    actorId:"execution-worker",
    reasonCode:"PROPOSAL_DATA_STALE_REAPPROVAL_REQUIRED",
    correlationId:input.correlationId,
    idempotencyKey:`${proposal.proposalId}:expire-reapproval:v${input.aggregate.version}`,
    occurredAt:input.now,
    metadata:{regenerationRequired:true}
  });
}
