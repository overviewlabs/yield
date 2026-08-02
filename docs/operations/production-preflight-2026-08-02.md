# Production preflight evidence — 2026-08-02

This report records observed evidence from the `Metis` workspace and the
current WHOX host. It contains no credentials. It is not an authorization to
enable Live trading, submit an infrastructure apply, change DNS, or place an
order.

## 1. Release decision

- **Demo:** launched on loopback and healthy.
- **Paper production:** **NO-GO** until the blockers in section 12 are resolved.
- **Live:** **NO-GO**. The runtime deliberately rejects Live startup and all
  seven checked-in Live gates remain false.
- No brokerage order, funding action, OAuth authorization, production database
  migration, Terraform apply, DNS mutation, or certificate mutation was made.

## 2. Files and infrastructure changed

- `infrastructure/docker/compose.yml`: the connection UI now receives
  `BUILD_API_BASE_URL` from the selected Compose API port. This prevents the UI
  from silently targeting a different service when port 8080 is occupied.
- `/etc/caddy/Caddyfile`: the Treasury Bot host permits only health, model, and
  Chat Completions routes; other Hermes management routes return 404.
- `/etc/systemd/system/hermes-gateway-treasury-bot.service.d/hardening.conf`:
  no-new-privileges, empty capability sets, private devices/temp/mounts,
  kernel/control-group protections, a strict read-only filesystem outside the
  bot profile, restricted address families, and umask 0077.
- The previous Treasury Bot state was quarantined under
  `/WHOX OS/.hermes/quarantine/treasury-bot-compromised-20260802`.

## 3. Source and image identity

- The repository has an unborn `main` branch: there is no Git commit to attest,
  and every source file is currently untracked. A reviewed initial commit is a
  release blocker.
- Local Linux/aarch64 image IDs:
  - API: `sha256:da7895ec7751f7ef90eff1f438eb56f29e6716ed45f857630aa94edc1f875cd6`
  - Orchestrator: `sha256:e15a1fe4bd871675438b7036b21603c4f700fe23ae96574006257fa4e1afbacd`
  - Execution: `sha256:824a9b03c4c28f04d9c2ee160005927de7306305a8c1fdf180fc0e7d4e2e91bd`
  - Notifications: `sha256:f7fe3d77b08db6ef42bb739bc7a4e5fa84d3fbe1ebf652e5a4b4a553d5da2c8c`
  - Market data: `sha256:a9e1fc9156a4112604b603a9169e513ec1bfb2ca94a9d419619f9032a9e80c36`
  - Connection UI: `sha256:80710563fe995975d396f4b7fbd6b46066685ade1b68bc387248443c311061fa`
  - Admin UI: `sha256:1560ced4a3a9f4193b974b5d20e82ae4215ede3802aa58c68482d1bb66690453`
- These are local image IDs, not registry-pushed multi-architecture release
  digests. No container vulnerability scanner was installed; registry signing,
  SBOM publication, and independent CVE scanning remain required.

## 4. Terraform plan/apply

- Paper and Live roots passed `terraform fmt -check`, `init -backend=false`, and
  `validate` with Terraform 1.15.8 and signed AWS provider 6.57.1.
- No backend configuration, environment tfvars, cloud identity, or state was
  present. Consequently, no trustworthy plan exists and no apply was run.
- Paper and Live remain separate configurations; checked-in capacity/bootstrap
  gates keep execution paths at zero until secrets and approvals exist.

## 5. Database

- A disposable local PostgreSQL 17 database was recreated from scratch.
- Migrations 001–019, policies 001–012, and Demo seed 001 applied successfully.
- The clean canary queue is empty. The database is local Demo state only; it is
  not a production migration or backup/restore proof.

## 6. External connectors

- The official Robinhood protected-resource metadata endpoint was reachable and
  identified `https://agent.robinhood.com/mcp/trading` as its resource.
- No Robinhood client registration, approval, browser authorization, token,
  credential vault, or broker-sync adapter was available. The broker-sync
  Compose profile was not started and remains intentionally fail-closed.
- No production market-data provider or token was available. Demo uses only the
  deterministic `whox-demo-fixture` provider.

## 7. Verification commands and results

- `npm ci`: passed; npm reported zero vulnerabilities.
- `npm run verify`: passed.
- PostgreSQL-backed workspace tests: 198 passed, 0 failed, 0 skipped.
- Load smoke: 6 scenarios, 3,340 operations, 0 errors; market-open p95 156.73 ms
  and connection p95 107.89 ms.
- `npm audit --omit=dev --audit-level=high`: zero vulnerabilities.
- OpenAPI lint/type generation: passed; two documented redirect-response
  warnings and no errors.
