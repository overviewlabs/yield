BEGIN;

-- Research universes are centrally published plan metadata, never inferred
-- from tenant watchlists/configurations. This initial Paper catalog is narrow
-- and can be expanded only through reviewed catalog publication.
CREATE FUNCTION app.valid_plan_agent_research_universe(value text[]) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path=pg_catalog
AS $$
  SELECT value IS NOT NULL
    AND cardinality(value) BETWEEN 1 AND 50
    AND NOT EXISTS (SELECT 1 FROM unnest(value) AS symbol WHERE symbol IS NULL OR symbol !~ '^[A-Z][A-Z0-9.-]{0,14}$')
    AND cardinality(value)=(SELECT count(DISTINCT symbol) FROM unnest(value) AS symbol)
    AND value=ARRAY(SELECT symbol FROM unnest(value) AS symbol ORDER BY symbol COLLATE "C")
$$;

ALTER TABLE plan_agent_catalog_entries
  ADD COLUMN research_universe text[] NOT NULL DEFAULT ARRAY['AAPL','MSFT','VTI']::text[],
  ADD CONSTRAINT plan_agent_research_universe_bounded
    CHECK (app.valid_plan_agent_research_universe(research_universe));
ALTER TABLE plan_agent_catalog_entries ALTER COLUMN research_universe DROP DEFAULT;

