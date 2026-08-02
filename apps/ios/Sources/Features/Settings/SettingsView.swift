import StoreKit
import SwiftUI
import UIKit

struct SettingsView: View {
  @Environment(AppSession.self) private var session
  @State private var exportItem: ExportItem?
  @State private var showingDelete = false
  @State private var showingPauseReview = false

  var body: some View {
    NavigationStack {
      List {
        modeHeader

        Section("Account") {
          NavigationLink {
            AccountProfileView()
          } label: {
            settingsLabel("Profile", value: session.profile.name, symbol: "person.crop.circle")
          }
          NavigationLink {
            InvestorProfileReviewView()
          } label: {
            settingsLabel(
              "Investor profile", value: session.profile.riskClassification,
              symbol: "person.text.rectangle")
          }
          NavigationLink {
            AccountModeSettingsView()
          } label: {
            settingsLabel("Account mode", value: session.mode.title, symbol: "switch.2")
          }
          Button {
            createExport()
          } label: {
            settingsLabel("Export data", value: nil, symbol: "square.and.arrow.up")
          }
          Button(role: .destructive) {
            showingDelete = true
          } label: {
            settingsLabel("Delete account", value: nil, symbol: "trash")
          }
        }

        Section("Robinhood Connection") {
          NavigationLink {
            ConnectionSettingsView()
          } label: {
            settingsLabel("Agentic Account", value: session.connection.status.title, symbol: "link")
          }
        }

        Section("Subscription") {
          NavigationLink {
            SubscriptionSettingsView()
          } label: {
            settingsLabel(
              "Current plan",
              value: session.mode == .demo ? "Demo access" : session.currentPlan.tier.title,
              symbol: "creditcard")
          }
        }

        Section("Agents") {
          NavigationLink {
            ActiveAgentsSettingsView()
          } label: {
            settingsLabel(
              "Active agents", value: String(session.activeAgents.count),
              symbol: "point.3.connected.trianglepath.dotted")
          }
          if let activeAgent = session.activeAgents.first {
            settingsLabel(
              "Default approval", value: activeAgent.operatingMode.title,
              symbol: "checkmark.shield")
            Button(role: session.accountIsPaused ? nil : .destructive) {
              showingPauseReview = true
            } label: {
              settingsLabel(
                session.accountIsPaused ? "Resume all agents" : "Pause all agents",
                value: session.accountIsPaused ? "Paused" : nil,
                symbol: session.accountIsPaused ? "play.circle" : "pause.circle")
            }
          }
        }

        Section("Risk Controls") {
          NavigationLink {
            RiskControlsView()
          } label: {
            settingsLabel(
              "Global limits", value: session.dashboard.riskState.title,
              symbol: "shield.lefthalf.filled")
          }
        }

        Section("Notifications") {
          NavigationLink {
            NotificationSettingsView()
          } label: {
            settingsLabel("Alerts and summaries", value: nil, symbol: "bell")
          }
        }

        Section("Security") {
          NavigationLink {
            SecuritySettingsView()
          } label: {
            settingsLabel(
              "Device and sessions",
              value: session.preferences.faceIDEnabled ? "Protected" : "Optional",
              symbol: "lock.shield")
          }
        }

        Section("Appearance") {
          NavigationLink {
            AppearanceSettingsView()
          } label: {
            settingsLabel(
              "Display and privacy", value: session.preferences.appearance.title,
              symbol: "circle.lefthalf.filled")
          }
        }

        Section("Data and Privacy") {
          NavigationLink {
            DataPrivacyView()
          } label: {
            settingsLabel("Privacy center", value: nil, symbol: "hand.raised")
          }
        }

        Section("Legal") {
          NavigationLink {
            LegalSettingsView()
          } label: {
            settingsLabel(
              "Documents",
              value: legalDocumentStatus,
              symbol: "doc.text")
          }
        }

        Section("Help") {
          NavigationLink {
            HelpSupportView()
          } label: {
            settingsLabel("Help and support", value: nil, symbol: "questionmark.circle")
          }
          Link(destination: URL(string: "https://status.whox.ai")!) {
            settingsLabel("System status", value: nil, symbol: "waveform.path.ecg")
          }
          LabeledContent("App version", value: appVersion)
        }
      }
      .navigationTitle("Settings")
      .sheet(item: $exportItem) { item in ExportShareView(item: item) }
      .sheet(isPresented: $showingDelete) { AccountDeletionView() }
      .sheet(isPresented: $showingPauseReview) { NavigationStack { PauseAllReviewView() } }
    }
  }

