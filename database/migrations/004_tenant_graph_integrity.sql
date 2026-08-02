BEGIN;

-- Tenant-owned child rows must not be able to reference another tenant's parent
-- even when a parent UUID is guessed. The original single-column foreign keys
-- remain useful for lifecycle behavior; these composite keys bind the graph to
-- the same user at the database boundary.
ALTER TABLE sessions ADD CONSTRAINT sessions_id_user_unique UNIQUE (id, user_id);
ALTER TABLE devices ADD CONSTRAINT devices_id_user_unique UNIQUE (id, user_id);
ALTER TABLE broker_connections ADD CONSTRAINT broker_connections_id_user_unique UNIQUE (id, user_id);
ALTER TABLE portfolio_snapshots ADD CONSTRAINT portfolio_snapshots_id_user_unique UNIQUE (id, user_id);
ALTER TABLE user_agents ADD CONSTRAINT user_agents_id_user_unique UNIQUE (id, user_id);
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_id_user_unique UNIQUE (id, user_id);
ALTER TABLE risk_policies ADD CONSTRAINT risk_policies_id_user_unique UNIQUE (id, user_id);
ALTER TABLE trade_proposals ADD CONSTRAINT trade_proposals_id_user_unique UNIQUE (id, user_id);
ALTER TABLE orders ADD CONSTRAINT orders_id_user_unique UNIQUE (id, user_id);

ALTER TABLE broker_accounts
  ADD CONSTRAINT broker_accounts_connection_tenant_fk
  FOREIGN KEY (connection_id, user_id) REFERENCES broker_connections(id, user_id) ON DELETE CASCADE;

ALTER TABLE connection_pairings
  ADD CONSTRAINT connection_pairings_creator_session_tenant_fk
  FOREIGN KEY (creator_session_id, user_id) REFERENCES sessions(id, user_id)
  ON DELETE SET NULL (creator_session_id),
  ADD CONSTRAINT connection_pairings_claimant_session_tenant_fk
  FOREIGN KEY (claimant_session_id, user_id) REFERENCES sessions(id, user_id)
  ON DELETE SET NULL (claimant_session_id);

ALTER TABLE legal_consents
  ADD CONSTRAINT legal_consents_device_tenant_fk
  FOREIGN KEY (device_id, user_id) REFERENCES devices(id, user_id)
  ON DELETE SET NULL (device_id);

ALTER TABLE position_snapshots
  ADD CONSTRAINT position_snapshots_portfolio_tenant_fk
  FOREIGN KEY (portfolio_snapshot_id, user_id) REFERENCES portfolio_snapshots(id, user_id) ON DELETE CASCADE;

ALTER TABLE agent_configurations
  ADD CONSTRAINT agent_configurations_user_agent_tenant_fk
  FOREIGN KEY (user_agent_id, user_id) REFERENCES user_agents(id, user_id) ON DELETE CASCADE;

ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_user_agent_tenant_fk
  FOREIGN KEY (user_agent_id, user_id) REFERENCES user_agents(id, user_id) ON DELETE RESTRICT;

ALTER TABLE agent_run_candidates
  ADD CONSTRAINT agent_run_candidates_run_tenant_fk
  FOREIGN KEY (agent_run_id, user_id) REFERENCES agent_runs(id, user_id) ON DELETE CASCADE;

ALTER TABLE capital_reservations
  ADD CONSTRAINT capital_reservations_user_agent_tenant_fk
  FOREIGN KEY (user_agent_id, user_id) REFERENCES user_agents(id, user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT capital_reservations_proposal_tenant_fk
  FOREIGN KEY (proposal_id, user_id) REFERENCES trade_proposals(id, user_id) ON DELETE RESTRICT;

ALTER TABLE trade_proposals
  ADD CONSTRAINT trade_proposals_run_tenant_fk
  FOREIGN KEY (agent_run_id, user_id) REFERENCES agent_runs(id, user_id) ON DELETE RESTRICT;

ALTER TABLE trade_proposal_evidence
  ADD CONSTRAINT trade_proposal_evidence_proposal_tenant_fk
  FOREIGN KEY (proposal_id, user_id) REFERENCES trade_proposals(id, user_id) ON DELETE CASCADE;

ALTER TABLE risk_checks
  ADD CONSTRAINT risk_checks_proposal_tenant_fk
  FOREIGN KEY (proposal_id, user_id) REFERENCES trade_proposals(id, user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT risk_checks_policy_tenant_fk
  FOREIGN KEY (policy_id, user_id) REFERENCES risk_policies(id, user_id) ON DELETE RESTRICT;

ALTER TABLE approval_requests
  ADD CONSTRAINT approval_requests_proposal_tenant_fk
  FOREIGN KEY (proposal_id, user_id) REFERENCES trade_proposals(id, user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT approval_requests_device_tenant_fk
  FOREIGN KEY (approving_device_id, user_id) REFERENCES devices(id, user_id)
  ON DELETE SET NULL (approving_device_id);

ALTER TABLE orders
  ADD CONSTRAINT orders_proposal_tenant_fk
  FOREIGN KEY (proposal_id, user_id) REFERENCES trade_proposals(id, user_id) ON DELETE RESTRICT;

ALTER TABLE order_events
  ADD CONSTRAINT order_events_order_tenant_fk
  FOREIGN KEY (order_id, user_id) REFERENCES orders(id, user_id) ON DELETE RESTRICT;

ALTER TABLE fills
  ADD CONSTRAINT fills_order_tenant_fk
  FOREIGN KEY (order_id, user_id) REFERENCES orders(id, user_id) ON DELETE RESTRICT;

ALTER TABLE option_legs
  ADD CONSTRAINT option_legs_proposal_tenant_fk
  FOREIGN KEY (proposal_id, user_id) REFERENCES trade_proposals(id, user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT option_legs_order_tenant_fk
  FOREIGN KEY (order_id, user_id) REFERENCES orders(id, user_id) ON DELETE RESTRICT;

ALTER TABLE reconciliation_jobs
  ADD CONSTRAINT reconciliation_jobs_order_tenant_fk
  FOREIGN KEY (order_id, user_id) REFERENCES orders(id, user_id) ON DELETE RESTRICT;

ALTER TABLE trade_proposal_events
  ADD CONSTRAINT trade_proposal_events_proposal_tenant_fk
  FOREIGN KEY (proposal_id, user_id) REFERENCES trade_proposals(id, user_id) ON DELETE RESTRICT;

ALTER TABLE risk_events
  ADD CONSTRAINT risk_events_proposal_tenant_fk
  FOREIGN KEY (proposal_id, user_id) REFERENCES trade_proposals(id, user_id) ON DELETE RESTRICT;

ALTER TABLE device_tokens
  ADD CONSTRAINT device_tokens_device_tenant_fk
  FOREIGN KEY (device_id, user_id) REFERENCES devices(id, user_id) ON DELETE CASCADE;

COMMIT;
