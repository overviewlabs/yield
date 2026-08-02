# Backup and recovery

## Policy

Use encrypted multi-AZ databases, point-in-time recovery, daily snapshots, cross-account copies where approved, versioned object storage, and tested infrastructure-as-code. Paper and Live backups, keys, accounts, and restore targets remain separate.

## Restore drill

1. Open a change/incident record; choose a new isolated restore environment and exact recovery point.
2. Verify snapshot integrity, KMS/key access, migration compatibility, audit-chain continuity, and queue replay boundary.
3. Restore database and configuration without enabling workers. Broker tokens require an explicit Security-approved restore path.
4. Run consistency checks for users, account binding, proposals, orders, fills, event sequence, idempotency keys, capital reservations, and legal-consent versions.
5. Reconcile order truth with the broker before enabling reconciliation-only workers. Never replay execution queues from backup.
6. Run tenant-isolation and risk regression tests, then Paper smoke tests. Cut over via DNS/service routing only after approvals.

Quarterly drills must record achieved RPO/RTO, failed checks, corrective actions, and evidence. A successful database restore alone is not a successful trading-system recovery.
