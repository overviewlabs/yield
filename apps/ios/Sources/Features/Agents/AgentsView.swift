import SwiftUI

enum AgentAssetFilter: String, CaseIterable, Identifiable {
  case all
  case stocks
  case options
  case moderate
  case growth
  var id: String { rawValue }
  var title: String { rawValue.capitalized }
}

struct AgentsView: View {
  @Environment(AppSession.self) private var session
  @State private var searchText = ""
  @State private var filter = AgentAssetFilter.all

  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 18) {
          sectionTitle("Active", count: session.activeAgents.count)
          if session.activeAgents.isEmpty {
            EmptyStateView(
              symbol: "pause.circle", title: "No active agents",
              message:
                "Choose a strategy below. Activation starts in Observe mode and never launches an immediate trade."
            )
            .treasuryCard()
          } else {
            ForEach(session.activeAgents) { agent in ActiveAgentCard(agent: agent) }
          }

          sectionTitle("Discover", count: filteredAgents.count)
          filterStrip
          if filteredAgents.isEmpty {
            EmptyStateView(
              symbol: "magnifyingglass", title: "No matching agents",
              message: "Change the search or filter. The server catalog was not modified."
            )
            .treasuryCard()
          } else {
            ForEach(filteredAgents) { agent in AgentDiscoveryCard(agent: agent) }
          }
        }
        .padding()
      }
      .background(Color(uiColor: .systemGroupedBackground))
      .navigationTitle("Agents")
      .searchable(text: $searchText, prompt: "Strategy or asset class")
      .refreshable { await session.refresh() }
    }
  }

  private var filterStrip: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack {
        ForEach(AgentAssetFilter.allCases) { item in
          Button(item.title) { filter = item }
            .buttonStyle(.bordered)
            .tint(filter == item ? .accentColor : .secondary)
            .accessibilityAddTraits(filter == item ? .isSelected : [])
        }
      }
    }
  }

  private var filteredAgents: [InvestmentAgent] {
    session.agents.filter { agent in
      let matchesSearch =
        searchText.isEmpty || agent.name.localizedCaseInsensitiveContains(searchText)
        || agent.strategy.localizedCaseInsensitiveContains(searchText)
        || agent.assetClass.localizedCaseInsensitiveContains(searchText)
      let matchesFilter: Bool
      switch filter {
      case .all: matchesFilter = true
      case .stocks: matchesFilter = agent.assetClass.localizedCaseInsensitiveContains("stock")
      case .options: matchesFilter = agent.assetClass.localizedCaseInsensitiveContains("option")
      case .moderate: matchesFilter = agent.riskCategory == .moderate
      case .growth: matchesFilter = [.growth, .aggressive].contains(agent.riskCategory)
      }
      return matchesSearch && matchesFilter
    }
  }

  private func sectionTitle(_ title: String, count: Int) -> some View {
    HStack {
      Text(title).font(.title2.bold())
      Text(String(count))
        .font(.caption.bold())
        .foregroundStyle(.secondary)
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(.secondary.opacity(0.12), in: Capsule())
        .accessibilityIdentifier(title == "Active" ? "activeAgentCount" : "discoverAgentCount")
      Spacer()
    }
  }
}

