BEGIN;

-- Plans link to centrally managed, immutable agent versions. User-specific
-- activation state and configuration continue to live exclusively in
-- user_agents and agent_configurations.
CREATE TABLE plan_agent_catalog_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  activated_at timestamptz,
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(plan_id,version),
  CHECK (superseded_at IS NULL OR (activated_at IS NOT NULL AND superseded_at > activated_at))
);

CREATE UNIQUE INDEX plan_agent_catalog_versions_current_idx
  ON plan_agent_catalog_versions(plan_id)
  WHERE activated_at IS NOT NULL AND superseded_at IS NULL;

CREATE TABLE plan_agent_catalog_entries (
  catalog_version_id uuid NOT NULL REFERENCES plan_agent_catalog_versions(id) ON DELETE CASCADE,
  agent_version_id uuid NOT NULL REFERENCES agent_versions(id) ON DELETE RESTRICT,
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 3),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(catalog_version_id,agent_version_id),
  UNIQUE(catalog_version_id,position)
);

CREATE OR REPLACE FUNCTION app.validate_plan_agent_catalog_integrity() RETURNS void
LANGUAGE plpgsql
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM plans AS plan
    LEFT JOIN plan_agent_catalog_versions AS catalog
      ON catalog.plan_id=plan.id
     AND catalog.activated_at IS NOT NULL
     AND catalog.superseded_at IS NULL
    WHERE plan.active
    GROUP BY plan.id
    HAVING count(catalog.id)<>1
       OR CASE
            WHEN jsonb_typeof(plan.features->'maximumActiveAgents')='number' THEN
              (plan.features->>'maximumActiveAgents')::numeric NOT BETWEEN 1 AND 3
              OR (plan.features->>'maximumActiveAgents')::numeric<>trunc((plan.features->>'maximumActiveAgents')::numeric)
            ELSE true
          END
  ) THEN
    RAISE EXCEPTION 'Every active plan requires exactly one current agent catalog version'
      USING ERRCODE='23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM plan_agent_catalog_versions AS catalog
    LEFT JOIN plan_agent_catalog_entries AS entry ON entry.catalog_version_id=catalog.id
    LEFT JOIN agent_versions AS version ON version.id=entry.agent_version_id
    WHERE catalog.activated_at IS NOT NULL AND catalog.superseded_at IS NULL
    GROUP BY catalog.id
    HAVING count(entry.agent_version_id) NOT BETWEEN 1 AND 3
       OR count(entry.agent_version_id)<>count(DISTINCT version.agent_definition_id)
       OR min(entry.position)<>1
       OR max(entry.position)<>count(entry.agent_version_id)
  ) THEN
    RAISE EXCEPTION 'A current plan agent catalog requires one to three ordered, distinct agent definitions'
      USING ERRCODE='23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION app.enforce_plan_agent_catalog_version_immutability() RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.activated_at IS NOT NULL THEN
      RAISE EXCEPTION 'Published plan agent catalog versions are immutable' USING ERRCODE='55000';
    END IF;
    RETURN OLD;
  END IF;

  IF ROW(NEW.id,NEW.plan_id,NEW.version,NEW.created_at)
       IS DISTINCT FROM ROW(OLD.id,OLD.plan_id,OLD.version,OLD.created_at) THEN
    RAISE EXCEPTION 'Plan agent catalog version identity is immutable' USING ERRCODE='55000';
  END IF;

  IF OLD.activated_at IS NULL THEN
    IF NEW.activated_at IS NULL OR NEW.superseded_at IS NOT NULL THEN
      RAISE EXCEPTION 'A draft catalog may only transition once to published' USING ERRCODE='55000';
    END IF;
    IF NEW.activated_at>clock_timestamp() THEN
      RAISE EXCEPTION 'A plan agent catalog cannot be published in the future' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.activated_at IS DISTINCT FROM OLD.activated_at
     OR OLD.superseded_at IS NOT NULL
     OR NEW.superseded_at IS NULL THEN
    RAISE EXCEPTION 'A published catalog may only transition once to superseded' USING ERRCODE='55000';
  END IF;
  IF NEW.superseded_at>clock_timestamp() THEN
    RAISE EXCEPTION 'A plan agent catalog cannot be superseded in the future' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app.enforce_plan_agent_catalog_entry_immutability() RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog,public
