import AuthenticationServices
import SwiftUI
import UIKit

struct OnboardingFlowView: View {
  @Environment(AppSession.self) private var session
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var selectedLegalDocument: LegalDocument?
  @State private var eligibilityDeletionConfirmation = ""
  @State private var pendingAppleNonce: String?

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        if session.onboardingDraft.step != .welcome {
          progressHeader
        }

        ScrollView {
          stepContent
            .frame(maxWidth: 680, alignment: .leading)
            .padding(.horizontal, 22)
            .padding(.vertical, 24)
        }
        .scrollDismissesKeyboard(.interactively)

        if showsStandardFooter {
          standardFooter
        }
      }
      .background(Color(uiColor: .systemGroupedBackground))
      .toolbar {
        if session.onboardingDraft.step.rawValue > OnboardingStep.signIn.rawValue,
          session.onboardingDraft.step != .completion
        {
          ToolbarItem(placement: .topBarLeading) {
            Button("Back", systemImage: "chevron.backward") { session.retreatOnboarding() }
              .accessibilityHint(
                "Returns to \(session.onboardingDraft.step.previous?.title ?? "the previous step")")
          }
        }
      }
      .sheet(item: $selectedLegalDocument) { document in
        NavigationStack { LegalDocumentView(document: document) }
          .presentationDetents([.medium, .large])
      }
      .animation(reduceMotion ? nil : .snappy, value: session.onboardingDraft.step)
    }
    .accessibilityIdentifier("onboardingFlow")
  }

  private var progressHeader: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text(session.onboardingDraft.step.title).font(.subheadline.weight(.semibold))
        Spacer()
        Text(
          "Step \(session.onboardingDraft.step.rawValue + 1) of \(OnboardingStep.allCases.count)"
        )
        .font(.caption).foregroundStyle(.secondary)
      }
      ProgressView(
        value: Double(session.onboardingDraft.step.rawValue),
        total: Double(OnboardingStep.allCases.count - 1)
      )
      .accessibilityLabel("Onboarding progress")
      .accessibilityValue(
        "Step \(session.onboardingDraft.step.rawValue + 1) of \(OnboardingStep.allCases.count)")
    }
    .padding(.horizontal, 22)
    .padding(.top, 12)
    .frame(maxWidth: 724)
    .frame(maxWidth: .infinity)
  }

  @ViewBuilder
  private var stepContent: some View {
    switch session.onboardingDraft.step {
    case .welcome: welcomeStep
    case .signIn: signInStep
    case .eligibility: eligibilityStep
    case .howItWorks: howItWorksStep
    case .investorProfile: investorProfileStep
    case .subscription: subscriptionStep
    case .agent: agentStep
    case .riskLimits: riskLimitsStep
    case .automation: automationStep
    case .connection: connectionStep
    case .notifications: notificationsStep
    case .deviceSecurity: deviceSecurityStep
    case .finalReview: finalReviewStep
    case .completion: completionStep
    }
  }

  private var welcomeStep: some View {
    VStack(spacing: 22) {
      Spacer(minLength: 20)
      BrandArtworkView(size: 112)
      VStack(spacing: 10) {
        Text("Automated strategies. Your limits.")
          .font(.largeTitle.bold())
          .multilineTextAlignment(.center)
        Text(
          "Select a strategy, define strict limits, and monitor every action from a native control plane."
        )
        .font(.title3)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
      }
      DisclosureNotice(
        title: "Investing involves loss",
        message:
          "Agents may make errors. WHOX Treasury does not predict markets or guarantee returns.",
        symbol: "exclamationmark.triangle", color: .orange
      )
      .treasuryCard()

      Button("Get Started") { Task { await session.advanceOnboarding() } }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier("getStartedButton")

      Button("I Already Have an Account") { Task { await session.advanceOnboarding() } }
        .buttonStyle(.bordered)
        .controlSize(.large)

      if session.mode == .demo {
        Button("Open App Review Demo") { session.openAppReviewDemo() }
          .font(.footnote.weight(.semibold))
          .accessibilityHint("Opens clearly labeled seeded Demo data without a brokerage login")
          .accessibilityIdentifier("openDemoButton")
      }
    }
    .frame(maxWidth: 560)
    .frame(maxWidth: .infinity)
  }

  private var signInStep: some View {
    VStack(alignment: .leading, spacing: 20) {
      onboardingTitle(
        "Sign in securely",
        subtitle:
          "Your account is created only after the WHOX server verifies Apple’s signed credential.")

      SignInWithAppleButton(.continue) { request in
        request.requestedScopes = [.fullName, .email]
        do {
          pendingAppleNonce = try session.appleAuthentication.prepare(request)
        } catch {
          pendingAppleNonce = nil
          session.alertMessage = error.localizedDescription
        }
      } onCompletion: { result in
        let nonce = pendingAppleNonce
        pendingAppleNonce = nil
        Task { await session.handleAppleAuthorization(result, rawNonce: nonce) }
      }
      .signInWithAppleButtonStyle(.black)
      .frame(height: 52)
      .accessibilityIdentifier("signInWithAppleButton")

      if session.mode == .demo {
        Button("Use App Review Demo Identity") { Task { await session.useDemoIdentity() } }
          .buttonStyle(.bordered)
          .controlSize(.large)
          .frame(maxWidth: .infinity)
          .accessibilityHint(
            "Uses a local, clearly labeled Demo identity and makes no brokerage connection")
      }

      HStack {
        legalLink(id: "privacy")
        Spacer()
        legalLink(id: "terms")
      }
      .font(.footnote)

      DisclosureNotice(
        title: "Private relay supported",
        message:
          "If you hide your email, your Apple private relay address is treated as the account contact address."
      )
    }
  }

  private var eligibilityStep: some View {
    VStack(alignment: .leading, spacing: 18) {
      onboardingTitle(
        "Confirm eligibility",
        subtitle:
          "Only the minimum product-eligibility information is collected here. Brokerage KYC is not duplicated."
      )
      VStack(spacing: 16) {
        labeledTextField("Country or jurisdiction", text: binding(\.country))
        labeledTextField("State of residence", text: binding(\.state))
        VStack(alignment: .leading, spacing: 6) {
          Text("Date-of-birth eligibility").font(.caption).foregroundStyle(.secondary)
          Picker("Date-of-birth eligibility", selection: binding(\.minimumAgeStatus)) {
            ForEach(MinimumAgeStatus.allCases) { status in
              Text(status.title).tag(status)
            }
          }
          .pickerStyle(.menu)
        }
        VStack(alignment: .leading, spacing: 6) {
          Text("Account ownership status").font(.caption).foregroundStyle(.secondary)
          Picker("Account ownership status", selection: binding(\.individualAccountStatus)) {
            ForEach(IndividualAccountStatus.allCases) { status in
              Text(status.title).tag(status)
            }
          }
          .pickerStyle(.menu)
        }
        VStack(alignment: .leading, spacing: 6) {
          Text("Adviser-client classification").font(.caption).foregroundStyle(.secondary)
          Picker(
            "Adviser-client classification",
            selection: binding(\.adviserClientClassification)
          ) {
            ForEach(AdviserClientClassification.allCases) { classification in
              Text(classification.title).tag(classification)
            }
          }
          .pickerStyle(.menu)
        }
        Toggle(
          "I understand WHOX Treasury is not a bank or broker",
          isOn: binding(\.understandsNotBroker))
      }
      .treasuryCard()
      eligibilityStatus
      DisclosureNotice(
        title: "No Social Security number",
        message: "This app does not collect a Social Security number for product onboarding.")
    }
  }

  private var howItWorksStep: some View {
    VStack(alignment: .leading, spacing: 18) {
      onboardingTitle(
        "How it works",
        subtitle:
          "The app is a monitoring and approval surface. Server workers perform scheduled analysis."
      )
      numberedExplanation(
        1, "Choose a plan and strategy",
        "Plans change features and cadence—not decision integrity.", "square.grid.2x2")
      numberedExplanation(
        2, "Set hard risk limits",
        "User limits combine with stricter platform caps that cannot be loosened.", "shield")
      numberedExplanation(
        3, "Connect and monitor",
        "Sign in to a dedicated Robinhood Agentic Account through the official browser authorization flow.",
        "safari")
      DisclosureNotice(
        title: "Important risks",
        message:
          "Agents can make errors. Investing can lose money. Options can lose the premium quickly. Automatic mode may submit without individual confirmation. You remain responsible for monitoring your brokerage account.",
        symbol: "exclamationmark.triangle",
        color: .orange
      )
      .treasuryCard()
      Toggle(
        "I understand how the service works and the risks described above",
        isOn: binding(\.howItWorksAcknowledged)
      )
      .font(.subheadline.weight(.semibold))
      .treasuryCard()
    }
  }

  private var investorProfileStep: some View {
    VStack(alignment: .leading, spacing: 18) {
      onboardingTitle(
        "Investor profile",
        subtitle:
          "Your answers produce a transparent internal classification. They do not determine brokerage options approval."
      )
      VStack(spacing: 18) {
        labeledPicker(
          "Investment objective", selection: binding(\.objective),
          options: InvestorAssessmentEvaluator.objectives)
        labeledPicker(
          "Intended holding period", selection: binding(\.holdingPeriod),
          options: InvestorAssessmentEvaluator.holdingPeriods)
        labeledPicker(
          "Overall trading experience", selection: binding(\.experience),
          options: InvestorAssessmentEvaluator.experienceLevels)
        labeledPicker(
          "Stock experience", selection: binding(\.stockExperience),
          options: InvestorAssessmentEvaluator.experienceLevels)
        labeledPicker(
          "Options experience", selection: binding(\.optionsExperience),
          options: InvestorAssessmentEvaluator.experienceLevels)
        VStack(alignment: .leading, spacing: 8) {
          Text(
            "Maximum acceptable drawdown: \(FinancialFormatters.percent(session.onboardingDraft.lossTolerance))"
          )
          Slider(value: binding(\.lossTolerance), in: 3...30, step: 1)
        }
        Toggle(
          "I depend on these invested funds for near-term expenses", isOn: binding(\.dependsOnFunds)
        )
        labeledPicker(
          "Need for near-term liquidity", selection: binding(\.liquidityNeed),
          options: InvestorAssessmentEvaluator.liquidityNeeds)
        labeledPicker(
          "Comfort with short-term volatility", selection: binding(\.volatilityComfort),
          options: InvestorAssessmentEvaluator.volatilityComfortLevels)
        labeledPicker(
          "Proposal-review preference", selection: binding(\.confirmationPreference),
          options: InvestorAssessmentEvaluator.confirmationPreferences)
        Toggle(
          "I understand an options premium can be lost in full",
          isOn: binding(\.understandsOptionsPremiumLoss))
        Toggle(
          "I reviewed these answers and confirm they are accurate",
          isOn: binding(\.investorProfileAcknowledged))
      }
      .treasuryCard()
      DisclosureNotice(
        title: "Current classification: \(session.investorAssessment.riskClassification.title)",
        message: session.investorAssessment.rationale.joined(separator: " "),
        symbol: "person.text.rectangle"
      )
      DisclosureNotice(
        title: session.investorAssessment.optionsClassification.title,
        message:
          "This internal assessment is not brokerage options approval. A subscription cannot override it, and broker permission remains independently required.",
        symbol: "checkmark.shield"
      )
    }
  }

  private var subscriptionStep: some View {
    VStack(alignment: .leading, spacing: 18) {
      onboardingTitle(
        "Choose a plan",
        subtitle:
          session.mode == .demo
          ? "Localized prices load from StoreKit. This explicit Demo configuration can be explored without a purchase."
          : "Plan features come from the authenticated WHOX catalog, while localized prices come only from StoreKit. Server access changes only after verified entitlement sync."
      )
      ForEach(session.plans) { plan in
        PlanSelectionCard(plan: plan, selected: session.onboardingDraft.selectedPlan == plan.tier)
      }
      if session.mode == .paper {
        Button("Restore Purchases") { Task { await session.restoreOnboardingPurchases() } }
          .buttonStyle(.bordered)
        Link(
          "Manage App Store Subscriptions",
          destination: URL(string: "https://apps.apple.com/account/subscriptions")!
        )
        .font(.footnote)
      }
      DisclosureNotice(
        title: "No return guarantee",
        message:
          "A subscription unlocks features. It does not guarantee returns or grant brokerage options approval.",
        symbol: "checkmark.shield")
    }
  }

  private var agentStep: some View {
    VStack(alignment: .leading, spacing: 18) {
      onboardingTitle(
        "Choose your first agent",
        subtitle: "Strategy capabilities are shown plainly. No unexplained AI score is used.")
      ForEach(session.agents) { agent in
        Button {
          session.selectOnboardingAgent(agent)
        } label: {
          HStack(alignment: .top, spacing: 14) {
            Image(systemName: agent.icon).font(.title2).frame(width: 36, height: 36)
              .foregroundStyle(.tint)
            VStack(alignment: .leading, spacing: 6) {
              HStack {
                Text(agent.name).font(.headline)
                Spacer()
                if session.onboardingDraft.selectedAgentID == agent.id {
                  Image(systemName: "checkmark.circle.fill").foregroundStyle(.tint)
                }
              }
              Text(agent.summary).font(.subheadline).foregroundStyle(.secondary)
                .multilineTextAlignment(.leading)
              Text("\(agent.assetClass) · \(agent.riskCategory.title) · \(agent.holdingPeriod)")
                .font(.caption).foregroundStyle(.secondary)
              Text("May struggle: \(agent.struggles.first ?? "Changing market conditions")")
                .font(.caption).foregroundStyle(.secondary)
            }
          }
          .treasuryCard()
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
          "\(agent.name), \(agent.assetClass), \(agent.riskCategory.title), requires \(agent.requiredPlan.title)"
        )
      }
    }
  }

  private var riskLimitsStep: some View {
    VStack(alignment: .leading, spacing: 18) {
      onboardingTitle(
        "Set hard risk limits",
        subtitle:
          session.mode == .demo
          ? "These defaults are conservative Demo suggestions. You may tighten them but cannot exceed platform caps."
          : "These server-confirmed limits may be tightened, but cannot exceed platform caps. Every proposal is checked again before submission."
      )
      riskSlider(
        "Maximum account allocation", value: riskBinding(\.maximumAllocationPercent),
        range: 10...80, step: 1
      ) { FinancialFormatters.percent($0) }
      riskSlider(
        "Maximum position amount", value: riskBinding(\.maximumPositionAmount), range: 500...25_000,
        step: 100
      ) { FinancialFormatters.currency($0) }
      riskSlider(
        "Maximum new order", value: riskBinding(\.maximumOrderAmount), range: 100...10_000,
        step: 100
      ) { FinancialFormatters.currency($0) }
      riskSlider(
        "Daily loss halt", value: riskBinding(\.dailyLossLimit), range: 100...5_000, step: 50
      ) { FinancialFormatters.currency($0) }
      riskSlider(
        "Portfolio drawdown halt", value: riskBinding(\.drawdownHaltPercent), range: 3...20, step: 1
      ) { FinancialFormatters.percent($0) }
      riskSlider(
        "Buying-power reserve", value: riskBinding(\.buyingPowerReservePercent), range: 10...90,
        step: 1
      ) { FinancialFormatters.percent($0) }
      Stepper(
        "Maximum simultaneous positions: \(session.onboardingDraft.riskPolicy.maximumPositions)",
        value: riskIntBinding(\.maximumPositions), in: 1...30
      )
      .treasuryCard()
      VStack(spacing: 12) {
        Toggle("Allow trading around earnings", isOn: riskBoolBinding(\.allowEarningsTrading))
        Toggle("Allow fractional shares", isOn: riskBoolBinding(\.allowFractionalShares))
        Toggle("Allow extended-hours orders", isOn: riskBoolBinding(\.allowExtendedHours))
      }
      .treasuryCard()
      if session.currentPlan.supportsOptions
        || [.options, .optionsPro].contains(session.onboardingDraft.selectedPlan)
      {
        DisclosureNotice(
          title: "Options hard caps",
          message:
            "No 0DTE, naked options, unlimited-loss structures, or unknown maximum loss are enabled in the initial policy.",
          symbol: "shield.lefthalf.filled", color: .orange)
        riskSlider(
          "Maximum options loss per trade", value: riskBinding(\.maximumOptionsLoss),
          range: 50...2_500, step: 50
        ) { FinancialFormatters.currency($0) }
        Stepper(
          "Minimum days to expiration: \(session.onboardingDraft.riskPolicy.minimumDaysToExpiration)",
          value: riskIntBinding(\.minimumDaysToExpiration), in: 14...90
        )
        .treasuryCard()
        Stepper(
          "Maximum contracts: \(session.onboardingDraft.riskPolicy.maximumContracts)",
          value: riskIntBinding(\.maximumContracts), in: 1...10
        )
        .treasuryCard()
      }
    }
  }

  private var automationStep: some View {
    VStack(alignment: .leading, spacing: 18) {
      onboardingTitle(
        "Choose an approval mode",
        subtitle:
          "Safer modes are available on every plan. New users default to individual confirmation.")
      ForEach(AgentOperatingMode.allCases) { mode in
        Button {
          if mode == .automaticWithinLimits, !session.gates.canEnableAutonomousMode {
            session.alertMessage =
              "Automatic mode is gated off in this build. Choose Observe or Confirm Every Trade."
          } else {
            session.onboardingDraft.automationMode = mode
          }
        } label: {
          HStack(alignment: .top, spacing: 14) {
            Image(
              systemName: mode == .observe
                ? "eye" : mode == .confirmEveryTrade ? "checkmark.shield" : "bolt.shield"
            )
            .font(.title2).foregroundStyle(.tint).frame(width: 34)
            VStack(alignment: .leading, spacing: 6) {
              HStack {
                Text(mode.title).font(.headline)
                if mode == .automaticWithinLimits, !session.gates.canEnableAutonomousMode {
                  Label("Locked", systemImage: "lock.fill").font(.caption).foregroundStyle(.orange)
                }
                Spacer()
                if session.onboardingDraft.automationMode == mode {
                  Image(systemName: "checkmark.circle.fill").foregroundStyle(.tint)
                }
              }
              Text(mode.summary).font(.subheadline).foregroundStyle(.secondary)
                .multilineTextAlignment(.leading)
            }
          }
          .treasuryCard()
        }
        .buttonStyle(.plain)
      }
    }
  }

  private var connectionStep: some View {
    VStack(alignment: .leading, spacing: 18) {
      onboardingTitle(
        "Connect Robinhood",
        subtitle:
          "Tap once to open the server-provided Robinhood setup in Apple’s secure authentication browser. Treasury receives only masked connection status—never your Robinhood password, OAuth code, broker token, or MCP credential."
      )

      DisclosureNotice(
        title: "Robinhood-controlled setup",
        message:
          "Treasury uses Apple’s secure authentication browser, never an embedded webview. Sign in and approve within Robinhood. QR, Copy, and Share are optional ways to reopen the same short-lived authorization.",
        symbol: "safari", color: .blue
      )

      if let pairing = session.pairingService.session {
        let browserURL = session.pairingService.browserAuthorizationURL ?? pairing.setupURL
        let browserExpiresAt =
          session.pairingService.browserAuthorizationExpiresAt ?? pairing.expiresAt
        let hasAuthorizationURL = session.pairingService.browserAuthorizationURL != nil
        VStack(spacing: 16) {
          Label(
            session.pairingService.statusMessage,
            systemImage: session.pairingService.lifecycleStatus == .connected
              ? "checkmark.circle.fill" : "clock"
          )
          .font(.subheadline).foregroundStyle(
            session.pairingService.lifecycleStatus == .connected ? .green : .secondary)
          if session.pairingService.lifecycleStatus != .connected {
            Button("Open Robinhood Sign In", systemImage: "safari") {
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
            Button("Regenerate Code") { Task { await session.pairingService.regenerate() } }
            Button("Cancel Pairing", role: .destructive) {
              Task { await session.pairingService.cancel() }
            }
          } else {
            Button("Continue") {
              Task {
                session.adoptCompletedPairing()
                await session.advanceOnboarding()
              }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .frame(maxWidth: .infinity)
          }

          if session.pairingService.lifecycleStatus != .connected {
            Divider()
            Text("Authorization link").font(.headline).frame(
              maxWidth: .infinity, alignment: .leading)
            Text(
              hasAuthorizationURL
                ? "Reopen this exact short-lived Robinhood authorization here, or use QR, Copy, or Share in another trusted browser."
                : "Use QR, Copy, or Share if you prefer to continue this short-lived setup in another trusted browser."
            )
            .font(.subheadline).foregroundStyle(.secondary)
            QRCodeView(url: browserURL).frame(width: 190, height: 190)
            Text(pairing.code)
              .font(.title2.monospaced().weight(.semibold))
              .accessibilityLabel("Pairing code, \(pairing.code)")
              .accessibilityIdentifier("pairingCode")
            Text("Expires \(browserExpiresAt, style: .timer)").font(.caption).foregroundStyle(
              .secondary)
            ViewThatFits {
              HStack {
                copySetupLinkButton(browserURL)
                Spacer()
                ShareLink(item: browserURL) {
                  Label("Share Robinhood Link", systemImage: "square.and.arrow.up")
                }
              }
              VStack(alignment: .leading) {
                copySetupLinkButton(browserURL)
                ShareLink(item: browserURL) {
                  Label("Share Robinhood Link", systemImage: "square.and.arrow.up")
                }
              }
            }
            .font(.subheadline)
          }
        }
        .treasuryCard()
      } else {
        DisclosureNotice(
          title: "Short-lived and single-use",
          message:
            "Treasury creates a pairing, requests a browser authorization handoff, and verifies the final result with the WHOX server. The pairing expires after 10 minutes.",
          symbol: "timer"
        )
        .treasuryCard()
        Button("Connect to Robinhood", systemImage: "safari") {
          Task {
            await session.pairingService.connectInApp()
            session.adoptCompletedPairing()
          }
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier("connectRobinhoodButton")
      }
    }
  }

  private var notificationsStep: some View {
    VStack(alignment: .leading, spacing: 18) {
      onboardingTitle(
        "Stay informed",
        subtitle:
          "Notifications are useful but optional. Sensitive balances and trade details are hidden from lock-screen previews by default."
      )
      let items = [
        ("doc.text", "Trade proposals and approvals"),
        ("arrow.triangle.2.circlepath", "Submissions, fills, rejections, and cancellations"),
        ("exclamationmark.shield", "Risk halts and connection expiration"),
        ("calendar.badge.exclamationmark", "Options expiration and assignment-risk reminders"),
        ("lock.shield", "Security events"),
      ]
      ForEach(items, id: \.1) { item in
        Label(item.1, systemImage: item.0).padding(.vertical, 4)
      }
      Button("Enable Notifications") {
        Task {
          await session.requestNotificationAuthorization()
          await session.advanceOnboarding()
        }
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.large)
      .frame(maxWidth: .infinity)
      Button("Not Now") { Task { await session.advanceOnboarding() } }
        .buttonStyle(.bordered)
        .controlSize(.large)
        .frame(maxWidth: .infinity)
    }
  }

  private var deviceSecurityStep: some View {
    VStack(alignment: .leading, spacing: 18) {
      onboardingTitle(
        "Protect sensitive actions",
        subtitle:
          "Use \(session.localAuthentication.biometryName) or the device passcode for approvals, major limit changes, reconnects, and account deletion."
      )
      Image(systemName: "faceid").font(.system(size: 68)).foregroundStyle(.tint).frame(
        maxWidth: .infinity
      ).padding(.vertical)
      DisclosureNotice(
        title: "Passcode fallback",
        message:
          "Device-owner authentication automatically falls back to the device passcode when appropriate.",
        symbol: "lock.shield"
      )
      .treasuryCard()
      Button("Enable \(session.localAuthentication.biometryName)") {
        Task {
          await session.enableDeviceSecurity()
          if session.onboardingDraft.deviceSecurityEnabled { await session.advanceOnboarding() }
        }
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.large)
      .frame(maxWidth: .infinity)
      Button("Set Up Later") { Task { await session.advanceOnboarding() } }
        .buttonStyle(.bordered)
        .controlSize(.large)
        .frame(maxWidth: .infinity)
    }
  }

  private var finalReviewStep: some View {
    VStack(alignment: .leading, spacing: 18) {
      onboardingTitle("Review your Treasury", subtitle: "No trade is placed when setup finishes.")
      VStack(spacing: 13) {
        LabeledValueRow(
          label: "Plan", value: session.onboardingDraft.selectedPlan.title, symbol: "creditcard")
        LabeledValueRow(
          label: "Agent",
          value: session.agents.first(where: { $0.id == session.onboardingDraft.selectedAgentID })?
            .name ?? "None", symbol: "point.3.connected.trianglepath.dotted")
        LabeledValueRow(
          label: "Account mode", value: session.mode.title,
          symbol: "sparkles.rectangle.stack")
        LabeledValueRow(
          label: "Approval", value: session.onboardingDraft.automationMode.title,
          symbol: "checkmark.shield")
        LabeledValueRow(
          label: "Investor profile", value: session.investorAssessment.riskClassification.title,
          symbol: "person.text.rectangle")
        LabeledValueRow(
          label: "Options profile", value: session.investorAssessment.optionsClassification.title,
          symbol: "lock.shield")
        LabeledValueRow(
          label: "Allocation limit",
          value: FinancialFormatters.percent(
            session.onboardingDraft.riskPolicy.maximumAllocationPercent), symbol: "chart.pie")
        LabeledValueRow(
          label: "Daily loss halt",
          value: FinancialFormatters.currency(session.onboardingDraft.riskPolicy.dailyLossLimit),
          symbol: "arrow.down.right")
        LabeledValueRow(
          label: "New order limit",
          value: FinancialFormatters.currency(
            session.onboardingDraft.riskPolicy.maximumOrderAmount), symbol: "cart")
        LabeledValueRow(label: "Connection", value: session.connection.status.title, symbol: "link")
        LabeledValueRow(
          label: "Notifications",
          value: session.onboardingDraft.notificationRequested ? "Requested" : "Not requested",
          symbol: "bell")
      }
      .treasuryCard()

      Text(
        session.mode == .demo ? "Required document fixtures" : "Required current documents"
      )
      .font(.headline)
      if session.legalDocuments.isEmpty {
        ContentUnavailableView(
          "Documents unavailable",
          systemImage: "doc.badge.ellipsis",
          description: Text(
            "Paper setup remains blocked until every approved current publication is available."
          ))
      }
      ForEach(session.legalDocuments, id: \.id) { document in
        HStack(alignment: .top, spacing: 12) {
          Button {
            session.toggleLegalDocumentAcceptance(document)
          } label: {
            Image(
              systemName: session.isLegalDocumentAccepted(document)
                ? "checkmark.square.fill" : "square"
            )
            .font(.title3)
          }
          .buttonStyle(.plain)
          Button {
            selectedLegalDocument = document
          } label: {
            VStack(alignment: .leading, spacing: 3) {
              Text(document.title).foregroundStyle(.primary)
              Text(
                "\(document.version) · \(session.mode == .demo ? "nonproduction" : "approved and current")"
              )
              .font(.caption)
              .foregroundStyle(document.productionApproved ? Color.secondary : Color.orange)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
          }
          .buttonStyle(.plain)
        }
        .padding(.vertical, 4)
      }
      Button(
        session.mode == .demo
          ? "Accept All Demo Document Fixtures" : "Accept All Current Documents"
      ) {
        session.acceptAllLegalDocuments()
      }
      .buttonStyle(.bordered)
      .disabled(session.legalDocuments.isEmpty)
      DisclosureNotice(
        title: session.mode == .demo ? "Live remains locked" : "Authoritative consent required",
        message:
          session.mode == .demo
          ? "These Demo acknowledgments do not substitute for counsel-approved documents. The production legal release gate remains false."
          : "These are the approved current publications for this account. Completion requires the WHOX server to accept every exact version and publication digest.",
        symbol: "lock.shield", color: .orange)
    }
  }

  private var completionStep: some View {
    VStack(spacing: 22) {
      Spacer(minLength: 40)
      Image(systemName: "checkmark.circle.fill").font(.system(size: 78)).foregroundStyle(.green)
        .accessibilityLabel("Setup complete")
      Text("Your \(session.mode.title) Treasury is ready").font(.largeTitle.bold())
        .multilineTextAlignment(.center)
      Text(
        session.mode == .demo
          ? "Review the seeded account, proposal, fill, risk rejection, and options warning. No immediate trade will launch."
          : "Authoritative setup is complete. No order is submitted merely because onboarding finished."
      )
      .font(.title3).foregroundStyle(.secondary).multilineTextAlignment(.center)
      Button("Open Treasury") { session.completeOnboarding() }
        .buttonStyle(.borderedProminent).controlSize(.large).frame(maxWidth: .infinity)
        .accessibilityIdentifier("openTreasuryButton")
      Button("Review Agent") {
        session.completeOnboarding()
        session.navigate(to: .activeAgent)
      }
      .buttonStyle(.bordered).controlSize(.large).frame(maxWidth: .infinity)
    }
    .frame(maxWidth: 560)
    .frame(maxWidth: .infinity)
  }

  private var showsStandardFooter: Bool {
    ![.welcome, .signIn, .connection, .notifications, .deviceSecurity, .completion].contains(
      session.onboardingDraft.step)
  }

  private var standardFooter: some View {
    VStack(spacing: 8) {
      Button(session.onboardingDraft.step == .finalReview ? "Accept and Finish Setup" : "Continue")
      {
        Task { await session.advanceOnboarding() }
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.large)
      .frame(maxWidth: 680)
      .disabled(!canContinue)
      .accessibilityIdentifier("onboardingContinueButton")
    }
    .padding(.horizontal, 22)
    .padding(.vertical, 12)
    .background(.bar)
  }

  private var canContinue: Bool {
    session.canAdvanceOnboarding
  }

  @ViewBuilder
  private var eligibilityStatus: some View {
    let assessment = session.eligibilityAssessment
    switch assessment.status {
    case .eligibleForDemo:
      DisclosureNotice(
        title: "Required fields complete",
        message: assessment.messages.joined(separator: " "),
        symbol: "checkmark.shield", color: .green
      )
    case .incomplete:
      DisclosureNotice(
        title: "Required before continuing",
        message: assessment.messages.joined(separator: " "),
        symbol: "list.bullet.clipboard"
      )
    case .unavailable:
      VStack(alignment: .leading, spacing: 14) {
        Label("WHOX Treasury is unavailable", systemImage: "person.crop.circle.badge.xmark")
          .font(.title3.bold())
          .foregroundStyle(.red)
        Text(assessment.messages.joined(separator: " "))
          .font(.subheadline)
          .foregroundStyle(.secondary)
        Text(
          "No brokerage connection or order was created. You may review your answers or delete this local Demo account."
        )
        .font(.footnote)
        TextField("Type DELETE", text: $eligibilityDeletionConfirmation)
          .textInputAutocapitalization(.characters)
          .textFieldStyle(.roundedBorder)
          .accessibilityIdentifier("eligibilityDeletionConfirmation")
        Button("Authenticate and Delete Account", role: .destructive) {
          Task {
            _ = await session.deleteAccount(confirmation: eligibilityDeletionConfirmation)
          }
        }
        .disabled(eligibilityDeletionConfirmation != "DELETE")
        .accessibilityIdentifier("deleteIneligibleAccountButton")
        Link(
          "Contact Eligibility Support",
          destination: URL(string: "https://support.whox.ai/eligibility")!
        )
        .font(.subheadline.weight(.semibold))
        .accessibilityIdentifier("eligibilitySupportLink")
      }
      .treasuryCard()
    }
  }

  private func onboardingTitle(_ title: String, subtitle: String) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title).font(.largeTitle.bold())
      Text(subtitle).font(.title3).foregroundStyle(.secondary)
    }
    .accessibilityElement(children: .combine)
  }

  private func numberedExplanation(
    _ number: Int, _ title: String, _ message: String, _ symbol: String
  ) -> some View {
    HStack(alignment: .top, spacing: 14) {
      ZStack {
        Circle().fill(.tint.opacity(0.14)).frame(width: 44, height: 44)
        Image(systemName: symbol).foregroundStyle(.tint)
      }
      VStack(alignment: .leading, spacing: 5) {
        Text("\(number). \(title)").font(.headline)
        Text(message).font(.subheadline).foregroundStyle(.secondary)
      }
      Spacer(minLength: 0)
    }
    .treasuryCard()
  }

  private func labeledTextField(_ title: String, text: Binding<String>) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title).font(.caption).foregroundStyle(.secondary)
      TextField(title, text: text).textFieldStyle(.roundedBorder)
    }
  }

  private func labeledPicker(_ title: String, selection: Binding<String>, options: [String])
    -> some View
  {
    VStack(alignment: .leading, spacing: 6) {
      Text(title).font(.caption).foregroundStyle(.secondary)
      Picker(title, selection: selection) { ForEach(options, id: \.self) { Text($0).tag($0) } }
        .pickerStyle(.menu)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func riskSlider(
    _ title: String, value: Binding<Double>, range: ClosedRange<Double>, step: Double,
    display: @escaping (Double) -> String
  ) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text(title)
        Spacer()
        Text(display(value.wrappedValue)).monospacedDigit().foregroundStyle(.secondary)
      }
      Slider(value: value, in: range, step: step)
    }
    .font(.subheadline)
    .treasuryCard()
  }

  private func legalLink(id: String) -> some View {
    Button(session.legalDocuments.first(where: { $0.id == id })?.title ?? "Legal") {
      selectedLegalDocument = session.legalDocuments.first(where: { $0.id == id })
    }
  }

  private func copySetupLinkButton(_ url: URL) -> some View {
    Button("Copy Robinhood Link", systemImage: "doc.on.doc") {
      UIPasteboard.general.url = url
      session.alertMessage = "The short-lived Robinhood authorization link was copied."
    }
  }

  private func binding<Value>(_ keyPath: WritableKeyPath<OnboardingDraft, Value>) -> Binding<Value>
  {
    Binding(
      get: { session.onboardingDraft[keyPath: keyPath] },
      set: { session.onboardingDraft[keyPath: keyPath] = $0 })
  }

  private func riskBinding(_ keyPath: WritableKeyPath<RiskPolicy, Double>) -> Binding<Double> {
    Binding(
      get: { session.onboardingDraft.riskPolicy[keyPath: keyPath] },
      set: { session.onboardingDraft.riskPolicy[keyPath: keyPath] = $0 })
  }

  private func riskIntBinding(_ keyPath: WritableKeyPath<RiskPolicy, Int>) -> Binding<Int> {
    Binding(
      get: { session.onboardingDraft.riskPolicy[keyPath: keyPath] },
      set: { session.onboardingDraft.riskPolicy[keyPath: keyPath] = $0 })
  }

  private func riskBoolBinding(_ keyPath: WritableKeyPath<RiskPolicy, Bool>) -> Binding<Bool> {
    Binding(
      get: { session.onboardingDraft.riskPolicy[keyPath: keyPath] },
      set: { session.onboardingDraft.riskPolicy[keyPath: keyPath] = $0 })
  }
}

