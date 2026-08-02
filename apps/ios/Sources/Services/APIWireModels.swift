import Foundation

enum APIWireMappingError: LocalizedError, Equatable {
  case invalidField(String)
  case environmentMismatch(expected: TreasuryMode, received: String)
  case dataClassificationMismatch(expected: TreasuryMode, received: String)

  var errorDescription: String? {
    switch self {
    case .invalidField(let field): "The server response contains an invalid \(field)."
    case .environmentMismatch(let expected, let received):
      "Expected \(expected.title) data, but the server identified the account as \(received)."
    case .dataClassificationMismatch(let expected, let received):
      "Expected \(expected.title) data, but the server classified the values as \(received)."
    }
  }
}

struct APIListEnvelope<Element: Decodable>: Decodable {
  let data: [Element]
  let nextCursor: String?
}

struct APIPlanCatalogEnvelopeDTO: Decodable {
  let data: [APIPlanCatalogDTO]
  let priceSource: String
}

struct APIPlanCatalogDTO: Decodable {
  let id: String
  let name: String
  let productID: String
  let features: APIEntitlementsDTO
  let agentCatalogVersion: Int
  let agents: [APIPlanAgentAssignmentDTO]

  enum CodingKeys: String, CodingKey {
    case id, name
    case productID = "productId"
    case features, agentCatalogVersion, agents
  }
}

struct APIEntitlementsDTO: Decodable {
  let stockTrading: Bool
  let optionsTrading: Bool
  let multiLegOptions: Bool
  let maximumActiveAgents: Int
  let automaticMode: Bool
  let monitoringFrequencyMinutes: Int
  let advancedAnalytics: Bool
  let customWatchlists: Bool
  let scannerAccess: Bool
  let agentCatalog: [String]
  let prioritySupport: Bool
}

struct APIPlanAgentAssignmentDTO: Decodable {
  let agentID: String
  let displayName: String
  let agentVersion: String
  let catalogPosition: Int
  let releaseStatus: String
  let deterministicStrategyVersion: String
  let researchUniverse: [String]

  enum CodingKeys: String, CodingKey {
    case agentID = "agentId"
    case displayName, agentVersion, catalogPosition, releaseStatus
    case deterministicStrategyVersion, researchUniverse
  }
}

struct APISubscriptionDTO: Decodable {
  let status: String
  let planID: String?
  let productID: String?
  let source: String

  enum CodingKeys: String, CodingKey {
    case status
    case planID = "planId"
    case productID = "productId"
    case source
  }
}

