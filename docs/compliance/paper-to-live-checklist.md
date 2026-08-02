# Paper-to-Live launch checklist

Every item needs named owner, timestamp, evidence link, and independent approver. “Not applicable” requires written rationale. A passing build alone is insufficient.

## External authority

- [ ] Written Robinhood production registration/permission and tested official MCP client registration.
- [ ] The generated Robinhood Agentic Account authorization URL and exact callback are approved and validated for WHOX's system-browser flow on every supported device; no unofficial browser automation or credential capture ships.
- [ ] Counsel-approved entity, Terms/Privacy/disclosures/agreements, advisory/broker analysis, options treatment, performance methodology, retention, and incident notices.
- [ ] Advisory/compliance approval and operational supervisory procedures.
- [ ] App Store financial-services/entity and subscription products approved.
- [ ] Production Apple identifiers, Sign in with Apple, APNs, App Attest, privacy manifest/answers, support and deletion endpoints verified.

## Technical evidence

- [ ] Separate Live account/network/database/Redis/queues/KMS/secrets/state/telemetry; encrypted locked remote Terraform state.
- [ ] Execution worker is the only broker placement principal; broker-vault read access is limited to execution and the separately approved broker-sync role; Live desired count remains zero until change window.
- [ ] OAuth metadata, exact redirect, S256 PKCE, state/issuer, audience/resource, refresh/revocation, and token-rotation tests pass.
- [ ] Authorization tests cover a committed pre-exchange tombstone, late/hung exchange, provisional-vault confirmation and deadline, process crash recovery, provider acknowledgment before hydration or disconnect/reconnect success, and replacement blocking while revocation is pending.
- [ ] Correct Agentic Account binding and runtime tool discovery/delta alert pass.
- [ ] Tenant isolation, CSRF/replay, idempotency/race, risk, state machine, audit, stale-data, partial fill, unknown status, outage, backup/restore, and rollback tests pass.
- [ ] Reconciliation/audit/kill-switch/expiry monitoring and on-call pages tested in a game day.
- [ ] Paper canary meets predeclared safety, correctness, latency, cost, and complaint guardrails; performance labels verified.

## Activation

- [ ] Current users have required consent, entitlement, broker permission, limits, approval mode, and cooling-off period.
- [ ] Enable foundational approval flags through reviewed configuration; verify each value independently.
- [ ] Start Live worker at the minimum canary count with new entries still globally paused.
- [ ] Run read-only/account-binding/tool discovery and reconciliation checks, then a controlled non-order dry run.
- [ ] Enable `LIVE_TRADING_ENABLED` last for the approved cohort. Options/autonomous flags remain false until their separate launches.
- [ ] Observe staffed canary and rollback thresholds. Any ambiguity engages the kill switch; never replay queued orders.
