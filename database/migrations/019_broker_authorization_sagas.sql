BEGIN;

ALTER TABLE connection_pairings
  ADD CONSTRAINT connection_pairings_id_user_unique UNIQUE (id,user_id);

CREATE TABLE broker_authorization_exchange_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  pairing_id uuid NOT NULL,
  exchange_transaction_id uuid NOT NULL UNIQUE,
  provider text NOT NULL CHECK (provider='robinhood_mcp'),
  authorization_issuer text NOT NULL,
  resource_uri text NOT NULL,
  connector_adapter_id text NOT NULL,
  connector_approval_reference text NOT NULL,
  connector_protocol_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('exchange_pending','completed','revoke_pending','revoked')),
  cleanup_after timestamptz NOT NULL,
  completed_at timestamptz,
  revocation_requested_at timestamptz,
  revoked_at timestamptz,
  recovery_generation integer NOT NULL DEFAULT 0 CHECK (recovery_generation>=0),
  last_error_code text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE(user_id,pairing_id),
  UNIQUE(exchange_transaction_id,user_id,pairing_id),
  FOREIGN KEY (pairing_id,user_id) REFERENCES connection_pairings(id,user_id) ON DELETE RESTRICT,
  CHECK (cleanup_after>created_at),
  CHECK ((status='completed')=(completed_at IS NOT NULL)),
  CHECK ((status IN ('revoke_pending','revoked'))=(revocation_requested_at IS NOT NULL)),
  CHECK ((status='revoked')=(revoked_at IS NOT NULL)),
  CHECK (completed_at IS NULL OR (completed_at>=created_at AND completed_at<=cleanup_after)),
  CHECK (revocation_requested_at IS NULL OR revocation_requested_at>=created_at),
  CHECK (revoked_at IS NULL OR revoked_at>=revocation_requested_at)
);
CREATE INDEX broker_authorization_exchange_attempts_pending_idx
  ON broker_authorization_exchange_attempts(status,updated_at)
  WHERE status IN ('exchange_pending','revoke_pending');

