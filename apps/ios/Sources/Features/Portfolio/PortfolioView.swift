import Charts
import SwiftUI

enum PortfolioSection: String, CaseIterable, Identifiable {
  case positions
  case allocation
  case performance
  var id: String { rawValue }
  var title: String { rawValue.capitalized }
}

enum PositionFilter: String, CaseIterable, Identifiable {
  case all
  case stocks
  case etfs
  case options
  case gains
  case losses
  var id: String { rawValue }
  var title: String { rawValue.capitalized }
}

enum PositionSort: String, CaseIterable, Identifiable {
  case marketValue
  case dailyChange
  case totalReturn
  case symbol
  case expiration
  var id: String { rawValue }
  var title: String {
    switch self {
    case .marketValue: "Market Value"
    case .dailyChange: "Daily Change"
    case .totalReturn: "Total Return"
    case .symbol: "Symbol"
    case .expiration: "Expiration"
    }
  }
}

struct PortfolioAllocationPresentation {
  let slices: [AllocationSlice]
  let chartAccessibilityLabel: String
  let chartAccessibilityValue: String
  let disclosureTitle: String
  let disclosureMessage: String

  static func make(
    mode: TreasuryMode, dashboard: DashboardSnapshot, positions: [Position]
  ) -> PortfolioAllocationPresentation? {
    guard dashboard.mode == mode else { return nil }
    switch mode {
    case .demo:
      let slices = DemoFixtures.allocation
      return PortfolioAllocationPresentation(
        slices: slices,
        chartAccessibilityLabel: "Demo asset allocation chart",
        chartAccessibilityValue: accessibleSummary(for: slices),
        disclosureTitle: "Accessible alternative",
        disclosureMessage:
          "ETFs 46.9%, stocks 31.4%, options 3.1%, cash reserve 18.6%. Allocation is seeded Demo data."
      )
    case .paper, .live:
      guard dashboard.accountValue.isFinite, dashboard.accountValue > 0,
        dashboard.buyingPowerReserve.isFinite,
        dashboard.buyingPowerReserve >= 0
      else { return nil }

      var stocks = 0.0
      var etfs = 0.0
      var options = 0.0
      for position in positions {
        guard position.marketValue.isFinite, position.marketValue >= 0 else { return nil }
        switch position.kind {
        case .stock: stocks += position.marketValue
        case .etf: etfs += position.marketValue
        case .option: options += position.marketValue
        }
      }

      let reserve = dashboard.buyingPowerReserve
      let classifiedTotal = stocks + etfs + options + reserve
      guard classifiedTotal.isFinite, classifiedTotal > 0 else { return nil }

      // Small cross-endpoint timing differences are expected. Materially irreconcilable
      // values fail closed instead of being normalized into a misleading allocation.
      let reconciliationTolerance = max(1, dashboard.accountValue * 0.005)
      guard classifiedTotal <= dashboard.accountValue + reconciliationTolerance else {
        return nil
      }

      let denominator = max(dashboard.accountValue, classifiedTotal)
      let unclassified = max(0, dashboard.accountValue - classifiedTotal)
      let rawSlices: [(String, String, Double)] = [
        ("etf", "ETFs", etfs),
        ("stocks", "Stocks", stocks),
        ("options", "Options", options),
        ("reserve", "Reserve", reserve),
        ("unclassified", "Unclassified", unclassified),
      ]
      let slices: [AllocationSlice] = rawSlices.compactMap { entry in
        let (id, name, value) = entry
        guard value > 0 else { return nil }
        return AllocationSlice(id: id, name: name, value: value / denominator * 100)
      }
      guard !slices.isEmpty else { return nil }

      let freshness =
        dashboard.isStale
        ? "The latest \(mode.title) snapshot is marked stale."
        : "As of \(FinancialFormatters.timestamp(dashboard.updatedAt))."
      return PortfolioAllocationPresentation(
        slices: slices,
        chartAccessibilityLabel: "\(mode.title) asset allocation chart",
        chartAccessibilityValue: accessibleSummary(for: slices),
        disclosureTitle: "\(mode.title) allocation snapshot",
        disclosureMessage:
          "\(freshness) Percentages use current position market values and the reported buying-power reserve. Any remaining account value is labeled Unclassified."
      )
    }
  }

