# Broker, OAuth, or external-agent credential compromise

## Contain immediately

1. Engage the affected user/tenant pause; engage the global kill switch if scope is unknown or shared infrastructure is implicated.
2. Revoke the broker authorization through the supported revocation/disconnect boundary. Do not print or test the suspect token.
3. Disable affected refresh paths, sessions, client credentials, and KMS grants. Isolate the execution task role if needed.
4. Rotate envelope keys/client credentials using a staged procedure that preserves forensic copies under legal hold.
5. Search token fingerprints and access metadata—not token values—across audit, proxy, CI, analytics, crash, and support systems.

For a Hermes API-key exposure, immediately scale the agent orchestrator to zero,
revoke the API-server key at the Hermes host, and issue a new value directly into
the environment's `hermes-api-key` Secrets Manager secret. Never copy the new
value through chat, source control, a ticket, Terraform variables, or shell
history. Inspect the Hermes VPS's agent/tool/session history and outbound access;
its standard API-server profile may have provider-side terminal, file, web,
memory, skill, plugin, MCP, cron, or delegation capabilities. If any broker data
or credential could have entered that environment, treat the incident as global
broker authorization exposure and engage the global pause.

## Investigate and notify

Determine token scope/audience, issue and last-use time, resources accessed, orders attempted, source of exposure, and whether account binding held. Reconcile all broker activity from authoritative broker responses. Follow counsel-approved breach notification and regulatory timelines; notify the user to monitor/revoke access without exposing investigation details.

## Recover

Require fresh user authorization with new state and S256 PKCE, verify issuer/resource/audience, rotate refresh tokens when supported, validate the dedicated Agentic Account, and canary read-only access before trading. Do not resume until Security closes credential exposure and Operations closes reconciliation.

Hermes recovery additionally requires a dedicated stateless research profile,
independent confirmation that every provider-side tool and persistence surface
is disabled, a new API key injected only into the orchestrator task, and a
sanitized schema-validation canary containing no tenant or financial data.
