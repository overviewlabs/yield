import Foundation

enum TreasuryRepositoryError: LocalizedError, Equatable {
  case unavailable
  case liveTradingLocked
  case proposalExpired
  case invalidTransition
  case notFound

  var errorDescription: String? {
    switch self {
    case .unavailable: "Treasury data is temporarily unavailable. Demo data remains on this device."
    case .liveTradingLocked:
      "Live trading is disabled because required release approvals are not complete."
    case .proposalExpired: "This proposal expired. Refresh to request a new analysis."
    case .invalidTransition:
      "This action no longer matches the proposal’s current state. Refresh and review it again."
    case .notFound: "The requested record is no longer available."
    }
  }
}

enum AccountDeletionDisposition: Equatable, Sendable {
  case localDemoReset
  case serverAccepted(brokerRevocationPending: Bool)
}

struct AgentConfigurationInput: Equatable, Sendable {
  let allocationPercent: Double
  let operatingMode: AgentOperatingMode
  let symbol: String
  let targetOrderAmount: Double
}

struct RemoteNotificationSettings: Equatable, Sendable {
  let detailedPreviewsEnabled: Bool
  let criticalNotificationsEnabled: Bool
  let quietHoursStartMinute: Int?
  let quietHoursEndMinute: Int?
  let quietHoursUTCOffsetMinutes: Int?
}

struct RemoteSettings: Equatable, Sendable {
  let privacyMode: Bool
  let appearance: AppearancePreference
  let notifications: RemoteNotificationSettings
}

protocol TreasuryRepository: Sendable {
  func planCatalog() async throws -> PlanCatalogContext
  func dashboard() async throws -> DashboardSnapshot
  func positions() async throws -> [Position]
  func agents() async throws -> [InvestmentAgent]
  func activities() async throws -> [ActivityEvent]
  func riskPolicy() async throws -> RiskPolicy
  func activateAgent(definitionID: String, configuration: AgentConfigurationInput) async throws
  func updateAgent(activationID: String, configuration: AgentConfigurationInput) async throws
  func pauseAgent(activationID: String) async throws
  func resumeAgent(activationID: String) async throws
  func approveProposal(id: String, mode: TreasuryMode) async throws -> ActivityEvent
  func rejectProposal(id: String) async throws -> ActivityEvent
  func cancelOrder(id: String) async throws -> ActivityEvent
  func saveRiskPolicy(_ policy: RiskPolicy) async throws -> RiskPolicy
  func pauseAll() async throws
  func resumeAll() async throws
  func settings() async throws -> RemoteSettings
  func saveSettings(_ settings: RemoteSettings) async throws -> RemoteSettings
  func registerPushToken(_ token: String, environment: String) async throws
  func unregisterPushToken() async throws
  func requestAccountDeletion() async throws -> AccountDeletionDisposition
}

