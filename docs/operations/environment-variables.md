# Environment-variable reference

Secrets belong in the managed secret system; public URLs and safe toggles may be ordinary configuration. Production fails startup for missing/invalid required values.

| Variable | Scope | Rule |
|---|---|---|
| `APP_ENV` | all services | `demo`, `paper`, or `live`; default Demo only locally |
| `DATABASE_URL` | server | Complete TLS/private PostgreSQL URL; every runtime receives its own login granted only its matching NOLOGIN service group |
| `APP_STORE_DATABASE_URL` | API StoreKit boundary | Complete TLS/private PostgreSQL URL using a distinct login granted only `whox_app_store_notifications`; must not equal the tenant API credential |
| `REDIS_URL` | server | Complete authenticated `rediss://` URL in deployed environments |
| `TRUSTED_PROXY_HOPS` | API | `1` behind the managed ALB; `0` for direct local connections. Other values require an explicit proxy-topology review. |
| `PUBLIC_API_URL` | API | Exact HTTPS public API origin when deployed |
| `CONNECT_WEB_URL` | API/iOS | Exact browser pairing origin |
| `ADMIN_WEB_URL` | API/operators | Restricted admin origin |
| `CORS_ALLOWED_ORIGINS` | API | Comma-separated exact HTTPS origins, never a wildcard |
| `HOST` / `PORT` | API | ECS uses `0.0.0.0:8080`; local defaults are loopback-safe |
| `HEALTH_PORT` | workers | Orchestrator/execution/notification/market data/broker sync use 9101/9102/9103/9104/9105 |
| `ROBINHOOD_MCP_URL` | execution | Must equal the approved official resource URI |
| `BROKER_TOKEN_ENCRYPTION_KEY_ID` | execution | Managed KMS key reference, never key material |
| `BROKER_TOKEN_SECRET_ARN` | execution/approved broker sync | Broker token-vault identifier; only those two task roles may read it |
| `BROKER_SNAPSHOT_MAX_AGE_SECONDS` | broker sync | Paper snapshot validity window, integer 15–300; default 60 |
| `BROKER_SYNC_INTERVAL_SECONDS` | broker sync | Recurring deterministic refresh interval, integer at least 10 and at least five seconds below the maximum snapshot age; default 45 |
| `SESSION_SIGNING_SECRET` | API | At least 32 random bytes; unique per environment |
| `PAIRING_HASH_PEPPER` | API | Separate random secret; never reuse session secret |
| `RATE_LIMIT_KEY_SECRET` | API | Separate random secret used to HMAC client addresses before Redis; never reuse another runtime secret |
| `DEVICE_TOKEN_ENCRYPTION_KEY` | API/notification | At least 32 random bytes, distinct from other secrets; required in Paper. API stores APNs tokens only as an AES-256-GCM envelope using `SHA-256(secret)` as the key (`v`, base64url `iv`, `ciphertext`, and `tag`) plus an HMAC-SHA256 lookup digest. Registration fails closed when unset. |
| `APPLE_*` | API/iOS CI | Sign in with Apple registration material |
| `APPLE_BUNDLE_ID` / `APPLE_APP_ID` | API StoreKit | Registered bundle identifier and numeric App Store Connect application ID; the numeric ID is mandatory when Production verification is enabled |
| `APPLE_ROOT_CA_BUNDLE` | API StoreKit | One or more official Apple PKI root certificates in PEM form for the official signed-data verifier |
| `STOREKIT_ENVIRONMENTS` | API StoreKit | Strict lowercase `sandbox`, `production`, or both comma-separated; Paper normally enables both for TestFlight and App Store delivery |
| `APNS_*` | notification | APNs provider key references/material |
| `MARKET_DATA_PROVIDER_URL` | market data | Approved canonical HTTPS provider endpoint without URL credentials, query, or fragment; required outside Demo |
| `MARKET_DATA_PROVIDER_TOKEN` | market data | Non-placeholder managed bearer token (32–4096 non-whitespace bytes); required outside Demo and injected only into this service |
| `MARKET_DATA_PROVIDER_ID` | orchestrator/execution/market data | Stable reviewed provider identifier. Response provenance and every refresh job must match it. |
| `APPROVED_MARKET_DATA_PROVIDERS` | orchestrator/execution/market data | Comma-separated explicit provider allowlist. Must contain `MARKET_DATA_PROVIDER_ID`; no value is inferred from a response. |
| `AGENT_SCHEDULER_POLL_MS` | orchestrator | PostgreSQL scheduler interval, integer 1000–300000; default 15000 |
| `AGENT_SCHEDULER_BATCH_SIZE` | orchestrator | Maximum eligible agents evaluated per elected tick, integer 1–1000; default 250 |
| `AGENT_SCHEDULER_LAG_ALERT_SECONDS` | orchestrator | Maximum due-agent lag before degraded health and alert, integer 30–86400; default 300 |
| `AGENT_SCHEDULER_MAX_OUTSTANDING_JOBS` | orchestrator | Global queued/leased Paper-job backpressure ceiling, integer 1–10000; default 1000 |
| `HERMES_BASE_URL` | orchestrator | Exact approved canonical endpoint `https://treasury-bot.whox.ai/v1`; other origins, paths, URL credentials, queries, fragments, and trailing slashes fail startup |
| `HERMES_MODEL` | orchestrator | Exact reviewed research model `treasury-bot`; it cannot select or submit orders |
| `HERMES_API_KEY` | orchestrator | Non-placeholder, managed, routinely rotated secret required outside Demo; never place it in source, prompts/chats, logs, client bundles, model content, database rows, tickets, or tenant jobs |
| `HERMES_RESEARCH_PROFILE_TOOLS_DISABLED` | orchestrator | Must be exact `true` whenever Hermes is composed, including Demo with a key; attests that a dedicated stateless server profile has terminal, file, web, MCP, plugins, cron, memory, skills, and every other tool disabled at the source |
| `OTEL_EXPORTER_OTLP_*` | services | Managed telemetry endpoint/authorization; no user data |
| `VITE_PAIRING_PROVIDER` | connector build | `mock` only when deployment is Demo; otherwise `api` |
| `VITE_ADMIN_AUTH_MODE` | admin build | `mock` only in Demo; `oidc` is a fail-closed placeholder until the complete identity/API/audit boundary is implemented |
| `API_CONNECT_SRC` | web runtime | One exact CSP API origin; never `*` |

