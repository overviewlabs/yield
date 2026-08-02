BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM plans AS plan
    JOIN plan_agent_catalog_versions AS catalog
      ON catalog.plan_id=plan.id AND catalog.activated_at IS NOT NULL AND catalog.superseded_at IS NULL
    JOIN plan_agent_catalog_entries AS entry ON entry.catalog_version_id=catalog.id
    WHERE plan.active
    GROUP BY plan.id
    HAVING count(*) NOT BETWEEN 1 AND 3
       OR count(*)<>count(DISTINCT entry.agent_version_id)
       OR bool_or(NOT app.valid_plan_agent_research_universe(entry.research_universe))
       OR (plan.features->>'maximumActiveAgents')::integer NOT BETWEEN 1 AND 3
       OR jsonb_array_length(plan.features->'agentCatalog') NOT BETWEEN 1 AND 3
  ) THEN
    RAISE EXCEPTION 'active plan catalog one-to-three invariant failed';
  END IF;

  IF (SELECT count(*) FROM plans WHERE active) <>
     (SELECT count(*) FROM plan_agent_catalog_versions WHERE activated_at IS NOT NULL AND superseded_at IS NULL) THEN
    RAISE EXCEPTION 'every active plan must have exactly one current catalog';
  END IF;
END $$;

DO $$
BEGIN
  BEGIN
    UPDATE plan_agent_catalog_entries SET position=2
    WHERE catalog_version_id='32000000-0000-4000-8000-000000000001'
      AND agent_version_id='31000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'published catalog entry unexpectedly changed';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;

  BEGIN
    INSERT INTO plan_agent_catalog_entries(catalog_version_id,agent_version_id,position,research_universe)
    VALUES ('32000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000002',2,ARRAY['AAPL','MSFT','VTI']::text[]);
    RAISE EXCEPTION 'published catalog unexpectedly accepted an additional entry';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;

  BEGIN
    UPDATE plan_agent_catalog_entries SET research_universe=ARRAY['AAPL','MSFT']::text[]
    WHERE catalog_version_id='32000000-0000-4000-8000-000000000001'
      AND agent_version_id='31000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'published catalog research universe unexpectedly changed';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;

  BEGIN
    UPDATE plans SET features=jsonb_set(features,'{maximumActiveAgents}','5'::jsonb)
    WHERE plan_key='equity';
    PERFORM app.validate_plan_agent_catalog_integrity();
    RAISE EXCEPTION 'active plan unexpectedly advertised more than three agents';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

INSERT INTO plans(id,plan_key,display_name,product_id,features,active) VALUES (
  '01900000-0000-4000-8000-000000000001','catalog-invariant-test','Catalog Invariant Test',
  'ai.whox.yield.catalog-invariant-test','{"stockTrading":true,"optionsTrading":false,"multiLegOptions":false,"maximumActiveAgents":3,"automaticMode":false,"monitoringFrequencyMinutes":60,"advancedAnalytics":false,"customWatchlists":false,"scannerAccess":false,"agentCatalog":[],"prioritySupport":false}',false
);
INSERT INTO plan_agent_catalog_versions(id,plan_id,version) VALUES
('32900000-0000-4000-8000-000000000001','01900000-0000-4000-8000-000000000001',1);
INSERT INTO plan_agent_catalog_entries(catalog_version_id,agent_version_id,position,research_universe) VALUES
('32900000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000001',1,ARRAY['AAPL','MSFT','VTI']::text[]),
('32900000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000002',2,ARRAY['AAPL','MSFT','VTI']::text[]),
('32900000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000003',3,ARRAY['AAPL','MSFT','VTI']::text[]);

DO $$
BEGIN
  BEGIN
    UPDATE plan_agent_catalog_entries SET research_universe=ARRAY['MSFT','AAPL']::text[]
    WHERE catalog_version_id='32900000-0000-4000-8000-000000000001' AND position=1;
    RAISE EXCEPTION 'catalog unexpectedly accepted an unsorted research universe';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE plan_agent_catalog_entries SET research_universe=ARRAY['AAPL','AAPL']::text[]
    WHERE catalog_version_id='32900000-0000-4000-8000-000000000001' AND position=1;
    RAISE EXCEPTION 'catalog unexpectedly accepted a duplicate research symbol';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE plan_agent_catalog_entries
    SET research_universe=ARRAY(SELECT 'A'||lpad(value::text,2,'0') FROM generate_series(0,50) AS value)
    WHERE catalog_version_id='32900000-0000-4000-8000-000000000001' AND position=1;
    RAISE EXCEPTION 'catalog unexpectedly accepted more than 50 research symbols';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- A fourth position is rejected structurally, and a published catalog with no
-- or invalid membership is rejected by the cross-table validator.
DO $$
BEGIN
  BEGIN
    INSERT INTO plan_agent_catalog_entries(catalog_version_id,agent_version_id,position,research_universe)
    VALUES ('32900000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000004',4,ARRAY['AAPL','MSFT','VTI']::text[]);
    RAISE EXCEPTION 'catalog unexpectedly accepted a fourth position';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

DELETE FROM plan_agent_catalog_entries
WHERE catalog_version_id='32900000-0000-4000-8000-000000000001';

DO $$
BEGIN
  BEGIN
    UPDATE plan_agent_catalog_versions SET activated_at=clock_timestamp()
    WHERE id='32900000-0000-4000-8000-000000000001';
    PERFORM app.validate_plan_agent_catalog_integrity();
    RAISE EXCEPTION 'empty catalog unexpectedly published';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

SELECT set_config('app.user_id','10000000-0000-4000-8000-000000000001',true);
SET LOCAL ROLE whox_api_runtime;
DO $$
DECLARE assignment record;
BEGIN
  SELECT * INTO assignment
  FROM app.lock_current_plan_agent_assignment(
    '10000000-0000-4000-8000-000000000001',
    'foundation-equity',
    NULL
  );
  IF assignment.agent_version_id<>'31000000-0000-4000-8000-000000000001'
     OR assignment.research_universe<>ARRAY['AAPL','MSFT','VTI']::text[] THEN
    RAISE EXCEPTION 'API assignment lock returned the wrong current catalog provenance';
  END IF;

  BEGIN
    PERFORM * FROM app.lock_current_plan_agent_assignment(
      '10000000-0000-4000-8000-000000000002',
      'foundation-equity',
      NULL
    );
    RAISE EXCEPTION 'API assignment lock accepted a different tenant';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  PERFORM count(*) FROM plan_agent_catalog_versions;
  PERFORM count(*) FROM plan_agent_catalog_entries;
END $$;
RESET ROLE;
SET LOCAL ROLE whox_agent_scheduler;
DO $$ BEGIN PERFORM count(*) FROM plan_agent_catalog_versions; PERFORM count(*) FROM plan_agent_catalog_entries; END $$;
RESET ROLE;

ROLLBACK;
