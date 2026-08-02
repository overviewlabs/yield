BEGIN;

CREATE TABLE broker_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK (provider = 'robinhood_mcp'), status connection_status NOT NULL,
  token_envelope jsonb, token_key_id text, token_expires_at timestamptz, refresh_supported boolean NOT NULL DEFAULT false,
  authorization_issuer text, resource_uri text, connected_at timestamptz, last_sync_at timestamptz, revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(user_id,provider)
);
CREATE TRIGGER broker_connections_updated_at BEFORE UPDATE ON broker_connections FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TABLE broker_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), connection_id uuid NOT NULL REFERENCES broker_connections(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT, opaque_broker_id text NOT NULL, masked_identifier text,
  account_type text NOT NULL, is_agentic_account boolean NOT NULL DEFAULT false, verified_for_trading_at timestamptz,
  options_permission text, active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(connection_id,opaque_broker_id), UNIQUE(id,user_id)
);
CREATE TRIGGER broker_accounts_updated_at BEFORE UPDATE ON broker_accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TABLE broker_capabilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), connection_id uuid NOT NULL REFERENCES broker_connections(id) ON DELETE CASCADE,
  tool_name text NOT NULL, input_schema jsonb NOT NULL, output_schema jsonb, protocol_version text NOT NULL,
  discovered_at timestamptz NOT NULL, last_seen_at timestamptz NOT NULL, unavailable_at timestamptz,
  UNIQUE(connection_id,tool_name,discovered_at)
);
CREATE TABLE connection_pairings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  creator_session_id uuid REFERENCES sessions(id) ON DELETE SET NULL, claimant_session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  code_digest bytea NOT NULL, status text NOT NULL CHECK (status IN ('pending','authorizing','connected','expired','canceled','error')),
  expires_at timestamptz NOT NULL, claimed_at timestamptz, consumed_at timestamptz, oauth_state_digest bytea,
  oauth_nonce_digest bytea, pkce_verifier_envelope jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > created_at)
);

CREATE TABLE portfolio_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  broker_account_id uuid NOT NULL, environment app_environment NOT NULL, total_value numeric(20,6) NOT NULL,
  buying_power numeric(20,6) NOT NULL, cash_value numeric(20,6), source_timestamp timestamptz NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(), data_classification text NOT NULL,
  FOREIGN KEY (broker_account_id,user_id) REFERENCES broker_accounts(id,user_id) ON DELETE RESTRICT
);
CREATE TABLE position_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), portfolio_snapshot_id uuid NOT NULL REFERENCES portfolio_snapshots(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT, broker_position_id text, symbol text NOT NULL,
  instrument_type text NOT NULL CHECK (instrument_type IN ('equity','option')), quantity numeric(20,8) NOT NULL,
  average_cost numeric(20,6), market_value numeric(20,6) NOT NULL, unrealized_pnl numeric(20,6), details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE market_data_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider text NOT NULL, symbol text NOT NULL, instrument_key text,
  data_type text NOT NULL, payload jsonb NOT NULL, source_timestamp timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delayed_by_seconds integer NOT NULL DEFAULT 0 CHECK (delayed_by_seconds >= 0), UNIQUE(provider,symbol,data_type,source_timestamp)
);