CREATE OR REPLACE FUNCTION protect_broker_authorization_exchange_binding()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.user_id IS DISTINCT FROM NEW.user_id
    OR OLD.pairing_id IS DISTINCT FROM NEW.pairing_id
    OR OLD.exchange_transaction_id IS DISTINCT FROM NEW.exchange_transaction_id
    OR OLD.provider IS DISTINCT FROM NEW.provider
    OR OLD.authorization_issuer IS DISTINCT FROM NEW.authorization_issuer
    OR OLD.resource_uri IS DISTINCT FROM NEW.resource_uri
    OR OLD.connector_adapter_id IS DISTINCT FROM NEW.connector_adapter_id
    OR OLD.connector_approval_reference IS DISTINCT FROM NEW.connector_approval_reference
    OR OLD.connector_protocol_version IS DISTINCT FROM NEW.connector_protocol_version
    OR OLD.cleanup_after IS DISTINCT FROM NEW.cleanup_after
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'broker authorization exchange binding is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.recovery_generation<OLD.recovery_generation THEN
    RAISE EXCEPTION 'broker authorization exchange recovery generation cannot decrease' USING ERRCODE='55000';
  END IF;
  IF OLD.completed_at IS DISTINCT FROM NEW.completed_at
    AND NOT (OLD.status='exchange_pending' AND NEW.status='completed'
      AND OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'broker authorization exchange completion timestamp is immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.revocation_requested_at IS DISTINCT FROM NEW.revocation_requested_at
    AND NOT (OLD.status='exchange_pending' AND NEW.status='revoke_pending'
      AND OLD.revocation_requested_at IS NULL AND NEW.revocation_requested_at IS NOT NULL) THEN
    RAISE EXCEPTION 'broker authorization exchange revocation request timestamp is immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.revoked_at IS DISTINCT FROM NEW.revoked_at
    AND NOT (OLD.status='revoke_pending' AND NEW.status='revoked'
      AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'broker authorization exchange revocation timestamp is immutable' USING ERRCODE='55000';
  END IF;
  IF NOT (
    OLD.status=NEW.status
    OR (OLD.status='exchange_pending' AND NEW.status IN ('completed','revoke_pending'))
    OR (OLD.status='revoke_pending' AND NEW.status='revoked')
  ) THEN
    RAISE EXCEPTION 'broker authorization exchange transition is invalid' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER broker_authorization_exchange_binding_guard
BEFORE UPDATE ON broker_authorization_exchange_attempts
FOR EACH ROW EXECUTE FUNCTION protect_broker_authorization_exchange_binding();
REVOKE ALL ON FUNCTION protect_broker_authorization_exchange_binding() FROM PUBLIC;
CREATE TRIGGER broker_authorization_exchange_updated_at
BEFORE UPDATE ON broker_authorization_exchange_attempts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE broker_authorization_sagas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  pairing_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider='robinhood_mcp'),
  exchange_transaction_id uuid NOT NULL UNIQUE,
  credential_handle text CHECK (credential_handle IS NULL OR credential_handle ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{15,254}$'),
  authorization_issuer text NOT NULL,
  resource_uri text NOT NULL,
  connector_adapter_id text NOT NULL,
  connector_approval_reference text NOT NULL,
  connector_protocol_version text NOT NULL,
  connection_summary jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('confirm_pending','confirmed','revoke_pending','revoked')),
  confirmation_deadline_at timestamptz NOT NULL,
  confirmation_acknowledged_at timestamptz,
  revocation_requested_at timestamptz,
  revoked_at timestamptz,
  recovery_generation integer NOT NULL DEFAULT 0 CHECK (recovery_generation>=0),
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(user_id,pairing_id),
  FOREIGN KEY (pairing_id,user_id) REFERENCES connection_pairings(id,user_id) ON DELETE RESTRICT,
  FOREIGN KEY (exchange_transaction_id,user_id,pairing_id)
    REFERENCES broker_authorization_exchange_attempts(exchange_transaction_id,user_id,pairing_id) ON DELETE RESTRICT,
  FOREIGN KEY (connection_id,user_id) REFERENCES broker_connections(id,user_id) ON DELETE RESTRICT,
  CHECK ((status='revoked')=(credential_handle IS NULL)),
  CHECK (confirmation_deadline_at>created_at),
  CHECK ((status='confirmed')=(confirmation_acknowledged_at IS NOT NULL AND revocation_requested_at IS NULL AND revoked_at IS NULL)
    OR status IN ('revoke_pending','revoked')),
  CHECK ((status IN ('revoke_pending','revoked'))=(revocation_requested_at IS NOT NULL)),
  CHECK ((status='revoked')=(revoked_at IS NOT NULL)),
  CHECK (confirmation_acknowledged_at IS NULL OR
    (confirmation_acknowledged_at>=created_at AND confirmation_acknowledged_at<confirmation_deadline_at)),
  CHECK (revocation_requested_at IS NULL OR revocation_requested_at>=created_at),
  CHECK (revocation_requested_at IS NULL OR confirmation_acknowledged_at IS NULL OR
    revocation_requested_at>=confirmation_acknowledged_at),
  CHECK (revoked_at IS NULL OR revoked_at>=revocation_requested_at)
);

CREATE UNIQUE INDEX broker_authorization_sagas_credential_handle_unique
  ON broker_authorization_sagas(credential_handle)
  WHERE credential_handle IS NOT NULL;
CREATE UNIQUE INDEX broker_authorization_sagas_active_connection_unique
  ON broker_authorization_sagas(connection_id)
  WHERE status<>'revoked';
CREATE INDEX broker_authorization_sagas_pending_idx
  ON broker_authorization_sagas(status,updated_at)
  WHERE status IN ('confirm_pending','revoke_pending');