enum APIPlanCatalogContextMapper {
  static func domain(
    catalog: APIPlanCatalogEnvelopeDTO,
    subscription: APISubscriptionDTO,
    entitlements: APIEntitlementsDTO
  ) throws -> PlanCatalogContext {
    guard
      catalog.priceSource
        == "StoreKit; display prices must be supplied by the client StoreKit response",
      !catalog.data.isEmpty
    else { throw APIWireMappingError.invalidField("plan catalog") }

    var seenTiers = Set<PlanTier>()
    var seenProducts = Set<String>()
    var plans: [SubscriptionPlan] = []
    var researchUniverseByPlan: [PlanTier: [String: [String]]] = [:]
    for value in catalog.data {
      guard let tier = planTier(value.id), seenTiers.insert(tier).inserted,
        !value.productID.isEmpty, seenProducts.insert(value.productID).inserted,
        value.name == tier.title, value.agentCatalogVersion > 0,
        (1...3).contains(value.agents.count)
      else { throw APIWireMappingError.invalidField("plan identity") }
      try validateEntitlements(value.features, allowEmpty: false)

      var universes: [String: [String]] = [:]
      var orderedAgentIDs: [String] = []
      for (index, assignment) in value.agents.enumerated() {
        guard assignment.catalogPosition == index + 1,
          !assignment.agentID.isEmpty,
          !assignment.displayName.isEmpty,
          !assignment.agentVersion.isEmpty,
          !assignment.deterministicStrategyVersion.isEmpty,
          ["draft", "paper", "limited_rollout", "live", "paused", "retired"]
            .contains(assignment.releaseStatus),
          universes[assignment.agentID] == nil
        else { throw APIWireMappingError.invalidField("plan agent assignment") }
        try validateResearchUniverse(assignment.researchUniverse)
        universes[assignment.agentID] = assignment.researchUniverse
        orderedAgentIDs.append(assignment.agentID)
      }
      guard orderedAgentIDs == value.features.agentCatalog,
        value.features.maximumActiveAgents <= value.agents.count
      else { throw APIWireMappingError.invalidField("plan agent catalog") }

      plans.append(subscriptionPlan(value, tier: tier))
      researchUniverseByPlan[tier] = universes
    }
    plans.sort {
      PlanTier.allCases.firstIndex(of: $0.tier)! < PlanTier.allCases.firstIndex(of: $1.tier)!
    }

    let currentPlanTier: PlanTier?
    let maximumActiveAgents: Int?
    if ["active", "grace_period"].contains(subscription.status) {
      guard subscription.source == "verified_storekit",
        let planID = subscription.planID,
        let tier = planTier(planID),
        let currentPlan = catalog.data.first(where: { $0.id == planID }),
        subscription.productID == currentPlan.productID
      else { throw APIWireMappingError.invalidField("subscription plan") }
      try validateEntitlements(entitlements, allowEmpty: false)
      guard entitlements.agentCatalog == currentPlan.features.agentCatalog,
        entitlements.maximumActiveAgents <= currentPlan.agents.count
      else { throw APIWireMappingError.invalidField("effective entitlements") }
      currentPlanTier = tier
      maximumActiveAgents = entitlements.maximumActiveAgents
    } else {
      let hasNoSubscription =
        subscription.status == "pending" && subscription.source == "none"
        && subscription.planID == nil && subscription.productID == nil
      let isInactiveSubscription =
        ["billing_retry", "expired", "revoked", "refunded"]
        .contains(subscription.status) && subscription.source == "verified_storekit"
        && catalog.data.contains(where: {
          $0.id == subscription.planID && $0.productID == subscription.productID
        })
      guard hasNoSubscription || isInactiveSubscription
      else { throw APIWireMappingError.invalidField("subscription status") }
      try validateEntitlements(entitlements, allowEmpty: true)
      currentPlanTier = nil
      maximumActiveAgents = nil
    }

    return PlanCatalogContext(
      plans: plans,
      currentPlanTier: currentPlanTier,
      maximumActiveAgents: maximumActiveAgents,
      researchUniverseByPlan: researchUniverseByPlan)
  }

  private static func validateEntitlements(_ value: APIEntitlementsDTO, allowEmpty: Bool) throws {
    let empty =
      value.maximumActiveAgents == 0 && value.monitoringFrequencyMinutes == 0
      && value.agentCatalog.isEmpty && !value.stockTrading && !value.optionsTrading
      && !value.multiLegOptions && !value.automaticMode && !value.advancedAnalytics
      && !value.customWatchlists && !value.scannerAccess && !value.prioritySupport
    if allowEmpty {
      guard empty else { throw APIWireMappingError.invalidField("inactive entitlements") }
      return
    }
    guard (1...3).contains(value.maximumActiveAgents),
      (1...525_600).contains(value.monitoringFrequencyMinutes),
      (1...3).contains(value.agentCatalog.count),
      Set(value.agentCatalog).count == value.agentCatalog.count,
      value.agentCatalog.allSatisfy({ !$0.isEmpty }),
      !value.optionsTrading || value.stockTrading,
      !value.multiLegOptions || value.optionsTrading
    else { throw APIWireMappingError.invalidField("entitlements") }
  }

  private static func validateResearchUniverse(_ symbols: [String]) throws {
    let pattern = try NSRegularExpression(pattern: "^[A-Z][A-Z0-9.-]{0,14}$")
    guard (1...50).contains(symbols.count), Set(symbols).count == symbols.count,
      symbols == symbols.sorted(),
      symbols.allSatisfy({ symbol in
        pattern.firstMatch(
          in: symbol, range: NSRange(symbol.startIndex..., in: symbol)) != nil
      })
    else { throw APIWireMappingError.invalidField("research universe") }
  }

  private static func subscriptionPlan(
    _ value: APIPlanCatalogDTO, tier: PlanTier
  ) -> SubscriptionPlan {
    let agentCount = value.features.maximumActiveAgents
    var features = [
      value.features.optionsTrading ? "Stocks, ETFs, and approved options" : "Stocks and ETFs",
      agentCount == 1 ? "One active agent" : "Up to \(agentCount) active agents",
      value.features.monitoringFrequencyMinutes >= 1_440
        ? "Daily scheduled analysis"
        : "Analysis every \(value.features.monitoringFrequencyMinutes) minutes",
    ]
    if value.features.multiLegOptions {
      features.append("Approved defined-risk multi-leg strategies")
    }
    if value.features.advancedAnalytics { features.append("Advanced analytics") }
    if value.features.automaticMode { features.append("Automatic mode when separately approved") }
    return SubscriptionPlan(
      tier: tier,
      productID: value.productID,
      summary:
        "\(value.name) publishes \(value.agents.count) versioned strateg\(value.agents.count == 1 ? "y" : "ies") with the same platform safety controls.",
      features: features,
      maximumActiveAgents: agentCount,
      supportsOptions: value.features.optionsTrading,
      supportsAutomaticMode: value.features.automaticMode)
  }
}

