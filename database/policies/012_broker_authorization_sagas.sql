BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='whox_broker_authorization_janitor') THEN
    CREATE ROLE whox_broker_authorization_janitor
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS;
  END IF;
END $$;

ALTER TABLE broker_authorization_sagas ENABLE ROW LEVEL SECURITY;
ALTER TABLE broker_authorization_sagas FORCE ROW LEVEL SECURITY;
ALTER TABLE broker_authorization_exchange_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE broker_authorization_exchange_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON broker_authorization_exchange_attempts
  USING (user_id=app.current_user_id()) WITH CHECK (user_id=app.current_user_id());
CREATE POLICY tenant_isolation ON broker_authorization_sagas
  USING (user_id=app.current_user_id()) WITH CHECK (user_id=app.current_user_id());
CREATE POLICY broker_authorization_janitor_access ON broker_authorization_sagas
  TO whox_broker_authorization_janitor USING (true) WITH CHECK (true);
CREATE POLICY broker_authorization_exchange_janitor_access ON broker_authorization_exchange_attempts
  TO whox_broker_authorization_janitor USING (true) WITH CHECK (true);
CREATE POLICY broker_authorization_janitor_connection_read ON broker_connections
  FOR SELECT TO whox_broker_authorization_janitor USING (true);

GRANT SELECT,INSERT,UPDATE ON broker_authorization_sagas TO whox_api_runtime;
GRANT SELECT,INSERT,UPDATE ON broker_authorization_exchange_attempts TO whox_api_runtime;
GRANT SELECT ON broker_authorization_sagas TO whox_broker_sync_worker;
GRANT UPDATE(status,credential_handle,confirmation_acknowledged_at,revocation_requested_at,
  revoked_at,recovery_generation,last_error_code,updated_at)
  ON broker_authorization_sagas TO whox_broker_sync_worker;
GRANT SELECT ON broker_authorization_exchange_attempts TO whox_broker_sync_worker;
GRANT UPDATE(status,completed_at,revocation_requested_at,revoked_at,recovery_generation,last_error_code,updated_at)
  ON broker_authorization_exchange_attempts TO whox_broker_sync_worker;
GRANT SELECT(id,status,deleted_at) ON users TO whox_broker_sync_worker;
GRANT SELECT(id,user_id,device_id,expires_at,revoked_at) ON sessions TO whox_broker_sync_worker;
GRANT SELECT(id,user_id,revoked_at) ON devices TO whox_broker_sync_worker;
GRANT SELECT(id,user_id,creator_session_id,claimant_session_id,status,consumed_at,oauth_state_digest)
  ON connection_pairings TO whox_broker_sync_worker;
GRANT UPDATE(status,consumed_at,oauth_state_digest,oauth_nonce_digest,pkce_verifier_envelope,
  oauth_state_expires_at,oauth_flow,oauth_redirect_uri,mobile_return_uri)
  ON connection_pairings TO whox_broker_sync_worker;
GRANT USAGE ON SCHEMA public,app TO whox_broker_authorization_janitor;
GRANT EXECUTE ON FUNCTION app.current_user_id() TO whox_broker_authorization_janitor;
GRANT SELECT,UPDATE ON broker_authorization_sagas TO whox_broker_authorization_janitor;
GRANT SELECT,UPDATE ON broker_authorization_exchange_attempts TO whox_broker_authorization_janitor;
GRANT SELECT(id,user_id,status,revoked_at) ON broker_connections TO whox_broker_authorization_janitor;
GRANT SELECT,INSERT ON queue_jobs TO whox_broker_authorization_janitor;
GRANT SELECT,UPDATE(updated_at) ON users TO whox_broker_authorization_janitor;
CREATE POLICY broker_authorization_janitor_queue_access ON queue_jobs
  TO whox_broker_authorization_janitor USING (true) WITH CHECK (true);
-- PostgreSQL requires the target owner to be able to create objects in the
-- containing schema. Grant that capability only for the ownership transfer;
-- the runtime janitor keeps USAGE, not CREATE, afterwards.
GRANT CREATE ON SCHEMA app TO whox_broker_authorization_janitor;
ALTER FUNCTION app.requeue_stuck_broker_authorization_sagas() OWNER TO whox_broker_authorization_janitor;
ALTER FUNCTION app.lock_broker_authorization_user(uuid) OWNER TO whox_broker_authorization_janitor;
ALTER FUNCTION app.broker_authorization_lag_status() OWNER TO whox_broker_authorization_janitor;
REVOKE CREATE ON SCHEMA app FROM whox_broker_authorization_janitor;
GRANT EXECUTE ON FUNCTION app.requeue_stuck_broker_authorization_sagas() TO whox_broker_sync_worker;
GRANT EXECUTE ON FUNCTION app.lock_broker_authorization_user(uuid) TO whox_broker_sync_worker;
GRANT EXECUTE ON FUNCTION app.broker_authorization_lag_status() TO whox_broker_sync_worker;

COMMIT;
