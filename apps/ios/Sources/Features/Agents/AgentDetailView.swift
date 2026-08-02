import SwiftUI

struct AgentDetailView: View {
  @Environment(AppSession.self) private var session
  let agentID: String

  var body: some View {
    Group {
      if let agent {
        ScrollView {
          VStack(spacing: 18) {
            header(agent)
            textSection("Objective", text: agent.objective, symbol: "scope")
            listSection("How It Works", items: agent.howItDecides, symbol: "gearshape.2")
            listSection("What It Can Trade", items: agent.canTrade, symbol: "checkmark.circle")
            listSection("What It Cannot Trade", items: agent.cannotTrade, symbol: "nosign")
            pairedFacts(agent)
            listSection("Risk Controls", items: agent.riskControls, symbol: "shield")
            listSection(
              "Conditions Where It May Struggle", items: agent.struggles,
              symbol: "exclamationmark.triangle")
            historicalResults(agent)
            listSection(
              "Version History", items: agent.versionHistory, symbol: "clock.arrow.circlepath")
            listSection(
              "Required Brokerage Permissions", items: agent.brokerPermissions,
              symbol: "checkmark.seal")
            textSection("Legal Disclosures", text: agent.disclosure, symbol: "doc.text")
            actionPanel(agent)
          }
          .padding()
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle(agent.name)
        .navigationBarTitleDisplayMode(.inline)
      } else {
        EmptyStateView(
          symbol: "questionmark.circle", title: "Agent unavailable",
          message:
            "This version may have been retired. Active positions remain visible and monitored.")
      }
    }
  }

  private var agent: InvestmentAgent? { session.agents.first(where: { $0.id == agentID }) }

  private func header(_ agent: InvestmentAgent) -> some View {
    HStack(alignment: .top, spacing: 16) {
      ZStack {
        RoundedRectangle(cornerRadius: 18).fill(.tint.opacity(0.14)).frame(width: 70, height: 70)
        Image(systemName: agent.icon).font(.system(size: 30)).foregroundStyle(.tint)
      }
      VStack(alignment: .leading, spacing: 7) {
        Text(agent.name).font(.title.bold())
        Text(agent.strategy).foregroundStyle(.secondary)
        HStack {
          StatusBadge(
            title: agent.riskCategory.title, symbol: "gauge.with.dots.needle.50percent",
            color: agent.riskCategory == .aggressive ? .orange : .blue)
          ModeBadge(mode: session.mode)
        }
        Text("v\(agent.version) · \(agent.releaseStatus)").font(.caption.monospaced())
          .foregroundStyle(.secondary)
      }
      Spacer()
    }
    .treasuryCard()
  }

  private func textSection(_ title: String, text: String, symbol: String) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Label(title, systemImage: symbol).font(.headline)
      Text(text).font(.subheadline).foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .treasuryCard()
  }

  private func listSection(_ title: String, items: [String], symbol: String) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Label(title, systemImage: symbol).font(.headline)
      ForEach(items, id: \.self) { item in
        HStack(alignment: .top, spacing: 8) {
          Image(systemName: "circle.fill").font(.system(size: 5)).padding(.top, 7)
          Text(item).font(.subheadline).foregroundStyle(.secondary)
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .treasuryCard()
  }

  private func pairedFacts(_ agent: InvestmentAgent) -> some View {
    VStack(spacing: 12) {
      LabeledValueRow(
        label: "Typical holding period", value: agent.holdingPeriod, symbol: "calendar")
      LabeledValueRow(label: "Evaluation schedule", value: agent.cadence, symbol: "clock")
      LabeledValueRow(label: "Subscription", value: agent.requiredPlan.title, symbol: "creditcard")
      LabeledValueRow(
        label: "Asset category", value: agent.assetClass, symbol: "square.stack.3d.up")
    }
    .treasuryCard()
  }

  private func historicalResults(_ agent: InvestmentAgent) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Label("Historical Results", systemImage: "chart.line.uptrend.xyaxis").font(.headline)
      if session.mode == .demo && agent.id == "foundation-equity" {
        LabeledValueRow(label: "Dataset", value: "Seeded Demo fixture")
        LabeledValueRow(label: "Period", value: "240 simulated calendar days")
        LabeledValueRow(label: "Method", value: "Net, time-weighted Demo presentation")
        LabeledValueRow(label: "Forward-looking", value: "No")
        Text("See Portfolio › Performance for the labeled Demo series and methodology limitations.")
          .font(.caption).foregroundStyle(.secondary)
      } else {
        EmptyStateView(
          symbol: "chart.line.uptrend.xyaxis", title: historicalResultsEmptyTitle,
          message: historicalResultsEmptyMessage
        )
        .frame(minHeight: 160)
      }
    }
    .treasuryCard()
  }

  private var historicalResultsEmptyTitle: String {
    switch session.mode {
    case .demo: "No approved results published"
    case .paper: "No Paper agent results available"
    case .live: "No Live agent results available"
    }
  }

  private var historicalResultsEmptyMessage: String {
    switch session.mode {
    case .demo:
      "WHOX Treasury does not invent performance. A complete methodology and approved dataset are required before results appear."
    case .paper:
      "Agent-level results are not inferred from seeded Demo fixtures or the current Paper account. Approved Paper methodology and authoritative results are required before they appear."
    case .live:
      "Agent-level results are not inferred from Demo or Paper data. Approved methodology and authoritative Live results are required before they appear."
    }
  }

  private func actionPanel(_ agent: InvestmentAgent) -> some View {
    VStack(spacing: 12) {
      if agent.isActive {
        if agent.availability == .available || agent.availability == .paperOnly {
          NavigationLink("Configure Agent") { AgentConfigurationView(agentID: agent.id) }
            .buttonStyle(.borderedProminent).controlSize(.large).frame(maxWidth: .infinity)
        } else {
          Label("Configuration unavailable — release hold", systemImage: "lock.fill")
            .foregroundStyle(.orange)
            .frame(maxWidth: .infinity)
        }
        Button(agent.runtimeStatus == .paused ? "Resume Agent" : "Pause Agent") {
          Task { await session.toggleAgent(agent.id) }
        }
        .buttonStyle(.bordered).controlSize(.large).frame(maxWidth: .infinity)
        .disabled(
          agent.runtimeStatus == .paused && agent.availability != .available
            && agent.availability != .paperOnly)
      } else {
        if agent.availability == .available || agent.availability == .paperOnly {
          if session.mode == .paper {
            NavigationLink("Configure to Activate") { AgentConfigurationView(agentID: agent.id) }
              .buttonStyle(.borderedProminent).controlSize(.large).frame(maxWidth: .infinity)
          } else {
            Button("Activate in Observe Mode") { Task { await session.toggleAgent(agent.id) } }
              .buttonStyle(.borderedProminent).controlSize(.large).frame(maxWidth: .infinity)
          }
        } else {
          Label("Activation unavailable — release hold", systemImage: "lock.fill")
            .foregroundStyle(.orange)
            .frame(maxWidth: .infinity)
            .accessibilityHint("This catalog definition cannot be activated or configured")
        }
      }
    }
  }
}
