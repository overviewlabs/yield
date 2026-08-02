import Foundation

enum TreasuryRoute: Hashable, Identifiable, Sendable {
  case dashboard
  case pendingProposals
  case activeAgent
  case riskControls
  case pauseAllReview
  case activity(String)
  case agent(String)
  case position(String)

  var id: String {
    switch self {
    case .dashboard: "dashboard"
    case .pendingProposals: "pending-proposals"
    case .activeAgent: "active-agent"
    case .riskControls: "risk-controls"
    case .pauseAllReview: "pause-all-review"
    case .activity(let id): "activity-\(id)"
    case .agent(let id): "agent-\(id)"
    case .position(let id): "position-\(id)"
    }
  }

  static func parse(_ url: URL) -> TreasuryRoute? {
    guard url.scheme == "whoxtreasury" else { return nil }
    let components = [url.host()].compactMap { $0 } + url.pathComponents.filter { $0 != "/" }
    guard let first = components.first else { return nil }
    switch first {
    case "dashboard": return .dashboard
    case "proposals": return .pendingProposals
    case "active-agent": return .activeAgent
    case "risk": return components.dropFirst().first == "pause" ? .pauseAllReview : .riskControls
    case "activity": return components.dropFirst().first.map(TreasuryRoute.activity)
    case "agent": return components.dropFirst().first.map(TreasuryRoute.agent)
    case "position": return components.dropFirst().first.map(TreasuryRoute.position)
    default: return nil
    }
  }
}
