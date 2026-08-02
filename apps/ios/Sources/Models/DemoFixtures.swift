import Foundation

enum DemoFixtures {
  static let now = Date.now

  static var recommendedRiskPolicy: RiskPolicy {
    RiskPolicy(
      maximumAllocationPercent: 70,
      maximumPositionAmount: 2_500,
      maximumOrderAmount: 1_200,
      dailyLossLimit: 450,
      drawdownHaltPercent: 12,
      buyingPowerReservePercent: 25,
      maximumPositions: 10,
      excludedSymbols: ["GME"],
      excludedSectors: [],
      allowEarningsTrading: false,
      allowFractionalShares: true,
      allowExtendedHours: false,
      maximumOptionsLoss: 350,
      maximumOptionsExposurePercent: 8,
      maximumContracts: 2,
      minimumDaysToExpiration: 14,
      maximumDaysToExpiration: 75,
      maximumBidAskSpreadPercent: 8,
      allowCoveredCalls: true,
      allowProtectivePuts: true,
      allowDefinedRiskSpreads: false,
      closeBeforeExpiration: true
    )
  }

  static var dashboard: DashboardSnapshot {
    DashboardSnapshot(
      accountValue: 24_862.41,
      todayChange: -117.62,
      todayPercent: -0.47,
      mode: .demo,
      updatedAt: now.addingTimeInterval(-54),
      isStale: false,
      dataLabel: "Seeded Demo data · not brokerage results",
      history: portfolioHistory,
      riskState: .warning,
      riskUsages: [
        RiskUsage(
          id: "loss", title: "Daily loss", used: 117.62, limit: 450, displayUnit: "currency",
          symbol: "arrow.down.right"),
        RiskUsage(
          id: "allocation", title: "Portfolio allocation", used: 52, limit: 70,
          displayUnit: "percent", symbol: "chart.pie"),
        RiskUsage(
          id: "options", title: "Options exposure", used: 3.1, limit: 8, displayUnit: "percent",
          symbol: "option"),
        RiskUsage(
          id: "reserve", title: "Buying-power reserve", used: 31, limit: 25, displayUnit: "reserve",
          symbol: "banknote"),
      ],
      buyingPowerReserve: 7_708.12
    )
  }

  static var portfolioHistory: [PortfolioPoint] {
    let calendar = Calendar(identifier: .gregorian)
    return (0..<240).map { index in
      let daysAgo = 239 - index
      let date = calendar.date(byAdding: .day, value: -daysAgo, to: now) ?? now
      let trend = Double(index) * 22.4
      let wave = sin(Double(index) / 9) * 410 + cos(Double(index) / 23) * 260
      let value = 19_210 + trend + wave
      let benchmark = 19_210 + Double(index) * 19.2 + sin(Double(index) / 16) * 190
      return PortfolioPoint(date: date, value: value, benchmarkValue: benchmark)
    }
  }

