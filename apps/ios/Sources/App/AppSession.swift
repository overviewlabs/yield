import AuthenticationServices
import Foundation
import Observation

enum ContentLoadPhase: Equatable {
  case idle
  case loading
  case loaded
  case offline(String)
  case failed(String)
}

@MainActor
@Observable
final class AppSession {
  private(set) var isOnboardingComplete: Bool
  private(set) var isAppReviewPreviewActive = false
  var onboardingDraft: OnboardingDraft
  var selectedTab: MainTab = .home
  var presentedRoute: TreasuryRoute?
  var loadPhase: ContentLoadPhase = .idle
  private(set) var mode: TreasuryMode = .demo
  private(set) var startupBlocker: String?
  var dashboard = DemoFixtures.dashboard
  var positions = DemoFixtures.positions
  var agents = DemoFixtures.agents
  var activities = DemoFixtures.activities
  var riskPolicy = DemoFixtures.recommendedRiskPolicy
  var connection = DemoFixtures.brokerConnection
  var profile = UserProfile(
    name: "Alex Morgan", email: "review@whox.ai", signInMethod: "Demo identity",
    jurisdiction: "Not assessed", riskClassification: "Not assessed")
  var preferences = AppPreferences()
  var selectedPlanTier = PlanTier.equity
  private(set) var authoritativeCurrentPlanTier: PlanTier?
  var alertMessage: String?
  var isPrivacyShieldVisible = false
  var isAppLocked = false
  var lastRefresh = Date.distantPast
  private(set) var exclusionUpdatesInFlight: Set<String> = []
  private(set) var orderCancellationsInFlight: Set<String> = []
  private(set) var plans = DemoFixtures.plans
  private(set) var researchUniverseByPlan: [PlanTier: [String: [String]]] = Dictionary(
    uniqueKeysWithValues: PlanTier.allCases.map { tier in
      (
        tier,
        Dictionary(
          uniqueKeysWithValues: DemoFixtures.agents.map { ($0.id, ["AAPL", "MSFT", "VTI"]) })
      )
    })
  private var effectiveMaximumActiveAgents: Int?
  private(set) var legalDocuments = DemoFixtures.legalDocuments
  let gates = ReleaseGates.locked

  let storeKit: StoreKitService
  let pairingService: PairingService
  @ObservationIgnored let appleAuthentication = AppleAuthenticationService()
  @ObservationIgnored private let authClient: any AuthClient
  @ObservationIgnored let localAuthentication: LocalAuthenticationService
  @ObservationIgnored let notificationAuthorization = NotificationAuthorizationService.shared
  @ObservationIgnored private let repository: any TreasuryRepository
  @ObservationIgnored private let onboardingPersistence: (any OnboardingPersisting)?
  @ObservationIgnored private let readinessChecker: (any RuntimeReadinessChecking)?
  @ObservationIgnored private let defaults: UserDefaults
  @ObservationIgnored private let arguments: [String]
  @ObservationIgnored private var authoritativeOnboardingCompleted = false

  init(
    runtimeMode: TreasuryMode = .demo,
    repository: any TreasuryRepository = DemoTreasuryRepository(),
    storeKit: StoreKitService = StoreKitService(),
    pairingService: PairingService = PairingService(),
    authClient: any AuthClient = DemoAuthClient(),
    onboardingPersistence: (any OnboardingPersisting)? = nil,
    readinessChecker: (any RuntimeReadinessChecking)? = nil,
    startupBlocker: String? = nil,
    defaults: UserDefaults = .standard,
    arguments: [String] = ProcessInfo.processInfo.arguments
  ) {
    self.repository = repository
    self.storeKit = storeKit
    self.pairingService = pairingService
    self.authClient = authClient
    self.onboardingPersistence = onboardingPersistence
    self.readinessChecker = readinessChecker
    self.startupBlocker = startupBlocker
    self.defaults = defaults
    self.arguments = arguments
    self.mode = runtimeMode
    if runtimeMode != .demo { self.legalDocuments = [] }
    self.localAuthentication = LocalAuthenticationService(arguments: arguments)
    // A service instance can be injected or reused by tests. Never retain an account
    // association until this session has authenticated a canonical Paper user UUID.
    self.storeKit.setAppAccountToken(nil)
    self.onboardingDraft =
      Self.restoreDraft(from: defaults)
      ?? OnboardingDraft(riskPolicy: DemoFixtures.recommendedRiskPolicy)
    self.preferences = Self.restorePreferences(from: defaults) ?? AppPreferences()

    #if DEBUG
      let skipsOnboardingForTests = arguments.contains("-skipOnboarding")
    #else
      let skipsOnboardingForTests = false
    #endif
    if arguments.contains("-resetOnboarding") {
      defaults.removeObject(forKey: StorageKey.onboardingComplete)
      defaults.removeObject(forKey: StorageKey.legacyOnboardingComplete)
      defaults.removeObject(forKey: StorageKey.onboardingDraft)
      defaults.removeObject(forKey: StorageKey.legacyOnboardingDraft)
      self.onboardingDraft = OnboardingDraft(riskPolicy: DemoFixtures.recommendedRiskPolicy)
      self.isOnboardingComplete = false
    } else {
      self.isOnboardingComplete =
        skipsOnboardingForTests
        || (onboardingPersistence == nil && defaults.bool(forKey: StorageKey.onboardingComplete))
    }

    if self.isOnboardingComplete, !skipsOnboardingForTests,
      self.onboardingDraft.step != .completion || !self.onboardingCompletionIssues.isEmpty
    {
      self.isOnboardingComplete = false
      defaults.removeObject(forKey: StorageKey.onboardingComplete)
    }

    if !self.isOnboardingComplete {
      self.connection = BrokerConnection(
        status: .disconnected, maskedAccount: nil, accountType: nil,
        capabilities: [], optionsPermission: "Not connected", lastSync: nil)
    } else if self.onboardingCompletionIssues.isEmpty {
      self.applyCompletedOnboardingDraft()
    }

    if runtimeMode != .demo {
      self.dashboard = Self.unavailableDashboard(mode: runtimeMode)
      self.positions = []
      self.agents = []
      self.activities = []
      self.connection = BrokerConnection(
        status: .disconnected, maskedAccount: nil, accountType: nil,
        capabilities: [], optionsPermission: "Not connected", lastSync: nil)
      self.profile = UserProfile(
        name: "Treasury User", email: "", signInMethod: "Signed out",
        jurisdiction: "Not assessed", riskClassification: "Not assessed")
    }

    if arguments.contains("-uiDarkMode") { self.preferences.appearance = .dark }
    if arguments.contains("-uiLightMode") { self.preferences.appearance = .light }
    if arguments.contains("-uiPrivacyMode") { self.preferences.privacyMode = true }
    #if DEBUG
      if arguments.contains("-uiPrivacyModeOff") { self.preferences.privacyMode = false }
    #endif
    if arguments.contains("-uiReduceMotion") { self.preferences.reduceChartAnimation = true }
    #if DEBUG
      if arguments.contains("-uiValidOnboardingAnswers") {
        self.onboardingDraft.country = "United States"
        self.onboardingDraft.state = "New York"
        self.onboardingDraft.minimumAgeStatus = .meetsRequirement
        self.onboardingDraft.individualAccountStatus = .actingForOwnAccount
        self.onboardingDraft.adviserClientClassification = .selfDirected
        self.onboardingDraft.understandsNotBroker = true
        self.onboardingDraft.howItWorksAcknowledged = true
        self.onboardingDraft.investorProfileAcknowledged = true
      }
    #endif
    if arguments.contains("-uiNoActiveAgents") {
      for index in self.agents.indices {
        self.agents[index].isActive = false
        self.agents[index].runtimeStatus = .paused
      }
    }

    notificationAuthorization.installCallbacks(
      onRegistration: { [weak self] token in
        Task { @MainActor in await self?.registerRemotePushToken(token) }
      },
      onFailure: { [weak self] message in
        guard self?.mode == .paper else { return }
        // APNs registration is secondary to fail-closed startup/onboarding errors. A delayed
        // callback must not replace a legal, identity, or entitlement blocker.
        if self?.alertMessage == nil {
          self?.alertMessage = "Remote notification registration failed. \(message)"
        }
      })
  }

