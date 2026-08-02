# Account-deletion runbook

The operator procedure is [`infrastructure/runbooks/account-deletion.md`](../../infrastructure/runbooks/account-deletion.md).

## User-facing behavior

Deletion requires strong authentication and a clear review that WHOX deletion does not close positions, cancel broker orders, or close the Robinhood account. Open or unknown orders block the implemented server request. The accepted-response alert exposes whether broker revocation is pending, but a production server export, expected processing time, persistent revocation-status surface, and counsel-approved regulatory-retention explanation remain release requirements rather than completed-work claims.

The implemented backend request locks the user authorization graph, refuses unresolved orders, closes the WHOX account, revokes sessions and device tokens, disables the local broker connection, cancels active pairings, dead-letters ordinary hydration work, and durably enqueues provider-revocation recovery. Its response exposes `brokerRevocationPending`; neither request acceptance nor local disconnection is terminal provider acknowledgment. Eligible-data deletion or anonymization, retained-record partitioning, export delivery, subprocessor propagation, and final completion evidence require separately implemented and approved workflows. Support cannot promise broker revocation or erasure before those authoritative outcomes, and it cannot promise erasure of legally retained records.

Edge cases requiring escalation: open/unknown orders, assignment/exercise approaching, legal hold, unresolved complaint/fraud, failed broker revocation, pending export, minor/deceased user process, or identity mismatch. Never auto-liquidate or make retention decisions ad hoc.
