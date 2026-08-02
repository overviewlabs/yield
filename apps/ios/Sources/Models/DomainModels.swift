import Foundation

enum TreasuryMode: String, CaseIterable, Codable, Sendable {
  case demo
  case paper
  case live

  var title: String { rawValue.capitalized }

  var explanation: String {
    switch self {
    case .demo: "Seeded financial data. No order can reach a broker."
    case .paper: "Simulated execution. Results are not actual brokerage results."
    case .live: "Broker-connected execution, available only after every release gate passes."
    }
  }
}

enum MainTab: String, CaseIterable, Hashable, Sendable {
  case home
  case portfolio
  case agents
  case activity
  case settings

  var title: String { rawValue.capitalized }

  var symbol: String {
    switch self {
    case .home: "house"
    case .portfolio: "chart.pie"
    case .agents: "point.3.connected.trianglepath.dotted"
    case .activity: "clock.arrow.trianglehead.counterclockwise.rotate.90"
    case .settings: "gearshape"
    }
  }
}

enum ChartRange: String, CaseIterable, Identifiable, Sendable {
  case day = "1D"
  case week = "1W"
  case month = "1M"
  case threeMonths = "3M"
  case year = "1Y"
  case all = "ALL"

  var id: String { rawValue }

  var sampleCount: Int {
    switch self {
    case .day: 24
    case .week: 7
    case .month: 30
    case .threeMonths: 90
    case .year: 180
    case .all: 240
    }
  }
}

enum AgentOperatingMode: String, CaseIterable, Codable, Identifiable, Sendable {
  case observe
  case confirmEveryTrade
  case automaticWithinLimits

  var id: String { rawValue }

  var title: String {
    switch self {
    case .observe: "Observe"
    case .confirmEveryTrade: "Confirm Every Trade"
    case .automaticWithinLimits: "Automatic Within Limits"
    }
  }

  var summary: String {
    switch self {
    case .observe: "Analysis and insights only. No order submission."
    case .confirmEveryTrade: "Review and authenticate every complete proposal."
    case .automaticWithinLimits:
      "Eligible proposals may be submitted only after every deterministic check passes."
    }
  }
}

enum RiskState: String, Codable, Sendable {
  case normal
  case warning
  case halted

  var title: String {
    switch self {
    case .normal: "Within limits"
    case .warning: "Approaching limit"
    case .halted: "Risk halt"
    }
  }
}

enum PositionKind: String, CaseIterable, Codable, Sendable {
  case stock
  case etf
  case option

  var title: String { rawValue.capitalized }
}

enum OptionType: String, Codable, Sendable {
  case call
  case put
}

enum OptionSide: String, Codable, Sendable {
  case long
  case short
}

enum RiskCategory: String, CaseIterable, Codable, Sendable {
  case conservative
  case moderate
  case growth
  case aggressive
  case optionsRestricted

  var title: String {
    switch self {
    case .optionsRestricted: "Options Restricted"
    default: rawValue.capitalized
    }
  }
}

enum PlanTier: String, CaseIterable, Codable, Identifiable, Sendable {
  case equity
  case equityPro
  case options
  case optionsPro

  var id: String { rawValue }

  var title: String {
    switch self {
    case .equity: "Equity"
    case .equityPro: "Equity Pro"
    case .options: "Options"
    case .optionsPro: "Options Pro"
    }
  }
}

enum AgentAvailability: String, Codable, Sendable {
  case available
  case locked
  case paperOnly
  case complianceHold

  var title: String {
    switch self {
    case .available: "Available"
    case .locked: "Plan required"
    case .paperOnly: "Paper only"
    case .complianceHold: "Unavailable"
    }
  }
}

enum AgentRuntimeStatus: String, Codable, Sendable {
  case monitoring
  case paused
  case waitingApproval
  case riskHalt

  var title: String {
    switch self {
    case .monitoring: "Monitoring"
    case .paused: "Paused"
    case .waitingApproval: "Waiting for approval"
    case .riskHalt: "Risk halt"
    }
  }
}

struct PortfolioPoint: Identifiable, Hashable, Codable, Sendable {
  let id: UUID
  let date: Date
  let value: Double
  let benchmarkValue: Double?

  init(id: UUID = UUID(), date: Date, value: Double, benchmarkValue: Double? = nil) {
    self.id = id
    self.date = date
    self.value = value
    self.benchmarkValue = benchmarkValue
  }
}