private struct PlanSelectionCard: View {
  @Environment(AppSession.self) private var session
  let plan: SubscriptionPlan
  let selected: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .firstTextBaseline) {
        Text(plan.tier.title).font(.title3.bold())
        Spacer()
        if isSelected { Image(systemName: "checkmark.circle.fill").foregroundStyle(.tint) }
      }
      Text(
        session.storeKit.localizedPrice(for: plan).map { "\($0) per month" }
          ?? "Price unavailable in current storefront"
      )
      .font(.headline).monospacedDigit()
      Text(plan.summary).font(.subheadline).foregroundStyle(.secondary)
      ForEach(plan.features, id: \.self) { Label($0, systemImage: "checkmark").font(.caption) }
      if session.mode == .demo {
        Button(isSelected ? "Selected" : "Select Plan") {
          session.selectOnboardingPlan(plan)
        }
        .buttonStyle(.borderedProminent)
        .disabled(isSelected)
      } else if isSelected {
        Label("Current server-authorized plan", systemImage: "checkmark.seal.fill")
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(.green)
      } else {
        Button("Purchase \(plan.tier.title)") {
          Task { await session.purchaseOnboardingPlan(plan) }
        }
        .buttonStyle(.borderedProminent)
        .disabled(session.storeKit.localizedPrice(for: plan) == nil)
      }
    }
    .treasuryCard()
    .overlay {
      RoundedRectangle(cornerRadius: 18, style: .continuous)
        .stroke(isSelected ? Color.accentColor : .clear, lineWidth: 2)
    }
    .accessibilityElement(children: .contain)
  }

  private var isSelected: Bool {
    session.mode == .demo ? selected : session.authoritativeCurrentPlanTier == plan.tier
  }
}
