# Operator runbooks

These runbooks assume named incident commander, operations, security, compliance, and communications roles. Record every command and administrative action with a correlation ID. Never paste broker tokens, authorization codes, account numbers, order details, balances, or customer PII into chat, tickets, pages, or logs.

| Event | Runbook |
|---|---|
| Unknown or cross-service incident | [Incident response](incident-response.md) |
| Broker/MCP degradation | [Broker outage](broker-outage.md) |
| Unsafe execution condition | [Emergency trading pause](emergency-trading-pause.md) |
| OAuth/broker token exposure | [Token compromise](token-compromise.md) |
| User deletion request | [Account deletion](account-deletion.md) |
| Restore or failover | [Backup and recovery](backup-recovery.md) |
| Bad deploy/configuration | [Rollback](rollback.md) |

Live execution is never restored merely because an alert clears. The incident commander requires evidence that reconciliation is current, account binding is correct, audit writes are healthy, market/account data are fresh, and every applicable release gate remains approved.