  private var modeHeader: some View {
    Section {
      HStack(spacing: 12) {
        BrandArtworkView(size: 48)
        VStack(alignment: .leading, spacing: 3) {
          Text(session.profile.name).font(.headline)
          if !session.profile.email.isEmpty {
            Text(session.profile.email).font(.caption).foregroundStyle(.secondary)
          }
        }
        Spacer()
        ModeBadge(mode: session.mode)
      }
    } footer: {
      Text(session.mode.explanation)
    }
  }

  private func settingsLabel(_ title: String, value: String?, symbol: String) -> some View {
    HStack {
      Label(title, systemImage: symbol).foregroundStyle(.primary)
      Spacer()
      if let value {
        Text(value).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.trailing)
      }
    }
  }

  private func createExport() {
    do { exportItem = ExportItem(url: try session.exportDemoData()) } catch {
      session.alertMessage =
        "The data export could not be created. Try again after reopening the app."
    }
  }

  private var appVersion: String {
    let version =
      Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
    let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "1"
    return "\(version) (\(build))"
  }

  private var legalDocumentStatus: String {
    if session.mode == .demo { return "\(session.legalDocuments.count) fixtures" }
    return session.legalDocuments.isEmpty
      ? "Unavailable" : "\(session.legalDocuments.count) current"
  }
}

private struct ExportItem: Identifiable {
  let id = UUID()
  let url: URL
}

private struct ExportShareView: View {
  @Environment(AppSession.self) private var session
  @Environment(\.dismiss) private var dismiss
  let item: ExportItem
  var body: some View {
    NavigationStack {
      VStack(spacing: 20) {
        Image(systemName: "doc.zipper").font(.system(size: 56)).foregroundStyle(.tint)
        Text("\(session.mode.title) data export ready").font(.title2.bold())
        Text(
          "The JSON file includes this \(session.mode.title) profile, positions, and audit timeline. It contains no brokerage credential."
        )
        .multilineTextAlignment(.center).foregroundStyle(.secondary)
        ShareLink(item: item.url) { Label("Share Export", systemImage: "square.and.arrow.up") }
          .buttonStyle(.borderedProminent).controlSize(.large)
      }
      .padding(30)
      .navigationTitle("Export Data")
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
    }
    .presentationDetents([.medium])
  }
}

struct RiskControlsView: View {
  @Environment(AppSession.self) private var session
  @Environment(\.dismiss) private var dismiss
  @State private var policy = DemoFixtures.recommendedRiskPolicy
  @State private var excludedSymbols = ""
  @State private var excludedSectors = ""

  var body: some View {
    Form {
      Section {
        DisclosureNotice(
          title: "Hard platform caps",
          message:
            "You may tighten these limits. The app never allows a value above the shared platform maximum, and the server validates every proposal again.",
          symbol: "lock.shield", color: .orange)
      }
      Section("Account limits") {
        riskSlider(
          "Maximum allocation", value: $policy.maximumAllocationPercent, range: 1...80, step: 1
        ) { FinancialFormatters.percent($0) }
        riskSlider(
          "Maximum position", value: $policy.maximumPositionAmount, range: 100...25_000, step: 100
        ) { FinancialFormatters.currency($0) }
        riskSlider(
          "Maximum new order", value: $policy.maximumOrderAmount, range: 100...10_000, step: 100
        ) { FinancialFormatters.currency($0) }
        riskSlider("Daily loss halt", value: $policy.dailyLossLimit, range: 50...5_000, step: 50) {
          FinancialFormatters.currency($0)
        }
        riskSlider("Drawdown halt", value: $policy.drawdownHaltPercent, range: 3...20, step: 1) {
          FinancialFormatters.percent($0)
        }
        riskSlider(
          "Buying-power reserve", value: $policy.buyingPowerReservePercent, range: 10...90, step: 1
        ) { FinancialFormatters.percent($0) }
        Stepper(
          "Maximum positions: \(policy.maximumPositions)", value: $policy.maximumPositions,
          in: 1...30)
      }
      Section("Exclusions and events") {
        TextField("Excluded symbols, comma separated", text: $excludedSymbols, axis: .vertical)
          .textInputAutocapitalization(.characters)
        TextField("Excluded sectors, comma separated", text: $excludedSectors, axis: .vertical)
        Toggle("Allow trading around verified earnings", isOn: $policy.allowEarningsTrading)
        Toggle("Allow fractional shares", isOn: $policy.allowFractionalShares)
        Toggle("Allow extended hours", isOn: $policy.allowExtendedHours)
      }
      Section("Options limits") {
        riskSlider(
          "Maximum defined loss", value: $policy.maximumOptionsLoss, range: 50...2_500, step: 50
        ) { FinancialFormatters.currency($0) }
        riskSlider(
          "Maximum options exposure", value: $policy.maximumOptionsExposurePercent, range: 1...20,
          step: 1
        ) { FinancialFormatters.percent($0) }
        Stepper(
          "Maximum contracts: \(policy.maximumContracts)", value: $policy.maximumContracts,
          in: 1...10)
        Stepper(
          "Minimum DTE: \(policy.minimumDaysToExpiration)", value: $policy.minimumDaysToExpiration,
          in: 14...90)
        Stepper(
          "Maximum DTE: \(policy.maximumDaysToExpiration)", value: $policy.maximumDaysToExpiration,
          in: policy.minimumDaysToExpiration...365)
        riskSlider(
          "Maximum bid-ask spread", value: $policy.maximumBidAskSpreadPercent, range: 0.5...10,
          step: 0.5
        ) { FinancialFormatters.percent($0) }
        Toggle("Covered calls", isOn: $policy.allowCoveredCalls)
        Toggle("Protective puts", isOn: $policy.allowProtectivePuts)
        Toggle("Defined-risk spreads", isOn: $policy.allowDefinedRiskSpreads)
        Toggle("Close-review before expiration", isOn: $policy.closeBeforeExpiration)
      }
      Section {
        Button("Reset to Recommended Defaults") {
          policy = DemoFixtures.recommendedRiskPolicy
          excludedSymbols = policy.excludedSymbols.joined(separator: ", ")
          excludedSectors = policy.excludedSectors.joined(separator: ", ")
        }
      }
    }
    .navigationTitle("Risk Controls")
    .navigationBarTitleDisplayMode(.inline)
    .onAppear {
      policy = session.riskPolicy
      excludedSymbols = policy.excludedSymbols.joined(separator: ", ")
      excludedSectors = policy.excludedSectors.joined(separator: ", ")
    }
    .toolbar {
      ToolbarItem(placement: .confirmationAction) {
        Button("Save") {
          policy.excludedSymbols = split(excludedSymbols).map { $0.uppercased() }
          policy.excludedSectors = split(excludedSectors)
          Task { if await session.saveRiskPolicy(policy) { dismiss() } }
        }
      }
    }
  }

