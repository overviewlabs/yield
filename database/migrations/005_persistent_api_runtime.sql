BEGIN;

-- Runtime functions are installed during the migration phase, before the
-- separately applied RLS policy files.
CREATE SCHEMA IF NOT EXISTS app;
CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

ALTER TABLE eligibility_profiles
  ADD COLUMN understands_not_bank_or_broker boolean NOT NULL DEFAULT false,
  ADD COLUMN adviser_client_classification text NOT NULL DEFAULT 'needs_review'
    CHECK (adviser_client_classification IN ('self_directed','adviser_client','needs_review')),
  ADD COLUMN decision_reasons jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE risk_assessments
  ADD COLUMN options_classification text NOT NULL DEFAULT 'options_restricted'
    CHECK (options_classification IN ('options_restricted','options_eligible_pending_broker_permission')),
  ADD COLUMN score integer NOT NULL DEFAULT 0,
  ADD COLUMN factors jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN rationale jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE devices
  ADD COLUMN client_identifier_digest text;
CREATE UNIQUE INDEX devices_user_client_identifier_unique
  ON devices(user_id,client_identifier_digest)
  WHERE client_identifier_digest IS NOT NULL AND revoked_at IS NULL;

ALTER TABLE connection_pairings
  ADD COLUMN oauth_state_expires_at timestamptz,
  ADD COLUMN oauth_flow text CHECK (oauth_flow IN ('desktop','mobile')),
  ADD COLUMN oauth_redirect_uri text,
  ADD COLUMN mobile_return_uri text;

ALTER TABLE broker_connections
  ADD COLUMN connection_summary jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE approval_requests
  ADD COLUMN authentication_verification_id text;
CREATE UNIQUE INDEX approval_authentication_verification_unique
  ON approval_requests(authentication_verification_id)
  WHERE authentication_verification_id IS NOT NULL;

CREATE TABLE api_idempotency_records (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('processing','completed')),
  response jsonb,
  lease_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(user_id,idempotency_key),
  CHECK ((status='processing' AND response IS NULL) OR (status='completed' AND response IS NOT NULL))
);
CREATE TRIGGER api_idempotency_records_updated_at BEFORE UPDATE ON api_idempotency_records FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE pairing_claim_attempts (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempt_key_digest text NOT NULL CHECK (attempt_key_digest ~ '^[0-9a-f]{64}$'),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  reset_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(user_id,attempt_key_digest)
);

ALTER TABLE api_idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_idempotency_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON api_idempotency_records
  USING (user_id = app.current_user_id()) WITH CHECK (user_id = app.current_user_id());

ALTER TABLE pairing_claim_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pairing_claim_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pairing_claim_attempts
  USING (user_id = app.current_user_id()) WITH CHECK (user_id = app.current_user_id());

CREATE OR REPLACE FUNCTION app.resolve_apple_identity(
  p_provider_subject text,
  p_email text,
  p_display_name text,
  p_account_mode app_environment
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  resolved_user_id uuid;
BEGIN
  IF p_provider_subject IS NULL OR length(btrim(p_provider_subject)) < 3 OR length(p_provider_subject) > 255 THEN
    RAISE EXCEPTION 'invalid Apple provider subject' USING ERRCODE = '22023';
  END IF;
  IF p_account_mode NOT IN ('demo','paper') THEN
    RAISE EXCEPTION 'unsupported account mode' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('apple:' || p_provider_subject, 0));
  SELECT user_id INTO resolved_user_id
  FROM user_identities
  WHERE provider='apple' AND provider_subject=p_provider_subject;

  IF resolved_user_id IS NULL THEN
    INSERT INTO users(status,email,display_name,account_mode,onboarding_step)
    VALUES ('active',NULLIF(btrim(p_email),''),COALESCE(NULLIF(btrim(p_display_name),''),'Treasury User'),p_account_mode,1)
    RETURNING id INTO resolved_user_id;
    INSERT INTO user_identities(user_id,provider,provider_subject,last_authenticated_at)
    VALUES (resolved_user_id,'apple',p_provider_subject,clock_timestamp());
    INSERT INTO user_profiles(user_id,profile) VALUES (resolved_user_id,'{}'::jsonb);
  ELSE
    UPDATE user_identities SET last_authenticated_at=clock_timestamp()
    WHERE provider='apple' AND provider_subject=p_provider_subject;
    UPDATE users SET
      email=COALESCE(email,NULLIF(btrim(p_email),'')),
      display_name=CASE WHEN display_name IS NULL OR display_name='' THEN COALESCE(NULLIF(btrim(p_display_name),''),'Treasury User') ELSE display_name END
    WHERE id=resolved_user_id;
  END IF;
  RETURN resolved_user_id;
END;
$$;

REVOKE ALL ON FUNCTION app.resolve_apple_identity(text,text,text,app_environment) FROM PUBLIC;

COMMIT;
