# Broker account synchronization

Paper portfolio data is produced only by `broker-sync-service` through an explicitly injected, reviewed connector. The repository does not implement, guess, or dynamically load a Robinhood endpoint or tool schema. The standard worker artifact has no connector and exits with `APPROVED_BROKER_CONNECTOR_REQUIRED`; its infrastructure capacity is locked at zero.

## Authorization-to-snapshot sequence

The iOS **Connect to Robinhood** action creates or resumes the tenant-bound pairing and immediately opens the server-generated authorization destination with `ASWebAuthenticationSession`. The app validates the destination as HTTPS on a Robinhood-owned host, rejects credential-bearing URLs, and accepts only the fixed token-free WHOX callback. Closing the browser does not abort the authorization: the exact short-lived PKCE-bound destination remains available to reopen directly or through QR, Copy, and Share while iOS continues polling canonical server state. Explicit cancellation or regeneration invalidates that destination before creating another pairing.

1. Before any provider exchange call, the API generates an exchange transaction UUID and commits a tenant-bound `broker_authorization_exchange_attempts` tombstone plus a delayed cleanup job. The connector must make exchange and revocation idempotent by that identifier, so a timeout, process crash, or late exchange result remains recoverable without possessing the authorization code again.
2. The approved authorization service exchanges the one-time code inside its isolated boundary and stores any resulting token material as an unreadable, auto-expiring provisional vault transaction. OAuth codes, tokens, PKCE verifier material, transaction identifiers, and credential handles never enter a client response, ordinary log, analytics event, or queue payload other than the explicitly allowed tenant-scoped recovery identifier.
3. The API validates the server-only receipt against the exact injected connector identity, review reference, issuer, canonical HTTPS MCP resource, caller transaction UUID, opaque credential handle, and sanitized connection summary. One tenant transaction marks the exchange attempt completed, binds a pending connection, creates a `confirm_pending` authorization saga, consumes the pairing, and enqueues saga recovery. It does not enqueue hydration yet.
4. The API or broker-sync worker asks the isolated connector to confirm durable vault persistence. Only after that provider acknowledgment does a database transaction re-check the active account, originating session, exact immutable binding, and confirmation deadline; it then marks the saga `confirmed` and enqueues `hydrate_broker_account`. A timeout has an unknown outcome and remains in durable recovery. An expired or invalid binding transitions to provider revocation instead of being accepted.
5. The initial hydration payload contains only `connectionId`, `pairingId`, `authorizationSagaId`, `provider`, and `trigger`. Before calling the snapshot connector, the worker verifies the tenant-bound saga is confirmed, the credential binding is still usable, and the connection exactly matches the injected adapter, approval reference, issuer, resource, and protocol version.
6. The worker validates the connector response at runtime: exact identity, verified Agentic Account, fresh `get_accounts` and `get_portfolio` discovery, bounded canonical timestamps, finite portfolio values, unique positions, and JSON-only schemas/details. `review_equity_order` is optional for hydration; when absent, the discovered capabilities are preserved and trading is exposed as unavailable.
7. One tenant transaction deactivates superseded accounts, upserts the verified account and discovered capabilities, appends one Paper portfolio/position snapshot, advances `last_sync_at`, and changes the connection/pairing to `connected` only after every write succeeds. An immutable fingerprint receipt makes job/source replays idempotent. Any error rolls back the entire snapshot and leaves the prior sync time unchanged. Deterministic initial-binding/schema failures durably request provider revocation; transient failures retry until the bounded queue policy is exhausted.
8. A successful job schedules a secret-free recurring job in the next deterministic time bucket. Scheduled payloads add only `scheduleBucket`. Even if the provider repeats the same source timestamp, the bucket advances. Queue retry uses bounded exponential backoff; stale/dead-lettered work degrades readiness.

## Disconnect, reconnect, and crash recovery

Disconnect and reconnect preparation require a fresh server-verified proof bound to the authenticated user, session, device, exact action, and `robinhood_mcp` resource. The API locks the user authorization graph and locates the one active saga or pre-exchange tombstone. It immediately disables the local execution binding, records `revoke_pending`, and enqueues recovery, while the saga retains the opaque credential handle until the isolated connector acknowledges idempotent external revocation. The API returns `tokensRevoked: true` only after that terminal acknowledgment. A timeout returns `503 BROKER_REVOCATION_PENDING`; iOS preserves its current local connection state, the worker keeps retrying, and every replacement authorization remains blocked until the durable state is `revoked`.

The bounded janitor requeues stale confirmation, exchange-cleanup, and revocation work with tenant-bound payloads and `SKIP LOCKED`. Account closure revokes sessions/devices, disables the connection immediately, dead-letters ordinary hydration work, and leaves provider-revocation recovery live. Operators monitor `app.broker_authorization_lag_status()`; they must never clear a saga, vault handle, or tombstone manually to force a reconnect.

## Data-use gates

Dashboard and automated Paper consumers may use only a snapshot where:

- `environment` and `data_classification` are exactly `paper`;
- `valid_until` is still in the future;
- the account is active, verified, and marked Agentic;
- the Robinhood MCP connection is connected; and
- `last_sync_at` covers the snapshot source timestamp.

Demo rows remain `demo` with infinite fixture validity and are never relabeled. Existing non-Demo rows were backfilled with an already-expired one-microsecond validity window.

## Readiness and deployment

`/healthz` reports process/worker liveness. `/readyz` additionally requires storage readiness, all connected broker credentials to be bound, and every credential-bound connection to have a currently usable verified Paper snapshot. The standard Terraform artifact creates the task, least-privilege database secret, log group, and broker-vault IAM boundary but fixes desired count at zero. Enabling capacity requires a separately reviewed build that injects the approved connector in process and an accompanying infrastructure review; environment variables cannot name or load connector code.

Never work around an outage with scraping, a consumer Robinhood password, an unofficial API, a fabricated capability, or a Demo snapshot. Follow [Broker outage](broker-outage.md) and [Token compromise](token-compromise.md) procedures.