  private func riskSlider(
    _ title: String, value: Binding<Double>, range: ClosedRange<Double>, step: Double,
    display: @escaping (Double) -> String
  ) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text(title)
        Spacer()
        Text(display(value.wrappedValue)).monospacedDigit().foregroundStyle(.secondary)
      }
      Slider(value: value, in: range, step: step)
    }
  }

  private func split(_ value: String) -> [String] {
    value.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter {
      !$0.isEmpty
    }
  }
}

struct PauseAllReviewView: View {
  @Environment(AppSession.self) private var session
  @Environment(\.dismiss) private var dismiss
  @State private var confirmed = false

  var body: some View {
    Form {
      Section {
        Label(
          session.accountIsPaused ? "All agents are paused" : "Pause all future agent activity",
          systemImage: session.accountIsPaused ? "pause.circle.fill" : "exclamationmark.shield"
        )
        .font(.title3.bold()).foregroundStyle(session.accountIsPaused ? .orange : .primary)
      }
      Section("What Pause All does") {
        Label("Stops new agent evaluations", systemImage: "checkmark")
        Label("Prevents new order submissions", systemImage: "checkmark")
        Label("Cancels queued, unsubmitted proposals", systemImage: "checkmark")
        Label("Leaves existing positions untouched", systemImage: "hand.raised")
        Label("Continues monitoring and reconciliation", systemImage: "eye")
      }
      if !session.accountIsPaused {
        Section {
          Toggle("I understand this does not liquidate positions", isOn: $confirmed)
            .accessibilityIdentifier("pauseAllAcknowledgement")
        }
        Section {
          Button("Confirm Pause All", role: .destructive) {
            Task {
              await session.pauseAllAgents()
              if session.accountIsPaused { dismiss() }
            }
          }
          .disabled(!confirmed)
          .frame(maxWidth: .infinity)
        }
      } else {
        Section {
          Button("Authenticate and Resume") {
            Task {
              await session.resumeAllAgents()
              if !session.accountIsPaused { dismiss() }
            }
          }
          .frame(maxWidth: .infinity)
        } footer: {
          Text("Resuming requires device authentication and does not submit an immediate trade.")
        }
      }
    }
    .navigationTitle("Pause All Review")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
  }
}

private struct AccountProfileView: View {
  @Environment(AppSession.self) private var session
  var body: some View {
    List {
      Section("Identity") {
        LabeledContent("Name", value: session.profile.name)
        LabeledContent("Email", value: session.profile.email)
        LabeledContent("Sign in method", value: session.profile.signInMethod)
        LabeledContent("Jurisdiction", value: session.profile.jurisdiction)
      }
      Section("Data classification") {
        Text(
          session.mode == .demo
            ? "This profile belongs to the clearly labeled App Review Demo account."
            : "This profile is tied to the authenticated WHOX account. Identity changes require server verification."
        )
      }
    }
    .navigationTitle("Account")
  }
}

