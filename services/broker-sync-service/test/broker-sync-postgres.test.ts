import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { DomainError, type ApprovedBrokerConnectorIdentity, type ApprovedBrokerSnapshotConnector, type BrokerHydrationSnapshot } from "@whox/contracts";
import { Pool } from "pg";
import { BrokerSyncProcessor } from "../src/broker-sync.js";
import { PostgresBrokerSyncPersistence } from "../src/persistence.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const identity: ApprovedBrokerConnectorIdentity = Object.freeze({
  provider: "robinhood_mcp",
  adapterId: "approved-postgres-fake",
  approvalReference: "review:test-postgres-sync",
  authorizationIssuer: "https://auth.postgres-fake.test/",
  resourceUri: "https://mcp.postgres-fake.test/",
  protocolVersion: "test-1"
});

function hydration(sourceTimestamp: string, totalValue = 25_000): BrokerHydrationSnapshot {
  return {
    identity,
    account: {
      opaqueBrokerId: "opaque-agentic-account",
      maskedIdentifier: "Agentic account •••• 1234",
      accountType: "individual_agentic",
      isAgenticAccount: true,
      equityTradingAvailable: true,
      optionsTradingAvailable: false,
      verifiedForTradingAt: new Date(Date.parse(sourceTimestamp) - 60_000).toISOString()
    },
    capabilities: ["get_accounts", "get_portfolio"].map((toolName) => ({
      toolName,
      inputSchema: {},
      discoveredAt: sourceTimestamp,
      protocolVersion: "test-1"
    })),
    portfolio: {
      sourceTimestamp,
      totalValue,
      buyingPower: 8_000,
      cashValue: 5_000,
      positions: [{
        brokerPositionId: "position-aapl",
        symbol: "AAPL",
        instrumentType: "equity",
        quantity: 10,
        averageCost: 190,
        marketValue: 2_000,
        unrealizedPnl: 100,
        details: { source: "approved-postgres-fake" }
      }]
    }
  };
}

function fakeConnector(snapshot: BrokerHydrationSnapshot): ApprovedBrokerSnapshotConnector {
  return Object.freeze({ identity, async fetchHydrationSnapshot() { return snapshot; } });
}

async function insertPendingConnection(pool: Pool, userId: string, connectionId: string, sourceTimestamp: string): Promise<{ pairingId: string; authorizationSagaId: string }> {
  const pairingId = randomUUID();
  const exchangeTransactionId = randomUUID();
  const authorizationSagaId = randomUUID();
  const credentialHandle = `vault:postgres-fake:${connectionId}`;
  await pool.query("INSERT INTO users(id,email,account_mode) VALUES($1,$2,'paper')", [userId, `${userId}@broker-sync.test`]);
  await pool.query(
    `INSERT INTO broker_connections(
       id,user_id,provider,status,authorization_issuer,resource_uri,credential_handle,
       credential_bound_at,credential_confirmed_at,connector_adapter_id,
       connector_approval_reference,connector_protocol_version
     ) VALUES($1,$2,'robinhood_mcp','pending',$3,$4,$5,$6,$6,$7,$8,$9)`,
    [
      connectionId,
      userId,
      identity.authorizationIssuer,
      identity.resourceUri,
      credentialHandle,
      sourceTimestamp,
      identity.adapterId,
      identity.approvalReference,
      identity.protocolVersion
    ]
  );
  await pool.query(
    `INSERT INTO connection_pairings(
       id,user_id,code_digest,status,expires_at,consumed_at,created_at
     ) VALUES($1,$2,decode(repeat('ab',32),'hex'),'authorizing',$3,$4,$4)`,
    [pairingId, userId, new Date(Date.parse(sourceTimestamp) + 10 * 60_000).toISOString(), sourceTimestamp]
  );
  await pool.query(
    `INSERT INTO broker_authorization_exchange_attempts(
       user_id,pairing_id,exchange_transaction_id,provider,authorization_issuer,resource_uri,
       connector_adapter_id,connector_approval_reference,connector_protocol_version,status,
       cleanup_after,completed_at,created_at,updated_at
     ) VALUES($1,$2,$3,'robinhood_mcp',$4,$5,$6,$7,$8,'completed',$9,$10,$10,$10)`,
    [userId, pairingId, exchangeTransactionId, identity.authorizationIssuer, identity.resourceUri, identity.adapterId, identity.approvalReference, identity.protocolVersion, new Date(Date.parse(sourceTimestamp) + 10 * 60_000).toISOString(), sourceTimestamp]
  );
  await pool.query(
    `INSERT INTO broker_authorization_sagas(
       id,user_id,pairing_id,connection_id,provider,exchange_transaction_id,credential_handle,
       authorization_issuer,resource_uri,connector_adapter_id,connector_approval_reference,
       connector_protocol_version,connection_summary,status,confirmation_deadline_at,
       confirmation_acknowledged_at,created_at,updated_at
     ) VALUES($1,$2,$3,$4,'robinhood_mcp',$5,$6,$7,$8,$9,$10,$11,$12::jsonb,'confirmed',$13,$14,$14,$14)`,
    [authorizationSagaId, userId, pairingId, connectionId, exchangeTransactionId, credentialHandle, identity.authorizationIssuer, identity.resourceUri, identity.adapterId, identity.approvalReference, identity.protocolVersion, JSON.stringify({ status: "connected", capabilities: [], equityTradingAvailable: false, optionsTradingAvailable: false }), new Date(Date.parse(sourceTimestamp) + 5 * 60_000).toISOString(), sourceTimestamp]
  );
  return { pairingId, authorizationSagaId };
}

