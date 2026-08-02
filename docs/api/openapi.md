# OpenAPI contract

The canonical contract is the checked-in OpenAPI 3.1 document under `packages/contracts`. Serve it read-only in Development and generate typed clients in CI; do not hand-maintain a second route schema.

Contract requirements:

- Versioned `/v1` paths and explicit request/response schemas.
- Bearer/session authentication requirements and tenant-scoped authorization.
- `Idempotency-Key` on mutations such as approvals, submissions, cancellations, pairing creation, and notifications.
- Opaque cursor pagination, correlation IDs, rate-limit headers, and typed problem details.
- No broker tokens, full account numbers, internal stack traces, MCP internals, or database codes in any public schema.

Errors use the stable `error` envelope defined by `ApiError`: a safe `code`, user-facing `message`, `correlationId`, and optional sanitized `details`. Ordinary clients receive actionable copy while operators use the correlation ID. Validation occurs before business logic. An ID from a client never establishes ownership.

Pairing adds authenticated, rate-limited endpoints for code claim and CSRF bootstrap. OAuth start is an authenticated, idempotent POST returning only an allowlisted HTTPS authorization URL. The reserved in-app start additionally binds opaque authenticated state and S256 PKCE to the tenant, session, and pairing. Its unauthenticated callback derives that context only from the opaque state, persists a caller-generated pre-exchange cleanup tombstone, exchanges the code server-side, and redirects with only `result` and `pairingId`; `verification_pending` means the exchange is in confirmation/recovery and the app must keep polling sanitized status until Agentic MCP hydration verifies the account and changes the pairing to `connected`. Explicit cancellation invalidates unconsumed browser authorization material; closing the browser retains the same short-lived link for retry. Disconnect and reconnect preparation require exact-context step-up authentication, return `tokensRevoked: true` only after terminal provider acknowledgment, and block all replacement authorization while revocation is pending.

CI runs the full Redocly recommended ruleset, checks backward compatibility against the base-branch contract, generates TypeScript client types, compiles them, and runs authorization/idempotency tests. The browser callbacks intentionally have successful `302` responses rather than `2XX`: their only successful representations are browser redirects stripped of authorization artifacts, so Redocly's two `operation-2xx-response` warnings remain visible. The in-app endpoints stay fail closed until an approved connector with matching identity and browser authorization metadata is injected. Breaking changes require a new API version or an approved compatibility plan.
