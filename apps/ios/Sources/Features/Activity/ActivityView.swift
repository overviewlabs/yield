import SwiftUI

enum ActivityFilter: Hashable, Identifiable {
  case all
  case type(ActivityType)

  var id: String {
    switch self {
    case .all: "all"
    case .type(let type): type.rawValue
    }
  }

  var title: String {
    switch self {
    case .all: "All"
    case .type(let type): type.title
    }
  }
}

struct ActivityView: View {
  @Environment(AppSession.self) private var session
  @State private var filter = ActivityFilter.all
  @State private var searchText = ""

  var body: some View {
    NavigationStack {
      List {
        Section {
          filterStrip
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
        }
        Section {
          if filteredEvents.isEmpty {
            EmptyStateView(
              symbol: "clock", title: "No matching activity",
              message: "Change the filter or search. Audit records were not removed.",
              actionTitle: "Show All"
            ) {
              filter = .all
              searchText = ""
            }
            .listRowBackground(Color.clear)
          } else {
            ForEach(groupedDates, id: \.self) { day in
              Section(day.formatted(date: .complete, time: .omitted)) {
                ForEach(events(on: day)) { event in
                  NavigationLink {
                    ActivityDetailView(eventID: event.id)
                  } label: {
                    ActivityRow(event: event)
                  }
                }
              }
            }
          }
        } footer: {
          Text(
            "Every event is labeled Demo, Paper, or Live and shown in your current timezone: \(TimeZone.current.identifier)."
          )
        }
      }
      .listStyle(.insetGrouped)
      .navigationTitle("Activity")
      .searchable(text: $searchText, prompt: "Symbol, agent, or status")
      .refreshable { await session.refresh() }
      .accessibilityIdentifier("activityList")
    }
  }

  private var filterStrip: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach([ActivityFilter.all] + ActivityType.allCases.map(ActivityFilter.type)) { item in
          Button(item.title) { filter = item }
            .buttonStyle(.bordered)
            .tint(filter == item ? .accentColor : .secondary)
            .accessibilityAddTraits(filter == item ? .isSelected : [])
        }
      }
      .padding(.horizontal)
    }
  }

  private var filteredEvents: [ActivityEvent] {
    session.activities.filter { event in
      let matchesFilter: Bool =
        switch filter {
        case .all: true
        case .type(let type): event.type == type
        }
      let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
      let matchesSearch =
        query.isEmpty || event.symbol?.localizedCaseInsensitiveContains(query) == true
        || event.agentName?.localizedCaseInsensitiveContains(query) == true
        || event.status.localizedCaseInsensitiveContains(query)
        || event.summary.localizedCaseInsensitiveContains(query)
      return matchesFilter && matchesSearch
    }.sorted { $0.timestamp > $1.timestamp }
  }

  private var groupedDates: [Date] {
    Array(Set(filteredEvents.map { Calendar.current.startOfDay(for: $0.timestamp) })).sorted(by: >)
  }

  private func events(on day: Date) -> [ActivityEvent] {
    filteredEvents.filter { Calendar.current.isDate($0.timestamp, inSameDayAs: day) }
  }
}
