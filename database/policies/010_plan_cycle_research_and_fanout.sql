BEGIN;

ALTER TABLE paper_plan_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE paper_plan_cycles FORCE ROW LEVEL SECURITY;
ALTER TABLE paper_plan_research_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE paper_plan_research_inputs FORCE ROW LEVEL SECURITY;
ALTER TABLE paper_plan_research_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE paper_plan_research_artifacts FORCE ROW LEVEL SECURITY;

GRANT SELECT,INSERT ON paper_plan_cycles,paper_plan_research_inputs,paper_plan_research_artifacts
TO whox_agent_scheduler;
GRANT SELECT ON paper_plan_cycles,paper_plan_research_artifacts TO whox_agent_worker;
GRANT SELECT ON eligibility_profiles,risk_assessments,legal_documents,legal_consents
TO whox_agent_scheduler;
GRANT SELECT ON eligibility_profiles,risk_assessments TO whox_agent_worker;

CREATE POLICY paper_scheduler_read ON eligibility_profiles TO whox_agent_scheduler USING (true);
CREATE POLICY paper_scheduler_read ON risk_assessments TO whox_agent_scheduler USING (true);
CREATE POLICY paper_scheduler_read ON legal_consents TO whox_agent_scheduler USING (true);

CREATE POLICY plan_cycle_scheduler_access ON paper_plan_cycles TO whox_agent_scheduler
  USING (true) WITH CHECK (true);
CREATE POLICY plan_research_input_scheduler_access ON paper_plan_research_inputs TO whox_agent_scheduler
  USING (true) WITH CHECK (true);
CREATE POLICY plan_research_artifact_scheduler_access ON paper_plan_research_artifacts TO whox_agent_scheduler
  USING (true) WITH CHECK (true);
CREATE POLICY plan_cycle_worker_read ON paper_plan_cycles TO whox_agent_worker USING (true);
CREATE POLICY plan_research_artifact_worker_read ON paper_plan_research_artifacts TO whox_agent_worker USING (true);

-- Extend only the scheduler's fixed queue surface. Plan research is global and
-- therefore must have no user_id; quote/run jobs remain tenant-bound.
DROP POLICY paper_scheduler_queue_access ON queue_jobs;
CREATE POLICY paper_scheduler_queue_access ON queue_jobs TO whox_agent_scheduler
  USING (
    (user_id IS NULL AND queue_name='plan-research' AND job_type='plan_research')
    OR (user_id IS NULL AND queue_name='market-data' AND job_type='refresh_plan_research_quotes')
    OR (user_id IS NOT NULL AND (
      (queue_name='market-data' AND job_type='refresh_quotes')
      OR (queue_name='agent-runs' AND job_type='agent_run')
    ))
  )
  WITH CHECK (
    (user_id IS NULL AND queue_name='plan-research' AND job_type='plan_research')
    OR (user_id IS NULL AND queue_name='market-data' AND job_type='refresh_plan_research_quotes')
    OR (user_id IS NOT NULL AND (
      (queue_name='market-data' AND job_type='refresh_quotes')
      OR (queue_name='agent-runs' AND job_type='agent_run')
    ))
  );

ALTER FUNCTION app.paper_plan_research_context(text,text,integer) OWNER TO whox_agent_scheduler;
ALTER FUNCTION app.record_paper_plan_research_artifact(text,text,text,timestamptz,text,text,jsonb)
  OWNER TO whox_agent_scheduler;
ALTER FUNCTION app.schedule_paper_agent_jobs(text[],text,integer,boolean,integer)
  OWNER TO whox_agent_scheduler;

-- Policy 007 grants the legacy four-argument function before this policy is
-- applied. Remove that bypass only after the five-argument boundary is owned
-- and ready, preserving clean migration/policy ordering.
REVOKE ALL ON FUNCTION app.schedule_paper_agent_jobs(text[],text,integer,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.schedule_paper_agent_jobs(text[],text,integer,boolean) FROM whox_agent_worker;
DROP FUNCTION app.schedule_paper_agent_jobs(text[],text,integer,boolean);

REVOKE ALL ON paper_plan_cycles,paper_plan_research_inputs,paper_plan_research_artifacts FROM PUBLIC;
REVOKE ALL ON FUNCTION app.paper_plan_research_context(text,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.record_paper_plan_research_artifact(text,text,text,timestamptz,text,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.schedule_paper_agent_jobs(text[],text,integer,boolean,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.paper_plan_research_context(text,text,integer) TO whox_agent_worker;
GRANT EXECUTE ON FUNCTION app.record_paper_plan_research_artifact(text,text,text,timestamptz,text,text,jsonb)
  TO whox_agent_worker;
GRANT EXECUTE ON FUNCTION app.schedule_paper_agent_jobs(text[],text,integer,boolean,integer)
  TO whox_agent_worker;

COMMIT;
