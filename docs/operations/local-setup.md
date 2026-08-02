# Local setup

## Requirements

- Node.js 22+ and npm 10+.
- Docker Engine/Desktop with Compose v2.
- Current stable public Xcode, XcodeGen 2.44+, and an iOS 26 simulator for iOS work.
- Optional: Terraform 1.8+, `promtool`, and an AWS sandbox for infrastructure validation.

## Install and verify

```sh
npm ci
npm run safety
npm run build
npm run typecheck:workspaces
npm run test:workspaces
```

Start the local data services and Demo web apps:

```sh
docker compose -f infrastructure/docker/compose.yml up --build
```

Pairing is at `http://localhost:4173/pair?pairing_code=SAFE-482K`; nginx serves the same client application for `/pair`, the UI removes the query from browser history, and the code is visibly labeled Demo. Admin is at `http://localhost:4174`; its simulated security-key login and roles mutate in-memory fixtures only. No brokerage login is needed or contacted.

To exercise the API and database, start PostgreSQL/Redis, apply migrations and row-level policies, then load the explicitly nonproduction Demo fixtures:

```sh
docker compose -f infrastructure/docker/compose.yml up -d postgres redis
DATABASE_URL=postgres://whox:whox@127.0.0.1:5432/whox_treasury npm run db:migrate
DATABASE_URL=postgres://whox:whox@127.0.0.1:5432/whox_treasury npm run db:seed
docker compose -f infrastructure/docker/compose.yml --profile backend up --build
```

To smoke-test the four Demo worker boundaries after migration, add the worker profile:

```sh
docker compose -f infrastructure/docker/compose.yml --profile workers up --build
```

The runtime port map is:

| Boundary | Loopback port |
|---|---:|
| API | 8080 |
| Agent orchestrator | 9101 |
| Execution worker | 9102 |
| Notification worker | 9103 |
| Market-data service | 9104 |
| Approved broker-sync service | 9105 |

The `workers` profile starts the four Demo workers on 9101–9104. Broker sync is the fifth, Paper-only worker boundary under the separate `approved-broker` profile on 9105; the checked-in standard artifact intentionally fails closed because it contains no reviewed connector composition, so a health port mapping is not evidence that broker sync is deployable.

The persistent Paper plan-cycle/Hermes/tenant-fan-out pipeline is implemented, but a healthy local boundary does not prove that its external dependencies are configured or approved. Paper Hermes requires the exact URL `https://treasury-bot.whox.ai/v1`, exact model `treasury-bot`, an orchestrator-only managed and rotated key, and exact `HERMES_RESEARCH_PROFILE_TOOLS_DISABLED=true` attestation after source-profile verification. An exposed key is compromised: revoke and replace it without printing, copying, or reusing the value. API-mode browser pairing requires an authenticated WHOX session owned by the same user as the pairing; deployed use therefore also requires configured Sign in with Apple/session infrastructure. The iPhone initiates the server-bound authorization in `ASWebAuthenticationSession` and tracks canonical status. QR, Copy, and Share are optional ways to reopen the same short-lived authorization in another trusted browser. The mock pairing provider above is the immediately usable local review path.

Never reuse the local database password, signing secret, pairing pepper, demo identities, or mock providers in a deployed environment. Paper/Live UIs reject mock providers. Keep the seven live gates false.

## Common recovery

- Port conflict: override `POSTGRES_PORT`, `REDIS_PORT`, `API_PORT`, `CONNECTION_WEB_PORT`, `ADMIN_WEB_PORT`, or the five worker `*_HEALTH_PORT` values in an untracked shell environment.
- Stale local data: stop Compose, review the exact named volumes, then remove only the explicit local project volumes if the test data is disposable.
- Pairing expired: regenerate it; never lengthen a production session to avoid fixing clock or delivery issues.
- Raw stack trace or secret in output: stop, treat the secret as compromised, revoke and replace it without repeating the value, file a security issue, and add a redaction regression test.
