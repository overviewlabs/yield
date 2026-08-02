import SwiftUI

struct ActivityRow: View {
  @Environment(AppSession.self) private var session
  let event: ActivityEvent

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      ZStack {
        Circle().fill(iconColor.opacity(0.12)).frame(width: 36, height: 36)
        Image(systemName: event.type.symbol).font(.subheadline).foregroundStyle(iconColor)
      }
      VStack(alignment: .leading, spacing: 4) {
        HStack {
          Text(event.status).font(.subheadline.weight(.semibold)).foregroundStyle(.primary)
          Spacer()
          Text(event.timestamp, style: .relative).font(.caption2).foregroundStyle(.tertiary)
        }
        Text(displaySummary).font(.caption).foregroundStyle(.secondary).lineLimit(2)
        HStack(spacing: 6) {
          if let symbol = event.symbol {
            Text(symbol).font(.caption.monospaced().weight(.semibold))
          }
          ModeBadge(mode: event.mode)
        }
      }
    }
    .padding(.vertical, 9)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(
      "\(event.type.title), \(event.status), \(displaySummary), \(event.mode.title), \(FinancialFormatters.timestamp(event.timestamp))"
    )
  }

  private var displaySummary: String {
    session.preferences.privacyMode ? "Activity details hidden" : event.summary
  }

  private var iconColor: Color {
    if event.status.localizedCaseInsensitiveContains("reject")
      || event.status.localizedCaseInsensitiveContains("halt")
    {
      return .red
    }
    if event.status.localizedCaseInsensitiveContains("warning")
      || event.status.localizedCaseInsensitiveContains("cancel")
    {
      return .orange
    }
    if event.status.localizedCaseInsensitiveContains("fill")
      || event.status.localizedCaseInsensitiveContains("connect")
    {
      return .green
    }
    return .accentColor
  }
}