-- A plan cycle coordinates one public-market research decision for one
-- published plan/agent version. It never owns tenant or broker credentials.
CREATE TABLE paper_plan_cycles (
  id text PRIMARY KEY CHECK (id ~ '^paper-plan-cycle:[0-9a-f-]{36}:[0-9a-f-]{36}:[0-9a-f-]{36}:[0-9]{1,12}:[0-9]{1,12}$'),
  plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  catalog_version_id uuid NOT NULL REFERENCES plan_agent_catalog_versions(id) ON DELETE RESTRICT,
  agent_version_id uuid NOT NULL REFERENCES agent_versions(id) ON DELETE RESTRICT,
  plan_agent_assignment_id text NOT NULL CHECK (plan_agent_assignment_id ~ '^plan-agent-assignment:[0-9a-f-]{36}:[0-9a-f-]{36}$'),
  schedule_bucket_started_at timestamptz NOT NULL,
  evaluation_as_of timestamptz NOT NULL,
  strategy_version text NOT NULL CHECK (strategy_version ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(plan_id,catalog_version_id,agent_version_id,schedule_bucket_started_at),
  FOREIGN KEY (catalog_version_id,agent_version_id)
    REFERENCES plan_agent_catalog_entries(catalog_version_id,agent_version_id) ON DELETE RESTRICT,
  CHECK (evaluation_as_of>=schedule_bucket_started_at),
  CHECK (plan_agent_assignment_id='plan-agent-assignment:'||catalog_version_id::text||':'||agent_version_id::text)
);

CREATE INDEX paper_plan_cycles_bucket_idx
  ON paper_plan_cycles(schedule_bucket_started_at DESC,plan_id,agent_version_id);

-- The exact sanitized public input is frozen before Hermes is called. This
-- removes retry-time quote drift and gives the provider one logical request.
CREATE TABLE paper_plan_research_inputs (
  plan_cycle_id text PRIMARY KEY REFERENCES paper_plan_cycles(id) ON DELETE RESTRICT,
  source_as_of timestamptz NOT NULL,
  research_universe jsonb NOT NULL CHECK (jsonb_typeof(research_universe)='array'),
  context_sha256 text NOT NULL CHECK (context_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Exactly one immutable, sanitized research artifact may be accepted for a
-- cycle. It is evidence only; tenant pipelines remain deterministic and own
-- all account/risk/consent/approval/execution validation.
CREATE TABLE paper_plan_research_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_cycle_id text NOT NULL UNIQUE REFERENCES paper_plan_cycles(id) ON DELETE RESTRICT,
  provider_id text NOT NULL CHECK (provider_id='hermes'),
  model_id text NOT NULL CHECK (model_id='treasury-bot'),
  source_as_of timestamptz NOT NULL,
  context_sha256 text NOT NULL CHECK (context_sha256 ~ '^[0-9a-f]{64}$'),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  sanitized_decision jsonb NOT NULL CHECK (jsonb_typeof(sanitized_decision)='object'),
  decision_sha256 text NOT NULL CHECK (decision_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TRIGGER paper_plan_cycles_immutable
  BEFORE UPDATE OR DELETE ON paper_plan_cycles
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();
CREATE TRIGGER paper_plan_research_inputs_immutable
  BEFORE UPDATE OR DELETE ON paper_plan_research_inputs
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();
CREATE TRIGGER paper_plan_research_artifacts_immutable
  BEFORE UPDATE OR DELETE ON paper_plan_research_artifacts
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();

CREATE OR REPLACE FUNCTION app.paper_plan_research_context(
  p_plan_cycle_id text,
  p_market_data_provider_id text,
  p_maximum_quote_age_seconds integer DEFAULT 60
)
RETURNS TABLE (
  plan_cycle_id text,
  plan_id uuid,
  catalog_version_id uuid,
  plan_agent_assignment_id text,
  agent_version_id uuid,
  plan_key text,
  agent_key text,
  agent_version text,
  strategy_version text,
  evaluation_as_of timestamptz,
  source_as_of timestamptz,
  context_sha256 text,
  research_universe jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,app
AS $$
DECLARE
  v_cycle record;
  v_existing record;
  v_symbol_count integer;
  v_ready_count integer;
  v_universe jsonb;
  v_source_as_of timestamptz;
  v_context jsonb;
  v_context_sha256 text;
BEGIN
  IF p_plan_cycle_id IS NULL
    OR p_plan_cycle_id !~ '^paper-plan-cycle:[0-9a-f-]{36}:[0-9a-f-]{36}:[0-9a-f-]{36}:[0-9]{1,12}:[0-9]{1,12}$'
    OR p_market_data_provider_id IS NULL
    OR p_market_data_provider_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$'
    OR p_maximum_quote_age_seconds IS NULL
    OR p_maximum_quote_age_seconds NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'plan research context parameters are invalid' USING ERRCODE='22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('whox:plan-research-context:'||p_plan_cycle_id,0));

  SELECT cycle.id,cycle.plan_id,cycle.catalog_version_id,cycle.plan_agent_assignment_id,
    cycle.agent_version_id,plan.plan_key,definition.agent_key,version.version AS agent_version,
    cycle.strategy_version,cycle.evaluation_as_of,assignment.research_universe
  INTO v_cycle
  FROM paper_plan_cycles AS cycle
  JOIN plans AS plan ON plan.id=cycle.plan_id AND plan.active
  JOIN plan_agent_catalog_versions AS catalog
    ON catalog.id=cycle.catalog_version_id AND catalog.plan_id=cycle.plan_id
    AND catalog.activated_at IS NOT NULL AND catalog.activated_at<=cycle.evaluation_as_of
    AND catalog.superseded_at IS NULL
  JOIN plan_agent_catalog_entries AS assignment
    ON assignment.catalog_version_id=catalog.id AND assignment.agent_version_id=cycle.agent_version_id
  JOIN agent_versions AS version
    ON version.id=cycle.agent_version_id AND version.status IN ('paper','limited_rollout','live')
    AND version.deterministic_strategy_version=cycle.strategy_version
  JOIN agent_definitions AS definition
    ON definition.id=version.agent_definition_id AND definition.retired_at IS NULL
  WHERE cycle.id=p_plan_cycle_id;

  IF v_cycle.id IS NULL THEN RETURN; END IF;

  SELECT input.source_as_of,input.context_sha256,input.research_universe
  INTO v_existing
  FROM paper_plan_research_inputs AS input
  WHERE input.plan_cycle_id=p_plan_cycle_id
    AND input.source_as_of>clock_timestamp()-make_interval(secs=>p_maximum_quote_age_seconds)
    AND v_cycle.evaluation_as_of>clock_timestamp()-interval '300 seconds';

  IF v_existing.context_sha256 IS NULL THEN
    WITH symbols AS (
      SELECT symbol
      FROM unnest(v_cycle.research_universe) AS symbol
    ), quotes AS (
      SELECT symbols.symbol,quote.payload,quote.source_timestamp
      FROM symbols
      LEFT JOIN LATERAL (
        SELECT snapshot.payload,snapshot.source_timestamp
        FROM market_data_snapshots AS snapshot
        WHERE snapshot.provider=p_market_data_provider_id
          AND snapshot.symbol=symbols.symbol
          AND snapshot.data_type='quote'
          AND snapshot.source_timestamp<=v_cycle.evaluation_as_of+interval '5 seconds'
          AND snapshot.source_timestamp>clock_timestamp()-make_interval(secs=>p_maximum_quote_age_seconds)
          AND jsonb_typeof(snapshot.payload)='object'
          AND jsonb_typeof(snapshot.payload->'bid')='number'
          AND jsonb_typeof(snapshot.payload->'ask')='number'
          AND jsonb_typeof(snapshot.payload->'last')='number'
          AND jsonb_typeof(snapshot.payload->'sector')='string'
          AND jsonb_typeof(snapshot.payload->'marketSession')='string'
          AND jsonb_typeof(snapshot.payload->'liquiditySufficient')='boolean'
          AND jsonb_typeof(snapshot.payload->'volatilityHalt')='boolean'
          AND jsonb_typeof(snapshot.payload->'tradingHalt')='boolean'
          AND snapshot.payload->>'marketSession' IN ('open','extended','closed')
          AND length(snapshot.payload->>'sector') BETWEEN 1 AND 100
          AND (snapshot.payload->>'bid')::numeric>=0
          AND (snapshot.payload->>'ask')::numeric>0
          AND (snapshot.payload->>'last')::numeric>0
          AND (snapshot.payload->>'ask')::numeric>=(snapshot.payload->>'bid')::numeric
        ORDER BY snapshot.source_timestamp DESC,snapshot.received_at DESC
        LIMIT 1
      ) AS quote ON true
    )
    SELECT count(*)::integer,
      count(*) FILTER (WHERE source_timestamp IS NOT NULL)::integer,
      jsonb_agg(
        jsonb_build_object(
          'symbol',symbol,
          'sector',payload->>'sector',
          'bid',(payload->>'bid')::numeric,
          'ask',(payload->>'ask')::numeric,
          'last',(payload->>'last')::numeric,
          'sourceTimestamp',source_timestamp,
          'marketSession',payload->>'marketSession',
          'liquiditySufficient',(payload->>'liquiditySufficient')::boolean,
          'volatilityHalt',(payload->>'volatilityHalt')::boolean,
          'tradingHalt',(payload->>'tradingHalt')::boolean
        ) ORDER BY symbol COLLATE "C"
      ) FILTER (WHERE source_timestamp IS NOT NULL),
      max(source_timestamp)
    INTO v_symbol_count,v_ready_count,v_universe,v_source_as_of
    FROM quotes;

    IF v_symbol_count>50 THEN
      RAISE EXCEPTION 'plan research universe exceeds 50 symbols' USING ERRCODE='54000';
    END IF;
    IF v_symbol_count=0 OR v_ready_count<>v_symbol_count THEN RETURN; END IF;
    -- source_as_of is the canonical cycle cutoff. Individual quote timestamps
    -- remain in the frozen universe and may differ within the bounded skew.
    v_source_as_of := v_cycle.evaluation_as_of;

    v_context := jsonb_build_object(
      'planCycleId',v_cycle.id,
      'planId',v_cycle.plan_id,
      'planKey',v_cycle.plan_key,
      'planCatalogVersionId',v_cycle.catalog_version_id,
      'planAgentAssignmentId',v_cycle.plan_agent_assignment_id,
      'agentVersionId',v_cycle.agent_version_id,
      'agentKey',v_cycle.agent_key,
      'agentVersion',v_cycle.agent_version,
      'deterministicStrategyVersion',v_cycle.strategy_version,
      'asOf',v_cycle.evaluation_as_of,
      'sourceAsOf',v_source_as_of,
      'symbols',v_universe
    );
    v_context_sha256 := encode(digest(convert_to(v_context::text,'UTF8'),'sha256'),'hex');

    INSERT INTO paper_plan_research_inputs(plan_cycle_id,source_as_of,research_universe,context_sha256)
    VALUES(v_cycle.id,v_source_as_of,v_universe,v_context_sha256)
    ON CONFLICT ON CONSTRAINT paper_plan_research_inputs_pkey DO NOTHING;

    SELECT input.source_as_of,input.context_sha256,input.research_universe
    INTO v_existing
    FROM paper_plan_research_inputs AS input WHERE input.plan_cycle_id=v_cycle.id;
  END IF;

  RETURN QUERY SELECT
    v_cycle.id::text,v_cycle.plan_id::uuid,v_cycle.catalog_version_id::uuid,
    v_cycle.plan_agent_assignment_id::text,v_cycle.agent_version_id::uuid,
    v_cycle.plan_key::text,v_cycle.agent_key::text,v_cycle.agent_version::text,
    v_cycle.strategy_version::text,v_cycle.evaluation_as_of::timestamptz,
    v_existing.source_as_of::timestamptz,v_existing.context_sha256::text,
    v_existing.research_universe::jsonb;
END;
$$;

CREATE OR REPLACE FUNCTION app.record_paper_plan_research_artifact(
  p_plan_cycle_id text,
  p_provider_id text,
  p_model_id text,
  p_source_as_of timestamptz,
  p_context_sha256 text,
  p_request_sha256 text,
  p_sanitized_decision jsonb
)
RETURNS TABLE (
  id uuid,
  plan_cycle_id text,
  provider_id text,
  model_id text,
  source_as_of timestamptz,
  context_sha256 text,
  request_sha256 text,
  decision_sha256 text,
  sanitized_decision jsonb,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,app
AS $$
DECLARE
  v_input record;
  v_decision_sha256 text;
  v_expected_request_id text;
  v_result record;
  v_top_keys text[];
  v_analysis_keys text[];
  v_symbols text[];
  v_input_symbols text[];
BEGIN
  IF p_provider_id<>'hermes' OR p_model_id<>'treasury-bot'
    OR p_context_sha256 !~ '^[0-9a-f]{64}$'
    OR p_request_sha256 !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(p_sanitized_decision) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'plan research artifact parameters are invalid' USING ERRCODE='22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('whox:plan-research-artifact:'||p_plan_cycle_id,0));
  SELECT input.source_as_of,input.context_sha256,input.research_universe
  INTO v_input
  FROM paper_plan_research_inputs AS input
  JOIN paper_plan_cycles AS cycle ON cycle.id=input.plan_cycle_id
  WHERE input.plan_cycle_id=p_plan_cycle_id
    AND input.source_as_of=p_source_as_of
    AND input.context_sha256=p_context_sha256
    AND cycle.evaluation_as_of<=input.source_as_of
    AND input.source_as_of<=cycle.evaluation_as_of+interval '5 seconds';
  IF v_input.context_sha256 IS NULL THEN
    RAISE EXCEPTION 'frozen plan research input does not match' USING ERRCODE='23514';
  END IF;

  SELECT array_agg(key ORDER BY key) INTO v_top_keys FROM jsonb_object_keys(p_sanitized_decision) AS key;
  SELECT array_agg(key ORDER BY key) INTO v_analysis_keys
  FROM jsonb_object_keys(p_sanitized_decision->'analysis') AS key;
  v_expected_request_id := 'hermes-plan-'||encode(digest(convert_to(p_plan_cycle_id,'UTF8'),'sha256'),'hex');
  IF v_top_keys<>ARRAY['analysis','receivedAt','requestDigest','requestId','responseCreatedAt','responseId','schemaVersion']::text[]
    OR v_analysis_keys<>ARRAY['analyses','requestId','schemaVersion']::text[]
    OR p_sanitized_decision->>'schemaVersion' IS DISTINCT FROM 'whox.hermes-plan-research-artifact.v1'
    OR p_sanitized_decision->>'requestId' IS DISTINCT FROM v_expected_request_id
    OR p_sanitized_decision->>'requestDigest' IS DISTINCT FROM p_request_sha256
    OR p_sanitized_decision->'analysis'->>'schemaVersion' IS DISTINCT FROM 'whox.foundation-equity-research.v1'
    OR p_sanitized_decision->'analysis'->>'requestId' IS DISTINCT FROM v_expected_request_id
    OR jsonb_typeof(p_sanitized_decision->'analysis'->'analyses') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_sanitized_decision->'analysis'->'analyses') NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'sanitized plan research schema is invalid' USING ERRCODE='23514';
  END IF;

  IF jsonb_typeof(p_sanitized_decision->'responseId') IS DISTINCT FROM 'string'
    OR p_sanitized_decision->>'responseId' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR jsonb_typeof(p_sanitized_decision->'responseCreatedAt') IS DISTINCT FROM 'string'
    OR p_sanitized_decision->>'responseCreatedAt'
      !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    OR jsonb_typeof(p_sanitized_decision->'receivedAt') IS DISTINCT FROM 'string'
    OR p_sanitized_decision->>'receivedAt'
      !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN
    RAISE EXCEPTION 'sanitized plan research provenance is invalid' USING ERRCODE='23514';
  END IF;
  IF (p_sanitized_decision->>'responseCreatedAt')::timestamptz
      <(p_sanitized_decision->>'receivedAt')::timestamptz-interval '15 minutes'
    OR (p_sanitized_decision->>'responseCreatedAt')::timestamptz
      >(p_sanitized_decision->>'receivedAt')::timestamptz+interval '60 seconds' THEN
    RAISE EXCEPTION 'sanitized plan research timestamps are invalid' USING ERRCODE='23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_sanitized_decision->'analysis'->'analyses') AS item
    WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
      OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(item) AS key)
        <>ARRAY['assessment','dataLimitations','riskFactors','summary','symbol']::text[]
      OR item->>'symbol' !~ '^[A-Z][A-Z0-9.-]{0,14}$'
      OR item->>'assessment' NOT IN ('supportive','mixed','cautionary')
      OR jsonb_typeof(item->'summary') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item->'riskFactors') IS DISTINCT FROM 'array'
      OR jsonb_typeof(item->'dataLimitations') IS DISTINCT FROM 'array'
  ) THEN
    RAISE EXCEPTION 'sanitized plan research analysis is invalid' USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_sanitized_decision->'analysis'->'analyses') AS item
    WHERE length(item->>'summary') NOT BETWEEN 1 AND 240
      OR item->>'summary' ~ '[[:cntrl:]]'
      OR jsonb_array_length(item->'riskFactors')>2
      OR jsonb_array_length(item->'dataLimitations')>2
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(item->'riskFactors') AS factor
        WHERE jsonb_typeof(factor) IS DISTINCT FROM 'string'
          OR length(factor#>>'{}') NOT BETWEEN 1 AND 120
          OR factor#>>'{}' ~ '[[:cntrl:]]'
      )
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(item->'dataLimitations') AS limitation
        WHERE jsonb_typeof(limitation) IS DISTINCT FROM 'string'
          OR length(limitation#>>'{}') NOT BETWEEN 1 AND 120
          OR limitation#>>'{}' ~ '[[:cntrl:]]'
      )
  ) THEN
    RAISE EXCEPTION 'sanitized plan research text bounds are invalid' USING ERRCODE='23514';
  END IF;

  SELECT array_agg(item->>'symbol' ORDER BY (item->>'symbol') COLLATE "C") INTO v_symbols
  FROM jsonb_array_elements(p_sanitized_decision->'analysis'->'analyses') AS item;
  SELECT array_agg(item->>'symbol' ORDER BY (item->>'symbol') COLLATE "C") INTO v_input_symbols
  FROM jsonb_array_elements(v_input.research_universe) AS item;
  IF v_symbols IS DISTINCT FROM v_input_symbols THEN
    RAISE EXCEPTION 'plan research symbols do not match frozen input' USING ERRCODE='23514';
  END IF;

  v_decision_sha256 := encode(digest(convert_to(p_sanitized_decision::text,'UTF8'),'sha256'),'hex');
  INSERT INTO paper_plan_research_artifacts(
    plan_cycle_id,provider_id,model_id,source_as_of,context_sha256,request_sha256,
    sanitized_decision,decision_sha256
  ) VALUES(
    p_plan_cycle_id,p_provider_id,p_model_id,p_source_as_of,p_context_sha256,p_request_sha256,
    p_sanitized_decision,v_decision_sha256
  ) ON CONFLICT ON CONSTRAINT paper_plan_research_artifacts_plan_cycle_id_key DO NOTHING;

  SELECT artifact.* INTO v_result
  FROM paper_plan_research_artifacts AS artifact
  WHERE artifact.plan_cycle_id=p_plan_cycle_id
    AND artifact.provider_id=p_provider_id
    AND artifact.model_id=p_model_id
    AND artifact.source_as_of=p_source_as_of
    AND artifact.context_sha256=p_context_sha256
    AND artifact.request_sha256=p_request_sha256
    AND artifact.decision_sha256=v_decision_sha256
    AND artifact.sanitized_decision=p_sanitized_decision;
  IF v_result.id IS NULL THEN
    RAISE EXCEPTION 'plan research artifact idempotency conflict' USING ERRCODE='23505';
  END IF;

  RETURN QUERY SELECT v_result.id::uuid,v_result.plan_cycle_id::text,v_result.provider_id::text,
    v_result.model_id::text,v_result.source_as_of::timestamptz,v_result.context_sha256::text,
    v_result.request_sha256::text,v_result.decision_sha256::text,
    v_result.sanitized_decision::jsonb,v_result.created_at::timestamptz;