The seven release flags are separate server values and all default false. Boolean parsing accepts only the exact strings `true` or `false`. Options and autonomous orders require their additional flags. Flags never replace user consent, entitlement, broker capability, account binding, risk, review, freshness, market, health, or approval checks.

Paper Hermes requires all four Hermes values as one deployment gate: the exact canonical URL, exact model, a current managed key injected only into the orchestrator, and exact `true` tool-disabled attestation after the dedicated remote profile has actually been verified stateless with every tool and memory facility disabled. Client-side `tools: []` and `tool_choice: none` do not replace that source-profile control.

Any Hermes key or other secret exposed to a user, prompt, chat, client, log, analytics stream, or ticket is compromised. Do not display or repeat it; revoke it, replace the managed-secret value, restart the affected tasks, and verify redaction before reuse. Never place OAuth tokens, authorization codes, brokerage identifiers, Apple private keys, APNs keys, database credentials, signing secrets, or pairing peppers in `VITE_*`, iOS bundles, source control, logs, analytics, tickets, or model context.

Broker access/refresh tokens remain in the isolated broker vault. Only the execution task role and a separately approved broker-sync task role may read/decrypt them; the API, agent orchestrator, Hermes, notification worker, market-data service, clients, and tenant jobs receive neither tokens nor vault access.

See [Broker account synchronization](broker-account-sync.md) and [Durable Paper agent scheduling](paper-agent-scheduling.md) for the producer/consumer job contracts, freshness gates, and lag response.

See [Hermes plan-cycle research](hermes-research.md) for the shared artifact boundary, privacy contract, and provider-profile requirements.
