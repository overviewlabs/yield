BEGIN;

-- A tenant may configure an agent version at most once at a time. Soft-deleted
-- assignments remain historical and do not prevent a later explicit re-add.
-- The API also serializes per-tenant assignment mutations so the plan count
-- can be enforced atomically; this index is the final cross-writer invariant.
CREATE UNIQUE INDEX one_current_user_agent_version
  ON user_agents(user_id,agent_version_id)
  WHERE deleted_at IS NULL;

COMMIT;