struct APIDashboardDTO: Decodable {
  let mode: String
  let dataClassification: String
  let portfolio: Portfolio
  let agentStatus: AgentStatus
  let risk: Risk

  struct Portfolio: Decodable {
    let value: Double
    let todayChange: Double
    let todayChangePercent: Double
    let asOf: Date
    let dataClassification: String
  }

  struct AgentStatus: Decodable {
    let riskState: String
  }

  struct Risk: Decodable {
    let dailyLossUsed: Double
    let dailyLossLimit: Double
    let allocationUsed: Double
    let buyingPowerReserve: Double
  }

  func domain(history: [PortfolioPoint], expectedMode: TreasuryMode) throws -> DashboardSnapshot {
    try validateWireMode(mode, classification: dataClassification, expected: expectedMode)
    try validateClassification(portfolio.dataClassification, expected: expectedMode)
    guard portfolio.value >= 0, risk.dailyLossLimit > 0,
      (0...1).contains(risk.allocationUsed), (0...1).contains(risk.buyingPowerReserve)
    else { throw APIWireMappingError.invalidField("dashboard values") }
    let state: RiskState
    switch agentStatus.riskState {
    case "within_limits": state = .normal
    case "warning", "approaching_limit": state = .warning
    case "halted", "risk_halt": state = .halted
    default: throw APIWireMappingError.invalidField("riskState")
    }
    return DashboardSnapshot(
      accountValue: portfolio.value,
      todayChange: portfolio.todayChange,
      todayPercent: portfolio.todayChangePercent * 100,
      mode: expectedMode,
      updatedAt: portfolio.asOf,
      isStale: Date.now.timeIntervalSince(portfolio.asOf) > 300,
      dataLabel: expectedMode == .demo
        ? "Server Demo data · not brokerage results"
        : "Authoritative Paper simulation · not brokerage results",
      history: history,
      riskState: state,
      riskUsages: [
        RiskUsage(
          id: "loss", title: "Daily loss", used: risk.dailyLossUsed,
          limit: risk.dailyLossLimit, displayUnit: "currency", symbol: "arrow.down.right"),
        RiskUsage(
          id: "allocation", title: "Portfolio allocation", used: risk.allocationUsed * 100,
          limit: 100, displayUnit: "percent", symbol: "chart.pie"),
        RiskUsage(
          id: "reserve", title: "Buying-power reserve", used: risk.buyingPowerReserve * 100,
          limit: 100, displayUnit: "reserve", symbol: "banknote"),
      ],
      buyingPowerReserve: portfolio.value * risk.buyingPowerReserve
    )
  }
}

struct APIPortfolioHistoryDTO: Decodable {
  let mode: String
  let data: [Point]
  let benchmark: [Point]?
  let dataClassification: String

  struct Point: Decodable {
    let timestamp: Date
    let value: Double
  }

  func domain(expectedMode: TreasuryMode) throws -> [PortfolioPoint] {
    try validateWireMode(mode, classification: dataClassification, expected: expectedMode)
    let benchmarkByDate = Dictionary(
      uniqueKeysWithValues: (benchmark ?? []).map {
        ($0.timestamp, $0.value)
      })
    return try data.map { point in
      guard point.value >= 0 else { throw APIWireMappingError.invalidField("history value") }
      return PortfolioPoint(
        date: point.timestamp, value: point.value, benchmarkValue: benchmarkByDate[point.timestamp])
    }
  }
}

struct APIPositionDTO: Decodable {
  let id: String
  let symbol: String
  let companyName: String?
  let instrumentType: String
  let quantity: Double
  let averageCost: Double?
  let marketValue: Double?
  let todayPnL: Double?
  let unrealizedPnL: Double?
  let strategy: String?
  let expiration: String?
  let maximumLoss: Double?
  let dataClassification: String

  enum CodingKeys: String, CodingKey {
    case id, symbol, companyName, instrumentType, quantity, averageCost, marketValue
    case todayPnL = "todayPnl"
    case unrealizedPnL = "unrealizedPnl"
    case strategy, expiration, maximumLoss, dataClassification
  }

