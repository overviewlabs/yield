import Foundation
import XCTest

@testable import WHOX_Treasury

final class CoreBehaviorTests: XCTestCase {
  func testReleaseGatesFailClosed() {
    XCTAssertFalse(ReleaseGates.locked.canEnableLiveTrading)
    XCTAssertFalse(ReleaseGates.locked.canEnableAutonomousMode)
  }

  func testCanonicalRiskCaps() {
    var policy = DemoFixtures.recommendedRiskPolicy
    policy.maximumOrderAmount = 10_001
    policy.drawdownHaltPercent = 21
    policy.maximumPositions = 31
    policy.maximumBidAskSpreadPercent = 10.5
    policy.maximumOptionsLoss = 2_501
    let ids = Set(RiskPolicyValidator.validate(policy).map(\.id))
    XCTAssertTrue(ids.isSuperset(of: ["order", "drawdown", "positions", "spread", "options-loss"]))
  }

  func testRecommendedRiskPolicyPasses() {
    XCTAssertTrue(RiskPolicyValidator.validate(DemoFixtures.recommendedRiskPolicy).isEmpty)
  }

  func testCompactJWSRequiresExactlyThreeSegments() {
    XCTAssertTrue(CompactJWS.isWellFormed("header.payload.signature"))
    XCTAssertFalse(CompactJWS.isWellFormed("header.payload"))
    XCTAssertFalse(CompactJWS.isWellFormed("header..signature"))
    let envelope = VerifiedTransactionEnvelope(
      productID: "plan", transactionID: "1", originalTransactionID: "1",
      signedTransactionJWS: "a.b.c")
    XCTAssertTrue(envelope.hasCompactJWS)
  }

  func testDeepLinkRouting() {
    XCTAssertEqual(TreasuryRoute.parse(URL(string: "whoxtreasury://dashboard")!), .dashboard)
    XCTAssertEqual(TreasuryRoute.parse(URL(string: "whoxtreasury://risk/pause")!), .pauseAllReview)
    XCTAssertEqual(
      TreasuryRoute.parse(URL(string: "whoxtreasury://activity/act-proposal")!),
      .activity("act-proposal"))
    XCTAssertNil(TreasuryRoute.parse(URL(string: "https://example.com")!))
  }

  func testPlanProductIDsAreUniqueAndCanonical() {
    let identifiers = DemoFixtures.plans.map(\.productID)
    XCTAssertEqual(Set(identifiers).count, 4)
    XCTAssertTrue(
      identifiers.allSatisfy { $0.hasPrefix("whox.treasury.") && $0.hasSuffix(".monthly") })
  }

  func testServerEntitlementProductIDsMapOnlyToKnownPlanTiers() {
    let productIDs: Set<String> = [
      "whox.treasury.equity.monthly",
      "whox.treasury.optionspro.monthly",
      "unknown.product",
    ]
    XCTAssertEqual(
      EntitlementResolver.tiers(for: productIDs, plans: DemoFixtures.plans),
      [.equity, .optionsPro]
    )
  }

  @MainActor
  func testPurchaseStateTransitionsForUnavailableProductAndMockedRestore() async {
    let unavailable = StoreKitService(arguments: ["tests"])
    await unavailable.purchase(DemoFixtures.plans[0])
    guard case .failed(let message) = unavailable.phase else {
      return XCTFail("An unloaded product must transition to failed")
    }
    XCTAssertTrue(message.localizedCaseInsensitiveContains("unavailable"))

    let restored = StoreKitService(arguments: ["tests", "-mockStoreKitRestoreSuccess"])
    await restored.restorePurchases()
    XCTAssertEqual(restored.phase, .idle)
    XCTAssertEqual(restored.statusMessage, "Purchases restored and access refreshed.")
  }

  @MainActor
  func testPaperSessionBindsAndClearsStoreKitAccountToken() async {
    let suite = "WHOX.Tests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let accountID = UUID(uuidString: "49FC57A7-C296-4FD2-B255-33290800AF2F")!
    let storeKit = StoreKitService(arguments: ["tests"])
    let session = AppSession(
      runtimeMode: .paper,
      storeKit: storeKit,
      authClient: RestoringAuthClient(userID: accountID.uuidString),
      onboardingPersistence: CompletingOnboardingPersistence(),
      defaults: defaults,
      arguments: ["tests", "-resetOnboarding"])

    await session.bootstrap()

    XCTAssertEqual(storeKit.appAccountTokenForTesting, accountID)
    XCTAssertTrue(session.onboardingDraft.isAuthenticated)

    await session.signOut()

    XCTAssertNil(storeKit.appAccountTokenForTesting)
    XCTAssertFalse(session.onboardingDraft.isAuthenticated)
  }

