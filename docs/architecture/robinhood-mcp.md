# Robinhood Trading MCP integration

Last verified against official material: 2026-08-01.

The canonical resource enforced by this repository is `https://agent.robinhood.com/mcp/trading`; using it in production still requires Robinhood approval and a registered client. Robinhood’s support pages describe a dedicated Agentic account, read access across Robinhood account data, trading restricted to the Agentic account, and current long equities/options tools. Capabilities still must be discovered at runtime; this document is not a substitute for the live tool schemas. See [Agentic Trading overview](https://robinhood.com/us/en/support/articles/agentic-trading-overview/) and [Trading with your agent](https://robinhood.com/us/en/support/articles/trading-with-your-agent/).

## Authorization and transport

1. Connect with Streamable HTTP and negotiate an MCP protocol version.
2. On `401`, resolve Protected Resource Metadata from `WWW-Authenticate`; validate HTTPS, the canonical resource URI, and allowed authorization server(s).
3. Resolve authorization-server metadata. Require S256 PKCE support, authorization code flow, exact redirect URI, transaction-bound state, and issuer/mix-up defenses.
4. Include the MCP resource URI in authorization and token requests; keep tokens audience/resource restricted.
5. Exchange authorization codes server-side. Never put access tokens in URLs. Treat refresh tokens as optional; rotate/store them encrypted when issued.
6. Send bearer tokens only in the `Authorization` header to the exact MCP resource. Never pass them to another service, model, analytics, browser, or log.

The API implements a capability-gated in-app browser authorization surface. An authenticated start can operate only when an isolated connector is injected with a matching reviewed identity and authorization capability. It produces opaque authenticated state and S256 PKCE, exact-allowlists the discovered authorization destination, and never hardcodes the current provider authorization endpoint. The unauthenticated callback resolves tenant/session/pairing only from the opaque state and consumes verifier material once. Before any provider exchange call, it commits a tenant-bound exchange tombstone and delayed cleanup job. The isolated connector then exchanges the code into an auto-expiring provisional vault transaction. The API validates the server-only receipt, records a pending connection and `confirm_pending` authorization saga, and asks the connector to confirm durable vault persistence. Only a terminal confirmation acknowledgment may enqueue Agentic Account hydration. The callback returns to `metis://broker-connection/callback` with only `result` and `pairingId`; `verification_pending` is not Connected. The connection and pairing become `connected` only after the broker-sync worker verifies an Agentic Account, current capabilities, and a fresh portfolio snapshot in one transaction.

OAuth-only flows do not add an OIDC nonce; nonce is required only when reviewed metadata declares OIDC. If the in-app authentication session is closed before callback consumption, the app retains the exact short-lived authorization for browser retry; explicit cancellation invalidates it. Disconnect and reconnect preparation require fresh exact-context server step-up proof, immediately disable the local execution binding, and return `tokensRevoked: true` only after terminal provider revocation acknowledgment. An unknown outcome remains in durable recovery and blocks replacement authorization. Account closure revokes WHOX sessions/devices, disables the local connection, terminalizes active pairings and ordinary hydration work, and leaves provider-revocation recovery live. Logout alone revokes the WHOX session; it does not disconnect an established broker authorization.

The standard runtime injects no production connector and returns `503` without mutating the pairing until the approved Treasury Agent client metadata, callback, and isolated authorization connector are configured. This is a deployment/credential gate, not a client-device restriction.

The current MCP revision is `2026-07-28`; the client negotiates it first and uses explicitly supported legacy revisions only when the server rejects the modern probe and advertises a mutually supported fallback. Its authorization rules require protected-resource metadata discovery, Resource Indicators, Authorization headers, and resource/audience validation; access tokens must not appear in query strings. See the [current MCP specification](https://modelcontextprotocol.io/specification/2026-07-28) and [Streamable HTTP transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports). OAuth redirect matching, CSRF/state, S256 PKCE, issuer defenses, TLS, audience restriction, and avoidance of implicit/password flows follow [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html), [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728.html), [RFC 8414](https://www.rfc-editor.org/rfc/rfc8414.html), and [RFC 8707](https://www.rfc-editor.org/rfc/rfc8707.html).

## Capability and account binding

Call `tools/list`, record tool name/input schema/protocol version and a nonsecret set hash, then map known schemas to internal capabilities. Unknown, absent, or changed tools disable the dependent feature and alert operators; never create an unofficial fallback. Review/place/cancel tools are execution-worker only.

The implemented provider-neutral producer boundary, atomic snapshot rules, recurring queue contract, and fail-closed deployment posture are documented in [Broker account synchronization](../operations/broker-account-sync.md). No connector implementation is linked into the standard artifact.

Robinhood may expose multiple accounts to reads. Store the user-confirmed opaque Agentic Account identifier and masked suffix. Before every submission, load accounts again, verify the intended account still exists and is Agentic/tradable, and place only with the server-held binding. A model and client can never choose or override the account ID.

## Order boundary

Placement requires immutable proposal state, current subscription/strategy/approval mode, all release gates, user/platform risk, broker permission/capability, fresh account/quote state, correct binding, broker review, warning classification, current approval, idempotency, and a proposal lock. Record the broker ID and reconcile until a known terminal state. Unknown status blocks retries until reconciled; timeouts are not evidence of failure or fill.
