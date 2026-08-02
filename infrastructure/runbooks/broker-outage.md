# Broker or Trading MCP outage

## Detect

Triggers include connection failures, authorization discovery failure, capability-set change, elevated tool errors, refresh-token failure, unknown order status, or reconciliation older than 120 seconds.

## Respond

1. Halt new Live entries at the broker adapter or global kill switch. Do not fabricate a fallback execution path.
2. Continue reconciliation where confirmed broker reads remain safe; otherwise mark status stale/unknown and alert users without guessing.
3. Preserve queued proposals but expire them normally. Never submit an old proposal after recovery without fresh account, quote, entitlement, risk, and broker review checks.
4. Discover MCP protected-resource and authorization metadata again. Record protocol version and tool capability diff, excluding tokens.
5. Check the broker’s official status/support channel and open a provider case using opaque connection IDs only.
6. Notify users of degraded connectivity, what is blocked, and that existing positions remain at the broker.

## Recover

Require stable health across three observation windows, complete reconciliation of all open orders, fresh capability discovery, token refresh tests, and a Paper canary. If a tool disappeared or changed schema, keep dependent features disabled until the adapter and tests are reviewed. Resume through an audited administrative action; no queued Live order is replayed automatically.