struct RiskUsage: Identifiable, Hashable, Codable, Sendable {
  let id: String
  let title: String
  let used: Double
  let limit: Double
  let displayUnit: String
  let symbol: String

  var fraction: Double {
    guard limit > 0 else { return 0 }
    return min(max(used / limit, 0), 1)
  }
}

struct DashboardSnapshot: Hashable, Codable, Sendable {
  let accountValue: Double
  let todayChange: Double
  let todayPercent: Double
  let mode: TreasuryMode
  let updatedAt: Date
  let isStale: Bool
  let dataLabel: String
  let history: [PortfolioPoint]
  let riskState: RiskState
  let riskUsages: [RiskUsage]
  let buyingPowerReserve: Double
}

struct OptionLeg: Identifiable, Hashable, Codable, Sendable {
  let id: UUID
  let side: OptionSide
  let type: OptionType
  let strike: Double
  let expiration: Date
  let quantity: Int

  init(
    id: UUID = UUID(), side: OptionSide, type: OptionType, strike: Double, expiration: Date,
    quantity: Int
  ) {
    self.id = id
    self.side = side
    self.type = type
    self.strike = strike
    self.expiration = expiration
    self.quantity = quantity
  }
}

struct ThesisNote: Identifiable, Hashable, Codable, Sendable {
  let id: UUID
  let date: Date
  let summary: String

  init(id: UUID = UUID(), date: Date, summary: String) {
    self.id = id
    self.date = date
    self.summary = summary
  }
}

struct Position: Identifiable, Hashable, Codable, Sendable {
  let id: String
  let symbol: String
  let name: String
  let kind: PositionKind
  let quantity: Double
  let averageCost: Double
  let currentPrice: Double
  let marketValue: Double
  let todayChange: Double
  let todayPercent: Double
  let totalReturn: Double
  let totalReturnPercent: Double
  let realizedPnL: Double
  let sector: String
  let quoteTimestamp: Date
  let expiration: Date?
  let strategyName: String?
  let maximumLoss: Double?
  let maximumProfit: Double?
  let breakeven: Double?
  let optionLegs: [OptionLeg]
  let liquidityNote: String?
  let thesisHistory: [ThesisNote]
  var isWatchlisted: Bool
  var isExcluded: Bool
}

struct AllocationSlice: Identifiable, Hashable, Codable, Sendable {
  let id: String
  let name: String
  let value: Double
}

struct PerformanceMetric: Identifiable, Hashable, Codable, Sendable {
  let id: String
  let title: String
  let value: String
  let context: String
}

struct InvestmentAgent: Identifiable, Hashable, Codable, Sendable {
  let id: String
  let name: String
  let version: String
  let strategy: String
  let assetClass: String
  let requiredPlan: PlanTier
  let riskCategory: RiskCategory
  let holdingPeriod: String
  let cadence: String
  let summary: String
  let objective: String
  let howItDecides: [String]
  let canTrade: [String]
  let cannotTrade: [String]
  let struggles: [String]
  let riskControls: [String]
  let brokerPermissions: [String]
  let disclosure: String
  let icon: String
  let releaseStatus: String
  let versionHistory: [String]
  var availability: AgentAvailability
  var isActive: Bool
  var runtimeStatus: AgentRuntimeStatus
  var operatingMode: AgentOperatingMode
  var allocationPercent: Double
  var lastRun: Date?
  var nextRun: Date?
  var recentDecision: String
  var activationID: String? = nil
  var configuredSymbol: String? = nil
  var targetOrderAmount: Double? = nil
}

enum ActivityType: String, CaseIterable, Codable, Identifiable, Sendable {
  case proposal
  case order
  case fill
  case agentRun
  case riskEvent
  case account
  case subscription

  var id: String { rawValue }

  var title: String {
    switch self {
    case .proposal: "Proposals"
    case .order: "Orders"
    case .fill: "Fills"
    case .agentRun: "Agent Runs"
    case .riskEvent: "Risk Events"
    case .account: "Account"
    case .subscription: "Subscription"
    }
  }

  var symbol: String {
    switch self {
    case .proposal: "doc.text.magnifyingglass"
    case .order: "arrow.up.arrow.down.square"
    case .fill: "checkmark.circle"
    case .agentRun: "waveform.path.ecg"
    case .riskEvent: "shield.lefthalf.filled"
    case .account: "link"
    case .subscription: "creditcard"
    }
  }
}