actor DemoTreasuryRepository: TreasuryRepository {
  private var activityRecords = DemoFixtures.activities
  private var savedRiskPolicy = DemoFixtures.recommendedRiskPolicy

  func planCatalog() async throws -> PlanCatalogContext {
    PlanCatalogContext(
      plans: DemoFixtures.plans,
      currentPlanTier: nil,
      maximumActiveAgents: nil,
      researchUniverseByPlan: Dictionary(
        uniqueKeysWithValues: PlanTier.allCases.map { tier in
          (
            tier,
            Dictionary(
              uniqueKeysWithValues: DemoFixtures.agents.map { ($0.id, ["AAPL", "MSFT", "VTI"]) })
          )
        }))
  }
  func dashboard() async throws -> DashboardSnapshot { DemoFixtures.dashboard }
  func positions() async throws -> [Position] { DemoFixtures.positions }
  func agents() async throws -> [InvestmentAgent] { DemoFixtures.agents }
  func activities() async throws -> [ActivityEvent] { activityRecords }
  func riskPolicy() async throws -> RiskPolicy { savedRiskPolicy }
  func activateAgent(definitionID: String, configuration: AgentConfigurationInput) async throws {}
  func updateAgent(activationID: String, configuration: AgentConfigurationInput) async throws {}
  func pauseAgent(activationID: String) async throws {}
  func resumeAgent(activationID: String) async throws {}

  func approveProposal(id: String, mode: TreasuryMode) async throws -> ActivityEvent {
    guard mode != .live else { throw TreasuryRepositoryError.liveTradingLocked }
    guard let index = activityRecords.firstIndex(where: { $0.proposal?.id == id }),
      var proposal = activityRecords[index].proposal
    else {
      throw TreasuryRepositoryError.notFound
    }
    guard proposal.approvalExpiresAt > .now else { throw TreasuryRepositoryError.proposalExpired }
    guard proposal.state == .awaitingUserApproval else {
      throw TreasuryRepositoryError.invalidTransition
    }

    proposal.state = .filled
    activityRecords[index].proposal = proposal
    activityRecords[index].status = "Filled"
    activityRecords[index].summary = "Authenticated Demo approval completed with a simulated fill."
    return activityRecords[index]
  }

  func rejectProposal(id: String) async throws -> ActivityEvent {
    guard let index = activityRecords.firstIndex(where: { $0.proposal?.id == id }),
      var proposal = activityRecords[index].proposal
    else {
      throw TreasuryRepositoryError.notFound
    }
    guard proposal.state == .awaitingUserApproval else {
      throw TreasuryRepositoryError.invalidTransition
    }
    proposal.state = .userRejected
    activityRecords[index].proposal = proposal
    activityRecords[index].status = "Rejected by user"
    activityRecords[index].summary = "Proposal rejected. No order was submitted."
    return activityRecords[index]
  }

  func cancelOrder(id: String) async throws -> ActivityEvent {
    guard let index = activityRecords.firstIndex(where: { $0.id == id }),
      let order = activityRecords[index].order, order.isCancelable
    else {
      throw TreasuryRepositoryError.invalidTransition
    }
    activityRecords[index] = ActivityEvent(
      id: activityRecords[index].id,
      type: .order,
      timestamp: .now,
      agentName: activityRecords[index].agentName,
      symbol: activityRecords[index].symbol,
      status: ProposalState.canceled.title,
      summary: "Demo order cancellation confirmed. No brokerage order was changed.",
      mode: .demo,
      proposal: nil,
      order: OrderDetail(
        proposalID: order.proposalID,
        brokerOrderID: order.brokerOrderID,
        submittedAt: order.submittedAt,
        terminalAt: .now,
        side: order.side,
        instrumentType: order.instrumentType,
        orderType: order.orderType,
        limitPrice: order.limitPrice,
        timeInForce: order.timeInForce,
        status: .canceled,
        fills: order.fills,
        averageFillPrice: order.averageFillPrice,
        remainingQuantity: order.remainingQuantity,
        statusReason: "Canceled in the isolated Demo.",
        reconciliationStatus: "Demo cancellation confirmed",
        auditTimeline: order.auditTimeline + ["Demo cancellation confirmed"]),
      agentRun: nil,
      riskEvent: nil)
    return activityRecords[index]
  }

  func saveRiskPolicy(_ policy: RiskPolicy) async throws -> RiskPolicy {
    savedRiskPolicy = policy
    return savedRiskPolicy
  }

  func pauseAll() async throws {}
  func resumeAll() async throws {}
  func settings() async throws -> RemoteSettings {
    RemoteSettings(
      privacyMode: false, appearance: .system,
      notifications: RemoteNotificationSettings(
        detailedPreviewsEnabled: false, criticalNotificationsEnabled: false,
        quietHoursStartMinute: nil, quietHoursEndMinute: nil,
        quietHoursUTCOffsetMinutes: nil))
  }
  func saveSettings(_ settings: RemoteSettings) async throws -> RemoteSettings { settings }
  func registerPushToken(_ token: String, environment: String) async throws {}
  func unregisterPushToken() async throws {}
  func requestAccountDeletion() async throws -> AccountDeletionDisposition { .localDemoReset }
}

