# Dependency rationale

Dependencies are kept deliberately small, locked in `package-lock.json` or pinned by version/digest in CI, and reviewed by weekly update automation.

| Area | Dependency | Why it exists |
|---|---|---|
| Node services | `pg` | Executes reviewed SQL migrations, row-level policies, tests, and Demo seeds through PostgreSQL without a host `psql` subprocess dependency. |
| Node development | `typescript` | Enforces shared strict types across contracts, risk controls, services, and web boundaries before runtime. |
| Node development | `tsx` | Runs TypeScript service tests and local entry points without maintaining a second emitted test tree; it is not shipped in the pruned service runtime image. |
| Web applications | `react` / `react-dom` | Provides accessible component/state composition for the pairing flow and role-aware admin console. |
| Web build | `vite` / `@vitejs/plugin-react` | Produces small static assets, injects explicitly scoped build configuration, and supports a fast local review server. |
| Web tests | `vitest` | Exercises deterministic pairing/admin domain logic in the same module environment used by Vite. |
| API CI | `@redocly/cli` | Applies the full recommended OpenAPI 3.1 quality ruleset and reference validation. |
| API CI | `openapi-typescript` | Generates compile-checked client types from the canonical contract to detect schema/tooling drift. |
| API compatibility | `oasdiff` | Rejects breaking pull-request changes relative to the base-branch OpenAPI contract. |
| Security/operations | Trivy, CodeQL, Terraform AWS provider, Prometheus `promtool`, and the OpenTelemetry Collector | Provide pinned secret/dependency/static analysis, reproducible cloud definitions, alert validation, and telemetry redaction/export rather than custom security or operations parsers. |
| iOS | Apple SDK frameworks only | SwiftUI, Charts, StoreKit, AuthenticationServices, LocalAuthentication, WidgetKit, AppIntents, and related system frameworks provide the required native features. No third-party Swift package is included, reducing mobile supply-chain and privacy surface. |
| StoreKit server | `@apple/app-store-server-library` 3.1.0 | Apple's official Node library validates StoreKit 2 transaction, renewal, and App Store Server Notifications V2 JWS certificate chains, identifiers, and environments. The version is pinned and wrapped behind WHOX interfaces for deterministic tests and fail-closed runtime configuration. |

An update is accepted only after build/test, license, security-advisory, privacy, and runtime-behavior review. Digest updates must retain multi-architecture support. A dependency cannot weaken release gates, broker isolation, deterministic risk checks, or data minimization.
