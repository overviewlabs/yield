BEGIN;

-- Bind a consumed proof to the same tenant as its authenticated session. The
-- composite session key installed by migration 004 prevents a guessed session
-- UUID from another tenant from being recorded if authorization regresses.
CREATE TABLE step_up_authentication_uses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  verification_id text NOT NULL UNIQUE
    CHECK (length(verification_id) BETWEEN 8 AND 255)
    CHECK (verification_id !~ '[[:space:][:cntrl:]]'),
  session_id uuid NOT NULL,
  device_identifier_digest text NOT NULL
    CHECK (device_identifier_digest ~ '^[0-9a-f]{64}$'),
  action text NOT NULL CHECK (action IN (
    'approve_trade_proposal',
    'resume_user_agent',
    'resume_all_user_agents',
    'disconnect_broker_connection',
    'delete_account',
    'relax_risk_policy'
  )),
  resource_id text NOT NULL
    CHECK (length(resource_id) BETWEEN 1 AND 512)
    CHECK (resource_id !~ '[[:cntrl:]]'),
  authentication_method text NOT NULL
    CHECK (authentication_method IN ('app_attest','devicecheck','webauthn')),
  authenticated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(session_id,user_id) REFERENCES sessions(id,user_id) ON DELETE RESTRICT,
  CHECK (expires_at > authenticated_at),
  CHECK (expires_at > used_at),
  CHECK (authenticated_at <= used_at + interval '30 seconds')
);

ALTER TABLE step_up_authentication_uses ENABLE ROW LEVEL SECURITY;
ALTER TABLE step_up_authentication_uses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON step_up_authentication_uses
  USING (user_id=app.current_user_id())
  WITH CHECK (user_id=app.current_user_id());

CREATE TRIGGER step_up_authentication_uses_immutable
  BEFORE UPDATE OR DELETE ON step_up_authentication_uses
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();

CREATE INDEX step_up_authentication_uses_user_time_idx
  ON step_up_authentication_uses(user_id,used_at DESC);

REVOKE ALL ON step_up_authentication_uses FROM PUBLIC;

COMMIT;
