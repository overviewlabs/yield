BEGIN;

-- Resolve the tenant's authoritative subscription before applying either
-- agent selector. The prior implementation applied the selector while
-- scanning every active subscription, so an agent from an older overlapping
-- subscription could be returned when the latest plan did not include it.
CREATE OR REPLACE FUNCTION app.lock_current_plan_agent_assignment(
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
DECLARE
  v_plan_id uuid;
BEGIN
  IF p_user_id IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'Plan assignment lock requires the authenticated tenant'
      USING ERRCODE='42501';
  END IF;
  IF (p_agent_key IS NULL)=(p_agent_version_id IS NULL) THEN
    RAISE EXCEPTION 'Exactly one plan assignment selector is required'
      USING ERRCODE='22023';
  END IF;

  SELECT subscription.plan_id
  INTO v_plan_id
  FROM subscriptions AS subscription
  JOIN plans AS plan ON plan.id=subscription.plan_id AND plan.active
  WHERE subscription.user_id=p_user_id
    AND subscription.status IN ('active','grace_period')
    AND subscription.effective_at<=clock_timestamp()
    AND subscription.revoked_at IS NULL
    AND (subscription.expires_at IS NULL OR subscription.expires_at>clock_timestamp())
  ORDER BY subscription.effective_at DESC,subscription.created_at DESC,subscription.id DESC
  LIMIT 1
  FOR SHARE OF subscription,plan;

  IF v_plan_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT plan.id,catalog.id,catalog.version,version.id,
    definition.agent_key,version.version,version.status,
    entry.research_universe
  FROM plans AS plan
  JOIN plan_agent_catalog_versions AS catalog
    ON catalog.plan_id=plan.id
   AND catalog.activated_at IS NOT NULL
   AND catalog.activated_at<=clock_timestamp()
   AND catalog.superseded_at IS NULL
  JOIN plan_agent_catalog_entries AS entry ON entry.catalog_version_id=catalog.id
  JOIN agent_versions AS version ON version.id=entry.agent_version_id
  JOIN agent_definitions AS definition ON definition.id=version.agent_definition_id
  WHERE plan.id=v_plan_id
    AND (
      (p_agent_key IS NOT NULL AND definition.agent_key=p_agent_key)
      OR
      (p_agent_version_id IS NOT NULL AND version.id=p_agent_version_id)
    )
  LIMIT 1
  FOR SHARE OF plan,catalog,entry,version;
END;
$$;

REVOKE ALL ON FUNCTION app.lock_current_plan_agent_assignment(uuid,text,uuid) FROM PUBLIC;

COMMIT;
