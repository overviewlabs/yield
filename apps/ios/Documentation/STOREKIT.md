# StoreKit and App Store Connect

The test configuration defines one subscription group with four monthly products:

| Product ID | Display name |
| --- | --- |
| `ai.whox.yield.equity.monthly` | Equity |
| `ai.whox.yield.equitypro.monthly` | Equity Pro |
| `ai.whox.yield.options.monthly` | Options |
| `ai.whox.yield.optionspro.monthly` | Options Pro |

Prices in `WHoxTreasury.storekit` are local test fixtures. Production UI prices come only from StoreKit's localized `Product.displayPrice`; never copy fixture prices into app copy or backend merchandising.

## Local testing

The generated scheme references `Resources/Configuration/WHoxTreasury.storekit`. In Xcode, use **Debug > StoreKit > Manage Transactions** to test purchase, renewal, expiration, revocation, Ask to Buy, and restore behavior. The UI test launch hook for a completed restore is test-only and is not a production entitlement path.

## Production setup

1. Create the same four product IDs in one auto-renewable subscription group in App Store Connect.
2. Add approved localizations, prices, review screenshots, and subscription terms.
3. Configure App Store Server Notifications V2 to the backend endpoint documented by the server project.
4. Configure App Store Server API credentials in the server secret manager, never in the app bundle.
5. Test in Sandbox and TestFlight, including upgrade/downgrade, billing retry, grace period, refund, revocation, expiration, restore, and account-transfer cases.

The app accepts only StoreKit-verified transactions. New Paper purchases include StoreKit's `appAccountToken`, derived only from the authenticated canonical WHOX user UUID; Demo and signed-out sessions clear that association. It posts `{productID, transactionID, originalTransactionID, signedTransactionJWS}` to `POST /v1/subscription/sync` with a short-lived WHOX bearer token and an idempotency key. The backend must independently validate the signed transaction, verify the signed account token association, and return the authoritative entitled product IDs. If server reconciliation fails, paid server-run agents remain disabled even when the device has a locally verified transaction.

Do not enable subscription-dependent Live functionality until App Review, financial-entity, legal, broker-permission, and compliance gates are independently approved.