CREATE OR REPLACE FUNCTION protect_broker_authorization_saga_binding()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.user_id IS DISTINCT FROM NEW.user_id
    OR OLD.pairing_id IS DISTINCT FROM NEW.pairing_id
    OR OLD.connection_id IS DISTINCT FROM NEW.connection_id
    OR OLD.provider IS DISTINCT FROM NEW.provider
    OR OLD.exchange_transaction_id IS DISTINCT FROM NEW.exchange_transaction_id
    OR OLD.authorization_issuer IS DISTINCT FROM NEW.authorization_issuer
    OR OLD.resource_uri IS DISTINCT FROM NEW.resource_uri
    OR OLD.connector_adapter_id IS DISTINCT FROM NEW.connector_adapter_id
    OR OLD.connector_approval_reference IS DISTINCT FROM NEW.connector_approval_reference
    OR OLD.connector_protocol_version IS DISTINCT FROM NEW.connector_protocol_version
    OR OLD.connection_summary IS DISTINCT FROM NEW.connection_summary
    OR OLD.confirmation_deadline_at IS DISTINCT FROM NEW.confirmation_deadline_at
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'broker authorization saga binding is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.recovery_generation<OLD.recovery_generation THEN
    RAISE EXCEPTION 'broker authorization saga recovery generation cannot decrease' USING ERRCODE='55000';
  END IF;
  IF OLD.confirmation_acknowledged_at IS DISTINCT FROM NEW.confirmation_acknowledged_at
    AND NOT (OLD.status='confirm_pending' AND NEW.status='confirmed'
      AND OLD.confirmation_acknowledged_at IS NULL AND NEW.confirmation_acknowledged_at IS NOT NULL) THEN
    RAISE EXCEPTION 'broker authorization confirmation timestamp is immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.revocation_requested_at IS DISTINCT FROM NEW.revocation_requested_at
    AND NOT (OLD.status IN ('confirm_pending','confirmed') AND NEW.status='revoke_pending'
      AND OLD.revocation_requested_at IS NULL AND NEW.revocation_requested_at IS NOT NULL) THEN
    RAISE EXCEPTION 'broker authorization revocation request timestamp is immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.revoked_at IS DISTINCT FROM NEW.revoked_at
    AND NOT (OLD.status='revoke_pending' AND NEW.status='revoked'
      AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'broker authorization revocation timestamp is immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.credential_handle IS DISTINCT FROM NEW.credential_handle
    AND NOT (OLD.status='revoke_pending' AND NEW.status='revoked' AND OLD.credential_handle IS NOT NULL AND NEW.credential_handle IS NULL) THEN
    RAISE EXCEPTION 'broker authorization saga credential binding is immutable until revocation acknowledgment' USING ERRCODE='55000';
  END IF;
  IF NOT (
    OLD.status=NEW.status
    OR (OLD.status='confirm_pending' AND NEW.status IN ('confirmed','revoke_pending'))
    OR (OLD.status='confirmed' AND NEW.status='revoke_pending')
    OR (OLD.status='revoke_pending' AND NEW.status='revoked')
  ) THEN
    RAISE EXCEPTION 'broker authorization saga transition is invalid' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER broker_authorization_sagas_binding_guard
BEFORE UPDATE ON broker_authorization_sagas
FOR EACH ROW EXECUTE FUNCTION protect_broker_authorization_saga_binding();
REVOKE ALL ON FUNCTION protect_broker_authorization_saga_binding() FROM PUBLIC;
CREATE TRIGGER broker_authorization_sagas_updated_at
BEFORE UPDATE ON broker_authorization_sagas
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION app.lock_broker_authorization_user(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
BEGIN
  IF p_user_id IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'broker authorization tenant mismatch' USING ERRCODE='42501';
  END IF;
  PERFORM id FROM public.users WHERE id=p_user_id FOR UPDATE;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION app.lock_broker_authorization_user(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.requeue_stuck_broker_authorization_sagas()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
DECLARE
  queued_count integer;
  exchange_count integer;
BEGIN
  WITH candidates AS (
    SELECT saga.id,saga.status,saga.connection_id,saga.pairing_id
    FROM public.broker_authorization_sagas AS saga
    JOIN public.broker_connections AS connection
      ON connection.id=saga.connection_id AND connection.user_id=saga.user_id
    WHERE saga.updated_at<clock_timestamp()-interval '5 minutes'
      AND (
        (saga.status IN ('confirm_pending','revoke_pending') AND NOT EXISTS (
          SELECT 1 FROM public.queue_jobs AS job
          WHERE job.user_id=saga.user_id
            AND job.queue_name='broker-sync'
            AND job.job_type='reconcile_broker_authorization'
            AND job.payload->>'authorizationSagaId'=saga.id::text
            AND job.status IN ('queued','failed','leased')
        ))
        OR
        (saga.status='confirmed' AND connection.status='pending' AND connection.revoked_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.queue_jobs AS job
            WHERE job.user_id=saga.user_id
              AND job.queue_name='broker-sync'
              AND job.job_type='hydrate_broker_account'
              AND job.payload->>'authorizationSagaId'=saga.id::text
              AND job.status IN ('queued','failed','leased')
          )
        )
      )
    ORDER BY saga.updated_at,saga.id
    LIMIT 100
    FOR UPDATE OF saga SKIP LOCKED
  ), advanced AS (
    UPDATE public.broker_authorization_sagas AS saga
    SET recovery_generation=saga.recovery_generation+1,
        last_error_code=CASE WHEN candidates.status='confirmed'
          THEN 'INITIAL_HYDRATION_RECOVERY_REQUEUED'
          ELSE COALESCE(saga.last_error_code,'AUTHORIZATION_RECOVERY_REQUEUED') END
    FROM candidates WHERE saga.id=candidates.id
    RETURNING saga.id,saga.user_id,saga.connection_id,saga.pairing_id,saga.status,saga.recovery_generation
  )
  INSERT INTO public.queue_jobs(queue_name,user_id,job_type,payload,idempotency_key,priority,max_attempts)
  SELECT 'broker-sync',advanced.user_id,
    CASE WHEN advanced.status='confirmed' THEN 'hydrate_broker_account' ELSE 'reconcile_broker_authorization' END,
    CASE WHEN advanced.status='confirmed' THEN jsonb_build_object(
      'connectionId',advanced.connection_id::text,
      'pairingId',advanced.pairing_id::text,
      'authorizationSagaId',advanced.id::text,
      'provider','robinhood_mcp',
      'trigger','authorization_completed'
    ) ELSE jsonb_build_object('authorizationSagaId',advanced.id::text) END,
    CASE WHEN advanced.status='confirmed' THEN 'initial-broker-sync-recovery:' ELSE 'broker-auth-recovery:' END
      ||advanced.id::text||':'||advanced.recovery_generation::text,
    CASE WHEN advanced.status='confirmed' THEN 25 ELSE 1 END,
    CASE WHEN advanced.status='confirmed' THEN 10 ELSE 25 END
  FROM advanced
  ON CONFLICT(queue_name,idempotency_key) DO NOTHING;
  GET DIAGNOSTICS queued_count=ROW_COUNT;

  WITH candidates AS (
    SELECT attempt.id
    FROM public.broker_authorization_exchange_attempts AS attempt
    WHERE attempt.status IN ('exchange_pending','revoke_pending')
      AND attempt.updated_at<clock_timestamp()-interval '5 minutes'
      AND (attempt.status='revoke_pending' OR attempt.cleanup_after<=clock_timestamp())
      AND NOT EXISTS (
        SELECT 1 FROM public.queue_jobs AS job
        WHERE job.user_id=attempt.user_id
          AND job.queue_name='broker-sync'
          AND job.job_type='reconcile_broker_authorization_exchange'
          AND job.payload->>'exchangeTransactionId'=attempt.exchange_transaction_id::text
          AND job.status IN ('queued','failed','leased')
      )
    ORDER BY attempt.updated_at,attempt.id
    LIMIT 100
    FOR UPDATE OF attempt SKIP LOCKED
  ), advanced AS (
    UPDATE public.broker_authorization_exchange_attempts AS attempt
    SET recovery_generation=attempt.recovery_generation+1,
        last_error_code=COALESCE(attempt.last_error_code,'AUTHORIZATION_EXCHANGE_RECOVERY_REQUEUED')
    FROM candidates WHERE attempt.id=candidates.id
    RETURNING attempt.user_id,attempt.exchange_transaction_id,attempt.recovery_generation
  )
  INSERT INTO public.queue_jobs(queue_name,user_id,job_type,payload,idempotency_key,priority,max_attempts)
  SELECT 'broker-sync',advanced.user_id,'reconcile_broker_authorization_exchange',
    jsonb_build_object('exchangeTransactionId',advanced.exchange_transaction_id::text),
    'broker-auth-exchange-recovery:'||advanced.exchange_transaction_id::text||':'||advanced.recovery_generation::text,
    1,25
  FROM advanced
  ON CONFLICT(queue_name,idempotency_key) DO NOTHING;
  GET DIAGNOSTICS exchange_count=ROW_COUNT;
  RETURN queued_count+exchange_count;
END;
$$;
REVOKE ALL ON FUNCTION app.requeue_stuck_broker_authorization_sagas() FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.broker_authorization_lag_status()
RETURNS TABLE(pending_count bigint,stuck_count bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
  SELECT
    count(*) FILTER (
      WHERE saga.status IN ('confirm_pending','revoke_pending')
        OR (saga.status='confirmed' AND connection.status='pending' AND connection.revoked_at IS NULL)
    ) + (SELECT count(*) FROM public.broker_authorization_exchange_attempts
         WHERE status IN ('exchange_pending','revoke_pending')) AS pending_count,
    count(*) FILTER (
      WHERE saga.updated_at<clock_timestamp()-interval '5 minutes'
        AND (
          saga.status IN ('confirm_pending','revoke_pending')
          OR (saga.status='confirmed' AND connection.status='pending' AND connection.revoked_at IS NULL)
        )
    ) + (SELECT count(*) FROM public.broker_authorization_exchange_attempts
         WHERE status IN ('exchange_pending','revoke_pending')
           AND updated_at<clock_timestamp()-interval '5 minutes'
           AND (status='revoke_pending' OR cleanup_after<=clock_timestamp())) AS stuck_count
  FROM public.broker_authorization_sagas AS saga
  JOIN public.broker_connections AS connection
    ON connection.id=saga.connection_id AND connection.user_id=saga.user_id;
$$;
REVOKE ALL ON FUNCTION app.broker_authorization_lag_status() FROM PUBLIC;

COMMIT;
