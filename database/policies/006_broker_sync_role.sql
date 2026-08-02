BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='whox_broker_sync_worker') THEN
    CREATE ROLE whox_broker_sync_worker
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS;
  END IF;
END $$;

GRANT whox_queue_worker TO whox_broker_sync_worker;
GRANT USAGE ON SCHEMA public,app TO whox_broker_sync_worker;
GRANT EXECUTE ON FUNCTION app.current_user_id() TO whox_broker_sync_worker;
GRANT EXECUTE ON FUNCTION app.broker_sync_lag_status() TO whox_broker_sync_worker;

GRANT SELECT,UPDATE ON broker_connections TO whox_broker_sync_worker;
GRANT SELECT,INSERT,UPDATE ON broker_accounts,broker_capabilities TO whox_broker_sync_worker;
GRANT SELECT,INSERT ON portfolio_snapshots TO whox_broker_sync_worker;
GRANT INSERT ON position_snapshots,audit_events TO whox_broker_sync_worker;
GRANT SELECT,INSERT ON broker_sync_runs TO whox_broker_sync_worker;

COMMIT;
