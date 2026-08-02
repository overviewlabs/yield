# Xcode setup

1. Install Xcode 26.1 or later and select it with `xcode-select` if multiple versions are installed.
2. Install XcodeGen 2.44 or later.
3. Run `make generate`, then open `WHOXTreasury.xcodeproj` and select the `WHOXTreasury` scheme.
4. For local simulator work, the checked-in StoreKit configuration is already attached to the Run action.
5. For device or archive builds, set the Apple Developer Team in `project.yml`, regenerate the project, and create matching App IDs for `ai.whox.treasury` and `ai.whox.treasury.widget`.

The signing account must provision:

- Sign in with Apple for the app target.
- App Attest/DeviceCheck for the app target.
- App Group `group.ai.whox.treasury` for both app and widget.
- Push Notifications and the APNs environment only after the production notification service is configured.

`Resources/WHoxTreasury.entitlements` resolves its App Attest environment from the generated build settings: Debug uses `development`, while Release uses `production`. A distribution archive still requires matching production provisioning and a backend that validates production attestations; otherwise protected Paper actions remain fail-closed.

Before an archive:

```sh
xcodegen generate --spec project.yml
xcrun swift-format lint --recursive --parallel --strict Sources Tests UITests Widget
make build
make test
```

Also verify the privacy manifest and App Store privacy answers against actual production telemetry and backend data processing. Generated build output belongs under `.build/` and is ignored by Git.
