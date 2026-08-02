# Agent architecture

> **Status:** The repository implements the proposal state machine, deterministic risk evaluation, durable PostgreSQL queue/lock primitives, shared deterministic plan cycles, immutable Hermes research artifacts, tenant-isolated fan-out, authoritative execution-time risk reload, Paper fill/reconciliation, and a persistent research → strategy → proposal pipeline for Foundation Equity v1. Paper startup requires PostgreSQL, Redis, an explicit approved market-data provider allowlist, and the exact reviewed Hermes configuration. The other catalog strategies fail closed with `DETERMINISTIC_STRATEGY_UNIMPLEMENTED`; Paper is not externally production-ready, and Live remains locked until the provider mapping and all release approvals are complete.

## Layers

1. Every active plan has one published catalog with one to three ordered, distinct shared agent versions. The elected scheduler creates a separate canonical plan/catalog/agent/time cycle for each due assignment and freezes its sorted, distinct, bounded public quote universe. It never derives this context from tenant configurations, watchlists, holdings, or accounts.
2. Hermes receives that public context only through one logical deterministic request ID. At-least-once delivery can repeat the network invocation, but the dedicated profile must be stateless and tool-free and PostgreSQL accepts only one immutable digest-bound sanitized artifact for the cycle.
3. Tenant fan-out carries the artifact ID/digest into independent tenant-bound jobs. Each job reloads its own user-agent/account binding, subscription, legal consent, capabilities, portfolio, quote, policy, and approval state; one tenant's failure cannot affect another tenant's authority.
4. A versioned deterministic strategy—not Hermes—selects the configured symbol, evaluates explicit entry/exit criteria, calculates order fields, and produces candidates or no-trade reasons. Proposal generation validates the `TradeProposal` schema and records the plan-cycle evidence, strategy, and agent versions.
5. The deterministic risk engine evaluates platform plus tighter user limits and creates immutable tenant-owned check results.
6. The execution worker independently reloads the authoritative tenant graph, calls broker review, classifies warnings, verifies current approval when required, refreshes state, and only then may place. Broker-token-vault access is limited to this role and a separately approved broker-sync role.
7. Reconciliation treats broker responses as order truth and appends tenant-owned events through terminal state.

## Proposal lifecycle

`DRAFT → ANALYZED → SCHEMA_VALIDATED → RISK_CHECKED` branches to `RISK_REJECTED` or `BROKER_REVIEWED`; review branches to `BROKER_REJECTED`, `AWAITING_USER_APPROVAL`, or `APPROVED`; execution proceeds through `SUBMITTING → SUBMITTED → PARTIALLY_FILLED/FILLED/CANCELED/REJECTED`, with explicit `USER_REJECTED`, `EXPIRED`, and `RECONCILIATION_ERROR` paths. Only named server actors may perform each transition, and every attempt is audited—even a rejected transition.

## Concurrency and conflicts

Idempotency keys cover plan research, tenant run, proposal, approval, submission, cancellation, reconciliation, and notification. Cycle uniqueness and coordination locks serialize artifact acceptance; the deterministic request ID remains the same across provider retries. Distributed locks serialize each proposal/order. Capital reservations atomically reserve portfolio/agent buying power after risk and before submission. A portfolio conflict resolver rejects opposing proposals, overlapping capital, duplicate symbol/order intent, and stale configurations; an LLM never arbitrates authority.

## Versioning and explainability

Agent, deterministic strategy, risk policy, prompt, model, input data, and broker capability versions are stored on the run/proposal. Users see objective, permitted/prohibited instruments, holding period, schedule, risk controls, struggle conditions, methods, required permissions, disclosures, and change history. Historical results remain separated as Live, Paper, or hypothetical/backtest with methodology; a fictional “AI score” or probability claim is prohibited.