struct ProposalApprovalAuthorization: Sendable, Equatable {
  let deviceID: String
  let proof: [String: String]
}

enum SensitiveOperationAction: String, Sendable {
  case approveTradeProposal = "approve_trade_proposal"
  case resumeUserAgent = "resume_user_agent"
  case resumeAllUserAgents = "resume_all_user_agents"
  case disconnectBrokerConnection = "disconnect_broker_connection"
  case deleteAccount = "delete_account"
  case relaxRiskPolicy = "relax_risk_policy"
}

enum SensitiveStepUpClientError: LocalizedError, Equatable {
  case unavailable

  var errorDescription: String? {
    "Server-verifiable device authentication is not configured. No sensitive action was sent."
  }
}

protocol ProposalStepUpProviding: Sendable {
  func authorization(
    for action: SensitiveOperationAction, resourceID: String
  ) async throws -> ProposalApprovalAuthorization
}

extension ProposalStepUpProviding {
  func authorization(forProposalID id: String) async throws -> ProposalApprovalAuthorization {
    try await authorization(for: .approveTradeProposal, resourceID: id)
  }
}

struct UnavailableProposalStepUpProvider: ProposalStepUpProviding {
  func authorization(
    for action: SensitiveOperationAction, resourceID: String
  ) async throws -> ProposalApprovalAuthorization {
    throw SensitiveStepUpClientError.unavailable
  }
}

struct StaticProposalStepUpProvider: ProposalStepUpProviding {
  let authorization: ProposalApprovalAuthorization

  func authorization(
    for action: SensitiveOperationAction, resourceID: String
  ) async throws -> ProposalApprovalAuthorization {
    authorization
  }
}

enum HTTPRepositoryError: LocalizedError {
  case signedOut
  case forbidden
  case notFound
  case conflict
  case rateLimited
  case unavailable
  case invalidResponse

  var errorDescription: String? {
    switch self {
    case .signedOut: "Your session expired. Sign in again to continue."
    case .forbidden: "This account is not permitted to perform that action."
    case .notFound: "The requested Treasury record is no longer available."
    case .conflict: "The account changed while you were reviewing it. Refresh and try again."
    case .rateLimited: "Too many requests were made. Wait briefly and try again."
    case .unavailable: "Treasury services are temporarily unavailable. No order state was changed."
    case .invalidResponse:
      "Treasury returned an unreadable response. Refresh before taking another action."
    }
  }
}

/// Typed REST boundary for Paper/Live environments. It uses only a short-lived WHOX app token.
/// Brokerage credentials and MCP tokens are never accepted by this client.
struct HTTPTreasuryRepository: TreasuryRepository {
  let baseURL: URL
  var urlSession: URLSession = .shared
  var expectedMode: TreasuryMode = .paper
  var proposalStepUpProvider: any ProposalStepUpProviding = UnavailableProposalStepUpProvider()
  var authenticatedUserIDProvider: @Sendable () async throws -> String = {
    throw HTTPRepositoryError.signedOut
  }
  let credentialProvider: @Sendable () async throws -> String

  func planCatalog() async throws -> PlanCatalogContext {
    async let catalog: APIPlanCatalogEnvelopeDTO = get("v1/plans")
    async let subscription: APISubscriptionDTO = get("v1/subscription")
    async let entitlements: APIEntitlementsDTO = get("v1/entitlements")
    return try await APIPlanCatalogContextMapper.domain(
      catalog: catalog, subscription: subscription, entitlements: entitlements)
  }

  func dashboard() async throws -> DashboardSnapshot {
    async let dashboard: APIDashboardDTO = get("v1/dashboard")
    async let history: APIPortfolioHistoryDTO = get("v1/portfolio/history")
    return try await dashboard.domain(
      history: history.domain(expectedMode: expectedMode), expectedMode: expectedMode)
  }

