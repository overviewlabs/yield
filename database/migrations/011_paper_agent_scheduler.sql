BEGIN;

-- Backfill the exact runtime discovery contract even when the catalog migration
-- was applied before durable scheduling shipped. Draft versions remain inert.
UPDATE agent_versions
SET definition=jsonb_set(
  definition,
  '{requiredBrokerageCapabilities}',
  '["get_equity_quotes","get_equity_tradability","review_equity_order"]'::jsonb,
  true
)
WHERE id='31000000-0000-4000-8000-000000000001'
  AND version='1.0.0'
  AND status='paper';

-- The scheduler state is durable so a replica restart cannot collapse the
-- monitoring cadence into a tight retry loop. The cross-tenant scheduler never
-- receives direct table access; it may invoke only the bounded function below.
CREATE TABLE paper_agent_schedule_states (
  user_agent_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  monitoring_frequency_minutes integer NOT NULL CHECK (monitoring_frequency_minutes BETWEEN 1 AND 525600),
  symbol text NOT NULL CHECK (symbol ~ '^[A-Z][A-Z0-9.-]{0,14}$'),
  schedule_bucket_started_at timestamptz,
  next_due_at timestamptz NOT NULL,
  last_evaluated_at timestamptz NOT NULL,
  last_refresh_enqueued_at timestamptz,
  last_agent_run_enqueued_at timestamptz,
  last_quote_source_timestamp timestamptz,
  block_reason text CHECK (block_reason IS NULL OR block_reason ~ '^[A-Z0-9_]{1,100}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (user_agent_id,user_id) REFERENCES user_agents(id,user_id) ON DELETE CASCADE,
  UNIQUE (user_agent_id,user_id)
);

CREATE TRIGGER paper_agent_schedule_states_updated_at
BEFORE UPDATE ON paper_agent_schedule_states
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX paper_agent_schedule_states_due_idx
  ON paper_agent_schedule_states(next_due_at,user_agent_id);

CREATE OR REPLACE FUNCTION app.schedule_paper_agent_jobs(
  p_approved_providers text[],
  p_market_data_provider_id text,
  p_batch_size integer DEFAULT 250,
  p_autonomous_mode_enabled boolean DEFAULT false
)
RETURNS TABLE (
  lock_acquired boolean,
  evaluated_agents integer,
  due_agents integer,
  refresh_jobs_enqueued integer,
  agent_runs_enqueued integer,
  quote_blocked_agents integer,
  other_blocked_agents integer,
  max_scheduling_lag_seconds integer,
  oldest_due_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_candidate record;
  v_lock_acquired boolean;
  v_active_incident boolean;
  v_due boolean;
  v_bucket_epoch bigint;
  v_bucket_start timestamptz;
  v_next_due_at timestamptz;
  v_block_reason text;
  v_quote_source_timestamp timestamptz;
  v_refresh_job_id uuid;
  v_refresh_job_created_at timestamptz;
  v_run_job_id uuid;
  v_run_job_created_at timestamptz;
  v_inserted boolean;
  v_last_refresh_enqueued_at timestamptz;
  v_last_run_enqueued_at timestamptz;
  v_lag_seconds integer;
  v_evaluated integer := 0;
  v_due_count integer := 0;
  v_refresh_count integer := 0;
  v_run_count integer := 0;
  v_quote_blocked integer := 0;
  v_other_blocked integer := 0;
  v_max_lag integer := 0;
  v_oldest_due timestamptz;
BEGIN
  IF p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 1000 THEN
    RAISE EXCEPTION 'paper scheduler batch size is invalid' USING ERRCODE = '22023';
  END IF;
  IF p_approved_providers IS NULL OR cardinality(p_approved_providers) = 0 OR EXISTS (
    SELECT 1 FROM unnest(p_approved_providers) AS provider
    WHERE provider IS NULL OR provider !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$'
  ) THEN
    RAISE EXCEPTION 'paper scheduler approved provider allowlist is invalid' USING ERRCODE = '22023';
  END IF;
  IF p_market_data_provider_id IS NULL
    OR p_market_data_provider_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$'
    OR NOT (p_market_data_provider_id=ANY(p_approved_providers)) THEN
    RAISE EXCEPTION 'paper scheduler configured provider is not approved' USING ERRCODE = '22023';
  END IF;

  v_lock_acquired := pg_try_advisory_xact_lock(hashtextextended('whox:paper-agent-scheduler:v1',0));
  IF NOT v_lock_acquired THEN
    RETURN QUERY SELECT false,0,0,0,0,0,0,0,NULL::timestamptz;
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM system_incidents
    WHERE environment='paper' AND status<>'resolved' AND lower(severity) IN ('blocking','critical')
  ) INTO v_active_incident;

  FOR v_candidate IN
    WITH bound AS (
      SELECT
        user_agent.id AS user_agent_id,
        user_agent.user_id,
        upper(configuration.configuration->>'symbol') AS symbol,
        CASE
          WHEN jsonb_typeof(effective_entitlements.features->'monitoringFrequencyMinutes')='number'
            AND effective_entitlements.features->>'monitoringFrequencyMinutes' ~ '^[1-9][0-9]{0,5}$'
          THEN (effective_entitlements.features->>'monitoringFrequencyMinutes')::integer
        END AS monitoring_frequency_minutes,
        CASE
          WHEN jsonb_typeof(effective_entitlements.features->'maximumActiveAgents')='number'
            AND effective_entitlements.features->>'maximumActiveAgents' ~ '^[1-9][0-9]{0,5}$'
          THEN (effective_entitlements.features->>'maximumActiveAgents')::integer
        END AS maximum_active_agents,
        active_count.value AS active_agent_count,
        effective_entitlements.features,
        version.definition AS agent_version_definition,
        user_agent.status AS user_agent_status,
        account.id AS broker_account_id,
        connection.last_sync_at AS connection_last_sync_at,
        portfolio.source_timestamp AS portfolio_source_timestamp,
        portfolio.valid_until AS portfolio_valid_until,
        CASE
          WHEN jsonb_typeof(policy.limits->'maximumQuoteAgeSeconds')='number'
            AND policy.limits->>'maximumQuoteAgeSeconds' ~ '^[1-9][0-9]{0,8}$'
          THEN (policy.limits->>'maximumQuoteAgeSeconds')::integer
        END AS maximum_quote_age_seconds,
        CASE
          WHEN jsonb_typeof(policy.limits->'maximumAccountSnapshotAgeSeconds')='number'
            AND policy.limits->>'maximumAccountSnapshotAgeSeconds' ~ '^[1-9][0-9]{0,8}$'
          THEN (policy.limits->>'maximumAccountSnapshotAgeSeconds')::integer
        END AS maximum_account_snapshot_age_seconds,
        last_run.started_at AS last_run_started_at,
        schedule.last_agent_run_enqueued_at,
        schedule.last_refresh_enqueued_at,
        greatest(user_agent.updated_at,configuration.effective_at,subscription.effective_at) AS activated_at
      FROM user_agents AS user_agent
      JOIN users AS app_user
        ON app_user.id=user_agent.user_id AND app_user.status='active' AND app_user.account_mode='paper'
      JOIN agent_versions AS version
        ON version.id=user_agent.agent_version_id AND version.status IN ('paper','limited_rollout')
      JOIN agent_definitions AS definition
        ON definition.id=version.agent_definition_id AND definition.retired_at IS NULL
      JOIN LATERAL (
        SELECT current_configuration.configuration,current_configuration.effective_at
        FROM agent_configurations AS current_configuration
        WHERE current_configuration.user_agent_id=user_agent.id
          AND current_configuration.user_id=user_agent.user_id
          AND current_configuration.effective_at<=v_now
          AND (current_configuration.superseded_at IS NULL OR current_configuration.superseded_at>v_now)
        ORDER BY current_configuration.version DESC
        LIMIT 1
      ) AS configuration ON true
      JOIN LATERAL (
        SELECT current_subscription.effective_at,current_plan.features
        FROM subscriptions AS current_subscription
        JOIN plans AS current_plan ON current_plan.id=current_subscription.plan_id AND current_plan.active
        WHERE current_subscription.user_id=user_agent.user_id
          AND current_subscription.status IN ('active','grace_period')
          AND current_subscription.effective_at<=v_now
          AND current_subscription.revoked_at IS NULL
          AND (current_subscription.expires_at IS NULL OR current_subscription.expires_at>v_now)
        ORDER BY current_subscription.effective_at DESC
        LIMIT 1
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
        SELECT subscription.features || COALESCE(overrides.values,'{}'::jsonb) AS features
      ) AS effective_entitlements
      JOIN broker_connections AS connection
        ON connection.user_id=user_agent.user_id
        AND connection.provider='robinhood_mcp'
        AND connection.status='connected'
        AND connection.revoked_at IS NULL
      JOIN broker_accounts AS account
        ON account.connection_id=connection.id
        AND account.user_id=user_agent.user_id
        AND account.is_agentic_account
        AND account.active
        AND account.verified_for_trading_at IS NOT NULL
      LEFT JOIN LATERAL (
        SELECT current_policy.limits
        FROM risk_policies AS current_policy
        WHERE current_policy.user_id=user_agent.user_id
          AND current_policy.effective_at<=v_now
          AND (current_policy.superseded_at IS NULL OR current_policy.superseded_at>v_now)
        ORDER BY current_policy.version DESC
        LIMIT 1
      ) AS policy ON true
      LEFT JOIN LATERAL (
        SELECT snapshot.source_timestamp,snapshot.valid_until
        FROM portfolio_snapshots AS snapshot
        WHERE snapshot.user_id=user_agent.user_id
          AND snapshot.broker_account_id=account.id
          AND snapshot.environment='paper'
          AND snapshot.source_timestamp<=v_now+interval '5 seconds'
        ORDER BY snapshot.source_timestamp DESC,snapshot.captured_at DESC
        LIMIT 1
      ) AS portfolio ON true
      LEFT JOIN LATERAL (
        SELECT run.started_at
        FROM agent_runs AS run
        WHERE run.user_id=user_agent.user_id AND run.user_agent_id=user_agent.id
        ORDER BY run.started_at DESC
        LIMIT 1
      ) AS last_run ON true
      LEFT JOIN paper_agent_schedule_states AS schedule
        ON schedule.user_agent_id=user_agent.id AND schedule.user_id=user_agent.user_id
      CROSS JOIN LATERAL (
        SELECT count(*)::integer AS value
        FROM user_agents AS counted
        WHERE counted.user_id=user_agent.user_id
          AND counted.deleted_at IS NULL
          AND counted.environment='paper'
          AND counted.status IN ('monitoring','waiting_approval','automatic')
      ) AS active_count
      WHERE user_agent.deleted_at IS NULL
        AND user_agent.environment='paper'
        AND user_agent.status IN ('monitoring','automatic')
        AND (user_agent.status<>'automatic' OR p_autonomous_mode_enabled)
        AND upper(configuration.configuration->>'symbol') ~ '^[A-Z][A-Z0-9.-]{0,14}$'
        AND jsonb_typeof(effective_entitlements.features->'agentCatalog')='array'
        AND effective_entitlements.features->'agentCatalog' @> jsonb_build_array(definition.agent_key)
        AND jsonb_typeof(version.definition->'requiredBrokerageCapabilities')='array'
        AND jsonb_array_length(version.definition->'requiredBrokerageCapabilities')>0
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(version.definition->'requiredBrokerageCapabilities') AS required(tool_name)
          WHERE NOT EXISTS (
            SELECT 1 FROM broker_capabilities AS capability
            WHERE capability.connection_id=connection.id
              AND capability.tool_name=required.tool_name
              AND capability.unavailable_at IS NULL
              AND capability.last_seen_at<=v_now+interval '5 seconds'
              AND capability.last_seen_at>v_now-interval '300 seconds'
          )
        )
        AND (
          (version.definition->'instruments' @> '["equity"]'::jsonb AND effective_entitlements.features->'stockTrading'='true'::jsonb)
          OR
          (version.definition->'instruments' @> '["option"]'::jsonb AND effective_entitlements.features->'optionsTrading'='true'::jsonb)
        )
    ), eligible AS (
      SELECT bound.*,
        CASE
          WHEN bound.last_run_started_at IS NULL AND bound.last_agent_run_enqueued_at IS NULL
          THEN bound.activated_at
          ELSE greatest(bound.last_run_started_at,bound.last_agent_run_enqueued_at)
            + make_interval(mins=>bound.monitoring_frequency_minutes)
        END AS due_at
      FROM bound
      WHERE bound.monitoring_frequency_minutes BETWEEN 1 AND 525600
        AND bound.maximum_active_agents IS NOT NULL
        AND bound.active_agent_count<=bound.maximum_active_agents
    )
    SELECT * FROM eligible
    ORDER BY due_at,user_agent_id
    LIMIT p_batch_size
  LOOP
    v_evaluated := v_evaluated + 1;
    v_due := v_candidate.due_at<=v_now;
    v_next_due_at := v_candidate.due_at;
    v_block_reason := CASE WHEN v_due THEN NULL ELSE 'NOT_DUE' END;
    v_bucket_epoch := floor(extract(epoch FROM v_now)/(v_candidate.monitoring_frequency_minutes*60))::bigint
      * (v_candidate.monitoring_frequency_minutes*60)::bigint;
    v_bucket_start := to_timestamp(v_bucket_epoch);
    v_quote_source_timestamp := NULL;
    v_refresh_job_id := NULL;
    v_refresh_job_created_at := NULL;
    v_run_job_id := NULL;
    v_run_job_created_at := NULL;
    v_last_refresh_enqueued_at := v_candidate.last_refresh_enqueued_at;
    v_last_run_enqueued_at := v_candidate.last_agent_run_enqueued_at;

    IF v_due THEN
      v_due_count := v_due_count + 1;
      v_lag_seconds := greatest(0,floor(extract(epoch FROM (v_now-v_candidate.due_at)))::integer);
      v_max_lag := greatest(v_max_lag,v_lag_seconds);
      v_oldest_due := least(v_oldest_due,v_candidate.due_at);

      IF v_active_incident THEN
        v_block_reason := 'SYSTEM_INCIDENT_ACTIVE';
        v_other_blocked := v_other_blocked + 1;
      ELSIF v_candidate.maximum_quote_age_seconds IS NULL
        OR v_candidate.maximum_account_snapshot_age_seconds IS NULL THEN
        v_block_reason := 'CURRENT_RISK_POLICY_REQUIRED';
        v_other_blocked := v_other_blocked + 1;
      ELSE
        INSERT INTO queue_jobs(
          queue_name,user_id,job_type,payload,idempotency_key,available_at,priority,max_attempts
        ) VALUES (
          'market-data',
          v_candidate.user_id,
          'refresh_quotes',
          jsonb_build_object(
            'symbols',jsonb_build_array(v_candidate.symbol),
            'providerId',p_market_data_provider_id,
            'source','paper-agent-scheduler',
            'userAgentId',v_candidate.user_agent_id,
            'scheduleBucket',v_bucket_start
          ),
          'paper-quote-refresh:'||v_candidate.user_agent_id::text||':'||v_bucket_epoch::text,
          v_now,
          40,
          5
        )
        ON CONFLICT(queue_name,idempotency_key) DO UPDATE
          SET idempotency_key=EXCLUDED.idempotency_key
          WHERE queue_jobs.user_id IS NOT DISTINCT FROM EXCLUDED.user_id
            AND queue_jobs.job_type=EXCLUDED.job_type
            AND queue_jobs.payload=EXCLUDED.payload
        RETURNING id,created_at,(xmax=0) INTO v_refresh_job_id,v_refresh_job_created_at,v_inserted;
        IF v_refresh_job_id IS NULL THEN
          RAISE EXCEPTION 'paper quote refresh idempotency ownership conflict' USING ERRCODE = '23505';
        END IF;
        IF v_inserted THEN v_refresh_count := v_refresh_count + 1; END IF;
        v_last_refresh_enqueued_at := v_refresh_job_created_at;

        SELECT snapshot.source_timestamp
        INTO v_quote_source_timestamp
        FROM market_data_snapshots AS snapshot
        WHERE snapshot.symbol=v_candidate.symbol
          AND snapshot.data_type='quote'
          AND snapshot.provider=p_market_data_provider_id
          AND snapshot.source_timestamp<=v_now+interval '5 seconds'
          AND snapshot.source_timestamp>=v_now
            - make_interval(secs=>v_candidate.maximum_quote_age_seconds)
        ORDER BY snapshot.source_timestamp DESC,snapshot.received_at DESC
        LIMIT 1;

        IF v_quote_source_timestamp IS NULL THEN
          v_block_reason := 'MARKET_QUOTE_REFRESH_PENDING';
          v_quote_blocked := v_quote_blocked + 1;
        ELSIF v_candidate.portfolio_source_timestamp IS NULL
          OR v_candidate.portfolio_valid_until IS NULL
          OR v_candidate.portfolio_valid_until<=v_now
          OR v_candidate.portfolio_source_timestamp<v_now
            - make_interval(secs=>v_candidate.maximum_account_snapshot_age_seconds)
          OR v_candidate.connection_last_sync_at IS NULL
          OR v_candidate.connection_last_sync_at<v_candidate.portfolio_source_timestamp THEN
          v_block_reason := 'ACCOUNT_SNAPSHOT_STALE';
          v_other_blocked := v_other_blocked + 1;
        ELSE
          INSERT INTO queue_jobs(
            queue_name,user_id,job_type,payload,idempotency_key,available_at,priority,max_attempts
          ) VALUES (
            'agent-runs',
            v_candidate.user_id,
            'agent_run',
            jsonb_build_object(
              'userAgentId',v_candidate.user_agent_id,
              'runIdempotencyKey','scheduled-paper-run:'||v_candidate.user_agent_id::text||':'||v_bucket_epoch::text
            ),
            'paper-agent-run:'||v_candidate.user_agent_id::text||':'||v_bucket_epoch::text,
            v_now,
            60,
            3
          )
          ON CONFLICT(queue_name,idempotency_key) DO UPDATE
            SET idempotency_key=EXCLUDED.idempotency_key
            WHERE queue_jobs.user_id IS NOT DISTINCT FROM EXCLUDED.user_id
              AND queue_jobs.job_type=EXCLUDED.job_type
              AND queue_jobs.payload=EXCLUDED.payload
          RETURNING id,created_at,(xmax=0) INTO v_run_job_id,v_run_job_created_at,v_inserted;
          IF v_run_job_id IS NULL THEN
            RAISE EXCEPTION 'paper agent run idempotency ownership conflict' USING ERRCODE = '23505';
          END IF;
          IF v_inserted THEN v_run_count := v_run_count + 1; END IF;
          v_last_run_enqueued_at := v_run_job_created_at;
          v_next_due_at := v_run_job_created_at
            + make_interval(mins=>v_candidate.monitoring_frequency_minutes);
          v_block_reason := NULL;
        END IF;
      END IF;
    END IF;

    INSERT INTO paper_agent_schedule_states(
      user_agent_id,user_id,monitoring_frequency_minutes,symbol,schedule_bucket_started_at,
      next_due_at,last_evaluated_at,last_refresh_enqueued_at,last_agent_run_enqueued_at,
      last_quote_source_timestamp,block_reason
    ) VALUES (
      v_candidate.user_agent_id,v_candidate.user_id,v_candidate.monitoring_frequency_minutes,
      v_candidate.symbol,v_bucket_start,v_next_due_at,v_now,v_last_refresh_enqueued_at,
      v_last_run_enqueued_at,v_quote_source_timestamp,v_block_reason
    )
    ON CONFLICT(user_agent_id) DO UPDATE SET
      user_id=EXCLUDED.user_id,
      monitoring_frequency_minutes=EXCLUDED.monitoring_frequency_minutes,
      symbol=EXCLUDED.symbol,
      schedule_bucket_started_at=EXCLUDED.schedule_bucket_started_at,
      next_due_at=EXCLUDED.next_due_at,
      last_evaluated_at=EXCLUDED.last_evaluated_at,
      last_refresh_enqueued_at=COALESCE(EXCLUDED.last_refresh_enqueued_at,paper_agent_schedule_states.last_refresh_enqueued_at),
      last_agent_run_enqueued_at=COALESCE(EXCLUDED.last_agent_run_enqueued_at,paper_agent_schedule_states.last_agent_run_enqueued_at),
      last_quote_source_timestamp=EXCLUDED.last_quote_source_timestamp,
      block_reason=EXCLUDED.block_reason;
  END LOOP;

  RETURN QUERY SELECT
    true,
    v_evaluated,
    v_due_count,
    v_refresh_count,
    v_run_count,
    v_quote_blocked,
    v_other_blocked,
    v_max_lag,
    v_oldest_due;
END;
$$;

REVOKE ALL ON FUNCTION app.schedule_paper_agent_jobs(text[],text,integer,boolean) FROM PUBLIC;

COMMIT;