  var currentPlan: SubscriptionPlan {
    let selected = plans.first(where: { $0.tier == selectedPlanTier }) ?? plans[0]
    guard let maximum = effectiveMaximumActiveAgents,
      selected.tier == selectedPlanTier, maximum != selected.maximumActiveAgents
    else { return selected }
    return SubscriptionPlan(
      tier: selected.tier, productID: selected.productID, summary: selected.summary,
      features: selected.features, maximumActiveAgents: maximum,
      supportsOptions: selected.supportsOptions,
      supportsAutomaticMode: selected.supportsAutomaticMode)
  }

  func researchUniverse(for agentID: String) -> [String] {
    let tier = isOnboardingComplete ? selectedPlanTier : onboardingDraft.selectedPlan
    return researchUniverseByPlan[tier]?[agentID] ?? []
  }

  var activeAgents: [InvestmentAgent] { agents.filter(\.isActive) }
  var pendingProposals: [ActivityEvent] {
    activities.filter { $0.proposal?.state == .awaitingUserApproval }
  }
  func activeOrders(for symbol: String? = nil) -> [ActivityEvent] {
    activities.filter { event in
      guard let order = event.order, order.isCancelable else { return false }
      guard let symbol else { return true }
      return event.symbol?.caseInsensitiveCompare(symbol) == .orderedSame
    }.sorted { $0.timestamp > $1.timestamp }
  }
  var accountIsPaused: Bool {
    !activeAgents.isEmpty && activeAgents.allSatisfy { $0.runtimeStatus == .paused }
  }
  var eligibilityAssessment: EligibilityAssessment {
    EligibilityValidator.assess(onboardingDraft, gates: gates)
  }
  var investorAssessment: InvestorAssessmentResult {
    InvestorAssessmentEvaluator.evaluate(onboardingDraft)
  }
  var hasAcceptedAllRequiredDocuments: Bool {
    let requiredAcceptanceKeys = Set(legalDocuments.filter(\.required).map(\.acceptanceKey))
    return !requiredAcceptanceKeys.isEmpty
      && requiredAcceptanceKeys.isSubset(of: onboardingDraft.acceptedDocumentIDs)
  }

  func bootstrap() async {
    if let readinessChecker {
      do {
        try await readinessChecker.requireReady(for: mode)
        startupBlocker = nil
      } catch {
        startupBlocker = error.localizedDescription
        loadPhase = .failed(error.localizedDescription)
        return
      }
    }

    if let onboardingPersistence {
      do {
        if let restored = try await authClient.restoreSession() {
          try configureStoreKitIdentity(for: restored)
          onboardingDraft.isAuthenticated = true
          profile.name = restored.displayName
          profile.email = restored.email
          profile.signInMethod = "Restored WHOX session"
          let dependenciesLoaded = mode == .demo ? true : await loadOnboardingDependencies()
          let documentsLoaded = mode == .demo ? true : await loadAuthoritativeLegalDocuments()
          let progress = try await onboardingPersistence.currentProgress()
          authoritativeOnboardingCompleted = progress.completed
          if let step = OnboardingStep(rawValue: max(0, min(13, progress.currentStep - 1))) {
            onboardingDraft.step = step
          }
          if mode != .demo, documentsLoaded, progress.legalConsentsComplete {
            onboardingDraft.acceptedDocumentIDs = Set(legalDocuments.map(\.acceptanceKey))
          }
          if progress.completed, dependenciesLoaded, documentsLoaded,
            onboardingCompletionIssues.isEmpty
          {
            isOnboardingComplete = true
            defaults.set(true, forKey: StorageKey.onboardingComplete)
            applyCompletedOnboardingDraft()
          }
          persistDraft()
          await synchronizeRemoteNotifications()
        }
      } catch {
        storeKit.setAppAccountToken(nil)
        try? await authClient.clearLocalSession()
        onboardingDraft.isAuthenticated = false
        if mode != .demo {
          legalDocuments = []
          onboardingDraft.acceptedDocumentIDs = []
        }
        isOnboardingComplete = false
        defaults.removeObject(forKey: StorageKey.onboardingComplete)
        persistDraft()
        alertMessage = error.localizedDescription
      }
    }

    if mode == .demo || isOnboardingComplete || isAppReviewPreviewActive {
      await loadData()
    }
    await storeKit.start(plans: plans)
    consumePendingIntentRoute()
  }

  func loadData() async {
    if arguments.contains("-uiOffline") {
      loadPhase = .offline(
        mode == .demo
          ? "You’re offline. Showing the most recent seeded Demo snapshot."
          : "You’re offline. Paper data is unavailable, and no Demo values were substituted.")
      return
    }
    loadPhase = .loading
    do {
      async let loadedPlanCatalog = repository.planCatalog()
      async let loadedDashboard = repository.dashboard()
      async let loadedPositions = repository.positions()
      async let loadedAgents = repository.agents()
      async let loadedActivities = repository.activities()
      async let loadedRiskPolicy = repository.riskPolicy()
      let (planCatalog, dashboard, positions, agents, activities, riskPolicy) = try await (
        loadedPlanCatalog, loadedDashboard, loadedPositions, loadedAgents, loadedActivities,
        loadedRiskPolicy
      )
      applyPlanCatalog(planCatalog)
      if mode != .demo { await storeKit.loadProducts(plans: plans) }
      let authoritativeRiskPolicy = Self.normalizedRiskPolicy(riskPolicy)
      self.dashboard = dashboard
      self.positions = Self.positions(positions, applying: authoritativeRiskPolicy)
      self.agents = agents
      if arguments.contains("-uiNoActiveAgents") {
        for index in self.agents.indices {
          self.agents[index].isActive = false
          self.agents[index].runtimeStatus = .paused
        }
      }
      self.activities = activities
      self.riskPolicy = authoritativeRiskPolicy
      if mode != .demo {
        applyRemoteSettings(try await repository.settings())
      }
      self.lastRefresh = .now
      loadPhase = .loaded
      publishWidgetSnapshot()
    } catch {
      loadPhase = .failed(error.localizedDescription)
    }
  }

  func refresh() async {
    await loadData()
  }

  @discardableResult
  private func loadOnboardingDependencies() async -> Bool {
    do {
      async let loadedPlanCatalog = repository.planCatalog()
      async let loadedAgents = repository.agents()
      async let loadedRiskPolicy = repository.riskPolicy()
      let (planCatalog, agents, riskPolicy) = try await (
        loadedPlanCatalog, loadedAgents, loadedRiskPolicy
      )
      applyPlanCatalog(planCatalog)
      if mode != .demo { await storeKit.loadProducts(plans: plans) }
      let authoritativeRiskPolicy = Self.normalizedRiskPolicy(riskPolicy)
      self.agents = agents
      self.riskPolicy = authoritativeRiskPolicy
      onboardingDraft.riskPolicy = authoritativeRiskPolicy
      persistDraft()
      return true
    } catch {
      alertMessage =
        "Authoritative onboarding dependencies could not be loaded. \(error.localizedDescription)"
      return false
    }
  }

  private func applyPlanCatalog(_ context: PlanCatalogContext) {
    guard !context.plans.isEmpty else { return }
    plans = context.plans
    researchUniverseByPlan = context.researchUniverseByPlan
    effectiveMaximumActiveAgents = context.maximumActiveAgents
    authoritativeCurrentPlanTier = context.currentPlanTier
    if let currentPlanTier = context.currentPlanTier {
      selectedPlanTier = currentPlanTier
      onboardingDraft.selectedPlan = currentPlanTier
    }
  }

  func refreshLegalDocuments() async {
    guard mode != .demo else { return }
    _ = await loadAuthoritativeLegalDocuments()
  }

  func isLegalDocumentAccepted(_ document: LegalDocument) -> Bool {
    onboardingDraft.acceptedDocumentIDs.contains(document.acceptanceKey)
  }

  func toggleLegalDocumentAcceptance(_ document: LegalDocument) {
    guard legalDocuments.contains(document) else { return }
    if isLegalDocumentAccepted(document) {
      onboardingDraft.acceptedDocumentIDs.remove(document.acceptanceKey)
    } else {
      onboardingDraft.acceptedDocumentIDs.insert(document.acceptanceKey)
    }
    persistDraft()
  }