  static var positions: [Position] {
    let calendar = Calendar(identifier: .gregorian)
    let expiration = calendar.date(byAdding: .day, value: 37, to: now) ?? now
    return [
      Position(
        id: "pos-vti", symbol: "VTI", name: "Vanguard Total Stock Market ETF", kind: .etf,
        quantity: 31.25, averageCost: 241.08, currentPrice: 266.14, marketValue: 8_316.88,
        todayChange: -24.69, todayPercent: -0.30, totalReturn: 783.13, totalReturnPercent: 10.39,
        realizedPnL: 0, sector: "Broad Market", quoteTimestamp: now.addingTimeInterval(-60),
        expiration: nil,
        strategyName: nil, maximumLoss: nil, maximumProfit: nil, breakeven: nil, optionLegs: [],
        liquidityNote: nil,
        thesisHistory: [
          ThesisNote(
            date: now.addingTimeInterval(-86_400 * 2),
            summary: "Diversified core allocation remains below its concentration ceiling."),
          ThesisNote(
            date: now.addingTimeInterval(-86_400 * 15),
            summary: "No rebalance needed after scheduled review."),
        ], isWatchlisted: true, isExcluded: false
      ),
      Position(
        id: "pos-msft", symbol: "MSFT", name: "Microsoft Corporation", kind: .stock,
        quantity: 12, averageCost: 402.10, currentPrice: 431.28, marketValue: 5_175.36,
        todayChange: 51.24, todayPercent: 1.00, totalReturn: 350.16, totalReturnPercent: 7.26,
        realizedPnL: 84.20, sector: "Technology", quoteTimestamp: now.addingTimeInterval(-48),
        expiration: nil,
        strategyName: nil, maximumLoss: nil, maximumProfit: nil, breakeven: nil, optionLegs: [],
        liquidityNote: nil,
        thesisHistory: [
          ThesisNote(
            date: now.addingTimeInterval(-86_400 * 4),
            summary: "Quality and trend filters remain positive; earnings restriction is active.")
        ],
        isWatchlisted: true, isExcluded: false
      ),
      Position(
        id: "pos-xlv", symbol: "XLV", name: "Health Care Select Sector SPDR Fund", kind: .etf,
        quantity: 23, averageCost: 141.12, currentPrice: 146.75, marketValue: 3_375.25,
        todayChange: -19.78, todayPercent: -0.58, totalReturn: 129.49, totalReturnPercent: 3.99,
        realizedPnL: 0, sector: "Health Care", quoteTimestamp: now.addingTimeInterval(-51),
        expiration: nil,
        strategyName: nil, maximumLoss: nil, maximumProfit: nil, breakeven: nil, optionLegs: [],
        liquidityNote: nil,
        thesisHistory: [
          ThesisNote(
            date: now.addingTimeInterval(-86_400 * 7),
            summary: "Position continues to reduce portfolio sector concentration.")
        ],
        isWatchlisted: false, isExcluded: false
      ),
      Position(
        id: "pos-aapl-put", symbol: "AAPL", name: "Apple Inc. protective put", kind: .option,
        quantity: 1, averageCost: 4.82, currentPrice: 5.47, marketValue: 547,
        todayChange: 24, todayPercent: 4.59, totalReturn: 65, totalReturnPercent: 13.49,
        realizedPnL: 0, sector: "Technology", quoteTimestamp: now.addingTimeInterval(-72),
        expiration: expiration,
        strategyName: "Protective Put", maximumLoss: 482, maximumProfit: nil, breakeven: 204.18,
        optionLegs: [
          OptionLeg(side: .long, type: .put, strike: 205, expiration: expiration, quantity: 1)
        ],
        liquidityNote: "Demo quote: spread is 6.2%. Limit orders required.",
        thesisHistory: [
          ThesisNote(
            date: now.addingTimeInterval(-86_400),
            summary: "Downside protection retained through the next scheduled risk review.")
        ],
        isWatchlisted: false, isExcluded: false
      ),
    ]
  }

  static var allocation: [AllocationSlice] {
    [
      AllocationSlice(id: "etf", name: "ETFs", value: 46.9),
      AllocationSlice(id: "stocks", name: "Stocks", value: 31.4),
      AllocationSlice(id: "options", name: "Options", value: 3.1),
      AllocationSlice(id: "cash", name: "Reserve", value: 18.6),
    ]
  }

  static var performanceMetrics: [PerformanceMetric] {
    [
      PerformanceMetric(
        id: "net", title: "Net return", value: "+8.4%",
        context: "Demo · time-weighted · fees included"),
      PerformanceMetric(
        id: "drawdown", title: "Maximum drawdown", value: "−5.8%", context: "Demo period"),
      PerformanceMetric(
        id: "volatility", title: "Annualized volatility", value: "12.1%",
        context: "Insufficient for prediction"),
      PerformanceMetric(id: "turnover", title: "Turnover", value: "18.7%", context: "Demo period"),
      PerformanceMetric(
        id: "wins", title: "Closed outcomes", value: "9 gains · 5 losses", context: "Not a forecast"
      ),
      PerformanceMetric(
        id: "average", title: "Average outcome", value: "+2.1% / −1.4%", context: "Gain / loss"),
    ]
  }

