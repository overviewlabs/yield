# Metis

Metis is a native investing control plane for selecting versioned strategies, setting deterministic risk limits, monitoring proposals and orders, and pairing a dedicated Robinhood Agentic Account through the official Trading MCP boundary.

> **Release status:** Demo is immediately runnable. Paper has durable API/session/pairing state, native iOS API wiring, a shared deterministic plan-cycle scheduler with tenant-isolated fan-out, a strict Hermes research-artifact boundary, approved-provider market-data boundaries, receipt-bound broker-account hydration, and a Foundation Equity v1 proposal/execution pipeline with fresh-quote reconciliation, atomic cancellation/pause handling, legal-document retrieval, exact-context sensitive-action authorization, and official StoreKit signed-transaction/notification verification. It is not externally launch-ready: approved Robinhood authorization/callback and account-data connectors, an approved market-data provider, a reviewed Hermes deployment and rotated managed key, a production App Attest cryptographic provider and server verifier, counsel-published legal documents, Apple identifiers/products/notification evidence, production identity/push configuration, and the external approvals listed below are still absent. Live execution is impossible by default. This repository is not evidence of legal, advisory, App Store, or Robinhood production approval. Investing and options involve risk, including possible loss of principal; automated agents can make errors. Metis is not Robinhood and is not represented as endorsed by Robinhood.

## Safety posture

Every applicable server flag must be exactly `true` before a Live submission can proceed. The checked-in configuration locks all seven to `false`:

```text
LIVE_TRADING_ENABLED=false
ROBINHOOD_PRODUCTION_APPROVED=false
LEGAL_DOCUMENTS_APPROVED=false
ADVISORY_COMPLIANCE_APPROVED=false
APP_STORE_FINANCIAL_ENTITY_APPROVED=false
OPTIONS_LIVE_TRADING_ENABLED=false
AUTONOMOUS_MODE_ENABLED=false
```

Demo never reaches a broker. Paper never substitutes synthetic Demo quotes, portfolios, capabilities, or fills and fails closed until every required provider, verifier, secret, and durable dependency is configured. Its scheduler and execution path require fresh provider data and receipt-bound Agentic Account state; order reconciliation cannot turn a resting or blocked order into a fabricated fill, and pause/cancel paths durably stop unsubmitted work. The implemented persistent strategy pipeline supports Foundation Equity v1 only; unsupported strategies fail closed.

Every active plan publishes exactly one current catalog containing one to three ordered, distinct shared agent versions. For each canonical plan/catalog/agent/time cycle, the orchestrator makes one logical deterministic Hermes request over a frozen, bounded public-quote universe from that exact assignment. At-least-once delivery can repeat the network invocation with the same request ID, but PostgreSQL accepts only one digest-bound immutable artifact. Tenant fan-out carries only that artifact reference into independent tenant-bound jobs; every job separately reloads and validates ownership, subscription, legal consent, Agentic Account binding, capabilities, portfolio and quote freshness, deterministic risk, approval, execution, and reconciliation state.

Native sensitive-action request composition and exact server-canonical action/resource binding are implemented; sensitive operations still fail closed until a production App Attest cryptographic provider and server verifier are composed. Only the execution worker may call broker placement tools. Broker-token-vault access is limited to the execution role and a separately approved broker-sync role; Hermes, other models, clients, the API, and the orchestrator cannot hold broker credentials, change risk limits, select an account, approve a proposal, or submit an order.

## Repository

- `apps/ios` — SwiftUI iPhone/iPad application, widget, StoreKit client fixture, and tests.
- `apps/web-connection` — accessible browser pairing UI with a fully local Demo provider and secure API boundary.
- `apps/admin-console` — role-aware Demo compliance/operations console with justified access and audited actions.
- `services` — API, strategy orchestration, execution, broker synchronization, notification, and market-data boundaries.
- `packages` — contracts, configuration, risk schemas, versioned agent definitions, design tokens, and fixtures.
- `database` — normalized migrations, row-level policies, and explicitly nonproduction Demo seeds.
- `infrastructure` — local containers, isolated Paper/Live Terraform, monitoring, and runbooks.
- `docs` — architecture, security, compliance, App Review, operations, and user support.

## Quick start

Prerequisites are Node.js 22+, npm 10+, Docker with Compose, and—only for iOS—the current stable public Xcode plus XcodeGen 2.44+.

```sh
npm ci
npm run verify
docker compose -f infrastructure/docker/compose.yml up --build
```

The default containers expose the Demo pairing UI at `http://localhost:4173/pair?pairing_code=SAFE-482K` and Demo admin console at `http://localhost:4174`. PostgreSQL and Redis bind only to loopback. Add `--profile backend` or `--profile workers` after running the database migration commands below. The API uses port 8080; the orchestrator, execution, notification, market-data, and approved broker-sync worker health boundaries use ports 9101 through 9105 respectively.

WHOX's iPhone boundary starts a short-lived, server-bound authorization and opens the generated, validated Robinhood setup URL in `ASWebAuthenticationSession`; the user signs in and approves within Robinhood. WHOX polls masked server status and keeps QR, Copy, and Share as optional browser-retry methods. The standard runtime still fails closed until the approved client registration, exact callback, and isolated connector are configured.

For iOS:

```sh
cd apps/ios
xcodegen generate
open WHOXTreasury.xcodeproj
```

Select the `WHoxTreasury.storekit` configuration and a current iOS 26 simulator. The server-side StoreKit verification boundary is implemented, but development/production signing, Sign in with Apple, APNs, production App Attest composition, counsel-published legal documents, broker client registration, App Store identifiers/products, and notification-delivery evidence still require external configuration or approval.

## Verification

```sh
npm run safety
npm run build
npm run typecheck:workspaces
npm run test:workspaces
docker compose -f infrastructure/docker/compose.yml config --quiet
```

Terraform commands and the mandatory encrypted remote-state policy are documented in [`infrastructure/terraform/README.md`](infrastructure/terraform/README.md). Start with [`docs/README.md`](docs/README.md) for the complete documentation map and [`docs/known-limitations.md`](docs/known-limitations.md) before any release decision.

The intentionally small external dependency set and the reason for each runtime/build tool are documented in [`docs/architecture/dependency-rationale.md`](docs/architecture/dependency-rationale.md).
