BEGIN;

-- API configuration writes and resumes must validate against one exact current
-- plan/catalog/agent assignment without granting the API role mutation rights
-- on global catalog tables. The definer-owned function acquires shared row
-- locks for the caller's transaction, so catalog publication cannot race a
-- successful membership check.
CREATE FUNCTION app.lock_current_plan_agent_assignment(
  p_user_id uuid,
  p_agent_key text,
  p_agent_version_id uuid
) RETURNS TABLE (
  plan_id uuid,
  catalog_version_id uuid,
  catalog_version integer,
  agent_version_id uuid,
  agent_key text,
  agent_version text,
  release_status text,
  research_universe text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,app
AS $$
BEGIN
  IF p_user_id IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'Plan assignment lock requires the authenticated tenant'
      USING ERRCODE='42501';
  END IF;
  IF (p_agent_key IS NULL)=(p_agent_version_id IS NULL) THEN
    RAISE EXCEPTION 'Exactly one plan assignment selector is required'
      USING ERRCODE='22023';
  END IF;

  RETURN QUERY
  SELECT plan.id,catalog.id,catalog.version,agent_version.id,
    definition.agent_key,agent_version.version,agent_version.status,
    entry.research_universe
  FROM subscriptions AS subscription
  JOIN plans AS plan ON plan.id=subscription.plan_id AND plan.active
  JOIN plan_agent_catalog_versions AS catalog
    ON catalog.plan_id=plan.id
   AND catalog.activated_at IS NOT NULL
   AND catalog.activated_at<=clock_timestamp()
   AND catalog.superseded_at IS NULL
  JOIN plan_agent_catalog_entries AS entry ON entry.catalog_version_id=catalog.id
  JOIN agent_versions AS agent_version ON agent_version.id=entry.agent_version_id
  JOIN agent_definitions AS definition ON definition.id=agent_version.agent_definition_id
  WHERE subscription.user_id=p_user_id
    AND subscription.status IN ('active','grace_period')
    AND subscription.effective_at<=clock_timestamp()
    AND subscription.revoked_at IS NULL
    AND (subscription.expires_at IS NULL OR subscription.expires_at>clock_timestamp())
    AND (
      (p_agent_key IS NOT NULL AND definition.agent_key=p_agent_key)
      OR
      (p_agent_version_id IS NOT NULL AND agent_version.id=p_agent_version_id)
    )
  ORDER BY subscription.effective_at DESC,subscription.created_at DESC
  LIMIT 1
  FOR SHARE OF subscription,plan,catalog,entry,agent_version;
END;
$$;

REVOKE ALL ON FUNCTION app.lock_current_plan_agent_assignment(uuid,text,uuid) FROM PUBLIC;

COMMIT;
