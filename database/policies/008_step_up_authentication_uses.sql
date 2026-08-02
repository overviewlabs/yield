BEGIN;

-- The public API may append a verified one-time use. It cannot read, update,
-- or delete the immutable authentication journal.
GRANT INSERT ON step_up_authentication_uses TO whox_api_runtime;

COMMIT;
