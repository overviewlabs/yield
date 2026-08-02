# Database schema

PostgreSQL is the source of truth. Redis contains only short-lived cache, locks, rate limits, and coordination; durable queue messages and PostgreSQL events survive Redis loss.

## Domains

- Identity/eligibility: `users`, `user_identities`, `user_profiles`, `eligibility_profiles`, `risk_assessments`, `risk_assessment_answers`, `devices`, `sessions`.
- Legal/billing: `legal_documents`, `legal_consents`, `subscriptions`, `subscription_events`, `entitlements`.
- Broker/pairing: `broker_connections`, `broker_accounts`, `broker_capabilities`, `connection_pairings`, durable pre-exchange cleanup tombstones in `broker_authorization_exchange_attempts`, provider-confirmation/revocation state in `broker_authorization_sagas`, and immutable receipt-bound `broker_sync_runs`.
- Portfolio/data: `portfolio_snapshots`, `position_snapshots`, `market_data_snapshots`.
- Agents/risk: centrally managed `agent_definitions` and `agent_versions`; immutable `plan_agent_catalog_versions` and `plan_agent_catalog_entries` linking exactly one to three shared versions to every active plan, with a sorted, distinct, closed `research_universe` of 1–50 symbols on each assignment; non-tenant immutable `paper_plan_cycles`, `paper_plan_research_inputs`, and `paper_plan_research_artifacts`; tenant-owned `user_agents`, `agent_configurations`, `paper_agent_schedule_states`, `agent_runs`, `agent_run_candidates`, `risk_policies`, `risk_checks`, `capital_reservations`, and `risk_events`.
- Execution: `trade_proposals`, `trade_proposal_evidence`, `approval_requests`, `orders`, `order_events`, `fills`, `option_legs`, `reconciliation_jobs`.
- Operations: `notifications`, `device_tokens`, `audit_events`, `support_tickets`, `security_events`, `feature_flags`, `system_incidents`, `demo_sessions`.

## Invariants

Public identifiers are UUIDs/nonsequential. All times include timezone. Event/audit rows are append-only; corrections append events. Idempotency keys are unique within their operation/tenant. Orders always reference a verified proposal and opaque bound broker account. Capital reservations prevent concurrent overspend. Full broker tokens are envelope-encrypted outside ordinary queryable plaintext; only the execution role and a separately approved broker-sync role may read/decrypt the vault. Full brokerage account numbers are not retained unless a reviewed requirement exists.

No provider exchange starts before its tenant-bound tombstone commits. A provisional credential cannot enter hydration until the matching authorization saga receives terminal provider confirmation and the database revalidates its immutable user/session/connector binding. Disconnect, reconnect, account closure, confirmation failure, and deterministic hydration failure request idempotent provider revocation; replacement authorization remains blocked and the saga retains its recovery handle until terminal revocation acknowledgment.

Every user-owned query scopes by authenticated tenant identity before applying a client-supplied identifier. Row/service authorization tests attempt cross-user access. Composite `(id, user_id)` foreign keys bind tenant-owned child graphs to a parent owned by the same user, so guessing another tenant's UUID cannot create a cross-tenant relationship even when the child row itself passes RLS. High-cardinality indexes cover user/account/status/timestamp/agent/proposal/order access paths without logging values.

Configured agent symbols must match the `research_universe` on the user's exact current plan/catalog/agent-version assignment. API writes and resumes perform this membership check in the same transaction while holding shared locks on the current mapping, so catalog publication cannot race a successful validation. Research universes are public plan metadata and must never be derived from tenant configuration, watchlists, holdings, or other account data.

A `paper_plan_cycles` row binds the plan, immutable catalog version, agent version, schedule bucket, canonical evaluation timestamp, and deterministic strategy version. The corresponding `paper_plan_research_inputs` row freezes only the central assignment's bounded public quote context and its SHA-256 digest. One logical deterministic Hermes request ID derives from that cycle; durable retries may repeat the external invocation, but the unique immutable `paper_plan_research_artifacts` row permits only one accepted context/request/decision digest set per cycle.

Shared-cycle rows contain no tenant, account, portfolio, policy, approval, order, or credential fields. Fan-out queue rows and `agent_runs` are tenant-bound and carry only the exact plan-cycle/artifact ID and digest reference. Composite ownership constraints, row-level security, current subscription/catalog checks, and transaction-local tenant context keep each tenant's binding, risk, approval, capital reservation, execution, and reconciliation graph independent.

Demo seeds are unmistakably nonproduction, contain synthetic identities, and cannot be loaded when `APP_ENV=live`. PostgreSQL 17 is the supported database runtime; migration 004 uses column-scoped `ON DELETE SET NULL` behavior to preserve tenant ownership on optional references. Migrations run transactionally where PostgreSQL permits, are validated from an empty database, and include a forward recovery plan; immutable event history is never rewritten during rollback.
