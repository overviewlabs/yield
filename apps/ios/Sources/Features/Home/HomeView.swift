import Charts
import SwiftUI

struct HomeView: View {
  @Environment(AppSession.self) private var session
  @State private var range = ChartRange.month
  @State private var benchmarkEnabled = false
  @State private var selectedDate: Date?
  @State private var showingNotifications = false
  @State private var showingPauseConfirmation = false

  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(spacing: 18) {
          accountSummary
          portfolioChart
          agentStatus
          riskPanel
          positionsPreview
          activityPreview
          DisclosureNotice(
            title: session.dashboard.dataLabel,
            message: dashboardDisclosure,
            symbol: "info.circle"
          )
          .treasuryCard()
        }
        .padding(.horizontal)
        .padding(.bottom, 24)
        .redacted(reason: session.loadPhase == .loading ? .placeholder : [])
      }
      .background(Color(uiColor: .systemGroupedBackground))
      .refreshable { await session.refresh() }
      .navigationTitle("Treasury")
      .toolbar {
        ToolbarItemGroup(placement: .topBarTrailing) {
          Button {
            Task { await session.togglePrivacy() }
          } label: {
            Image(systemName: session.preferences.privacyMode ? "eye.slash" : "eye")
          }
          .accessibilityLabel(
            session.preferences.privacyMode ? "Show financial values" : "Hide financial values")

          Button {
            showingNotifications = true
          } label: {
            Image(systemName: "bell")
          }
          .accessibilityLabel("Notification center")
        }
      }
      .safeAreaInset(edge: .top, spacing: 0) {
        if case .failed(let message) = session.loadPhase {
          offlineBanner(message)
        } else if case .offline(let message) = session.loadPhase {
          offlineBanner(message)
        }
      }
      .sheet(isPresented: $showingNotifications) {
        NavigationStack { NotificationCenterView() }
          .presentationDetents([.medium, .large])
      }
      .confirmationDialog(
        "Pause all agents?",
        isPresented: $showingPauseConfirmation,
        titleVisibility: .visible
      ) {
        Button("Pause All Agents", role: .destructive) { Task { await session.pauseAllAgents() } }
        Button("Cancel", role: .cancel) {}
      } message: {
        Text("This stops new evaluations and submissions. Existing positions remain untouched.")
      }
    }
  }

  private var accountSummary: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        ModeBadge(mode: session.mode)
        Spacer()
        Text("Updated \(session.dashboard.updatedAt, style: .relative)")
          .font(.caption).foregroundStyle(.secondary)
      }
      Text("Agentic Account value").font(.subheadline).foregroundStyle(.secondary)
      Text(
        FinancialFormatters.currency(
          session.dashboard.accountValue, hide: session.preferences.privacyMode)
      )
      .font(.system(.largeTitle, design: .rounded, weight: .semibold))
      .monospacedDigit()
      .contentTransition(.numericText())
      .accessibilityLabel(
        session.preferences.privacyMode
          ? "Portfolio value hidden"
          : "Portfolio value, \(FinancialFormatters.spokenCurrency(session.dashboard.accountValue))"
      )
      ChangeLabel(
        amount: session.dashboard.todayChange, percent: session.dashboard.todayPercent,
        privacy: session.preferences.privacyMode)
      if session.dashboard.isStale {
        StatusBadge(title: "Stale data", symbol: "clock.badge.exclamationmark", color: .orange)
      }
    }
    .treasuryCard()
    .accessibilityIdentifier("accountSummary")
  }

  private var portfolioChart: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack {
        Text("Portfolio").font(.headline)
        Spacer()
        Toggle("Benchmark", isOn: $benchmarkEnabled).labelsHidden()
        Text("Benchmark").font(.caption).foregroundStyle(.secondary)
      }

      Picker("Chart range", selection: $range) {
        ForEach(ChartRange.allCases) { Text($0.rawValue).tag($0) }
      }
      .pickerStyle(.segmented)

      Chart {
        ForEach(session.chartPoints(for: range)) { point in
          AreaMark(
            x: .value("Date", point.date), yStart: .value("Baseline", chartMinimum),
            yEnd: .value("Value", point.value)
          )
          .foregroundStyle(
            .linearGradient(
              colors: [Color.accentColor.opacity(0.24), .clear], startPoint: .top, endPoint: .bottom
            )
          )
          .interpolationMethod(.monotone)
          LineMark(x: .value("Date", point.date), y: .value("Portfolio value", point.value))
            .foregroundStyle(Color.accentColor)
            .lineStyle(.init(lineWidth: 2.5, lineCap: .round, lineJoin: .round))
            .interpolationMethod(.monotone)
          if benchmarkEnabled, let benchmark = point.benchmarkValue {
            LineMark(x: .value("Date", point.date), y: .value("Benchmark", benchmark))
              .foregroundStyle(.secondary)
              .lineStyle(.init(lineWidth: 1.5, dash: [5, 4]))
          }
        }
        if let selectedDate, let point = nearestPoint(to: selectedDate) {
          RuleMark(x: .value("Selected date", point.date))
            .foregroundStyle(.secondary.opacity(0.6))
          PointMark(
            x: .value("Selected date", point.date), y: .value("Selected value", point.value)
          )
          .foregroundStyle(Color.accentColor)
          .symbolSize(55)
          .annotation(position: .top, overflowResolution: .init(x: .fit, y: .disabled)) {
            VStack(spacing: 2) {
              Text(FinancialFormatters.currency(point.value, hide: session.preferences.privacyMode))
                .font(.caption.bold()).monospacedDigit()
              Text(point.date, format: .dateTime.month(.abbreviated).day()).font(.caption2)
                .foregroundStyle(.secondary)
            }
            .padding(7)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
          }
        }
      }
      .chartYScale(domain: chartMinimum...chartMaximum)
      .chartXAxis(.hidden)
      .chartYAxis {
        AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) { value in
          AxisGridLine().foregroundStyle(.secondary.opacity(0.15))
          AxisValueLabel {
            if !session.preferences.privacyMode, let number = value.as(Double.self) {
              Text(number.formatted(.number.notation(.compactName)))
            }
          }
        }
      }
      .chartXSelection(value: $selectedDate)
      .frame(height: 220)
      .animation(
        session.preferences.reduceChartAnimation ? nil : .easeInOut(duration: 0.22), value: range
      )
      .accessibilityLabel(chartAccessibilityLabel)
      .accessibilityValue(chartAccessibilitySummary)

      DisclosureGroup("Accessible chart summary") {
        Text(chartAccessibilitySummary).font(.caption).foregroundStyle(.secondary)
      }
      Text(chartInteractionDisclosure)
        .font(.caption2).foregroundStyle(.secondary)
    }
    .treasuryCard()
  }

  private var agentStatus: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack {
        Text("Agent status").font(.headline)
        Spacer()
        StatusBadge(
          title: session.accountIsPaused
            ? "Paused" : session.activeAgents.first?.runtimeStatus.title ?? "Not configured",
          symbol: agentStatusSymbol,
          color: agentStatusColor
        )
      }
      if let agent = session.activeAgents.first {
        LabeledValueRow(label: "Agent", value: agent.name, symbol: agent.icon)
        LabeledValueRow(
          label: "Approval", value: agent.operatingMode.title, symbol: "checkmark.shield")
        LabeledValueRow(
          label: "Last run", value: FinancialFormatters.relative(agent.lastRun),
          symbol: "clock.arrow.circlepath")
        LabeledValueRow(
          label: "Next evaluation", value: FinancialFormatters.relative(agent.nextRun),
          symbol: "calendar")
        LabeledValueRow(
          label: "Pending proposals", value: String(session.pendingProposals.count),
          symbol: "doc.badge.clock")
        LabeledValueRow(label: "Connection", value: session.connection.status.title, symbol: "link")
        Text(agent.recentDecision).font(.subheadline).foregroundStyle(.secondary)
        HStack {
          Button(
            session.accountIsPaused ? "Resume" : "Pause",
            systemImage: session.accountIsPaused ? "play.fill" : "pause.fill"
          ) {
            if session.accountIsPaused {
              Task { await session.resumeAllAgents() }
            } else {
              showingPauseConfirmation = true
            }
          }
          .buttonStyle(.borderedProminent)
          NavigationLink("View Agent") { AgentDetailView(agentID: agent.id) }.buttonStyle(.bordered)
        }
      } else {
        EmptyStateView(
          symbol: "point.3.connected.trianglepath.dotted", title: "No active agent",
          message: "Choose a strategy in Agents."
        ) {
          session.selectedTab = .agents
        }
      }
    }
    .treasuryCard()
  }

  private var riskPanel: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack {
        Text("Risk controls").font(.headline)
        Spacer()
        StatusBadge(
          title: session.dashboard.riskState.title, symbol: "shield",
          color: TreasurySemanticColor.risk(session.dashboard.riskState))
      }
      ForEach(session.dashboard.riskUsages) { RiskProgressRow(usage: $0) }
      NavigationLink("Review Risk Controls") { RiskControlsView() }
        .font(.subheadline.weight(.semibold))
    }
    .treasuryCard()
  }

  private var positionsPreview: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Text("Open positions").font(.headline)
        Spacer()
        Button("View All") { session.selectedTab = .portfolio }.font(.subheadline)
      }
      .padding(.bottom, 8)
      if session.positions.isEmpty {
        Text("No open positions").font(.subheadline).foregroundStyle(.secondary)
          .frame(maxWidth: .infinity, minHeight: 72)
      } else {
        ForEach(session.positions.prefix(4)) { position in
          NavigationLink {
            PositionDetailView(positionID: position.id)
          } label: {
            PositionRow(position: position)
          }
          .buttonStyle(.plain)
          if position.id != session.positions.prefix(4).last?.id { Divider().padding(.leading, 46) }
        }
      }
    }
    .treasuryCard()
  }

  private var activityPreview: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Text("Recent activity").font(.headline)
        Spacer()
        Button("View All") { session.selectedTab = .activity }.font(.subheadline)
      }
      .padding(.bottom, 8)
      if session.activities.isEmpty {
        Text("No activity yet").font(.subheadline).foregroundStyle(.secondary)
          .frame(maxWidth: .infinity, minHeight: 72)
      } else {
        ForEach(session.activities.prefix(4)) { event in
          NavigationLink {
            ActivityDetailView(eventID: event.id)
          } label: {
            ActivityRow(event: event)
          }
          .buttonStyle(.plain)
          if event.id != session.activities.prefix(4).last?.id { Divider().padding(.leading, 46) }
        }
      }
    }
    .treasuryCard()
  }

  private func offlineBanner(_ message: String) -> some View {
    HStack {
      Image(systemName: "wifi.exclamationmark")
      Text(message).font(.caption).lineLimit(2)
      Spacer()
      Button("Retry") { Task { await session.refresh() } }.font(.caption.weight(.semibold))
    }
    .padding(10)
    .background(.orange.opacity(0.15))
  }

  private var chartValues: [Double] { session.chartPoints(for: range).map(\.value) }
  private var chartMinimum: Double { (chartValues.min() ?? 0) * 0.985 }
  private var chartMaximum: Double { (chartValues.max() ?? 1) * 1.015 }

  private var dashboardDisclosure: String {
    switch session.mode {
    case .demo:
      "Seeded Demo values are not brokerage results and must not be used as a promise of future results."
    case .paper:
      "Paper values reflect simulated execution, not brokerage results, and must not be used as a promise of future results."
    case .live:
      "Live account values can change and must not be used as a promise of future results."
    }
  }

  private var chartAccessibilityLabel: String {
    switch session.mode {
    case .demo: "Demo portfolio value chart"
    case .paper: "Paper simulated portfolio value chart"
    case .live: "Live portfolio value chart"
    }
  }

  private var chartInteractionDisclosure: String {
    switch session.mode {
    case .demo: "Long-press and drag to inspect · seeded Demo history"
    case .paper: "Long-press and drag to inspect · authoritative Paper simulation history"
    case .live: "Long-press and drag to inspect · authoritative Live account history"
    }
  }

  private func nearestPoint(to date: Date) -> PortfolioPoint? {
    session.chartPoints(for: range).min {
      abs($0.date.timeIntervalSince(date)) < abs($1.date.timeIntervalSince(date))
    }
  }

  private var chartAccessibilitySummary: String {
    if session.preferences.privacyMode {
      return "Portfolio chart values are hidden while privacy mode is enabled."
    }
    guard let first = session.chartPoints(for: range).first,
      let last = session.chartPoints(for: range).last
    else { return "No \(session.mode.title) portfolio history is available." }
    let change = last.value - first.value
    let direction = change >= 0 ? "increased" : "decreased"
    let seriesName: String
    switch session.mode {
    case .demo: seriesName = "seeded Demo portfolio value"
    case .paper: seriesName = "Paper simulated portfolio value"
    case .live: seriesName = "Live portfolio value"
    }
    return
      "Over \(range.rawValue), \(seriesName) \(direction) by \(FinancialFormatters.spokenCurrency(abs(change))). Values range from \(FinancialFormatters.spokenCurrency(chartMinimum)) to \(FinancialFormatters.spokenCurrency(chartMaximum))."
  }

  private var agentStatusSymbol: String {
    switch session.activeAgents.first?.runtimeStatus {
    case .paused: "pause.circle.fill"
    case .riskHalt: "exclamationmark.shield.fill"
    case .waitingApproval: "doc.badge.clock"
    case .monitoring: "dot.radiowaves.left.and.right"
    case nil: "minus.circle"
    }
  }

  private var agentStatusColor: Color {
    switch session.activeAgents.first?.runtimeStatus {
    case .paused: .orange
    case .riskHalt: .red
    case .waitingApproval: .blue
    case .monitoring: .green
    case nil: .secondary
    }
  }
}

