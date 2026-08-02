import { randomUUID } from "node:crypto";
import { DomainError } from "@whox/contracts";
import { Pool, type PoolClient } from "pg";

export interface QueueJob<T = Readonly<Record<string, unknown>>> {
  readonly id: string;
  readonly queueName: string;
  readonly userId?: string;
  readonly jobType: string;
  readonly payload: T;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly leasedBy: string;
  readonly leasedUntil: string;
}

export interface EnqueueCommand<T> {
  readonly queueName: string;
  readonly userId?: string;
  readonly jobType: string;
  readonly payload: T;
  readonly idempotencyKey: string;
  readonly availableAt?: string;
  readonly priority?: number;
  readonly maxAttempts?: number;
}

export interface DurableJobQueue {
  enqueue<T extends Readonly<Record<string, unknown>>>(command: EnqueueCommand<T>): Promise<string>;
  claim<T extends Readonly<Record<string, unknown>>>(queueName: string, workerId: string, leaseMs: number): Promise<QueueJob<T> | undefined>;
  heartbeat(jobId: string, workerId: string, leaseMs: number): Promise<void>;
  defer(jobId: string, workerId: string, availableAt: string): Promise<void>;
  complete(jobId: string, workerId: string): Promise<void>;
  fail(jobId: string, workerId: string, errorCode: string, retryDelayMs: number): Promise<"retry" | "dead_letter">;
  close(): Promise<void>;
}

interface MemoryRecord {
  readonly id: string;
  readonly command: EnqueueCommand<Readonly<Record<string, unknown>>>;
  status: "queued" | "leased" | "succeeded" | "failed" | "dead_letter";
  attempts: number;
  availableAt: number;
  leasedBy?: string;
  leasedUntil?: number;
}

export class InMemoryDurableJobQueue implements DurableJobQueue {
  readonly #records = new Map<string, MemoryRecord>();
  readonly #keys = new Map<string, { readonly id: string; readonly fingerprint: string }>();
  public constructor(private readonly clock: () => number = Date.now) {}

