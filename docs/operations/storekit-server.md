# StoreKit server verification and notifications

WHOX uses Apple's official `@apple/app-store-server-library` for StoreKit 2 signed-transaction verification and App Store Server Notifications V2. The dependency is pinned; only the latest major receives Apple's security updates, so upgrades require an explicit verification-suite and schema review.

Apple's verifier requires DER-encoded Apple root certificates, the exact app bundle identifier, the target environment, and the numeric App Apple ID for Production. Download the current roots from [Apple PKI](https://www.apple.com/certificateauthority/) and provide their PEM bundle through the deployment secret channel; the runtime converts them to DER. Do not substitute the host trust store or an unreviewed certificate. Certificate expiration and OCSP checks are always enabled and a failure blocks entitlement mutation. See Apple's [official Node library](https://github.com/apple/app-store-server-library-node).

## Required Paper runtime configuration

| Variable | Requirement |
|---|---|
| `APPLE_ROOT_CA_BUNDLE` | One or more current, self-signed Apple root CA certificates in PEM form; secret-managed multiline value. |
| `APPLE_BUNDLE_ID` | Exact approved app bundle identifier, currently `ai.whox.yield`. |
| `APPLE_APP_ID` | Positive numeric App Apple ID; required whenever Production verification is enabled. |
| `STOREKIT_ENVIRONMENTS` | Exact `sandbox`, `production`, or `sandbox,production`. |
| `APP_STORE_DATABASE_URL` | Dedicated login granted only `whox_app_store_notifications`; must differ from the tenant API credential. |

Demo does not read these variables and continues to use local StoreKit fixtures. Paper refuses startup when its StoreKit verification or durable notification boundary is unconfigured. Live trading gates remain independent and false; a verified subscription never grants brokerage permission or enables execution.

## App Store Connect

Configure App Store Server Notifications V2 URLs independently:

- `POST https://<paper-api>/v1/storekit/notifications/sandbox`
- `POST https://<production-api>/v1/storekit/notifications/production`

The public ingress must use TLS 1.2 or later. Apple treats HTTP 200–206 as successful processing and retries unsuccessful 4xx/5xx responses, so WHOX returns success only after signature verification and a durable database commit. Use Apple's test-notification API before enabling Production. See [Enabling App Store Server Notifications](https://developer.apple.com/documentation/appstoreservernotifications/enabling-app-store-server-notifications) and [App Store Server Notifications V2](https://developer.apple.com/documentation/appstoreservernotifications/app-store-server-notifications-v2).

## Processing invariants

1. Verify the outer `signedPayload` using the exact environment's Apple certificate chain, bundle ID, and App Apple ID.
2. Independently verify every nested `signedTransactionInfo` and `signedRenewalInfo` JWS and require their environment, original transaction ID, and app-account token bindings to agree.
3. Resolve the tenant only from the Apple-signed `appAccountToken` UUID or a previously bound original transaction. The iOS purchase path supplies the authenticated WHOX user UUID as `Product.PurchaseOption.appAccountToken`.
4. Serialize updates by original transaction, reject cross-account rebinding, and run subscription changes under forced tenant RLS.
5. Deduplicate by Apple's notification UUID and the SHA-256 digest of the signed payload. Store normalized metadata—not the raw JWS—and acknowledge an already-processed replay without repeating state changes.
6. Journal out-of-order verified events but never let an older signed event regress newer subscription state. An unresolved tenant is durably marked `unmatched` and returns 503 so Apple can retry after client reconciliation.

Operational alerts must cover verification retry failures, unresolved notifications, replay conflicts, unknown product IDs, and journal backlog. Recovery uses App Store Server API notification history; it does not fabricate entitlement state. Refund consumption-data responses and any App Store Server API credentials require a separately reviewed adapter.