  func positions() async throws -> [Position] {
    let envelope: APIListEnvelope<APIPositionDTO> = try await get("v1/positions")
    return try envelope.data.map { try $0.domain(expectedMode: expectedMode) }
  }

  func agents() async throws -> [InvestmentAgent] {
    async let definitions: APIListEnvelope<APIAgentDefinitionDTO> = get("v1/agents")
    async let activations: APIListEnvelope<APIUserAgentDTO> = get("v1/user-agents")
    let (catalog, userAgents) = try await (definitions, activations)
    let activeByDefinition = userAgents.data.reduce(into: [String: APIUserAgentDTO]()) {
      if $0[$1.agentID] == nil { $0[$1.agentID] = $1 }
    }
    return try catalog.data.map {
      try $0.domain(userAgent: activeByDefinition[$0.agentID], expectedMode: expectedMode)
    }
  }

  func activities() async throws -> [ActivityEvent] {
    let envelope: APIListEnvelope<APIActivityItemDTO> = try await get("v1/activity")
    return try envelope.data.map { item in
      switch item {
      case .proposal(let record):
        let event = try record.domain()
        guard event.mode == expectedMode else {
          throw APIWireMappingError.environmentMismatch(
            expected: expectedMode, received: event.mode.rawValue)
        }
        return event
      case .order(let record):
        return try record.domain(expectedMode: expectedMode)
      }
    }
  }

  func riskPolicy() async throws -> RiskPolicy {
    let wire: APIRiskPolicyDTO = try await get("v1/risk-policy")
    return wire.domain
  }

  func activateAgent(
    definitionID: String, configuration: AgentConfigurationInput
  ) async throws {
    let _: APIUserAgentDTO = try await mutate(
      "v1/user-agents", method: "POST",
      body: AgentActivationBody(
        agentID: definitionID,
        allocation: configuration.allocationPercent / 100,
        approvalMode: approvalMode(configuration.operatingMode),
        configuration: AgentWireConfiguration(
          symbol: configuration.symbol, targetOrderAmount: configuration.targetOrderAmount)),
      idempotent: true)
  }

  func updateAgent(
    activationID: String, configuration: AgentConfigurationInput
  ) async throws {
    let _: APIUserAgentDTO = try await mutate(
      "v1/user-agents/\(activationID)", method: "PATCH",
      body: AgentUpdateBody(
        allocation: configuration.allocationPercent / 100,
        approvalMode: approvalMode(configuration.operatingMode),
        configuration: AgentWireConfiguration(
          symbol: configuration.symbol, targetOrderAmount: configuration.targetOrderAmount)),
      idempotent: true)
  }

  func pauseAgent(activationID: String) async throws {
    let _: APIUserAgentDTO = try await mutate(
      "v1/user-agents/\(activationID)/pause", method: "POST", body: EmptyBody(),
      idempotent: true)
  }

  func resumeAgent(activationID: String) async throws {
    let authorization = try await proposalStepUpProvider.authorization(
      for: .resumeUserAgent, resourceID: activationID)
    let _: APIUserAgentDTO = try await mutate(
      "v1/user-agents/\(activationID)/resume", method: "POST",
      body: SensitiveOperationBody(authorization: authorization),
      idempotent: true)
  }

  func approveProposal(id: String, mode: TreasuryMode) async throws -> ActivityEvent {
    guard mode == expectedMode, mode != .live else {
      throw TreasuryRepositoryError.liveTradingLocked
    }
    let authorization = try await proposalStepUpProvider.authorization(forProposalID: id)
    guard !authorization.deviceID.isEmpty, !authorization.proof.isEmpty else {
      throw HTTPRepositoryError.forbidden
    }
    let record: APIProposalRecordDTO = try await mutate(
      "v1/proposals/\(id)/approve", method: "POST",
      body: ApprovalBody(
        mode: mode, deviceID: authorization.deviceID, stepUpProof: authorization.proof),
      idempotent: true
    )
    let event = try record.domain()
    guard event.mode == expectedMode else {
      throw APIWireMappingError.environmentMismatch(
        expected: expectedMode, received: event.mode.rawValue)
    }
    return event
  }