  func domain(expectedMode: TreasuryMode) throws -> Position {
    try validateClassification(dataClassification, expected: expectedMode)
    guard !id.isEmpty, !symbol.isEmpty, quantity >= 0 else {
      throw APIWireMappingError.invalidField("position identity or quantity")
    }
    let kind: PositionKind
    switch instrumentType {
    case "equity": kind = .stock
    case "option": kind = .option
    default: throw APIWireMappingError.invalidField("instrumentType")
    }
    let value = marketValue ?? 0
    let cost = averageCost ?? 0
    let price = quantity > 0 ? value / quantity : 0
    let dayChange = todayPnL ?? 0
    let priorValue = value - dayChange
    let totalReturn = unrealizedPnL ?? 0
    let costBasis = max(value - totalReturn, 0)
    let expirationDate = try expiration.map(parseAPIDateOnly)
    let unavailable = "The API did not supply quote time, realized P&L, sector, or tax-lot detail."
    return Position(
      id: id,
      symbol: symbol,
      name: companyName ?? symbol,
      kind: kind,
      quantity: quantity,
      averageCost: cost,
      currentPrice: price,
      marketValue: value,
      todayChange: dayChange,
      todayPercent: priorValue > 0 ? dayChange / priorValue * 100 : 0,
      totalReturn: totalReturn,
      totalReturnPercent: costBasis > 0 ? totalReturn / costBasis * 100 : 0,
      realizedPnL: 0,
      sector: "Not supplied",
      quoteTimestamp: .distantPast,
      expiration: expirationDate,
      strategyName: strategy,
      maximumLoss: maximumLoss,
      maximumProfit: nil,
      breakeven: nil,
      optionLegs: [],
      liquidityNote: unavailable,
      thesisHistory: [],
      isWatchlisted: false,
      isExcluded: false
    )
  }
}

struct APIAgentDefinitionDTO: Decodable {
  let agentID: String
  let displayName: String
  let version: String
  let strategyCategory: String
  let requiredSubscription: String
  let permittedAccountModes: [String]
  let permittedInstruments: [String]
  let requiredBrokerageCapabilities: [String]
  let riskClassification: String
  let typicalHoldingPeriod: String
  let analysisSchedule: String
  let entryCriteria: [String]
  let exitCriteria: [String]
  let dataDependencies: [String]
  let hardRiskRequirements: [String]
  let restrictedMarketConditions: [String]
  let deterministicStrategyVersion: String
  let status: String
  let disclosureText: String
  let changeLog: [Change]

  enum CodingKeys: String, CodingKey {
    case agentID = "agentId"
    case displayName, version, strategyCategory, requiredSubscription, permittedAccountModes
    case permittedInstruments, requiredBrokerageCapabilities, riskClassification
    case typicalHoldingPeriod, analysisSchedule, entryCriteria, exitCriteria, dataDependencies
    case hardRiskRequirements, restrictedMarketConditions, deterministicStrategyVersion, status
    case disclosureText, changeLog
  }

  struct Change: Decodable {
    let version: String
    let date: String
    let summary: String
  }

  func domain(userAgent: APIUserAgentDTO?, expectedMode: TreasuryMode) throws -> InvestmentAgent {
    guard permittedAccountModes.contains(expectedMode.rawValue) else {
      throw APIWireMappingError.environmentMismatch(
        expected: expectedMode, received: permittedAccountModes.joined(separator: ","))
    }
    guard let plan = planTier(requiredSubscription),
      let risk = riskCategory(riskClassification)
    else { throw APIWireMappingError.invalidField("agent classification") }
    let availability: AgentAvailability
    switch status {
    case "paper": availability = expectedMode == .paper ? .paperOnly : .available
    case "limited_rollout": availability = .locked
    case "live": availability = expectedMode == .live ? .available : .locked
    case "draft", "paused", "retired": availability = .complianceHold
    default: throw APIWireMappingError.invalidField("agent status")
    }
    let mode = try userAgent.map { try operatingMode($0.approvalMode) } ?? .observe
    let runtime = try userAgent.map { try runtimeStatus($0.status) } ?? .paused
    return InvestmentAgent(
      id: agentID,
      name: displayName,
      version: version,
      strategy: strategyCategory.replacingOccurrences(of: "_", with: " ").capitalized,
      assetClass: permittedInstruments.map { $0.capitalized }.joined(separator: ", "),
      requiredPlan: plan,
      riskCategory: risk,
      holdingPeriod: typicalHoldingPeriod,
      cadence: analysisSchedule,
      summary: disclosureText,
      objective: strategyCategory.replacingOccurrences(of: "_", with: " ").capitalized,
      howItDecides: entryCriteria,
      canTrade: permittedInstruments,
      cannotTrade: restrictedMarketConditions,
      struggles: restrictedMarketConditions,
      riskControls: hardRiskRequirements,
      brokerPermissions: requiredBrokerageCapabilities,
      disclosure: disclosureText,
      icon: permittedInstruments.contains("option") ? "option" : "chart.line.uptrend.xyaxis",
      releaseStatus: status.replacingOccurrences(of: "_", with: " ").capitalized,
      versionHistory: changeLog.map { "\($0.version) · \($0.date) · \($0.summary)" },
      availability: availability,
      isActive: userAgent != nil,
      runtimeStatus: runtime,
      operatingMode: mode,
      allocationPercent: (userAgent?.allocation ?? 0) * 100,
      lastRun: nil,
      nextRun: nil,
      recentDecision: userAgent == nil ? "Not activated." : "No run result supplied.",
      activationID: userAgent?.id,
      configuredSymbol: userAgent?.configuration?.symbol,
      targetOrderAmount: userAgent?.configuration?.targetOrderAmount
    )
  }
}

