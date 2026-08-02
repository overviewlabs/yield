# App Review notes template

This is a ready-to-paste structure, not a release-ready representation today. Replace every bracketed field with verified evidence and obtain Legal/Product approval before submitting. Entries marked **BLOCKED / TBD** must not be softened, omitted, or described as approved.

## Review Notes

**Purpose**

Metis lets a user select a versioned investing strategy, set deterministic portfolio and order limits, review proposals and order activity, and pause future automated activity. It does not promise results. A subscription grants app features only; it does not grant brokerage trading or options permission.

**Demo entry — no credentials or purchase required**

1. Install and launch a fresh build.
2. On the first screen, tap **Open App Review Demo**.
3. The app opens a clearly labeled seeded Demo account with the five tabs Home, Portfolio, Agents, Activity, and Settings.
4. To review deletion, open **Settings → Delete account**, type `DELETE`, then tap **Authenticate and Delete Demo Account**. In Demo this resets only the local fixture.

No Apple, brokerage, or subscription credential is required for this path. If the review build uses any additional access step, provide its exact instructions through App Store Connect's secure Review Notes field: **[TBD before submission]**.

**How broker browser setup works**

Tapping **Connect to Robinhood** starts a short-lived, server-bound authorization and the capability-gated Paper client opens the generated, validated provider destination in `ASWebAuthenticationSession`; it never asks for a Robinhood password or stores broker tokens in iOS. The same authorization remains available through QR, Copy, and Share as optional browser-retry methods. The submitted Demo simulates successful pairing and never contacts or creates a brokerage account. The standard Paper build returns unavailable until the approved client registration, exact callback, and reviewed connector are configured.

`verification_pending` is not Connected. A non-Demo connection may be shown as Connected only after provider confirmation and verified Agentic Account/capability/snapshot hydration. Disconnect and reconnect preparation may report success only after provider revocation acknowledgment; an unknown outcome stays pending and blocks replacement authorization.

**Simulated scope**

All displayed balances, positions, quotes, charts, performance, proposals, fills, order states, risk rejections, options warnings, broker capabilities, connection state, notifications, agent runs, and entitlements in the review path are seeded Demo fixtures. Demo proposal approval and close review are local simulations; no order can reach a broker. StoreKit products in the checked-in configuration are test fixtures. Paper, backtest, Demo, and Live data are never presented as interchangeable.

**Legal and external approvals**

- Legal entity responsible for the financial service: **BLOCKED / TBD — [verified legal name and jurisdiction required]**.
- Applicable investment-adviser, broker/dealer, financial-services, and jurisdictional licenses or exemptions: **BLOCKED / TBD — [counsel-approved description and evidence required]**.
- Robinhood written production authorization/client registration: **BLOCKED / TBD — not present in this repository**.
- Counsel-approved Terms, Privacy Policy, advisory agreement, performance disclosure, electronic consent, and AI/subprocessor disclosure URLs: **BLOCKED / TBD — [live versioned URLs required]**.
- App Store financial-entity eligibility/approval: **BLOCKED / TBD — [App Store Connect evidence required]**.

The app's seven Live release gates remain false. Do not submit a build that represents any blocked item as approved.

**Subscription products**

Development fixture identifiers are `ai.whox.metis.equity.monthly`, `ai.whox.metis.equitypro.monthly`, `ai.whox.metis.options.monthly`, and `ai.whox.metis.optionspro.monthly`. App Store Connect product status, localized terms, pricing, and review approval are **BLOCKED / TBD** until verified. The Demo path requires no purchase, and purchasing a product never authorizes a brokerage order or options strategy.

**Data handling**

The Demo path uses synthetic local fixtures and creates no broker credential. Production identity, telemetry, portfolio, order, retention, processor, encryption, and privacy-label statements must match the deployed runtime and the approved Privacy Policy: **BLOCKED / TBD — [approved data inventory and Privacy URL required]**. Broker tokens, when production authorization exists, are server-side secrets restricted to the execution and separately approved broker-sync roles and are never placed in the iOS app, web connector state, analytics, or logs. Only the execution worker may place orders.

**Account deletion**

The in-app entry is **Settings → Delete account**. The implemented server boundary rejects deletion while open or unknown orders remain, revokes WHOX sessions/devices, stops future local authority, disables the broker connection, and durably requests provider revocation without closing brokerage positions. An accepted request is not evidence that provider revocation, eligible-data erasure, retained-record partitioning, or subprocessor propagation has completed. Those workflows, the production endpoint, retention schedule, counsel-approved disclosure, and public deletion URL are **BLOCKED / TBD — [evidence and URL required]**.

**Contact**

- Review contact name/title: **[TBD]**
- Review phone/email: **[TBD; provide in App Store Connect, not source control]**
- Customer support URL/email: **BLOCKED / TBD — [approved live contact required]**
- Privacy contact: **BLOCKED / TBD — [approved live contact required]**