  func rejectProposal(id: String) async throws -> ActivityEvent {
    let record: APIProposalRecordDTO = try await mutate(
      "v1/proposals/\(id)/reject", method: "POST", body: EmptyBody(), idempotent: true)
    let event = try record.domain()
    guard event.mode == expectedMode else {
      throw APIWireMappingError.environmentMismatch(
        expected: expectedMode, received: event.mode.rawValue)
    }
    return event
  }

  func cancelOrder(id: String) async throws -> ActivityEvent {
    let record: APIOrderRecordDTO = try await mutate(
      "v1/orders/\(id)/cancel", method: "POST", body: EmptyBody(), idempotent: true)
    return try record.domain(expectedMode: expectedMode)
  }

  func saveRiskPolicy(_ policy: RiskPolicy) async throws -> RiskPolicy {
    let current: APIRiskPolicyDTO = try await get("v1/risk-policy")
    var body = APIRiskPolicyDTO(domain: policy, preserving: current)
    let preview: RiskPolicyUpdatePreview = try await mutate(
      "v1/risk-policy/preview", method: "POST", body: body, idempotent: false)
    guard preview.currentPolicyID == current.policyID, preview.currentVersion == current.version,
      preview.relaxationRequired == riskPolicyRequiresStepUp(candidate: body, current: current),
      !preview.stepUpResourceID.isEmpty
    else { throw HTTPRepositoryError.invalidResponse }
    if preview.relaxationRequired {
      let authorization = try await proposalStepUpProvider.authorization(
        for: .relaxRiskPolicy, resourceID: preview.stepUpResourceID)
      body = APIRiskPolicyDTO(
        domain: policy, preserving: current, authorization: authorization)
    }
    let response: APIRiskPolicyDTO = try await mutate(
      "v1/risk-policy", method: "PATCH", body: body, idempotent: true)
    return response.domain
  }

  func pauseAll() async throws {
    let response: APIPauseResponseDTO = try await mutate(
      "v1/risk/pause-all", method: "POST", body: EmptyBody(), idempotent: true)
    guard response.paused, response.positionsUntouched else {
      throw HTTPRepositoryError.invalidResponse
    }
  }

  func resumeAll() async throws {
    let userID = try await authenticatedUserID()
    let authorization = try await proposalStepUpProvider.authorization(
      for: .resumeAllUserAgents, resourceID: userID)
    let response: APIResumeResponseDTO = try await mutate(
      "v1/risk/resume-all", method: "POST",
      body: SensitiveOperationBody(authorization: authorization), idempotent: true)
    guard response.resumed, response.positionsUntouched else {
      throw HTTPRepositoryError.invalidResponse
    }
  }

  func settings() async throws -> RemoteSettings {
    let response: SettingsResponse = try await get("v1/settings")
    return try response.domain
  }

  func saveSettings(_ settings: RemoteSettings) async throws -> RemoteSettings {
    let response: SettingsResponse = try await mutate(
      "v1/settings", method: "PATCH", body: SettingsBody(settings: settings), idempotent: true)
    return try response.domain
  }

  func registerPushToken(_ token: String, environment: String) async throws {
    let response: PushRegistrationResponse = try await mutate(
      "v1/devices/push-token", method: "POST",
      body: PushRegistrationBody(token: token, environment: environment), idempotent: true)
    guard response.registered, response.environment == environment else {
      throw HTTPRepositoryError.invalidResponse
    }
  }

