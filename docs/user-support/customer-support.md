# Customer-support guide

## Triage

Authenticate without requesting passwords, pairing codes, OAuth codes, broker tokens, full account numbers, SSNs, or screenshots containing them. Create a ticket with category, environment, safe timestamp/timezone, app version, correlation ID, user-described impact, and consent for diagnostics. Financial/account values stay masked by default; every lookup needs a specific reason.

| Issue | First action | Escalate when |
|---|---|---|
| Pairing expired | Generate a new code and reopen Robinhood sign-in | Repeated valid same-user claims fail/rate-limit anomaly |
| Connection expired | Use reconnect; explain that WHOX never requests or receives Robinhood credentials, while Robinhood may authenticate the user in its own approved surface | Provider revocation remains pending, refresh fails, or an open order is unknown |
| Proposal rejected | Show exact deterministic reason and recovery | Rule appears inconsistent with stored limits/state |
| Order pending/unknown | Do not guess; wait for reconciliation | Beyond SLO, duplicate concern, position mismatch |
| Risk halt | Explain new entries stopped, positions untouched | Systemic halt or reason absent |
| Subscription loss | Explain new-feature pause; records/monitoring remain | Existing position safety path is unavailable |
| Options restriction | Broker approval and capability are separate | UI contradicts broker capability |
| Deletion/export | Start authenticated workflow | Open order, legal hold, failed delivery/revocation |

Never provide individualized investment, tax, or legal advice; never promise performance/fill price/timing or blame a provider without evidence. Use approved scripts for risk and options disclosures. Security, complaint, unauthorized activity, vulnerable adult, self-harm/financial distress, regulator/media, and legal requests follow restricted escalation.

Close only after the user receives the outcome/next action and the ticket records safe evidence, owners, and related incident/order IDs. Redact attachments and follow retention policy.