describe("PostgreSQL broker hydration transaction", { skip: databaseUrl === undefined }, () => {
  it("commits a complete snapshot once and rolls back partial mutations on failure", async () => {
    const admin = new Pool({ connectionString: databaseUrl });
    const persistence = new PostgresBrokerSyncPersistence(databaseUrl!);
    const sourceTimestamp = new Date().toISOString();
    const userId = randomUUID();
    const connectionId = randomUUID();
    try {
      const baselineLagStatus = await persistence.lagStatus();
      const { pairingId, authorizationSagaId } = await insertPendingConnection(admin, userId, connectionId, sourceTimestamp);
      const before = await admin.query<{ connection_status: string; pairing_status: string }>(
        `SELECT connection.status AS connection_status,pairing.status AS pairing_status
         FROM broker_connections connection JOIN connection_pairings pairing ON pairing.user_id=connection.user_id
         WHERE connection.id=$1 AND pairing.id=$2`,
        [connectionId, pairingId]
      );
      assert.deepEqual(before.rows[0], { connection_status: "pending", pairing_status: "authorizing" });
      const processor = new BrokerSyncProcessor(fakeConnector(hydration(sourceTimestamp)), persistence, {
        now: () => new Date(sourceTimestamp)
      });
      const first = await processor.process({
        jobId: randomUUID(),
        userId,
        payload: { connectionId, provider: "robinhood_mcp", trigger: "authorization_completed", pairingId, authorizationSagaId }
      });
      assert.equal(first.replayed, false);
      const committed = await admin.query<{
        last_sync_at: Date;
        account_count: string;
        capability_count: string;
        snapshot_count: string;
        position_count: string;
        run_count: string;
        audit_count: string;
        equity_available: boolean;
        valid_until: Date;
        connection_status: string;
        pairing_status: string;
      }>(
        `SELECT connection.last_sync_at,connection.status AS connection_status,
           (SELECT count(*)::text FROM broker_accounts WHERE connection_id=connection.id) AS account_count,
           (SELECT count(*)::text FROM broker_capabilities WHERE connection_id=connection.id AND unavailable_at IS NULL) AS capability_count,
           (SELECT count(*)::text FROM portfolio_snapshots WHERE user_id=connection.user_id) AS snapshot_count,
           (SELECT count(*)::text FROM position_snapshots WHERE user_id=connection.user_id) AS position_count,
           (SELECT count(*)::text FROM broker_sync_runs WHERE connection_id=connection.id) AS run_count,
           (SELECT count(*)::text FROM audit_events WHERE user_id=connection.user_id AND action='broker_snapshot_hydrated') AS audit_count,
           COALESCE((connection.connection_summary->>'equityTradingAvailable')::boolean,true) AS equity_available,
           (SELECT valid_until FROM portfolio_snapshots WHERE user_id=connection.user_id LIMIT 1) AS valid_until,
           (SELECT status FROM connection_pairings WHERE id=$2 AND user_id=connection.user_id) AS pairing_status
         FROM broker_connections AS connection WHERE connection.id=$1`,
        [connectionId, pairingId]
      );
      assert.deepEqual({ ...committed.rows[0], last_sync_at: committed.rows[0]?.last_sync_at.toISOString(), valid_until: committed.rows[0]?.valid_until.toISOString() }, {
        last_sync_at: sourceTimestamp,
        account_count: "1",
        capability_count: "2",
        snapshot_count: "1",
        position_count: "1",
        run_count: "1",
        audit_count: "1",
        equity_available: false,
        valid_until: new Date(Date.parse(sourceTimestamp) + 60_000).toISOString(),
        connection_status: "connected",
        pairing_status: "connected"
      });
      const currentLagStatus = await persistence.lagStatus();
      assert.deepEqual({
        connectedCount: currentLagStatus.connectedCount - baselineLagStatus.connectedCount,
        credentialUnboundCount: currentLagStatus.credentialUnboundCount - baselineLagStatus.credentialUnboundCount,
        laggedCount: currentLagStatus.laggedCount - baselineLagStatus.laggedCount
      }, { connectedCount: 1, credentialUnboundCount: 0, laggedCount: 0 }, "this synchronized Paper connection must add one healthy connection without changing other fixtures");

      const replay = await processor.process({
        jobId: randomUUID(),
        userId,
        payload: { connectionId, provider: "robinhood_mcp", trigger: "scheduled", scheduleBucket: 1 }
      });
      assert.equal(replay.replayed, true);
      assert.equal((await admin.query("SELECT id FROM broker_sync_runs WHERE connection_id=$1", [connectionId])).rowCount, 1);
      assert.equal((await admin.query("SELECT id FROM portfolio_snapshots WHERE user_id=$1", [userId])).rowCount, 1);

      const nextSourceTimestamp = new Date(Date.parse(sourceTimestamp) + 10_000).toISOString();
      const advancingProcessor = new BrokerSyncProcessor(fakeConnector(hydration(nextSourceTimestamp)), persistence, {
        now: () => new Date(nextSourceTimestamp)
      });
      const advanced = await advancingProcessor.process({
        jobId: randomUUID(),
        userId,
        payload: { connectionId, provider: "robinhood_mcp", trigger: "scheduled", scheduleBucket: 2 }
      });
      assert.equal(advanced.replayed, false);
      const capabilityHistory = await admin.query<{ total: string; current: string }>(
        "SELECT count(*)::text AS total,count(*) FILTER (WHERE unavailable_at IS NULL)::text AS current FROM broker_capabilities WHERE connection_id=$1",
        [connectionId]
      );
      assert.deepEqual(capabilityHistory.rows[0], { total: "4", current: "2" });
      assert.equal((await admin.query("SELECT id FROM portfolio_snapshots WHERE user_id=$1", [userId])).rowCount, 2);
      assert.equal(await persistence.requestAuthorizationRevocation(userId, authorizationSagaId, "USER_REQUESTED_DISCONNECT", new Date(Date.parse(sourceTimestamp) + 20_000).toISOString()), "revoke_pending");
      assert.equal(await persistence.acknowledgeAuthorizationRevocation(userId, authorizationSagaId, new Date(Date.parse(sourceTimestamp) + 21_000).toISOString()), "revoked");
      assert.deepEqual((await admin.query<{ connection_status: string; saga_status: string }>(`SELECT connection.status AS connection_status,saga.status AS saga_status FROM broker_connections connection JOIN broker_authorization_sagas saga ON saga.connection_id=connection.id AND saga.user_id=connection.user_id WHERE connection.id=$1 AND saga.id=$2`, [connectionId, authorizationSagaId])).rows[0], { connection_status: "revoked", saga_status: "revoked" });

      const failedUserId = randomUUID();
      const failedConnectionId = randomUUID();
      const { pairingId: failedPairingId, authorizationSagaId: failedAuthorizationSagaId } = await insertPendingConnection(admin, failedUserId, failedConnectionId, sourceTimestamp);
      const overflow = new BrokerSyncProcessor(fakeConnector(hydration(sourceTimestamp, Number.MAX_VALUE)), persistence, {
        now: () => new Date(sourceTimestamp)
      });
      await assert.rejects(overflow.process({
        jobId: randomUUID(),
        userId: failedUserId,
        payload: { connectionId: failedConnectionId, provider: "robinhood_mcp", trigger: "authorization_completed", pairingId: failedPairingId, authorizationSagaId: failedAuthorizationSagaId }
      }));
      const rolledBack = await admin.query<{ last_sync_is_null: boolean; connection_status: string; pairing_status: string; accounts: string; capabilities: string; snapshots: string; runs: string }>(
        `SELECT connection.last_sync_at IS NULL AS last_sync_is_null,connection.status AS connection_status,
           (SELECT status FROM connection_pairings WHERE id=$2 AND user_id=connection.user_id) AS pairing_status,
           (SELECT count(*)::text FROM broker_accounts WHERE connection_id=connection.id) AS accounts,
           (SELECT count(*)::text FROM broker_capabilities WHERE connection_id=connection.id) AS capabilities,
           (SELECT count(*)::text FROM portfolio_snapshots WHERE user_id=connection.user_id) AS snapshots,
           (SELECT count(*)::text FROM broker_sync_runs WHERE connection_id=connection.id) AS runs
         FROM broker_connections AS connection WHERE connection.id=$1`,
        [failedConnectionId, failedPairingId]
      );
      assert.deepEqual(rolledBack.rows[0], { last_sync_is_null: true, connection_status: "pending", pairing_status: "authorizing", accounts: "0", capabilities: "0", snapshots: "0", runs: "0" });

      const expiredUserId = randomUUID();
      const expiredConnectionId = randomUUID();
      await admin.query("INSERT INTO users(id,email,account_mode) VALUES($1,$2,'paper')", [expiredUserId, `${expiredUserId}@broker-sync.test`]);
      await admin.query(
        `INSERT INTO broker_connections(
           id,user_id,provider,status,authorization_issuer,resource_uri,token_envelope,
           token_key_id,token_expires_at,refresh_supported,connector_adapter_id,
           connector_approval_reference,connector_protocol_version,connected_at
         ) VALUES($1,$2,'robinhood_mcp','connected',$3,$4,'{}'::jsonb,'expired-test-key',$5,false,$6,$7,$8,$9)`,
        [expiredConnectionId, expiredUserId, identity.authorizationIssuer, identity.resourceUri, new Date(Date.parse(sourceTimestamp) - 1_000).toISOString(), identity.adapterId, identity.approvalReference, identity.protocolVersion, new Date(Date.parse(sourceTimestamp) - 120_000).toISOString()]
      );
      let providerCalls = 0;
      const expiredConnector: ApprovedBrokerSnapshotConnector = {
        identity,
        async fetchHydrationSnapshot() { providerCalls += 1; return hydration(sourceTimestamp); }
      };
      const expiredProcessor = new BrokerSyncProcessor(expiredConnector, persistence, { now: () => new Date(sourceTimestamp) });
      await assert.rejects(expiredProcessor.process({
        jobId: randomUUID(),
        userId: expiredUserId,
        payload: { connectionId: expiredConnectionId, provider: "robinhood_mcp", trigger: "scheduled", scheduleBucket: 1 }
      }), (error: unknown) => error instanceof DomainError && error.code === "BROKER_CREDENTIAL_BINDING_REQUIRED");
      assert.equal(providerCalls, 0, "an expired non-refreshable token must fail before the connector call");
    } finally {
      await persistence.close();
      await admin.end();
    }
  });
});