  private static func accessibleSummary(for slices: [AllocationSlice]) -> String {
    slices.map { "\($0.name), \(FinancialFormatters.percent($0.value))" }
      .joined(separator: "; ")
  }
}

struct PortfolioPerformancePresentation {
  let points: [PortfolioPoint]
  let metrics: [PerformanceMetric]
  let disclosureTitle: String
  let disclosureMessage: String
  let limitsTitle: String
  let limitsMessage: String
  let portfolioSeriesName: String
  let benchmarkSeriesName: String
  let chartAccessibilityLabel: String
  let chartAccessibilityValue: String

  static func make(
    mode: TreasuryMode, dashboard: DashboardSnapshot
  ) -> PortfolioPerformancePresentation? {
    guard dashboard.mode == mode else { return nil }
    let displayedPoints = Array(dashboard.history.suffix(90))

    switch mode {
    case .demo:
      return PortfolioPerformancePresentation(
        points: displayedPoints,
        metrics: DemoFixtures.performanceMetrics,
        disclosureTitle: "Demo performance · net · time-weighted",
        disclosureMessage:
          "Seeded Demo results include assumed fees, exclude deposits and withdrawals using a time-weighted method, and are never combined with Paper, Live, or backtested results.",
        limitsTitle: "Statistical limits",
        limitsMessage:
          "This short Demo period is not statistically meaningful for probability, profit-factor, or predictive claims.",
        portfolioSeriesName: "Demo portfolio",
        benchmarkSeriesName: "Demo benchmark",
        chartAccessibilityLabel: "Demo portfolio performance chart",
        chartAccessibilityValue: "Seeded Demo history with \(displayedPoints.count) snapshots"
      )
    case .paper, .live:
      let points = displayedPoints.sorted { $0.date < $1.date }
      guard points.count >= 2,
        points.allSatisfy({ point in
          point.value.isFinite && point.value >= 0
            && (point.benchmarkValue.map { $0.isFinite && $0 >= 0 } ?? true)
        })
      else { return nil }

      let metrics = derivedMetrics(mode: mode, points: points)
      let metricSummary = metrics.map { "\($0.title), \($0.value)" }.joined(separator: "; ")
      return PortfolioPerformancePresentation(
        points: points,
        metrics: metrics,
        disclosureTitle: "\(mode.title) portfolio value history",
        disclosureMessage:
          "This chart uses only the authoritative \(mode.title) value history returned for the current session. Portfolio-value change does not remove deposits, withdrawals, fees, or taxes, so it is not a time-weighted return.",
        limitsTitle: "Interpretation limits",
        limitsMessage:
          "Observed \(mode.title) value changes are not predictive and are not live-trading results.",
        portfolioSeriesName: "\(mode.title) portfolio",
        benchmarkSeriesName: "\(mode.title) benchmark",
        chartAccessibilityLabel: "\(mode.title) portfolio value history chart",
        chartAccessibilityValue: metricSummary
      )
    }
  }

  private static func derivedMetrics(
    mode: TreasuryMode, points: [PortfolioPoint]
  ) -> [PerformanceMetric] {
    guard let first = points.first, let last = points.last else { return [] }
    var metrics: [PerformanceMetric] = []

    if first.value > 0 {
      let change = (last.value - first.value) / first.value * 100
      metrics.append(
        PerformanceMetric(
          id: "value-change", title: "Portfolio value change",
          value: FinancialFormatters.percent(change, showSign: true),
          context: "First to latest \(mode.title) snapshot"))
    }

    var peak = first.value
    var maximumDrawdown = 0.0
    for point in points {
      peak = max(peak, point.value)
      if peak > 0 {
        maximumDrawdown = max(maximumDrawdown, (peak - point.value) / peak * 100)
      }
    }
    metrics.append(
      PerformanceMetric(
        id: "observed-drawdown", title: "Maximum value decline",
        value: FinancialFormatters.percent(-maximumDrawdown),
        context: "Observed \(mode.title) snapshots"))

    if let firstBenchmark = first.benchmarkValue, firstBenchmark > 0,
      let lastBenchmark = last.benchmarkValue
    {
      let benchmarkChange = (lastBenchmark - firstBenchmark) / firstBenchmark * 100
      metrics.append(
        PerformanceMetric(
          id: "benchmark-change", title: "Benchmark value change",
          value: FinancialFormatters.percent(benchmarkChange, showSign: true),
          context: "Methodology not supplied"))
    }

    metrics.append(
      PerformanceMetric(
        id: "snapshot-count", title: "Snapshots", value: String(points.count),
        context:
          "\(first.date.formatted(date: .abbreviated, time: .omitted))–\(last.date.formatted(date: .abbreviated, time: .omitted))"
      ))
    return metrics
  }
}