END;
$$;

CREATE OR REPLACE FUNCTION app.schedule_paper_agent_jobs(
  p_approved_providers text[],
  p_market_data_provider_id text,
  p_batch_size integer DEFAULT 250,
  p_autonomous_mode_enabled boolean DEFAULT false,
  p_max_outstanding_jobs integer DEFAULT 1000
)
RETURNS TABLE (
  lock_acquired boolean,
  evaluated_agents integer,
  due_agents integer,
  refresh_jobs_enqueued integer,
  research_jobs_enqueued integer,
  agent_runs_enqueued integer,
  research_blocked_agents integer,
  backpressure_blocked_agents integer,
  quote_blocked_agents integer,
  other_blocked_agents integer,
  max_scheduling_lag_seconds integer,
  oldest_due_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,app
AS $$
DECLARE
  v_now timestamptz := date_trunc('second',clock_timestamp());
  v_mapping record;
  v_cycle record;
  v_candidate record;
  v_cycle_id text;
  v_bucket_epoch bigint;
  v_as_of_epoch bigint;
  v_bucket_start timestamptz;
  v_capacity integer;
  v_outstanding integer;
  v_symbol_count integer;
  v_inserted boolean;
  v_job_id uuid;
  v_job_created_at timestamptz;
  v_quote_source_timestamp timestamptz;
  v_block_reason text;
  v_last_refresh timestamptz;
  v_last_run timestamptz;
  v_next_due timestamptz;
  v_active_incident boolean;
  v_evaluated integer := 0;
  v_due_count integer := 0;
  v_refresh_count integer := 0;
  v_research_count integer := 0;
  v_run_count integer := 0;
  v_research_blocked integer := 0;
  v_backpressure_blocked integer := 0;
  v_quote_blocked integer := 0;
  v_other_blocked integer := 0;
  v_max_lag integer := 0;
  v_oldest_due timestamptz;
  v_current_cycle_ids text[] := ARRAY[]::text[];
BEGIN
  IF p_batch_size IS NULL OR p_batch_size NOT BETWEEN 1 AND 1000
    OR p_max_outstanding_jobs IS NULL OR p_max_outstanding_jobs NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'paper scheduler bounds are invalid' USING ERRCODE='22023';
  END IF;
  IF p_approved_providers IS NULL OR cardinality(p_approved_providers)=0 OR EXISTS (
    SELECT 1 FROM unnest(p_approved_providers) AS provider
    WHERE provider IS NULL OR provider !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$'
  ) OR p_market_data_provider_id IS NULL
    OR p_market_data_provider_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$'
    OR NOT p_market_data_provider_id=ANY(p_approved_providers) THEN
    RAISE EXCEPTION 'paper scheduler provider configuration is invalid' USING ERRCODE='22023';
  END IF;

  IF NOT pg_try_advisory_xact_lock(hashtextextended('whox:paper-agent-scheduler:v2',0)) THEN
    RETURN QUERY SELECT false,0,0,0,0,0,0,0,0,0,0,NULL::timestamptz;
    RETURN;
  END IF;

  SELECT count(*)::integer INTO v_outstanding
  FROM queue_jobs
  WHERE queue_name IN ('plan-research','market-data','agent-runs')
    AND status IN ('queued','failed','leased');
  v_capacity := greatest(0,p_max_outstanding_jobs-v_outstanding);

  SELECT EXISTS (
    SELECT 1 FROM system_incidents
    WHERE environment='paper' AND status<>'resolved' AND lower(severity) IN ('blocking','critical')
  ) INTO v_active_incident;

  -- Create exactly one immutable cycle per normalized plan assignment/bucket.
  FOR v_mapping IN
    SELECT plan.id AS plan_id,catalog.id AS catalog_version_id,entry.agent_version_id,
      version.deterministic_strategy_version,cohort.frequency_minutes
    FROM plans AS plan
    JOIN plan_agent_catalog_versions AS catalog
      ON catalog.plan_id=plan.id AND catalog.activated_at IS NOT NULL
      AND catalog.activated_at<=v_now AND catalog.superseded_at IS NULL
    JOIN plan_agent_catalog_entries AS entry ON entry.catalog_version_id=catalog.id
    JOIN agent_versions AS version ON version.id=entry.agent_version_id
      AND version.status IN ('paper','limited_rollout','live')
    JOIN agent_definitions AS definition ON definition.id=version.agent_definition_id
      AND definition.retired_at IS NULL
    -- The shared cadence is the fastest current effective cadence in the
    -- genuinely eligible cohort. Slower members still retain their own
    -- durable next_due_at and are not evaluated on every shared cycle.
    JOIN LATERAL (
      SELECT min((effective_entitlements.features->>'monitoringFrequencyMinutes')::integer)::integer
        AS frequency_minutes
      FROM user_agents AS user_agent
      JOIN users AS app_user ON app_user.id=user_agent.user_id
        AND app_user.status='active' AND app_user.account_mode='paper'
      JOIN LATERAL (
        SELECT current_subscription.plan_id,current_plan.features AS plan_features
        FROM subscriptions AS current_subscription
        JOIN plans AS current_plan ON current_plan.id=current_subscription.plan_id AND current_plan.active
        WHERE current_subscription.user_id=user_agent.user_id
          AND current_subscription.status IN ('active','grace_period')
          AND current_subscription.effective_at<=v_now AND current_subscription.revoked_at IS NULL
          AND (current_subscription.expires_at IS NULL OR current_subscription.expires_at>v_now)
        ORDER BY current_subscription.effective_at DESC,current_subscription.id DESC LIMIT 1
      ) AS subscription ON subscription.plan_id=plan.id
      LEFT JOIN LATERAL (
        SELECT jsonb_object_agg(latest.feature_key,latest.value) AS values
        FROM (
          SELECT DISTINCT ON (entitlement.feature_key) entitlement.feature_key,entitlement.value
          FROM entitlements AS entitlement
          WHERE entitlement.user_id=user_agent.user_id
            AND entitlement.effective_at<=v_now
            AND (entitlement.expires_at IS NULL OR entitlement.expires_at>v_now)
          ORDER BY entitlement.feature_key,entitlement.effective_at DESC,entitlement.id DESC
        ) AS latest
      ) AS overrides ON true
      CROSS JOIN LATERAL (
        SELECT subscription.plan_features||COALESCE(overrides.values,'{}'::jsonb) AS features
      ) AS effective_entitlements
      JOIN LATERAL (
        SELECT eligibility.adviser_client_classification
        FROM eligibility_profiles AS eligibility
        WHERE eligibility.user_id=user_agent.user_id
          AND eligibility.eligibility_status='eligible'
          AND eligibility.assessed_at<=v_now
          AND (eligibility.superseded_at IS NULL OR eligibility.superseded_at>v_now)
        ORDER BY eligibility.assessed_at DESC,eligibility.id DESC LIMIT 1
      ) AS eligibility ON true
      JOIN LATERAL (
        SELECT assessment.id
        FROM risk_assessments AS assessment
        WHERE assessment.user_id=user_agent.user_id AND assessment.completed_at<=v_now
          AND (assessment.superseded_at IS NULL OR assessment.superseded_at>v_now)
        ORDER BY assessment.completed_at DESC,assessment.id DESC LIMIT 1
      ) AS assessment ON true
      JOIN LATERAL (
        SELECT policy.limits
        FROM risk_policies AS policy
        WHERE policy.user_id=user_agent.user_id AND policy.effective_at<=v_now
          AND (policy.superseded_at IS NULL OR policy.superseded_at>v_now)
        ORDER BY policy.version DESC LIMIT 1
      ) AS policy ON true
      JOIN LATERAL (
        SELECT current_configuration.configuration
        FROM agent_configurations AS current_configuration
        WHERE current_configuration.user_agent_id=user_agent.id
          AND current_configuration.user_id=user_agent.user_id
          AND current_configuration.effective_at<=v_now
          AND (current_configuration.superseded_at IS NULL OR current_configuration.superseded_at>v_now)
        ORDER BY current_configuration.version DESC LIMIT 1
      ) AS configuration ON true
      JOIN broker_connections AS connection ON connection.user_id=user_agent.user_id
        AND connection.provider='robinhood_mcp' AND connection.status='connected'
        AND connection.revoked_at IS NULL
      JOIN broker_accounts AS account ON account.connection_id=connection.id
        AND account.user_id=user_agent.user_id AND account.is_agentic_account
        AND account.active AND account.verified_for_trading_at IS NOT NULL
      CROSS JOIN LATERAL (
        SELECT ARRAY['terms','privacy','ai-risk']::text[]
          || CASE WHEN effective_entitlements.features->'optionsTrading'='true'::jsonb
            THEN ARRAY['options']::text[] ELSE ARRAY[]::text[] END
          || CASE WHEN eligibility.adviser_client_classification='adviser_client'
            THEN ARRAY['advisory']::text[] ELSE ARRAY[]::text[] END AS document_keys
      ) AS applicable_legal
      CROSS JOIN LATERAL (
        SELECT count(*)::integer AS value FROM user_agents AS counted
        WHERE counted.user_id=user_agent.user_id AND counted.deleted_at IS NULL
          AND counted.status IN ('monitoring','waiting_approval','automatic')
      ) AS active_count
      WHERE user_agent.agent_version_id=entry.agent_version_id
        AND user_agent.environment='paper' AND user_agent.deleted_at IS NULL
        AND user_agent.status IN ('monitoring','automatic')
        AND (user_agent.status<>'automatic' OR p_autonomous_mode_enabled)
        AND upper(configuration.configuration->>'symbol') ~ '^[A-Z][A-Z0-9.-]{0,14}$'
        AND upper(configuration.configuration->>'symbol')=ANY(entry.research_universe)
        AND effective_entitlements.features->>'monitoringFrequencyMinutes' ~ '^[1-9][0-9]{0,5}$'
        AND (effective_entitlements.features->>'monitoringFrequencyMinutes')::integer BETWEEN 1 AND 525600
        AND effective_entitlements.features->>'maximumActiveAgents' ~ '^[1-9][0-9]{0,5}$'
        AND (effective_entitlements.features->>'maximumActiveAgents')::integer BETWEEN 1 AND 3
        AND active_count.value<=(effective_entitlements.features->>'maximumActiveAgents')::integer
        AND jsonb_typeof(effective_entitlements.features->'agentCatalog')='array'
        AND effective_entitlements.features->'agentCatalog' @> jsonb_build_array(definition.agent_key)
        AND jsonb_typeof(version.definition->'requiredBrokerageCapabilities')='array'
        AND jsonb_array_length(version.definition->'requiredBrokerageCapabilities')>0
        AND (
          (version.definition->'instruments' @> '["equity"]'::jsonb
            AND effective_entitlements.features->'stockTrading'='true'::jsonb)
          OR
          (version.definition->'instruments' @> '["option"]'::jsonb
            AND effective_entitlements.features->'optionsTrading'='true'::jsonb)
        )
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(version.definition->'requiredBrokerageCapabilities') AS required(tool_name)
          WHERE NOT EXISTS (
            SELECT 1 FROM broker_capabilities AS capability
            WHERE capability.connection_id=connection.id AND capability.tool_name=required.tool_name
              AND capability.unavailable_at IS NULL
              AND capability.last_seen_at>v_now-interval '300 seconds'
              AND capability.last_seen_at<=v_now+interval '5 seconds'
          )
        )
        AND (
          SELECT count(*)::integer
          FROM (
            SELECT DISTINCT ON (document.document_key) document.id,document.document_key
            FROM legal_documents AS document
            WHERE document.document_key=ANY(applicable_legal.document_keys)
              AND document.production_approved AND document.published_at<=v_now
              AND (document.retired_at IS NULL OR document.retired_at>v_now)
            ORDER BY document.document_key,document.published_at DESC,document.created_at DESC
          ) AS current_document
          WHERE EXISTS (
            SELECT 1 FROM legal_consents AS consent
            WHERE consent.user_id=user_agent.user_id
              AND consent.legal_document_id=current_document.id
              AND consent.accepted_at<=v_now AND consent.revoked_at IS NULL
          )
        )=cardinality(applicable_legal.document_keys)
    ) AS cohort ON cohort.frequency_minutes IS NOT NULL
    WHERE plan.active
  LOOP
    v_bucket_epoch := floor(extract(epoch FROM v_now)/(v_mapping.frequency_minutes*60))::bigint
      *(v_mapping.frequency_minutes*60)::bigint;
    v_bucket_start := to_timestamp(v_bucket_epoch);
    v_as_of_epoch := floor(extract(epoch FROM v_now))::bigint;
    v_cycle_id := 'paper-plan-cycle:'||v_mapping.plan_id::text||':'||v_mapping.catalog_version_id::text
      ||':'||v_mapping.agent_version_id::text||':'||v_bucket_epoch::text||':'||v_as_of_epoch::text;
    INSERT INTO paper_plan_cycles(
      id,plan_id,catalog_version_id,agent_version_id,plan_agent_assignment_id,
      schedule_bucket_started_at,evaluation_as_of,strategy_version
    ) VALUES(
      v_cycle_id,v_mapping.plan_id,v_mapping.catalog_version_id,v_mapping.agent_version_id,
      'plan-agent-assignment:'||v_mapping.catalog_version_id::text||':'||v_mapping.agent_version_id::text,
      v_bucket_start,v_now,v_mapping.deterministic_strategy_version
    ) ON CONFLICT(plan_id,catalog_version_id,agent_version_id,schedule_bucket_started_at) DO NOTHING;
    SELECT current_cycle.id INTO v_cycle_id
    FROM paper_plan_cycles AS current_cycle
    WHERE current_cycle.plan_id=v_mapping.plan_id
      AND current_cycle.catalog_version_id=v_mapping.catalog_version_id
      AND current_cycle.agent_version_id=v_mapping.agent_version_id
      AND current_cycle.schedule_bucket_started_at=v_bucket_start;
    IF v_cycle_id IS NOT NULL THEN
      v_current_cycle_ids:=array_append(v_current_cycle_ids,v_cycle_id);
    END IF;
  END LOOP;

  -- Elect one plan-level Hermes research job. The payload contains no tenant,
  -- account, broker connection, policy, portfolio, or credential fields.
  FOR v_cycle IN
    SELECT cycle.*,assignment.research_universe
    FROM paper_plan_cycles AS cycle
    JOIN plan_agent_catalog_versions AS catalog ON catalog.id=cycle.catalog_version_id
      AND catalog.superseded_at IS NULL
    JOIN plan_agent_catalog_entries AS assignment
      ON assignment.catalog_version_id=cycle.catalog_version_id
      AND assignment.agent_version_id=cycle.agent_version_id
    LEFT JOIN paper_plan_research_artifacts AS artifact ON artifact.plan_cycle_id=cycle.id
    WHERE artifact.id IS NULL
      AND cycle.id=ANY(v_current_cycle_ids)
      AND cycle.schedule_bucket_started_at=(
        SELECT max(current_cycle.schedule_bucket_started_at)
        FROM paper_plan_cycles AS current_cycle
        WHERE current_cycle.plan_id=cycle.plan_id
          AND current_cycle.catalog_version_id=cycle.catalog_version_id
          AND current_cycle.agent_version_id=cycle.agent_version_id
      )
    ORDER BY cycle.evaluation_as_of,cycle.id
  LOOP
    v_symbol_count:=cardinality(v_cycle.research_universe);
    IF v_symbol_count BETWEEN 1 AND 50 AND v_capacity>0 THEN
      INSERT INTO queue_jobs(queue_name,user_id,job_type,payload,idempotency_key,available_at,priority,max_attempts)
      VALUES(
        'market-data',NULL,'refresh_plan_research_quotes',
        jsonb_build_object(
          'symbols',to_jsonb(v_cycle.research_universe),
          'providerId',p_market_data_provider_id,
          'planCycleId',v_cycle.id
        ),
        'paper-plan-quote-refresh:'||encode(digest(convert_to(v_cycle.id,'UTF8'),'sha256'),'hex'),
        v_now,10,5
      ) ON CONFLICT(queue_name,idempotency_key) DO NOTHING
      RETURNING id,(xmax=0) INTO v_job_id,v_inserted;
      IF v_inserted THEN v_refresh_count:=v_refresh_count+1;v_capacity:=v_capacity-1; END IF;
    END IF;
    IF v_symbol_count BETWEEN 1 AND 50 AND v_capacity>0 THEN
      INSERT INTO queue_jobs(queue_name,user_id,job_type,payload,idempotency_key,available_at,priority,max_attempts)
      VALUES(
        'plan-research',NULL,'plan_research',
        jsonb_build_object(
          'planCycleId',v_cycle.id,
          'planId',v_cycle.plan_id,
          'planCatalogVersionId',v_cycle.catalog_version_id,
          'planAgentAssignmentId',v_cycle.plan_agent_assignment_id,
          'agentVersionId',v_cycle.agent_version_id,
          'deterministicStrategyVersion',v_cycle.strategy_version,
          'asOf',v_cycle.evaluation_as_of
        ),
        'paper-plan-research:'||encode(digest(convert_to(v_cycle.id,'UTF8'),'sha256'),'hex'),
        v_now,20,5
      ) ON CONFLICT(queue_name,idempotency_key) DO NOTHING
      RETURNING id,(xmax=0) INTO v_job_id,v_inserted;
      IF v_inserted THEN v_research_count:=v_research_count+1;v_capacity:=v_capacity-1; END IF;
    END IF;
  END LOOP;

  FOR v_candidate IN
    WITH bound AS (
      SELECT user_agent.id AS user_agent_id,user_agent.user_id,user_agent.status AS user_agent_status,
        upper(configuration.configuration->>'symbol') AS symbol,
        subscription.plan_id,effective_entitlements.features,
        cycle.id AS plan_cycle_id,cycle.catalog_version_id,cycle.plan_agent_assignment_id,
        cycle.agent_version_id,cycle.strategy_version,cycle.schedule_bucket_started_at,
        cycle.evaluation_as_of,
        CASE WHEN effective_entitlements.features->>'monitoringFrequencyMinutes' ~ '^[1-9][0-9]{0,5}$'
          THEN (effective_entitlements.features->>'monitoringFrequencyMinutes')::integer END AS frequency_minutes,
        account.id AS broker_account_id,connection.last_sync_at AS connection_last_sync_at,
        portfolio.source_timestamp AS portfolio_source_timestamp,portfolio.valid_until AS portfolio_valid_until,
        CASE WHEN policy.limits->>'maximumQuoteAgeSeconds' ~ '^[1-9][0-9]{0,8}$'
          THEN (policy.limits->>'maximumQuoteAgeSeconds')::integer END AS maximum_quote_age_seconds,
        CASE WHEN policy.limits->>'maximumAccountSnapshotAgeSeconds' ~ '^[1-9][0-9]{0,8}$'
          THEN (policy.limits->>'maximumAccountSnapshotAgeSeconds')::integer END AS maximum_snapshot_age_seconds,
        artifact.id AS research_artifact_id,artifact.decision_sha256 AS research_artifact_digest,
        last_run.started_at AS last_run_started_at,schedule.last_agent_run_enqueued_at,
        schedule.last_refresh_enqueued_at,schedule.next_due_at AS scheduled_next_due_at,
        active_count.value AS active_agent_count,
        CASE WHEN effective_entitlements.features->>'maximumActiveAgents' ~ '^[1-9][0-9]{0,5}$'
          THEN (effective_entitlements.features->>'maximumActiveAgents')::integer END AS maximum_active_agents,
        cardinality(assignment.research_universe) AS research_symbol_count,
        assignment.research_universe
      FROM user_agents AS user_agent
      JOIN users AS app_user ON app_user.id=user_agent.user_id
        AND app_user.status='active' AND app_user.account_mode='paper'
      JOIN agent_versions AS version ON version.id=user_agent.agent_version_id
        AND version.status IN ('paper','limited_rollout','live')
      JOIN agent_definitions AS definition ON definition.id=version.agent_definition_id
        AND definition.retired_at IS NULL
      JOIN LATERAL (
        SELECT current_configuration.configuration,current_configuration.effective_at
        FROM agent_configurations AS current_configuration
        WHERE current_configuration.user_agent_id=user_agent.id
          AND current_configuration.user_id=user_agent.user_id
          AND current_configuration.effective_at<=v_now
          AND (current_configuration.superseded_at IS NULL OR current_configuration.superseded_at>v_now)
        ORDER BY current_configuration.version DESC LIMIT 1
      ) AS configuration ON true
      JOIN LATERAL (
        SELECT current_subscription.plan_id,plan.features AS plan_features
        FROM subscriptions AS current_subscription
        JOIN plans AS plan ON plan.id=current_subscription.plan_id AND plan.active
        WHERE current_subscription.user_id=user_agent.user_id
          AND current_subscription.status IN ('active','grace_period')
          AND current_subscription.effective_at<=v_now AND current_subscription.revoked_at IS NULL
          AND (current_subscription.expires_at IS NULL OR current_subscription.expires_at>v_now)
          AND plan.features->>'monitoringFrequencyMinutes' ~ '^[1-9][0-9]{0,5}$'
        ORDER BY current_subscription.effective_at DESC LIMIT 1
      ) AS subscription ON true
      LEFT JOIN LATERAL (
        SELECT jsonb_object_agg(latest.feature_key,latest.value) AS values
        FROM (
          SELECT DISTINCT ON (entitlement.feature_key) entitlement.feature_key,entitlement.value
          FROM entitlements AS entitlement
          WHERE entitlement.user_id=user_agent.user_id
            AND entitlement.effective_at<=v_now
            AND (entitlement.expires_at IS NULL OR entitlement.expires_at>v_now)
          ORDER BY entitlement.feature_key,entitlement.effective_at DESC
        ) AS latest
      ) AS overrides ON true
      CROSS JOIN LATERAL (
        SELECT subscription.plan_features||COALESCE(overrides.values,'{}'::jsonb) AS features
      ) AS effective_entitlements
      JOIN LATERAL (
        SELECT current_eligibility.adviser_client_classification
        FROM eligibility_profiles AS current_eligibility
        WHERE current_eligibility.user_id=user_agent.user_id
          AND current_eligibility.eligibility_status='eligible'
          AND current_eligibility.assessed_at<=v_now
          AND (current_eligibility.superseded_at IS NULL OR current_eligibility.superseded_at>v_now)
        ORDER BY current_eligibility.assessed_at DESC,current_eligibility.id DESC LIMIT 1
      ) AS eligibility ON true
      JOIN LATERAL (
        SELECT current_assessment.id
        FROM risk_assessments AS current_assessment
        WHERE current_assessment.user_id=user_agent.user_id
          AND current_assessment.completed_at<=v_now
          AND (current_assessment.superseded_at IS NULL OR current_assessment.superseded_at>v_now)
        ORDER BY current_assessment.completed_at DESC,current_assessment.id DESC LIMIT 1
      ) AS assessment ON true
      JOIN plan_agent_catalog_versions AS catalog ON catalog.plan_id=subscription.plan_id
        AND catalog.activated_at IS NOT NULL AND catalog.activated_at<=v_now AND catalog.superseded_at IS NULL
      JOIN plan_agent_catalog_entries AS assignment ON assignment.catalog_version_id=catalog.id
        AND assignment.agent_version_id=user_agent.agent_version_id
      JOIN LATERAL (
        SELECT current_cycle.* FROM paper_plan_cycles AS current_cycle
        WHERE current_cycle.plan_id=subscription.plan_id
          AND current_cycle.catalog_version_id=catalog.id
          AND current_cycle.agent_version_id=user_agent.agent_version_id
          AND current_cycle.schedule_bucket_started_at<=v_now
          AND current_cycle.evaluation_as_of<=v_now+interval '5 seconds'
        ORDER BY current_cycle.schedule_bucket_started_at DESC LIMIT 1
      ) AS cycle ON true
      LEFT JOIN paper_plan_research_artifacts AS artifact ON artifact.plan_cycle_id=cycle.id
      JOIN broker_connections AS connection ON connection.user_id=user_agent.user_id
        AND connection.provider='robinhood_mcp' AND connection.status='connected'
        AND connection.revoked_at IS NULL
      JOIN broker_accounts AS account ON account.connection_id=connection.id
        AND account.user_id=user_agent.user_id AND account.is_agentic_account
        AND account.active AND account.verified_for_trading_at IS NOT NULL
      JOIN LATERAL (
        SELECT current_policy.limits FROM risk_policies AS current_policy
        WHERE current_policy.user_id=user_agent.user_id AND current_policy.effective_at<=v_now
          AND (current_policy.superseded_at IS NULL OR current_policy.superseded_at>v_now)
        ORDER BY current_policy.version DESC LIMIT 1
      ) AS policy ON true
      CROSS JOIN LATERAL (
        SELECT ARRAY['terms','privacy','ai-risk']::text[]
          || CASE WHEN effective_entitlements.features->'optionsTrading'='true'::jsonb
            THEN ARRAY['options']::text[] ELSE ARRAY[]::text[] END
          || CASE WHEN eligibility.adviser_client_classification='adviser_client'
            THEN ARRAY['advisory']::text[] ELSE ARRAY[]::text[] END AS document_keys
      ) AS applicable_legal
      LEFT JOIN LATERAL (
        SELECT snapshot.source_timestamp,snapshot.valid_until FROM portfolio_snapshots AS snapshot
        WHERE snapshot.user_id=user_agent.user_id AND snapshot.broker_account_id=account.id
          AND snapshot.environment='paper' AND snapshot.source_timestamp<=v_now+interval '5 seconds'
        ORDER BY snapshot.source_timestamp DESC,snapshot.captured_at DESC LIMIT 1
      ) AS portfolio ON true
      LEFT JOIN LATERAL (
        SELECT run.started_at FROM agent_runs AS run
        WHERE run.user_id=user_agent.user_id AND run.user_agent_id=user_agent.id
        ORDER BY run.started_at DESC LIMIT 1
      ) AS last_run ON true
      LEFT JOIN paper_agent_schedule_states AS schedule ON schedule.user_agent_id=user_agent.id
      CROSS JOIN LATERAL (
        SELECT count(*)::integer AS value FROM user_agents AS counted
        WHERE counted.user_id=user_agent.user_id AND counted.deleted_at IS NULL
          AND counted.status IN ('monitoring','waiting_approval','automatic')
      ) AS active_count
      WHERE user_agent.environment='paper' AND user_agent.deleted_at IS NULL
        AND user_agent.status IN ('monitoring','automatic')
        AND (user_agent.status<>'automatic' OR p_autonomous_mode_enabled)
        AND upper(configuration.configuration->>'symbol') ~ '^[A-Z][A-Z0-9.-]{0,14}$'
        AND upper(configuration.configuration->>'symbol')=ANY(assignment.research_universe)
        AND configuration.effective_at<=cycle.evaluation_as_of
        AND cycle.strategy_version=version.deterministic_strategy_version
        AND jsonb_typeof(effective_entitlements.features->'agentCatalog')='array'
        AND effective_entitlements.features->'agentCatalog' @> jsonb_build_array(definition.agent_key)
        AND jsonb_typeof(version.definition->'requiredBrokerageCapabilities')='array'
        AND jsonb_array_length(version.definition->'requiredBrokerageCapabilities')>0
        AND (
          (version.definition->'instruments' @> '["equity"]'::jsonb
            AND effective_entitlements.features->'stockTrading'='true'::jsonb)
          OR
          (version.definition->'instruments' @> '["option"]'::jsonb
            AND effective_entitlements.features->'optionsTrading'='true'::jsonb)
        )
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(version.definition->'requiredBrokerageCapabilities') AS required(tool_name)
          WHERE NOT EXISTS (
            SELECT 1 FROM broker_capabilities AS capability
            WHERE capability.connection_id=connection.id AND capability.tool_name=required.tool_name
              AND capability.unavailable_at IS NULL AND capability.last_seen_at>v_now-interval '300 seconds'
              AND capability.last_seen_at<=v_now+interval '5 seconds'
            )
        )
        AND (
          SELECT count(*)::integer
          FROM (
            SELECT DISTINCT ON (document.document_key) document.id,document.document_key
            FROM legal_documents AS document
            WHERE document.document_key=ANY(applicable_legal.document_keys)
              AND document.production_approved AND document.published_at<=v_now
              AND (document.retired_at IS NULL OR document.retired_at>v_now)
            ORDER BY document.document_key,document.published_at DESC,document.created_at DESC
          ) AS current_document
          WHERE EXISTS (
            SELECT 1 FROM legal_consents AS consent
            WHERE consent.user_id=user_agent.user_id
              AND consent.legal_document_id=current_document.id
              AND consent.accepted_at<=v_now AND consent.revoked_at IS NULL
          )
        )=cardinality(applicable_legal.document_keys)
    )
    SELECT * FROM bound
    WHERE frequency_minutes BETWEEN 1 AND 525600
      AND maximum_active_agents BETWEEN 1 AND 3
      AND active_agent_count<=maximum_active_agents
    ORDER BY evaluation_as_of,user_agent_id
    LIMIT p_batch_size
  LOOP
    v_evaluated:=v_evaluated+1;
    v_next_due:=COALESCE(v_candidate.scheduled_next_due_at,v_candidate.evaluation_as_of);
    v_last_refresh:=v_candidate.last_refresh_enqueued_at;
    v_last_run:=v_candidate.last_agent_run_enqueued_at;
    v_block_reason:='NOT_DUE';
    v_quote_source_timestamp:=NULL;

    IF (v_candidate.scheduled_next_due_at IS NULL OR v_candidate.scheduled_next_due_at<=v_now) AND ((
      v_candidate.last_run_started_at IS NULL AND v_candidate.last_agent_run_enqueued_at IS NULL
    ) OR (
      COALESCE(v_candidate.last_run_started_at,'-infinity'::timestamptz)
        <=v_candidate.evaluation_as_of-make_interval(mins=>v_candidate.frequency_minutes)
      AND COALESCE(v_candidate.last_agent_run_enqueued_at,'-infinity'::timestamptz)
        <=v_candidate.evaluation_as_of-make_interval(mins=>v_candidate.frequency_minutes)
    )) THEN
      v_due_count:=v_due_count+1;
      v_max_lag:=greatest(v_max_lag,greatest(0,floor(extract(epoch FROM (v_now-v_candidate.evaluation_as_of)))::integer));
      v_oldest_due:=least(v_oldest_due,v_candidate.evaluation_as_of);
      v_block_reason:=NULL;

      IF v_active_incident THEN
        v_block_reason:='SYSTEM_INCIDENT_ACTIVE';v_other_blocked:=v_other_blocked+1;
      ELSIF v_candidate.research_symbol_count>50 THEN
        v_block_reason:='PLAN_RESEARCH_UNIVERSE_TOO_LARGE';v_research_blocked:=v_research_blocked+1;
      ELSIF NOT v_candidate.symbol=ANY(v_candidate.research_universe) THEN
        v_block_reason:='PLAN_RESEARCH_SYMBOL_UNSUPPORTED';v_research_blocked:=v_research_blocked+1;
      ELSIF v_candidate.maximum_quote_age_seconds IS NULL OR v_candidate.maximum_snapshot_age_seconds IS NULL THEN
        v_block_reason:='CURRENT_RISK_POLICY_REQUIRED';v_other_blocked:=v_other_blocked+1;
      ELSIF v_capacity<=0 THEN
        v_block_reason:='SCHEDULER_BACKPRESSURE';v_backpressure_blocked:=v_backpressure_blocked+1;
      ELSE
        INSERT INTO queue_jobs(queue_name,user_id,job_type,payload,idempotency_key,available_at,priority,max_attempts)
        VALUES(
          'market-data',v_candidate.user_id,'refresh_quotes',
          jsonb_build_object('symbols',jsonb_build_array(v_candidate.symbol),'providerId',p_market_data_provider_id,
            'source','paper-agent-scheduler','userAgentId',v_candidate.user_agent_id,
            'scheduleBucket',v_candidate.evaluation_as_of),
          'paper-quote-refresh:'||encode(digest(convert_to(v_candidate.user_agent_id::text||':'||v_candidate.plan_cycle_id,'UTF8'),'sha256'),'hex'),
          v_now,40,5
        ) ON CONFLICT(queue_name,idempotency_key) DO NOTHING
        RETURNING id,created_at,(xmax=0) INTO v_job_id,v_job_created_at,v_inserted;
        IF v_inserted THEN v_refresh_count:=v_refresh_count+1;v_capacity:=v_capacity-1; END IF;
        v_last_refresh:=COALESCE(v_job_created_at,v_last_refresh);

        IF v_candidate.research_artifact_id IS NULL THEN
          v_block_reason:='PLAN_RESEARCH_PENDING';v_research_blocked:=v_research_blocked+1;
        ELSE
          SELECT snapshot.source_timestamp INTO v_quote_source_timestamp
          FROM market_data_snapshots AS snapshot
          WHERE snapshot.symbol=v_candidate.symbol AND snapshot.data_type='quote'
            AND snapshot.provider=p_market_data_provider_id
            AND snapshot.source_timestamp<=v_now+interval '5 seconds'
            AND snapshot.source_timestamp>=v_now-make_interval(secs=>v_candidate.maximum_quote_age_seconds)
          ORDER BY snapshot.source_timestamp DESC,snapshot.received_at DESC LIMIT 1;
          IF v_quote_source_timestamp IS NULL THEN
            v_block_reason:='MARKET_QUOTE_REFRESH_PENDING';v_quote_blocked:=v_quote_blocked+1;
          ELSIF v_candidate.portfolio_source_timestamp IS NULL OR v_candidate.portfolio_valid_until<=v_now
            OR v_candidate.portfolio_source_timestamp<v_now-make_interval(secs=>v_candidate.maximum_snapshot_age_seconds)
            OR v_candidate.connection_last_sync_at IS NULL
            OR v_candidate.connection_last_sync_at<v_candidate.portfolio_source_timestamp THEN
            v_block_reason:='ACCOUNT_SNAPSHOT_STALE';v_other_blocked:=v_other_blocked+1;
          ELSIF v_capacity<=0 THEN
            v_block_reason:='SCHEDULER_BACKPRESSURE';v_backpressure_blocked:=v_backpressure_blocked+1;
          ELSE
            INSERT INTO queue_jobs(queue_name,user_id,job_type,payload,idempotency_key,available_at,priority,max_attempts)
            VALUES(
              'agent-runs',v_candidate.user_id,'agent_run',
              jsonb_build_object(
                'userAgentId',v_candidate.user_agent_id,
                'runIdempotencyKey','scheduled-paper-plan-run:'||encode(digest(convert_to(v_candidate.user_agent_id::text||':'||v_candidate.plan_cycle_id,'UTF8'),'sha256'),'hex'),
                'planCycle',jsonb_build_object(
                  'planCycleId',v_candidate.plan_cycle_id,'planId',v_candidate.plan_id,
                  'planCatalogVersionId',v_candidate.catalog_version_id,
                  'planAgentAssignmentId',v_candidate.plan_agent_assignment_id,
                  'agentVersionId',v_candidate.agent_version_id,
                  'deterministicStrategyVersion',v_candidate.strategy_version,
                  'asOf',v_candidate.evaluation_as_of,
                  'researchArtifactId',v_candidate.research_artifact_id,
                  'researchArtifactDigest',v_candidate.research_artifact_digest
                )
              ),
              'paper-agent-run:'||encode(digest(convert_to(v_candidate.user_agent_id::text||':'||v_candidate.plan_cycle_id,'UTF8'),'sha256'),'hex'),
              v_now,60,3
            ) ON CONFLICT(queue_name,idempotency_key) DO NOTHING
            RETURNING id,created_at,(xmax=0) INTO v_job_id,v_job_created_at,v_inserted;
            IF v_inserted THEN v_run_count:=v_run_count+1;v_capacity:=v_capacity-1; END IF;
            v_last_run:=COALESCE(v_job_created_at,v_last_run);
            v_next_due:=COALESCE(v_job_created_at,v_now)+make_interval(mins=>v_candidate.frequency_minutes);
            v_block_reason:=NULL;
          END IF;
        END IF;
      END IF;
    END IF;

    INSERT INTO paper_agent_schedule_states(
      user_agent_id,user_id,monitoring_frequency_minutes,symbol,schedule_bucket_started_at,
      next_due_at,last_evaluated_at,last_refresh_enqueued_at,last_agent_run_enqueued_at,
      last_quote_source_timestamp,block_reason
    ) VALUES(
      v_candidate.user_agent_id,v_candidate.user_id,v_candidate.frequency_minutes,v_candidate.symbol,
      v_candidate.schedule_bucket_started_at,v_next_due,v_now,v_last_refresh,v_last_run,
      v_quote_source_timestamp,v_block_reason
    ) ON CONFLICT(user_agent_id) DO UPDATE SET
      user_id=EXCLUDED.user_id,monitoring_frequency_minutes=EXCLUDED.monitoring_frequency_minutes,
      symbol=EXCLUDED.symbol,schedule_bucket_started_at=EXCLUDED.schedule_bucket_started_at,
      next_due_at=EXCLUDED.next_due_at,last_evaluated_at=EXCLUDED.last_evaluated_at,
      last_refresh_enqueued_at=COALESCE(EXCLUDED.last_refresh_enqueued_at,paper_agent_schedule_states.last_refresh_enqueued_at),
      last_agent_run_enqueued_at=COALESCE(EXCLUDED.last_agent_run_enqueued_at,paper_agent_schedule_states.last_agent_run_enqueued_at),
      last_quote_source_timestamp=EXCLUDED.last_quote_source_timestamp,block_reason=EXCLUDED.block_reason;
  END LOOP;

  RETURN QUERY SELECT true,v_evaluated,v_due_count,v_refresh_count,v_research_count,v_run_count,
    v_research_blocked,v_backpressure_blocked,v_quote_blocked,v_other_blocked,v_max_lag,v_oldest_due;
END;
$$;

REVOKE ALL ON FUNCTION app.paper_plan_research_context(text,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.record_paper_plan_research_artifact(text,text,text,timestamptz,text,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.schedule_paper_agent_jobs(text[],text,integer,boolean,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.valid_plan_agent_research_universe(text[]) FROM PUBLIC;

COMMIT;
