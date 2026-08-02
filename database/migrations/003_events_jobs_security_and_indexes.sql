BEGIN;

CREATE TABLE trade_proposal_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), proposal_id uuid NOT NULL REFERENCES trade_proposals(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT, from_status proposal_status NOT NULL, to_status proposal_status NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('system','user','worker','broker','operator')), actor_id text NOT NULL,
  reason_code text NOT NULL, correlation_id text NOT NULL, idempotency_key text NOT NULL UNIQUE,
  metadata jsonb NOT NULL DEFAULT '{}', occurred_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE risk_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  broker_account_id uuid, proposal_id uuid REFERENCES trade_proposals(id) ON DELETE RESTRICT,
  environment app_environment NOT NULL, event_type text NOT NULL, severity text NOT NULL CHECK (severity IN ('info','warning','blocking','critical')),
  reason_code text NOT NULL, structured_details jsonb NOT NULL, occurred_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (broker_account_id,user_id) REFERENCES broker_accounts(id,user_id) ON DELETE RESTRICT
);
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type text NOT NULL, priority text NOT NULL CHECK (priority IN ('summary','normal','time_sensitive','critical')),
  title text NOT NULL, private_body text NOT NULL, public_body text, deep_link text,
  status text NOT NULL CHECK (status IN ('queued','delivered','failed','suppressed','read')),
  idempotency_key text NOT NULL UNIQUE, scheduled_at timestamptz NOT NULL, delivered_at timestamptz, read_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0), created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE device_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE, token_digest text NOT NULL, token_envelope jsonb NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), invalidated_at timestamptz, UNIQUE(device_id,environment)
);
CREATE TRIGGER device_tokens_updated_at BEFORE UPDATE ON device_tokens FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  actor_id text NOT NULL, actor_role text NOT NULL, action text NOT NULL, reason text,
  resource_type text NOT NULL, resource_id text, before_state jsonb, after_state jsonb,
  correlation_id text NOT NULL, source_ip_digest text, occurred_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('open','waiting_user','waiting_internal','resolved','closed')),
  category text NOT NULL, subject text NOT NULL, body_ciphertext bytea, assigned_role text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), closed_at timestamptz
);
CREATE TRIGGER support_tickets_updated_at BEFORE UPDATE ON support_tickets FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TABLE security_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL, event_type text NOT NULL, severity text NOT NULL,
  ip_digest text, structured_details jsonb NOT NULL DEFAULT '{}', occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE queue_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), queue_name text NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE RESTRICT, job_type text NOT NULL, payload jsonb NOT NULL,
  status job_status NOT NULL DEFAULT 'queued', priority smallint NOT NULL DEFAULT 100,
  idempotency_key text NOT NULL, available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  leased_by text, leased_until timestamptz, attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0), max_attempts integer NOT NULL DEFAULT 10 CHECK (max_attempts > 0),
  last_error_code text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(queue_name,idempotency_key)
);
CREATE TRIGGER queue_jobs_updated_at BEFORE UPDATE ON queue_jobs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), aggregate_type text NOT NULL, aggregate_id uuid NOT NULL,
  event_type text NOT NULL, payload jsonb NOT NULL, idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), published_at timestamptz, publish_attempts integer NOT NULL DEFAULT 0
);

CREATE FUNCTION reject_immutable_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable event rows cannot be updated or deleted' USING ERRCODE = '55000'; END;
$$;
CREATE FUNCTION protect_legal_consent_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'legal consent rows cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND NEW.revoked_at >= OLD.accepted_at
     AND NEW.id IS NOT DISTINCT FROM OLD.id
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.legal_document_id IS NOT DISTINCT FROM OLD.legal_document_id
     AND NEW.accepted_at IS NOT DISTINCT FROM OLD.accepted_at
     AND NEW.ip_metadata_ciphertext IS NOT DISTINCT FROM OLD.ip_metadata_ciphertext
     AND NEW.device_id IS NOT DISTINCT FROM OLD.device_id
     AND NEW.user_agent_digest IS NOT DISTINCT FROM OLD.user_agent_digest THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'legal consent history is immutable except for one-way revocation' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER legal_consents_history BEFORE UPDATE OR DELETE ON legal_consents FOR EACH ROW EXECUTE FUNCTION protect_legal_consent_history();
CREATE TRIGGER subscription_events_immutable BEFORE UPDATE OR DELETE ON subscription_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();
CREATE TRIGGER order_events_immutable BEFORE UPDATE OR DELETE ON order_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();
CREATE TRIGGER fills_immutable BEFORE UPDATE OR DELETE ON fills FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();
CREATE TRIGGER proposal_events_immutable BEFORE UPDATE OR DELETE ON trade_proposal_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();
CREATE TRIGGER security_events_immutable BEFORE UPDATE OR DELETE ON security_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();

CREATE UNIQUE INDEX one_current_risk_policy_per_user ON risk_policies(user_id) WHERE superseded_at IS NULL;
CREATE UNIQUE INDEX one_active_agent_configuration ON agent_configurations(user_agent_id) WHERE superseded_at IS NULL;
CREATE UNIQUE INDEX one_active_eligibility_profile ON eligibility_profiles(user_id) WHERE superseded_at IS NULL;
CREATE UNIQUE INDEX one_active_risk_assessment ON risk_assessments(user_id) WHERE superseded_at IS NULL;
CREATE UNIQUE INDEX active_agentic_account_per_connection ON broker_accounts(connection_id) WHERE is_agentic_account AND active;
CREATE UNIQUE INDEX active_capital_reservation_per_proposal ON capital_reservations(proposal_id) WHERE released_at IS NULL;
CREATE INDEX users_status_idx ON users(status);
CREATE INDEX sessions_user_active_idx ON sessions(user_id,expires_at) WHERE revoked_at IS NULL;
CREATE INDEX broker_connections_status_idx ON broker_connections(status,updated_at);
CREATE INDEX portfolio_snapshots_user_time_idx ON portfolio_snapshots(user_id,captured_at DESC);
CREATE INDEX position_snapshots_user_symbol_idx ON position_snapshots(user_id,symbol);
CREATE INDEX market_data_symbol_time_idx ON market_data_snapshots(symbol,data_type,source_timestamp DESC);
CREATE INDEX user_agents_user_status_idx ON user_agents(user_id,status);
CREATE INDEX agent_runs_user_time_idx ON agent_runs(user_id,started_at DESC);
CREATE INDEX proposals_user_status_time_idx ON trade_proposals(user_id,status,created_at DESC);
CREATE INDEX proposal_events_proposal_time_idx ON trade_proposal_events(proposal_id,occurred_at);
CREATE INDEX orders_user_status_time_idx ON orders(user_id,status,created_at DESC);
CREATE INDEX order_events_order_time_idx ON order_events(order_id,occurred_at);
CREATE INDEX risk_events_user_time_idx ON risk_events(user_id,occurred_at DESC);
CREATE INDEX notifications_user_status_time_idx ON notifications(user_id,status,scheduled_at DESC);
CREATE INDEX audit_events_user_time_idx ON audit_events(user_id,occurred_at DESC);
CREATE INDEX queue_jobs_claim_idx ON queue_jobs(queue_name,status,priority,available_at) WHERE status='queued';
CREATE INDEX reconciliation_jobs_claim_idx ON reconciliation_jobs(status,run_after) WHERE status IN ('queued','failed');
CREATE INDEX outbox_unpublished_idx ON outbox_events(created_at) WHERE published_at IS NULL;

COMMIT;
