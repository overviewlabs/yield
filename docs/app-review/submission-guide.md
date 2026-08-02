# App Review submission guide

Start from the [ready-to-paste Review Notes template](app-review-notes.md). It deliberately keeps unavailable approvals marked **BLOCKED / TBD**; replace them only with verified evidence.

## Review environment

Use the built-in Demo environment with synthetic portfolio, positions, proposals, successful/failed orders, a risk rejection, options expiration warning, subscriptions, connection success, accessibility labels, and settings. It works without Robinhood credentials or Live network. All data and simulated execution are labeled Demo.

Review Notes must state:

- Product purpose: users select a strategy, set hard limits, monitor proposals/orders, and can pause future automation.
- Exact Demo entry steps and review credentials supplied through the secure App Review field—not this repository.
- Browser pairing opens the generated Robinhood authorization URL in Apple's secure authentication browser; Demo simulates completion without contacting Robinhood.
- Which screens/orders/data/subscriptions are simulated, and that no broker order is possible.
- Approved legal entity, licenses/permissions, Robinhood written authorization, support contact, data handling, and deletion steps. If any is unavailable, submission is blocked rather than fabricated.
- Subscription product IDs/terms and that purchase never grants broker options approval or guarantees results.

Attach counsel-approved disclosures and live URLs; verify Privacy Nutrition Labels/manifest against actual runtime. Demonstrate account deletion, restore purchases, privacy mode, notification denial, offline Demo, pause all, large Dynamic Type, VoiceOver, dark mode, and Reduce Motion.

Before upload, archive with the stable toolchain, run the complete suite, inspect signed entitlements/privacy manifest, confirm all seven server and bundled gates false, scan for secrets/test endpoints/placeholder legal language, and have Legal/Product/Engineering sign the release record.