  @MainActor
  func testPaperSessionLoadsAuthoritativeLegalDocumentsAndClearsThemOnSignOut() async {
    let suite = "WHOX.Tests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let documents = LegalDocumentTestFixtures.paper(version: "PAPER-2026.08")
    let persistence = CompletingOnboardingPersistence(legalDocuments: documents)
    let session = AppSession(
      runtimeMode: .paper,
      authClient: RestoringAuthClient(
        userID: "49FC57A7-C296-4FD2-B255-33290800AF2F"),
      onboardingPersistence: persistence,
      defaults: defaults,
      arguments: ["tests", "-resetOnboarding"])

    await session.bootstrap()

    XCTAssertEqual(session.legalDocuments, documents)
    XCTAssertFalse(session.legalDocuments.contains { $0.version.hasPrefix("DEMO-") })

    await session.signOut()

    XCTAssertTrue(session.legalDocuments.isEmpty)
    XCTAssertFalse(session.hasAcceptedAllRequiredDocuments)
  }

  @MainActor
  func testUnavailablePaperLegalDocumentsFailClosedWithoutDemoFallback() async {
    let suite = "WHOX.Tests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let persistence = CompletingOnboardingPersistence(legalDocumentsUnavailable: true)
    let session = AppSession(
      runtimeMode: .paper,
      authClient: RestoringAuthClient(
        userID: "49FC57A7-C296-4FD2-B255-33290800AF2F"),
      onboardingPersistence: persistence,
      defaults: defaults,
      arguments: ["tests", "-resetOnboarding"])

    await session.bootstrap()

    XCTAssertTrue(session.legalDocuments.isEmpty)
    XCTAssertFalse(session.hasAcceptedAllRequiredDocuments)
    XCTAssertFalse(session.legalDocuments.contains { $0.version.hasPrefix("DEMO-") })
    XCTAssertTrue(session.alertMessage?.localizedCaseInsensitiveContains("legal") == true)
  }

  @MainActor
  func testPaperLegalVersionChangeRequiresFreshAcknowledgement() async throws {
    let suite = "WHOX.Tests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let persistence = CompletingOnboardingPersistence(
      legalDocuments: LegalDocumentTestFixtures.paper(version: "PAPER-2026.08"))
    let session = AppSession(
      runtimeMode: .paper,
      authClient: RestoringAuthClient(
        userID: "49FC57A7-C296-4FD2-B255-33290800AF2F"),
      onboardingPersistence: persistence,
      defaults: defaults,
      arguments: ["tests", "-resetOnboarding"])
    await session.bootstrap()
    let originalDocument = try XCTUnwrap(
      session.legalDocuments.first { $0.id == "terms" })
    session.onboardingDraft.acceptedDocumentIDs = Set(
      session.legalDocuments.map(\.acceptanceKey))
    XCTAssertTrue(session.hasAcceptedAllRequiredDocuments)

    let replacement = LegalDocumentTestFixtures.paper(
      version: "PAPER-2026.08", termsVersion: "PAPER-2026.09")
    await persistence.replaceLegalDocuments(replacement)
    await session.refreshLegalDocuments()