  func unregisterPushToken() async throws {
    let response: PushUnregistrationResponse = try await mutate(
      "v1/devices/push-token", method: "DELETE", idempotent: true)
    guard response.unregistered else { throw HTTPRepositoryError.invalidResponse }
  }

  func requestAccountDeletion() async throws -> AccountDeletionDisposition {
    let userID = try await authenticatedUserID()
    let authorization = try await proposalStepUpProvider.authorization(
      for: .deleteAccount, resourceID: userID)
    let response: AccountDeletionResponse = try await mutate(
      "v1/account", method: "DELETE", body: SensitiveOperationBody(authorization: authorization),
      idempotent: true)
    guard response.deletionRequested else { throw HTTPRepositoryError.invalidResponse }
    return .serverAccepted(brokerRevocationPending: response.brokerRevocationPending)
  }

  private func authenticatedUserID() async throws -> String {
    let value = try await authenticatedUserIDProvider()
      .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.isEmpty else { throw HTTPRepositoryError.signedOut }
    return value
  }

  private func get<Response: Decodable>(_ path: String) async throws -> Response {
    var request = URLRequest(url: baseURL.appending(path: path))
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    return try await send(request)
  }

  private func mutate<Response: Decodable, Body: Encodable>(
    _ path: String,
    method: String,
    body: Body,
    idempotent: Bool
  ) async throws -> Response {
    var request = URLRequest(url: baseURL.appending(path: path))
    request.httpMethod = method
    request.httpBody = try JSONEncoder.api.encode(body)
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if idempotent { request.setValue(UUID().uuidString, forHTTPHeaderField: "Idempotency-Key") }
    return try await send(request)
  }

  private func mutate<Response: Decodable>(
    _ path: String,
    method: String,
    idempotent: Bool
  ) async throws -> Response {
    var request = URLRequest(url: baseURL.appending(path: path))
    request.httpMethod = method
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if idempotent { request.setValue(UUID().uuidString, forHTTPHeaderField: "Idempotency-Key") }
    return try await send(request)
  }

  private func send<Response: Decodable>(_ request: URLRequest) async throws -> Response {
    var authenticated = request
    authenticated.setValue(
      "Bearer \(try await credentialProvider())", forHTTPHeaderField: "Authorization")
    authenticated.setValue(UUID().uuidString, forHTTPHeaderField: "X-Correlation-ID")
    let (data, response) = try await urlSession.data(for: authenticated)
    guard let http = response as? HTTPURLResponse else { throw HTTPRepositoryError.invalidResponse }
    switch http.statusCode {
    case 200..<300: break
    case 401: throw HTTPRepositoryError.signedOut
    case 403: throw HTTPRepositoryError.forbidden
    case 404: throw HTTPRepositoryError.notFound
    case 409: throw HTTPRepositoryError.conflict
    case 429: throw HTTPRepositoryError.rateLimited
    case 500...599: throw HTTPRepositoryError.unavailable
    default: throw HTTPRepositoryError.invalidResponse
    }
    if Response.self == EmptyResponse.self, data.isEmpty {
      return EmptyResponse() as! Response
    }
    do {
      return try JSONDecoder.api.decode(Response.self, from: data)
    } catch {
      throw HTTPRepositoryError.invalidResponse
    }
  }

  private struct ApprovalBody: Encodable {
    let mode: TreasuryMode
    let deviceID: String
    let stepUpProof: [String: String]

    enum CodingKeys: String, CodingKey {
      case mode
      case deviceID = "deviceId"
      case stepUpProof
    }
  }
  private struct SensitiveOperationBody: Encodable {
    let deviceID: String
    let stepUpProof: [String: String]

    init(authorization: ProposalApprovalAuthorization) {
      deviceID = authorization.deviceID
      stepUpProof = authorization.proof
    }

    enum CodingKeys: String, CodingKey {
      case deviceID = "deviceId"
      case stepUpProof
    }
  }
  private struct AgentWireConfiguration: Encodable {
    let symbol: String
    let targetOrderAmount: Double
  }
  private struct AgentActivationBody: Encodable {
    let agentID: String
    let allocation: Double
    let approvalMode: String
    let configuration: AgentWireConfiguration

