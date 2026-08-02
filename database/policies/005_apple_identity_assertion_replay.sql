BEGIN;

GRANT EXECUTE ON FUNCTION app.consume_apple_identity_assertion(text,timestamptz,timestamptz) TO whox_api_runtime;

COMMIT;
