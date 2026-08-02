BEGIN;

-- Authorization adapters persist credentials in an isolated encrypted store
-- before completing pairing, then bind only an opaque lookup handle here. The
-- handle is confidential server metadata and never enters a queue payload.
ALTER TABLE broker_connections
  ADD COLUMN credential_handle text,
  ADD COLUMN credential_bound_at timestamptz,
  ADD COLUMN connector_adapter_id text,
  ADD COLUMN connector_approval_reference text,
  ADD COLUMN connector_protocol_version text,
  ADD CONSTRAINT broker_connection_credential_binding_complete CHECK (
    (credential_handle IS NULL AND credential_bound_at IS NULL)
    OR
    (credential_handle ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{15,254}$' AND credential_bound_at IS NOT NULL)
  ),
  ADD CONSTRAINT broker_connection_connector_binding_complete CHECK (
    (connector_adapter_id IS NULL AND connector_approval_reference IS NULL AND connector_protocol_version IS NULL)
    OR
    (
      connector_adapter_id ~ '^[a-z0-9][a-z0-9._-]{2,99}$'
      AND connector_approval_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$'
      AND connector_protocol_version ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$'
    )
  );

-- Paper snapshots are usable only for a bounded interval chosen by the
-- reviewed sync worker. Existing non-Demo rows are expired rather than being
-- silently trusted; Demo fixtures remain available indefinitely in Demo only.
ALTER TABLE portfolio_snapshots ADD COLUMN valid_until timestamptz;
UPDATE portfolio_snapshots
SET valid_until = CASE
  WHEN environment = 'demo' THEN 'infinity'::timestamptz
  ELSE source_timestamp + interval '1 microsecond'
END;
ALTER TABLE portfolio_snapshots
  ALTER COLUMN valid_until SET NOT NULL,
  ADD CONSTRAINT portfolio_snapshot_validity_window
    CHECK (valid_until > source_timestamp),
  ADD CONSTRAINT portfolio_snapshot_classification_matches_environment
    CHECK (data_classification = environment::text) NOT VALID;

-- A completed receipt makes broker hydration idempotent across worker lease
-- loss. The fingerprint binds a queue job and provider source timestamp to the
-- exact normalized snapshot that committed.
CREATE TABLE broker_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  connection_id uuid NOT NULL,
  portfolio_snapshot_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  snapshot_fingerprint text NOT NULL CHECK (snapshot_fingerprint ~ '^[0-9a-f]{64}$'),
  source_timestamp timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (connection_id,user_id)
    REFERENCES broker_connections(id,user_id) ON DELETE RESTRICT,
  FOREIGN KEY (portfolio_snapshot_id,user_id)
    REFERENCES portfolio_snapshots(id,user_id) ON DELETE RESTRICT,
  UNIQUE(connection_id,idempotency_key),
  UNIQUE(connection_id,source_timestamp)
);

ALTER TABLE broker_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE broker_sync_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON broker_sync_runs
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());

CREATE TRIGGER broker_sync_runs_immutable
  BEFORE UPDATE OR DELETE ON broker_sync_runs
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();

CREATE INDEX broker_sync_runs_user_time_idx
  ON broker_sync_runs(user_id,completed_at DESC);

-- Worker readiness needs aggregate lag only; no tenant identifiers or balances
-- leave this SECURITY DEFINER boundary.
CREATE OR REPLACE FUNCTION app.broker_sync_lag_status()
RETURNS TABLE(connected_count bigint, credential_unbound_count bigint, lagged_count bigint)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public,pg_temp
AS $$
  WITH connected AS (
    SELECT connection.id,connection.user_id,
      (
        (connection.credential_handle IS NOT NULL AND connection.credential_bound_at IS NOT NULL)
        OR
        (
          connection.token_envelope IS NOT NULL
          AND connection.token_key_id IS NOT NULL
          AND (
            connection.token_expires_at IS NULL
            OR connection.token_expires_at>transaction_timestamp()
            OR connection.refresh_supported
          )
        )
      ) AS credential_bound
    FROM broker_connections AS connection
    JOIN users AS owner ON owner.id=connection.user_id
    WHERE connection.provider='robinhood_mcp'
      AND connection.status='connected'
      AND connection.revoked_at IS NULL
      AND owner.account_mode='paper'
      AND owner.status='active'
  )
  SELECT
    count(*)::bigint,
    count(*) FILTER (WHERE NOT connected.credential_bound)::bigint,
    count(*) FILTER (
      WHERE connected.credential_bound AND NOT EXISTS (
        SELECT 1
        FROM broker_accounts AS account
        JOIN portfolio_snapshots AS snapshot
          ON snapshot.broker_account_id=account.id AND snapshot.user_id=account.user_id
        JOIN broker_connections AS bound_connection
          ON bound_connection.id=account.connection_id AND bound_connection.user_id=account.user_id
        WHERE account.connection_id=connected.id
          AND account.user_id=connected.user_id
          AND account.active
          AND account.is_agentic_account
          AND account.verified_for_trading_at IS NOT NULL
          AND snapshot.environment='paper'
          AND snapshot.data_classification='paper'
          AND snapshot.valid_until>transaction_timestamp()
          AND bound_connection.last_sync_at>=snapshot.source_timestamp
      )
    )::bigint
  FROM connected
$$;

REVOKE ALL ON FUNCTION app.broker_sync_lag_status() FROM PUBLIC;

COMMIT;
