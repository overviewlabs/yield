BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE app_environment AS ENUM ('demo','paper','live');
CREATE TYPE proposal_status AS ENUM ('DRAFT','ANALYZED','SCHEMA_VALIDATED','RISK_CHECKED','RISK_REJECTED','BROKER_REVIEWED','BROKER_REJECTED','AWAITING_USER_APPROVAL','USER_REJECTED','APPROVED','SUBMITTING','SUBMITTED','PARTIALLY_FILLED','FILLED','CANCELED','REJECTED','EXPIRED','RECONCILIATION_ERROR');
CREATE TYPE order_status AS ENUM ('pending','submitted','partially_filled','filled','canceled','rejected','unknown');
CREATE TYPE connection_status AS ENUM ('pending','connected','expired','revoked','error');
CREATE TYPE job_status AS ENUM ('queued','leased','succeeded','failed','dead_letter');

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = clock_timestamp(); RETURN NEW; END;
$$;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  email text, display_name text, jurisdiction_country char(2), jurisdiction_region text,
  account_mode app_environment NOT NULL DEFAULT 'demo', onboarding_step smallint NOT NULL DEFAULT 1 CHECK (onboarding_step BETWEEN 1 AND 14),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), deleted_at timestamptz
);
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE user_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('apple','email_magic_link')), provider_subject text NOT NULL,
  relay_email boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), last_authenticated_at timestamptz,
  UNIQUE(provider,provider_subject)
);
CREATE TABLE user_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, profile jsonb NOT NULL DEFAULT '{}',
  profile_version integer NOT NULL DEFAULT 1 CHECK (profile_version > 0), created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER user_profiles_updated_at BEFORE UPDATE ON user_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TABLE eligibility_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  country char(2) NOT NULL, region text, age_eligible boolean NOT NULL, own_individual_account boolean NOT NULL,
  eligibility_status text NOT NULL CHECK (eligibility_status IN ('eligible','ineligible','review')),
  assessment_version text NOT NULL, assessed_at timestamptz NOT NULL DEFAULT clock_timestamp(), superseded_at timestamptz
);
CREATE TABLE risk_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  classification text NOT NULL CHECK (classification IN ('conservative','moderate','growth','aggressive','options_restricted','options_pending_permission')),
  scoring_version text NOT NULL, explanation text NOT NULL, completed_at timestamptz NOT NULL DEFAULT clock_timestamp(), superseded_at timestamptz
);
CREATE TABLE risk_assessment_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), assessment_id uuid NOT NULL REFERENCES risk_assessments(id) ON DELETE CASCADE,
  question_id text NOT NULL, answer jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(assessment_id,question_id)
);

CREATE TABLE legal_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), document_key text NOT NULL, version text NOT NULL, title text NOT NULL,
  content_uri text NOT NULL, content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  production_approved boolean NOT NULL DEFAULT false, published_at timestamptz, retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(document_key,version)
);
CREATE TABLE legal_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  legal_document_id uuid NOT NULL REFERENCES legal_documents(id) ON DELETE RESTRICT, accepted_at timestamptz NOT NULL,
  revoked_at timestamptz, ip_metadata_ciphertext bytea, device_id uuid, user_agent_digest text,
  UNIQUE(user_id,legal_document_id,accepted_at)
);

CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), plan_key text NOT NULL UNIQUE, display_name text NOT NULL,
  product_id text NOT NULL UNIQUE, features jsonb NOT NULL, active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER plans_updated_at BEFORE UPDATE ON plans FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE RESTRICT, original_transaction_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('active','grace_period','billing_retry','expired','revoked','refunded','pending')),
  environment text NOT NULL CHECK (environment IN ('xcode','sandbox','production')), effective_at timestamptz NOT NULL,
  expires_at timestamptz, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(original_transaction_id,environment)
);
CREATE TRIGGER subscriptions_updated_at BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TABLE subscription_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
  transaction_id text NOT NULL, event_type text NOT NULL, signed_payload_digest text NOT NULL,
  event_timestamp timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT clock_timestamp(), idempotency_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL, UNIQUE(transaction_id,event_type)
);
CREATE TABLE entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL, feature_key text NOT NULL, value jsonb NOT NULL,
  effective_at timestamptz NOT NULL, expires_at timestamptz, source_event_id uuid REFERENCES subscription_events(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(user_id,feature_key,effective_at)
);

CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_identifier uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(), platform text NOT NULL, device_name text,
  app_attest_key_id text, trust_state text NOT NULL DEFAULT 'unknown', last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), revoked_at timestamptz
);
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL, refresh_token_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), last_used_at timestamptz, expires_at timestamptz NOT NULL, revoked_at timestamptz,
  rotation_counter integer NOT NULL DEFAULT 0 CHECK (rotation_counter >= 0)
);

CREATE TABLE feature_flags (
  key text PRIMARY KEY, enabled boolean NOT NULL DEFAULT false, environment app_environment NOT NULL,
  description text NOT NULL, updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER feature_flags_updated_at BEFORE UPDATE ON feature_flags FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TABLE system_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), environment app_environment NOT NULL, severity text NOT NULL,
  status text NOT NULL CHECK (status IN ('investigating','identified','monitoring','resolved')),
  public_message text NOT NULL, started_at timestamptz NOT NULL, resolved_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE demo_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  review_identifier text, started_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
  reset_at timestamptz, CHECK (expires_at > started_at)
);

COMMIT;