struct PortfolioView: View {
  @Environment(AppSession.self) private var session
  @State private var section = PortfolioSection.positions
  @State private var filter = PositionFilter.all
  @State private var sort = PositionSort.marketValue
  @State private var searchText = ""

  var body: some View {
    NavigationStack {
      Group {
        switch section {
        case .positions:
          positionsList.searchable(text: $searchText, prompt: "Symbol or company")
        case .allocation: AllocationView()
        case .performance: PerformanceView()
        }
      }
      .navigationTitle("Portfolio")
      .safeAreaInset(edge: .top, spacing: 0) {
        Picker("Portfolio section", selection: $section) {
          ForEach(PortfolioSection.allCases) { Text($0.title).tag($0) }
        }
        .pickerStyle(.segmented)
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.bar)
      }
      .toolbar {
        if section == .positions {
          ToolbarItemGroup(placement: .topBarTrailing) {
            Menu {
              Picker("Filter", selection: $filter) {
                ForEach(PositionFilter.allCases) { Text($0.title).tag($0) }
              }
            } label: {
              Label("Filter", systemImage: "line.3.horizontal.decrease.circle")
            }
            Menu {
              Picker("Sort", selection: $sort) {
                ForEach(PositionSort.allCases) { Text($0.title).tag($0) }
              }
            } label: {
              Label("Sort", systemImage: "arrow.up.arrow.down.circle")
            }
          }
        }
      }
    }
  }

  private var positionsList: some View {
    List {
      Section {
        if filteredPositions.isEmpty {
          EmptyStateView(
            symbol: "magnifyingglass", title: "No matching positions",
            message: "Change the search or filter. No financial records were removed.",
            actionTitle: "Clear Filters"
          ) {
            searchText = ""
            filter = .all
          }
          .listRowBackground(Color.clear)
        } else {
          ForEach(filteredPositions) { position in
            NavigationLink {
              PositionDetailView(positionID: position.id)
            } label: {
              PositionRow(position: position)
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
              if session.mode == .demo {
                Button(position.isWatchlisted ? "Unwatch" : "Watch") {
                  session.toggleWatchlist(positionID: position.id)
                }
                .tint(.accentColor)
              }
            }
            .contextMenu {
              if session.mode == .demo {
                Button(position.isWatchlisted ? "Remove from Watchlist" : "Add to Watchlist") {
                  session.toggleWatchlist(positionID: position.id)
                }
              }
            }
          }
        }
      } header: {
        HStack {
          Text("\(filteredPositions.count) open")
          Spacer()
          Text(filter.title)
        }
      } footer: {
        Text("\(session.dashboard.dataLabel). Pull to refresh quote timestamps.")
      }
    }
    .refreshable { await session.refresh() }
    .accessibilityIdentifier("positionsList")
  }

  private var filteredPositions: [Position] {
    let searched = session.positions.filter {
      searchText.isEmpty || $0.symbol.localizedCaseInsensitiveContains(searchText)
        || $0.name.localizedCaseInsensitiveContains(searchText)
    }
    let filtered = searched.filter { position in
      switch filter {
      case .all: true
      case .stocks: position.kind == .stock
      case .etfs: position.kind == .etf
      case .options: position.kind == .option
      case .gains: position.totalReturn > 0
      case .losses: position.totalReturn < 0
      }
    }
    return filtered.sorted { lhs, rhs in
      switch sort {
      case .marketValue: lhs.marketValue > rhs.marketValue
      case .dailyChange: lhs.todayChange > rhs.todayChange
      case .totalReturn: lhs.totalReturn > rhs.totalReturn
      case .symbol: lhs.symbol < rhs.symbol
      case .expiration: (lhs.expiration ?? .distantFuture) < (rhs.expiration ?? .distantFuture)
      }
    }
  }
}

