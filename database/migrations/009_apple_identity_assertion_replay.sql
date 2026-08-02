BEGIN;

CREATE TABLE apple_identity_assertions (
  assertion_digest text PRIMARY KEY CHECK (assertion_digest ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NOT NULL,
  CHECK (expires_at > consumed_at)
);

REVOKE ALL ON apple_identity_assertions FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.consume_apple_identity_assertion(
  p_assertion_digest text,
  p_expires_at timestamptz,
  p_consumed_at timestamptz
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_assertion_digest IS NULL OR p_assertion_digest !~ '^[0-9a-f]{64}$'
     OR p_expires_at IS NULL OR p_consumed_at IS NULL OR p_expires_at <= p_consumed_at THEN
    RAISE EXCEPTION 'invalid Apple identity assertion metadata' USING ERRCODE = '22023';
  END IF;
  DELETE FROM apple_identity_assertions WHERE expires_at <= p_consumed_at;
  INSERT INTO apple_identity_assertions(assertion_digest,expires_at,consumed_at)
  VALUES(p_assertion_digest,p_expires_at,p_consumed_at);
END;
$$;

REVOKE ALL ON FUNCTION app.consume_apple_identity_assertion(text,timestamptz,timestamptz) FROM PUBLIC;

COMMIT;