    XCTAssertEqual(session.legalDocuments, replacement)
    let replacementDocument = try XCTUnwrap(
      session.legalDocuments.first { $0.id == "terms" })
    XCTAssertNotEqual(originalDocument.acceptanceKey, replacementDocument.acceptanceKey)
    XCTAssertFalse(session.hasAcceptedAllRequiredDocuments)
    XCTAssertFalse(
      session.onboardingDraft.acceptedDocumentIDs.contains(replacementDocument.acceptanceKey))
  }

  @MainActor
  func testRefreshingLegalDocumentsPreservesExplicitDemoFixtures() async {
    let session = AppSession(runtimeMode: .demo, arguments: ["tests", "-resetOnboarding"])
    let fixtures = session.legalDocuments

    await session.refreshLegalDocuments()

    XCTAssertEqual(session.legalDocuments, fixtures)
    XCTAssertEqual(session.legalDocuments, DemoFixtures.legalDocuments)
    XCTAssertTrue(session.legalDocuments.allSatisfy { !$0.productionApproved })
  }

  @MainActor
  func testPaperSessionRejectsNonUUIDStoreKitIdentity() async {
    let suite = "WHOX.Tests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let storeKit = StoreKitService(arguments: ["tests"])
    let auth = RestoringAuthClient(userID: "not-a-canonical-user-uuid")
    let session = AppSession(
      runtimeMode: .paper,
      storeKit: storeKit,
      authClient: auth,
      onboardingPersistence: CompletingOnboardingPersistence(),
      defaults: defaults,
      arguments: ["tests", "-resetOnboarding"])

    await session.bootstrap()

    XCTAssertNil(storeKit.appAccountTokenForTesting)
    XCTAssertFalse(session.onboardingDraft.isAuthenticated)
    let clearCount = await auth.localClearCount()
    XCTAssertEqual(clearCount, 1)
    XCTAssertTrue(session.alertMessage?.contains("account response could not be verified") == true)
  }

  func testFinancialFormatterSignPercentAndRoundingEdges() {
    XCTAssertTrue(FinancialFormatters.currency(1, showSign: true).hasPrefix("+"))
    XCTAssertFalse(FinancialFormatters.currency(0, showSign: true).hasPrefix("+"))
    XCTAssertFalse(FinancialFormatters.currency(-1, showSign: true).hasPrefix("+"))
    XCTAssertTrue(FinancialFormatters.percent(0.01, showSign: true).hasPrefix("+"))
    XCTAssertFalse(FinancialFormatters.percent(0, showSign: true).hasPrefix("+"))
    XCTAssertTrue(FinancialFormatters.percent(-0.01, showSign: true).hasPrefix("-"))
    let rounded = FinancialFormatters.spokenCurrency(1.999)
    XCTAssertTrue(rounded.contains("two dollars"))
    XCTAssertTrue(rounded.contains("zero cents"))
  }

  func testFinancialAccessibilityStringIsUnambiguous() {
    let spoken = FinancialFormatters.spokenCurrency(12_430.25)
    XCTAssertTrue(spoken.contains("dollars"))
    XCTAssertTrue(spoken.contains("cents"))
    XCTAssertFalse(spoken.contains("$"))
  }

  func testPaperAllocationPresentationUsesOnlyAuthoritativeSessionValues() throws {
    let dashboard = paperDashboard(accountValue: 1_000, reserve: 100)
    let positions = [
      paperPosition(id: "stock", kind: .stock, marketValue: 400),
      paperPosition(id: "etf", kind: .etf, marketValue: 300),
      paperPosition(id: "option", kind: .option, marketValue: 100),
    ]

    let presentation = try XCTUnwrap(
      PortfolioAllocationPresentation.make(
        mode: .paper, dashboard: dashboard, positions: positions))
    let values = Dictionary(uniqueKeysWithValues: presentation.slices.map { ($0.id, $0.value) })
    XCTAssertEqual(values["stocks"] ?? -1, 40, accuracy: 0.001)
    XCTAssertEqual(values["etf"] ?? -1, 30, accuracy: 0.001)
    XCTAssertEqual(values["options"] ?? -1, 10, accuracy: 0.001)
    XCTAssertEqual(values["reserve"] ?? -1, 10, accuracy: 0.001)
    XCTAssertEqual(values["unclassified"] ?? -1, 10, accuracy: 0.001)

    let visibleCopy =
      ([
        presentation.chartAccessibilityLabel,
        presentation.chartAccessibilityValue,
        presentation.disclosureTitle,
        presentation.disclosureMessage,
      ] + presentation.slices.map(\.name)).joined(separator: " ").lowercased()
    XCTAssertFalse(visibleCopy.contains("demo"))
    XCTAssertFalse(visibleCopy.contains("seeded"))
  }

  func testPaperAllocationPresentationFailsClosedForUnavailableOrInconsistentValues() {
    XCTAssertNil(
      PortfolioAllocationPresentation.make(
        mode: .paper, dashboard: DemoFixtures.dashboard, positions: DemoFixtures.positions))
    XCTAssertNil(
      PortfolioAllocationPresentation.make(
        mode: .paper, dashboard: paperDashboard(accountValue: 0, reserve: 0), positions: []))
    XCTAssertNil(
      PortfolioAllocationPresentation.make(
        mode: .paper,
        dashboard: paperDashboard(accountValue: 1_000, reserve: 500),
        positions: [paperPosition(id: "stock", kind: .stock, marketValue: 1_000)]))
  }

  func testPaperPerformancePresentationDerivesOnlySupportedMetrics() throws {
    let start = Date(timeIntervalSince1970: 1_700_000_000)
    let history = [
      PortfolioPoint(date: start, value: 100, benchmarkValue: 200),
      PortfolioPoint(date: start.addingTimeInterval(86_400), value: 120, benchmarkValue: 210),
      PortfolioPoint(date: start.addingTimeInterval(172_800), value: 90, benchmarkValue: 220),
    ]
    let dashboard = paperDashboard(accountValue: 90, reserve: 10, history: history)

    let presentation = try XCTUnwrap(
      PortfolioPerformancePresentation.make(mode: .paper, dashboard: dashboard))
    XCTAssertEqual(
      Set(presentation.metrics.map(\.id)),
      ["value-change", "observed-drawdown", "benchmark-change", "snapshot-count"])
    XCTAssertEqual(presentation.points.map(\.value), [100, 120, 90])
    XCTAssertTrue(
      Set(presentation.metrics.map(\.id)).isDisjoint(
        with: Set(DemoFixtures.performanceMetrics.map(\.id))))

    let visibleCopy =
      ([
        presentation.disclosureTitle,
        presentation.disclosureMessage,
        presentation.limitsTitle,
        presentation.limitsMessage,
        presentation.portfolioSeriesName,
        presentation.benchmarkSeriesName,
        presentation.chartAccessibilityLabel,
        presentation.chartAccessibilityValue,
      ] + presentation.metrics.flatMap { [$0.title, $0.value, $0.context] })
      .joined(separator: " ").lowercased()
    XCTAssertFalse(visibleCopy.contains("demo"))
    XCTAssertFalse(visibleCopy.contains("seeded"))
    XCTAssertFalse(visibleCopy.contains("turnover"))
    XCTAssertFalse(visibleCopy.contains("closed outcomes"))
  }

  func testPaperPerformancePresentationRequiresTwoAuthoritativeSnapshots() {
    XCTAssertNil(
      PortfolioPerformancePresentation.make(mode: .paper, dashboard: DemoFixtures.dashboard))
    let dashboard = paperDashboard(
      accountValue: 100, reserve: 20,
      history: [PortfolioPoint(date: .now, value: 100)])
    XCTAssertNil(PortfolioPerformancePresentation.make(mode: .paper, dashboard: dashboard))
  }

  func testDemoPortfolioPresentationsPreserveSeededFixtureBehavior() throws {
    let allocation = try XCTUnwrap(
      PortfolioAllocationPresentation.make(
        mode: .demo, dashboard: DemoFixtures.dashboard, positions: DemoFixtures.positions))
    let performance = try XCTUnwrap(
      PortfolioPerformancePresentation.make(mode: .demo, dashboard: DemoFixtures.dashboard))

    XCTAssertEqual(allocation.slices, DemoFixtures.allocation)
    XCTAssertEqual(allocation.disclosureTitle, "Accessible alternative")
    XCTAssertEqual(performance.metrics, DemoFixtures.performanceMetrics)
    XCTAssertEqual(performance.disclosureTitle, "Demo performance · net · time-weighted")
  }

  func testRepositoryProposalTransition() async throws {
    let repository = DemoTreasuryRepository()
    let updated = try await repository.approveProposal(
      id: DemoFixtures.pendingProposal.id, mode: .demo)
    XCTAssertEqual(updated.proposal?.state, .filled)
    XCTAssertEqual(updated.status, "Filled")
  }

  func testRepositoryRejectsLiveSubmission() async {
    let repository = DemoTreasuryRepository()
    do {
      _ = try await repository.approveProposal(id: DemoFixtures.pendingProposal.id, mode: .live)
      XCTFail("Live must fail closed")
    } catch {
      XCTAssertEqual(error as? TreasuryRepositoryError, .liveTradingLocked)
    }
  }

  @MainActor
  func testPrivacyPreferencePersists() async {
    let suite = "WHOX.Tests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let session = AppSession(defaults: defaults, arguments: ["tests", "-skipOnboarding"])
    XCTAssertFalse(session.preferences.privacyMode)
    await session.togglePrivacy()
    let restored = AppSession(defaults: defaults, arguments: ["tests", "-skipOnboarding"])
    XCTAssertTrue(restored.preferences.privacyMode)
  }

  @MainActor
  func testOnboardingProgressPersistsAfterMeaningfulStep() async {
    let suite = "WHOX.Tests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let session = AppSession(defaults: defaults, arguments: ["tests", "-resetOnboarding"])
    await session.advanceOnboarding()
    XCTAssertEqual(session.onboardingDraft.step, .signIn)
    let restored = AppSession(defaults: defaults, arguments: ["tests"])
    XCTAssertEqual(restored.onboardingDraft.step, .signIn)
  }

  @MainActor
  func testOnboardingCompletionAppliesAndPersistsSelection() {
    let suite = "WHOX.Tests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let session = AppSession(defaults: defaults, arguments: ["tests", "-resetOnboarding"])
    makeOnboardingEligibleForCompletion(session)
    session.onboardingDraft.selectedPlan = .equityPro
    session.onboardingDraft.selectedAgentID = "equity-momentum"
    session.onboardingDraft.automationMode = .observe
    XCTAssertTrue(session.completeOnboarding())

    XCTAssertTrue(session.isOnboardingComplete)
    XCTAssertEqual(session.selectedPlanTier, .equityPro)
    XCTAssertEqual(session.activeAgents.map(\.id), ["equity-momentum"])
    XCTAssertEqual(session.activeAgents.first?.operatingMode, .observe)
    XCTAssertEqual(session.profile.riskClassification, "Growth")
    XCTAssertEqual(session.profile.jurisdiction, "New York, United States")
    let restored = AppSession(defaults: defaults, arguments: ["tests"])
    XCTAssertTrue(restored.isOnboardingComplete)
    XCTAssertEqual(restored.selectedPlanTier, .equityPro)
    XCTAssertEqual(restored.activeAgents.map(\.id), ["equity-momentum"])
    XCTAssertEqual(restored.profile.riskClassification, "Growth")
  }

  func testEligibilityRequiresExplicitFieldsAndFailsClosed() {
    var draft = OnboardingDraft(riskPolicy: DemoFixtures.recommendedRiskPolicy)
    XCTAssertEqual(EligibilityValidator.assess(draft).status, .incomplete)

    draft.country = "United States"
    draft.state = "New York"
    draft.minimumAgeStatus = .doesNotMeetRequirement
    draft.individualAccountStatus = .actingForOwnAccount
    draft.adviserClientClassification = .selfDirected
    draft.understandsNotBroker = true
    let underage = EligibilityValidator.assess(draft)
    XCTAssertEqual(underage.status, .unavailable)
    XCTAssertTrue(underage.messages.contains { $0.localizedCaseInsensitiveContains("age") })

    draft.minimumAgeStatus = .meetsRequirement
    draft.adviserClientClassification = .unanswered
    XCTAssertEqual(EligibilityValidator.assess(draft).status, .incomplete)
    draft.adviserClientClassification = .adviserClient
    XCTAssertEqual(EligibilityValidator.assess(draft).status, .unavailable)
    draft.adviserClientClassification = .selfDirected
    XCTAssertEqual(EligibilityValidator.assess(draft).status, .eligibleForDemo)
  }

  func testInvestorClassificationIsDerivedFromAnswers() {
    var conservative = OnboardingDraft(riskPolicy: DemoFixtures.recommendedRiskPolicy)
    conservative.objective = "Capital preservation"
    conservative.holdingPeriod = "Under 1 year"
    conservative.experience = "None"
    conservative.stockExperience = "None"
    conservative.lossTolerance = 5
    conservative.dependsOnFunds = true
    conservative.liquidityNeed = "High"
    conservative.volatilityComfort = "Low"
    let conservativeResult = InvestorAssessmentEvaluator.evaluate(conservative)
    XCTAssertEqual(conservativeResult.riskClassification, .conservative)
    XCTAssertEqual(conservativeResult.optionsClassification, .restricted)

    var aggressive = conservative
    aggressive.objective = "Aggressive growth"
    aggressive.holdingPeriod = "More than 5 years"
    aggressive.experience = "Extensive"
    aggressive.stockExperience = "Extensive"
    aggressive.optionsExperience = "Some experience"
    aggressive.lossTolerance = 30
    aggressive.dependsOnFunds = false
    aggressive.liquidityNeed = "Low"
    aggressive.volatilityComfort = "High"
    aggressive.understandsOptionsPremiumLoss = true
    let aggressiveResult = InvestorAssessmentEvaluator.evaluate(aggressive)
    XCTAssertEqual(aggressiveResult.riskClassification, .aggressive)
    XCTAssertEqual(
      aggressiveResult.optionsClassification, .eligiblePendingBrokerPermission)
    XCTAssertNotEqual(conservativeResult.score, aggressiveResult.score)
  }

  @MainActor
  func testOnboardingCannotCompleteWithoutEligibilityAndLegalChecks() {
    let suite = "WHOX.Tests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let session = AppSession(defaults: defaults, arguments: ["tests", "-resetOnboarding"])
    session.onboardingDraft.step = .completion

    XCTAssertFalse(session.completeOnboarding())
    XCTAssertFalse(session.isOnboardingComplete)
    XCTAssertFalse(defaults.bool(forKey: "onboarding.complete.v2"))
    XCTAssertTrue(session.alertMessage?.localizedCaseInsensitiveContains("country") == true)
  }

  @MainActor
  func testAppReviewPreviewDoesNotForgeOnboardingCompletionOrConsent() {
    let suite = "WHOX.Tests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let session = AppSession(defaults: defaults, arguments: ["tests", "-resetOnboarding"])

    session.openAppReviewDemo()

    XCTAssertTrue(session.isAppReviewPreviewActive)
    XCTAssertFalse(session.isOnboardingComplete)
    XCTAssertFalse(session.onboardingDraft.isAuthenticated)
    XCTAssertTrue(session.onboardingDraft.acceptedDocumentIDs.isEmpty)
    XCTAssertEqual(session.onboardingDraft.minimumAgeStatus, .unanswered)
  }

  @MainActor
  func testIneligibleDemoAccountCanBeDeletedWithoutForgingServerPersistence() async {
    let suite = "WHOX.Tests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let session = AppSession(
      defaults: defaults, arguments: ["tests", "-resetOnboarding", "-mockBiometricSuccess"])
    session.onboardingDraft.isAuthenticated = true
    session.onboardingDraft.minimumAgeStatus = .doesNotMeetRequirement
    session.profile.email = "person@example.com"
    await session.togglePrivacy()
    defaults.set(Data("legacy-sensitive-answers".utf8), forKey: "onboarding.draft.v1")

    let deleted = await session.deleteAccount(confirmation: "DELETE")
    XCTAssertTrue(deleted)
    XCTAssertFalse(session.isOnboardingComplete)
    XCTAssertFalse(session.isAppReviewPreviewActive)
    XCTAssertFalse(session.onboardingDraft.isAuthenticated)
    XCTAssertEqual(session.onboardingDraft.minimumAgeStatus, .unanswered)
    XCTAssertNil(defaults.data(forKey: "onboarding.draft.v1"))
    XCTAssertEqual(session.profile.email, "review@whox.ai")
    XCTAssertFalse(session.preferences.privacyMode)
    XCTAssertNil(defaults.data(forKey: "preferences.v1"))
    XCTAssertTrue(session.alertMessage?.contains("No server account existed") == true)
  }

  @MainActor
  func testLegacyCompletionFlagCannotBypassCurrentChecks() {
    let suite = "WHOX.Tests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    defaults.set(true, forKey: "onboarding.complete.v1")

    let session = AppSession(defaults: defaults, arguments: ["tests"])

    XCTAssertFalse(session.isOnboardingComplete)
  }

  @MainActor
  func testDemoFixtureCannotBeRelabeledAsPaper() {
    let session = AppSession(arguments: ["tests", "-skipOnboarding"])
    let original = session.dashboard
    session.setMode(.paper)
    XCTAssertEqual(session.mode, .demo)
    XCTAssertEqual(session.dashboard, original)
    XCTAssertTrue(session.dashboard.dataLabel.localizedCaseInsensitiveContains("demo"))
    XCTAssertFalse(session.dashboard.dataLabel.localizedCaseInsensitiveContains("paper"))
    XCTAssertTrue(
      session.alertMessage?.localizedCaseInsensitiveContains("cannot be relabeled") == true)
  }

  @MainActor
  func testAuthoritativeOnboardingCannotBeCompletedByLocalStateAlone() async {
    let suite = "WHOX.Tests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let persistence = CompletingOnboardingPersistence()
    let session = AppSession(
      onboardingPersistence: persistence,
      defaults: defaults,
      arguments: ["tests", "-resetOnboarding"])
    makeOnboardingEligibleForCompletion(session)

    XCTAssertFalse(session.completeOnboarding())
    XCTAssertFalse(session.isOnboardingComplete)

    session.onboardingDraft.step = .finalReview
    let advanced = await session.advanceOnboarding()
    XCTAssertTrue(advanced)
    XCTAssertEqual(session.onboardingDraft.step, .completion)
    XCTAssertTrue(session.completeOnboarding())
    XCTAssertTrue(session.isOnboardingComplete)
  }

  @MainActor
  func testOfflineLaunchKeepsActionableFixture() async {
    let session = AppSession(arguments: ["tests", "-skipOnboarding", "-uiOffline"])
    await session.loadData()
    guard case .offline(let message) = session.loadPhase else {
      return XCTFail("Expected offline state")
    }
    XCTAssertTrue(message.localizedCaseInsensitiveContains("offline"))
    XCTAssertFalse(session.positions.isEmpty)
  }

  @MainActor
  func testExclusionAddRemoveAndReloadUseAuthoritativeRiskPolicy() async throws {
    let repository = DemoTreasuryRepository()
    let session = AppSession(
      repository: repository, arguments: ["tests", "-skipOnboarding"])
    await session.loadData()

    await session.toggleExclusion(positionID: "pos-msft")

    XCTAssertTrue(session.positions.first(where: { $0.id == "pos-msft" })?.isExcluded == true)
    let policyAfterAdd = try await repository.riskPolicy()
    XCTAssertEqual(policyAfterAdd.excludedSymbols, ["GME", "MSFT"])

    let reloaded = AppSession(
      repository: repository, arguments: ["tests", "-skipOnboarding"])
    await reloaded.loadData()
    XCTAssertTrue(reloaded.positions.first(where: { $0.id == "pos-msft" })?.isExcluded == true)

    await reloaded.toggleExclusion(positionID: "pos-msft")

    XCTAssertFalse(reloaded.positions.first(where: { $0.id == "pos-msft" })?.isExcluded == true)
    let policyAfterRemove = try await repository.riskPolicy()
    XCTAssertEqual(policyAfterRemove.excludedSymbols, ["GME"])
  }

  @MainActor
  func testExclusionReloadCanonicalizesAndDeduplicatesAuthoritativeSymbols() async throws {
    let repository = DemoTreasuryRepository()
    var policy = DemoFixtures.recommendedRiskPolicy
    policy.excludedSymbols = [" msft ", "MSFT", " vti", "VTI ", ""]
    _ = try await repository.saveRiskPolicy(policy)
    let session = AppSession(
      repository: repository, arguments: ["tests", "-skipOnboarding"])

    await session.loadData()

    XCTAssertEqual(session.riskPolicy.excludedSymbols, ["MSFT", "VTI"])
    XCTAssertTrue(session.positions.first(where: { $0.id == "pos-msft" })?.isExcluded == true)
    XCTAssertTrue(session.positions.first(where: { $0.id == "pos-vti" })?.isExcluded == true)
    XCTAssertFalse(session.positions.first(where: { $0.id == "pos-xlv" })?.isExcluded == true)
  }

  @MainActor
  func testExclusionFailureRollsBackPolicyAndPositionState() async {
    let session = AppSession(
      repository: UnavailableTreasuryRepository(), arguments: ["tests", "-skipOnboarding"])
    let originalPolicy = session.riskPolicy
    let originalPosition = session.positions.first(where: { $0.id == "pos-msft" })

    await session.toggleExclusion(positionID: "pos-msft")

    XCTAssertEqual(session.riskPolicy, originalPolicy)
    XCTAssertEqual(session.positions.first(where: { $0.id == "pos-msft" }), originalPosition)
    XCTAssertFalse(session.exclusionUpdateIsInFlight(positionID: "pos-msft"))
    XCTAssertTrue(session.alertMessage?.contains("exclusion was not changed") == true)
  }

  @MainActor
  private func makeOnboardingEligibleForCompletion(_ session: AppSession) {
    session.onboardingDraft.step = .completion
    session.onboardingDraft.isAuthenticated = true
    session.onboardingDraft.country = "United States"
    session.onboardingDraft.state = "New York"
    session.onboardingDraft.minimumAgeStatus = .meetsRequirement
    session.onboardingDraft.individualAccountStatus = .actingForOwnAccount
    session.onboardingDraft.adviserClientClassification = .selfDirected
    session.onboardingDraft.understandsNotBroker = true
    session.onboardingDraft.howItWorksAcknowledged = true
    session.onboardingDraft.investorProfileAcknowledged = true
    session.onboardingDraft.acceptedDocumentIDs = Set(
      session.legalDocuments.map(\.acceptanceKey))
    session.connection = DemoFixtures.brokerConnection
  }

  private func paperDashboard(
    accountValue: Double, reserve: Double, history: [PortfolioPoint] = []
  ) -> DashboardSnapshot {
    DashboardSnapshot(
      accountValue: accountValue,
      todayChange: 0,
      todayPercent: 0,
      mode: .paper,
      updatedAt: Date(timeIntervalSince1970: 1_700_000_000),
      isStale: false,
      dataLabel: "Authoritative Paper simulation · not brokerage results",
      history: history,
      riskState: .normal,
      riskUsages: [],
      buyingPowerReserve: reserve)
  }

  private func paperPosition(id: String, kind: PositionKind, marketValue: Double) -> Position {
    Position(
      id: id,
      symbol: id.uppercased(),
      name: id,
      kind: kind,
      quantity: 1,
      averageCost: marketValue,
      currentPrice: marketValue,
      marketValue: marketValue,
      todayChange: 0,
      todayPercent: 0,
      totalReturn: 0,
      totalReturnPercent: 0,
      realizedPnL: 0,
      sector: "Not supplied",
      quoteTimestamp: .distantPast,
      expiration: nil,
      strategyName: nil,
      maximumLoss: nil,
      maximumProfit: nil,
      breakeven: nil,
      optionLegs: [],
      liquidityNote: nil,
      thesisHistory: [],
      isWatchlisted: false,
      isExcluded: false)
  }
}