private struct InvestorProfileReviewView: View {
  @Environment(AppSession.self) private var session
  var body: some View {
    List {
      Section("Classification") {
        LabeledContent("Internal profile", value: session.profile.riskClassification)
        Text(
          "This classification explains strategy eligibility inside Yield and is not brokerage options approval."
        )
      }
      Section("Current \(session.mode.title) answers") {
        LabeledContent("Objective", value: session.onboardingDraft.objective)
        LabeledContent("Holding period", value: session.onboardingDraft.holdingPeriod)
        LabeledContent("Experience", value: session.onboardingDraft.experience)
        LabeledContent(
          "Loss tolerance",
          value: FinancialFormatters.percent(session.onboardingDraft.lossTolerance))
        LabeledContent(
          "Depends on funds", value: session.onboardingDraft.dependsOnFunds ? "Yes" : "No")
      }
      Section("Reassessment") {
        Text(
          "A new classification is applied only after the complete questionnaire is submitted and the WHOX server confirms the scoring version."
        )
        .foregroundStyle(.secondary)
      }
    }
    .navigationTitle("Investor Profile")
  }
}

private struct AccountModeSettingsView: View {
  @Environment(AppSession.self) private var session
  var body: some View {
    List {
      Section("Signed runtime") {
        LabeledContent("Current mode", value: session.mode.title)
        Text(session.mode.explanation).foregroundStyle(.secondary)
      }
      Section("Availability") {
        Label(
          "Demo and Paper are separate signed app configurations", systemImage: "checkmark.seal")
        Label("Live trading is not enabled in this build", systemImage: "lock.fill")
          .foregroundStyle(.orange)
        Text(
          "Account data cannot be relabeled or switched between modes inside the app. Install the appropriate approved configuration instead."
        )
        .font(.caption).foregroundStyle(.secondary)
      }
    }
    .navigationTitle("Account Mode")
  }
}

private struct ConnectionSettingsView: View {
  @Environment(AppSession.self) private var session
  @State private var showingPairing = false
  @State private var showingDisconnect = false
  @State private var isPreparingReconnect = false

  var body: some View {
    List {
      Section("Connection") {
        ConnectionValueRow(label: "Status", value: session.connection.status.title)
        if let masked = session.connection.maskedAccount {
          ConnectionValueRow(label: "Account", value: masked)
        }
        if let type = session.connection.accountType {
          ConnectionValueRow(label: "Type", value: type)
        }
        if let sync = session.connection.lastSync {
          ConnectionValueRow(
            label: "Last successful sync", value: FinancialFormatters.timestamp(sync))
        }
        ConnectionValueRow(label: "Options", value: session.connection.optionsPermission)
      }
      Section("Capabilities") {
        if session.connection.capabilities.isEmpty {
          Text("No broker capabilities are available.").foregroundStyle(.secondary)
        }
        ForEach(session.connection.capabilities, id: \.self) {
          Label($0, systemImage: "checkmark.circle")
        }
      }
      Section {
        Button(
          session.connection.status == .connected ? "Reconnect Robinhood" : "Connect to Robinhood"
        ) {
          if [.connected, .expired, .error].contains(session.connection.status) {
            Task {
              isPreparingReconnect = true
              let ready = await session.prepareBrokerReconnect()
              isPreparingReconnect = false
              if ready { showingPairing = true }
            }
          } else {
            showingPairing = true
          }
        }
        .disabled(isPreparingReconnect)
        if session.connection.status == .connected {
          Button("Disconnect", role: .destructive) { showingDisconnect = true }
        }
      }
      Section("Disclosure") {
        Text(
          "Yield opens the server-provided Robinhood setup in Safari. After approval, the secure callback returns to Yield. No password, OAuth code, broker token, or MCP credential is returned to or stored by this app."
        )
      }
    }
    .navigationTitle("Robinhood Connection")
    .sheet(isPresented: $showingPairing) { BrokerPairingSheet() }
    .confirmationDialog(
      "Disconnect brokerage access?", isPresented: $showingDisconnect, titleVisibility: .visible
    ) {
      Button("Authenticate and Disconnect", role: .destructive) {
        Task { await session.disconnectBroker() }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(
        "Existing positions remain at the broker. Open orders require review before disconnection.")
    }
  }
}

private struct ConnectionValueRow: View {
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  let label: String
  let value: String

