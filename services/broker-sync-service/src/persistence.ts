import { randomUUID } from "node:crypto";
import {
  DomainError,
  type ApprovedBrokerConnectorIdentity,
  type BrokerAuthorizationCompletion,
  type BrokerAuthorizationExchangeOperation,
  type BrokerAuthorizationExchangePersistence,
  type BrokerAuthorizationExchangeWork,
  type BrokerAuthorizationSagaOperation,
  type BrokerAuthorizationSagaPersistence,
  type BrokerAuthorizationSagaWork,
  type BrokerConnectionSummary,
  type BrokerHydrationRequest
} from "@whox/contracts";
import { Pool, type PoolClient } from "pg";
import type {
  BrokerSyncPersistence,
  BrokerSyncTrigger,
  PersistBrokerHydrationCommand,
  PersistBrokerHydrationResult
} from "./broker-sync.js";

interface ConnectionRow {
  readonly id: string;
  readonly provider: string;
  readonly status: string;
  readonly authorization_issuer: string | null;
  readonly resource_uri: string | null;
  readonly credential_ready: boolean;
  readonly connector_adapter_id: string | null;
  readonly connector_approval_reference: string | null;
  readonly connector_protocol_version: string | null;
  readonly connected_at: Date | null;
  readonly credential_bound_at: Date | null;
  readonly last_sync_at: Date | null;
}

interface PriorRunRow {
  readonly account_id: string;
  readonly portfolio_snapshot_id: string;
  readonly source_timestamp: Date;
  readonly snapshot_fingerprint: string;
  readonly completed_at: Date;
}

export interface BrokerSyncLagStatus {
  readonly connectedCount: number;
  readonly credentialUnboundCount: number;
  readonly laggedCount: number;
  readonly pendingAuthorizationCount: number;
  readonly stuckAuthorizationCount: number;
}

interface AuthorizationSagaRow {
  readonly sagaId: string;
  readonly userId: string;
  readonly pairingId: string;
  readonly connectionId: string;
  readonly exchangeTransactionId: string;
  readonly credentialHandle: string | null;
  readonly status: BrokerAuthorizationSagaOperation;
  readonly authorizationIssuer: string;
  readonly resourceUri: string;
  readonly adapterId: string;
  readonly approvalReference: string;
  readonly protocolVersion: string;
  readonly confirmationDeadlineAt: Date;
  readonly summary: BrokerConnectionSummary;
}

interface AuthorizationExchangeRow {
  readonly userId: string;
  readonly pairingId: string;
  readonly exchangeTransactionId: string;
  readonly status: BrokerAuthorizationExchangeOperation;
  readonly authorizationIssuer: string;
  readonly resourceUri: string;
  readonly adapterId: string;
  readonly approvalReference: string;
  readonly protocolVersion: string;
  readonly cleanupAfter: Date;
}

interface LockedAuthorizationBinding {
  readonly sagaId: string;
  readonly connectionId: string;
  readonly pairingId: string;
  readonly operation: BrokerAuthorizationSagaOperation;
  readonly credentialHandle: string | null;
  readonly creatorSessionId: string | null;
  readonly confirmationDeadlineAt: Date;
}

function assertUuid(value: string, field: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new DomainError("BROKER_SYNC_BINDING_INVALID", `${field} is not a UUID`, 422);
  }
}

function assertConnection(row: ConnectionRow | undefined, request: BrokerHydrationRequest, identity: ApprovedBrokerConnectorIdentity, trigger: BrokerSyncTrigger): ConnectionRow {
  const allowedStatus = trigger === "authorization_completed" ? new Set(["pending", "connected"]) : new Set(["connected"]);
  if (row === undefined || row.id !== request.connectionId || row.provider !== request.provider || !allowedStatus.has(row.status)) {
    throw new DomainError("BROKER_CONNECTION_NOT_READY", "Broker connection is absent, revoked, or not connected", 409);
  }
  if (!row.credential_ready) throw new DomainError("BROKER_CREDENTIAL_BINDING_REQUIRED", "Broker connection has no encrypted credential envelope or isolated credential handle", 503);
  if (row.authorization_issuer !== identity.authorizationIssuer
    || row.resource_uri !== identity.resourceUri
    || row.connector_adapter_id !== identity.adapterId
    || row.connector_approval_reference !== identity.approvalReference
    || row.connector_protocol_version !== identity.protocolVersion) {
    throw new DomainError("BROKER_CONNECTOR_BINDING_MISMATCH", "Persisted broker authorization does not match the injected approved connector and resource", 403);
  }
  return row;
}

export class PostgresBrokerSyncPersistence implements BrokerSyncPersistence, BrokerAuthorizationSagaPersistence, BrokerAuthorizationExchangePersistence {
  readonly #pool: Pool;

  public constructor(databaseUrl: string) {
    if (databaseUrl.trim() === "") throw new TypeError("DATABASE_URL is required");
    this.#pool = new Pool({ connectionString: databaseUrl, application_name: "whox-broker-sync", max: 8 });
  }

