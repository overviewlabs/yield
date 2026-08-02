import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { DomainError } from "@whox/contracts";
import type { DurableJobQueue, QueueJob } from "./durable-queue.js";

export interface WorkerHealth {readonly name:string;readonly state:"starting"|"ready"|"degraded"|"stopping";readonly workerId:string;readonly processed:number;readonly failed:number;readonly lastHeartbeat:string;readonly lastErrorCode?:string;}
export type JobHandler<T extends Readonly<Record<string, unknown>>>=(job:QueueJob<T>,signal:AbortSignal)=>Promise<void>;
export class DeferJobError extends Error {public constructor(readonly availableAt:string){super("Job deferred");this.name="DeferJobError";}}

export class PollingWorker<T extends Readonly<Record<string, unknown>>=Readonly<Record<string, unknown>>> {
  readonly workerId:string;#state:WorkerHealth["state"]="starting";#processed=0;#failed=0;#lastHeartbeat=new Date().toISOString();#lastErrorCode:string|undefined;
  public constructor(readonly name:string,private readonly queue:DurableJobQueue,private readonly queueName:string,private readonly handler:JobHandler<T>,private readonly pollingIntervalMs=750,private readonly leaseMs=30_000,workerId?:string){this.workerId=workerId??`${name}:${randomUUID()}`;}
  public health():WorkerHealth{return Object.freeze({name:this.name,state:this.#state,workerId:this.workerId,processed:this.#processed,failed:this.#failed,lastHeartbeat:this.#lastHeartbeat,...(this.#lastErrorCode===undefined?{}:{lastErrorCode:this.#lastErrorCode})});}
  public async run(signal:AbortSignal):Promise<void>{this.#state="ready";while(!signal.aborted){await this.runOnce(signal);if(!signal.aborted)await wait(this.pollingIntervalMs,signal);}this.#state="stopping";}
  public async runOnce(signal:AbortSignal):Promise<boolean>{this.#lastHeartbeat=new Date().toISOString();let job:QueueJob<T>|undefined;try{job=await this.queue.claim<T>(this.queueName,this.workerId,this.leaseMs);}catch(error){this.#degrade(error);return false;}if(job===undefined)return false;
    const heartbeat=setInterval(()=>{void this.queue.heartbeat(job!.id,this.workerId,this.leaseMs).catch((error:unknown)=>this.#degrade(error));},Math.max(1_000,Math.floor(this.leaseMs/3)));heartbeat.unref();
    try{await this.handler(job,signal);await this.queue.complete(job.id,this.workerId);this.#processed+=1;this.#state="ready";this.#lastErrorCode=undefined;return true;}catch(error){if(error instanceof DeferJobError){try{await this.queue.defer(job.id,this.workerId,error.availableAt);this.#state="ready";this.#lastErrorCode=undefined;}catch(deferError){this.#failed+=1;this.#degrade(deferError);}return false;}this.#failed+=1;this.#degrade(error);try{await this.queue.fail(job.id,this.workerId,errorCode(error),Math.min(60_000,1_000*2**Math.min(job.attempts,6)));}catch(leaseError){this.#degrade(leaseError);}return false;}finally{clearInterval(heartbeat);this.#lastHeartbeat=new Date().toISOString();}}
  async stop():Promise<void>{this.#state="stopping";await this.queue.close();}
  #degrade(error:unknown):void{this.#state="degraded";this.#lastErrorCode=errorCode(error);}
}

export function startWorkerHealthServer(worker:{health():WorkerHealth},port:number,host="0.0.0.0"):Server{const server=createServer((request,response)=>{if(request.url!=="/healthz"){response.writeHead(404);response.end();return;}const health=worker.health();const status=health.state==="degraded"?503:200;const body=JSON.stringify(health);response.writeHead(status,{"content-type":"application/json; charset=utf-8","content-length":Buffer.byteLength(body),"cache-control":"no-store"});response.end(body);});server.listen(port,host);return server;}
export function errorCode(error:unknown):string{if(error instanceof DomainError)return error.code;return "WORKER_ERROR";}
function wait(milliseconds:number,signal:AbortSignal):Promise<void>{return new Promise((resolve)=>{if(signal.aborted){resolve();return;}const timer=setTimeout(done,milliseconds);function done():void{signal.removeEventListener("abort",done);clearTimeout(timer);resolve();}signal.addEventListener("abort",done,{once:true});});}
