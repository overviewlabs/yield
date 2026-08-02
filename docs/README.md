# Metis documentation

These documents describe the runnable Demo, the implemented but dependency-gated Paper path, and the controlled boundaries required for Live. Paper and Live are not externally production-ready. These are engineering documents, not attorney-approved disclosure language or proof of licensing, App Store approval, Robinhood approval, or provider readiness.

## Architecture and API

- [System architecture](architecture/system-architecture.md)
- [Data-flow diagram](architecture/data-flow.md)
- [Database schema](architecture/database-schema.md)
- [OpenAPI usage](api/openapi.md)
- [Robinhood Trading MCP](architecture/robinhood-mcp.md)
- [Agent architecture](architecture/agent-architecture.md)
- [Deterministic risk engine](architecture/risk-engine.md)
- [Dependency rationale](architecture/dependency-rationale.md)

## Setup and platform services

- [Local setup](operations/local-setup.md)
- [Xcode setup](operations/xcode-setup.md)
- [Environment variables](operations/environment-variables.md)
- [StoreKit configuration](app-review/storekit-configuration.md)
- [App Store Connect products](app-review/app-store-connect-products.md)
- [App Review notes template](app-review/app-review-notes.md)
- [APNs setup](operations/apns-setup.md)
- [StoreKit server verification](operations/storekit-server.md)
- [Broker account synchronization](operations/broker-account-sync.md)
- [Durable Paper agent scheduling](operations/paper-agent-scheduling.md)
- [Hermes plan-cycle research](operations/hermes-research.md)

## Security and compliance

- [Security architecture](security/security-architecture.md)
- [Threat model](security/threat-model.md)
- [Browser pairing](security/desktop-pairing.md)
- [Legal document publishing](compliance/legal-document-publishing.md)
- [Strategy versioning](operations/strategy-versioning.md)
- [Paper-to-Live checklist](compliance/paper-to-live-checklist.md)
- [Performance methodology](compliance/performance-methodology.md)

## Review, operations, and support

- [App Review submission](app-review/submission-guide.md)
- [Incident response](operations/incident-response.md)
- [Broker outage](operations/broker-outage.md)
- [Emergency trading pause](operations/emergency-trading-pause.md)
- [Token compromise](operations/token-compromise.md)
- [Account deletion](user-support/account-deletion.md)
- [Customer support](user-support/customer-support.md)
- [Backup and recovery](operations/backup-recovery.md)
- [Rollback](operations/rollback.md)
- [Known limitations](known-limitations.md)
