# Rollback procedure

Use [`infrastructure/runbooks/rollback.md`](../../infrastructure/runbooks/rollback.md).

Rollback selects a previously verified immutable image/configuration and stops canary expansion. If execution correctness is uncertain, engage the kill switch first. Never reverse a destructive migration automatically or infer order status from a timeout. Reconcile the deployment boundary, validate audit/locks/account binding/freshness, run focused tests and Paper canary, then resume through an audited recovery gate.
