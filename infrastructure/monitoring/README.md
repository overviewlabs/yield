# Monitoring contract

Application services emit OpenTelemetry traces, metrics, and structured logs. The collector removes known credential and account-number attributes before export; application code must still avoid emitting those values in the first place. Never depend on collector redaction as the only protection.

`alerts.yml` covers the release-critical conditions in the build brief. Each production alert must page a named on-call rotation and link to the deployed runbook URL. Metrics use low-cardinality opaque identifiers only—never email, full user IDs, symbols held by a user, broker account numbers, proposal rationale, tokens, or order details.

Validate configuration in CI with `promtool check config` and `promtool check rules`. Import `grafana/operations.json` through the managed dashboard provisioning pipeline. Production telemetry endpoints and authorization headers come from the secret manager.
