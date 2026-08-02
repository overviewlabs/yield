# App Store Connect product setup

This procedure begins only after the legal entity, Paid Applications Agreement, tax/banking, financial-services eligibility, pricing, customer-support contact, and counsel-approved subscription language are confirmed.

1. Create one subscription group and the approved monthly/annual products; use identifiers matching backend plan configuration exactly.
2. Add localized display names/descriptions that state strategy/access features without “better trades,” returns, win rates, or broker-permission claims.
3. Configure price tiers from the approved commercial decision; never copy suggested development prices without review.
4. Supply review screenshots, terms/privacy URLs, and Review Notes. Map upgrade/downgrade levels deliberately and test effective dates.
5. Configure App Store Server Notifications V2 endpoints separately for sandbox and production, verify signed payloads, deduplicate notification IDs, and reconcile transaction history.
6. Create Sandbox testers for purchase, renewal, billing retry, grace, refund/revocation, upgrade/downgrade, restore, and family/account edge cases.

Before submission, compare App Store product metadata, StoreKit display, backend entitlements, legal terms, App Privacy answers, and review notes. `APP_STORE_FINANCIAL_ENTITY_APPROVED` and legal/advisory gates stay false until named approvers record evidence. Product approval cannot activate trading.
