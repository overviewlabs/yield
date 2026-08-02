import { DomainError } from "@whox/contracts";
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

export interface TenantTransaction {
  query<R extends QueryResultRow=QueryResultRow>(text:string,values?:readonly unknown[]):Promise<QueryResult<R>>;
}

/**
 * The only database boundary exposed to public API adapters. Every operation is
 * transactional and sets the tenant GUC before the first application query, so
 * FORCE RLS remains the final authorization layer even when an ID is guessed.
 */
export class PostgresTenantDatabase {
  readonly #pool:Pool;
  readonly #runtimeRole:string;
  public constructor(databaseUrl:string,runtimeRole="whox_api_runtime"){if(databaseUrl.trim()==="")throw new TypeError("DATABASE_URL is required");if(!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole))throw new TypeError("Database runtime role is invalid");this.#runtimeRole=runtimeRole;this.#pool=new Pool({connectionString:databaseUrl,application_name:"whox-api-runtime",max:12});}
  async #setRuntimeTransactionRole(client:PoolClient):Promise<void>{await client.query(`SET LOCAL ROLE ${this.#runtimeRole}`);await client.query("SET LOCAL statement_timeout='10s'");}
  public async withTenant<T>(userId:string,operation:(transaction:TenantTransaction)=>Promise<T>):Promise<T>{if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId))throw new DomainError("TENANT_CONTEXT_INVALID","Authenticated tenant context is invalid",401);const client=await this.#pool.connect();let began=false;try{await client.query("BEGIN");began=true;await this.#setRuntimeTransactionRole(client);await client.query(`SELECT set_config('app.user_id',$1,true)`,[userId]);const result=await operation(new ScopedTransaction(client));await client.query("COMMIT");return result;}catch(error){if(began)await client.query("ROLLBACK");throw error;}finally{client.release();}}
  public async resolveAppleIdentity(providerSubject:string,email:string|undefined,displayName:string|undefined,accountMode:"demo"|"paper"):Promise<string>{const client=await this.#pool.connect();let began=false;try{await client.query("BEGIN");began=true;await this.#setRuntimeTransactionRole(client);const result=await client.query<{user_id:string}>("SELECT app.resolve_apple_identity($1,$2,$3,$4)::text AS user_id",[providerSubject,email??"",displayName??"",accountMode]);const userId=result.rows[0]?.user_id;if(userId===undefined)throw new DomainError("IDENTITY_PERSISTENCE_FAILED","Apple identity could not be resolved",500);await client.query("COMMIT");return userId;}catch(error){if(began)await client.query("ROLLBACK");throw error;}finally{client.release();}}
  public async consumeAppleIdentityAssertion(assertionDigest:string,expiresAt:string,consumedAt:string):Promise<void>{const client=await this.#pool.connect();let began=false;try{await client.query("BEGIN");began=true;await this.#setRuntimeTransactionRole(client);await client.query("SELECT app.consume_apple_identity_assertion($1,$2,$3)",[assertionDigest,expiresAt,consumedAt]);await client.query("COMMIT");}catch(error){if(began)await client.query("ROLLBACK");if(typeof error==="object"&&error!==null&&(error as{code?:string}).code==="23505")throw new DomainError("APPLE_IDENTITY_REPLAYED","Apple identity token was already consumed",401);throw error;}finally{client.release();}}
  public async healthy():Promise<boolean>{try{return (await this.#pool.query<{ok:number}>("SELECT 1 AS ok")).rows[0]?.ok===1;}catch{return false;}}
  public async ready():Promise<boolean>{
    const client=await this.#pool.connect();
    let began=false;
    try{
      await client.query("BEGIN");
      began=true;
      await this.#setRuntimeTransactionRole(client);
      const result=await client.query<{ready:boolean}>(`SELECT
        to_regclass('public.api_idempotency_records') IS NOT NULL
        AND to_regclass('public.pairing_claim_attempts') IS NOT NULL
        AND to_regclass('public.apple_identity_assertions') IS NOT NULL
        AND to_regclass('public.step_up_authentication_uses') IS NOT NULL
        AND to_regclass('public.plan_agent_catalog_versions') IS NOT NULL
        AND to_regclass('public.plan_agent_catalog_entries') IS NOT NULL
        AND to_regclass('public.one_current_user_agent_version') IS NOT NULL
        AND to_regprocedure('app.resolve_apple_identity(text,text,text,app_environment)') IS NOT NULL
        AND to_regprocedure('app.consume_apple_identity_assertion(text,timestamptz,timestamptz)') IS NOT NULL
        AND to_regprocedure('app.lock_current_plan_agent_assignment(uuid,text,uuid)') IS NOT NULL
        AND COALESCE((
          SELECT relation.relrowsecurity AND relation.relforcerowsecurity
          FROM pg_class relation
          WHERE relation.oid=to_regclass('public.broker_authorization_sagas')
        ),false)
        AND COALESCE((
          SELECT relation.relrowsecurity AND relation.relforcerowsecurity
          FROM pg_class relation
          WHERE relation.oid=to_regclass('public.broker_authorization_exchange_attempts')
        ),false)
        AND EXISTS(
          SELECT 1 FROM pg_policies
          WHERE schemaname='public' AND tablename='broker_authorization_sagas'
            AND policyname='tenant_isolation'
        )
        AND EXISTS(
          SELECT 1 FROM pg_policies
          WHERE schemaname='public' AND tablename='broker_authorization_sagas'
            AND policyname='broker_authorization_janitor_access'
        )
        AND EXISTS(
          SELECT 1 FROM pg_policies
          WHERE schemaname='public' AND tablename='broker_authorization_exchange_attempts'
            AND policyname='tenant_isolation'
        )
        AND EXISTS(
          SELECT 1 FROM pg_policies
          WHERE schemaname='public' AND tablename='broker_authorization_exchange_attempts'
            AND policyname='broker_authorization_exchange_janitor_access'
        )
        AND has_table_privilege($1,'public.broker_authorization_sagas','SELECT,INSERT,UPDATE')
        AND has_table_privilege($1,'public.broker_authorization_exchange_attempts','SELECT,INSERT,UPDATE')
        AND COALESCE((
          SELECT pg_get_userbyid(proowner)='whox_broker_authorization_janitor'
            AND has_function_privilege('whox_broker_sync_worker',oid,'EXECUTE')
          FROM pg_proc WHERE oid=to_regprocedure('app.requeue_stuck_broker_authorization_sagas()')
        ),false)
        AND COALESCE((
          SELECT pg_get_userbyid(proowner)='whox_broker_authorization_janitor'
            AND has_function_privilege('whox_broker_sync_worker',oid,'EXECUTE')
          FROM pg_proc WHERE oid=to_regprocedure('app.lock_broker_authorization_user(uuid)')
        ),false)
        AND COALESCE((
          SELECT pg_get_userbyid(proowner)='whox_broker_authorization_janitor'
            AND has_function_privilege('whox_broker_sync_worker',oid,'EXECUTE')
          FROM pg_proc WHERE oid=to_regprocedure('app.broker_authorization_lag_status()')
        ),false)
        AND NOT has_schema_privilege('whox_broker_authorization_janitor','app','CREATE')
        AS ready`,[this.#runtimeRole]);
      await client.query("COMMIT");
      return result.rows[0]?.ready===true;
    }catch{
      if(began)await client.query("ROLLBACK");
      return false;
    }finally{client.release();}
  }
  public async close():Promise<void>{await this.#pool.end();}
}

class ScopedTransaction implements TenantTransaction {public constructor(private readonly client:PoolClient){}public query<R extends QueryResultRow=QueryResultRow>(text:string,values:readonly unknown[]=[]):Promise<QueryResult<R>>{if(/^\s*(BEGIN|COMMIT|ROLLBACK|SET\s+(?:LOCAL\s+)?ROLE|RESET\s+ROLE)/i.test(text))throw new DomainError("TENANT_TRANSACTION_CONTROL_FORBIDDEN","Nested transaction or role control is forbidden",500);return this.client.query<R>(text,[...values]);}}
