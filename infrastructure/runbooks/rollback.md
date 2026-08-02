# Deployment rollback

## Decision

Rollback for elevated errors, data/schema incompatibility, broker capability regression, risk-policy discrepancy, audit failures, latency SLO breach, or unexpected proposal/order behavior. Engage the kill switch before rollback whenever execution integrity is uncertain.

## Procedure

1. Record current and target image digests, configuration/flag versions, migration version, affected environment, and correlation ID.
2. Stop canary expansion. Route traffic to the last verified immutable task definition; do not rebuild an old tag.
3. Never automatically reverse a destructive database migration. Use the reviewed forward-fix/restore plan and preserve event tables.
4. Keep execution desired count zero until API health, audit writes, queues, locks, account binding, market freshness, and reconciliation are verified.
5. Reconcile every order created near the deployment boundary. Do not resubmit ambiguous or timed-out requests.
6. Run focused tests and a Paper canary. Resume through the emergency-pause recovery gate.

Close the change with root cause and add a regression test. Rollback success is based on verified behavior and reconciliation, not merely healthy container status.
