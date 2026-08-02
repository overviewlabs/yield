# Broker-outage runbook

Use [`infrastructure/runbooks/broker-outage.md`](../../infrastructure/runbooks/broker-outage.md).

Stop new Live entries; do not invent an unofficial endpoint or substitute fake execution. Preserve monitoring/reconciliation only where broker reads are confirmed safe. Unknown or timed-out order status stays unknown until reconciled. Expire old proposals normally and re-run fresh account/quote/entitlement/risk/review/approval checks after recovery. Capability changes keep dependent features disabled until adapter tests and review pass.
