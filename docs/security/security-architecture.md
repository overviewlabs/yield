# Security architecture

## Identity and sessions

Users authenticate with Sign in with Apple (and an approved magic-link option if enabled). Web sessions use Secure, HttpOnly, SameSite cookies, CSRF tokens, short access lifetime, rotating refresh/session identifiers, device/session inventory, revocation, brute-force limits, and account-takeover alerts. Sensitive iOS actions require LocalAuthentication with device-passcode fallback. Administrative access requires organization SSO, phishing-resistant MFA, managed-device policy, least-privilege roles, justification, and step-up for kill switches/reveals.

## Sensitive-operation step-up

A bearer session alone cannot approve a trade proposal, resume one agent, resume all agents, disconnect or prepare a Robinhood reconnect, request account deletion, or relax the effective risk policy. These routes call one server verification boundary. The configured verifier must return a fresh result bound byte-for-byte to the authenticated user, session, device, action, and server-selected resource; results older than five minutes, expired results, wrong-context results, and unsupported methods fail closed. Every accepted verification identifier is appended to an immutable tenant-scoped PostgreSQL journal with a global unique constraint before the operation proceeds, so a proof cannot be replayed for another action or after a process restart.

| Operation | Verification action | Server-bound resource |
| --- | --- | --- |
| Approve proposal | `approve_trade_proposal` | Proposal UUID |
| Resume one agent | `resume_user_agent` | User-agent UUID |
| Resume all agents | `resume_all_user_agents` | Authenticated user UUID |
| Disconnect or prepare reconnect | `disconnect_broker_connection` | `robinhood_mcp` |
| Request account deletion | `delete_account` | Authenticated user UUID |
| Relax risk policy | `relax_risk_policy` | Current policy UUID/version plus SHA-256 of the exact resulting controls |

Risk changes are intentionally asymmetric. Lower maximums, higher minimums, permission removal, and exclusion additions reduce authority and remain available without step-up. Raising a maximum, lowering a minimum, enabling a permission, removing an exclusion, or combining any relaxation with a tightening requires a proof bound to the current policy version and a digest of the exact resulting policy.

The repository does not treat LocalAuthentication success or client-supplied App Attest fields as verified cryptography. When no production App Attest, DeviceCheck, or WebAuthn verifier is composed, proof-bearing sensitive requests return `STEP_UP_VERIFICATION_UNAVAILABLE`; missing proofs return a typed denial. Production deployment therefore remains blocked on the real server verifier plus native challenge/assertion composition for these actions.

## Secrets and execution

Paper and Live have separate accounts, networks, KMS keys, secrets, queues, and databases. Broker tokens use per-record envelope encryption and are available only to the execution task role and a separately approved broker-sync task role. Ordinary API, admin UI, iOS, analytics, CI logs, and models cannot decrypt them. Rotation is tested; token compromise invokes revocation, pause, reconciliation, and reauthorization.

Authorization exchange, confirmation, and revocation are separate durable transitions. The API commits a cleanup tombstone before provider exchange, permits hydration only after provider confirmation acknowledgment, and reports disconnect/reconnect success only after provider revocation acknowledgment. Unknown outcomes stay in recovery and cannot be bypassed by starting a replacement authorization.

Only the execution worker can invoke broker review/place/cancel. It validates immutable proposal state, account binding, gates, entitlement, strategy, permission, risk, freshness, approval, idempotency, and locks. Critical dependency or audit failure blocks submissions. Pausing never automatically liquidates.

## Application/data controls

- TLS in transit; managed encryption at rest; private data services; WAF/rate limits; least-privilege IAM.
- Tenant context derived from authentication and enforced on every query; automated cross-tenant tests.
- Append-only audit/action events with correlation IDs and protected retention.
- Dependency/container/secret scans, signed immutable images, protected environments, canaries, and rollback circuits.
- App Attest/DeviceCheck raises request confidence; jailbreak signals inform risk but never establish truth alone.
- Privacy center, export, deletion workflow, broker disconnect, retention explanation, no ad SDKs/cross-app tracking.

## AI controls

External text/tool output is untrusted data. System policy and allowlisted tools are outside model control. Models receive minimized derived features, no secrets, and only with approved data-processing configuration and user consent. Output must match strict schemas; rationales are concise and verifiable, not hidden chain-of-thought. Models cannot change definitions/limits, approve themselves, conceal checks, or execute tools directly.

Logs/telemetry use opaque low-cardinality identifiers. Authorization headers, cookies, codes, tokens, account numbers, balances, positions, and financial rationales are prohibited attributes. Collector redaction is defense in depth, not permission to emit sensitive values.
