import { DomainError } from "@whox/contracts";
import {
  DeferJobError,
  InMemoryCoordinationAdapter,
  InMemoryDurableJobQueue,
  PollingWorker,
  PostgresDurableJobQueue,
  RedisCoordinationAdapter,
  startWorkerHealthServer,
  type CoordinationAdapter,
  type DurableJobQueue
} from "@whox/agent-orchestrator";
import { parseRuntimeMode, readReleaseGates } from "@whox/shared-config";
import { PaperBroker } from "./brokers.js";
import { executionMarketDataProviderId, handleExecutionPrerequisiteFailure } from "./execution-prerequisites.js";
import { ExecutionWorker } from "./index.js";
import { PostgresExecutionRepository } from "./persistence.js";

function port():number{const value=Number(process.env.HEALTH_PORT??9102);if(!Number.isInteger(value)||value<1||value>65_535)throw new DomainError("WORKER_PORT_INVALID","HEALTH_PORT is invalid",500);return value;}
function approvedProviders(mode:"demo"|"paper"|"live"):readonly string[]{if(mode==="demo")return Object.freeze(["whox-demo-fixture"]);const providers=(process.env.APPROVED_MARKET_DATA_PROVIDERS??"").split(",").map((value)=>value.trim()).filter(Boolean);if(providers.length===0||providers.some((value)=>!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value)))throw new DomainError("APPROVED_MARKET_DATA_PROVIDERS_REQUIRED","APPROVED_MARKET_DATA_PROVIDERS must name at least one explicitly approved provider",500);return Object.freeze([...new Set(providers)]);}

async function main():Promise<void>{
  const mode=parseRuntimeMode(process.env.APP_ENV);if(mode==="live")throw new DomainError("ROBINHOOD_ORDER_MAPPING_UNAPPROVED","Live execution cannot start until an approved runtime order-schema mapper is configured",503);
  const databaseUrl=process.env.DATABASE_URL?.trim();const redisUrl=process.env.REDIS_URL?.trim();if(mode!=="demo"&&(!databaseUrl||!redisUrl))throw new DomainError("PERSISTENT_EXECUTION_RUNTIME_REQUIRED","Paper execution requires DATABASE_URL and REDIS_URL",500);
  const marketProviders=approvedProviders(mode);const marketProviderId=executionMarketDataProviderId(mode,marketProviders);const releaseGates=readReleaseGates(process.env);const queue:DurableJobQueue=databaseUrl?PostgresDurableJobQueue.connect(databaseUrl):new InMemoryDurableJobQueue();const coordination:CoordinationAdapter=redisUrl?await RedisCoordinationAdapter.connect(redisUrl,"whox-execution"):new InMemoryCoordinationAdapter();const repository=databaseUrl?new PostgresExecutionRepository(databaseUrl):undefined;const broker=new PaperBroker(mode);
  const worker=new PollingWorker("execution-worker",queue,"execution",async(job)=>{const lock=await coordination.acquireLock(`job:${job.id}`,60_000);if(lock===undefined)throw new DomainError("EXECUTION_JOB_LOCKED","Execution job is already locked",409);try{
    if(job.jobType==="reconcile_paper_order"){
      if(repository===undefined||job.userId===undefined||typeof job.payload.jobId!=="string"||typeof job.payload.orderId!=="string")throw new DomainError("RECONCILIATION_JOB_INVALID","Paper reconciliation job is invalid",422);
      const disposition=await repository.reconcilePaperOrder(job.userId,job.payload.jobId,job.payload.orderId,new Date().toISOString(),marketProviders);
      if(disposition.resolution==="deferred")throw new DeferJobError(disposition.retryAt);
      return;
    }
    if(job.jobType!=="submit_approved"||repository===undefined||job.userId===undefined||typeof job.payload.proposalId!=="string"||typeof job.payload.idempotencyKey!=="string"||typeof job.payload.correlationId!=="string")throw new DomainError("EXECUTION_JOB_INVALID","Execution submission job is invalid or requires the persistent runtime",422);
    const now=new Date().toISOString();const store=repository.proposalStore(job.userId);const persisted=await store.get(job.payload.proposalId);if(persisted===undefined)throw new DomainError("PROPOSAL_NOT_FOUND","Proposal was not found",404);
    try{
      const authorized=persisted.status==="APPROVED"?await store.loadApproved(job.payload.proposalId,now,releaseGates,marketProviders):await store.loadRecoverable(job.payload.proposalId,now,releaseGates,marketProviders);if(authorized.aggregate.proposal.environment!==mode)throw new DomainError("EXECUTION_MODE_MISMATCH","Proposal mode does not match execution runtime",409);
      const riskContext=await repository.loadAuthoritativeRiskContext(job.userId,authorized,now);const execution=new ExecutionWorker(store,broker,repository);const outcome=await execution.submitApproved({aggregate:authorized.aggregate,policy:authorized.policy,riskContext,authorization:authorized.authorization,idempotencyKey:job.payload.idempotencyKey,correlationId:job.payload.correlationId,now});await repository.persistOutcome(job.userId,outcome,job.payload.idempotencyKey);
    }catch(error){
      await handleExecutionPrerequisiteFailure({error,queue,store,aggregate:persisted,userId:job.userId,providerId:marketProviderId,correlationId:job.payload.correlationId,now});
    }
  }finally{await coordination.releaseLock(lock);}});
  let reconciliationPollError:string|undefined;
  const health=startWorkerHealthServer({health:()=>{
    const base=worker.health();
    return reconciliationPollError===undefined?base:Object.freeze({...base,state:"degraded" as const,lastErrorCode:reconciliationPollError});
  }},port());
  const controller=new AbortController();const stop=():void=>controller.abort();process.once("SIGTERM",stop);process.once("SIGINT",stop);
  const reconciliationTimer=repository?setInterval(()=>{
    void repository.claimDueReconciliations().then(async(items)=>{
      for(const item of items)await queue.enqueue({queueName:"execution",userId:item.userId,jobType:"reconcile_paper_order",payload:{jobId:item.jobId,orderId:item.orderId},idempotencyKey:`reconcile:${item.jobId}`});
      reconciliationPollError=undefined;
    }).catch((error:unknown)=>{
      reconciliationPollError=error instanceof DomainError?error.code:"RECONCILIATION_POLL_FAILED";
      process.stderr.write(JSON.stringify({event:"reconciliation_poll_failed",service:"execution-worker",code:reconciliationPollError})+"\n");
    });
  },5_000):undefined;
  reconciliationTimer?.unref();process.stdout.write(JSON.stringify({event:"worker_started",service:"execution-worker",mode,healthPort:port()})+"\n");await worker.run(controller.signal);if(reconciliationTimer)clearInterval(reconciliationTimer);await new Promise<void>((resolve)=>health.close(()=>resolve()));await worker.stop();await coordination.close();await repository?.close();
}
void main().catch((error:unknown)=>{process.stderr.write(JSON.stringify({event:"worker_start_failed",service:"execution-worker",code:error instanceof DomainError?error.code:"WORKER_START_FAILED"})+"\n");process.exitCode=1;});