    enum CodingKeys: String, CodingKey {
      case agentID = "agentId"
      case allocation, approvalMode, configuration
    }
  }
  private struct AgentUpdateBody: Encodable {
    let allocation: Double
    let approvalMode: String
    let configuration: AgentWireConfiguration
  }
  private struct SettingsResponse: Decodable {
    let privacyMode: Bool
    let appearance: String
    let notificationPreferences: NotificationPreferencesResponse

    var domain: RemoteSettings {
      get throws {
        guard let appearance = AppearancePreference(rawValue: appearance) else {
          throw HTTPRepositoryError.invalidResponse
        }
        let quiet = notificationPreferences.quietHours
        return RemoteSettings(
          privacyMode: privacyMode, appearance: appearance,
          notifications: RemoteNotificationSettings(
            detailedPreviewsEnabled: notificationPreferences.detailedPreviewsEnabled,
            criticalNotificationsEnabled: notificationPreferences.criticalNotificationsEnabled,
            quietHoursStartMinute: quiet?.startMinute,
            quietHoursEndMinute: quiet?.endMinute,
            quietHoursUTCOffsetMinutes: quiet?.utcOffsetMinutes))
      }
    }
  }
  private struct NotificationPreferencesResponse: Decodable {
    let detailedPreviewsEnabled: Bool
    let criticalNotificationsEnabled: Bool
    let quietHours: QuietHours?
  }
  private struct QuietHours: Codable {
    let startMinute: Int
    let endMinute: Int
    let utcOffsetMinutes: Int
  }
  private struct SettingsBody: Encodable {
    let privacyMode: Bool
    let appearance: String
    let detailedPreviewsEnabled: Bool
    let criticalNotificationsEnabled: Bool
    let quietHours: QuietHours?

    init(settings: RemoteSettings) {
      privacyMode = settings.privacyMode
      appearance = settings.appearance.rawValue
      detailedPreviewsEnabled = settings.notifications.detailedPreviewsEnabled
      criticalNotificationsEnabled = settings.notifications.criticalNotificationsEnabled
      if let start = settings.notifications.quietHoursStartMinute,
        let end = settings.notifications.quietHoursEndMinute,
        let offset = settings.notifications.quietHoursUTCOffsetMinutes
      {
        quietHours = QuietHours(
          startMinute: start, endMinute: end, utcOffsetMinutes: offset)
      } else {
        quietHours = nil
      }
    }

    enum CodingKeys: String, CodingKey {
      case privacyMode, appearance, notificationPreferences
    }
    enum NotificationKeys: String, CodingKey {
      case detailedPreviewsEnabled, criticalNotificationsEnabled, quietHours
    }

    func encode(to encoder: Encoder) throws {
      var root = encoder.container(keyedBy: CodingKeys.self)
      try root.encode(privacyMode, forKey: .privacyMode)
      try root.encode(appearance, forKey: .appearance)
      var notifications = root.nestedContainer(
        keyedBy: NotificationKeys.self, forKey: .notificationPreferences)
      try notifications.encode(detailedPreviewsEnabled, forKey: .detailedPreviewsEnabled)
      try notifications.encode(criticalNotificationsEnabled, forKey: .criticalNotificationsEnabled)
      if let quietHours {
        try notifications.encode(quietHours, forKey: .quietHours)
      } else {
        try notifications.encodeNil(forKey: .quietHours)
      }
    }
  }
  private struct PushRegistrationBody: Encodable {
    let token: String
    let environment: String
  }
  private struct PushRegistrationResponse: Decodable {
    let registered: Bool
    let environment: String
  }
  private struct PushUnregistrationResponse: Decodable {
    let unregistered: Bool
  }
  private struct AccountDeletionResponse: Decodable {
    let deletionRequested: Bool
    let brokerRevocationPending: Bool
    let retentionNotice: String
  }
  private struct RiskPolicyUpdatePreview: Decodable {
    let relaxationRequired: Bool
    let stepUpResourceID: String
    let currentPolicyID: String
    let currentVersion: Int

