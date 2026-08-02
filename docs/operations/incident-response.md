# Incident-response runbook

The deployable operator procedure is [`infrastructure/runbooks/incident-response.md`](../../infrastructure/runbooks/incident-response.md). It defines declaration authority, first-15-minute containment, evidence, recovery gates, communications, and closeout.

Product-specific principles: any operator may pause new execution when integrity is uncertain; reconciliation/monitoring continue; broker status is authoritative; customer copy is factual and counsel-approved; secrets/financial details stay out of incident channels. Restoration requires current account binding, audit health, full order reconciliation, fresh data, focused regression tests, Paper canary, and an authenticated audited administrative action.

Severity-one examples are suspected unauthorized order, cross-tenant exposure, wrong account binding, duplicate broker submission, compromised broker token, audit-write failure during execution, or systemic inability to reconcile.
