BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='whox_agent_scheduler') THEN
    CREATE ROLE whox_agent_scheduler NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$;

ALTER TABLE paper_agent_schedule_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE paper_agent_schedule_states FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON paper_agent_schedule_states
  USING (user_id=app.current_user_id())
  WITH CHECK (user_id=app.current_user_id());

-- A NOLOGIN owner gives the SECURITY DEFINER function only the read graph and
-- two fixed queue job types it needs. The agent runtime receives EXECUTE only;
-- it cannot assume this role or query another tenant directly.
GRANT USAGE ON SCHEMA public, app TO whox_agent_scheduler;
GRANT SELECT ON
  users,subscriptions,entitlements,plans,user_agents,agent_configurations,
  agent_definitions,agent_versions,broker_connections,broker_accounts,
  broker_capabilities,portfolio_snapshots,agent_runs,risk_policies,market_data_snapshots,
  system_incidents,paper_agent_schedule_states
TO whox_agent_scheduler;
GRANT SELECT, INSERT, UPDATE ON queue_jobs TO whox_agent_scheduler;
GRANT INSERT, UPDATE ON paper_agent_schedule_states TO whox_agent_scheduler;

CREATE POLICY paper_scheduler_read ON users TO whox_agent_scheduler USING (true);
CREATE POLICY paper_scheduler_read ON subscriptions TO whox_agent_scheduler USING (true);
CREATE POLICY paper_scheduler_read ON entitlements TO whox_agent_scheduler USING (true);
CREATE POLICY paper_scheduler_read ON user_agents TO whox_agent_scheduler USING (true);
CREATE POLICY paper_scheduler_read ON agent_configurations TO whox_agent_scheduler USING (true);
CREATE POLICY paper_scheduler_read ON broker_connections TO whox_agent_scheduler USING (true);
CREATE POLICY paper_scheduler_read ON broker_accounts TO whox_agent_scheduler USING (true);
CREATE POLICY paper_scheduler_read ON broker_capabilities TO whox_agent_scheduler USING (true);
CREATE POLICY paper_scheduler_read ON portfolio_snapshots TO whox_agent_scheduler USING (true);
CREATE POLICY paper_scheduler_read ON agent_runs TO whox_agent_scheduler USING (true);
CREATE POLICY paper_scheduler_read ON risk_policies TO whox_agent_scheduler USING (true);
CREATE POLICY paper_scheduler_state_access ON paper_agent_schedule_states TO whox_agent_scheduler
  USING (true) WITH CHECK (true);
CREATE POLICY paper_scheduler_queue_access ON queue_jobs TO whox_agent_scheduler
  USING (
    user_id IS NOT NULL AND (
      (queue_name='market-data' AND job_type='refresh_quotes') OR
      (queue_name='agent-runs' AND job_type='agent_run')
    )
  )
  WITH CHECK (
    user_id IS NOT NULL AND (
      (queue_name='market-data' AND job_type='refresh_quotes') OR
      (queue_name='agent-runs' AND job_type='agent_run')
    )
  );

ALTER FUNCTION app.schedule_paper_agent_jobs(text[],text,integer,boolean) OWNER TO whox_agent_scheduler;
REVOKE ALL ON paper_agent_schedule_states FROM PUBLIC;
REVOKE ALL ON FUNCTION app.schedule_paper_agent_jobs(text[],text,integer,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.schedule_paper_agent_jobs(text[],text,integer,boolean) TO whox_agent_worker;

COMMIT;