  static var plans: [SubscriptionPlan] {
    [
      SubscriptionPlan(
        tier: .equity, productID: "whox.treasury.equity.monthly",
        summary: "Long-only stocks and ETFs with one active agent.",
        features: [
          "Stocks and ETFs", "One active agent", "Daily scheduled analysis", "Confirm Every Trade",
          "Paper mode",
        ],
        maximumActiveAgents: 1, supportsOptions: false, supportsAutomaticMode: false
      ),
      SubscriptionPlan(
        tier: .equityPro, productID: "whox.treasury.equitypro.monthly",
        summary: "More agents, monitoring, scanners, and analytics.",
        features: [
          "Up to three agents", "Momentum and quality strategies", "Advanced watchlists",
          "Custom exclusions", "Automatic mode when approved",
        ],
        maximumActiveAgents: 3, supportsOptions: false, supportsAutomaticMode: true
      ),
      SubscriptionPlan(
        tier: .options, productID: "whox.treasury.options.monthly",
        summary: "Defined-premium long and covered options strategies.",
        features: [
          "Long calls and puts", "Covered calls", "Protective puts", "Expiration monitoring",
          "Defined maximum risk",
        ],
        maximumActiveAgents: 3, supportsOptions: true, supportsAutomaticMode: true
      ),
      SubscriptionPlan(
        tier: .optionsPro, productID: "whox.treasury.optionspro.monthly",
        summary: "Approved limited-risk multi-leg strategies and advanced analytics.",
        features: [
          "Defined-risk spreads", "Limited-risk range structures", "Up to three agents",
          "Granular volatility rules", "Advanced options analytics",
        ],
        maximumActiveAgents: 3, supportsOptions: true, supportsAutomaticMode: true
      ),
    ]
  }

