import SwiftUI

struct AgentConfigurationView: View {
  @Environment(AppSession.self) private var session
  @Environment(\.dismiss) private var dismiss
  let agentID: String
  @State private var allocation: Double = 10
  @State private var operatingMode = AgentOperatingMode.observe
  @State private var symbol = ""
  @State private var targetOrderAmount: Double = 0

  var body: some View {
    Form {
      if let agent {
        Section {
          LabeledContent("Agent", value: agent.name)
          LabeledContent("Version", value: agent.version)
        }
        Section("Capital reservation") {
          VStack(alignment: .leading) {
            Text("Agent allocation: \(FinancialFormatters.percent(allocation))")
            Slider(value: $allocation, in: 1...session.riskPolicy.maximumAllocationPercent, step: 1)
          }
          Text(
            "Capital is reserved at the portfolio level. Conflicting agents cannot spend the same buying power."
          )
          .font(.caption).foregroundStyle(.secondary)
        }
        Section("\(session.mode.title) execution configuration") {
          Picker("Ticker symbol", selection: $symbol) {
            Text("Choose a symbol").tag("")
            ForEach(availableSymbols, id: \.self) { availableSymbol in
              Text(availableSymbol).tag(availableSymbol)
            }
          }
          .disabled(availableSymbols.isEmpty)
          TextField(
            "Target order amount", value: $targetOrderAmount,
            format: .currency(code: Locale.current.currency?.identifier ?? "USD")
          )
          .keyboardType(.decimalPad)
          Text(
            availableSymbols.isEmpty
              ? "No symbol universe is published for this exact plan and agent version. Configuration is blocked until the catalog is refreshed."
              : "Available symbols are centrally published with this exact plan and agent version. The app sends the selected symbol and amount explicitly."
          )
          .font(.caption).foregroundStyle(.secondary)
        }
        Section("Approval and schedule") {
          Picker("Approval mode", selection: $operatingMode) {
            ForEach(AgentOperatingMode.allCases) { mode in
              Text(
                mode == .automaticWithinLimits && !session.gates.canEnableAutonomousMode
                  ? "\(mode.title) — Locked" : mode.title
              )
              .tag(mode)
              .disabled(mode == .automaticWithinLimits && !session.gates.canEnableAutonomousMode)
            }
          }
          LabeledContent("Evaluation schedule", value: agent.cadence)
          Text(
            "Schedule changes are limited to strategy-approved values and execute on server workers."
          )
          .font(.caption).foregroundStyle(.secondary)
        }
        Section("Effective risk limits") {
          LabeledContent(
            "New order", value: FinancialFormatters.currency(session.riskPolicy.maximumOrderAmount))
          LabeledContent(
            "Daily loss halt",
            value: FinancialFormatters.currency(session.riskPolicy.dailyLossLimit))
          LabeledContent(
            "Portfolio drawdown",
            value: FinancialFormatters.percent(session.riskPolicy.drawdownHaltPercent))
          NavigationLink("Review Global Risk Controls") { RiskControlsView() }
        }
        Section {
          Button("Restore Recommended Defaults") {
            allocation = min(20, session.riskPolicy.maximumAllocationPercent)
            operatingMode = .observe
            symbol = availableSymbols.contains("VTI") ? "VTI" : availableSymbols.first ?? ""
            targetOrderAmount = min(500, session.riskPolicy.maximumOrderAmount)
          }
        }
        if agent.activationID == nil,
          session.activeAgents.count >= session.currentPlan.maximumActiveAgents
        {
          Section {
            DisclosureNotice(
              title: "Plan agent limit reached",
              message:
                "This plan supports \(session.currentPlan.maximumActiveAgents) active agent(s). Pause another agent before activating this one.",
              symbol: "exclamationmark.shield", color: .orange)
          }
        }
      } else {
        EmptyStateView(
          symbol: "questionmark.circle", title: "Agent unavailable",
          message: "This configuration cannot be edited because the agent definition is missing.")
      }
    }
    .navigationTitle("Configure")
    .navigationBarTitleDisplayMode(.inline)
    .onAppear {
      guard let agent else { return }
      allocation = min(
        max(agent.allocationPercent, 1), session.riskPolicy.maximumAllocationPercent)
      operatingMode = agent.operatingMode
      if let configuredSymbol = agent.configuredSymbol,
        availableSymbols.contains(configuredSymbol)
      {
        symbol = configuredSymbol
      } else {
        symbol = session.mode == .demo && availableSymbols.contains("VTI") ? "VTI" : ""
      }
      targetOrderAmount =
        agent.targetOrderAmount
        ?? (session.mode == .demo ? min(500, session.riskPolicy.maximumOrderAmount) : 0)
    }
    .toolbar {
      ToolbarItem(placement: .confirmationAction) {
        Button("Save") {
          Task {
            if await session.updateAgentConfiguration(
              id: agentID, allocation: allocation, operatingMode: operatingMode,
              symbol: symbol, targetOrderAmount: targetOrderAmount)
            {
              dismiss()
            }
          }
        }
        .disabled(saveIsDisabled)
      }
    }
  }

  private var agent: InvestmentAgent? { session.agents.first(where: { $0.id == agentID }) }
  private var availableSymbols: [String] { session.researchUniverse(for: agentID) }

  private var saveIsDisabled: Bool {
    guard let agent else { return true }
    if !availableSymbols.contains(symbol) { return true }
    if targetOrderAmount <= 0 || targetOrderAmount > session.riskPolicy.maximumOrderAmount {
      return true
    }
    if allocation <= 0 || allocation > session.riskPolicy.maximumAllocationPercent { return true }
    if operatingMode == .automaticWithinLimits, !session.gates.canEnableAutonomousMode {
      return true
    }
    return agent.activationID == nil
      && session.activeAgents.count >= session.currentPlan.maximumActiveAgents
  }
}
