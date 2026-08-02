# Historical iOS QA evidence — 2026-08-01

This directory preserves a historical local verification baseline captured
before the latest plan-catalog, Settings, and UI-test changes. It is not proof
of the current source state. Generated Xcode `DerivedData` was removed after
that baseline was captured.

- Retained baseline suite: 78/78 passed (63 unit/HTTP contract tests and 15
  end-to-end UI tests on iPhone 17 Pro).
- Current source merged rerun: 80/80 passed (65 unit/HTTP contract tests and 15
  end-to-end UI tests on iPhone 17 Pro). Its generated `xcresult` is transient
  local build output and is not part of the retained historical bundle below.
- iPhone 17 Pro visual matrix: 3/3 passed; the final clean-branding Welcome,
  onboarding, five-tab, and Settings rerun passed 2/2.
- iPad Pro 13-inch (M5) visual matrix: 3/3 passed, including dark mode at
  Accessibility XXXL.
- Generic iOS Simulator Release builds succeeded with Paper mode,
  `https://api.whox.ai`, production APNs and App Attest environments, and all
  seven embedded Live release gates disabled.
- Strict Swift formatting passed.

`logs/` contains the historical command logs, `results/` contains the retained
`xcresult` bundles (including the 78-test baseline), and `visual-review/` contains
the exported screenshots and manifests used for human visual inspection. The
retained visual matrix uses deterministic Demo data; authenticated Paper pages
must be re-run against production-like staging adapters before submission, as
tracked in `docs/known-limitations.md`.