private actor CompletingOnboardingPersistence: OnboardingPersisting {
  private var legalDocuments: [LegalDocument]
  private let legalDocumentsUnavailable: Bool

  init(
    legalDocuments: [LegalDocument] = LegalDocumentTestFixtures.paper(),
    legalDocumentsUnavailable: Bool = false
  ) {
    self.legalDocuments = legalDocuments
    self.legalDocumentsUnavailable = legalDocumentsUnavailable
  }

  func currentProgress() async throws -> AuthoritativeOnboardingProgress {
    progress(completed: false, step: 13)
  }

  func currentLegalDocuments() async throws -> [LegalDocument] {
    if legalDocumentsUnavailable { throw HTTPRepositoryError.unavailable }
    return legalDocuments
  }

  func replaceLegalDocuments(_ documents: [LegalDocument]) {
    legalDocuments = documents
  }

  func recordEligibility(_ draft: OnboardingDraft) async throws
    -> AuthoritativeEligibilityDecision
  {
    AuthoritativeEligibilityDecision(status: "eligible", messages: [])
  }

  func recordRiskAssessment(_ draft: OnboardingDraft) async throws
    -> AuthoritativeRiskDecision
  {
    let local = InvestorAssessmentEvaluator.evaluate(draft)
    return AuthoritativeRiskDecision(
      classification: local.riskClassification,
      optionsClassification: local.optionsClassification)
  }

  func recordLegalConsents(_ documents: [LegalDocument]) async throws -> Bool { true }

  func persistStep(_ step: Int) async throws -> AuthoritativeOnboardingProgress {
    progress(completed: step == 14, step: step)
  }

  private func progress(completed: Bool, step: Int) -> AuthoritativeOnboardingProgress {
    AuthoritativeOnboardingProgress(
      currentStep: step,
      completed: completed,
      resumable: true,
      eligibilityStatus: "eligible",
      riskAssessmentStatus: "current",
      legalConsentsComplete: completed)
  }
}

