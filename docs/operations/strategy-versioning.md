# Strategy-versioning procedure

1. Create a new immutable semantic version; never edit a version referenced by a run, proposal, order, or position.
2. Record objective, instruments, account modes, plan/capability, risk class, schedule, entry/exit rules, data dependencies, hard risk requirements, restricted conditions, prompt/model version if used, deterministic version, disclosures, and change log.
3. Add deterministic fixtures for trade/no-trade, stale/missing data, event restrictions, risk boundaries, conflicts, maximum loss, and absence of future data/look-ahead bias.
4. Peer review by quantitative, risk, security, product, and compliance owners appropriate to the change. New instruments/claims require legal review.
5. Release `draft → paper → limited rollout → live`; each promotion is a new audited status event. Paper results never merge with Live.
6. Canary by version and cohort. Compare proposal/risk rejection, turnover, data freshness, latency, error, reconciliation, and complaint metrics against explicit guardrails.
7. Pause/retire on schema/capability change, guardrail breach, disclosure mismatch, or unexplained behavior. Preserve monitoring and exits for existing positions; never auto-liquidate.

Model/prompt changes follow the same procedure and cannot alter deterministic policy/tool authority. Rollback selects a previous immutable version for new runs; it never rewrites past proposals. Existing positions keep their originating version and a separately versioned monitoring/exit compatibility policy.

A plan assignment's `researchUniverse` is part of its immutable catalog-version provenance. Adding, removing, or replacing a symbol requires publishing and activating a new reviewed `plan_agent_catalog_version`; never update an activated catalog entry in place. Before persisting an activation/configuration change or resuming automation, the API locks and verifies the user's exact current catalog entry and rejects configured symbols outside that entry's closed universe. Historical cycles and artifacts retain their original catalog version and universe.
