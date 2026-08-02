# Security and accessibility notes

## Security invariants

- Robinhood setup may be displayed through `ASWebAuthenticationSession`, but Robinhood credentials stay in the system authentication surface. The callback reaches the WHOX API; after a tenant-bound cleanup tombstone commits, an isolated approved connector exchanges the code into a provisional encrypted-vault transaction. Provider confirmation must precede broker hydration. iOS and the ordinary API receive neither token bytes nor Robinhood credentials.
- WHOX access and refresh material uses Keychain items restricted to this device.
- Sign in with Apple identity tokens are exchanged with the backend; the app never treats an unverified local identity as a production session.
- StoreKit verification is necessary but not sufficient for server-agent access. Backend JWS verification and acknowledgment are authoritative.
- Pairing is server-created, expires, rate-limits status polling, and uses idempotency keys for mutations.
- Mobile authorization accepts only an HTTPS `robinhood.com` or boundary-safe subdomain URL, the registered `metis` callback scheme, an exact return path, a matching pairing ID, and a token-free result. Unknown, duplicate, sensitive, fragmented, or user-info callback fields fail closed.
- Closing the system authentication browser retains the exact short-lived authorization for retry. Explicit cancel or regeneration invokes the authenticated invalidation boundary; a reset that cannot be confirmed causes the pairing to be canceled and replaced.
- Disconnect and reconnect preparation disable local execution authority first but report success only after provider revocation acknowledgment. An unknown outcome remains in durable recovery, preserves the current local presentation, and blocks replacement authorization.
- The production design requires a nonce-bound App Attest assertion verified by the server; DeviceCheck may inform risk but is not equivalent proof. No production cryptographic provider/verifier is composed in this repository, so protected Paper actions remain fail-closed.
- Proposal approval, resuming agents, broker disconnect/reconnect, risk-policy relaxation, and account deletion use device-owner authentication plus exact-context server verification; local authentication alone grants no server authority.
- Live, autonomous, options-live, financial-entity, legal, compliance, and broker-approval gates default to false.
- Pause All completes on the server before local UI state changes and does not liquidate positions.
- App Intents only navigate to protected screens; they do not trade, approve, pause, resume, or delete.

Production security review must cover certificate and API-domain configuration, token rotation and revocation, server authorization, App Attest replay prevention, audit retention, log redaction, incident response, and deletion propagation.

## Accessibility acceptance checks

- Test all screens through accessibility XXXL Dynamic Type in portrait and landscape.
- Test VoiceOver reading order, actionable labels, values, traits, modal focus, and error announcements.
- Verify status and risk states remain understandable without color.
- Verify Reduce Motion disables optional chart animation and transitions remain comprehensible.
- Verify charts expose text summaries and numeric values use locale-aware formatting.
- Verify controls meet minimum touch targets and keyboard/focus navigation on iPad.
- Verify light/dark appearance, increased contrast, bold text, button shapes, and Reduce Transparency.
- Verify the widget redacts privacy-sensitive values on the Lock Screen.

The UI suite exercises five-tab navigation, Demo entry, large Dynamic Type with dark appearance, reduced motion, offline recovery, protected Pause All, proposal review, biometric failure, StoreKit restore messaging, and exact account-deletion confirmation. Manual VoiceOver and device testing remain required before submission.