    enum CodingKeys: String, CodingKey {
      case relaxationRequired
      case stepUpResourceID = "stepUpResourceId"
      case currentPolicyID = "currentPolicyId"
      case currentVersion
    }
  }
  private struct EmptyBody: Encodable {}
  private struct EmptyResponse: Codable {}

  private func approvalMode(_ mode: AgentOperatingMode) -> String {
    switch mode {
    case .observe: "observe"
    case .confirmEveryTrade: "confirm_every_trade"
    case .automaticWithinLimits: "automatic_within_limits"
    }
  }
}

private func riskPolicyRequiresStepUp(
  candidate: APIRiskPolicyDTO, current: APIRiskPolicyDTO
) -> Bool {
  let maximumWasRaised =
    candidate.maximumAccountAllocation > current.maximumAccountAllocation
    || candidate.maximumPositionAmount > current.maximumPositionAmount
    || candidate.maximumNewOrderAmount > current.maximumNewOrderAmount
    || candidate.maximumDailyLoss > current.maximumDailyLoss
    || candidate.maximumPortfolioDrawdown > current.maximumPortfolioDrawdown
    || candidate.maximumSimultaneousPositions > current.maximumSimultaneousPositions
    || candidate.maximumSymbolConcentration > current.maximumSymbolConcentration
    || candidate.maximumSectorConcentration > current.maximumSectorConcentration
    || candidate.maximumTradesPerDay > current.maximumTradesPerDay
    || candidate.maximumDailyTurnover > current.maximumDailyTurnover
    || candidate.maximumOptionsExposure > current.maximumOptionsExposure
    || candidate.maximumOptionRiskPerTrade > current.maximumOptionRiskPerTrade
    || candidate.maximumContractsPerTrade > current.maximumContractsPerTrade
    || candidate.maximumDaysToExpiration > current.maximumDaysToExpiration
    || candidate.maximumBidAskSpreadRatio > current.maximumBidAskSpreadRatio
    || candidate.maximumQuoteAgeSeconds > current.maximumQuoteAgeSeconds
    || candidate.maximumAccountSnapshotAgeSeconds > current.maximumAccountSnapshotAgeSeconds
    || candidate.maximumPriceDeviationRatio > current.maximumPriceDeviationRatio
  let minimumWasLowered =
    candidate.minimumBuyingPowerReserve < current.minimumBuyingPowerReserve
    || candidate.minimumDaysToExpiration < current.minimumDaysToExpiration
  let permissionWasAdded =
    (!current.fractionalSharesPermitted && candidate.fractionalSharesPermitted)
    || (!current.extendedHoursPermitted && candidate.extendedHoursPermitted)
    || (!current.earningsTradesPermitted && candidate.earningsTradesPermitted)
    || (!current.coveredCallsPermitted && candidate.coveredCallsPermitted)
    || (!current.protectivePutsPermitted && candidate.protectivePutsPermitted)
    || (!current.definedRiskSpreadsPermitted && candidate.definedRiskSpreadsPermitted)
  let symbolExclusionWasRemoved =
    !Set(current.excludedSymbols).isSubset(of: Set(candidate.excludedSymbols))
  let sectorExclusionWasRemoved =
    !Set(current.excludedSectors).isSubset(of: Set(candidate.excludedSectors))
  return maximumWasRaised || minimumWasLowered || permissionWasAdded
    || symbolExclusionWasRemoved || sectorExclusionWasRemoved
}

extension JSONEncoder {
  fileprivate static var api: JSONEncoder {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    return encoder
  }
}

extension JSONDecoder {
  fileprivate static var api: JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return decoder
  }
}