  var body: some View {
    Group {
      if dynamicTypeSize.isAccessibilitySize {
        VStack(alignment: .leading, spacing: 4) {
          Text(label).font(.subheadline).foregroundStyle(.secondary)
          Text(value).fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      } else {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
          Text(label)
          Spacer(minLength: 12)
          Text(value)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.trailing)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
    .accessibilityElement(children: .combine)
  }
}

private struct BrokerPairingSheet: View {
  @Environment(AppSession.self) private var session
  @Environment(\.dismiss) private var dismiss
  @State private var attemptedAutomaticAuthorization = false

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 18) {
          if session.pairingService.session != nil {
            DisclosureNotice(
              title: "Secure Robinhood handoff",
              message:
                "Treasury opens Apple’s system authentication browser using a short-lived URL supplied by WHOX. The app accepts only a token-free return and verifies connection status with the server.",
              symbol: "safari", color: .blue)
            Text(session.pairingService.statusMessage).multilineTextAlignment(.center)
              .foregroundStyle(.secondary)
            if session.pairingService.lifecycleStatus == .connected {
              Button("Use Connection") {
                session.adoptCompletedPairing()
                dismiss()
              }
              .buttonStyle(.borderedProminent).controlSize(.large)
            } else {
              Button("Connect Robinhood", systemImage: "safari") {
                Task {
                  await session.pairingService.connectInApp()
                  session.adoptCompletedPairing()
                }
              }
              .buttonStyle(.borderedProminent)
              .controlSize(.large)
              .disabled(session.pairingService.isAuthorizingInApp)
              if session.mode == .demo {
                Button("Complete Demo Pairing") {
                  Task {
                    await session.pairingService.completeDemo()
                    session.adoptCompletedPairing()
                  }
                }
                .buttonStyle(.borderedProminent)
              }
              Button("Check Status Now", systemImage: "arrow.clockwise") {
                Task {
                  await session.pairingService.pollNow()
                  session.adoptCompletedPairing()
                }
              }
              Button("Cancel Setup", role: .destructive) {
                Task { await session.pairingService.cancel() }
              }
            }
          } else {
            BrandArtworkView(size: 76)
            Text("Preparing Robinhood setup").font(.title2.bold())
            Text(
              "Treasury is requesting a short-lived setup session for Robinhood’s secure sign-in browser."
            ).multilineTextAlignment(.center).foregroundStyle(.secondary)
            if session.pairingService.lifecycleStatus == .failed {
              Button("Try Again") {
                Task {
                  await session.pairingService.connectInApp()
                  session.adoptCompletedPairing()
                }
              }
              .buttonStyle(.borderedProminent).controlSize(.large)
            } else {
              ProgressView().controlSize(.large)
            }
          }
        }
        .padding(24)
      }
      .navigationTitle("Broker Connection")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
    }
    .presentationDetents([.large])
    .interactiveDismissDisabled(session.pairingService.isAuthorizingInApp)
    .task {
      guard !attemptedAutomaticAuthorization else { return }
      attemptedAutomaticAuthorization = true
      await Task.yield()
      await session.pairingService.connectInApp()
      session.adoptCompletedPairing()
    }
  }

}

