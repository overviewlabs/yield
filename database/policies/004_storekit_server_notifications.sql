BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='whox_app_store_notifications') THEN
    CREATE ROLE whox_app_store_notifications NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public,app TO whox_app_store_notifications;
GRANT EXECUTE ON FUNCTION app.current_user_id() TO whox_app_store_notifications;
GRANT EXECUTE ON FUNCTION app.resolve_storekit_notification_tenant(text,text,text) TO whox_app_store_notifications;
GRANT EXECUTE ON FUNCTION app.resolve_storekit_notification_tenant(text,text,text) TO whox_api_runtime;
GRANT SELECT ON users,plans TO whox_app_store_notifications;
GRANT SELECT,INSERT,UPDATE ON subscriptions TO whox_app_store_notifications;
GRANT SELECT,INSERT ON subscription_events TO whox_app_store_notifications;
GRANT SELECT,INSERT,UPDATE ON app_store_server_notifications TO whox_app_store_notifications;

CREATE POLICY app_store_notification_journal_access ON app_store_server_notifications
  TO whox_app_store_notifications USING (true) WITH CHECK (true);

COMMIT;