- Terraform formatting/initialization/validation: passed for Paper and Live.
- Docker Compose configuration: passed.
- Demo health checks: API, readiness, both web apps, and four worker boundaries
  all returned HTTP 200.
- Live image startup probe: exited 1 with `LIVE_RUNTIME_DISABLED` behavior.
- Paper image without required secrets: exited 1 (fail-closed).

## 8. Provider and device evidence

- Only unauthenticated Robinhood resource discovery was performed. The app now
  treats the generated agent authorization URL as browser-capable and does not
  impose a desktop-only restriction; provider sign-in was not exercised from
  this host.
- This host is Linux/aarch64 and has no Xcode or physical iPhone. Current iOS
  build, App Attest, APNs, StoreKit, universal-link/custom-scheme callback, and
  physical-device evidence could not be produced.

## 9. Treasury Bot isolation and key handling

- Public base URL: `https://treasury-bot.whox.ai/v1`
- Model: `treasury-bot`
- The previously exposed key was revoked and replaced without printing its
  value. The replacement file is mode 0600.
- Public authenticated canary: HTTP 200, expected response, zero tool calls.
  Unauthenticated Chat Completions: 401. Management/session routes: 404.
- All Hermes toolsets, skills, plugins, MCP servers, delegation, browser,
  terminal, file, code execution, memory capture, and user-profile memory are
  disabled for this profile.
- The new key is not delivered to the application: no approved managed secret
  store or deployed orchestrator exists. Copying it into source, chat, or a
  client app is prohibited.
- Hermes still maintains gateway/response bookkeeping databases. Therefore the
  stronger `HERMES_RESEARCH_PROFILE_TOOLS_DISABLED=true` production attestation
  must remain false until the project owner accepts or replaces that persistence
  and an independent control verifies research-only data handling.

## 10. Monitoring, backup, and rollback

- Monitoring dashboards/alerts and backup resources exist as configuration, but
  no deployed alert evidence, snapshot evidence, or restore drill was available.
- Demo rollback: stop the seven application containers; the isolated Demo data
  services may remain for inspection.
- Hermes rollback: remove the systemd drop-in and restore the quarantined profile
  only after a security review. Do not restore the revoked key.
- Infrastructure rollback is not applicable because no apply occurred.

## 11. Current runtime

- Demo API: `http://127.0.0.1:18080`
- Demo connection UI: `http://127.0.0.1:14173`
- Demo admin UI: `http://127.0.0.1:14174`
- Worker health: loopback ports 19101–19104
- `https://api.whox.ai` did not respond from this host, and
  `https://connect.whox.ai` did not have a working TLS site here. They were not
  changed because DNS/certificate mutation requires an approved target and plan.

## 12. Blocking gaps

1. Reviewed initial Git commit, protected repository, release tag, CI provenance,
   registry push, signing/SBOM, and independent image scanning.
2. Approved Paper AWS account/region, backend, tfvars, cloud identity, redacted
   Terraform plan, owner approval, and apply window.
3. Managed database/Redis/KMS/secrets, backup/restore drill, monitoring routes,
   alert receivers, and operational ownership.
4. Approved Robinhood connector/client, browser authorization, per-tenant
   encrypted credential vault, revocation path, and reconciliation evidence.
5. Approved production market-data provider and stale/degraded-data drills.
6. Sign in with Apple/session keys, production App Attest verifier, Apple IDs,
   APNs, StoreKit, legal/compliance approvals, admin OIDC, and physical-device QA.
7. A dedicated non-root Treasury Bot service identity, managed-secret delivery
   of the rotated key, and an accepted statelessness control. Do not enable its
   Terraform attestation before then. The current root-owned process has an
   empty capability set and the systemd sandbox documented above, but root is
   not an acceptable final production identity.
8. Correct DNS/TLS for `api.whox.ai`, `connect.whox.ai`, and the approved admin
   origin, after reviewing exact records and rollback.

## 13. Activation checklist

1. Establish and review the source commit; rerun all tests and supply-chain scans.
2. Resolve sections 12.2–12.8 and collect named approvals/evidence.
3. Generate a redacted Paper plan against the approved backend; review blast
   radius, backup, rollback, and cost before explicit apply approval.
4. Migrate Paper data and perform restore, failover, alert, stale-data, connector,
   App Attest, APNs, and physical-device drills.
5. Inject the rotated Hermes credential only from managed secrets to the
   orchestrator; independently verify the research boundary.
6. Start with observe-only Paper, then confirmation-required Paper canary. Keep
   Live and autonomous gates false.
7. Require a separate Live readiness review and explicit human authorization.