enum ProposalState: String, Codable, Sendable {
  case draft = "DRAFT"
  case analyzed = "ANALYZED"
  case schemaValidated = "SCHEMA_VALIDATED"
  case riskChecked = "RISK_CHECKED"
  case riskRejected = "RISK_REJECTED"
  case brokerReviewed = "BROKER_REVIEWED"
  case brokerRejected = "BROKER_REJECTED"
  case awaitingUserApproval = "AWAITING_USER_APPROVAL"
  case userRejected = "USER_REJECTED"
  case approved = "APPROVED"
  case pending = "PENDING"
  case submitting = "SUBMITTING"
  case submitted = "SUBMITTED"
  case partiallyFilled = "PARTIALLY_FILLED"
  case filled = "FILLED"
  case canceled = "CANCELED"
  case rejected = "REJECTED"
  case unknown = "UNKNOWN"
  case expired = "EXPIRED"
  case reconciliationError = "RECONCILIATION_ERROR"

  var title: String { rawValue.replacingOccurrences(of: "_", with: " ").capitalized }
}

enum RiskCheckOutcome: String, Codable, Sendable {
  case passed
  case warning
  case failed
}

struct RiskCheckResult: Identifiable, Hashable, Codable, Sendable {
  let id: String
  let title: String
  let outcome: RiskCheckOutcome
  let explanation: String
}

struct TradeProposal: Identifiable, Hashable, Codable, Sendable {
  let id: String
  let agentID: String
  let agentName: String
  let agentVersion: String
  let createdAt: Date
  let dataTimestamp: Date
  let quoteTimestamp: Date
  let mode: TreasuryMode
  let instrument: String
  let symbol: String
  let side: String
  let quantity: Double
  let estimatedNotional: Double
  let orderType: String
  let limitPrice: Double?
  let timeInForce: String
  let strategy: String
  let thesisSummary: String
  let entryReasoning: [String]
  let exitPlan: String
  let invalidatingCondition: String
  let expectedHoldingPeriod: String
  let knownCatalysts: [String]
  let riskAmount: Double
  let maximumLoss: Double?
  let allocationAfter: Double
  let warnings: [String]
  let riskChecks: [RiskCheckResult]
  let brokerReview: String
  let entitlement: String
  let brokeragePermission: String
  let approvalExpiresAt: Date
  var state: ProposalState

  var isApprovable: Bool { state == .awaitingUserApproval && approvalExpiresAt > .now }
}

struct FillRecord: Identifiable, Hashable, Codable, Sendable {
  let id: String
  let timestamp: Date
  let quantity: Double
  let price: Double
}

struct OrderDetail: Hashable, Codable, Sendable {
  let proposalID: String
  let brokerOrderID: String?
  let submittedAt: Date?
  let terminalAt: Date?
  let side: String
  let instrumentType: String
  let orderType: String
  let limitPrice: Double?
  let timeInForce: String
  let status: ProposalState
  let fills: [FillRecord]
  let averageFillPrice: Double?
  let remainingQuantity: Double
  let statusReason: String?
  let reconciliationStatus: String
  let auditTimeline: [String]

  var isCancelable: Bool {
    switch status {
    case .pending, .submitted, .partiallyFilled:
      true
    default:
      false
    }
  }
}

struct AgentRunDetail: Hashable, Codable, Sendable {
  let startedAt: Date
  let endedAt: Date
  let dataSources: [String]
  let symbolsEvaluated: Int
  let candidatesRejected: Int
  let outcome: String
  let riskFilters: [String]
  let strategyVersion: String
  let errors: [String]
  let noTradeReason: String?
}

struct RiskEventDetail: Hashable, Codable, Sendable {
  let rule: String
  let observedValue: String
  let threshold: String
  let response: String
  let resolvedAt: Date?
}

struct ActivityEvent: Identifiable, Hashable, Codable, Sendable {
  let id: String
  let type: ActivityType
  let timestamp: Date
  let agentName: String?
  let symbol: String?
  var status: String
  var summary: String
  let mode: TreasuryMode
  var proposal: TradeProposal?
  let order: OrderDetail?
  let agentRun: AgentRunDetail?
  let riskEvent: RiskEventDetail?
}