  static var agents: [InvestmentAgent] {
    [
      InvestmentAgent(
        id: "foundation-equity", name: "Foundation Equity", version: "1.4.2",
        strategy: "Diversified long-only", assetClass: "Stocks & ETFs",
        requiredPlan: .equity, riskCategory: .moderate, holdingPeriod: "Weeks to months",
        cadence: "Daily after market close",
        summary:
          "Builds a diversified core from liquid stocks and broad-market ETFs at lower turnover.",
        objective:
          "Participate in long-term equity growth while controlling concentration and turnover.",
        howItDecides: [
          "Screens for liquidity and tradability", "Favors diversified exposure and quality",
          "Rebalances only when drift is material",
        ],
        canTrade: [
          "Liquid U.S. stocks", "Broad and sector ETFs", "Fractional shares when enabled",
        ],
        cannotTrade: ["Options", "Short sales", "Penny stocks", "Margin-dependent positions"],
        struggles: ["Fast reversals", "Narrow speculative rallies", "Extended sideways markets"],
        riskControls: [
          "Position and symbol caps", "Minimum cash reserve", "Daily loss and drawdown halts",
          "Earnings restriction",
        ],
        brokerPermissions: ["Verified Agentic Account", "Equity trading"],
        disclosure:
          "Long-only diversification does not prevent loss. Demo results are simulated and not predictive.",
        icon: "building.columns",
        releaseStatus: "Paper",
        versionHistory: [
          "1.4.2 · concentration checks clarified", "1.4.0 · improved rebalance threshold",
        ],
        availability: .available, isActive: true, runtimeStatus: .waitingApproval,
        operatingMode: .confirmEveryTrade, allocationPercent: 48,
        lastRun: now.addingTimeInterval(-3_200), nextRun: now.addingTimeInterval(15_600),
        recentDecision: "Proposed a small VTI rebalance; awaiting review."
      ),
      InvestmentAgent(
        id: "equity-momentum", name: "Equity Momentum", version: "1.2.0",
        strategy: "Trend and volume", assetClass: "Stocks & ETFs",
        requiredPlan: .equityPro, riskCategory: .growth, holdingPeriod: "Days to weeks",
        cadence: "Every two hours during market sessions",
        summary:
          "Uses trend, volume, liquidity, and price-dislocation filters without short selling.",
        objective: "Seek persistent liquid equity trends within strict entry and exit rules.",
        howItDecides: [
          "Requires trend confirmation", "Checks participation and tradability",
          "Rejects entries after extreme moves",
        ],
        canTrade: ["Liquid U.S. stocks", "Liquid ETFs"],
        cannotTrade: ["Short sales", "Options", "Illiquid securities"],
        struggles: ["Whipsaw markets", "Gap reversals", "Low-volume sessions"],
        riskControls: ["Trailing exit", "Cooldown after loss", "Turnover cap"],
        brokerPermissions: ["Equity trading"],
        disclosure: "Momentum strategies can reverse quickly and incur repeated small losses.",
        icon: "waveform.path.ecg",
        releaseStatus: "Paper", versionHistory: ["1.2.0 · dislocation filter tightened"],
        availability: .available, isActive: false,
        runtimeStatus: .paused, operatingMode: .observe, allocationPercent: 0, lastRun: nil,
        nextRun: nil, recentDecision: "Not active."
      ),
      InvestmentAgent(
        id: "quality-swing", name: "Quality Swing", version: "1.1.3",
        strategy: "Quality with technical confirmation", assetClass: "Stocks",
        requiredPlan: .equityPro, riskCategory: .growth, holdingPeriod: "Several days to weeks",
        cadence: "Twice daily",
        summary:
          "Combines verified financial-quality factors with deterministic technical confirmation.",
        objective: "Find liquid quality companies with improving price confirmation.",
        howItDecides: ["Quality threshold", "Trend confirmation", "Event-risk check"],
        canTrade: ["Liquid U.S. stocks"],
        cannotTrade: ["Options", "Short sales", "Unverified event data"],
        struggles: ["Sharp factor rotations", "Event-driven gaps"],
        riskControls: ["Earnings blackout", "Position cap", "Re-entry cooldown"],
        brokerPermissions: ["Equity trading"],
        disclosure: "Quality and technical filters may fail together during rapid market changes.",
        icon: "checkmark.seal",
        releaseStatus: "Paper", versionHistory: ["1.1.3 · event blackout revised"],
        availability: .available, isActive: false,
        runtimeStatus: .paused, operatingMode: .observe, allocationPercent: 0, lastRun: nil,
        nextRun: nil, recentDecision: "Not active."
      ),
      InvestmentAgent(
        id: "directional-options", name: "Directional Options", version: "0.9.5",
        strategy: "Long calls and puts", assetClass: "Options",
        requiredPlan: .options, riskCategory: .aggressive, holdingPeriod: "Days to weeks",
        cadence: "Hourly during market sessions",
        summary:
          "Uses long calls and puts with defined premium risk, expiration, and liquidity rules.",
        objective: "Express a directional view with premium-defined risk.",
        howItDecides: [
          "Confirms underlying setup", "Requires sufficient time to expiration",
          "Uses limit orders",
        ],
        canTrade: ["Long calls", "Long puts"],
        cannotTrade: ["0DTE", "Naked short options", "Automatic averaging down"],
        struggles: ["Volatility contraction", "Time decay", "Wide spreads"],
        riskControls: ["Maximum premium", "Minimum 14 DTE", "Spread and liquidity limits"],
        brokerPermissions: ["Verified options approval", "Long options"],
        disclosure:
          "An option can lose its full premium quickly. A subscription does not grant broker approval.",
        icon: "arrow.up.right.and.arrow.down.left.rectangle", releaseStatus: "Paper",
        versionHistory: ["0.9.5 · liquidity rule added"],
        availability: .paperOnly, isActive: false, runtimeStatus: .paused, operatingMode: .observe,
        allocationPercent: 0,
        lastRun: nil, nextRun: nil,
        recentDecision: "Paper-only while Live options gates are disabled."
      ),
      InvestmentAgent(
        id: "covered-strategy", name: "Covered Strategy", version: "0.8.7",
        strategy: "Covered calls & protective puts", assetClass: "Options",
        requiredPlan: .options, riskCategory: .aggressive, holdingPeriod: "Weeks",
        cadence: "Daily plus expiration monitoring",
        summary: "Manages only covered calls and protective puts after verifying share coverage.",
        objective: "Use limited option overlays on verified underlying shares.",
        howItDecides: [
          "Verifies underlying coverage", "Checks dividend and assignment risk",
          "Requires limit pricing",
        ],
        canTrade: ["Covered calls", "Protective puts"],
        cannotTrade: ["Uncovered calls", "Naked puts", "Unsupported ratios"],
        struggles: ["Sharp upside moves", "Wide option markets", "Corporate actions"],
        riskControls: ["Coverage check", "Assignment warning", "Expiration job"],
        brokerPermissions: ["Covered options approval"],
        disclosure: "Covered calls can limit upside and still retain substantial equity downside.",
        icon: "shield.checkered",
        releaseStatus: "Paper", versionHistory: ["0.8.7 · ex-dividend escalation"],
        availability: .paperOnly, isActive: false,
        runtimeStatus: .paused, operatingMode: .observe, allocationPercent: 0, lastRun: nil,
        nextRun: nil, recentDecision: "Not active."
      ),
      InvestmentAgent(
        id: "defined-risk-spreads", name: "Defined-Risk Spreads", version: "0.6.1",
        strategy: "Limited-risk vertical spreads", assetClass: "Options",
        requiredPlan: .optionsPro, riskCategory: .aggressive, holdingPeriod: "Days to weeks",
        cadence: "Hourly during market sessions",
        summary:
          "Evaluates debit spreads and approved limited-risk credit structures with known maximum loss.",
        objective: "Use supported multi-leg structures with bounded risk.",
        howItDecides: [
          "Builds supported leg combinations", "Calculates maximum loss deterministically",
          "Requires broker review",
        ],
        canTrade: ["Debit spreads", "Approved defined-risk credit spreads"],
        cannotTrade: ["Naked legs", "Unlimited-loss structures", "Unsupported ratios"],
        struggles: ["Multi-leg partial fills", "Low liquidity", "Pin and assignment risk"],
        riskControls: ["Known maximum loss", "Leg consistency", "Partial-fill reconciliation"],
        brokerPermissions: ["Multi-leg options approval"],
        disclosure: "Multi-leg options carry execution, assignment, and expiration complexity.",
        icon: "rectangle.split.3x1",
        releaseStatus: "Paper", versionHistory: ["0.6.1 · maximum-loss fixtures expanded"],
        availability: .locked, isActive: false,
        runtimeStatus: .paused, operatingMode: .observe, allocationPercent: 0, lastRun: nil,
        nextRun: nil, recentDecision: "Options Pro required."
      ),
      InvestmentAgent(
        id: "range-volatility", name: "Range & Volatility", version: "0.3.0",
        strategy: "Limited-risk range structures", assetClass: "Options",
        requiredPlan: .optionsPro, riskCategory: .aggressive, holdingPeriod: "Days to weeks",
        cadence: "Hourly during market sessions",
        summary:
          "Evaluates limited-risk range structures only when strategy-specific approval is recorded.",
        objective: "Observe potential bounded-risk range setups.",
        howItDecides: [
          "Checks verified volatility inputs", "Avoids earnings windows",
          "Requires strict spread width",
        ],
        canTrade: ["Paper iron condors"],
        cannotTrade: ["Live orders", "Naked options", "Undefined risk"],
        struggles: ["Volatility expansion", "Gap moves", "Assignment near expiration"],
        riskControls: ["Compliance gate", "Maximum width", "Event restriction"],
        brokerPermissions: ["Advanced multi-leg approval"],
        disclosure:
          "This definition is held from Live use pending strategy-specific legal and compliance approval.",
        icon: "arrow.left.and.right.circle", releaseStatus: "Compliance hold",
        versionHistory: ["0.3.0 · paper evaluation only"],
        availability: .complianceHold, isActive: false, runtimeStatus: .paused,
        operatingMode: .observe, allocationPercent: 0,
        lastRun: nil, nextRun: nil, recentDecision: "Unavailable pending approval."
      ),
    ]
  }

