# Backup and recovery plan

Use [`infrastructure/runbooks/backup-recovery.md`](../../infrastructure/runbooks/backup-recovery.md).

Paper and Live use separate encrypted multi-AZ data systems, keys, accounts, snapshots, and restore targets. Recovery validates more than database availability: audit/event continuity, tenant boundaries, idempotency, reservations, order/fill state, legal versions, queue replay boundaries, and authoritative broker reconciliation. Execution queues are never blindly restored/replayed. Quarterly isolated drills record achieved RPO/RTO and corrective actions; production RPO/RTO require business/compliance approval.
