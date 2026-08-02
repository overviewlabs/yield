# Yield for iOS

Native SwiftUI client for Yield. The app targets iOS 26, uses Swift 6.2 strict concurrency, and includes an iPhone/iPad app, WidgetKit extension, App Intents, unit tests, and UI tests.

The built-in Demo experience is complete and works without a backend or brokerage login. Paper mode uses authenticated canonical HTTP endpoints only when an explicit HTTPS service is configured; missing, malformed, mismatched, or Demo-classified responses fail closed and never fall back to seeded data. Live trading, options live trading, and autonomous execution are compile-time/resource gated off in `Resources/Configuration/ReleaseGates.json`.

## Build and test

Requirements:

- Xcode 26.1 or later
- XcodeGen 2.44 or later (`brew install xcodegen`)

From this directory:

```sh
make generate
make build
make test
xcrun swift-format lint --recursive --parallel --strict Sources Tests UITests Widget
```

`project.yml` is the source of truth for the generated Xcode project. Do not hand-edit `WHOXTreasury.xcodeproj`.

## App Review Demo

On a fresh install, choose **Open App Review Demo**. No credentials are required. This opens an isolated local preview; it does not mark onboarding complete, create an authenticated user, infer eligibility, or record legal consent. The review fixture demonstrates dashboard and performance data, equity and options positions, agents, an approval proposal, successful and failed orders, risk rejection, expiration warnings, settings, subscriptions, account deletion, and browser-pairing completion.

The local web pairing fixture is `http://localhost:4173/pair?pairing_code=SAFE-482K`. Production pairing remains server-created and server-confirmed.

In Paper configuration, eligibility, investor assessment, exact legal-document consent, and step progress are persisted through authenticated canonical onboarding endpoints and completion requires authoritative server confirmation. The bundled legal documents are intentionally marked nonproduction, so this sample cannot complete Paper onboarding until approved versions are delivered by the service. Demo acknowledgments remain isolated local fixtures.

See `Documentation/APP_REVIEW_NOTES.md` before submission. It intentionally identifies legal, licensing, production authorization, and support details that the product owner must supply; the app must not be submitted while those fields remain unresolved.

## Architecture and security boundaries

- `Sources/App`: lifecycle, session state, routing, and five-tab shell.
- `Sources/Features`: onboarding, dashboard, portfolio, agents, activity, and settings flows.
- `Sources/Services`: StoreKit, Apple authentication, Keychain credentials, pairing, device integrity, repository boundaries, and deterministic risk policy.
- `Sources/Models`: domain types and auditable Demo fixtures.
- `Sources/System`: navigation-only App Intents.
- `Widget`: privacy-sensitive status widget with redacted locked-device content.

Broker credentials never enter or persist in the iOS app. The client stores only short-lived WHOX session material in the Keychain. Purchases are locally verified with StoreKit 2, then sent as signed JWS transactions to the backend; only server-acknowledged entitlements may unlock server-run agents. Pause All is a protected server-first operation and never liquidates holdings.

## Runtime and Robinhood connection boundary

`WHOXRuntimeMode` must be exactly `demo` or `paper`. Paper additionally requires a valid HTTPS `WHOXAPIBaseURL`; `live`, absent, or invalid settings show a persistent unavailable screen. The Paper session restores and rotates WHOX access credentials through the Keychain, and logout/revocation is confirmed server-side before local credentials are discarded.

The iOS app starts a server-created, single-use authorization and asks the WHOX API to email the validated, short-lived provider destination to the Robinhood address entered by the user. The server supplies that address as the OAuth login hint; the phone receives only masked delivery status and an expiry. The user opens the link on a desktop computer, while Yield retains the pairing and polls canonical server status. It does not request Robinhood credentials, embed or proxy Robinhood, or receive or store OAuth codes, broker tokens, or MCP credentials.

Detailed notification previews default off and quiet hours are optional. In Paper mode those delivery/privacy fields, appearance, and privacy mode are server-confirmed through `/v1/settings`. APNs tokens are registered per authenticated device/environment and explicitly unregistered on permission removal, sign-out, or deletion. This build does not expose per-category notification filters or Critical Alerts because no corresponding server setting/client filter or Apple Critical Alerts entitlement is active.

Additional setup and operational notes are in `Documentation/`.