  static var pendingProposal: TradeProposal {
    TradeProposal(
      id: "prop-demo-1007", agentID: "foundation-equity", agentName: "Foundation Equity",
      agentVersion: "1.4.2",
      createdAt: now.addingTimeInterval(-1_100), dataTimestamp: now.addingTimeInterval(-1_220),
      quoteTimestamp: now.addingTimeInterval(-1_115),
      mode: .demo, instrument: "ETF", symbol: "VTI", side: "Buy", quantity: 2.25,
      estimatedNotional: 598.82,
      orderType: "Limit", limitPrice: 266.14, timeInForce: "Day", strategy: "Diversified rebalance",
      thesisSummary:
        "VTI is below its target core allocation after recent cash inflows; the proposal remains inside every configured concentration limit.",
      entryReasoning: [
        "Core allocation is 2.6 percentage points below target",
        "Quote and account snapshot are current for this Demo review",
        "No restricted event or symbol exclusion applies",
      ],
      exitPlan:
        "Review at the next scheduled rebalance or if the portfolio drawdown halt activates.",
      invalidatingCondition:
        "Account allocation would exceed 70%, quote becomes stale, or buying-power reserve falls below 25%.",
      expectedHoldingPeriod: "Months", knownCatalysts: ["No verified near-term catalyst used"],
      riskAmount: 35.93, maximumLoss: 598.82,
      allocationAfter: 54.4,
      warnings: [
        "Demo proposal — approval cannot reach a broker",
        "Estimated notional may differ from a simulated fill",
      ],
      riskChecks: [
        RiskCheckResult(
          id: "mode", title: "Environment", outcome: .passed,
          explanation: "Demo execution adapter selected."),
        RiskCheckResult(
          id: "allocation", title: "Allocation cap", outcome: .passed,
          explanation: "54.4% after execution; 70% limit."),
        RiskCheckResult(
          id: "reserve", title: "Buying-power reserve", outcome: .passed,
          explanation: "28.7% after execution; 25% minimum."),
        RiskCheckResult(
          id: "loss", title: "Daily loss halt", outcome: .warning,
          explanation: "26% of the daily loss limit is currently used."),
        RiskCheckResult(
          id: "duplicate", title: "Duplicate order", outcome: .passed,
          explanation: "No matching open proposal or order."),
      ],
      brokerReview: "Demo broker review accepted the order shape with no severe warning.",
      entitlement: "Demo review entitlement",
      brokeragePermission: "Not required in Demo", approvalExpiresAt: now.addingTimeInterval(2_500),
      state: .awaitingUserApproval
    )
  }