CREATE TABLE agent_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), agent_key text NOT NULL UNIQUE, display_name text NOT NULL,
  strategy_category text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), retired_at timestamptz
);
CREATE TABLE agent_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), agent_definition_id uuid NOT NULL REFERENCES agent_definitions(id) ON DELETE RESTRICT,
  version text NOT NULL, required_plan_key text NOT NULL, definition jsonb NOT NULL,
  deterministic_strategy_version text NOT NULL, prompt_version text,
  status text NOT NULL CHECK (status IN ('draft','paper','limited_rollout','live','paused','retired')),
  compliance_approved_at timestamptz, published_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(agent_definition_id,version)
);
CREATE TABLE user_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  agent_version_id uuid NOT NULL REFERENCES agent_versions(id) ON DELETE RESTRICT, status text NOT NULL CHECK (status IN ('paused','monitoring','waiting_approval','automatic','risk_halt')),
  environment app_environment NOT NULL, allocation_limit numeric(8,6) NOT NULL CHECK (allocation_limit > 0 AND allocation_limit <= 1),
  approval_mode text NOT NULL CHECK (approval_mode IN ('observe','confirm_every_trade','automatic_within_limits')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), deleted_at timestamptz
);
CREATE TRIGGER user_agents_updated_at BEFORE UPDATE ON user_agents FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TABLE agent_configurations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_agent_id uuid NOT NULL REFERENCES user_agents(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT, version integer NOT NULL CHECK (version > 0), configuration jsonb NOT NULL,
  effective_at timestamptz NOT NULL, superseded_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(user_agent_id,version)
);
CREATE TABLE agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  user_agent_id uuid NOT NULL REFERENCES user_agents(id) ON DELETE RESTRICT, status text NOT NULL,
  idempotency_key text NOT NULL UNIQUE, started_at timestamptz NOT NULL, completed_at timestamptz,
  data_sources jsonb NOT NULL DEFAULT '[]', strategy_version text NOT NULL, structured_outcome jsonb, error_code text
);
CREATE TABLE agent_run_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), agent_run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT, symbol text NOT NULL, decision text NOT NULL,
  rejection_codes text[] NOT NULL DEFAULT '{}', structured_rationale jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE risk_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0), limits jsonb NOT NULL, exclusions jsonb NOT NULL DEFAULT '{}',
  effective_at timestamptz NOT NULL, superseded_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(user_id,version)
);
CREATE TABLE capital_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  broker_account_id uuid NOT NULL, user_agent_id uuid NOT NULL REFERENCES user_agents(id) ON DELETE RESTRICT,
  proposal_id uuid, symbol text NOT NULL, side text NOT NULL CHECK (side IN ('buy','sell')), amount numeric(20,6) NOT NULL CHECK (amount > 0),
  idempotency_key text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), FOREIGN KEY (broker_account_id,user_id) REFERENCES broker_accounts(id,user_id) ON DELETE RESTRICT
);
CREATE TABLE trade_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  broker_account_id uuid NOT NULL, agent_run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
  agent_version_id uuid NOT NULL REFERENCES agent_versions(id) ON DELETE RESTRICT, environment app_environment NOT NULL,
  status proposal_status NOT NULL DEFAULT 'DRAFT', version integer NOT NULL DEFAULT 0 CHECK (version >= 0), symbol text NOT NULL,
  instrument_type text NOT NULL CHECK (instrument_type IN ('equity','option')), proposal jsonb NOT NULL,
  proposal_fingerprint text NOT NULL CHECK (proposal_fingerprint ~ '^[0-9a-f]{64}$'), idempotency_key text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (broker_account_id,user_id) REFERENCES broker_accounts(id,user_id) ON DELETE RESTRICT
);
ALTER TABLE capital_reservations ADD CONSTRAINT capital_reservations_proposal_fk FOREIGN KEY (proposal_id) REFERENCES trade_proposals(id) ON DELETE RESTRICT;
CREATE TABLE trade_proposal_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), proposal_id uuid NOT NULL REFERENCES trade_proposals(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT, evidence_type text NOT NULL, source text NOT NULL,
  source_reference text NOT NULL, observed_at timestamptz NOT NULL, payload_digest text, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE risk_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), proposal_id uuid NOT NULL REFERENCES trade_proposals(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT, policy_id uuid NOT NULL REFERENCES risk_policies(id) ON DELETE RESTRICT,
  check_code text NOT NULL, passed boolean NOT NULL, severity text NOT NULL, observed jsonb, limit_value jsonb,
  evaluated_at timestamptz NOT NULL, UNIQUE(proposal_id,check_code,evaluated_at)
);
CREATE TABLE approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), proposal_id uuid NOT NULL REFERENCES trade_proposals(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT, status text NOT NULL CHECK (status IN ('pending','approved','rejected','expired','canceled')),
  idempotency_key text UNIQUE, requested_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, acted_at timestamptz,
  approving_device_id uuid REFERENCES devices(id) ON DELETE SET NULL, authentication_context jsonb
);
CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  proposal_id uuid NOT NULL UNIQUE REFERENCES trade_proposals(id) ON DELETE RESTRICT, broker_account_id uuid NOT NULL,
  broker_order_id text, instrument_type text NOT NULL CHECK (instrument_type IN ('equity','option')), status order_status NOT NULL,
  submission_idempotency_key text NOT NULL UNIQUE, submitted_at timestamptz, terminal_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (broker_account_id,user_id) REFERENCES broker_accounts(id,user_id) ON DELETE RESTRICT,
  UNIQUE(broker_account_id,broker_order_id)
);
CREATE TABLE order_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT, status order_status NOT NULL, broker_event_id text,
  occurred_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT clock_timestamp(), payload jsonb NOT NULL,
  idempotency_key text NOT NULL UNIQUE
);
CREATE TABLE fills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT, broker_fill_id text NOT NULL,
  quantity numeric(20,8) NOT NULL CHECK (quantity > 0), price numeric(20,8) NOT NULL CHECK (price >= 0), fees numeric(20,8),
  occurred_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(order_id,broker_fill_id)
);
CREATE TABLE option_legs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), proposal_id uuid REFERENCES trade_proposals(id) ON DELETE RESTRICT,
  order_id uuid REFERENCES orders(id) ON DELETE RESTRICT, user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  broker_instrument_id text, underlying_symbol text NOT NULL, option_type text NOT NULL CHECK (option_type IN ('call','put')),
  side text NOT NULL CHECK (side IN ('buy','sell')), position_effect text NOT NULL CHECK (position_effect IN ('open','close')),
  strike_price numeric(20,6) NOT NULL CHECK (strike_price > 0), expiration_date date NOT NULL, ratio_quantity integer NOT NULL CHECK (ratio_quantity > 0),
  CHECK ((proposal_id IS NOT NULL) <> (order_id IS NOT NULL))
);
CREATE TABLE reconciliation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT, status job_status NOT NULL DEFAULT 'queued',
  idempotency_key text NOT NULL UNIQUE, attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0), run_after timestamptz NOT NULL,
  leased_until timestamptz, last_error_code text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

COMMIT;
