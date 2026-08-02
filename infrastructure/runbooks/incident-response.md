# Incident response

## Trigger and authority

Declare an incident for suspected unauthorized access, cross-tenant exposure, duplicate submission, incorrect account binding, missing audit records, unexplained order state, material availability loss, or breach of a freshness/risk SLO. Any on-call operator may engage the global execution kill switch; only an Administrator following the recovery gate may resume.

## First 15 minutes

1. Create a restricted incident record and correlation ID; assign incident commander, operations lead, security lead, and scribe.
2. If execution integrity is uncertain, engage the kill switch. Confirm scheduling and new submissions are blocked while reconciliation and monitoring continue.
3. Preserve immutable logs, audit events, queue attributes, deployment digests, feature-flag versions, and broker capability snapshots. Do not copy sensitive payloads.
4. Establish scope by environment, tenant count, proposal/order state, and earliest known timestamp. Paper and Live must be assessed separately.
5. Notify compliance/security leadership under the approved severity matrix. Use counsel-approved customer or regulator language only.

## Containment and diagnosis

- Verify database, queue, KMS, audit sink, clock, market-data freshness, and worker health.
- Compare internal orders with broker-confirmed status; do not infer fills.
- Disable affected agent/risk/model versions rather than editing an active definition.
- Rotate exposed credentials through the token-compromise runbook.
- Keep evidence read-only and record all queries with a purpose.

## Recovery gate

Reconcile every nonterminal order, prove idempotency/locks, validate correct account binding, run focused regression tests, obtain Security and Operations approval, then canary in Paper. Resuming Live requires Administrator action with reason and correlation ID; positions are never automatically liquidated.

## Closeout

Publish a factual timeline, customer-impact count, root cause, controls that worked/failed, follow-up owners, due dates, and evidence retention classification. Conduct a blameless review within five business days. Never include secrets or unnecessary user data in the report.
