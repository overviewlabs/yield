# Hermes plan-cycle research

Hermes is a research-only dependency of the Paper Foundation Equity v1 pipeline. It is not an account agent, broker adapter, risk engine, approval actor, or execution worker.

## Deployment gate

The orchestrator refuses to compose Hermes outside Demo without all four exact settings:

- `HERMES_BASE_URL=https://treasury-bot.whox.ai/v1`
- `HERMES_MODEL=treasury-bot`
- `HERMES_API_KEY` supplied through the orchestrator-only managed secret injection and current rotation process
- `HERMES_RESEARCH_PROFILE_TOOLS_DISABLED=true`

The final setting is an operator attestation, not a client-side security control. The remote Hermes profile must be dedicated and stateless, with terminal, file access, web browsing, MCP, plugins, cron, skills, memory, and every other server-side tool disabled. Sending `tools: []` and `tool_choice: none` does not by itself prevent a tool-capable server profile from causing side effects. Do not enable the attestation until the source profile has been reviewed and verified.

Any API key exposed to a user, prompt, chat, client, log, analytics stream, or ticket is compromised, not merely "suspect." Do not display or repeat the value. Revoke it, replace the managed-secret value, restart the affected orchestrator tasks, and verify redaction before reuse. Never copy a key into source, `.env.example`, iOS/web bundles, logs, analytics, tickets, database rows, job payloads, or model content.

Passing these startup checks proves only local configuration shape. It does not prove provider approval, secret hygiene, staging performance, incident readiness, Robinhood approval, or external production readiness.

## Shared-cycle boundary

The elected Paper scheduler creates one canonical cycle for a plan/catalog-version/agent-version/time bucket and enqueues one non-tenant `plan-research` job. The symbol universe comes only from the centrally published immutable plan-agent catalog assignment, never from a union or mapping of user configurations. The authenticated plans API exposes that exact closed set as `researchUniverse` (shown to users as “Available symbols”). Agent create, update, single resume, and resume-all operations canonicalize configured ticker input and then fail closed with `AGENT_SYMBOL_NOT_ALLOWED` unless it is an exact member of the current assignment's set; draft/unimplemented-version rejection still takes precedence. A distributed cycle lock and the database uniqueness boundary serialize production. The consumer first reuses an existing immutable artifact; otherwise it loads one server-derived, frozen public quote universe and performs one logical Hermes request with a deterministic request identifier.

Durable delivery is at least once. A timeout, provider 5xx, or worker crash may repeat the network invocation with the same deterministic request identifier; the system does not claim external exactly-once behavior without provider-side idempotency. The dedicated Hermes profile must therefore remain stateless and side-effect-free. PostgreSQL accepts exactly one digest-bound immutable artifact per cycle, and every tenant in the fan-out reuses that artifact.

The universe is sorted, distinct, and limited to 50 symbols. The response contract permits one 240-character summary plus at most two 120-character risk factors and two 120-character limitations per symbol. The request allows up to 12,000 completion tokens while the bounded response reader independently enforces a 64 KiB response ceiling and a 20-second timeout. A maximum-universe protocol fixture is exercised in CI. The entire cycle fails closed when the universe exceeds the bound, is stale, malformed, leaks an unexpected field, or cannot be represented in one response. It is never split into per-user calls. Provider staging latency and output-size telemetry must still be reviewed before raising any of these limits.

Only these input classes may cross the Hermes boundary:

- canonical plan-cycle, plan/catalog, agent-version, and deterministic-strategy identifiers;
- frozen context SHA-256 digest; the exact serialized request-body digest is computed locally and stored with the accepted artifact;
- source timestamp;
- public symbol, sector, bid/ask/last, session, liquidity, and halt context.

User IDs, broker/account/connection identifiers, tokens, portfolio values, buying power, holdings, positions, order sizes, allocations, risk limits, legal state, approval state, and other tenant financial or identity data are prohibited.

## Response and authority

The client uses a hard timeout, redirect rejection, a 64 KiB bounded response-body limit, a strict closed JSON schema, exact request/model/symbol binding, and bounded strings/lists. It rejects malformed JSON, extra fields, refusals, tool calls, non-stop completion, missing or reordered symbols, stale/future provenance, and response/model/request mismatches.

The artifact records provider, model, request and response identifiers, response timestamps, the frozen context digest, exact serialized request-body digest, and immutable decision digest. Each tenant run must present the exact artifact ID/digest and must have a matching symbol annotation. Missing matches fail closed.

Hermes assessment and prose are persisted only as `research_only` rationale/evidence. The versioned deterministic Foundation Equity strategy still selects the configured symbol and calculates side, quantity, notional, limit price, order type, time-in-force, and expiration. After fan-out, every tenant independently reloads ownership, subscription, legal consent, Agentic Account binding, capability, portfolio/quote freshness, risk policy, approval, and execution state. The deterministic risk engine, broker review, user/automatic approval gates, execution worker, and reconciliation remain the only authorities for trading state transitions; one tenant's failure cannot weaken another tenant's controls.
