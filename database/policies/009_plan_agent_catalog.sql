BEGIN;

-- Global product metadata is readable but never writable by application and
-- worker roles. Publishing a new catalog version remains an administrative
-- migration/change-control operation.
GRANT SELECT ON plan_agent_catalog_versions,plan_agent_catalog_entries
TO whox_api_runtime,whox_agent_worker,whox_execution_worker,whox_agent_scheduler;

COMMIT;
