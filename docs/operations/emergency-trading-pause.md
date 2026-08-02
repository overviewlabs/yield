# Emergency trading-pause runbook

Use [`infrastructure/runbooks/emergency-trading-pause.md`](../../infrastructure/runbooks/emergency-trading-pause.md).

Pause stops scheduling/proposals/submissions and may cancel queued unsubmitted work. It does not liquidate positions. Reconciliation, monitoring, risk/expiration alerts, and approved user-reviewed risk-reducing paths continue. Resume requires strong authentication, remediation evidence, reconciliation, fresh state, focused tests/Paper canary, and immutable actor/role/reason/before/after/timestamp/correlation audit.