  static var activities: [ActivityEvent] {
    let proposal = pendingProposal
    return [
      ActivityEvent(
        id: "act-proposal", type: .proposal, timestamp: proposal.createdAt,
        agentName: proposal.agentName, symbol: proposal.symbol,
        status: proposal.state.title, summary: "Rebalance proposal ready for authenticated review.",
        mode: .demo, proposal: proposal,
        order: nil, agentRun: nil, riskEvent: nil),
      ActivityEvent(
        id: "act-open-order", type: .order, timestamp: now.addingTimeInterval(-1_800),
        agentName: "Foundation Equity", symbol: "VTI",
        status: ProposalState.submitted.title,
        summary: "Demo limit order is resting below the simulated ask and remains unfilled.",
        mode: .demo, proposal: nil,
        order: OrderDetail(
          proposalID: "prop-demo-open-1002", brokerOrderID: "DEMO-ORDER-8843",
          submittedAt: now.addingTimeInterval(-1_800), terminalAt: nil, side: "Buy",
          instrumentType: "Equity", orderType: "Limit", limitPrice: 260,
          timeInForce: "Day", status: .submitted, fills: [], averageFillPrice: nil,
          remainingQuantity: 2.25, statusReason: "Limit is not marketable at the Demo quote.",
          reconciliationStatus: "Monitoring",
          auditTimeline: ["Authenticated Demo approval", "Demo limit order submitted"]),
        agentRun: nil, riskEvent: nil),
      ActivityEvent(
        id: "act-run", type: .agentRun, timestamp: now.addingTimeInterval(-3_200),
        agentName: "Foundation Equity", symbol: nil,
        status: "Completed", summary: "Evaluated 38 symbols and produced one proposal.",
        mode: .demo, proposal: nil, order: nil,
        agentRun: AgentRunDetail(
          startedAt: now.addingTimeInterval(-3_290), endedAt: now.addingTimeInterval(-3_200),
          dataSources: ["Demo market snapshot", "Demo account snapshot", "Agent definition 1.4.2"],
          symbolsEvaluated: 38, candidatesRejected: 37, outcome: "One rebalance candidate",
          riskFilters: ["Liquidity", "Tradability", "Concentration", "Event restriction"],
          strategyVersion: "foundation-1.4.2",
          errors: [], noTradeReason: nil), riskEvent: nil),
      ActivityEvent(
        id: "act-fill", type: .fill, timestamp: now.addingTimeInterval(-86_400),
        agentName: "Foundation Equity", symbol: "XLV",
        status: "Filled", summary: "Demo limit order filled in two simulated lots.", mode: .demo,
        proposal: nil,
        order: OrderDetail(
          proposalID: "prop-demo-1001", brokerOrderID: "DEMO-ORDER-8842",
          submittedAt: now.addingTimeInterval(-86_520),
          terminalAt: now.addingTimeInterval(-86_410), side: "Buy", instrumentType: "Equity",
          orderType: "Limit", limitPrice: 146.80, timeInForce: "Day",
          status: .filled,
          fills: [
            FillRecord(
              id: "fill-1", timestamp: now.addingTimeInterval(-86_470), quantity: 12, price: 146.71),
            FillRecord(
              id: "fill-2", timestamp: now.addingTimeInterval(-86_410), quantity: 11, price: 146.79),
          ],
          averageFillPrice: 146.75, remainingQuantity: 0, statusReason: nil,
          reconciliationStatus: "Reconciled",
          auditTimeline: [
            "Proposal approved with device authentication", "Demo order submitted",
            "Partial fill recorded", "Final fill reconciled",
          ]),
        agentRun: nil, riskEvent: nil),
      ActivityEvent(
        id: "act-rejected", type: .riskEvent, timestamp: now.addingTimeInterval(-172_800),
        agentName: "Equity Momentum", symbol: "GME",
        status: "Risk rejected", summary: "Excluded symbol policy prevented proposal creation.",
        mode: .demo, proposal: nil, order: nil,
        agentRun: nil,
        riskEvent: RiskEventDetail(
          rule: "Excluded symbol", observedValue: "GME", threshold: "User exclusion list",
          response: "Candidate rejected before broker review", resolvedAt: nil)),
      ActivityEvent(
        id: "act-option", type: .riskEvent, timestamp: now.addingTimeInterval(-220_000),
        agentName: "Covered Strategy", symbol: "AAPL",
        status: "Expiration warning",
        summary: "Demo protective put enters its 45-day monitoring window.", mode: .demo,
        proposal: nil, order: nil,
        agentRun: nil,
        riskEvent: RiskEventDetail(
          rule: "Expiration monitoring", observedValue: "37 days remaining", threshold: "45 days",
          response: "Review reminder scheduled; no automatic close", resolvedAt: nil)),
      ActivityEvent(
        id: "act-cancel", type: .order, timestamp: now.addingTimeInterval(-260_000),
        agentName: "Foundation Equity", symbol: "MSFT",
        status: "Canceled", summary: "Demo order canceled after its thesis was invalidated.",
        mode: .demo, proposal: nil,
        order: OrderDetail(
          proposalID: "prop-demo-992", brokerOrderID: "DEMO-ORDER-8819",
          submittedAt: now.addingTimeInterval(-261_000),
          terminalAt: now.addingTimeInterval(-260_000), side: "Buy", instrumentType: "Equity",
          orderType: "Limit", limitPrice: 392.50, timeInForce: "Day",
          status: .canceled, fills: [], averageFillPrice: nil, remainingQuantity: 2,
          statusReason: "Price moved beyond configured deviation",
          reconciliationStatus: "Reconciled",
          auditTimeline: ["Submitted", "Deviation warning", "Cancellation confirmed"]),
        agentRun: nil, riskEvent: nil),
      ActivityEvent(
        id: "act-connect", type: .account, timestamp: now.addingTimeInterval(-345_000),
        agentName: nil, symbol: nil,
        status: "Connected", summary: "Demo Agentic Account pairing completed.", mode: .demo,
        proposal: nil, order: nil, agentRun: nil, riskEvent: nil),
      ActivityEvent(
        id: "act-sub", type: .subscription, timestamp: now.addingTimeInterval(-604_800),
        agentName: nil, symbol: nil,
        status: "Demo access",
        summary: "App Review Demo entitlement activated; no App Store charge.", mode: .demo,
        proposal: nil, order: nil, agentRun: nil, riskEvent: nil),
    ]
  }

