# System architecture

Yield separates shared public research from tenant authority. Every active plan publishes one current catalog containing one to three ordered, distinct shared agent versions. The orchestrator elects a canonical cycle for each due plan/catalog/agent assignment, freezes a centrally published bounded public-quote context, accepts one immutable Hermes research artifact, and fans out only the artifact reference. Each tenant job then reloads its own binding, policy, account state, consent, approval, and execution prerequisites. iOS/web clients present and approve; server workers schedule and reconcile; only the execution worker can invoke broker placement tools. PostgreSQL owns durable state, Redis owns short-lived coordination, and durable queues decouple every consequential transition.

This is the target production topology. Demo implements and exercises the complete local review experience. Paper implements durable API/session/pairing state, native iOS REST wiring, shared deterministic plan-cycle scheduling, tenant-isolated fan-out, immutable Hermes artifact validation, tenant policies, market-data ingestion boundaries, APNs delivery, and a deterministic Foundation Equity v1 proposal/execution path. It still fails closed without approved external provider adapters, rotated managed credentials, verifiers, and deployment configuration. Neither Paper nor Live is externally production-ready; Live remains deliberately unreachable rather than presenting this diagram as deployed production behavior.

## Components

| Component | Responsibility | Explicitly cannot |
|---|---|---|
| iOS | Onboarding, limits, monitoring, approval, pause | Store broker tokens or run continuous automation |
| Browser connector | Claim a short-lived pairing and redirect to broker auth | See tokens/codes after callback or place trades |
| Authorization connector | Provider-approved discovery, code exchange, provisional vault confirmation, and idempotent revocation | Expose token bytes to clients/models, hydrate an account, or place orders |
| Admin console | Masked oversight and audited controls | Override server authorization or external approvals |
| API | Authentication, tenant authorization, contracts, user state | Decrypt broker tokens or directly place orders |
| Agent orchestrator | Shared plan-cycle election, bounded public research, tenant-bound fan-out, deterministic strategy, proposals | Send tenant/account data to Hermes, approve, or submit its own proposal |
| Hermes research profile | Strict research-only annotation of the central public quote universe | Use tools/memory, receive tenant data, choose an account/order, or execute |
| Risk engine | Deterministic user/platform checks | Loosen platform caps or infer broker permission |
| Execution worker | Broker review, placement, cancellation, reconciliation | Bypass risk/gates/account binding or accept model tool calls |
| Broker-sync worker | Approved account/capability reads and receipt-bound tenant snapshots | Place orders, expose tokens, or run without a reviewed connector |
| Notification worker | Deduplicated APNs/realtime delivery | Treat delivery as the only safety control |
| Market data service | Approved-source normalization/freshness | Invent missing market values |

## Environment boundary

Demo, Paper, and Live use separate configuration. Paper and Live production use separate cloud accounts, networks, databases, Redis clusters, queues, keys, secrets, telemetry, and deployments. Demo has no broker path. Paper never calls placement tools. Live additionally requires every applicable release flag and approval.

Critical dependencies fail closed: unavailable audit storage, plan research artifact, execution worker, account binding, entitlement/risk data, broker review, fresh quotes/account state, or reconciliation blocks new submissions. Paper Hermes additionally requires the exact canonical URL `https://treasury-bot.whox.ai/v1`, exact model `treasury-bot`, an orchestrator-only managed and rotated API key, and exact `HERMES_RESEARCH_PROFILE_TOOLS_DISABLED=true` attestation after verifying that every remote tool and memory facility is disabled. Monitoring and user-reviewed risk-reducing workflows continue where safe.

The production module registers the API plus five worker runtime boundaries even when a capability is deliberately held at zero capacity. API health is on 8080; agent orchestration, execution, notification, market-data, and broker-sync health are on 9101, 9102, 9103, 9104, and 9105 respectively. Separate ECS execution roles inject only each process's exact secrets. Broker-token-vault read/decrypt permission exists only on the execution task role and the separately approved broker-sync task role; the API, orchestrator, Hermes, notification, and market-data roles do not have it. No runtime role can read the RDS master secret.

## Trust rules

- Models receive minimized verified features and untrusted content, never credentials.
- Hermes receives only frozen central-plan public quote context. A cycle has one logical deterministic request; network retries may repeat it, while the database accepts only one immutable artifact.
- Tenant binding, risk, approval, execution, and reconciliation remain independent after fan-out; shared research never shares tenant authority or failure state.
- Tool discovery is runtime allowlisted; missing/renamed broker tools disable dependent features.
- Every proposal transition, approval, broker request, administrative action, and legal consent is authorized and auditable.
- Browser/mobile values are requests, never authority for ownership, plan, broker account, fill, or price.
- No subscription tier receives weaker safety or claims better trades.