struct PositionRow: View {
  @Environment(AppSession.self) private var session
  let position: Position

  var body: some View {
    HStack(spacing: 12) {
      ZStack {
        RoundedRectangle(cornerRadius: 10).fill(Color.accentColor.opacity(0.12)).frame(
          width: 40, height: 40)
        Text(String(position.symbol.prefix(2))).font(.caption.monospaced().bold()).foregroundStyle(
          .tint)
      }
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 5) {
          Text(position.symbol).font(.headline.monospaced())
          if position.kind == .option {
            Image(systemName: "option").font(.caption).foregroundStyle(.secondary)
          }
          if position.isExcluded {
            Image(systemName: "nosign").font(.caption).foregroundStyle(.orange)
          }
        }
        Text(
          position.kind == .option
            ? position.strategyName ?? "Option"
            : "\(FinancialFormatters.quantity(position.quantity)) \(position.kind.title.lowercased()) shares"
        )
        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
        if let expiration = position.expiration {
          Text("Expires \(expiration.formatted(date: .abbreviated, time: .omitted))").font(
            .caption2
          ).foregroundStyle(.secondary)
        }
      }
      Spacer()
      VStack(alignment: .trailing, spacing: 3) {
        Text(
          FinancialFormatters.currency(position.marketValue, hide: session.preferences.privacyMode)
        ).font(.subheadline.monospacedDigit().weight(.semibold))
        HStack(spacing: 3) {
          Image(
            systemName: session.preferences.privacyMode
              ? "eye.slash"
              : position.todayChange < 0
                ? "arrow.down.right" : position.todayChange > 0 ? "arrow.up.right" : "minus")
          Text(
            session.preferences.privacyMode
              ? "••••••" : FinancialFormatters.percent(position.todayPercent, showSign: true)
          )
          .monospacedDigit()
        }
        .font(.caption).foregroundStyle(
          session.preferences.privacyMode
            ? Color.secondary : TreasurySemanticColor.change(position.todayChange))
      }
    }
    .padding(.vertical, 5)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(positionAccessibilityLabel)
  }

  private var positionAccessibilityLabel: String {
    let hidden = session.preferences.privacyMode
    let direction =
      position.todayChange < 0 ? "down" : position.todayChange > 0 ? "up" : "unchanged"
    if hidden {
      return "\(position.symbol), \(position.name), \(position.kind.title), financial values hidden"
    }
    return
      "\(position.symbol), \(position.name), \(position.kind.title), market value \(FinancialFormatters.spokenCurrency(position.marketValue)), today \(direction) \(FinancialFormatters.percent(abs(position.todayPercent)))"
  }
}

struct AllocationView: View {
  @Environment(AppSession.self) private var session

