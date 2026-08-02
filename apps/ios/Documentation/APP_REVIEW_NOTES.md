# App Review Notes draft

This file is a submission template, not evidence of approval. Replace every **PRODUCT OWNER REQUIRED** item before submitting.

## Purpose

Metis is an agent-assisted investing interface for viewing portfolio information, configuring bounded strategies, reviewing proposals, and controlling future agent activity. The submitted build keeps Live trading and autonomous execution disabled. It never asks the reviewer to enter brokerage credentials on iOS.

## Demo access

No username or password is required. On first launch, tap **Open App Review Demo**. The isolated local preview does not complete onboarding, create an authenticated user, infer product eligibility, or record legal consent. If onboarding was already completed, delete and reinstall the app to show that entry again. The Demo works offline and is clearly labeled as simulated data.

The Demo includes dashboard performance, equity and options positions, agents, proposals, orders and fills, a failed order, a risk-rejected proposal, an options expiration warning, risk settings, Pause All, subscriptions, and account deletion. Simulated actions cannot reach a brokerage or move money.

## Robinhood browser connection

Tapping **Connect to Robinhood** once creates or resumes a short-lived server pairing, requests the authorization transaction for that pairing, validates the returned destination in both the API and app, and opens the exact server-provided Robinhood OAuth URL in Apple's `ASWebAuthenticationSession`. This is a system authentication browser, not an embedded `WKWebView`. The app does not impose a desktop-only restriction. The public `https://agent.robinhood.com/mcp/trading` address is a Streamable HTTP MCP resource for registered clients, not a browser setup page, so the app never opens it directly as onboarding.

The same screen retains QR, Copy, and Share controls as optional ways to reopen the exact short-lived authorization in another trusted browser. Closing the browser does not discard that authorization; explicit cancel or regeneration invalidates it. The token-free return can contain only `verification_pending`, `canceled`, or `failed`; `verification_pending` is not Connected. The app polls until broker sync verifies the Agentic Account, required capabilities, and fresh snapshot and the server atomically reports `connected`. The callback reaches the WHOX API, but an isolated approved connector exchanges the code and keeps broker token bytes in its encrypted vault; neither iOS nor the ordinary API receives them. In the Demo, pairing completion is simulated. The local fixture uses code `SAFE-482K`; App Review does not need to run the local website. Non-Demo authorization remains unavailable until the Treasury Agent client registration, exact callback, and isolated production connector are configured and approved; public endpoint discovery is not evidence of that approval.

## Financial service and permissions

- Legal entity providing the service: **PRODUCT OWNER REQUIRED**
- Applicable registrations, licenses, exemptions, and jurisdictions: **PRODUCT OWNER REQUIRED**
- Robinhood authorization or written integration permission: **PRODUCT OWNER REQUIRED**
- Compliance contact and supporting documentation: **PRODUCT OWNER REQUIRED**

The release gates remain false until these items are established. Paper runtime additionally requires a persistent production backend, a registered Robinhood connector and callback, approved legal-document versions, and server-verifiable protected-action proof. Do not imply brokerage affiliation or authorization that has not been documented.

## Subscriptions

The app presents Equity, Equity Pro, Options, and Options Pro monthly subscriptions using localized StoreKit product data. Product identifiers and setup instructions are in `STOREKIT.md`. Purchases do not bypass suitability, risk, compliance, broker-capability, or production release gates.

## Data handling and deletion

The iOS app stores short-lived WHOX session credentials in the Keychain and does not store broker OAuth tokens. Access tokens are rotated through the WHOX server. Sensitive actions use device-owner authentication, but local biometric success is not treated as server proof: protected Paper approval fails closed until a production App Attest/DeviceCheck or equivalent nonce-bound provider is connected. The status widget marks financial content privacy-sensitive.

Detailed notification previews default off and quiet hours are optional. Paper builds save those fields through the canonical settings service and register APNs tokens only for the authenticated device and configured sandbox/production environment. Permission removal, sign-out, and account deletion invoke token unregistration. This build does not expose per-category notification filters or Critical Alerts because no corresponding server setting/client filter or Apple Critical Alerts entitlement is active.

Account deletion is available at **Settings > Delete account** and requires typing `DELETE` plus device authentication. The production backend must delete or schedule deletion of server-side account data according to the published retention policy.

- Privacy policy URL and effective version: **PRODUCT OWNER REQUIRED**
- Terms URL and effective version: **PRODUCT OWNER REQUIRED**
- Data retention and deletion SLA: **PRODUCT OWNER REQUIRED**

## Review contact

- Name: **PRODUCT OWNER REQUIRED**
- Email: **PRODUCT OWNER REQUIRED**
- Phone: **PRODUCT OWNER REQUIRED**
- Review availability/time zone: **PRODUCT OWNER REQUIRED**