struct RiskPolicy: Hashable, Codable, Sendable {
  var maximumAllocationPercent: Double
  var maximumPositionAmount: Double
  var maximumOrderAmount: Double
  var dailyLossLimit: Double
  var drawdownHaltPercent: Double
  var buyingPowerReservePercent: Double
  var maximumPositions: Int
  var excludedSymbols: [String]
  var excludedSectors: [String]
  var allowEarningsTrading: Bool
  var allowFractionalShares: Bool
  var allowExtendedHours: Bool
  var maximumOptionsLoss: Double
  var maximumOptionsExposurePercent: Double
  var maximumContracts: Int
  var minimumDaysToExpiration: Int
  var maximumDaysToExpiration: Int
  var maximumBidAskSpreadPercent: Double
  var allowCoveredCalls: Bool
  var allowProtectivePuts: Bool
  var allowDefinedRiskSpreads: Bool
  var closeBeforeExpiration: Bool
}

struct SubscriptionPlan: Identifiable, Hashable, Codable, Sendable {
  let tier: PlanTier
  let productID: String
  let summary: String
  let features: [String]
  let maximumActiveAgents: Int
  let supportsOptions: Bool
  let supportsAutomaticMode: Bool

  var id: PlanTier { tier }
}

struct PlanCatalogContext: Equatable, Sendable {
  let plans: [SubscriptionPlan]
  let currentPlanTier: PlanTier?
  let maximumActiveAgents: Int?
  let researchUniverseByPlan: [PlanTier: [String: [String]]]
}

enum ConnectionStatus: String, Codable, Sendable {
  case disconnected
  case pairing
  case connected
  case expired
  case error

  var title: String { rawValue.capitalized }
}

struct BrokerConnection: Hashable, Codable, Sendable {
  var status: ConnectionStatus
  var maskedAccount: String?
  var accountType: String?
  var capabilities: [String]
  var optionsPermission: String
  var lastSync: Date?
}

struct PairingSession: Identifiable, Hashable, Codable, Sendable {
  let id: UUID
  let code: String
  let setupURL: URL
  let expiresAt: Date

  var isExpired: Bool { expiresAt <= .now }
}

enum PairingLifecycleStatus: String, Codable, Sendable {
  case pending
  case authorizing
  case connected
  case expired
  case canceled
  case failed

  var isTerminal: Bool {
    switch self {
    case .connected, .expired, .canceled, .failed: true
    case .pending, .authorizing: false
    }
  }
}

struct PairingStatusSnapshot: Hashable, Codable, Sendable {
  let status: PairingLifecycleStatus
  let connection: BrokerConnection?
  let message: String?
}

struct UserProfile: Hashable, Codable, Sendable {
  var name: String
  var email: String
  var signInMethod: String
  var jurisdiction: String
  var riskClassification: String
}

struct NotificationPreferences: Hashable, Codable, Sendable {
  var proposals = true
  var orderChanges = true
  var fills = true
  var riskAlerts = true
  var expirationAlerts = true
  var dailySummary = true
  var weeklyReport = false
  var securityEvents = true
  var marketing = false
  var detailedPreviewsEnabled = false
  var criticalNotificationsEnabled = false
  var quietHoursStartHourUTC: Int?
  var quietHoursEndHourUTC: Int?
  var quietHoursUTCOffsetMinutes: Int?
}

enum AppearancePreference: String, CaseIterable, Codable, Identifiable, Sendable {
  case system
  case light
  case dark

  var id: String { rawValue }
  var title: String { rawValue.capitalized }
}

struct AppPreferences: Hashable, Codable, Sendable {
  var notificationPreferences = NotificationPreferences()
  var faceIDEnabled = false
  var appLockDelayMinutes = 5
  var appearance = AppearancePreference.system
  var privacyMode = false
  var emphasizePercentage = false
  var hapticsEnabled = true
  var reduceChartAnimation = false
  var detailedWidgetValues = false
}

struct LegalDocument: Identifiable, Hashable, Codable, Sendable {
  let id: String
  let title: String
  let version: String
  let productionApproved: Bool
  let required: Bool
  let contentURL: URL?
  let contentSHA256: String?
  let publishedAt: Date?
  let summary: String

