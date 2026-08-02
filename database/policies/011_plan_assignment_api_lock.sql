BEGIN;

GRANT EXECUTE ON FUNCTION app.lock_current_plan_agent_assignment(uuid,text,uuid)
TO whox_api_runtime;

COMMIT;