struct APIUserAgentDTO: Decodable {
  let id: String
  let agentID: String
  let status: String
  let allocation: Double
  let approvalMode: String
  let configuration: Configuration?

  struct Configuration: Decodable {
    let symbol: String?
    let targetOrderAmount: Double?
  }

  enum CodingKeys: String, CodingKey {
    case id
    case agentID = "agentId"
    case status, allocation, approvalMode, configuration
  }
}

struct APIProposalRecordDTO: Decodable {
  let id: String
  let status: String
  let proposal: APITradeProposalDTO
  let updatedAt: Date

  func domain(agentName: String? = nil) throws -> ActivityEvent {
    let proposal = try proposal.domain(state: status, agentName: agentName)
    return ActivityEvent(
      id: id,
      type: .proposal,
      timestamp: updatedAt,
      agentName: proposal.agentName,
      symbol: proposal.symbol,
      status: proposal.state.title,
      summary: proposal.entryReasoning.first ?? "Proposal status updated.",
      mode: proposal.mode,
      proposal: proposal,
      order: nil,
      agentRun: nil,
      riskEvent: nil
    )
  }
}

struct APITradeProposalDTO: Decodable {
  let proposalID: String
  let agentDefinitionID: String
  let agentVersion: String
  let environment: String
  let instrumentType: String
  let symbol: String
  let side: String
  let quantity: Double
  let notionalEstimate: Double
  let orderType: String
  let limitPrice: Double?
  let timeInForce: String
  let strategyType: String
  let entryReason: String
  let exitPlan: String
  let invalidationCondition: String
  let dataTimestamp: Date
  let quoteTimestamp: Date
  let maximumLoss: Double?
  let estimatedPortfolioAllocationAfter: Double
  let riskAmount: Double
  let expirationTimestamp: Date
  let warnings: [String]

  enum CodingKeys: String, CodingKey {
    case proposalID = "proposalId"
    case agentDefinitionID = "agentDefinitionId"
    case agentVersion, environment, instrumentType, symbol, side, quantity, notionalEstimate
    case orderType, limitPrice, timeInForce, strategyType, entryReason, exitPlan
    case invalidationCondition, dataTimestamp, quoteTimestamp, maximumLoss
    case estimatedPortfolioAllocationAfter, riskAmount, expirationTimestamp, warnings
  }

  func domain(state: String, agentName: String?) throws -> TradeProposal {
    guard let mode = TreasuryMode(rawValue: environment), mode != .live,
      let proposalState = ProposalState(rawValue: state), quantity > 0,
      notionalEstimate >= 0, riskAmount >= 0,
      (0...1).contains(estimatedPortfolioAllocationAfter)
    else { throw APIWireMappingError.invalidField("trade proposal") }
    return TradeProposal(
      id: proposalID,
      agentID: agentDefinitionID,
      agentName: agentName ?? agentDefinitionID,
      agentVersion: agentVersion,
      createdAt: dataTimestamp,
      dataTimestamp: dataTimestamp,
      quoteTimestamp: quoteTimestamp,
      mode: mode,
      instrument: instrumentType.capitalized,
      symbol: symbol,
      side: side.capitalized,
      quantity: quantity,
      estimatedNotional: notionalEstimate,
      orderType: orderType.replacingOccurrences(of: "_", with: " ").capitalized,
      limitPrice: limitPrice,
      timeInForce: timeInForce.uppercased(),
      strategy: strategyType.replacingOccurrences(of: "_", with: " ").capitalized,
      thesisSummary: entryReason,
      entryReasoning: [entryReason],
      exitPlan: exitPlan,
      invalidatingCondition: invalidationCondition,
      expectedHoldingPeriod: "Not supplied by API",
      knownCatalysts: [],
      riskAmount: riskAmount,
      maximumLoss: maximumLoss,
      allocationAfter: estimatedPortfolioAllocationAfter * 100,
      warnings: warnings,
      riskChecks: [],
      brokerReview: "Broker review detail was not supplied by the API.",
      entitlement: "Server authorization required",
      brokeragePermission: "Server and broker remain authoritative",
      approvalExpiresAt: expirationTimestamp,
      state: proposalState
    )
  }
}

