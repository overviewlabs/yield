# StoreKit configuration

`apps/ios/Resources/Configuration/WHoxTreasury.storekit` is a local test fixture. It exercises product loading, localized display, purchase/pending/cancel/failure, verification, current entitlements, restore, upgrade/downgrade, expiration, refund/revocation, and subscription management. Fixture prices are never the production source of truth.

## Product families

Suggested monthly identifiers are `whox.treasury.equity.monthly`, `whox.treasury.equitypro.monthly`, `whox.treasury.options.monthly`, and `whox.treasury.optionspro.monthly`; annual products may be added after pricing/legal review. Production identifiers, pricing, names, terms, and availability come from App Store Connect and backend plan configuration.

## Validation

1. Select the StoreKit configuration on the Xcode scheme and use a fresh test account/state.
2. Test every purchase state, interrupted launch, Ask to Buy/pending, restore, renewal, grace/billing retry, upgrade/crossgrade/downgrade, refund/revocation, and network failure.
3. Verify signed transactions on-device and reconcile App Store Server Notifications server-side. The backend entitlement—not a client plan string—is authoritative for server agents.
4. Confirm plan loss stops incompatible new entries but preserves records, monitoring, expiration/risk notifications, and permitted protective exits; it never liquidates.
5. Confirm an Options plan does not grant brokerage options permission, and automatic mode remains separately gated.

The paywall must show StoreKit-localized price/period, renewal terms, restore, manage-subscription link, privacy/terms, and accurate risk copy. Plans differ by access/cadence/capacity—not decision quality or safety—and never promise returns.
