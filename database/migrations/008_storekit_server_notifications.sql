BEGIN;

CREATE TABLE app_store_server_notifications (
  notification_uuid uuid PRIMARY KEY,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  notification_type text NOT NULL,
  subtype text,
  version text NOT NULL,
  signed_at timestamptz NOT NULL,
  signed_payload_digest text NOT NULL CHECK (signed_payload_digest ~ '^[0-9a-f]{64}$'),
  processing_status text NOT NULL CHECK (processing_status IN ('processing','processed','unmatched','failed')),
  attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  processed_at timestamptz,
  user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  original_transaction_id text,
  transaction_id text,
  error_code text,
  normalized_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK ((processing_status='processed' AND processed_at IS NOT NULL) OR processing_status<>'processed')
);
CREATE INDEX app_store_notifications_status_attempt_idx
  ON app_store_server_notifications(processing_status,last_attempt_at);
CREATE INDEX app_store_notifications_original_transaction_idx
  ON app_store_server_notifications(original_transaction_id,environment)
  WHERE original_transaction_id IS NOT NULL;

ALTER TABLE app_store_server_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_store_server_notifications FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION app.resolve_storekit_notification_tenant(
  p_original_transaction_id text,
  p_environment text,
  p_app_account_token text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  mapped_user_id uuid;
  token_user_id uuid;
BEGIN
  IF p_original_transaction_id IS NULL OR length(p_original_transaction_id) < 1 OR length(p_original_transaction_id) > 255 THEN
    RAISE EXCEPTION 'invalid original transaction identifier' USING ERRCODE='22023';
  END IF;
  IF p_environment NOT IN ('sandbox','production') THEN
    RAISE EXCEPTION 'invalid App Store environment' USING ERRCODE='22023';
  END IF;

  SELECT user_id INTO mapped_user_id
  FROM subscriptions
  WHERE original_transaction_id=p_original_transaction_id AND environment=p_environment;

  IF p_app_account_token IS NOT NULL AND
     p_app_account_token ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    SELECT id INTO token_user_id FROM users WHERE id=p_app_account_token::uuid AND status='active' AND deleted_at IS NULL;
  END IF;

  IF mapped_user_id IS NOT NULL AND token_user_id IS NOT NULL AND mapped_user_id<>token_user_id THEN
    RAISE EXCEPTION 'App Store account token does not own original transaction' USING ERRCODE='23514';
  END IF;
  RETURN COALESCE(mapped_user_id,token_user_id);
END;
$$;
REVOKE ALL ON FUNCTION app.resolve_storekit_notification_tenant(text,text,text) FROM PUBLIC;

COMMIT;