  func acceptAllLegalDocuments() {
    guard !legalDocuments.isEmpty else {
      alertMessage =
        "Current approved legal documents are unavailable. Paper setup remains blocked."
      return
    }
    onboardingDraft.acceptedDocumentIDs = Set(
      legalDocuments.filter(\.required).map(\.acceptanceKey))
    persistDraft()
  }

  @discardableResult
  private func loadAuthoritativeLegalDocuments() async -> Bool {
    guard mode != .demo else { return true }
    guard onboardingDraft.isAuthenticated, let onboardingPersistence else {
      clearAuthoritativeLegalDocuments()
      alertMessage =
        "Sign in to load the current approved legal documents. Paper setup remains blocked."
      return false
    }
    do {
      let documents = try LegalDocumentCatalog.validateAuthoritative(
        await onboardingPersistence.currentLegalDocuments())
      reconcileLegalAcknowledgements(with: documents)
      persistDraft()
      return true
    } catch {
      clearAuthoritativeLegalDocuments()
      persistDraft()
      alertMessage =
        "Current approved legal documents could not be loaded. Paper setup remains blocked. \(error.localizedDescription)"
      return false
    }
  }

  private func reconcileLegalAcknowledgements(with documents: [LegalDocument]) {
    let priorDocuments = Dictionary(
      legalDocuments.map { ($0.id, $0) }, uniquingKeysWith: { current, _ in current })
    let priorAcknowledgements = onboardingDraft.acceptedDocumentIDs
    let retainedAcknowledgements = documents.reduce(into: Set<String>()) { retained, document in
      guard let prior = priorDocuments[document.id],
        prior.version == document.version,
        prior.contentSHA256 == document.contentSHA256,
        priorAcknowledgements.contains(prior.acceptanceKey)
      else { return }
      retained.insert(document.acceptanceKey)
    }
    legalDocuments = documents
    onboardingDraft.acceptedDocumentIDs = retainedAcknowledgements
  }

  private func clearAuthoritativeLegalDocuments() {
    legalDocuments = []
    onboardingDraft.acceptedDocumentIDs = []
  }

  func chartPoints(for range: ChartRange) -> [PortfolioPoint] {
    Array(dashboard.history.suffix(range.sampleCount))
  }

  func handleAppleAuthorization(
    _ result: Result<ASAuthorization, any Error>, rawNonce: String?
  ) async {
    do {
      let payload = try appleAuthentication.payload(from: result, rawNonce: rawNonce)
      let authenticatedSession = try await authClient.exchangeAppleCredential(payload)
      do {
        try configureStoreKitIdentity(for: authenticatedSession)
      } catch {
        storeKit.setAppAccountToken(nil)
        try? await authClient.clearLocalSession()
        throw error
      }
      if mode != .demo { clearAuthoritativeLegalDocuments() }
      onboardingDraft.isAuthenticated = true
      profile.name = authenticatedSession.displayName
      profile.email = authenticatedSession.email
      profile.signInMethod = "Sign in with Apple"
      persistDraft()
      await synchronizeRemoteNotifications()
      _ = await advanceOnboarding()
    } catch {
      alertMessage = error.localizedDescription
    }
  }

  func useDemoIdentity() async {
    guard mode == .demo else {
      alertMessage =
        "The App Review Demo identity is available only in an explicit Demo configuration."
      return
    }
    onboardingDraft.isAuthenticated = true
    profile.signInMethod = "App Review Demo identity"
    persistDraft()
    _ = await advanceOnboarding()
  }

  func requestNotificationAuthorization() async {
    let granted = await notificationAuthorization.request()
    onboardingDraft.notificationRequested = true
    persistDraft()
    if granted {
      if let token = notificationAuthorization.remoteToken {
        await registerRemotePushToken(token)
      }
    } else {
      await unregisterRemotePushTokenIfNeeded()
    }
  }

  func enableDeviceSecurity() async {
    do {
      try await localAuthentication.authenticate(
        reason: "Enable authentication for sensitive Treasury controls")
      preferences.faceIDEnabled = true
      onboardingDraft.deviceSecurityEnabled = true
      persistPreferences()
      persistDraft()
      Haptics.success(enabled: preferences.hapticsEnabled)
    } catch {
      alertMessage = error.localizedDescription
    }
  }

  func adoptCompletedPairing() {
    guard let connected = pairingService.connectedConnection else { return }
    connection = connected
    Haptics.success(enabled: preferences.hapticsEnabled)
  }

  func openAppReviewDemo() {
    guard mode == .demo else {
      alertMessage = "App Review preview is unavailable in a Paper configuration."
      return
    }
    isAppReviewPreviewActive = true
    profile.signInMethod = "No account — local App Review preview"
    selectedPlanTier = .equity
  }

  var canAdvanceOnboarding: Bool { onboardingIssuesForCurrentStep.isEmpty }

  @discardableResult
  func advanceOnboarding() async -> Bool {
    if mode != .demo {
      switch onboardingDraft.step {
      case .signIn:
        guard await loadOnboardingDependencies(), await loadAuthoritativeLegalDocuments() else {
          return false
        }
      case .deviceSecurity, .finalReview:
        guard await loadAuthoritativeLegalDocuments() else { return false }
      default: break
      }
    }
    let issues = onboardingIssuesForCurrentStep
    guard issues.isEmpty else {
      alertMessage = issues.joined(separator: "\n")
      return false
    }
    guard let next = onboardingDraft.step.next else { return false }

    if let onboardingPersistence, onboardingDraft.step != .welcome {
      do {
        switch onboardingDraft.step {
        case .eligibility:
          let decision = try await onboardingPersistence.recordEligibility(onboardingDraft)
          guard decision.isEligible else {
            alertMessage =
              (["The server did not approve eligibility."] + decision.messages)
              .joined(separator: "\n")
            return false
          }
          if mode != .demo, !(await loadAuthoritativeLegalDocuments()) { return false }
        case .investorProfile:
          let decision = try await onboardingPersistence.recordRiskAssessment(onboardingDraft)
          let local = investorAssessment
          guard decision.classification == local.riskClassification,
            decision.optionsClassification == local.optionsClassification
          else {
            alertMessage =
              "The server assessment did not match the displayed classification. Setup remains blocked until the answer and scoring versions are reconciled."
            return false
          }
          if mode != .demo, !(await loadAuthoritativeLegalDocuments()) { return false }
        case .finalReview:
          guard try await onboardingPersistence.recordLegalConsents(legalDocuments) else {
            alertMessage = "The server did not confirm every required current legal consent."
            return false
          }
        default: break
        }
        let progress = try await onboardingPersistence.persistStep(next.rawValue + 1)
        guard progress.currentStep >= next.rawValue + 1 else {
          alertMessage = "The server did not confirm this onboarding step."
          return false
        }
        authoritativeOnboardingCompleted = progress.completed
      } catch {
        alertMessage = error.localizedDescription
        return false
      }
    }
    onboardingDraft.step = next
    persistDraft()
    return true
  }

  func retreatOnboarding() {
    guard let previous = onboardingDraft.step.previous else { return }
    onboardingDraft.step = previous
    persistDraft()
  }

  @discardableResult
  func completeOnboarding() -> Bool {
    var issues = onboardingCompletionIssues
    if onboardingPersistence != nil, !authoritativeOnboardingCompleted {
      issues.append("The WHOX server has not authoritatively completed onboarding.")
    }
    guard onboardingDraft.step == .completion, issues.isEmpty else {
      alertMessage =
        (["Onboarding is not complete."] + issues).joined(separator: "\n")
      return false
    }

    applyCompletedOnboardingDraft()
    isOnboardingComplete = true
    defaults.set(true, forKey: StorageKey.onboardingComplete)
    persistDraft()
    Haptics.success(enabled: preferences.hapticsEnabled)
    return true
  }