struct APIOrderFillDTO: Decodable {
  let id: String
  let timestamp: Date
  let quantity: Double
  let price: Double
}

struct APIOrderTimelineDTO: Decodable {
  let status: String
  let occurredAt: Date
  let reasonCode: String?
}

struct APIOrderRecordDTO: Decodable {
  let id: String
  let proposalID: String
  let status: String
  let symbol: String
  let side: String
  let quantity: Double
  let filledQuantity: Double
  let remainingQuantity: Double
  let averageFillPrice: Double?
  let brokerOrderID: String?
  let instrumentType: String
  let orderType: String
  let limitPrice: Double?
  let timeInForce: String
  let submittedAt: Date?
  let terminalAt: Date?
  let statusReason: String?
  let reconciliationStatus: String
  let fills: [APIOrderFillDTO]
  let auditTimeline: [APIOrderTimelineDTO]
  let updatedAt: Date
  let mode: String
  let dataClassification: String

  enum CodingKeys: String, CodingKey {
    case id
    case proposalID = "proposalId"
    case status, symbol, side, quantity, filledQuantity, remainingQuantity, averageFillPrice
    case brokerOrderID = "brokerOrderId"
    case instrumentType, orderType, limitPrice, timeInForce, submittedAt, terminalAt, statusReason
    case reconciliationStatus, fills, auditTimeline
    case updatedAt, mode, dataClassification
  }

  func domain(expectedMode: TreasuryMode) throws -> ActivityEvent {
    try validateWireMode(mode, classification: dataClassification, expected: expectedMode)
    guard let state = ProposalState(rawValue: status) else {
      throw APIWireMappingError.invalidField("order status")
    }
    return ActivityEvent(
      id: id,
      type: state == .filled ? .fill : .order,
      timestamp: updatedAt,
      agentName: nil,
      symbol: symbol,
      status: state.title,
      summary:
        "\(side.capitalized) \(FinancialFormatters.quantity(quantity)) \(symbol) · authoritative \(expectedMode.title) order state.",
      mode: expectedMode,
      proposal: nil,
      order: OrderDetail(
        proposalID: proposalID,
        brokerOrderID: brokerOrderID,
        submittedAt: submittedAt,
        terminalAt: terminalAt,
        side: side.capitalized,
        instrumentType: instrumentType.capitalized,
        orderType: orderType.capitalized,
        limitPrice: limitPrice,
        timeInForce: timeInForce.uppercased(),
        status: state,
        fills: fills.map {
          FillRecord(id: $0.id, timestamp: $0.timestamp, quantity: $0.quantity, price: $0.price)
        },
        averageFillPrice: averageFillPrice,
        remainingQuantity: remainingQuantity,
        statusReason: statusReason?.replacingOccurrences(of: "_", with: " ").capitalized,
        reconciliationStatus:
          reconciliationStatus.replacingOccurrences(of: "_", with: " ").capitalized,
        auditTimeline: auditTimeline.map {
          let reason =
            $0.reasonCode.map {
              " · \($0.replacingOccurrences(of: "_", with: " ").capitalized)"
            } ?? ""
          let title = $0.status.replacingOccurrences(of: "_", with: " ").capitalized
          return "\(title) · \(FinancialFormatters.timestamp($0.occurredAt))\(reason)"
        }
      ),
      agentRun: nil,
      riskEvent: nil
    )
  }
}