  static var brokerConnection: BrokerConnection {
    BrokerConnection(
      status: .connected, maskedAccount: "Agentic •••• 4821", accountType: "Demo Agentic Account",
      capabilities: ["Demo equity review", "Demo paper fills", "Options monitoring"],
      optionsPermission: "Demo Level 2 fixture — not broker approval",
      lastSync: now.addingTimeInterval(-54))
  }

  static var legalDocuments: [LegalDocument] {
    [
      LegalDocument(
        id: "terms", title: "Terms of Service", version: "DEMO-2026.08", productionApproved: false,
        summary: "Demo fixture only. Counsel-approved terms are required before Live activation."),
      LegalDocument(
        id: "privacy", title: "Privacy Policy", version: "DEMO-2026.08", productionApproved: false,
        summary: "Demo fixture only. Runtime data practices must be reflected before release."),
      LegalDocument(
        id: "ai-risk", title: "AI Agent Risk Disclosure", version: "DEMO-2026.08",
        productionApproved: false,
        summary: "Automated analysis can be wrong. Investing can lose money."),
      LegalDocument(
        id: "broker", title: "Brokerage Connection Disclosure", version: "DEMO-2026.08",
        productionApproved: false,
        summary: "WHOX Treasury is not Robinhood and stores no brokerage credential on this device."
      ),
      LegalDocument(
        id: "options", title: "Options Risk Disclosure", version: "DEMO-2026.08",
        productionApproved: false,
        summary: "Options may lose their premium quickly and require separate broker permission."),
      LegalDocument(
        id: "subscription", title: "Subscription Terms", version: "DEMO-2026.08",
        productionApproved: false,
        summary: "Subscriptions provide feature access and never guarantee investment returns."),
      LegalDocument(
        id: "advisory", title: "Investment Advisory Agreement", version: "DEMO-2026.08",
        productionApproved: false,
        summary:
          "Demo fixture only. An applicable counsel-approved advisory agreement is required before Live activation."
      ),
      LegalDocument(
        id: "electronic", title: "Electronic Communications Consent", version: "DEMO-2026.08",
        productionApproved: false,
        summary:
          "Demo fixture only. Production consent language and delivery records require approval."),
      LegalDocument(
        id: "performance", title: "Performance Presentation Disclosure", version: "DEMO-2026.08",
        productionApproved: false,
        summary:
          "Demo, Paper, backtested, and Live results must remain separately and completely labeled."
      ),
      LegalDocument(
        id: "ai-data", title: "Data Processing and Third-Party AI Disclosure",
        version: "DEMO-2026.08", productionApproved: false,
        summary:
          "Demo fixture only. Production processors and AI data practices must be disclosed from actual runtime behavior."
      ),
    ]
  }
}
