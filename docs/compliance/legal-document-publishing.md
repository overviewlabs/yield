# Legal-document publishing procedure

No checked-in fixture is final legal language. Counsel owns approved text; Compliance owns version/status; Engineering owns faithful rendering, acceptance, gating, and auditability.

1. Counsel supplies immutable content, document type, jurisdiction/audience, effective time, superseded version, reacceptance rule, retention rule, accessibility review, and approval evidence.
2. Compliance hashes the canonical bytes, assigns a non-reused version, verifies referenced legal entity/contact/licenses, and records approvers. Engineering cannot mark its own draft approved.
3. Publish to staging, compare rendered text/hash on all supported sizes/themes/assistive technologies, test links/download/offline behavior, and verify no truncation.
4. Run acceptance/revocation/reacceptance tests. Record user identity, document/version/hash, timestamp, locale, device/session reference, and permitted IP metadata. Never infer consent from navigation.
5. Promote with a scheduled immutable status event. Live activation remains hidden until every required current document is approved and accepted.
6. A correction creates a new version. Never mutate accepted bytes. Emergency withdrawal blocks affected new activity and invokes compliance response.

Required types include Terms, Privacy, AI Agent Risk, Brokerage Connection, advisory agreement when applicable, Options Risk when applicable, electronic communications, subscription, performance presentation, and third-party AI/data processing. Jurisdiction/profile/strategy determines the required set server-side.
