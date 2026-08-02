# Local containers

The default Compose project runs PostgreSQL, Redis, the Demo desktop connector, and the Demo administrative console. It does not contact Robinhood and all seven live release flags remain false.

```sh
docker compose -f infrastructure/docker/compose.yml up --build
```

Open `http://localhost:4173/pair?pairing_code=SAFE-482K` for pairing and `http://localhost:4174` for the administrative console. Add `--profile backend` to start the API, or `--profile workers` to start the agent orchestrator, execution worker, notification worker, and market-data service. Their loopback-only health endpoints are on ports 8080 and 9101–9104 respectively. Run the database migrations before starting the persistent worker profile.

The database password default is intentionally local-only. Override it in an untracked environment file for shared development. Production uses managed PostgreSQL, Redis, queues, KMS, and Secrets Manager; this Compose topology is not a production deployment.

All build stages use digest-pinned base images. The npm workspaces install from the root lockfile with `npm ci`; the service runtime prunes development dependencies before copying the non-root production tree. Dependabot tracks both npm and Docker references.

The web images run as non-root users with read-only filesystems, restrictive security headers, disabled frame embedding, and no source maps. `API_CONNECT_SRC` generates the exact CSP API origin at container start; do not use a wildcard. Paper and Live pairing builds require the API provider and an HTTPS API origin. Mock pairing/admin modes fail closed outside Demo, and the admin `oidc` selection also fails closed until token exchange, MFA/device enforcement, server roles, API persistence, and durable auditing are implemented. TLS/HSTS and HTTP-to-HTTPS upgrade are enforced at the production edge, not in this HTTP-only local container.
