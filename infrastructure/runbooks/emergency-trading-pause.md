# Emergency trading pause

## Engage

1. Use the system-wide execution kill switch for systemic risk; use user or strategy pause for proven limited scope.
2. Confirm new evaluations, new proposals, and order submissions are blocked. Cancel only queued and unsubmitted work.
3. Keep account monitoring, broker reconciliation, risk alerts, and expiration monitoring running.
4. Do not liquidate positions. Open orders may be canceled only after their state is reconciled and the authorized workflow confirms eligibility.
5. Record actor, role, reason, before/after state, timestamp, and correlation ID. Notify users and operators at the appropriate scope.

## Verify

Query queue depth, submission-rate metrics, distributed locks, worker desired count, and broker order activity. A pause is incomplete if any new submission reaches the broker after the effective timestamp; escalate as critical.

## Resume

Identify and remediate the trigger, reconcile every order, validate audit writes, confirm current account binding and data freshness, run focused tests and Paper canary, then obtain Operations plus Compliance/Security approval as applicable. Resume requires strong authentication and a new audited action. Preserve a risk-reducing, user-reviewed exit path where legally and technically permitted.
