# Durable Paper agent scheduling

Paper agent runs are produced by the agent-orchestrator's PostgreSQL scheduler. Demo keeps its existing in-memory behavior, and Live orchestration remains disabled by release configuration.

## Eligibility and cadence

The database function `app.schedule_paper_agent_jobs` selects only active Paper users whose agent is `monitoring` (or a server-authorized `automatic` state), whose current persisted configuration is effective, whose version is Paper-enabled, and whose current active/grace-period subscription entitles the exact normalized plan/catalog assignment and monitoring frequency. Cycle election and tenant fan-out both require a unique current eligible investor profile, current investor risk assessment and policy, every applicable current counsel-approved legal consent, an active verified Agentic Account on a connected Robinhood MCP connection, and a fresh available discovery record for every exact brokerage capability named by that agent version. Options and adviser-client classifications add their applicable legal documents. A merely monitoring but otherwise ineligible tenant cannot cause a plan research request. A missing, renamed, stale, or unavailable tool removes the agent from scheduling until discovery proves the exact contract again. Paused, deleted, over-plan-limit, draft, expired-subscription, and waiting-approval agents are not scheduled.

`monitoringFrequencyMinutes` comes from the effective plan plus each feature's latest current entitlement override. The authenticated API uses the same merge for plan limits, cadence, and feature gates; its `agentCatalog` is always rebuilt from the normalized current catalog and cannot be replaced by an entitlement JSON mirror. A shared plan/agent cycle uses the fastest cadence among its currently eligible cohort, while every member retains its own durable cadence and `next_due_at`; a 30-minute member is therefore not run on an intervening 15-minute shared cycle created for an entitled faster member. Each agent's durable `paper_agent_schedule_states` row records its last evaluation, last quote-refresh enqueue, last run enqueue, next due time, and fail-closed reason. A transaction-scoped PostgreSQL advisory lock elects one scheduler replica per tick. The immutable six-part plan-cycle ID binds plan, catalog version, agent version, bucket epoch, and canonical as-of epoch. Queue and run idempotency keys bind that cycle to the tenant agent, so replica races and restarts cannot create duplicate evaluations or tight retries.

One non-tenant public-market refresh and one logical, tool-free Hermes research request are elected for each plan/catalog/agent cycle. The request freezes only the sorted, distinct, bounded public quote context from that centrally published plan assignment; it is never built from tenant configuration, watchlists, holdings, accounts, or policies. The resulting immutable sanitized artifact is then referenced by independent tenant-bound jobs; tenant IDs, account IDs, policies, portfolios, and broker credentials never enter the research payload. Fan-out means the evaluations share one canonical decision timestamp and research artifact. It does not promise simultaneous brokerage acceptance or fills: queues are asynchronous, and each account independently revalidates current eligibility, legal consent, entitlements, account binding, capability discovery, portfolio freshness, quote freshness, deterministic risk, proposal approval, execution, and reconciliation. One account failing closed never weakens or bypasses another account's controls.

## Quote-first and account freshness gates

For every due agent, the scheduler first inserts a tenant-bound durable job:

```json
{
  "queueName": "market-data",
  "jobType": "refresh_quotes",
  "payload": {
    "symbols": ["AAPL"],
    "providerId": "approved-provider-id",
    "source": "paper-agent-scheduler",
    "userAgentId": "opaque-uuid",
    "scheduleBucket": "timestamp"
  }
}
```

The market worker rejects a Paper job without a tenant, without the configured provider ID, or with a provider ID that differs from `MARKET_DATA_PROVIDER_ID`. Its payload is a closed, token-free schema; unknown fields are rejected before provider access. That configured ID must also appear in `APPROVED_MARKET_DATA_PROVIDERS`. The HTTP adapter requires a canonical HTTPS URL, a non-placeholder managed token, and a response provider value equal to this configuration. It strictly validates every quote field consumed by the deterministic pipeline: bid/ask/last, provenance time, delay, tradability, fractional support, liquidity, session, halt and restriction flags, earnings window, sector, and broker-warning severity.

An `agent_run` is inserted only when that configured approved provider already has a quote inside the user's current risk-policy freshness window. The run also requires a current unexpired Paper portfolio snapshot from the verified Agentic Account, and the broker connection's `last_sync_at` must attest a time at or after the snapshot source time. A missing/stale quote leaves the agent due with `MARKET_QUOTE_REFRESH_PENDING`; missing risk state, a stale account snapshot, or a blocking system incident also leaves it fail-closed. A later scheduler tick in the same bucket can observe the newly persisted quote and enqueue the one deterministic run without enqueueing another refresh.

The scheduler counts queued, failed, and leased work across research, market-data, and agent-run queues before enqueueing. `AGENT_SCHEDULER_MAX_OUTSTANDING_JOBS` provides a bounded global backpressure ceiling; reaching it records `SCHEDULER_BACKPRESSURE` and leaves the tenant due for a later tick. Research delivery is at least once with a deterministic logical request ID and up to five durable attempts. The external HTTP call is not claimed to be exactly once; the Hermes profile must remain stateless and side-effect-free, while PostgreSQL accepts only one immutable artifact for the cycle.

## Health and alerting

The orchestrator `/healthz` response contains a nested `scheduler` object with last tick/success time, lock contention count, evaluated/due/blocked counts, enqueue counts, oldest due time, and maximum scheduling lag. Database errors and lag beyond `AGENT_SCHEDULER_LAG_ALERT_SECONDS` make the top-level health state degraded. Lag emits only aggregate, non-user-identifying JSON under event `paper_scheduler_lag`; Terraform converts it to the `WHOX/Treasury/PaperSchedulerLagEvents` CloudWatch metric and alerts the configured SNS topic.

The defaults are a 15-second poll, batch size 250, and 300-second lag alert. Raising the batch or poll interval requires capacity evidence. A provider outage should be investigated from the market-data worker and scheduler aggregate state; do not bypass freshness, change provider IDs, or relabel Demo data.

## Deployment gate

Paper orchestration capacity cannot be enabled in Terraform unless market-data capacity is nonzero, the provider URL is HTTPS, the configured provider ID is syntactically valid, and the same ID is in the explicit approved allowlist. The provider token remains a managed secret delivered only to the market-data service.

Paper Hermes also fails startup unless `HERMES_BASE_URL` is exactly `https://treasury-bot.whox.ai/v1`, `HERMES_MODEL` is exactly `treasury-bot`, `HERMES_API_KEY` is an orchestrator-only managed and rotated secret, and `HERMES_RESEARCH_PROFILE_TOOLS_DISABLED` is exactly `true` after the dedicated remote profile has been verified stateless with every tool and memory facility disabled. Any key exposed to a user, prompt, chat, client, log, or ticket must be treated as compromised, revoked, and replaced without displaying or reusing it. See [Hermes plan-cycle research](hermes-research.md).
