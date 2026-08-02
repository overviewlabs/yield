BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='whox_api_runtime') THEN CREATE ROLE whox_api_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='whox_queue_worker') THEN CREATE ROLE whox_queue_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='whox_agent_worker') THEN CREATE ROLE whox_agent_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='whox_execution_worker') THEN CREATE ROLE whox_execution_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='whox_notification_worker') THEN CREATE ROLE whox_notification_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='whox_market_data_worker') THEN CREATE ROLE whox_market_data_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='whox_outbox_publisher') THEN CREATE ROLE whox_outbox_publisher NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF;
END $$;

GRANT whox_queue_worker TO whox_agent_worker, whox_execution_worker, whox_notification_worker, whox_market_data_worker;
GRANT USAGE ON SCHEMA public, app TO whox_api_runtime, whox_agent_worker, whox_execution_worker, whox_notification_worker, whox_market_data_worker, whox_outbox_publisher;
GRANT EXECUTE ON FUNCTION app.current_user_id() TO whox_api_runtime, whox_agent_worker, whox_execution_worker, whox_notification_worker;

GRANT SELECT, INSERT, UPDATE, DELETE ON queue_jobs TO whox_queue_worker;
CREATE POLICY queue_worker_access ON queue_jobs TO whox_queue_worker USING (true) WITH CHECK (true);

-- The agent worker can read only the current tenant/catalog inputs required to
-- run a versioned deterministic strategy, and can append/update only pipeline
-- artifacts. Tenant tables remain protected by FORCE RLS after the worker sets
-- app.user_id from the authenticated durable job.
GRANT SELECT ON
  users,subscriptions,entitlements,plans,legal_documents,legal_consents,
  broker_connections,broker_accounts,broker_capabilities,
  portfolio_snapshots,position_snapshots,market_data_snapshots,
  user_agents,agent_configurations,agent_definitions,agent_versions,
  risk_policies,capital_reservations,trade_proposals,approval_requests,
  orders,fills,risk_events,security_events,system_incidents
TO whox_agent_worker;
GRANT SELECT, INSERT, UPDATE ON agent_runs,capital_reservations,trade_proposals TO whox_agent_worker;
GRANT SELECT, INSERT ON
  agent_run_candidates,trade_proposal_evidence,risk_checks,approval_requests,
  trade_proposal_events
TO whox_agent_worker;

GRANT SELECT, INSERT, UPDATE ON reconciliation_jobs TO whox_execution_worker;
CREATE POLICY execution_reconciliation_access ON reconciliation_jobs TO whox_execution_worker USING (true) WITH CHECK (true);
GRANT SELECT, UPDATE ON trade_proposals TO whox_execution_worker;
GRANT INSERT ON trade_proposal_events, orders, order_events, fills TO whox_execution_worker;
GRANT SELECT, UPDATE ON orders TO whox_execution_worker;
-- Execution may verify only the identity, current agent configuration,
-- entitlement/legal chain, broker synchronization/capabilities, and persisted
-- account/market/operational risk inputs needed to recheck an already-approved
-- proposal immediately before Paper placement.
-- Tenant-owned rows remain constrained by RLS and the worker sets app.user_id
-- inside each transaction; global catalog rows are read-only.
GRANT SELECT ON
  fills,risk_policies,capital_reservations,risk_events,security_events,system_incidents,
  broker_accounts,broker_connections,broker_capabilities,broker_sync_runs,approval_requests,
  users,subscriptions,entitlements,user_agents,agent_configurations,agent_runs,
  portfolio_snapshots,position_snapshots,market_data_snapshots,
  plans,legal_documents,legal_consents,agent_definitions,agent_versions
TO whox_execution_worker;

GRANT SELECT, INSERT, UPDATE ON notifications TO whox_notification_worker;
GRANT INSERT ON audit_events TO whox_notification_worker;
CREATE POLICY notification_worker_access ON notifications TO whox_notification_worker
  USING (user_id = app.current_user_id()) WITH CHECK (user_id = app.current_user_id());
GRANT SELECT ON user_profiles, devices TO whox_notification_worker;
GRANT SELECT, UPDATE ON device_tokens TO whox_notification_worker;
CREATE POLICY notification_device_access ON device_tokens TO whox_notification_worker
  USING (user_id = app.current_user_id()) WITH CHECK (user_id = app.current_user_id());

GRANT SELECT, INSERT ON market_data_snapshots TO whox_market_data_worker;

GRANT SELECT, UPDATE ON outbox_events TO whox_outbox_publisher;
CREATE POLICY outbox_publisher_access ON outbox_events TO whox_outbox_publisher USING (true) WITH CHECK (true);

-- The API role receives table privileges but remains constrained by tenant RLS.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  users,user_identities,user_profiles,eligibility_profiles,risk_assessments,risk_assessment_answers,legal_consents,
  subscriptions,subscription_events,entitlements,devices,sessions,broker_connections,broker_accounts,broker_capabilities,
  connection_pairings,portfolio_snapshots,position_snapshots,user_agents,agent_configurations,agent_runs,agent_run_candidates,
  risk_policies,risk_checks,capital_reservations,trade_proposals,trade_proposal_evidence,approval_requests,orders,order_events,
  fills,option_legs,reconciliation_jobs,trade_proposal_events,risk_events,notifications,device_tokens,audit_events,
  support_tickets,security_events,demo_sessions,queue_jobs
TO whox_api_runtime;
GRANT SELECT ON plans,legal_documents,feature_flags,agent_definitions,agent_versions,market_data_snapshots TO whox_api_runtime;

COMMIT;