private struct SubscriptionSettingsView: View {
  @Environment(AppSession.self) private var session
  @State private var isPresentingOfferCodeRedemption = false
  @State private var productIDsBeforeOfferCodeRedemption: Set<String> = []
  var body: some View {
    List {
      Section {
        DisclosureNotice(
          title: subscriptionTitle,
          message:
            session.mode == .demo
            ? "This local catalog preview does not grant server-run agent access."
            : "Backend entitlements are authoritative for server-run agents and must follow verified StoreKit JWS reconciliation.",
          symbol: session.mode == .demo || session.authoritativeCurrentPlanTier != nil
            ? "checkmark.seal" : "exclamationmark.shield")
      }
      Section("Plans") {
        ForEach(session.plans) { plan in
          VStack(alignment: .leading, spacing: 8) {
            HStack {
              Text(plan.tier.title).font(.headline)
              Spacer()
              Text(session.storeKit.purchaseTerms(for: plan) ?? "Unavailable")
                .font(.subheadline)
                .multilineTextAlignment(.trailing)
                .monospacedDigit()
            }
            Text(plan.summary).font(.caption).foregroundStyle(.secondary)
            ForEach(plan.features, id: \.self) {
              Label($0, systemImage: "checkmark").font(.caption)
            }
            if session.mode == .demo {
              Label("Demo catalog preview", systemImage: "sparkles.rectangle.stack")
                .font(.subheadline).foregroundStyle(.secondary)
            } else if session.authoritativeCurrentPlanTier == plan.tier {
              Label("Current server-authorized plan", systemImage: "checkmark.seal.fill")
                .font(.subheadline.weight(.semibold)).foregroundStyle(.green)
            } else {
              Button(session.storeKit.purchaseButtonTitle(for: plan)) {
                Task { await session.purchaseOnboardingPlan(plan) }
              }
              .disabled(session.storeKit.localizedPrice(for: plan) == nil)
            }
          }
          .padding(.vertical, 6)
        }
      }
      Section("Purchase tools") {
        Button("Redeem Promo Code", systemImage: "ticket") {
          productIDsBeforeOfferCodeRedemption = session.storeKit.localVerifiedProductIDs
          isPresentingOfferCodeRedemption = true
        }
        Button("Restore Purchases") { Task { await session.restoreOnboardingPurchases() } }
        if let statusMessage = session.storeKit.statusMessage {
          Label(statusMessage, systemImage: "checkmark.circle.fill")
            .foregroundStyle(.green)
            .accessibilityIdentifier("restorePurchasesStatus")
        }
        Button("Manage Subscription") {
          guard
            let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
              .first
          else {
            session.alertMessage = "Subscription management requires an active app window."
            return
          }
          Task { await session.storeKit.manageSubscriptions(in: scene) }
        }
      }
      Section("Entitlement status") {
        LabeledContent(
          "Locally verified products", value: String(session.storeKit.localVerifiedProductIDs.count)
        )
        LabeledContent(
          "Server-authorized products",
          value: String(session.storeKit.serverEntitlementProductIDs.count))
        Text(
          "Locally verified IDs drive display only. Server-agent features remain disabled until the server acknowledges the signed transaction."
        )
        .font(.caption).foregroundStyle(.secondary)
      }
      Section("Terms") {
        Text(
          "Subscriptions renew unless canceled through App Store settings. Downgrade or expiration stops incompatible new entries, never liquidates holdings, and preserves records and monitoring where permitted."
        )
        Text(
          "Options subscriptions do not grant brokerage options approval and do not guarantee returns."
        )
      }
    }
    .offerCodeRedemption(isPresented: $isPresentingOfferCodeRedemption) { result in
      switch result {
      case .success:
        Task {
          switch await session.reconcileOfferCodeRedemption(
            previousProductIDs: productIDsBeforeOfferCodeRedemption)
          {
          case .activated(let tier):
            session.alertMessage = "\(tier.title) access is active."
          case .verifiedLocally(let tier):
            session.alertMessage =
              "\(tier.title) was verified by the App Store. Server access is syncing in the background."
          case .noVerifiedRedemption:
            break
          }
        }
      case .failure(let error):
        session.alertMessage = "The promo code was not redeemed. \(error.localizedDescription)"
      }
    }
    .navigationTitle("Subscription")
  }

  private var subscriptionTitle: String {
    if session.mode == .demo { return "App Review Demo access" }
    return session.authoritativeCurrentPlanTier?.title ?? "No server-authorized plan"
  }
}

private struct ActiveAgentsSettingsView: View {
  @Environment(AppSession.self) private var session
  var body: some View {
    List {
      Section("Active") {
        if session.activeAgents.isEmpty { Text("No active agents").foregroundStyle(.secondary) }
        ForEach(session.activeAgents) { agent in
          NavigationLink(agent.name) { AgentConfigurationView(agentID: agent.id) }
        }
      }
      Section("Portfolio controls") {
        LabeledContent(
          "Global allocation cap",
          value: FinancialFormatters.percent(session.riskPolicy.maximumAllocationPercent))
        LabeledContent("Conflict handling", value: "Reserve capital and reject conflicts")
        LabeledContent("Scheduling", value: "Server workers only")
      }
    }
    .navigationTitle("Active Agents")
  }
}

private struct NotificationSettingsView: View {
  @Environment(AppSession.self) private var session
  var body: some View {
    @Bindable var session = session
    Form {
      if session.mode == .paper {
        Section("Privacy and delivery") {
          Toggle(
            "Detailed lock-screen previews",
            isOn: $session.preferences.notificationPreferences.detailedPreviewsEnabled)
          Toggle(
            "Quiet hours",
            isOn: Binding(
              get: {
                session.preferences.notificationPreferences.quietHoursStartHourUTC != nil
                  && session.preferences.notificationPreferences.quietHoursEndHourUTC != nil
              },
              set: { enabled in
                session.preferences.notificationPreferences.quietHoursStartHourUTC =
                  enabled ? 22 : nil
                session.preferences.notificationPreferences.quietHoursEndHourUTC = enabled ? 7 : nil
                session.preferences.notificationPreferences.quietHoursUTCOffsetMinutes =
                  enabled ? TimeZone.current.secondsFromGMT() / 60 : nil
              }
            ))
          if session.preferences.notificationPreferences.quietHoursStartHourUTC != nil {
            Picker(
              "Start hour (UTC)",
              selection: $session.preferences.notificationPreferences.quietHoursStartHourUTC
            ) {
              ForEach(0..<24, id: \.self) {
                Text(String(format: "%02d:00", $0)).tag(Optional($0))
              }
            }
            Picker(
              "End hour (UTC)",
              selection: $session.preferences.notificationPreferences.quietHoursEndHourUTC
            ) {
              ForEach(0..<24, id: \.self) {
                Text(String(format: "%02d:00", $0)).tag(Optional($0))
              }
            }
          }
        }
        Section {
          Button("Request System Permission") {
            Task { await session.requestNotificationAuthorization() }
          }
        } footer: {
          Text(
            "These delivery settings are saved to WHOX. APNs delivery also requires system permission and successful device-token registration. Critical Alerts are not offered because this build has no Apple Critical Alerts entitlement."
          )
        }
      } else {
        Section {
          DisclosureNotice(
            title: "Remote delivery is off in Demo",
            message:
              "The local App Review timeline remains available in the app, but this Demo configuration does not register an APNs device token or offer delivery controls.",
            symbol: "bell.slash")
        }
      }
    }
    .navigationTitle("Notifications")
    .onDisappear { Task { await session.saveRemotePreferences() } }
  }
}

