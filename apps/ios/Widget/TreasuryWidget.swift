import SwiftUI
import WidgetKit

private struct TreasuryWidgetEntry: TimelineEntry {
  let date: Date
  let mode: String
  let agentStatus: String
  let lastRun: Date?
  let pendingProposals: Int
  let riskState: String
}

private struct TreasuryWidgetProvider: TimelineProvider {
  func placeholder(in context: Context) -> TreasuryWidgetEntry {
    TreasuryWidgetEntry(
      date: .now, mode: "Demo", agentStatus: "Monitoring", lastRun: .now.addingTimeInterval(-3_600),
      pendingProposals: 1, riskState: "Within limits")
  }

  func getSnapshot(in context: Context, completion: @escaping (TreasuryWidgetEntry) -> Void) {
    completion(loadEntry())
  }

  func getTimeline(
    in context: Context, completion: @escaping (Timeline<TreasuryWidgetEntry>) -> Void
  ) {
    let entry = loadEntry()
    completion(Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(15 * 60))))
  }

  private func loadEntry() -> TreasuryWidgetEntry {
    let values = UserDefaults(suiteName: "group.ai.whox.metis")?.dictionary(
      forKey: "widgetSnapshot")
    let lastRunTimestamp = values?["lastRun"] as? Double ?? 0
    return TreasuryWidgetEntry(
      date: .now,
      mode: values?["mode"] as? String ?? "Demo",
      agentStatus: values?["agentStatus"] as? String ?? "Open app to configure",
      lastRun: lastRunTimestamp > 0 ? Date(timeIntervalSince1970: lastRunTimestamp) : nil,
      pendingProposals: values?["pendingProposals"] as? Int ?? 0,
      riskState: values?["riskState"] as? String ?? "Status unavailable"
    )
  }
}

private struct TreasuryWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: TreasuryWidgetEntry

  var body: some View {
    Link(
      destination: URL(
        string: entry.pendingProposals > 0 ? "metis://proposals" : "metis://dashboard"
      )!
    ) {
      VStack(alignment: .leading, spacing: family == .systemSmall ? 7 : 10) {
        HStack {
          Image(systemName: "lock.shield")
          Text("Treasury").font(.headline)
          Spacer()
          Text(entry.mode).font(.caption.bold()).padding(.horizontal, 6).padding(.vertical, 3)
            .background(.tint.opacity(0.14), in: Capsule())
        }
        Text(entry.agentStatus).font(.title3.weight(.semibold)).lineLimit(2)
        if family != .systemSmall {
          HStack {
            Label(entry.riskState, systemImage: "shield")
            Spacer()
            Label("\(entry.pendingProposals) pending", systemImage: "doc.badge.clock")
          }
          .font(.caption)
        } else {
          Label("\(entry.pendingProposals) pending", systemImage: "doc.badge.clock").font(.caption)
        }
        Spacer(minLength: 0)
        Text(
          entry.lastRun.map { "Last run \($0.formatted(.relative(presentation: .named)))" }
            ?? "No completed run"
        )
        .font(.caption2).foregroundStyle(.secondary)
      }
      .privacySensitive(true)
    }
    .containerBackground(.fill.tertiary, for: .widget)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(
      "Metis, \(entry.mode), agent \(entry.agentStatus), \(entry.pendingProposals) pending proposals, risk \(entry.riskState)"
    )
  }
}

private struct TreasuryStatusWidget: Widget {
  let kind = "ai.whox.metis.status"
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: TreasuryWidgetProvider()) { entry in
      TreasuryWidgetView(entry: entry)
    }
    .configurationDisplayName("Metis Status")
    .description("Privacy-preserving agent, proposal, and risk status.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

@main
struct WHOXTreasuryWidgetBundle: WidgetBundle {
  var body: some Widget { TreasuryStatusWidget() }
}