  func resetDemo() {
    defaults.removeObject(forKey: StorageKey.onboardingComplete)
    defaults.removeObject(forKey: StorageKey.legacyOnboardingComplete)
    defaults.removeObject(forKey: StorageKey.onboardingDraft)
    defaults.removeObject(forKey: StorageKey.legacyOnboardingDraft)
    onboardingDraft = OnboardingDraft(riskPolicy: DemoFixtures.recommendedRiskPolicy)
    isOnboardingComplete = false
    isAppReviewPreviewActive = false
    mode = .demo
    selectedPlanTier = .equity
    plans = DemoFixtures.plans
    researchUniverseByPlan = Dictionary(
      uniqueKeysWithValues: PlanTier.allCases.map { tier in
        (
          tier,
          Dictionary(
            uniqueKeysWithValues: DemoFixtures.agents.map { ($0.id, ["AAPL", "MSFT", "VTI"]) })
        )
      })
    effectiveMaximumActiveAgents = nil
    authoritativeCurrentPlanTier = nil
    dashboard = DemoFixtures.dashboard
    positions = DemoFixtures.positions
    agents = DemoFixtures.agents
    activities = DemoFixtures.activities
    riskPolicy = DemoFixtures.recommendedRiskPolicy
    legalDocuments = DemoFixtures.legalDocuments
    connection = BrokerConnection(
      status: .disconnected, maskedAccount: nil, accountType: nil,
      capabilities: [], optionsPermission: "Not connected", lastSync: nil)
    profile = UserProfile(
      name: "Alex Morgan", email: "review@whox.ai", signInMethod: "Demo identity",
      jurisdiction: "Not assessed", riskClassification: "Not assessed")
    selectedTab = .home
  }

  func canSelectOnboardingAgent(_ agent: InvestmentAgent) -> Bool {
    guard agent.availability == .available || agent.availability == .paperOnly else { return false }
    guard agent.requiredPlan == onboardingDraft.selectedPlan || agent.requiredPlan == .equity else {
      return false
    }
    if agent.assetClass.localizedCaseInsensitiveContains("options") {
      return investorAssessment.optionsClassification == .eligiblePendingBrokerPermission
    }
    if agent.riskCategory == .growth {
      return [.growth, .aggressive].contains(investorAssessment.riskClassification)
    }
    return agent.riskCategory != .optionsRestricted
  }

  func selectOnboardingAgent(_ agent: InvestmentAgent) {
    guard canSelectOnboardingAgent(agent) else {
      if agent.assetClass.localizedCaseInsensitiveContains("options"),
        investorAssessment.optionsClassification == .restricted
      {
        alertMessage =
          "Your current internal assessment keeps options strategies restricted. Review your answers; a subscription never overrides this restriction or broker permission."
      } else if agent.availability != .available && agent.availability != .paperOnly {
        alertMessage =
          "This agent is unavailable until its plan, permission, and compliance requirements are met."
      } else if agent.riskCategory == .growth {
        alertMessage =
          "This growth strategy is outside the current internal risk classification. Choose a compatible strategy or review your answers."
      } else {
        alertMessage = "\(agent.requiredPlan.title) is required for this agent."
      }
      return
    }
    onboardingDraft.selectedAgentID = agent.id
    persistDraft()
  }

  func selectOnboardingPlan(_ plan: SubscriptionPlan) {
    guard plans.contains(where: { $0.id == plan.id }) else {
      alertMessage = "This plan is no longer present in the current catalog. Refresh and try again."
      return
    }
    guard mode == .demo || authoritativeCurrentPlanTier == plan.tier else {
      alertMessage =
        "Purchase or restore this plan first. Paper setup uses only the plan currently authorized by the WHOX server."
      return
    }
    onboardingDraft.selectedPlan = plan.tier
    persistDraft()
  }

  func purchaseOnboardingPlan(_ plan: SubscriptionPlan) async {
    guard plans.contains(where: { $0.id == plan.id }) else {
      alertMessage = "This plan is no longer present in the current catalog. Refresh and try again."
      return
    }
    guard mode == .paper else {
      selectOnboardingPlan(plan)
      return
    }
    await storeKit.purchase(plan)
    guard case .purchased(let productID) = storeKit.phase,
      productID == plan.productID
    else { return }
    do {
      let context = try await repository.planCatalog()
      applyPlanCatalog(context)
      await storeKit.loadProducts(plans: plans)
      guard authoritativeCurrentPlanTier == plan.tier else {
        alertMessage =
          "The App Store purchase was verified, but the WHOX server has not authorized this plan yet. Restore or refresh after entitlement reconciliation completes."
        return
      }
      persistDraft()
    } catch {
      alertMessage =
        "The purchase was verified, but the current server plan could not be refreshed. Agent activation remains blocked until refresh succeeds. \(error.localizedDescription)"
    }
  }

  func restoreOnboardingPurchases() async {
    await storeKit.restorePurchases()
    guard mode == .paper else { return }
    do {
      applyPlanCatalog(try await repository.planCatalog())
      await storeKit.loadProducts(plans: plans)
      persistDraft()
    } catch {
      alertMessage =
        "Purchases were checked, but the current server plan could not be refreshed. \(error.localizedDescription)"
    }
  }

  func setMode(_ requested: TreasuryMode) {
    guard requested == mode else {
      alertMessage =
        requested == .live
        ? "Live mode is locked. Brokerage, legal, compliance, financial-entity, and trading release gates are all disabled."
        : "Runtime mode is fixed by the signed app configuration. Seeded Demo values cannot be relabeled as Paper."
      return
    }
  }

  func togglePrivacy() async {
    preferences.privacyMode.toggle()
    persistPreferences()
    if mode != .demo { await saveRemotePreferences() }
  }

  func pauseAllAgents() async {
    do {
      try await repository.pauseAll()
    } catch {
      alertMessage = error.localizedDescription
      return
    }
    for index in agents.indices where agents[index].isActive {
      agents[index].runtimeStatus = .paused
    }
    activities.insert(
      ActivityEvent(
        id: "pause-\(UUID().uuidString)", type: .riskEvent, timestamp: .now, agentName: nil,
        symbol: nil,
        status: "Paused",
        summary:
          "All agent scheduling and new submissions paused. Existing positions were left unchanged.",
        mode: mode, proposal: nil, order: nil, agentRun: nil,
        riskEvent: RiskEventDetail(
          rule: "User global pause", observedValue: "Requested", threshold: "Immediate",
          response: "Scheduling stopped; queued unsubmitted work canceled", resolvedAt: nil)),
      at: 0
    )
    Haptics.warning(enabled: preferences.hapticsEnabled)
    publishWidgetSnapshot()
  }

  func resumeAllAgents() async {
    do {
      try await localAuthentication.authenticate(
        reason: "Resume agent monitoring and allow future proposals")
      try await repository.resumeAll()
      for index in agents.indices where agents[index].isActive {
        agents[index].runtimeStatus = .monitoring
      }
      Haptics.success(enabled: preferences.hapticsEnabled)
      publishWidgetSnapshot()
    } catch {
      alertMessage = error.localizedDescription
    }
  }

  func toggleAgent(_ id: String) async {
    guard let index = agents.firstIndex(where: { $0.id == id }) else { return }
    if agents[index].isActive {
      if agents[index].runtimeStatus == .paused,
        agents[index].availability != .available && agents[index].availability != .paperOnly
      {
        alertMessage = "This agent is on a release hold and cannot be resumed."
        return
      }
      do {
        if agents[index].runtimeStatus == .paused {
          try await localAuthentication.authenticate(reason: "Resume this investment agent")
        }
        if mode == .demo {
          agents[index].runtimeStatus =
            agents[index].runtimeStatus == .paused ? .monitoring : .paused
        } else {
          guard let activationID = agents[index].activationID else {
            throw HTTPRepositoryError.invalidResponse
          }
          if agents[index].runtimeStatus == .paused {
            try await repository.resumeAgent(activationID: activationID)
          } else {
            try await repository.pauseAgent(activationID: activationID)
          }
          agents = try await repository.agents()
        }
        if agents.first(where: { $0.id == id })?.runtimeStatus == .paused {
          Haptics.warning(enabled: preferences.hapticsEnabled)
        } else {
          Haptics.success(enabled: preferences.hapticsEnabled)
        }
      } catch {
        alertMessage = error.localizedDescription
      }
      return
    }

    guard agents[index].availability == .available || agents[index].availability == .paperOnly
    else {
      alertMessage =
        agents[index].availability == .locked
        ? "\(agents[index].requiredPlan.title) and required brokerage permissions are needed to activate this agent."
        : "This agent is unavailable while its compliance release is on hold."
      return
    }
    guard activeAgents.count < currentPlan.maximumActiveAgents else {
      alertMessage =
        "Your plan supports up to \(currentPlan.maximumActiveAgents) active agent(s). Pause another agent first."
      return
    }
    if mode != .demo {
      alertMessage =
        "Configure a symbol, target order amount, allocation, and approval mode before activating this Paper agent."
      return
    }
    agents[index].isActive = true
    agents[index].runtimeStatus = .monitoring
    agents[index].operatingMode = .observe
    agents[index].allocationPercent = min(20, riskPolicy.maximumAllocationPercent)
  }