  var body: some View {
    ScrollView {
      VStack(spacing: 18) {
        if let presentation {
          VStack(alignment: .leading, spacing: 14) {
            Text("Asset class").font(.headline)
            Chart(presentation.slices) { slice in
              SectorMark(
                angle: .value("Allocation", slice.value), innerRadius: .ratio(0.62),
                angularInset: 2
              )
              .foregroundStyle(by: .value("Asset class", slice.name))
              .cornerRadius(4)
            }
            .chartLegend(position: .bottom, alignment: .center)
            .frame(height: 260)
            .accessibilityLabel(presentation.chartAccessibilityLabel)
            .accessibilityValue(presentation.chartAccessibilityValue)
            ForEach(presentation.slices) { slice in
              LabeledValueRow(label: slice.name, value: FinancialFormatters.percent(slice.value))
            }
          }
          .treasuryCard()

          if !concentrationPositions.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
              Text("Concentration").font(.headline)
              ForEach(concentrationPositions) { position in
                let percent = position.marketValue / session.dashboard.accountValue * 100
                VStack(alignment: .leading, spacing: 5) {
                  HStack {
                    Text(position.symbol).monospaced().font(.subheadline.weight(.semibold))
                    Spacer()
                    Text(FinancialFormatters.percent(percent)).font(.caption).monospacedDigit()
                  }
                  ProgressView(value: percent, total: 100)
                }
              }
            }
            .treasuryCard()
          }

          DisclosureNotice(
            title: presentation.disclosureTitle,
            message: presentation.disclosureMessage
          )
          .treasuryCard()
        } else {
          EmptyStateView(
            symbol: "chart.pie",
            title: "Allocation unavailable",
            message:
              "\(session.mode.title) allocation will appear when an authoritative account value and current position or reserve values are available."
          )
          .frame(maxWidth: .infinity, minHeight: 280)
          .treasuryCard()
        }
      }
      .padding()
    }
    .background(Color(uiColor: .systemGroupedBackground))
  }

  private var presentation: PortfolioAllocationPresentation? {
    PortfolioAllocationPresentation.make(
      mode: session.mode, dashboard: session.dashboard, positions: session.positions)
  }

  private var concentrationPositions: [Position] {
    guard session.dashboard.accountValue.isFinite, session.dashboard.accountValue > 0 else {
      return []
    }
    return session.positions
      .filter { $0.marketValue.isFinite && $0.marketValue > 0 }
      .sorted { $0.marketValue > $1.marketValue }
  }
}

struct PerformanceView: View {
  @Environment(AppSession.self) private var session

  var body: some View {
    ScrollView {
      VStack(spacing: 18) {
        if let presentation {
          DisclosureNotice(
            title: presentation.disclosureTitle,
            message: presentation.disclosureMessage,
            symbol: "info.circle", color: .blue
          )
          .treasuryCard()
          Chart(presentation.points) { point in
            LineMark(
              x: .value("Date", point.date),
              y: .value(presentation.portfolioSeriesName, point.value)
            )
            .foregroundStyle(.tint)
            .interpolationMethod(.monotone)
            if let benchmark = point.benchmarkValue {
              LineMark(
                x: .value("Date", point.date),
                y: .value(presentation.benchmarkSeriesName, benchmark)
              )
              .foregroundStyle(.secondary).lineStyle(.init(dash: [5, 4]))
            }
          }
          .chartLegend(.hidden)
          .frame(height: 230)
          .accessibilityLabel(presentation.chartAccessibilityLabel)
          .accessibilityValue(presentation.chartAccessibilityValue)
          .treasuryCard()
          LazyVGrid(columns: [GridItem(.adaptive(minimum: 145), spacing: 12)], spacing: 12) {
            ForEach(presentation.metrics) { metric in
              VStack(alignment: .leading, spacing: 6) {
                Text(metric.title).font(.caption).foregroundStyle(.secondary)
                Text(metric.value).font(.title3.monospacedDigit().weight(.semibold))
                Text(metric.context).font(.caption2).foregroundStyle(.secondary)
              }
              .frame(maxWidth: .infinity, minHeight: 95, alignment: .topLeading)
              .treasuryCard()
            }
          }
          DisclosureNotice(
            title: presentation.limitsTitle,
            message: presentation.limitsMessage,
            symbol: "exclamationmark.triangle", color: .orange
          )
          .treasuryCard()
        } else {
          EmptyStateView(
            symbol: "chart.xyaxis.line",
            title: "Performance unavailable",
            message:
              "\(session.mode.title) performance will appear after at least two authoritative portfolio value snapshots are available."
          )
          .frame(maxWidth: .infinity, minHeight: 280)
          .treasuryCard()
        }
      }
      .padding()
    }
    .background(Color(uiColor: .systemGroupedBackground))
  }

  private var presentation: PortfolioPerformancePresentation? {
    PortfolioPerformancePresentation.make(mode: session.mode, dashboard: session.dashboard)
  }
}