AS $$
DECLARE published_at timestamptz;
BEGIN
  SELECT activated_at INTO published_at
  FROM plan_agent_catalog_versions
  WHERE id=COALESCE(NEW.catalog_version_id,OLD.catalog_version_id);
  IF published_at IS NOT NULL THEN
    RAISE EXCEPTION 'Published plan agent catalog entries are immutable' USING ERRCODE='55000';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE FUNCTION app.check_plan_agent_catalog_integrity_trigger() RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog,public
AS $$
BEGIN
  PERFORM app.validate_plan_agent_catalog_integrity();
  RETURN COALESCE(NEW,OLD);
END;
$$;

CREATE TRIGGER plan_agent_catalog_version_immutability
  BEFORE UPDATE OR DELETE ON plan_agent_catalog_versions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_plan_agent_catalog_version_immutability();

CREATE TRIGGER plan_agent_catalog_entry_immutability
  BEFORE INSERT OR UPDATE OR DELETE ON plan_agent_catalog_entries
  FOR EACH ROW EXECUTE FUNCTION app.enforce_plan_agent_catalog_entry_immutability();

CREATE CONSTRAINT TRIGGER plan_agent_catalog_plan_integrity
  AFTER INSERT OR UPDATE OR DELETE ON plans
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_plan_agent_catalog_integrity_trigger();

CREATE CONSTRAINT TRIGGER plan_agent_catalog_version_integrity
  AFTER INSERT OR UPDATE OR DELETE ON plan_agent_catalog_versions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_plan_agent_catalog_integrity_trigger();

CREATE CONSTRAINT TRIGGER plan_agent_catalog_entry_integrity
  AFTER INSERT OR UPDATE OR DELETE ON plan_agent_catalog_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_plan_agent_catalog_integrity_trigger();

INSERT INTO plan_agent_catalog_versions(id,plan_id,version) VALUES
('32000000-0000-4000-8000-000000000001','01000000-0000-4000-8000-000000000001',1),
('32000000-0000-4000-8000-000000000002','01000000-0000-4000-8000-000000000002',1),
('32000000-0000-4000-8000-000000000003','01000000-0000-4000-8000-000000000003',1),
('32000000-0000-4000-8000-000000000004','01000000-0000-4000-8000-000000000004',1);

INSERT INTO plan_agent_catalog_entries(catalog_version_id,agent_version_id,position) VALUES
('32000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000001',1),
('32000000-0000-4000-8000-000000000002','31000000-0000-4000-8000-000000000001',1),
('32000000-0000-4000-8000-000000000002','31000000-0000-4000-8000-000000000002',2),
('32000000-0000-4000-8000-000000000002','31000000-0000-4000-8000-000000000003',3),
('32000000-0000-4000-8000-000000000003','31000000-0000-4000-8000-000000000001',1),
('32000000-0000-4000-8000-000000000003','31000000-0000-4000-8000-000000000004',2),
('32000000-0000-4000-8000-000000000003','31000000-0000-4000-8000-000000000005',3),
('32000000-0000-4000-8000-000000000004','31000000-0000-4000-8000-000000000001',1),
('32000000-0000-4000-8000-000000000004','31000000-0000-4000-8000-000000000006',2),
('32000000-0000-4000-8000-000000000004','31000000-0000-4000-8000-000000000007',3);

UPDATE plan_agent_catalog_versions SET activated_at=clock_timestamp();

-- Keep the legacy entitlement JSON mirror synchronized for consumers that have
-- not yet moved to the normalized catalog. The normalized mapping above is the
-- authority for API catalog and activation decisions.
UPDATE plans SET features=jsonb_set(
  jsonb_set(features,'{maximumActiveAgents}',to_jsonb(LEAST(3,(features->>'maximumActiveAgents')::integer))),
  '{agentCatalog}',
  CASE plan_key
    WHEN 'equity' THEN '["foundation-equity"]'::jsonb
    WHEN 'equity_pro' THEN '["foundation-equity","equity-momentum","quality-swing"]'::jsonb
    WHEN 'options' THEN '["foundation-equity","directional-options","covered-strategy"]'::jsonb
    WHEN 'options_pro' THEN '["foundation-equity","defined-risk-spreads","range-volatility"]'::jsonb
    ELSE '[]'::jsonb
  END
)
WHERE plan_key IN ('equity','equity_pro','options','options_pro');

SELECT app.validate_plan_agent_catalog_integrity();

REVOKE ALL ON FUNCTION app.validate_plan_agent_catalog_integrity() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_plan_agent_catalog_version_immutability() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_plan_agent_catalog_entry_immutability() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_plan_agent_catalog_integrity_trigger() FROM PUBLIC;

COMMIT;