  func updateAgentConfiguration(
    id: String,
    allocation: Double,
    operatingMode: AgentOperatingMode,
    symbol: String,
    targetOrderAmount: Double
  ) async -> Bool {
    guard let index = agents.firstIndex(where: { $0.id == id }) else { return false }
    guard agents[index].availability == .available || agents[index].availability == .paperOnly
    else {
      alertMessage =
        "This catalog definition is on a release hold and cannot be activated or configured."
      return false
    }
    guard allocation > 0, allocation <= riskPolicy.maximumAllocationPercent else {
      alertMessage = "Agent allocation must be positive and within the global allocation cap."
      return false
    }
    if operatingMode == .automaticWithinLimits, !gates.canEnableAutonomousMode {
      alertMessage =
        "Automatic mode is locked until all Live and autonomous release gates are approved."
      return false
    }
    let normalizedSymbol = symbol.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    guard
      normalizedSymbol.range(of: "^[A-Z][A-Z0-9.-]{0,14}$", options: .regularExpression) != nil
    else {
      alertMessage = "Enter one valid ticker symbol before saving the agent configuration."
      return false
    }
    let availableSymbols = researchUniverse(for: id)
    guard availableSymbols.contains(normalizedSymbol) else {
      alertMessage =
        availableSymbols.isEmpty
        ? "The current plan has no published symbol universe for this agent. Refresh before saving."
        : "Choose one of the symbols published for this plan: \(availableSymbols.joined(separator: ", "))."
      return false
    }
    guard targetOrderAmount > 0, targetOrderAmount <= riskPolicy.maximumOrderAmount else {
      alertMessage = "Target order amount must be positive and within the global new-order limit."
      return false
    }
    if agents[index].activationID == nil {
      guard activeAgents.count < currentPlan.maximumActiveAgents else {
        alertMessage =
          "Your plan supports up to \(currentPlan.maximumActiveAgents) active agent(s). Pause another agent before activating this one."
        return false
      }
    }

    if mode == .demo {
      agents[index].allocationPercent = allocation
      agents[index].operatingMode = operatingMode
      agents[index].configuredSymbol = normalizedSymbol
      agents[index].targetOrderAmount = targetOrderAmount
      Haptics.success(enabled: preferences.hapticsEnabled)
      return true
    }

    let input = AgentConfigurationInput(
      allocationPercent: allocation, operatingMode: operatingMode, symbol: normalizedSymbol,
      targetOrderAmount: targetOrderAmount)
    do {
      if let activationID = agents[index].activationID {
        try await repository.updateAgent(activationID: activationID, configuration: input)
      } else {
        try await repository.activateAgent(definitionID: id, configuration: input)
      }
      agents = try await repository.agents()
      Haptics.success(enabled: preferences.hapticsEnabled)
      return true
    } catch {
      alertMessage = error.localizedDescription
      return false
    }
  }

  func approveProposal(_ proposalID: String) async {
    do {
      try await localAuthentication.authenticate(
        reason: "Approve and submit this \(mode.title) trade proposal")
      let updated = try await repository.approveProposal(id: proposalID, mode: mode)
      if let index = activities.firstIndex(where: { $0.proposal?.id == proposalID }) {
        activities[index] = updated
      }
      Haptics.success(enabled: preferences.hapticsEnabled)
    } catch {
      alertMessage = error.localizedDescription
    }
  }

  func rejectProposal(_ proposalID: String) async {
    do {
      let updated = try await repository.rejectProposal(id: proposalID)
      if let index = activities.firstIndex(where: { $0.proposal?.id == proposalID }) {
        activities[index] = updated
      }
    } catch {
      alertMessage = error.localizedDescription
    }
  }

  func cancelOrder(_ orderID: String) async {
    guard !orderCancellationsInFlight.contains(orderID),
      activities.contains(where: { $0.id == orderID && $0.order?.isCancelable == true })
    else { return }
    orderCancellationsInFlight.insert(orderID)
    defer { orderCancellationsInFlight.remove(orderID) }
    do {
      try await localAuthentication.authenticate(
        reason: "Cancel this \(mode.title) order and release its remaining reservation")
      let updated = try await repository.cancelOrder(id: orderID)
      guard updated.id == orderID, updated.order?.status == .canceled else {
        throw HTTPRepositoryError.invalidResponse
      }
      if let index = activities.firstIndex(where: { $0.id == orderID }) {
        activities[index] = updated
      } else {
        activities.insert(updated, at: 0)
      }
      Haptics.success(enabled: preferences.hapticsEnabled)
    } catch {
      alertMessage = error.localizedDescription
    }
  }

  func recordDemoProposalAdjustment(proposalID: String, quantity: Double) {
    guard mode == .demo else {
      alertMessage =
        "Proposal adjustment is unavailable because no authoritative Paper revision endpoint is configured. Reject the proposal or review it without changes."
      return
    }
    guard let proposal = activities.compactMap(\.proposal).first(where: { $0.id == proposalID }),
      quantity > 0
    else {
      alertMessage = "Enter a positive proposal quantity."
      return
    }
    let perUnit = proposal.estimatedNotional / max(proposal.quantity, 0.0001)
    let revisedNotional = quantity * perUnit
    guard revisedNotional <= riskPolicy.maximumOrderAmount else {
      alertMessage = "The revised estimated notional exceeds your maximum new-order limit."
      return
    }
    activities.insert(
      ActivityEvent(
        id: "adjust-\(UUID().uuidString)", type: .proposal, timestamp: .now,
        agentName: proposal.agentName,
        symbol: proposal.symbol, status: "Revision requested",
        summary:
          "Requested a Demo revision to \(FinancialFormatters.quantity(quantity)) unit(s), estimated \(FinancialFormatters.currency(revisedNotional)). The original remains unsubmitted.",
        mode: mode, proposal: nil, order: nil, agentRun: nil, riskEvent: nil
      ),
      at: 0
    )
    alertMessage =
      "Demo revision requested. A fresh proposal and risk review would be required before approval."
  }

  func saveRiskPolicy(_ updated: RiskPolicy) async -> Bool {
    let candidate = Self.normalizedRiskPolicy(updated)
    let issues = RiskPolicyValidator.validate(candidate)
    guard issues.isEmpty else {
      alertMessage = issues.map(\.message).joined(separator: "\n")
      return false
    }
    do {
      try await localAuthentication.authenticate(reason: "Save major investment risk limits")
      let authoritative = Self.normalizedRiskPolicy(
        try await repository.saveRiskPolicy(candidate))
      let authoritativeIssues = RiskPolicyValidator.validate(authoritative)
      guard authoritativeIssues.isEmpty else {
        alertMessage =
          "The saved risk policy could not be verified. Existing risk settings remain unchanged."
        return false
      }
      applyAuthoritativeRiskPolicy(authoritative)
      Haptics.success(enabled: preferences.hapticsEnabled)
      return true
    } catch {
      alertMessage = error.localizedDescription
      return false
    }
  }

  func toggleWatchlist(positionID: String) {
    guard mode == .demo else {
      alertMessage =
        "Watchlist editing is unavailable until a server-confirmed Paper watchlist endpoint is enabled."
      return
    }
    guard let index = positions.firstIndex(where: { $0.id == positionID }) else { return }
    positions[index].isWatchlisted.toggle()
  }

  func exclusionUpdateIsInFlight(positionID: String) -> Bool {
    exclusionUpdatesInFlight.contains(positionID)
  }

