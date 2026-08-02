# Xcode setup

1. Install the current stable public Xcode release that supports the iOS 26 SDK; do not use a beta-only toolchain for release builds.
2. Install XcodeGen 2.44 or newer, then generate the project:

   ```sh
   cd apps/ios
   xcodegen generate
   open WHOXTreasury.xcodeproj
   ```

3. Set the development team locally. Do not commit personal signing identifiers or private keys.
4. Select an iOS 26 simulator and the `WHoxTreasury.storekit` scheme configuration.
5. Keep `Resources/Configuration/ReleaseGates.json` false and the legal fixture marked nonproduction.
6. For Sign in with Apple/APNs/App Attest, create separate Development identifiers and use managed CI secrets. Production identifiers require the approved legal entity and release review.

Run unit/UI tests from Xcode or:

```sh
xcodebuild -project apps/ios/WHOXTreasury.xcodeproj -scheme WHOXTreasury -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
```

Simulator names vary by installed runtime. Face ID, push, StoreKit interruption, offline, large Dynamic Type, dark mode, and Reduce Motion cases must be run before submission. The StoreKit fixture is not proof that App Store products exist.
