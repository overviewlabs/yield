# Threat model

## Assets and boundaries

Highest-impact assets are broker authorization, correct user/account binding, order authority, risk/legal configuration, immutable audit history, financial/identity data, signing/encryption keys, and administrative control. Trust boundaries exist at iOS/web/API, admin/API, queue/worker, model/orchestrator, execution/broker, and service/data/telemetry interfaces.

| Threat | Primary controls | Detection/response |
|---|---|---|
| Pairing code brute force/reuse | High entropy, digest+pepper, short expiry, same-user auth, layered rate limits, atomic consume | Security event; revoke session; investigate IP/account pattern |
| OAuth CSRF/code injection/mix-up | S256 PKCE, bound state, issuer checks, exact redirect, metadata validation; nonce only for an OIDC ID token | Reject without token use; OAuth mismatch alert |
| Authorization URL/token leakage | HTTPS allowlist, server callback, header-only bearer, no browser storage/logs | Redaction tests, CSP, token-compromise runbook |
| Exchange timeout/crash leaves a provisional credential | Commit a tenant-bound tombstone before the provider call; connector exchange/revocation idempotent by transaction UUID; delayed cleanup and janitor recovery | Authorization-lag alert; reconcile or revoke by opaque transaction identifier without reusing the code |
| Confirmation or reconnect race | Immutable confirmation/revocation saga, provider acknowledgment before hydration or success, user-graph lock, replacement blocked while revocation is pending | Recovery queue and lag alert; never clear a saga, handle, or tombstone manually |
| Cross-tenant/BOLA | Auth-derived tenant scope, service/RLS policy, opaque IDs | Cross-user automated tests and denial-rate alert |
| Wrong broker account | Server-held Agentic binding, reverify before order, model/client cannot choose | Critical binding rejection; global pause if systemic |
| Duplicate/raced order | Idempotency key, distributed proposal lock, immutable state transition | Duplicate-attempt page; reconcile before retry |
| Prompt injection/tool misuse | Untrusted-data separation, tool allowlist, strict output schema, no placement/model credentials | Adversarial fixtures, tool-call bypass tests |
| Stale/poisoned data | Approved sources, timestamps, freshness limits, evidence references | Staleness halt and operator alert |
| Admin abuse/account takeover | SSO, phishing-resistant MFA, managed device, RBAC, reason, step-up, immutable before/after audit | Security review, revoke sessions, preserve evidence |
| Token/KMS compromise | Envelope encryption, vault access limited to execution and separately approved broker-sync roles, rotation/revocation, environment isolation | Decrypt anomaly alert and compromise runbook |
| Queue replay/worker crash | Durable messages, idempotency, visibility timeout, DLQ, reconciliation | Queue/reconciliation alerts; never blind replay |
| Shared plan-agent blast radius | Versioned 1–3 agent catalog per plan, canonical plan-cycle timestamp, bounded fan-out, tenant-bound jobs, independent per-account risk/consent/approval/execution checks | Aggregate cycle health plus tenant-scoped failures; pause the affected plan version without weakening user controls |
| External Hermes tool side effects | Dedicated stateless research-only Hermes profile, all terminal/file/web/memory/skill/plugin/MCP/cron tools disabled at the provider, no tenant identity/financial/broker data in prompts, strict closed output schema | Fail provider composition closed without exact operator attestation; reject tool calls/malformed output; rotate key and isolate endpoint on any anomaly |
| Central credential aggregation | Per-user envelope-encrypted broker records, opaque connection references in jobs, broker vault access limited to approved sync/execution roles; never a plan-level token file | Secret-access anomaly alert, revoke affected connection independently, rotate vault keys under incident procedure |
| Audit/log failure | Synchronous critical audit, append-only storage, redaction | Fail submissions closed; incident response |
| Subscription downgrade | Server authority, transition rules | Block new incompatible entries; never liquidate/withhold records |

Assume browser extensions, user devices, external content, model output, clients, and provider errors can be hostile or wrong. A model endpoint that returns only text can still execute provider-side tools before returning; client-side `tool_choice` is not a substitute for disabling those tools at the provider. Do not assume TLS prevents compromised endpoints, notifications are delivered, timeouts imply failure, or a broker tool schema remains stable.

Review this model for every new instrument, OAuth provider change, agent/risk version, external model/tool, data field, admin action, and deployment topology change. Security acceptance requires tests and named residual-risk owners, not only documentation.