  func toggleExclusion(positionID: String) async {
    guard !exclusionUpdatesInFlight.contains(positionID),
      let position = positions.first(where: { $0.id == positionID })
    else { return }
    let symbol = Self.canonicalSymbol(position.symbol)
    guard !symbol.isEmpty else {
      alertMessage = "This position has no valid symbol, so its exclusion was not changed."
      return
    }

    exclusionUpdatesInFlight.insert(positionID)
    defer { exclusionUpdatesInFlight.remove(positionID) }

    var candidate = Self.normalizedRiskPolicy(riskPolicy)
    if position.isExcluded {
      candidate.excludedSymbols.removeAll { Self.canonicalSymbol($0) == symbol }
    } else {
      candidate.excludedSymbols.append(symbol)
    }
    candidate = Self.normalizedRiskPolicy(candidate)

    let issues = RiskPolicyValidator.validate(candidate)
    guard issues.isEmpty else {
      alertMessage = issues.map(\.message).joined(separator: "\n")
      return
    }

    do {
      let authoritative = Self.normalizedRiskPolicy(
        try await repository.saveRiskPolicy(candidate))
      let authoritativeIssues = RiskPolicyValidator.validate(authoritative)
      guard authoritativeIssues.isEmpty else {
        alertMessage =
          "The saved exclusion could not be verified. Existing risk settings remain unchanged."
        return
      }
      applyAuthoritativeRiskPolicy(authoritative)
      Haptics.success(enabled: preferences.hapticsEnabled)
    } catch {
      alertMessage =
        "The exclusion was not changed because WHOX could not confirm it. \(error.localizedDescription)"
    }
  }

  func createDemoCloseReview(positionID: String, quantity: Double) async {
    guard mode == .demo else {
      alertMessage =
        "Close-review creation is unavailable because no authoritative Paper close-proposal endpoint is configured. Review the position at the brokerage."
      return
    }
    guard let position = positions.first(where: { $0.id == positionID }), quantity > 0,
      quantity <= position.quantity
    else {
      alertMessage = "Choose a positive quantity no greater than the open position."
      return
    }
    do {
      try await localAuthentication.authenticate(
        reason: "Create a reviewed Demo closing proposal for \(position.symbol)")
      activities.insert(
        ActivityEvent(
          id: "close-review-\(UUID().uuidString)", type: .proposal, timestamp: .now,
          agentName: "User close review", symbol: position.symbol, status: "Draft review",
          summary:
            "A Demo closing review for \(FinancialFormatters.quantity(quantity)) unit(s) was created. No order was submitted.",
          mode: mode, proposal: nil, order: nil, agentRun: nil, riskEvent: nil
        ),
        at: 0
      )
      Haptics.success(enabled: preferences.hapticsEnabled)
      alertMessage =
        "Demo close review created. No order was submitted and no execution price is guaranteed."
    } catch {
      alertMessage = error.localizedDescription
    }
  }

  func handle(url: URL) {
    guard let route = TreasuryRoute.parse(url) else {
      alertMessage = "That Metis link is not supported."
      return
    }
    navigate(to: route)
  }

  func navigate(to route: TreasuryRoute) {
    switch route {
    case .dashboard:
      selectedTab = .home
      presentedRoute = nil
    case .pendingProposals, .activity:
      selectedTab = .activity
      presentedRoute = route
    case .activeAgent, .agent:
      selectedTab = .agents
      presentedRoute = route
    case .riskControls, .pauseAllReview:
      selectedTab = .settings
      presentedRoute = route
    case .position:
      selectedTab = .portfolio
      presentedRoute = route
    }
  }

  func handleScenePhase(active: Bool) async {
    if !active {
      isPrivacyShieldVisible = true
      if preferences.faceIDEnabled { isAppLocked = true }
      return
    }
    isPrivacyShieldVisible = false
    await synchronizeRemoteNotifications()
    guard isAppLocked else {
      consumePendingIntentRoute()
      return
    }
    do {
      try await localAuthentication.authenticate(reason: "Unlock sensitive Treasury information")
      isAppLocked = false
      consumePendingIntentRoute()
    } catch {
      alertMessage = error.localizedDescription
    }
  }

  func unlockApp() async {
    do {
      try await localAuthentication.authenticate(reason: "Unlock sensitive Treasury information")
      isAppLocked = false
    } catch { alertMessage = error.localizedDescription }
  }

  func persistPreferences() {
    if let encoded = try? JSONEncoder().encode(preferences) {
      defaults.set(encoded, forKey: StorageKey.preferences)
    }
  }

  func saveRemotePreferences() async {
    persistPreferences()
    guard mode != .demo, onboardingDraft.isAuthenticated else { return }
    do {
      let saved = try await repository.saveSettings(remoteSettingsFromPreferences())
      applyRemoteSettings(saved)
      persistPreferences()
    } catch {
      if let authoritative = try? await repository.settings() {
        applyRemoteSettings(authoritative)
        persistPreferences()
      }
      alertMessage =
        "Paper settings were not confirmed by the server and were restored to the last authoritative values. \(error.localizedDescription)"
    }
  }

  private func remoteSettingsFromPreferences() -> RemoteSettings {
    let notifications = preferences.notificationPreferences
    return RemoteSettings(
      privacyMode: preferences.privacyMode,
      appearance: preferences.appearance,
      notifications: RemoteNotificationSettings(
        detailedPreviewsEnabled: notifications.detailedPreviewsEnabled,
        // This target has no Apple Critical Alerts entitlement, so the client must not request
        // or persist a delivery capability it cannot honor.
        criticalNotificationsEnabled: false,
        quietHoursStartMinute: notifications.quietHoursStartHourUTC.map { $0 * 60 },
        quietHoursEndMinute: notifications.quietHoursEndHourUTC.map { $0 * 60 },
        quietHoursUTCOffsetMinutes: notifications.quietHoursUTCOffsetMinutes))
  }

  private func applyRemoteSettings(_ settings: RemoteSettings) {
    preferences.privacyMode = settings.privacyMode
    preferences.appearance = settings.appearance
    preferences.notificationPreferences.detailedPreviewsEnabled =
      settings.notifications.detailedPreviewsEnabled
    preferences.notificationPreferences.criticalNotificationsEnabled = false
    preferences.notificationPreferences.quietHoursStartHourUTC =
      settings.notifications.quietHoursStartMinute.map { $0 / 60 }
    preferences.notificationPreferences.quietHoursEndHourUTC =
      settings.notifications.quietHoursEndMinute.map { $0 / 60 }
    preferences.notificationPreferences.quietHoursUTCOffsetMinutes =
      settings.notifications.quietHoursUTCOffsetMinutes
  }

  private func registerRemotePushToken(_ token: String) async {
    guard mode == .paper, onboardingDraft.isAuthenticated else { return }
    do {
      try await repository.registerPushToken(
        token, environment: notificationAuthorization.apnsEnvironment)
      defaults.set(true, forKey: StorageKey.pushTokenRegistered)
    } catch {
      alertMessage =
        "Remote notifications are not registered with WHOX. \(error.localizedDescription)"
    }
  }

  private func unregisterRemotePushTokenIfNeeded() async {
    guard mode == .paper, onboardingDraft.isAuthenticated,
      defaults.bool(forKey: StorageKey.pushTokenRegistered)
    else { return }
    do {
      try await repository.unregisterPushToken()
      defaults.removeObject(forKey: StorageKey.pushTokenRegistered)
    } catch {
      alertMessage =
        "Remote notification removal was not confirmed. Sign-out remains blocked until the server can revoke this device token. \(error.localizedDescription)"
    }
  }

  private func synchronizeRemoteNotifications() async {
    guard mode == .paper, onboardingDraft.isAuthenticated else { return }
    if await notificationAuthorization.refreshRemoteRegistration() {
      if let token = notificationAuthorization.remoteToken {
        await registerRemotePushToken(token)
      }
    } else {
      await unregisterRemotePushTokenIfNeeded()
    }
  }

  func disconnectBroker() async {
    _ = await revokeBrokerConnection(
      reason: "Disconnect the Robinhood Agentic Account", recordActivity: true)
  }

  func prepareBrokerReconnect() async -> Bool {
    await revokeBrokerConnection(
      reason: "Reconnect the Robinhood Agentic Account", recordActivity: false)
  }

  private func revokeBrokerConnection(reason: String, recordActivity: Bool) async -> Bool {
    do {
      try await localAuthentication.authenticate(reason: reason)
      try await pairingService.prepareReconnect()
      connection = BrokerConnection(
        status: .disconnected, maskedAccount: nil, accountType: nil,
        capabilities: [], optionsPermission: "Not connected", lastSync: nil)
      if recordActivity {
        activities.insert(
          ActivityEvent(
            id: "disconnect-\(UUID().uuidString)", type: .account, timestamp: .now,
            agentName: nil, symbol: nil, status: "Disconnected",
            summary:
              "\(mode.title) brokerage access disconnected. Existing positions were not changed.",
            mode: mode, proposal: nil, order: nil, agentRun: nil, riskEvent: nil), at: 0
        )
      }
      publishWidgetSnapshot()
      return true
    } catch {
      alertMessage = error.localizedDescription
      return false
    }
  }