  /// Demo fixtures retain their historical ID-only acknowledgement behavior. Paper documents bind
  /// consent to the exact version and canonical-content digest so a republished document can never
  /// inherit an earlier acknowledgement.
  var acceptanceKey: String {
    guard let contentSHA256 else { return id }
    return "\(id.utf8.count):\(id)\(version.utf8.count):\(version)\(contentSHA256)"
  }

  init(
    id: String,
    title: String,
    version: String,
    productionApproved: Bool,
    required: Bool = true,
    contentURL: URL? = nil,
    contentSHA256: String? = nil,
    publishedAt: Date? = nil,
    summary: String
  ) {
    self.id = id
    self.title = title
    self.version = version
    self.productionApproved = productionApproved
    self.required = required
    self.contentURL = contentURL
    self.contentSHA256 = contentSHA256
    self.publishedAt = publishedAt
    self.summary = summary
  }
}

enum OnboardingStep: Int, CaseIterable, Codable, Sendable {
  case welcome = 0
  case signIn
  case eligibility
  case howItWorks
  case investorProfile
  case subscription
  case agent
  case riskLimits
  case automation
  case connection
  case notifications
  case deviceSecurity
  case finalReview
  case completion

  var title: String {
    switch self {
    case .welcome: "Welcome"
    case .signIn: "Sign In"
    case .eligibility: "Eligibility"
    case .howItWorks: "How It Works"
    case .investorProfile: "Investor Profile"
    case .subscription: "Choose a Plan"
    case .agent: "Choose an Agent"
    case .riskLimits: "Risk Limits"
    case .automation: "Automation"
    case .connection: "Connect Account"
    case .notifications: "Notifications"
    case .deviceSecurity: "Device Security"
    case .finalReview: "Final Review"
    case .completion: "Ready"
    }
  }

  var next: OnboardingStep? { OnboardingStep(rawValue: rawValue + 1) }
  var previous: OnboardingStep? { OnboardingStep(rawValue: rawValue - 1) }
}

struct OnboardingDraft: Hashable, Codable, Sendable {
  var step: OnboardingStep = .welcome
  var isAuthenticated = false
  var country = ""
  var state = ""
  var minimumAgeStatus = MinimumAgeStatus.unanswered
  var individualAccountStatus = IndividualAccountStatus.unanswered
  var adviserClientClassification = AdviserClientClassification.unanswered
  var understandsNotBroker = false
  var howItWorksAcknowledged = false
  var objective = "Long-term growth"
  var holdingPeriod = "3-5 years"
  var experience = "Some experience"
  var stockExperience = "Some experience"
  var optionsExperience = "None"
  var lossTolerance = 15.0
  var dependsOnFunds = false
  var liquidityNeed = "Moderate"
  var volatilityComfort = "Some"
  var confirmationPreference = "Confirm every trade"
  var understandsOptionsPremiumLoss = false
  var investorProfileAcknowledged = false
  var selectedPlan = PlanTier.equity
  var selectedAgentID = "foundation-equity"
  var riskPolicy: RiskPolicy
  var automationMode = AgentOperatingMode.confirmEveryTrade
  var notificationRequested = false
  var deviceSecurityEnabled = false
  var acceptedDocumentIDs: Set<String> = []

  init(riskPolicy: RiskPolicy) {
    self.riskPolicy = riskPolicy
  }
}

struct ReleaseGates: Hashable, Codable, Sendable {
  let liveTradingEnabled: Bool
  let robinhoodProductionApproved: Bool
  let legalDocumentsApproved: Bool
  let advisoryComplianceApproved: Bool
  let appStoreFinancialEntityApproved: Bool
  let optionsLiveTradingEnabled: Bool
  let autonomousModeEnabled: Bool

  static let locked = ReleaseGates(
    liveTradingEnabled: false,
    robinhoodProductionApproved: false,
    legalDocumentsApproved: false,
    advisoryComplianceApproved: false,
    appStoreFinancialEntityApproved: false,
    optionsLiveTradingEnabled: false,
    autonomousModeEnabled: false
  )

  var canEnableLiveTrading: Bool {
    liveTradingEnabled && robinhoodProductionApproved && legalDocumentsApproved
      && advisoryComplianceApproved && appStoreFinancialEntityApproved
  }

  var canEnableAutonomousMode: Bool { canEnableLiveTrading && autonomousModeEnabled }
}