  async #withTenant<T>(userId: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    assertUuid(userId, "Broker sync tenant");
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE whox_broker_sync_worker");
      await client.query("SET LOCAL statement_timeout='10s'");
      await client.query("SELECT set_config('app.user_id',$1,true)", [userId]);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async #connection(client: PoolClient, request: BrokerHydrationRequest, forUpdate: boolean): Promise<ConnectionRow | undefined> {
    const result = await client.query<ConnectionRow>(
      `SELECT id::text,provider,status,authorization_issuer,resource_uri,
         (
           (credential_handle IS NOT NULL AND credential_bound_at IS NOT NULL AND credential_confirmed_at IS NOT NULL)
           OR
           (
             token_envelope IS NOT NULL AND token_key_id IS NOT NULL
             AND (token_expires_at IS NULL OR token_expires_at>transaction_timestamp() OR refresh_supported)
           )
         ) AS credential_ready,
         connector_adapter_id,connector_approval_reference,connector_protocol_version,
         connected_at,credential_bound_at,last_sync_at
       FROM broker_connections
       WHERE id=$1 AND user_id=$2 AND provider=$3 AND revoked_at IS NULL${forUpdate ? " FOR UPDATE" : ""}`,
      [request.connectionId, request.userId, request.provider]
    );
    return result.rows[0];
  }

  async #authorizationSaga(client: PoolClient, userId: string, sagaId: string, forUpdate = false): Promise<AuthorizationSagaRow | undefined> {
    assertUuid(sagaId, "Broker authorization saga");
    const result = await client.query<AuthorizationSagaRow>(
      `SELECT id::text AS "sagaId",user_id::text AS "userId",pairing_id::text AS "pairingId",
         connection_id::text AS "connectionId",exchange_transaction_id AS "exchangeTransactionId",
         credential_handle AS "credentialHandle",status,authorization_issuer AS "authorizationIssuer",
         resource_uri AS "resourceUri",connector_adapter_id AS "adapterId",
         connector_approval_reference AS "approvalReference",connector_protocol_version AS "protocolVersion",
         confirmation_deadline_at AS "confirmationDeadlineAt",connection_summary AS summary
       FROM broker_authorization_sagas WHERE id=$1 AND user_id=$2${forUpdate ? " FOR UPDATE" : ""}`,
      [sagaId, userId]
    );
    return result.rows[0];
  }

  async #authorizationExchange(client: PoolClient, userId: string, exchangeTransactionId: string, forUpdate = false): Promise<AuthorizationExchangeRow | undefined> {
    assertUuid(exchangeTransactionId, "Broker authorization exchange");
    const result = await client.query<AuthorizationExchangeRow>(
      `SELECT user_id::text AS "userId",pairing_id::text AS "pairingId",
         exchange_transaction_id::text AS "exchangeTransactionId",status,
         authorization_issuer AS "authorizationIssuer",resource_uri AS "resourceUri",
         connector_adapter_id AS "adapterId",connector_approval_reference AS "approvalReference",
         connector_protocol_version AS "protocolVersion",cleanup_after AS "cleanupAfter"
       FROM broker_authorization_exchange_attempts
       WHERE user_id=$1 AND exchange_transaction_id=$2${forUpdate ? " FOR UPDATE" : ""}`,
      [userId, exchangeTransactionId]
    );
    return result.rows[0];
  }

  async #stageExchangeRevocation(
    client: PoolClient,
    userId: string,
    row: AuthorizationExchangeRow,
    errorCode: string,
    now: string
  ): Promise<"revoke_pending" | "revoked" | "completed"> {
    if (row.status === "completed" || row.status === "revoked") return row.status;
    await client.query(
      `UPDATE connection_pairings SET status='error',consumed_at=COALESCE(consumed_at,$3),
         oauth_state_digest=NULL,oauth_nonce_digest=NULL,pkce_verifier_envelope=NULL,
         oauth_state_expires_at=NULL,oauth_flow=NULL,oauth_redirect_uri=NULL,mobile_return_uri=NULL
       WHERE id=$1 AND user_id=$2 AND status IN ('pending','authorizing')`,
      [row.pairingId, userId, now]
    );
    const updated = await client.query<{ generation: number }>(
      `UPDATE broker_authorization_exchange_attempts SET status='revoke_pending',
         revocation_requested_at=COALESCE(revocation_requested_at,$3::timestamptz),
         recovery_generation=recovery_generation+1,last_error_code=$4
       WHERE user_id=$1 AND exchange_transaction_id=$2 AND status IN ('exchange_pending','revoke_pending')
       RETURNING recovery_generation AS generation`,
      [userId, row.exchangeTransactionId, now, errorCode]
    );
    const generation = updated.rows[0]?.generation;
    if (generation === undefined) {
      const terminal = await this.#authorizationExchange(client, userId, row.exchangeTransactionId);
      if (terminal?.status === "completed" || terminal?.status === "revoked") return terminal.status;
      throw new DomainError("BROKER_AUTHORIZATION_EXCHANGE_INVALID", "Broker authorization exchange could not enter revocation", 409);
    }
    const queued = await client.query<{ id: string }>(
      `INSERT INTO queue_jobs(queue_name,user_id,job_type,payload,idempotency_key,priority,max_attempts)
       VALUES('broker-sync',$1,'reconcile_broker_authorization_exchange',$2::jsonb,$3,1,25)
       ON CONFLICT(queue_name,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
       WHERE queue_jobs.user_id=EXCLUDED.user_id AND queue_jobs.job_type=EXCLUDED.job_type
         AND queue_jobs.payload=EXCLUDED.payload RETURNING id::text`,
      [userId, JSON.stringify({ exchangeTransactionId: row.exchangeTransactionId }), `broker-auth-exchange-revoke:${row.exchangeTransactionId}:${generation}`]
    );
    if (queued.rows[0]?.id === undefined) throw new DomainError("BROKER_AUTHORIZATION_RECOVERY_IDEMPOTENCY_REUSED", "Broker authorization exchange revocation key was reused", 409);
    return "revoke_pending";
  }

  public async loadAuthorizationExchange(userId: string, exchangeTransactionId: string, _now: string): Promise<BrokerAuthorizationExchangeWork> {
    return await this.#withTenant(userId, async (client) => {
      const row = await this.#authorizationExchange(client, userId, exchangeTransactionId);
      if (row === undefined) throw new DomainError("BROKER_AUTHORIZATION_EXCHANGE_NOT_FOUND", "Broker authorization exchange recovery operation was not found", 404);
      const identity: ApprovedBrokerConnectorIdentity = Object.freeze({
        provider: "robinhood_mcp",
        adapterId: row.adapterId,
        approvalReference: row.approvalReference,
        authorizationIssuer: row.authorizationIssuer,
        resourceUri: row.resourceUri,
        protocolVersion: row.protocolVersion
      });
      return Object.freeze({
        userId: row.userId,
        pairingId: row.pairingId,
        exchangeTransactionId: row.exchangeTransactionId,
        operation: row.status,
        identity,
        cleanupAfter: row.cleanupAfter.toISOString()
      });
    });
  }

  public async requestAuthorizationExchangeRevocation(userId: string, exchangeTransactionId: string, errorCode: string, now: string): Promise<"revoke_pending" | "revoked" | "completed"> {
    if (!/^[A-Z0-9_:-]{1,100}$/.test(errorCode)) throw new DomainError("BROKER_AUTHORIZATION_EXCHANGE_INVALID", "Broker authorization exchange revocation reason is invalid", 422);
    return await this.#withTenant(userId, async (client) => {
      const initial = await this.#authorizationExchange(client, userId, exchangeTransactionId);
      if (initial === undefined) throw new DomainError("BROKER_AUTHORIZATION_EXCHANGE_NOT_FOUND", "Broker authorization exchange recovery operation was not found", 404);
      const ownerLock = await client.query<{ locked: boolean }>("SELECT app.lock_broker_authorization_user($1) AS locked", [userId]);
      if (ownerLock.rows[0]?.locked !== true) throw new DomainError("BROKER_AUTHORIZATION_EXCHANGE_NOT_FOUND", "Broker authorization exchange owner was not found", 404);
      await client.query("SELECT id FROM connection_pairings WHERE id=$1 AND user_id=$2 FOR UPDATE", [initial.pairingId, userId]);
      const current = await this.#authorizationExchange(client, userId, exchangeTransactionId, true);
      if (current === undefined || current.pairingId !== initial.pairingId) throw new DomainError("BROKER_AUTHORIZATION_EXCHANGE_INVALID", "Broker authorization exchange binding changed", 500);
      return await this.#stageExchangeRevocation(client, userId, current, errorCode, now);
    });
  }

  public async acknowledgeAuthorizationExchangeRevocation(userId: string, exchangeTransactionId: string, now: string): Promise<"revoked" | "completed"> {
    return await this.#withTenant(userId, async (client) => {
      const initial = await this.#authorizationExchange(client, userId, exchangeTransactionId);
      if (initial === undefined) throw new DomainError("BROKER_AUTHORIZATION_EXCHANGE_NOT_FOUND", "Broker authorization exchange recovery operation was not found", 404);
      const ownerLock = await client.query<{ locked: boolean }>("SELECT app.lock_broker_authorization_user($1) AS locked", [userId]);
      if (ownerLock.rows[0]?.locked !== true) throw new DomainError("BROKER_AUTHORIZATION_EXCHANGE_NOT_FOUND", "Broker authorization exchange owner was not found", 404);
      await client.query("SELECT id FROM connection_pairings WHERE id=$1 AND user_id=$2 FOR UPDATE", [initial.pairingId, userId]);
      const current = await this.#authorizationExchange(client, userId, exchangeTransactionId, true);
      if (current?.status === "completed") return "completed";
      if (current?.status === "revoked") return "revoked";
      if (current?.status !== "revoke_pending") throw new DomainError("BROKER_AUTHORIZATION_EXCHANGE_INVALID", "Broker authorization exchange revocation cannot be acknowledged", 409);
      const revoked = await client.query(
        `UPDATE broker_authorization_exchange_attempts SET status='revoked',
           revoked_at=GREATEST($3::timestamptz,revocation_requested_at),last_error_code=NULL
         WHERE user_id=$1 AND exchange_transaction_id=$2 AND status='revoke_pending'`,
        [userId, exchangeTransactionId, now]
      );
      if (revoked.rowCount !== 1) throw new DomainError("BROKER_AUTHORIZATION_EXCHANGE_INVALID", "Broker authorization exchange revocation changed", 409);
      return "revoked";
    });
  }

  async #lockAuthorizationBinding(client: PoolClient, userId: string, sagaId: string): Promise<LockedAuthorizationBinding> {
    const initial = await this.#authorizationSaga(client, userId, sagaId);
    if (initial === undefined) throw new DomainError("BROKER_AUTHORIZATION_SAGA_NOT_FOUND", "Broker authorization recovery operation was not found", 404);
    const ownerLock = await client.query<{ locked: boolean }>("SELECT app.lock_broker_authorization_user($1) AS locked", [userId]);
    if (ownerLock.rows[0]?.locked !== true) throw new DomainError("BROKER_AUTHORIZATION_SAGA_NOT_FOUND", "Broker authorization owner was not found", 404);
    await client.query("SELECT id FROM broker_connections WHERE id=$1 AND user_id=$2 FOR UPDATE", [initial.connectionId, userId]);
    const pairing = await client.query<{ creatorSessionId: string | null }>(
      "SELECT creator_session_id::text AS \"creatorSessionId\" FROM connection_pairings WHERE id=$1 AND user_id=$2 FOR UPDATE",
      [initial.pairingId, userId]
    );
    const current = await this.#authorizationSaga(client, userId, sagaId, true);
    if (current === undefined || current.connectionId !== initial.connectionId || current.pairingId !== initial.pairingId) {
      throw new DomainError("BROKER_AUTHORIZATION_SAGA_INVALID", "Broker authorization recovery binding changed", 500);
    }
    return Object.freeze({
      sagaId,
      connectionId: current.connectionId,
      pairingId: current.pairingId,
      operation: current.status,
      credentialHandle: current.credentialHandle,
      creatorSessionId: pairing.rows[0]?.creatorSessionId ?? null,
      confirmationDeadlineAt: current.confirmationDeadlineAt
    });
  }

  async #stageAuthorizationRevocation(client: PoolClient, userId: string, binding: LockedAuthorizationBinding, errorCode: string, now: string): Promise<"revoke_pending" | "revoked"> {
    if (binding.operation === "revoked") return "revoked";
    await client.query(
      `UPDATE broker_connections SET status='error',credential_handle=NULL,credential_bound_at=NULL,
         credential_confirmed_at=NULL,token_envelope=NULL,token_key_id=NULL,token_expires_at=NULL,
         revoked_at=COALESCE(revoked_at,$3)
       WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL`,
      [binding.connectionId, userId, now]
    );
    await client.query(
      `UPDATE connection_pairings SET status='error',consumed_at=COALESCE(consumed_at,$3),
         oauth_state_digest=NULL,oauth_nonce_digest=NULL,pkce_verifier_envelope=NULL,
         oauth_state_expires_at=NULL,oauth_flow=NULL,oauth_redirect_uri=NULL,mobile_return_uri=NULL
       WHERE id=$1 AND user_id=$2 AND status IN ('pending','authorizing','connected')`,
      [binding.pairingId, userId, now]
    );
    const updated = await client.query<{ generation: number }>(
      `UPDATE broker_authorization_sagas SET status='revoke_pending',
         revocation_requested_at=COALESCE(revocation_requested_at,$3),
         recovery_generation=recovery_generation+1,last_error_code=$4
       WHERE id=$1 AND user_id=$2 AND status IN ('confirm_pending','confirmed','revoke_pending')
       RETURNING recovery_generation AS generation`,
      [binding.sagaId, userId, now, errorCode]
    );
    const generation = updated.rows[0]?.generation;
    if (generation === undefined) {
      const terminal = await this.#authorizationSaga(client, userId, binding.sagaId);
      if (terminal?.status === "revoked") return "revoked";
      throw new DomainError("BROKER_AUTHORIZATION_SAGA_INVALID", "Broker authorization could not enter revocation", 409);
    }
    const queued = await client.query<{ id: string }>(
      `INSERT INTO queue_jobs(queue_name,user_id,job_type,payload,idempotency_key,priority,max_attempts)
       VALUES('broker-sync',$1,'reconcile_broker_authorization',$2::jsonb,$3,1,25)
       ON CONFLICT(queue_name,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
       WHERE queue_jobs.user_id=EXCLUDED.user_id AND queue_jobs.job_type=EXCLUDED.job_type
         AND queue_jobs.payload=EXCLUDED.payload RETURNING id::text`,
      [userId, JSON.stringify({ authorizationSagaId: binding.sagaId }), `broker-auth-revoke:${binding.sagaId}:${generation}`]
    );
    if (queued.rows[0]?.id === undefined) throw new DomainError("BROKER_AUTHORIZATION_RECOVERY_IDEMPOTENCY_REUSED", "Broker authorization revocation key was reused", 409);
    return "revoke_pending";
  }

  public async loadAuthorizationSaga(userId: string, sagaId: string, _now: string): Promise<BrokerAuthorizationSagaWork> {
    return await this.#withTenant(userId, async (client) => {
      const row = await this.#authorizationSaga(client, userId, sagaId);
      if (row === undefined) throw new DomainError("BROKER_AUTHORIZATION_SAGA_NOT_FOUND", "Broker authorization recovery operation was not found", 404);
      const identity: ApprovedBrokerConnectorIdentity = Object.freeze({
        provider: "robinhood_mcp",
        adapterId: row.adapterId,
        approvalReference: row.approvalReference,
        authorizationIssuer: row.authorizationIssuer,
        resourceUri: row.resourceUri,
        protocolVersion: row.protocolVersion
      });
      let completion: BrokerAuthorizationCompletion | undefined;
      if (row.credentialHandle !== null) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{15,254}$/.test(row.credentialHandle)) throw new DomainError("BROKER_AUTHORIZATION_SAGA_INVALID", "Broker authorization credential binding is invalid", 500);
        completion = Object.freeze({ identity, credentialHandle: row.credentialHandle, resourceUri: row.resourceUri, connection: row.summary });
      }
      return Object.freeze({
        sagaId: row.sagaId,
        userId: row.userId,
        pairingId: row.pairingId,
        connectionId: row.connectionId,
        exchangeTransactionId: row.exchangeTransactionId,
        operation: row.status,
        identity,
        confirmationDeadlineAt: row.confirmationDeadlineAt.toISOString(),
        ...(completion === undefined ? {} : { completion })
      });
    });
  }

  public async requestAuthorizationRevocation(userId: string, sagaId: string, errorCode: string, now: string): Promise<"revoke_pending" | "revoked"> {
    if (!/^[A-Z0-9_:-]{1,100}$/.test(errorCode)) throw new DomainError("BROKER_AUTHORIZATION_SAGA_INVALID", "Broker authorization revocation reason is invalid", 422);
    return await this.#withTenant(userId, async (client) => {
      const binding = await this.#lockAuthorizationBinding(client, userId, sagaId);
      return await this.#stageAuthorizationRevocation(client, userId, binding, errorCode, now);
    });
  }

  public async acknowledgeAuthorizationConfirmation(userId: string, sagaId: string, now: string): Promise<BrokerAuthorizationSagaOperation> {
    return await this.#withTenant(userId, async (client) => {
      const binding = await this.#lockAuthorizationBinding(client, userId, sagaId);
      if (binding.operation !== "confirm_pending") return binding.operation;
      if (binding.credentialHandle === null) throw new DomainError("BROKER_AUTHORIZATION_SAGA_INVALID", "Broker authorization confirmation binding is unavailable", 409);
      const databaseClock = await client.query<{ now: Date }>("SELECT transaction_timestamp() AS now");
      if (binding.confirmationDeadlineAt.getTime() <= (databaseClock.rows[0]?.now.getTime() ?? Number.POSITIVE_INFINITY)) {
        return await this.#stageAuthorizationRevocation(client, userId, binding, "AUTHORIZATION_CONFIRMATION_DEADLINE_EXCEEDED", now);
      }
      const owner = await client.query<{ active: boolean }>("SELECT status='active' AND deleted_at IS NULL AS active FROM users WHERE id=$1", [userId]);
      const session = binding.creatorSessionId === null ? undefined : await client.query<{ active: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM sessions s JOIN devices d ON d.id=s.device_id AND d.user_id=s.user_id
           WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>$3::timestamptz
             AND d.revoked_at IS NULL) AS active`,
        [binding.creatorSessionId, userId, now]
      );
      if (owner.rows[0]?.active !== true || session?.rows[0]?.active !== true) {
        return await this.#stageAuthorizationRevocation(client, userId, binding, owner.rows[0]?.active === true ? "AUTHORIZATION_SESSION_INACTIVE" : "ACCOUNT_NOT_ACTIVE", now);
      }
      const connection = await client.query(
        `UPDATE broker_connections SET credential_confirmed_at=$4::timestamptz
         WHERE id=$1 AND user_id=$2 AND status='pending' AND credential_handle=$3
           AND credential_confirmed_at IS NULL AND revoked_at IS NULL`,
        [binding.connectionId, userId, binding.credentialHandle, now]
      );
      if (connection.rowCount !== 1) throw new DomainError("BROKER_AUTHORIZATION_SAGA_INVALID", "Broker authorization confirmation could not be committed", 409);
      const confirmed = await client.query(
        `UPDATE broker_authorization_sagas SET status='confirmed',confirmation_acknowledged_at=$3::timestamptz,last_error_code=NULL
         WHERE id=$1 AND user_id=$2 AND status='confirm_pending'`,
        [sagaId, userId, now]
      );
      if (confirmed.rowCount !== 1) throw new DomainError("BROKER_AUTHORIZATION_SAGA_INVALID", "Broker authorization confirmation changed", 409);
      const queued = await client.query<{ id: string }>(
        `INSERT INTO queue_jobs(queue_name,user_id,job_type,payload,idempotency_key,priority,max_attempts)
         VALUES('broker-sync',$1,'hydrate_broker_account',$2::jsonb,$3,25,10)
         ON CONFLICT(queue_name,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
         WHERE queue_jobs.user_id=EXCLUDED.user_id AND queue_jobs.job_type=EXCLUDED.job_type
           AND queue_jobs.payload=EXCLUDED.payload RETURNING id::text`,
        [userId, JSON.stringify({ connectionId: binding.connectionId, pairingId: binding.pairingId, authorizationSagaId: sagaId, provider: "robinhood_mcp", trigger: "authorization_completed" }), `initial-broker-sync:${binding.pairingId}`]
      );
      if (queued.rows[0]?.id === undefined) throw new DomainError("BROKER_SYNC_IDEMPOTENCY_REUSED", "Initial broker-sync key was reused with a different tenant-bound payload", 409);
      return "confirmed";
    });
  }

  public async acknowledgeAuthorizationRevocation(userId: string, sagaId: string, now: string): Promise<"revoked"> {
    return await this.#withTenant(userId, async (client) => {
      const binding = await this.#lockAuthorizationBinding(client, userId, sagaId);
      if (binding.operation === "revoked") return "revoked" as const;
      if (binding.operation !== "revoke_pending") throw new DomainError("BROKER_AUTHORIZATION_SAGA_INVALID", "Broker authorization revocation cannot be acknowledged", 409);
      const revoked = await client.query(
        `UPDATE broker_authorization_sagas SET status='revoked',credential_handle=NULL,
           revoked_at=GREATEST($3::timestamptz,revocation_requested_at),last_error_code=NULL
         WHERE id=$1 AND user_id=$2 AND status='revoke_pending'`,
        [sagaId, userId, now]
      );
      if (revoked.rowCount !== 1) throw new DomainError("BROKER_AUTHORIZATION_SAGA_INVALID", "Broker authorization revocation changed", 409);
      await client.query(
        `UPDATE broker_connections SET status='revoked',revoked_at=COALESCE(revoked_at,$3::timestamptz),
           credential_handle=NULL,credential_bound_at=NULL,credential_confirmed_at=NULL,
           token_envelope=NULL,token_key_id=NULL,token_expires_at=NULL
         WHERE id=$1 AND user_id=$2`,
        [binding.connectionId, userId, now]
      );
      return "revoked" as const;
    });
  }

  public async requestInitialAuthorizationRevocation(request: BrokerHydrationRequest, pairingId: string, authorizationSagaId: string | undefined, errorCode: string, now: string): Promise<void> {
    assertUuid(pairingId, "Broker authorization pairing");
    if (authorizationSagaId !== undefined) assertUuid(authorizationSagaId, "Broker authorization saga");
    const sagaId = await this.#withTenant(request.userId, async (client) => {
      const result = await client.query<{ id: string }>(
        "SELECT id::text FROM broker_authorization_sagas WHERE user_id=$1 AND connection_id=$2 AND pairing_id=$3 AND status<>'revoked' AND ($4::uuid IS NULL OR id=$4::uuid)",
        [request.userId, request.connectionId, pairingId, authorizationSagaId ?? null]
      );
      return result.rows[0]?.id;
    });
    if (sagaId === undefined) throw new DomainError("BROKER_AUTHORIZATION_SAGA_NOT_FOUND", "Initial broker authorization has no durable revocation binding", 503);
    await this.requestAuthorizationRevocation(request.userId, sagaId, errorCode, now);
  }

  public async requeueStuckAuthorizationSagas(): Promise<number> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE whox_broker_sync_worker");
      const result = await client.query<{ count: number }>("SELECT app.requeue_stuck_broker_authorization_sagas() AS count");
      await client.query("COMMIT");
      return result.rows[0]?.count ?? 0;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async requireReadyConnection(request: BrokerHydrationRequest, identity: ApprovedBrokerConnectorIdentity, trigger: BrokerSyncTrigger, pairingId?: string, authorizationSagaId?: string): Promise<void> {
    assertUuid(request.connectionId, "Broker connection");
    await this.#withTenant(request.userId, async (client) => {
      const owner = await client.query<{ active: boolean }>("SELECT status='active' AND deleted_at IS NULL AS active FROM users WHERE id=$1", [request.userId]);
      if (owner.rows[0]?.active !== true) throw new DomainError("BROKER_CONNECTION_NOT_READY", "Broker connection owner is not active", 409);
      assertConnection(await this.#connection(client, request, false), request, identity, trigger);
      if (trigger === "authorization_completed") {
        if (pairingId === undefined) throw new DomainError("BROKER_SYNC_PAIRING_REQUIRED", "Initial broker hydration is missing its pairing binding", 422);
        const pairing = await client.query<{ claimantSessionId: string | null }>(
          "SELECT claimant_session_id::text AS \"claimantSessionId\" FROM connection_pairings WHERE id=$1 AND user_id=$2 AND consumed_at IS NOT NULL AND status IN ('authorizing','connected')",
          [pairingId, request.userId]
        );
        if (pairing.rows[0] === undefined) throw new DomainError("BROKER_SYNC_PAIRING_CHANGED", "Initial broker pairing is unavailable", 409);
        if (pairing.rows[0].claimantSessionId === null) {
          if (authorizationSagaId === undefined) throw new DomainError("BROKER_AUTHORIZATION_SAGA_NOT_FOUND", "Initial mobile broker authorization has no durable saga binding", 503);
          const saga = await client.query<{ confirmed: boolean }>(
            "SELECT status='confirmed' AS confirmed FROM broker_authorization_sagas WHERE id=$1 AND user_id=$2 AND connection_id=$3 AND pairing_id=$4",
            [authorizationSagaId, request.userId, request.connectionId, pairingId]
          );
          if (saga.rows[0]?.confirmed !== true) throw new DomainError("BROKER_AUTHORIZATION_NOT_CONFIRMED", "Initial mobile broker authorization is not confirmed", 409);
        }
      }
    });
  }

  public async persistHydration(command: PersistBrokerHydrationCommand): Promise<PersistBrokerHydrationResult> {
    const { request, hydration } = command;
    assertUuid(command.jobId, "Broker sync job");
    return await this.#withTenant(request.userId, async (client) => {
      const ownerLock = await client.query<{ locked: boolean }>("SELECT app.lock_broker_authorization_user($1) AS locked", [request.userId]);
      if (ownerLock.rows[0]?.locked !== true) throw new DomainError("BROKER_CONNECTION_NOT_READY", "Broker connection owner was not found", 409);
      const owner = await client.query<{ active: boolean }>("SELECT status='active' AND deleted_at IS NULL AS active FROM users WHERE id=$1", [request.userId]);
      if (owner.rows[0]?.active !== true) throw new DomainError("BROKER_CONNECTION_NOT_READY", "Broker connection owner is not active", 409);
      const connection = assertConnection(
        await this.#connection(client, request, true), request, hydration.snapshot.identity, command.trigger
      );
      if (command.trigger === "authorization_completed") {
        if (command.pairingId === undefined) throw new DomainError("BROKER_SYNC_PAIRING_REQUIRED", "Initial broker hydration is missing its pairing binding", 422);
        const pairing = await client.query<{ claimantSessionId: string | null }>(
          "SELECT claimant_session_id::text AS \"claimantSessionId\" FROM connection_pairings WHERE id=$1 AND user_id=$2 AND consumed_at IS NOT NULL AND status IN ('authorizing','connected') FOR UPDATE",
          [command.pairingId, request.userId]
        );
        const pairingRow = pairing.rows[0];
        if (pairingRow === undefined) throw new DomainError("BROKER_SYNC_PAIRING_CHANGED", "Initial broker pairing changed before Agentic Account verification", 409);
        if (pairingRow.claimantSessionId === null) {
          if (command.authorizationSagaId === undefined) throw new DomainError("BROKER_AUTHORIZATION_SAGA_NOT_FOUND", "Initial mobile broker authorization has no durable saga binding", 503);
          const saga = await client.query<{ status: BrokerAuthorizationSagaOperation }>(
            "SELECT status FROM broker_authorization_sagas WHERE id=$1 AND user_id=$2 AND connection_id=$3 AND pairing_id=$4 FOR UPDATE",
            [command.authorizationSagaId, request.userId, request.connectionId, command.pairingId]
          );
          if (saga.rows[0]?.status !== "confirmed") throw new DomainError("BROKER_AUTHORIZATION_NOT_CONFIRMED", "Initial mobile broker authorization is not confirmed", 409);
        }
      }
      const sourceTimestamp = hydration.snapshot.portfolio.sourceTimestamp;
      const prior = await client.query<PriorRunRow>(
        `SELECT account.id::text AS account_id,run.portfolio_snapshot_id::text,
           run.source_timestamp,run.snapshot_fingerprint,run.completed_at
         FROM broker_sync_runs AS run
         JOIN portfolio_snapshots AS snapshot
           ON snapshot.id=run.portfolio_snapshot_id AND snapshot.user_id=run.user_id
         JOIN broker_accounts AS account
           ON account.id=snapshot.broker_account_id AND account.user_id=snapshot.user_id
         WHERE run.connection_id=$1 AND run.user_id=$2
           AND (run.idempotency_key=$3 OR run.source_timestamp=$4::timestamptz)
         ORDER BY (run.idempotency_key=$3) DESC LIMIT 1`,
        [request.connectionId, request.userId, command.jobId, sourceTimestamp]
      );
      const previous = prior.rows[0];
      if (previous !== undefined) {
        if (previous.snapshot_fingerprint !== hydration.snapshotFingerprint) {
          throw new DomainError("BROKER_SYNC_IDEMPOTENCY_REUSED", "Broker sync job or source timestamp was reused with different snapshot content", 409);
        }
        return Object.freeze({
          accountId: previous.account_id,
          portfolioSnapshotId: previous.portfolio_snapshot_id,
          sourceTimestamp: previous.source_timestamp.toISOString(),
          completedAt: previous.completed_at.toISOString(),
          replayed: true
        });
      }
      const sourceMs = Date.parse(sourceTimestamp);
      if (connection.credential_bound_at !== null && sourceMs < connection.credential_bound_at.getTime() - 5_000) {
        throw new DomainError("BROKER_SNAPSHOT_PRECEDES_AUTHORIZATION", "Initial broker snapshot predates the current authorization", 409);
      }
      if (connection.last_sync_at !== null && sourceMs <= connection.last_sync_at.getTime()) {
        throw new DomainError("BROKER_SNAPSHOT_OUT_OF_ORDER", "Broker snapshots must advance monotonically", 409);
      }

      await client.query(
        "UPDATE broker_accounts SET active=false WHERE connection_id=$1 AND user_id=$2 AND active",
        [request.connectionId, request.userId]
      );
      const accountValue = hydration.snapshot.account;
      const account = await client.query<{ id: string }>(
        `INSERT INTO broker_accounts(
           connection_id,user_id,opaque_broker_id,masked_identifier,account_type,
           is_agentic_account,verified_for_trading_at,options_permission,active
         ) VALUES($1,$2,$3,$4,$5,true,$6::timestamptz,$7,true)
         ON CONFLICT(connection_id,opaque_broker_id) DO UPDATE SET
           masked_identifier=EXCLUDED.masked_identifier,
           account_type=EXCLUDED.account_type,
           is_agentic_account=true,
           verified_for_trading_at=EXCLUDED.verified_for_trading_at,
           options_permission=EXCLUDED.options_permission,
           active=true
         RETURNING id::text`,
        [
          request.connectionId,
          request.userId,
          accountValue.opaqueBrokerId,
          accountValue.maskedIdentifier,
          accountValue.accountType,
          accountValue.verifiedForTradingAt,
          accountValue.optionsPermission ?? null
        ]
      );
      const accountId = account.rows[0]?.id;
      if (accountId === undefined) throw new DomainError("BROKER_ACCOUNT_PERSISTENCE_FAILED", "Verified Agentic Account could not be persisted", 503);

      const capabilityNames = hydration.snapshot.capabilities.map((capability) => capability.toolName);
      await client.query(
        `UPDATE broker_capabilities SET unavailable_at=$2::timestamptz
         WHERE connection_id=$1 AND unavailable_at IS NULL`,
        [request.connectionId, command.completedAt]
      );
      for (const capability of hydration.snapshot.capabilities) {
        await client.query(
          `INSERT INTO broker_capabilities(
             connection_id,tool_name,input_schema,output_schema,protocol_version,
             discovered_at,last_seen_at,unavailable_at
           ) VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6::timestamptz,$7::timestamptz,NULL)
           ON CONFLICT(connection_id,tool_name,discovered_at) DO UPDATE SET
             input_schema=EXCLUDED.input_schema,
             output_schema=EXCLUDED.output_schema,
             protocol_version=EXCLUDED.protocol_version,
             last_seen_at=EXCLUDED.last_seen_at,
             unavailable_at=NULL`,
          [
            request.connectionId,
            capability.toolName,
            JSON.stringify(capability.inputSchema),
            capability.outputSchema === undefined ? null : JSON.stringify(capability.outputSchema),
            capability.protocolVersion,
            capability.discoveredAt,
            command.completedAt
          ]
        );
      }

      const portfolioSnapshotId = randomUUID();
      const portfolio = hydration.snapshot.portfolio;
      await client.query(
        `INSERT INTO portfolio_snapshots(
           id,user_id,broker_account_id,environment,total_value,buying_power,cash_value,
           source_timestamp,valid_until,data_classification
         ) VALUES($1,$2,$3,'paper',$4,$5,$6,$7::timestamptz,$8::timestamptz,'paper')`,
        [
          portfolioSnapshotId,
          request.userId,
          accountId,
          portfolio.totalValue,
          portfolio.buyingPower,
          portfolio.cashValue,
          portfolio.sourceTimestamp,
          hydration.validUntil
        ]
      );
      for (const position of portfolio.positions) {
        await client.query(
          `INSERT INTO position_snapshots(
             id,portfolio_snapshot_id,user_id,broker_position_id,symbol,instrument_type,
             quantity,average_cost,market_value,unrealized_pnl,details
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
          [
            randomUUID(),
            portfolioSnapshotId,
            request.userId,
            position.brokerPositionId,
            position.symbol,
            position.instrumentType,
            position.quantity,
            position.averageCost ?? null,
            position.marketValue,
            position.unrealizedPnl ?? null,
            JSON.stringify(position.details)
          ]
        );
      }

      const summary = Object.freeze({
        status: "connected",
        maskedAccountIdentifier: accountValue.maskedIdentifier,
        lastSuccessfulSync: sourceTimestamp,
        capabilities: capabilityNames,
        equityTradingAvailable: accountValue.equityTradingAvailable,
        optionsTradingAvailable: accountValue.optionsTradingAvailable
      });
      const updated = await client.query(
        `UPDATE broker_connections SET status='connected',connected_at=COALESCE(connected_at,$5::timestamptz),last_sync_at=$3::timestamptz,connection_summary=$4::jsonb
         WHERE id=$1 AND user_id=$2
           AND (status='connected' OR ($6='authorization_completed' AND status='pending'))
           AND revoked_at IS NULL
           AND (
             (credential_handle IS NOT NULL AND credential_bound_at IS NOT NULL AND credential_confirmed_at IS NOT NULL)
             OR
             (
               token_envelope IS NOT NULL AND token_key_id IS NOT NULL
               AND (token_expires_at IS NULL OR token_expires_at>transaction_timestamp() OR refresh_supported)
             )
           )`,
        [request.connectionId, request.userId, sourceTimestamp, JSON.stringify(summary), command.completedAt, command.trigger]
      );
      if (updated.rowCount !== 1) throw new DomainError("BROKER_CONNECTION_CHANGED", "Broker connection changed during hydration", 409);
      if (command.trigger === "authorization_completed") {
        if (command.pairingId === undefined) throw new DomainError("BROKER_SYNC_PAIRING_REQUIRED", "Initial broker hydration is missing its pairing binding", 422);
        const pairing = await client.query(
          `UPDATE connection_pairings SET status='connected'
           WHERE id=$1 AND user_id=$2 AND status='authorizing'
             AND consumed_at IS NOT NULL AND oauth_state_digest IS NULL
             AND NOT EXISTS(
               SELECT 1 FROM broker_authorization_sagas saga
               WHERE saga.user_id=$2 AND saga.pairing_id=$1 AND saga.status<>'confirmed'
             )`,
          [command.pairingId, request.userId]
        );
        if (pairing.rowCount !== 1) throw new DomainError("BROKER_SYNC_PAIRING_CHANGED", "Initial broker pairing changed before Agentic Account verification completed", 409);
      }
      await client.query(
        `INSERT INTO broker_sync_runs(
           user_id,connection_id,portfolio_snapshot_id,idempotency_key,
           snapshot_fingerprint,source_timestamp,completed_at
         ) VALUES($1,$2,$3,$4,$5,$6::timestamptz,$7::timestamptz)`,
        [
          request.userId,
          request.connectionId,
          portfolioSnapshotId,
          command.jobId,
          hydration.snapshotFingerprint,
          sourceTimestamp,
          command.completedAt
        ]
      );
      await client.query(
        `INSERT INTO audit_events(
           user_id,actor_id,actor_role,action,reason,resource_type,resource_id,
           after_state,correlation_id,occurred_at
         ) VALUES($1,'broker-sync-service','worker','broker_snapshot_hydrated',$2,
           'broker_connection',$3,$4::jsonb,$5,$6::timestamptz)`,
        [
          request.userId,
          "Approved connector snapshot committed atomically",
          request.connectionId,
          JSON.stringify({
            provider: request.provider,
            sourceTimestamp,
            positionCount: portfolio.positions.length,
            capabilities: capabilityNames
          }),
          `broker-sync:${command.jobId}`,
          command.completedAt
        ]
      );
      return Object.freeze({
        accountId,
        portfolioSnapshotId,
        sourceTimestamp,
        completedAt: command.completedAt,
        replayed: false
      });
    });
  }

  public async lagStatus(): Promise<BrokerSyncLagStatus> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE whox_broker_sync_worker");
      const result = await client.query<{
        connected_count: string;
        credential_unbound_count: string;
        lagged_count: string;
      }>("SELECT connected_count::text,credential_unbound_count::text,lagged_count::text FROM app.broker_sync_lag_status()");
      const authorization = await client.query<{ pending_count: string; stuck_count: string }>(
        "SELECT pending_count::text,stuck_count::text FROM app.broker_authorization_lag_status()"
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      const authorizationRow = authorization.rows[0];
      if (row === undefined || authorizationRow === undefined) throw new DomainError("BROKER_SYNC_HEALTH_UNAVAILABLE", "Broker sync lag status is unavailable", 503);
      return Object.freeze({
        connectedCount: Number(row.connected_count),
        credentialUnboundCount: Number(row.credential_unbound_count),
        laggedCount: Number(row.lagged_count),
        pendingAuthorizationCount: Number(authorizationRow.pending_count),
        stuckAuthorizationCount: Number(authorizationRow.stuck_count)
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async healthy(): Promise<boolean> {
    let client: PoolClient | undefined;
    try {
      client = await this.#pool.connect();
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE whox_broker_sync_worker");
      const result = await client.query<{ ready: boolean }>(
        `SELECT to_regclass('public.broker_sync_runs') IS NOT NULL
           AND EXISTS(SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='portfolio_snapshots' AND column_name='valid_until')
           AND to_regclass('public.broker_authorization_sagas') IS NOT NULL
           AND to_regclass('public.broker_authorization_exchange_attempts') IS NOT NULL
           AND to_regprocedure('app.broker_sync_lag_status()') IS NOT NULL
           AND to_regprocedure('app.requeue_stuck_broker_authorization_sagas()') IS NOT NULL
           AND to_regprocedure('app.broker_authorization_lag_status()') IS NOT NULL
           AND to_regprocedure('app.lock_broker_authorization_user(uuid)') IS NOT NULL
           AND has_function_privilege(current_user,'app.requeue_stuck_broker_authorization_sagas()','EXECUTE')
           AND has_function_privilege(current_user,'app.broker_authorization_lag_status()','EXECUTE')
           AND has_function_privilege(current_user,'app.lock_broker_authorization_user(uuid)','EXECUTE')
           AND has_table_privilege(current_user,'public.broker_authorization_sagas','SELECT')
           AND has_table_privilege(current_user,'public.broker_authorization_exchange_attempts','SELECT')
           AND has_column_privilege(current_user,'public.broker_authorization_sagas','status','UPDATE')
           AND has_column_privilege(current_user,'public.broker_authorization_sagas','credential_handle','UPDATE')
           AND has_column_privilege(current_user,'public.broker_authorization_exchange_attempts','status','UPDATE')
           AND has_column_privilege(current_user,'public.broker_authorization_exchange_attempts','revoked_at','UPDATE')
           AND has_column_privilege(current_user,'public.connection_pairings','status','UPDATE') AS ready`
      );
      await client.query("COMMIT");
      return result.rows[0]?.ready === true;
    } catch {
      await client?.query("ROLLBACK").catch(() => undefined);
      return false;
    } finally {
      client?.release();
    }
  }

  public async close(): Promise<void> {
    await this.#pool.end();
  }
}