  func setDeviceSecurityEnabled(_ enabled: Bool) async {
    if enabled {
      await enableDeviceSecurity()
    } else {
      preferences.faceIDEnabled = false
      persistPreferences()
    }
  }

  func signOutOtherDevices() async {
    do {
      try await localAuthentication.authenticate(reason: "Sign out all other Metis devices")
      let count = try await authClient.revokeOtherSessions()
      alertMessage =
        mode == .demo
        ? "No other server sessions exist for the local Demo identity."
        : "Revoked \(count) other WHOX session\(count == 1 ? "" : "s"). This device remains signed in."
    } catch { alertMessage = error.localizedDescription }
  }

  func signOut() async {
    do {
      if mode == .paper, defaults.bool(forKey: StorageKey.pushTokenRegistered) {
        try await repository.unregisterPushToken()
        defaults.removeObject(forKey: StorageKey.pushTokenRegistered)
      }
      try await authClient.logout()
      clearSignedOutState()
      alertMessage = "Signed out. Server revocation and local credential removal completed."
    } catch {
      alertMessage =
        "Sign-out revocation could not be confirmed, so this device retained the session for a safe retry. \(error.localizedDescription)"
    }
  }

  @discardableResult
  func deleteAccount(confirmation: String) async -> Bool {
    guard confirmation == "DELETE" else {
      alertMessage = "Type DELETE exactly to confirm account deletion."
      return false
    }
    do {
      try await localAuthentication.authenticate(reason: "Delete this Metis account")
    } catch {
      alertMessage = error.localizedDescription
      return false
    }

    let disposition: AccountDeletionDisposition
    do {
      if mode == .paper, defaults.bool(forKey: StorageKey.pushTokenRegistered) {
        try await repository.unregisterPushToken()
        defaults.removeObject(forKey: StorageKey.pushTokenRegistered)
      }
      disposition = try await repository.requestAccountDeletion()
    } catch {
      alertMessage =
        "Account deletion was not accepted, so local account state was retained. \(error.localizedDescription)"
      return false
    }

    do {
      try await authClient.clearLocalSession()
      resetAccountState()
      clearDeletedAccountLocalState()
      switch disposition {
      case .localDemoReset:
        alertMessage =
          "The local Demo account and onboarding answers were deleted. No server account existed."
      case .serverAccepted(let brokerRevocationPending):
        alertMessage =
          brokerRevocationPending
          ? "Account closure was accepted and local access was removed. Broker authorization revocation is durably queued and still pending provider confirmation. Records required by law remain restricted and retained."
          : "Account closure was accepted, local access was removed, and no broker revocation remains pending. Records required by law remain restricted and retained."
      }
      return true
    } catch {
      resetAccountState()
      clearDeletedAccountLocalState()
      switch disposition {
      case .localDemoReset:
        alertMessage =
          "The Demo account was reset, but local credential removal could not be verified. Do not reuse this installation; contact support. \(error.localizedDescription)"
      case .serverAccepted(let brokerRevocationPending):
        let revocationStatus =
          brokerRevocationPending
          ? " Broker authorization revocation is queued and pending provider confirmation."
          : " No broker revocation remains pending."
        alertMessage =
          "Account closure was accepted by the WHOX service, but local credential removal could not be verified.\(revocationStatus) Do not reuse this installation; contact support. \(error.localizedDescription)"
      }
      return true
    }
  }

  func recordSupportTicket(subject: String, message: String) {
    guard mode == .demo else {
      alertMessage = "Open the WHOX support site to create a server-tracked support request."
      return
    }
    guard !subject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else {
      alertMessage = "Add a subject and description before sending the support request."
      return
    }
    activities.insert(
      ActivityEvent(
        id: "support-\(UUID().uuidString)", type: .account, timestamp: .now, agentName: nil,
        symbol: nil, status: "Support request created", summary: subject, mode: mode,
        proposal: nil, order: nil, agentRun: nil, riskEvent: nil), at: 0
    )
    alertMessage =
      "Demo support request recorded. No financial values or brokerage credentials were included."
  }

  func exportDemoData() throws -> URL {
    struct Export: Codable {
      let exportedAt: Date
      let mode: TreasuryMode
      let profile: UserProfile
      let positions: [Position]
      let activities: [ActivityEvent]
    }
    let export = Export(
      exportedAt: .now, mode: mode, profile: profile, positions: positions, activities: activities)
    let data = try JSONEncoder().encode(export)
    let url = FileManager.default.temporaryDirectory.appending(
      path: "WHOX-Treasury-\(mode.title)-Export.json")
    try data.write(to: url, options: [.atomic, .completeFileProtection])
    return url
  }

  private var onboardingIssuesForCurrentStep: [String] {
    switch onboardingDraft.step {
    case .welcome:
      []
    case .signIn:
      onboardingDraft.isAuthenticated ? [] : ["Complete a verified sign-in before continuing."]
    case .eligibility:
      eligibilityAssessment.permitsDemoOnboarding ? [] : eligibilityAssessment.messages
    case .howItWorks:
      onboardingDraft.howItWorksAcknowledged
        ? [] : ["Acknowledge how the service works and the risks before continuing."]
    case .investorProfile:
      InvestorAssessmentEvaluator.validationIssues(for: onboardingDraft)
    case .subscription:
      if mode == .demo {
        plans.contains(where: { $0.tier == onboardingDraft.selectedPlan })
          ? [] : ["Choose an available plan."]
      } else if let authoritativeCurrentPlanTier,
        onboardingDraft.selectedPlan == authoritativeCurrentPlanTier
      {
        []
      } else {
        ["Purchase or restore a plan and wait for server entitlement confirmation."]
      }
    case .agent:
      selectedOnboardingAgentIsAllowed
        ? [] : ["Choose an available strategy compatible with the plan and assessment."]
    case .riskLimits:
      RiskPolicyValidator.validate(onboardingDraft.riskPolicy).map(\.message)
    case .automation:
      onboardingDraft.automationMode != .automaticWithinLimits || gates.canEnableAutonomousMode
        ? [] : ["Automatic mode is unavailable while its release gate is disabled."]
    case .connection:
      connection.status == .connected
        ? [] : ["Complete the explicit \(mode.title) connection step before continuing."]
    case .notifications, .deviceSecurity:
      []
    case .finalReview:
      onboardingCompletionIssues
    case .completion:
      []
    }
  }

  private var onboardingCompletionIssues: [String] {
    var issues: [String] = []
    if !onboardingDraft.isAuthenticated {
      issues.append("A verified identity is required.")
    }
    if !eligibilityAssessment.permitsDemoOnboarding {
      issues.append(contentsOf: eligibilityAssessment.messages)
    }
    if !onboardingDraft.howItWorksAcknowledged {
      issues.append("The service-and-risk explanation has not been acknowledged.")
    }
    issues.append(contentsOf: InvestorAssessmentEvaluator.validationIssues(for: onboardingDraft))
    if mode != .demo {
      if let authoritativeCurrentPlanTier {
        if onboardingDraft.selectedPlan != authoritativeCurrentPlanTier {
          issues.append("The selected plan does not match the current server-authorized plan.")
        }
      } else {
        issues.append("No current server-authorized subscription is available.")
      }
    }
    if !selectedOnboardingAgentIsAllowed {
      issues.append("The selected strategy is not compatible with the plan and assessment.")
    }
    issues.append(
      contentsOf: RiskPolicyValidator.validate(onboardingDraft.riskPolicy).map(\.message))
    if onboardingDraft.automationMode == .automaticWithinLimits, !gates.canEnableAutonomousMode {
      issues.append("Automatic mode remains disabled by the release gates.")
    }
    if connection.status != .connected {
      issues.append("The required \(mode.title) connection step is incomplete.")
    }
    if mode != .demo, legalDocuments.isEmpty {
      issues.append("Current approved legal documents are unavailable.")
    } else if !hasAcceptedAllRequiredDocuments {
      issues.append(
        mode == .demo
          ? "Review and accept every required Demo document fixture."
          : "Review and accept every required current legal document.")
    }
    if mode != .demo,
      legalDocuments.contains(where: {
        !$0.productionApproved || !$0.required || $0.contentURL == nil
          || $0.contentSHA256 == nil || $0.publishedAt == nil
      })
    {
      issues.append(
        "Paper onboarding is blocked because the current legal-document catalog is not approved and verifiable."
      )
    }
    return Array(Set(issues)).sorted()
  }