private struct ActiveAgentCard: View {
  @Environment(AppSession.self) private var session
  let agent: InvestmentAgent

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .top) {
        Image(systemName: agent.icon).font(.title).foregroundStyle(.tint).frame(
          width: 42, height: 42)
        VStack(alignment: .leading, spacing: 3) {
          Text(agent.name).font(.title3.bold())
          Text("v\(agent.version) · \(agent.strategy)").font(.caption).foregroundStyle(.secondary)
        }
        Spacer()
        StatusBadge(
          title: agent.runtimeStatus.title,
          symbol: statusSymbol,
          color: statusColor)
      }
      Text(agent.recentDecision).font(.subheadline).foregroundStyle(.secondary)
      LabeledValueRow(label: "Mode", value: agent.operatingMode.title, symbol: "checkmark.shield")
      LabeledValueRow(
        label: "Allocation", value: FinancialFormatters.percent(agent.allocationPercent),
        symbol: "chart.pie")
      LabeledValueRow(
        label: "Last run", value: FinancialFormatters.relative(agent.lastRun),
        symbol: "clock.arrow.circlepath")
      LabeledValueRow(
        label: "Next run", value: FinancialFormatters.relative(agent.nextRun), symbol: "calendar")
      LabeledValueRow(label: "Risk", value: session.dashboard.riskState.title, symbol: "shield")
      HStack {
        Button(
          agent.runtimeStatus == .paused ? "Resume" : "Pause",
          systemImage: agent.runtimeStatus == .paused ? "play.fill" : "pause.fill"
        ) {
          Task { await session.toggleAgent(agent.id) }
        }
        .accessibilityIdentifier("agentToggle.\(agent.id)")
        .buttonStyle(.borderedProminent)
        .disabled(
          agent.runtimeStatus == .paused && agent.availability != .available
            && agent.availability != .paperOnly)
        if agent.availability == .available || agent.availability == .paperOnly {
          NavigationLink("Configure") { AgentConfigurationView(agentID: agent.id) }.buttonStyle(
            .bordered)
        } else {
          Label("Release hold", systemImage: "lock.fill")
            .foregroundStyle(.orange)
        }
        Spacer()
        NavigationLink("Details") { AgentDetailView(agentID: agent.id) }
      }
      .font(.subheadline.weight(.semibold))
    }
    .treasuryCard()
    .accessibilityElement(children: .contain)
  }

  private var statusSymbol: String {
    switch agent.runtimeStatus {
    case .monitoring: "dot.radiowaves.left.and.right"
    case .paused: "pause.circle"
    case .waitingApproval: "doc.badge.clock"
    case .riskHalt: "exclamationmark.shield.fill"
    }
  }

  private var statusColor: Color {
    switch agent.runtimeStatus {
    case .monitoring: .green
    case .paused: .orange
    case .waitingApproval: .blue
    case .riskHalt: .red
    }
  }
}

private struct AgentDiscoveryCard: View {
  @Environment(AppSession.self) private var session
  let agent: InvestmentAgent

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top) {
        Image(systemName: agent.icon).font(.title2).foregroundStyle(.tint).frame(
          width: 38, height: 38)
        VStack(alignment: .leading, spacing: 3) {
          Text(agent.name).font(.headline)
          Text("\(agent.assetClass) · \(agent.riskCategory.title)").font(.caption).foregroundStyle(
            .secondary)
        }
        Spacer()
        StatusBadge(
          title: agent.availability.title, symbol: availabilitySymbol, color: availabilityColor)
      }
      Text(agent.summary).font(.subheadline).foregroundStyle(.secondary)
      LabeledValueRow(label: "Holding period", value: agent.holdingPeriod)
      LabeledValueRow(label: "Monitoring", value: agent.cadence)
      LabeledValueRow(label: "Required plan", value: agent.requiredPlan.title)
      DisclosureGroup("How this agent decides") {
        ForEach(agent.howItDecides, id: \.self) {
          Label($0, systemImage: "checkmark.circle").font(.caption)
        }
      }
      DisclosureGroup("When it may struggle") {
        ForEach(agent.struggles, id: \.self) {
          Label($0, systemImage: "exclamationmark.triangle").font(.caption)
        }
      }
      HStack {
        NavigationLink("Learn More") { AgentDetailView(agentID: agent.id) }.buttonStyle(.bordered)
        Spacer()
        if !agent.isActive {
          if agent.availability == .available || agent.availability == .paperOnly {
            if session.mode == .paper {
              NavigationLink("Configure to Activate") {
                AgentConfigurationView(agentID: agent.id)
              }
              .buttonStyle(.borderedProminent)
            } else {
              Button("Activate") { Task { await session.toggleAgent(agent.id) } }
                .accessibilityIdentifier("agentToggle.\(agent.id)")
                .buttonStyle(.borderedProminent)
            }
          } else {
            Label("Release hold", systemImage: "lock.fill")
              .font(.subheadline.weight(.semibold))
              .foregroundStyle(.orange)
              .accessibilityHint("This catalog definition cannot be activated")
          }
        }
      }
    }
    .treasuryCard()
  }

  private var availabilitySymbol: String {
    switch agent.availability {
    case .available: "checkmark.circle"
    case .paperOnly: "doc.text"
    case .locked: "lock"
    case .complianceHold: "exclamationmark.shield"
    }
  }

  private var availabilityColor: Color {
    switch agent.availability {
    case .available: .green
    case .paperOnly: .blue
    case .locked: .orange
    case .complianceHold: .red
    }
  }
}
