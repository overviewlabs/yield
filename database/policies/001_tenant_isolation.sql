BEGIN;

CREATE SCHEMA IF NOT EXISTS app;
CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'users','user_identities','user_profiles','eligibility_profiles','risk_assessments','legal_consents',
    'subscriptions','entitlements','devices','sessions','broker_connections','broker_accounts','connection_pairings',
    'portfolio_snapshots','position_snapshots','user_agents','agent_configurations','agent_runs','agent_run_candidates',
    'risk_policies','risk_checks','capital_reservations','trade_proposals','trade_proposal_evidence','approval_requests',
    'orders','order_events','fills','option_legs','reconciliation_jobs','trade_proposal_events','risk_events','notifications',
    'device_tokens','audit_events','support_tickets','security_events','demo_sessions','queue_jobs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    IF table_name = 'users' THEN
      EXECUTE 'CREATE POLICY tenant_isolation ON users USING (id = app.current_user_id()) WITH CHECK (id = app.current_user_id())';
    ELSIF table_name = 'user_profiles' THEN
      EXECUTE 'CREATE POLICY tenant_isolation ON user_profiles USING (user_id = app.current_user_id()) WITH CHECK (user_id = app.current_user_id())';
    ELSE
      EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (user_id = app.current_user_id()) WITH CHECK (user_id = app.current_user_id())', table_name);
    END IF;
  END LOOP;
END $$;

-- Answers inherit their tenant from the owning assessment and intentionally do
-- not duplicate user_id. Keep both visibility and writes bound to that parent.
ALTER TABLE risk_assessment_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_assessment_answers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON risk_assessment_answers
  USING (
    EXISTS (
      SELECT 1
      FROM risk_assessments
      WHERE risk_assessments.id = risk_assessment_answers.assessment_id
        AND risk_assessments.user_id = app.current_user_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM risk_assessments
      WHERE risk_assessments.id = risk_assessment_answers.assessment_id
        AND risk_assessments.user_id = app.current_user_id()
    )
  );

ALTER TABLE subscription_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON subscription_events
  USING (
    EXISTS (
      SELECT 1 FROM subscriptions
      WHERE subscriptions.id = subscription_events.subscription_id
        AND subscriptions.user_id = app.current_user_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM subscriptions
      WHERE subscriptions.id = subscription_events.subscription_id
        AND subscriptions.user_id = app.current_user_id()
    )
  );

ALTER TABLE broker_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE broker_capabilities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON broker_capabilities
  USING (
    EXISTS (
      SELECT 1 FROM broker_connections
      WHERE broker_connections.id = broker_capabilities.connection_id
        AND broker_connections.user_id = app.current_user_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM broker_connections
      WHERE broker_connections.id = broker_capabilities.connection_id
        AND broker_connections.user_id = app.current_user_id()
    )
  );

-- Outbox payloads may combine multiple aggregate types and are reachable only
-- by the separately privileged publisher role, never tenant sessions.
ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;

COMMIT;
