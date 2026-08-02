import SwiftUI

struct MainTabView: View {
  @Environment(AppSession.self) private var session

  var body: some View {
    @Bindable var session = session
    TabView(selection: $session.selectedTab) {
      Tab("Home", systemImage: MainTab.home.symbol, value: MainTab.home) { HomeView() }
      Tab("Portfolio", systemImage: MainTab.portfolio.symbol, value: MainTab.portfolio) {
        PortfolioView()
      }
      Tab("Agents", systemImage: MainTab.agents.symbol, value: MainTab.agents) { AgentsView() }
      Tab("Activity", systemImage: MainTab.activity.symbol, value: MainTab.activity) {
        ActivityView()
      }
      Tab("Settings", systemImage: MainTab.settings.symbol, value: MainTab.settings) {
        SettingsView()
      }
    }
    .tabViewStyle(.sidebarAdaptable)
    .sheet(item: $session.presentedRoute) { route in
      NavigationStack { routedView(route) }
        .presentationDetents(route == .pauseAllReview ? [.medium] : [.large])
    }
  }

  @ViewBuilder
  private func routedView(_ route: TreasuryRoute) -> some View {
    switch route {
    case .dashboard:
      HomeView()
    case .pendingProposals:
      if let event = session.pendingProposals.first {
        ActivityDetailView(eventID: event.id)
      } else {
        EmptyStateView(
          symbol: "checkmark.circle", title: "No pending proposals",
          message: "There is nothing waiting for approval.")
      }
    case .activeAgent:
      if let agent = session.activeAgents.first {
        AgentDetailView(agentID: agent.id)
      } else {
        EmptyStateView(
          symbol: "pause.circle", title: "No active agent",
          message: "Choose an available strategy from Discover.")
      }
    case .riskControls:
      RiskControlsView()
    case .pauseAllReview:
      PauseAllReviewView()
    case .activity(let id):
      ActivityDetailView(eventID: id)
    case .agent(let id):
      AgentDetailView(agentID: id)
    case .position(let id):
      PositionDetailView(positionID: id)
    }
  }
}