struct NotificationCenterView: View {
  @Environment(AppSession.self) private var session
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    List {
      Section {
        if notificationEvents.isEmpty {
          Text("No proposal, risk, or account alerts yet.").foregroundStyle(.secondary)
        } else {
          ForEach(notificationEvents.prefix(8)) { event in
            Button {
              dismiss()
              session.navigate(to: .activity(event.id))
            } label: {
              HStack(alignment: .top) {
                Image(systemName: event.type.symbol).foregroundStyle(.tint).frame(width: 28)
                VStack(alignment: .leading, spacing: 4) {
                  Text(event.status).font(.headline)
                  Text(session.preferences.privacyMode ? "Activity details hidden" : event.summary)
                    .font(.subheadline).foregroundStyle(.secondary)
                  Text(event.timestamp, style: .relative).font(.caption).foregroundStyle(.tertiary)
                }
                Spacer()
              }
            }
            .buttonStyle(.plain)
          }
        }
      } footer: {
        Text(notificationDisclosure)
      }
    }
    .navigationTitle("Notifications")
    .toolbar {
      ToolbarItem(placement: .topBarLeading) { Button("Close") { dismiss() } }
    }
  }

  private var notificationDisclosure: String {
    switch session.mode {
    case .demo:
      "Demo notification content hides balances and detailed trade information by default."
    case .paper:
      "Paper notifications reflect simulated activity. Review the app for complete account and order details."
    case .live:
      "Live notifications may summarize account activity. Review the app for current account and order details."
    }
  }

  private var notificationEvents: [ActivityEvent] {
    session.activities.filter { [.proposal, .riskEvent, .account].contains($0.type) }
  }
}
