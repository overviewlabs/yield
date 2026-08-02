# Browser pairing

WHOX treats Robinhood's generated agent authorization URL as a browser-capable sign-in flow. The iOS app starts and tracks the transaction in Apple's secure authentication browser; it does not impose a desktop-only restriction. Robinhood remains responsible for the pages, authentication requirements, and account approval presented at that URL.

Pairing bridges an authenticated iOS user to broker onboarding without moving broker credentials through iOS or the connector UI.

## One-tap mobile initiation

**Connect to Robinhood** is one user action, but it does not turn the Robinhood Trading MCP endpoint into a browser destination:

1. The authenticated app creates or resumes a short-lived pairing and asks the WHOX API to start the Robinhood authorization transaction for that exact pairing.
2. A reviewed server connector can perform MCP/OAuth discovery only after provider approval and registration, then returns the provider authorization destination. The API validates the complete HTTPS URL against the configured Robinhood authorization-server metadata and binds it to one-time state and S256 PKCE before returning it to iOS. `https://agent.robinhood.com/mcp/trading` is the Streamable HTTP MCP resource for an approved registered client; it is not a setup webpage and is never opened as the in-app browser destination.
3. iOS independently checks the pairing ID, expiry, exact return route, Robinhood host, URL size and structure, and absence of credential/token-like values. It then opens the server-provided authorization URL with `ASWebAuthenticationSession`, never `WKWebView`.
4. Robinhood returns the authorization response to the WHOX server. The server verifies one-time state, issuer when advertised, redirect URI, and PKCE, then commits a tenant-bound exchange tombstone and delayed cleanup job before any provider exchange call.
5. The isolated connector exchanges the one-time code into an auto-expiring provisional vault transaction. The API validates its server-only receipt, records a pending connection and `confirm_pending` saga, consumes the pairing, and does not enqueue hydration yet.
6. The API or broker-sync worker asks the connector to confirm durable vault persistence. Only terminal provider acknowledgment may mark the saga confirmed and enqueue hydration. A timeout remains an unknown outcome in durable recovery; an expired or invalid binding enters provider revocation instead of being accepted.
7. The app receives only `result` and `pairingId`; the result can be only `verification_pending`, `canceled`, or `failed`. `verification_pending` is not Connected. iOS re-fetches canonical pairing status and shows Connected only after broker sync verifies the confirmed authorization, Agentic Account, required capabilities, and a fresh snapshot for the same user, creator session, and pairing.

The same screen keeps the still-valid authorization visible with QR, Copy, and Share controls as optional recovery methods. Closing the system browser does not discard the generated authorization: the user may reopen it or continue in another trusted browser. An explicit cancel or regeneration invalidates the old transaction instead of reusing uncertain OAuth state.

This browser initiation boundary is implemented but fails closed outside Demo until the Treasury Agent client registration, exact callback, and production connector are configured and approved. A public MCP URL or public OAuth metadata alone is not production authorization.

## Disconnect and reconnect

Disconnect and reconnect preparation require a fresh server-verified proof bound to the authenticated user, session, device, exact action, and `robinhood_mcp` resource. The server locks the user's authorization graph, disables local execution authority, persists `revoke_pending`, and invokes idempotent provider revocation through the isolated connector. It returns `tokensRevoked: true` only after terminal provider acknowledgment. An unknown outcome returns `BROKER_REVOCATION_PENDING`, remains in durable worker recovery, and blocks every replacement authorization; iOS keeps its current local connection presentation until the server confirms success.

## Session design

- Generate at least 128 bits of cryptographic entropy server-side; the displayed eight-character code is a lookup handle protected by attempt limits, not the sole authorization secret.
- Store only a keyed digest of the human code. Bind pairing ID to WHOX user, intended environment, creation/expiry, and one-time status.
- Ten-minute default pairing expiry, with each OAuth authorization state capped at five minutes; both are single use, invalidate immediately on success/cancel, and cannot be extended. Regeneration creates new entropy and invalidates the old session.
- Accept codes only after the browser user authenticates as the same WHOX identity. Compare ownership server-side with constant-time digest comparison.
- Rate-limit by pairing, account, session, IP risk, and global anomaly signals without logging the code.

## Browser flow

1. The connector removes `pairing_code` from browser history immediately and keeps it only in memory.
2. `GET /v1/auth/csrf` creates a session-bound CSRF token. Cookie-authenticated mutations require exact `X-CSRF-Token`, SameSite/Secure/HttpOnly session cookies, origin checks, and rate limits.
3. `POST /pairings/claim` returns sanitized pairing metadata. `POST /oauth/start` returns only a validated HTTPS authorization URL; the UI allows only the configured API origin or discovered authorization-server allowlist. Plain HTTP is accepted only for an explicitly allowlisted loopback origin in Demo mode and is rejected in Paper/Live.
4. OAuth uses exact redirect URI, S256 PKCE, transaction-bound state, and issuer checks. A nonce is generated and validated only if the authorization server returns an OpenID Connect ID token. Any non-Demo server callback must follow the tombstone, provisional receipt, confirmation saga, and hydration sequence above; callback receipt alone never binds a verified account.
5. Callback redirect contains only `result` and opaque `pairingId`; the UI re-fetches status. Tokens and OAuth codes never appear in UI state, analytics, URLs, local/session storage, crash reports, or logs.

The Demo provider accepts only `SAFE-482K`, remains labeled Demo, keeps state in memory, and never performs a network broker request. Paper/Live builds fail closed if the mock provider is selected. The API provider requires an existing authenticated WHOX browser session belonging to the pairing owner; the page accurately states that it does not initiate Sign in with Apple. Cancel/reset sends the CSRF-protected server `DELETE` before clearing local state. Deployed use therefore depends on configured Sign in with Apple/session infrastructure. The local mock is the immediately usable review path.

Security tests cover code brute force/reuse/expiry, cross-user claim, CSRF/replay, state mismatch, redirect mismatch, callback replay, code/token redaction, rate limiting, concurrent claim/complete races, pre-exchange timeout recovery, confirmation deadlines, revocation unknown outcomes, and replacement blocking until terminal acknowledgment.
