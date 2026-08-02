BEGIN;

-- OAuth exchange writes a provisional vault handle before the API can commit
-- its tenant binding. Workers must not resolve that handle until the isolated
-- connector confirms persistence and the API records that confirmation.
ALTER TABLE broker_connections
  ADD COLUMN credential_confirmed_at timestamptz;

UPDATE broker_connections
SET credential_confirmed_at=credential_bound_at
WHERE credential_handle IS NOT NULL
  AND credential_bound_at IS NOT NULL
  AND status='connected';

ALTER TABLE broker_connections
  ADD CONSTRAINT broker_connection_credential_confirmation_complete CHECK (
    (credential_handle IS NULL AND credential_confirmed_at IS NULL)
    OR
    (
      credential_handle IS NOT NULL
      AND credential_bound_at IS NOT NULL
      AND (
        credential_confirmed_at IS NULL
        OR credential_confirmed_at>=credential_bound_at
      )
    )
  );

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
        (
          connection.credential_handle IS NOT NULL
          AND connection.credential_bound_at IS NOT NULL
          AND connection.credential_confirmed_at IS NOT NULL
        )
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
