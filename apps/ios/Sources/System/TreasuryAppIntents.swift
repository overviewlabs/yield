import AppIntents
import Foundation

private enum IntentRouteWriter {
  static func store(_ url: String) {
    UserDefaults(suiteName: "group.ai.whox.metis")?.set(url, forKey: "pendingIntentURL")
  }
}

struct OpenDashboardIntent: AppIntent {
  static let title: LocalizedStringResource = "Open Dashboard"
  static let description = IntentDescription("Open the privacy-protected Metis dashboard.")
  static let openAppWhenRun = true
  func perform() async throws -> some IntentResult {
    IntentRouteWriter.store("metis://dashboard")
    return .result()
  }
}

struct OpenPendingProposalsIntent: AppIntent {
  static let title: LocalizedStringResource = "Open Pending Proposals"
  static let description = IntentDescription(
    "Open proposals for authenticated in-app review. This intent never approves a trade.")
  static let openAppWhenRun = true
  func perform() async throws -> some IntentResult {
    IntentRouteWriter.store("metis://proposals")
    return .result()
  }
}

struct OpenActiveAgentIntent: AppIntent {
  static let title: LocalizedStringResource = "Open Active Agent"
  static let description = IntentDescription("Open the active investment agent status.")
  static let openAppWhenRun = true
  func perform() async throws -> some IntentResult {
    IntentRouteWriter.store("metis://active-agent")
    return .result()
  }
}

struct OpenRiskControlsIntent: AppIntent {
  static let title: LocalizedStringResource = "Open Risk Controls"
  static let description = IntentDescription("Open risk controls without changing any limits.")
  static let openAppWhenRun = true
  func perform() async throws -> some IntentResult {
    IntentRouteWriter.store("metis://risk")
    return .result()
  }
}

struct OpenPauseAllReviewIntent: AppIntent {
  static let title: LocalizedStringResource = "Open Pause-All Review"
  static let description = IntentDescription(
    "Open the protected Pause All review. The intent itself never pauses or trades.")
  static let openAppWhenRun = true
  func perform() async throws -> some IntentResult {
    IntentRouteWriter.store("metis://risk/pause")
    return .result()
  }
}

struct TreasuryShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: OpenDashboardIntent(), phrases: ["Open \(.applicationName) dashboard"],
      shortTitle: "Dashboard", systemImageName: "chart.line.uptrend.xyaxis")
    AppShortcut(
      intent: OpenPendingProposalsIntent(), phrases: ["Open \(.applicationName) proposals"],
      shortTitle: "Proposals", systemImageName: "doc.text.magnifyingglass")
    AppShortcut(
      intent: OpenRiskControlsIntent(), phrases: ["Open \(.applicationName) risk controls"],
      shortTitle: "Risk Controls", systemImageName: "shield")
  }
}
