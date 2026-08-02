BEGIN;

GRANT SELECT, INSERT, UPDATE, DELETE ON api_idempotency_records,pairing_claim_attempts TO whox_api_runtime;
GRANT EXECUTE ON FUNCTION app.resolve_apple_identity(text,text,text,app_environment) TO whox_api_runtime;

COMMIT;