private struct SecuritySettingsView: View {
  @Environment(AppSession.self) private var session
  var body: some View {
    @Bindable var session = session
    Form {
      Section("Device security") {
        Toggle(
          session.localAuthentication.biometryName,
          isOn: Binding(
            get: { session.preferences.faceIDEnabled },
            set: { enabled in Task { await session.setDeviceSecurityEnabled(enabled) } }
          ))
        Text("When enabled, leaving the app locks sensitive content immediately.")
          .font(.caption).foregroundStyle(.secondary)
      }
      Section("Sessions") {
        LabeledContent("This device", value: "Active")
        LabeledContent(
          session.mode == .demo ? "Other Demo devices" : "Other devices", value: "Server")
        Button("Sign Out Other Devices", role: .destructive) {
          Task { await session.signOutOtherDevices() }
        }
        Button("Sign Out This Device", role: .destructive) {
          Task { await session.signOut() }
        }
      }
      Section("Recent security activity") {
        Label(
          session.mode == .demo ? "App Review Demo identity used" : session.profile.signInMethod,
          systemImage: "person.badge.key")
        Label("No brokerage credential stored on device", systemImage: "checkmark.shield")
        Label(
          "App Attest client interface staged; server validation is not configured",
          systemImage: "iphone.gen3.radiowaves.left.and.right")
      }
    }
    .navigationTitle("Security")
    .onDisappear { session.persistPreferences() }
  }
}

private struct AppearanceSettingsView: View {
  @Environment(AppSession.self) private var session
  var body: some View {
    @Bindable var session = session
    Form {
      Section("Appearance") {
        Picker("Color scheme", selection: $session.preferences.appearance) {
          ForEach(AppearancePreference.allCases) { Text($0.title).tag($0) }
        }
        Toggle("Privacy mode", isOn: $session.preferences.privacyMode)
        Toggle("Meaningful haptics", isOn: $session.preferences.hapticsEnabled)
        Toggle("Reduce chart animation", isOn: $session.preferences.reduceChartAnimation)
      }
      Section("Widget privacy") {
        Text(
          "The widget shows operational status only. Exact balances are never published to the widget, and sensitive content follows system privacy redaction."
        )
      }
      Section {
        Text(
          "System Reduce Motion, Increase Contrast, Differentiate Without Color, Bold Text, and Button Shapes remain authoritative."
        )
      }
    }
    .navigationTitle("Appearance")
    .onDisappear { Task { await session.saveRemotePreferences() } }
  }
}

private struct DataPrivacyView: View {
  @Environment(AppSession.self) private var session
  @State private var exportItem: ExportItem?
  @State private var showingDelete = false

  var body: some View {
    List {
      Section("Data collected") {
        Label("Identity and contact information", systemImage: "person.text.rectangle")
        Label("Linked account and financial snapshots", systemImage: "chart.bar.doc.horizontal")
        Label("Purchase and product interaction records", systemImage: "creditcard")
        Text(
          "The Privacy Manifest declares these linked-to-user categories for app functionality and declares no tracking."
        )
      }
      Section("AI data use") {
        Text(
          "Production must obtain explicit consent before sending minimized derived financial features to a third-party AI provider. Broker tokens are never sent to a model."
        )
      }
      Section("Retention and processors") {
        Text(
          "Production disclosures must list actual processors and explain regulatory retention. Yield never claims deletion of records that law requires it to retain."
        )
      }
      Section("Controls") {
        Button("Download Data") {
          do {
            exportItem = ExportItem(url: try session.exportDemoData())
          } catch { session.alertMessage = error.localizedDescription }
        }
        NavigationLink("Brokerage Access") { ConnectionSettingsView() }
        Button("Delete Account", role: .destructive) {
          showingDelete = true
        }
      }
    }
    .navigationTitle("Privacy Center")
    .sheet(item: $exportItem) { item in ExportShareView(item: item) }
    .sheet(isPresented: $showingDelete) { AccountDeletionView() }
  }
}