enum APIActivityItemDTO: Decodable {
  case proposal(APIProposalRecordDTO)
  case order(APIOrderRecordDTO)

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: Discriminator.self)
    if container.contains(.proposal) {
      self = .proposal(try APIProposalRecordDTO(from: decoder))
    } else if container.contains(.brokerOrderID) {
      self = .order(try APIOrderRecordDTO(from: decoder))
    } else {
      throw DecodingError.dataCorruptedError(
        forKey: .proposal, in: container, debugDescription: "Unknown activity record")
    }
  }

  private enum Discriminator: String, CodingKey {
    case proposal
    case brokerOrderID = "brokerOrderId"
  }
}

struct APIRiskPolicyDTO: Codable {
  let policyID: String?
  let userID: String?
  let version: Int?
  let maximumAccountAllocation: Double
  let maximumPositionAmount: Double
  let maximumNewOrderAmount: Double
  let maximumDailyLoss: Double
  let maximumPortfolioDrawdown: Double
  let minimumBuyingPowerReserve: Double
  let maximumSimultaneousPositions: Int
  let maximumSymbolConcentration: Double
  let maximumSectorConcentration: Double
  let maximumTradesPerDay: Int
  let maximumDailyTurnover: Double
  let maximumOptionsExposure: Double
  let maximumOptionRiskPerTrade: Double
  let maximumContractsPerTrade: Int
  let minimumDaysToExpiration: Int
  let maximumDaysToExpiration: Int
  let maximumBidAskSpreadRatio: Double
  let maximumQuoteAgeSeconds: Int
  let maximumAccountSnapshotAgeSeconds: Int
  let maximumPriceDeviationRatio: Double
  let excludedSymbols: [String]
  let excludedSectors: [String]
  let fractionalSharesPermitted: Bool
  let extendedHoursPermitted: Bool
  let earningsTradesPermitted: Bool
  let coveredCallsPermitted: Bool
  let protectivePutsPermitted: Bool
  let definedRiskSpreadsPermitted: Bool
  let deviceID: String?
  let stepUpProof: [String: String]?

  enum CodingKeys: String, CodingKey {
    case policyID = "policyId"
    case userID = "userId"
    case version
    case maximumAccountAllocation, maximumPositionAmount, maximumNewOrderAmount, maximumDailyLoss
    case maximumPortfolioDrawdown, minimumBuyingPowerReserve, maximumSimultaneousPositions
    case maximumSymbolConcentration, maximumSectorConcentration, maximumTradesPerDay
    case maximumDailyTurnover
    case maximumOptionsExposure, maximumOptionRiskPerTrade, maximumContractsPerTrade
    case minimumDaysToExpiration, maximumDaysToExpiration, maximumBidAskSpreadRatio
    case maximumQuoteAgeSeconds, maximumAccountSnapshotAgeSeconds, maximumPriceDeviationRatio
    case excludedSymbols, excludedSectors, fractionalSharesPermitted, extendedHoursPermitted
    case earningsTradesPermitted, coveredCallsPermitted, protectivePutsPermitted
    case definedRiskSpreadsPermitted
    case deviceID = "deviceId"
    case stepUpProof
  }

  init(
    domain: RiskPolicy, preserving current: APIRiskPolicyDTO? = nil,
    authorization: ProposalApprovalAuthorization? = nil
  ) {
    policyID = current?.policyID
    userID = current?.userID
    version = current?.version
    maximumAccountAllocation = domain.maximumAllocationPercent / 100
    maximumPositionAmount = domain.maximumPositionAmount
    maximumNewOrderAmount = domain.maximumOrderAmount
    maximumDailyLoss = domain.dailyLossLimit
    maximumPortfolioDrawdown = domain.drawdownHaltPercent / 100
    minimumBuyingPowerReserve = domain.buyingPowerReservePercent / 100
    maximumSimultaneousPositions = domain.maximumPositions
    maximumSymbolConcentration = current?.maximumSymbolConcentration ?? 0.15
    maximumSectorConcentration = current?.maximumSectorConcentration ?? 0.30
    maximumTradesPerDay = current?.maximumTradesPerDay ?? 5
    maximumDailyTurnover = current?.maximumDailyTurnover ?? 0.30
    maximumOptionsExposure = domain.maximumOptionsExposurePercent / 100
    maximumOptionRiskPerTrade = domain.maximumOptionsLoss
    maximumContractsPerTrade = domain.maximumContracts
    minimumDaysToExpiration = domain.minimumDaysToExpiration
    maximumDaysToExpiration = domain.maximumDaysToExpiration
    maximumBidAskSpreadRatio = domain.maximumBidAskSpreadPercent / 100
    maximumQuoteAgeSeconds = current?.maximumQuoteAgeSeconds ?? 30
    maximumAccountSnapshotAgeSeconds = current?.maximumAccountSnapshotAgeSeconds ?? 60
    maximumPriceDeviationRatio = current?.maximumPriceDeviationRatio ?? 0.02
    excludedSymbols = domain.excludedSymbols
    excludedSectors = domain.excludedSectors
    fractionalSharesPermitted = domain.allowFractionalShares
    extendedHoursPermitted = domain.allowExtendedHours
    earningsTradesPermitted = domain.allowEarningsTrading
    coveredCallsPermitted = domain.allowCoveredCalls
    protectivePutsPermitted = domain.allowProtectivePuts
    definedRiskSpreadsPermitted = domain.allowDefinedRiskSpreads
    deviceID = authorization?.deviceID
    stepUpProof = authorization?.proof
  }

