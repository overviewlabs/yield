# APNs setup

1. Register Development and Production app identifiers/entitlements for the approved bundle ID and notification capability.
2. Create a narrowly scoped APNs signing key in the approved Apple team; store key ID/team ID/private key only in the managed secret system. Rotate under dual control.
3. Configure separate sandbox/production provider endpoints and topics. Never mix Paper/Live device-token stores.
4. Store device tokens per authenticated device/environment with timestamp and replacement history. Treat token changes as normal; remove invalid tokens after APNs response.
5. Deduplicate notification events and retry with bounded backoff. APNs delivery is not an order, reconciliation, expiration, or risk-control guarantee.

Lock-screen content is privacy-safe by default: event category and action, not balance, symbol, quantity, account, P&L, or detailed security data. Detailed previews require explicit user opt-in. Security/risk/time-sensitive categories bypass quiet hours only according to user choice and platform policy; summaries respect quiet hours.

Deep links carry opaque event identifiers and open the authenticated app, which authorizes and fetches current state. Never place tokens, order details, or PII in a push payload. Test permission denial, provisional/disabled state, token rotation, foreground/background delivery, duplicate/out-of-order messages, deep-link authorization, and sandbox/production isolation.

The notification worker requires `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY`, `APNS_TOPIC`, `APNS_ENVIRONMENTS`, and the same `DEVICE_TOKEN_ENCRYPTION_KEY` supplied to the API. It uses Apple token authentication over HTTP/2, caches provider JWTs for less than one hour, binds the configured topic, separates sandbox and production hosts, invalidates APNs-rejected device tokens, and refuses non-Demo startup when any required value is absent. The database stores only an HMAC digest and an AES-256-GCM envelope for each APNs token; the notification runtime role can decrypt the envelope but cannot access broker credentials.