private struct LegalSettingsView: View {
  @Environment(AppSession.self) private var session
  var body: some View {
    List {
      Section {
        if session.mode == .demo {
          DisclosureNotice(
            title: "Nonproduction document fixtures",
            message:
              "All versions remain unapproved and Live activation is hidden until counsel-approved versions are loaded.",
            symbol: "exclamationmark.shield", color: .orange)
        } else if session.legalDocuments.isEmpty {
          DisclosureNotice(
            title: "Documents unavailable",
            message:
              "Current approved publications could not be loaded. Paper consent and setup remain blocked until they are available.",
            symbol: "exclamationmark.shield", color: .orange)
        } else {
          DisclosureNotice(
            title: "Approved current documents",
            message:
              "These publications are authoritative for this account. Open each publication to review its complete current language.",
            symbol: "checkmark.shield", color: .green)
        }
      }
      Section("Documents") {
        if session.legalDocuments.isEmpty {
          Text("No current documents are available.").foregroundStyle(.secondary)
        } else {
          ForEach(session.legalDocuments) { document in
            NavigationLink {
              LegalDocumentView(document: document)
            } label: {
              VStack(alignment: .leading, spacing: 3) {
                Text(document.title)
                Text(documentStatus(document)).font(.caption).foregroundStyle(.secondary)
              }
            }
          }
        }
      }
    }
    .navigationTitle("Legal")
    .task { await session.refreshLegalDocuments() }
  }

  private func documentStatus(_ document: LegalDocument) -> String {
    if session.mode == .demo { return "\(document.version) · accepted in Demo setup" }
    return "\(document.version) · Approved and current"
      + (session.isLegalDocumentAccepted(document) ? " · Accepted" : "")
  }
}

private struct HelpSupportView: View {
  @Environment(AppSession.self) private var session
  @State private var subject = "Connection help"
  @State private var message = ""
  var body: some View {
    Form {
      Section("Help center") {
        Link(
          "Connection Troubleshooting",
          destination: URL(string: "https://support.whox.ai/connection")!)
        Link("Emergency Steps", destination: URL(string: "https://support.whox.ai/emergency")!)
        Text(
          "During an outage, use Pause All for future activity and verify open orders and positions directly with the brokerage. Pause does not liquidate positions."
        )
      }
      if session.mode == .demo {
        Section {
          TextField("Subject", text: $subject)
          TextField("Describe the issue", text: $message, axis: .vertical).lineLimit(4...8)
          Button("Create Demo Support Record") {
            session.recordSupportTicket(subject: subject, message: message)
          }
        } header: {
          Text("Demo support workflow")
        } footer: {
          Text("This records a local Demo activity only; it does not contact a support team.")
        }
      } else {
        Section("Contact support") {
          Link(
            "Open Secure Support Request",
            destination: URL(string: "https://support.whox.ai/contact")!)
        }
      }
      Section {
        Button("Copy Diagnostic Summary") {
          UIPasteboard.general.string =
            "Yield | mode=\(session.mode.title) | connection=\(session.connection.status.title) | app=1.0"
          session.alertMessage = "Privacy-safe diagnostic summary copied."
        }
      } header: {
        Text("Report an issue")
      } footer: {
        Text("Never include passwords, OAuth codes, brokerage tokens, or full account numbers.")
      }
    }
    .navigationTitle("Help & Support")
  }
}

private struct AccountDeletionView: View {
  @Environment(AppSession.self) private var session
  @Environment(\.dismiss) private var dismiss
  @State private var confirmation = ""
  var body: some View {
    NavigationStack {
      Form {
        Section {
          DisclosureNotice(
            title: "Delete Yield account",
            message:
              "Account closure disables local access and future automation, revokes WHOX sessions, and durably requests broker authorization revocation. It never closes brokerage positions or open orders, and records required by law remain restricted and retained.",
            symbol: "exclamationmark.triangle", color: .red)
        }
        Section("Before deleting") {
          Label("Review open brokerage orders and positions", systemImage: "checkmark.square")
          Label("Export any records you want to retain", systemImage: "checkmark.square")
          Label("Disconnect brokerage access", systemImage: "checkmark.square")
        }
        Section("Type DELETE to confirm") {
          TextField("DELETE", text: $confirmation).textInputAutocapitalization(.characters)
        }
        Section {
          Button("Authenticate and Request Account Deletion", role: .destructive) {
            Task {
              if await session.deleteAccount(confirmation: confirmation) { dismiss() }
            }
          }
          .disabled(confirmation != "DELETE")
          .frame(maxWidth: .infinity)
        }
      }
      .navigationTitle("Delete Account")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
    }
    .presentationDetents([.large])
  }
}