  var domain: RiskPolicy {
    RiskPolicy(
      maximumAllocationPercent: maximumAccountAllocation * 100,
      maximumPositionAmount: maximumPositionAmount,
      maximumOrderAmount: maximumNewOrderAmount,
      dailyLossLimit: maximumDailyLoss,
      drawdownHaltPercent: maximumPortfolioDrawdown * 100,
      buyingPowerReservePercent: minimumBuyingPowerReserve * 100,
      maximumPositions: maximumSimultaneousPositions,
      excludedSymbols: excludedSymbols,
      excludedSectors: excludedSectors,
      allowEarningsTrading: earningsTradesPermitted,
      allowFractionalShares: fractionalSharesPermitted,
      allowExtendedHours: extendedHoursPermitted,
      maximumOptionsLoss: maximumOptionRiskPerTrade,
      maximumOptionsExposurePercent: maximumOptionsExposure * 100,
      maximumContracts: maximumContractsPerTrade,
      minimumDaysToExpiration: minimumDaysToExpiration,
      maximumDaysToExpiration: maximumDaysToExpiration,
      maximumBidAskSpreadPercent: maximumBidAskSpreadRatio * 100,
      allowCoveredCalls: coveredCallsPermitted,
      allowProtectivePuts: protectivePutsPermitted,
      allowDefinedRiskSpreads: definedRiskSpreadsPermitted,
      closeBeforeExpiration: true
    )
  }
}

struct APIPauseResponseDTO: Decodable {
  let paused: Bool
  let occurredAt: Date
  let positionsUntouched: Bool
}

struct APIResumeResponseDTO: Decodable {
  let resumed: Bool
  let occurredAt: Date
  let positionsUntouched: Bool
}

private func validateWireMode(
  _ mode: String, classification: String, expected: TreasuryMode
) throws {
  guard mode == expected.rawValue else {
    throw APIWireMappingError.environmentMismatch(expected: expected, received: mode)
  }
  try validateClassification(classification, expected: expected)
}

private func validateClassification(_ classification: String, expected: TreasuryMode) throws {
  guard classification == expected.rawValue else {
    throw APIWireMappingError.dataClassificationMismatch(
      expected: expected, received: classification)
  }
}

private func parseAPIDateOnly(_ value: String) throws -> Date {
  let formatter = DateFormatter()
  formatter.calendar = Calendar(identifier: .iso8601)
  formatter.locale = Locale(identifier: "en_US_POSIX")
  formatter.timeZone = TimeZone(secondsFromGMT: 0)
  formatter.dateFormat = "yyyy-MM-dd"
  guard let date = formatter.date(from: value) else {
    throw APIWireMappingError.invalidField("expiration")
  }
  return date
}

private func planTier(_ raw: String) -> PlanTier? {
  switch raw {
  case "equity": .equity
  case "equity_pro": .equityPro
  case "options": .options
  case "options_pro": .optionsPro
  default: nil
  }
}

private func riskCategory(_ raw: String) -> RiskCategory? {
  switch raw {
  case "conservative": .conservative
  case "moderate": .moderate
  case "growth": .growth
  case "aggressive": .aggressive
  case "options_restricted": .optionsRestricted
  default: nil
  }
}

private func operatingMode(_ raw: String) throws -> AgentOperatingMode {
  switch raw {
  case "observe": .observe
  case "confirm_every_trade": .confirmEveryTrade
  case "automatic_within_limits": .automaticWithinLimits
  default: throw APIWireMappingError.invalidField("approvalMode")
  }
}

private func runtimeStatus(_ raw: String) throws -> AgentRuntimeStatus {
  switch raw {
  case "monitoring": .monitoring
  case "paused": .paused
  default: throw APIWireMappingError.invalidField("agent runtime status")
  }
}