private enum LegalDocumentTestFixtures {
  static func paper(
    version: String = "PAPER-2026.08", termsVersion: String? = nil
  ) -> [LegalDocument] {
    let definitions = [
      ("terms", "Terms of Service", "terms", "a"),
      ("privacy", "Privacy Policy", "privacy", "b"),
      ("ai-risk", "AI Agent Risk Disclosure", "ai-risk", "c"),
      ("broker", "Brokerage Connection Disclosure", "broker", "d"),
      ("subscription", "Subscription Terms", "subscription", "e"),
      ("electronic", "Electronic Communications Consent", "electronic", "f"),
      ("performance", "Performance Presentation Disclosure", "performance", "1"),
      ("ai-data", "Data Processing and Third-Party AI Disclosure", "ai-data", "2"),
    ]
    return definitions.map { definition in
      let (id, title, path, hashCharacter) = definition
      let documentVersion = id == "terms" ? termsVersion ?? version : version
      return LegalDocument(
        id: id,
        title: title,
        version: documentVersion,
        productionApproved: true,
        required: true,
        contentURL: URL(string: "https://legal.whox.ai/\(path)/\(documentVersion)")!,
        contentSHA256: String(repeating: hashCharacter, count: 64),
        publishedAt: Date(timeIntervalSince1970: 1_754_055_600),
        summary: "")
    }
  }
}

private actor RestoringAuthClient: AuthClient {
  private let userID: String
  private var clearCount = 0

  init(userID: String) {
    self.userID = userID
  }

  func exchangeAppleCredential(_ payload: AppleCredentialPayload) async throws
    -> AuthenticatedUserSession
  {
    restoredSession()
  }

  func restoreSession() async throws -> AuthenticatedUserSession? { restoredSession() }
  func accessToken() async throws -> String { "test-access-token" }
  func logout() async throws {}
  func revokeSession(id: String) async throws {}
  func revokeOtherSessions() async throws -> Int { 0 }

  func clearLocalSession() async throws {
    clearCount += 1
  }

  func localClearCount() -> Int { clearCount }

  private func restoredSession() -> AuthenticatedUserSession {
    AuthenticatedUserSession(
      userID: userID,
      displayName: "Paper Tester",
      email: "paper@example.com",
      accessToken: "test-access-token",
      accessTokenExpiresAt: Date().addingTimeInterval(900),
      sessionID: "test-session")
  }
}