  public async enqueue<T extends Readonly<Record<string, unknown>>>(command: EnqueueCommand<T>): Promise<string> {
    const scope = `${command.queueName}:${command.idempotencyKey}`;
    const fingerprint = JSON.stringify(command.payload);
    const prior = this.#keys.get(scope);
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprint) throw new DomainError("QUEUE_IDEMPOTENCY_REUSED", "Queue idempotency key was reused with a different payload", 409);
      return prior.id;
    }
    const id = randomUUID();
    this.#records.set(id, {id, command, status:"queued", attempts:0, availableAt:Date.parse(command.availableAt ?? new Date(this.clock()).toISOString())});
    this.#keys.set(scope, {id, fingerprint});
    return id;
  }

  public async claim<T extends Readonly<Record<string, unknown>>>(queueName:string,workerId:string,leaseMs:number):Promise<QueueJob<T>|undefined>{
    const now=this.clock();
    const record=[...this.#records.values()].filter((item)=>item.command.queueName===queueName&&(["queued","failed"].includes(item.status)||(item.status==="leased"&&item.leasedUntil!==undefined&&item.leasedUntil<=now))&&item.availableAt<=now&&(item.leasedUntil===undefined||item.leasedUntil<=now)).sort((a,b)=>(a.command.priority??100)-(b.command.priority??100)||a.availableAt-b.availableAt)[0];
    if(record===undefined)return undefined;
    record.status="leased";record.leasedBy=workerId;record.leasedUntil=now+leaseMs;
    return this.#job<T>(record);
  }
  public async heartbeat(jobId:string,workerId:string,leaseMs:number):Promise<void>{const record=this.#leased(jobId,workerId);record.leasedUntil=this.clock()+leaseMs;}
  public async defer(jobId:string,workerId:string,availableAt:string):Promise<void>{const instant=Date.parse(availableAt);if(!Number.isFinite(instant)||instant<=this.clock())throw new DomainError("QUEUE_DEFER_TIME_INVALID","Deferred job time must be in the future",422);const record=this.#leased(jobId,workerId);record.status="queued";record.availableAt=instant;delete record.leasedBy;delete record.leasedUntil;}
  public async complete(jobId:string,workerId:string):Promise<void>{const record=this.#leased(jobId,workerId);record.status="succeeded";delete record.leasedBy;delete record.leasedUntil;}
  public async fail(jobId:string,workerId:string,errorCode:string,retryDelayMs:number):Promise<"retry"|"dead_letter"> {const record=this.#leased(jobId,workerId);if(!/^[A-Z0-9_:-]{1,100}$/.test(errorCode))errorCode="WORKER_ERROR";record.attempts+=1;const terminal=record.attempts>=(record.command.maxAttempts??10);record.status=terminal?"dead_letter":"failed";record.availableAt=this.clock()+retryDelayMs;delete record.leasedBy;delete record.leasedUntil;return terminal?"dead_letter":"retry";}
  public async close():Promise<void>{}
  #leased(id:string,workerId:string):MemoryRecord{const record=this.#records.get(id);if(record===undefined||record.status!=="leased"||record.leasedBy!==workerId||record.leasedUntil===undefined||record.leasedUntil<=this.clock())throw new DomainError("QUEUE_LEASE_LOST","Queue job lease was lost",409);return record;}
  #job<T extends Readonly<Record<string, unknown>>>(record:MemoryRecord):QueueJob<T>{return Object.freeze({id:record.id,queueName:record.command.queueName,...(record.command.userId===undefined?{}:{userId:record.command.userId}),jobType:record.command.jobType,payload:record.command.payload as T,attempts:record.attempts,maxAttempts:record.command.maxAttempts??10,leasedBy:record.leasedBy!,leasedUntil:new Date(record.leasedUntil!).toISOString()});}
}

interface JobRow {id:string;queue_name:string;user_id:string|null;job_type:string;payload:unknown;attempts:number;max_attempts:number;leased_by:string;leased_until:Date;}

export class PostgresDurableJobQueue implements DurableJobQueue {
  public constructor(private readonly pool: Pool) {}
  public static connect(databaseUrl:string):PostgresDurableJobQueue{if(databaseUrl.trim()==="")throw new TypeError("DATABASE_URL is required");return new PostgresDurableJobQueue(new Pool({connectionString:databaseUrl,application_name:"whox-durable-queue",max:8}));}
  public async enqueue<T extends Readonly<Record<string, unknown>>>(command:EnqueueCommand<T>):Promise<string>{
    if(command.idempotencyKey.length<8)throw new DomainError("IDEMPOTENCY_KEY_INVALID","Queue idempotency key is required",400);
    const result=await this.pool.query<{id:string}>(`INSERT INTO queue_jobs(queue_name,user_id,job_type,payload,idempotency_key,available_at,priority,max_attempts)
      VALUES ($1,$2,$3,$4::jsonb,$5,COALESCE($6::timestamptz,clock_timestamp()),$7,$8)
      ON CONFLICT(queue_name,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
      WHERE queue_jobs.payload=EXCLUDED.payload AND queue_jobs.job_type=EXCLUDED.job_type AND queue_jobs.user_id IS NOT DISTINCT FROM EXCLUDED.user_id
      RETURNING id`,[command.queueName,command.userId??null,command.jobType,JSON.stringify(command.payload),command.idempotencyKey,command.availableAt??null,command.priority??100,command.maxAttempts??10]);
    const id=result.rows[0]?.id;if(id===undefined)throw new DomainError("QUEUE_IDEMPOTENCY_REUSED","Queue idempotency key was reused with a different payload",409);return id;
  }
  public async claim<T extends Readonly<Record<string, unknown>>>(queueName:string,workerId:string,leaseMs:number):Promise<QueueJob<T>|undefined>{return this.#transaction(async(client)=>{const result=await client.query<JobRow>(`WITH candidate AS (
        SELECT id FROM queue_jobs WHERE queue_name=$1 AND (status IN ('queued','failed') OR (status='leased' AND leased_until<=clock_timestamp())) AND available_at<=clock_timestamp()
          AND (leased_until IS NULL OR leased_until<=clock_timestamp()) ORDER BY priority,available_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
        UPDATE queue_jobs AS job SET status='leased',leased_by=$2,leased_until=clock_timestamp()+($3::text||' milliseconds')::interval
        FROM candidate WHERE job.id=candidate.id
        RETURNING job.id,job.queue_name,job.user_id,job.job_type,job.payload,job.attempts,job.max_attempts,job.leased_by,job.leased_until`,[queueName,workerId,leaseMs]);const row=result.rows[0];return row===undefined?undefined:this.#map<T>(row);});}
  public async heartbeat(jobId:string,workerId:string,leaseMs:number):Promise<void>{const result=await this.pool.query(`UPDATE queue_jobs SET leased_until=clock_timestamp()+($3::text||' milliseconds')::interval WHERE id=$1 AND leased_by=$2 AND status='leased' AND leased_until>clock_timestamp()`,[jobId,workerId,leaseMs]);if(result.rowCount!==1)throw new DomainError("QUEUE_LEASE_LOST","Queue job lease was lost",409);}
  public async defer(jobId:string,workerId:string,availableAt:string):Promise<void>{const result=await this.pool.query(`UPDATE queue_jobs SET status='queued',available_at=$3::timestamptz,leased_by=NULL,leased_until=NULL WHERE id=$1 AND leased_by=$2 AND status='leased' AND leased_until>clock_timestamp() AND $3::timestamptz>clock_timestamp()`,[jobId,workerId,availableAt]);if(result.rowCount!==1)throw new DomainError("QUEUE_DEFER_FAILED","Queue job could not be deferred",409);}
  public async complete(jobId:string,workerId:string):Promise<void>{const result=await this.pool.query(`UPDATE queue_jobs SET status='succeeded',leased_by=NULL,leased_until=NULL,last_error_code=NULL WHERE id=$1 AND leased_by=$2 AND status='leased' AND leased_until>clock_timestamp()`,[jobId,workerId]);if(result.rowCount!==1)throw new DomainError("QUEUE_LEASE_LOST","Queue job lease was lost",409);}
  public async fail(jobId:string,workerId:string,errorCode:string,retryDelayMs:number):Promise<"retry"|"dead_letter">{const safe=/^[A-Z0-9_:-]{1,100}$/.test(errorCode)?errorCode:"WORKER_ERROR";const result=await this.pool.query<{status:"failed"|"dead_letter"}>(`UPDATE queue_jobs SET attempts=attempts+1,status=CASE WHEN attempts+1>=max_attempts THEN 'dead_letter'::job_status ELSE 'failed'::job_status END,
      available_at=clock_timestamp()+($4::text||' milliseconds')::interval,leased_by=NULL,leased_until=NULL,last_error_code=$3
      WHERE id=$1 AND leased_by=$2 AND status='leased' AND leased_until>clock_timestamp() RETURNING status`,[jobId,workerId,safe,retryDelayMs]);const status=result.rows[0]?.status;if(status===undefined)throw new DomainError("QUEUE_LEASE_LOST","Queue job lease was lost",409);return status==="dead_letter"?"dead_letter":"retry";}
  public async close():Promise<void>{await this.pool.end();}
  async #transaction<T>(operation:(client:PoolClient)=>Promise<T>):Promise<T>{const client=await this.pool.connect();try{await client.query("BEGIN");const value=await operation(client);await client.query("COMMIT");return value;}catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}}
  #map<T extends Readonly<Record<string, unknown>>>(row:JobRow):QueueJob<T>{if(typeof row.payload!=="object"||row.payload===null||Array.isArray(row.payload))throw new DomainError("QUEUE_PAYLOAD_INVALID","Queue payload must be an object",500);return Object.freeze({id:row.id,queueName:row.queue_name,...(row.user_id===null?{}:{userId:row.user_id}),jobType:row.job_type,payload:row.payload as T,attempts:row.attempts,maxAttempts:row.max_attempts,leasedBy:row.leased_by,leasedUntil:new Date(row.leased_until).toISOString()});}
}