  private var selectedOnboardingAgentIsAllowed: Bool {
    guard let agent = agents.first(where: { $0.id == onboardingDraft.selectedAgentID }) else {
      return false
    }
    return canSelectOnboardingAgent(agent)
  }

  private func persistDraft() {
    if let encoded = try? JSONEncoder().encode(onboardingDraft) {
      defaults.set(encoded, forKey: StorageKey.onboardingDraft)
    }
  }

  private func applyCompletedOnboardingDraft() {
    selectedPlanTier = onboardingDraft.selectedPlan
    riskPolicy = onboardingDraft.riskPolicy
    profile.jurisdiction = "\(onboardingDraft.state), \(onboardingDraft.country)"
    profile.riskClassification = investorAssessment.riskClassification.title
    for index in agents.indices {
      agents[index].isActive = agents[index].id == onboardingDraft.selectedAgentID
      if agents[index].isActive {
        agents[index].operatingMode = onboardingDraft.automationMode
        agents[index].runtimeStatus = .monitoring
      } else {
        agents[index].runtimeStatus = .paused
      }
    }
  }

  private func clearDeletedAccountLocalState() {
    pairingService.clearAfterAccountDeletion()
    defaults.removeObject(forKey: StorageKey.preferences)
    preferences = AppPreferences()
    if let sharedDefaults = UserDefaults(suiteName: "group.ai.whox.treasury") {
      sharedDefaults.removeObject(forKey: "widgetSnapshot")
      sharedDefaults.removeObject(forKey: "pendingIntentURL")
    }
  }

  private func clearSignedOutState() {
    storeKit.setAppAccountToken(nil)
    authoritativeCurrentPlanTier = nil
    effectiveMaximumActiveAgents = nil
    onboardingDraft.isAuthenticated = false
    onboardingDraft.step = .signIn
    isOnboardingComplete = false
    authoritativeOnboardingCompleted = false
    isAppReviewPreviewActive = false
    if mode != .demo { clearAuthoritativeLegalDocuments() }
    defaults.removeObject(forKey: StorageKey.onboardingComplete)
    persistDraft()
    profile = UserProfile(
      name: mode == .demo ? "Alex Morgan" : "Treasury User",
      email: mode == .demo ? "review@whox.ai" : "",
      signInMethod: "Signed out",
      jurisdiction: "Not assessed",
      riskClassification: "Not assessed")
    connection = BrokerConnection(
      status: .disconnected, maskedAccount: nil, accountType: nil,
      capabilities: [], optionsPermission: "Not connected", lastSync: nil)
    if mode != .demo {
      dashboard = Self.unavailableDashboard(mode: mode)
      positions = []
      agents = []
      activities = []
    }
  }

  private func resetAccountState() {
    storeKit.setAppAccountToken(nil)
    if mode == .demo {
      resetDemo()
      return
    }
    defaults.removeObject(forKey: StorageKey.onboardingComplete)
    defaults.removeObject(forKey: StorageKey.legacyOnboardingComplete)
    defaults.removeObject(forKey: StorageKey.onboardingDraft)
    defaults.removeObject(forKey: StorageKey.legacyOnboardingDraft)
    onboardingDraft = OnboardingDraft(riskPolicy: DemoFixtures.recommendedRiskPolicy)
    selectedPlanTier = .equity
    authoritativeCurrentPlanTier = nil
    effectiveMaximumActiveAgents = nil
    isOnboardingComplete = false
    authoritativeOnboardingCompleted = false
    isAppReviewPreviewActive = false
    dashboard = Self.unavailableDashboard(mode: mode)
    positions = []
    agents = []
    activities = []
    riskPolicy = DemoFixtures.recommendedRiskPolicy
    clearAuthoritativeLegalDocuments()
    connection = BrokerConnection(
      status: .disconnected, maskedAccount: nil, accountType: nil,
      capabilities: [], optionsPermission: "Not connected", lastSync: nil)
    profile = UserProfile(
      name: "Treasury User", email: "", signInMethod: "Signed out",
      jurisdiction: "Not assessed", riskClassification: "Not assessed")
    selectedTab = .home
  }

  private func configureStoreKitIdentity(for session: AuthenticatedUserSession) throws {
    guard mode == .paper else {
      storeKit.setAppAccountToken(nil)
      return
    }
    guard let accountID = UUID(uuidString: session.userID) else {
      throw AuthClientError.invalidResponse
    }
    storeKit.setAppAccountToken(accountID)
  }

  private func consumePendingIntentRoute() {
    guard let defaults = UserDefaults(suiteName: "group.ai.whox.treasury"),
      let rawURL = defaults.string(forKey: "pendingIntentURL"),
      let url = URL(string: rawURL)
    else { return }
    defaults.removeObject(forKey: "pendingIntentURL")
    handle(url: url)
  }

  private func publishWidgetSnapshot() {
    guard let defaults = UserDefaults(suiteName: "group.ai.whox.treasury") else { return }
    let payload: [String: Any] = [
      "mode": mode.title,
      "agentStatus": activeAgents.first?.runtimeStatus.title ?? "No active agent",
      "lastRun": activeAgents.first?.lastRun?.timeIntervalSince1970 ?? 0,
      "pendingProposals": pendingProposals.count,
      "riskState": dashboard.riskState.title,
      "updatedAt": Date.now.timeIntervalSince1970,
    ]
    defaults.set(payload, forKey: "widgetSnapshot")
  }

  private static func restoreDraft(from defaults: UserDefaults) -> OnboardingDraft? {
    defaults.data(forKey: StorageKey.onboardingDraft).flatMap {
      try? JSONDecoder().decode(OnboardingDraft.self, from: $0)
    }
  }

  private static func restorePreferences(from defaults: UserDefaults) -> AppPreferences? {
    defaults.data(forKey: StorageKey.preferences).flatMap {
      try? JSONDecoder().decode(AppPreferences.self, from: $0)
    }
  }

  private func applyAuthoritativeRiskPolicy(_ policy: RiskPolicy) {
    riskPolicy = policy
    onboardingDraft.riskPolicy = policy
    positions = Self.positions(positions, applying: policy)
  }

  private static func positions(_ positions: [Position], applying policy: RiskPolicy) -> [Position]
  {
    let excluded = Set(policy.excludedSymbols.map(canonicalSymbol).filter { !$0.isEmpty })
    return positions.map { position in
      var updated = position
      updated.isExcluded = excluded.contains(canonicalSymbol(position.symbol))
      return updated
    }
  }

  private static func normalizedRiskPolicy(_ policy: RiskPolicy) -> RiskPolicy {
    var normalized = policy
    normalized.excludedSymbols = Array(
      Set(policy.excludedSymbols.map(canonicalSymbol).filter { !$0.isEmpty })
    ).sorted()
    return normalized
  }

  private static func canonicalSymbol(_ symbol: String) -> String {
    symbol.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
  }

  private static func unavailableDashboard(mode: TreasuryMode) -> DashboardSnapshot {
    DashboardSnapshot(
      accountValue: 0,
      todayChange: 0,
      todayPercent: 0,
      mode: mode,
      updatedAt: .distantPast,
      isStale: true,
      dataLabel: "\(mode.title) data unavailable · no Demo values substituted",
      history: [],
      riskState: .halted,
      riskUsages: [],
      buyingPowerReserve: 0
    )
  }

  private enum StorageKey {
    static let onboardingComplete = "onboarding.complete.v2"
    static let legacyOnboardingComplete = "onboarding.complete.v1"
    static let onboardingDraft = "onboarding.draft.v2"
    static let legacyOnboardingDraft = "onboarding.draft.v1"
    static let preferences = "preferences.v1"
    static let pushTokenRegistered = "notifications.push-token.registered.v1"
  }
}
