import Charts
import SwiftUI

struct PositionDetailView: View {
  @Environment(AppSession.self) private var session
  let positionID: String
  @State private var showingCloseReview = false
  @State private var chartRange = ChartRange.month

  var body: some View {
    Group {
      if let position {
        ScrollView {
          VStack(spacing: 18) {
            header(position)
            priceChart(position)
            if position.kind == .option { optionDetails(position) } else { equityDetails(position) }
            thesis(position)
            riskAllocation(position)
            activeOrders(position)
            DisclosureNotice(
              title: session.dashboard.dataLabel,
              message:
                session.mode == .demo
                ? "Quotes and outcomes on this screen are simulated and timestamped. No unverified Greeks, implied volatility, open interest, or probability values are shown."
                : "Only fields supplied or directly derived from the authoritative \(session.mode.title) API are shown. Missing brokerage fields are labeled unavailable."
            )
            .treasuryCard()
          }
          .padding()
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle(position.symbol)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { positionToolbar(position) }
        .sheet(isPresented: $showingCloseReview) { CloseReviewSheet(position: position) }
      } else {
        EmptyStateView(
          symbol: "questionmark.folder", title: "Position unavailable",
          message: "This position may have closed or changed. Refresh Portfolio."
        )
        .navigationTitle("Position")
      }
    }
  }

  private var position: Position? { session.positions.first(where: { $0.id == positionID }) }

  private func header(_ position: Position) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top) {
        VStack(alignment: .leading, spacing: 4) {
          Text(position.symbol).font(.largeTitle.monospaced().bold())
          Text(position.name).foregroundStyle(.secondary)
          HStack {
            StatusBadge(
              title: position.kind.title,
              symbol: position.kind == .option ? "option" : "building.2", color: .accentColor)
            StatusBadge(
              title: "\(session.mode.title) record", symbol: "checkmark.circle", color: .green)
          }
        }
        Spacer()
        if position.isWatchlisted {
          Image(systemName: "star.fill").foregroundStyle(.yellow).accessibilityLabel("On watchlist")
        }
      }
      Divider()
      HStack(alignment: .firstTextBaseline) {
        Text(
          FinancialFormatters.currency(position.marketValue, hide: session.preferences.privacyMode)
        )
        .font(.title.monospacedDigit().weight(.semibold))
        Spacer()
        ChangeLabel(
          amount: position.todayChange, percent: position.todayPercent,
          privacy: session.preferences.privacyMode)
      }
      Text(
        position.quoteTimestamp == .distantPast
          ? "Quote timestamp not supplied by API"
          : "Quote \(position.quoteTimestamp.formatted(date: .omitted, time: .standard)) · \(session.mode.title) data"
      )
      .font(.caption).foregroundStyle(.secondary)
    }
    .treasuryCard()
  }

  @ViewBuilder
  private func priceChart(_ position: Position) -> some View {
    if session.preferences.privacyMode {
      DisclosureNotice(
        title: "Price history hidden",
        message: "Turn off privacy mode to display exact chart values.",
        symbol: "eye.slash"
      )
      .treasuryCard()
    } else if session.mode != .demo {
      DisclosureNotice(
        title: "Price history unavailable",
        message:
          "The positions response does not include canonical price history, so WHOX does not synthesize a Paper chart.",
        symbol: "chart.xyaxis.line"
      )
      .treasuryCard()
    } else {
      VStack(alignment: .leading, spacing: 12) {
        HStack {
          Text("Demo price history").font(.headline)
          Spacer()
          Text(chartRange.rawValue).font(.caption).foregroundStyle(.secondary)
        }
        Picker("Price range", selection: $chartRange) {
          ForEach(ChartRange.allCases) { Text($0.rawValue).tag($0) }
        }
        .pickerStyle(.segmented)
        Chart(demoPricePoints(position)) { point in
          LineMark(x: .value("Date", point.date), y: .value("Price", point.price))
            .foregroundStyle(position.totalReturn >= 0 ? .green : .red)
            .interpolationMethod(.monotone)
          AreaMark(
            x: .value("Date", point.date), yStart: .value("Baseline", priceMinimum(position)),
            yEnd: .value("Price", point.price)
          )
          .foregroundStyle(
            .linearGradient(
              colors: [(position.totalReturn >= 0 ? Color.green : .red).opacity(0.2), .clear],
              startPoint: .top, endPoint: .bottom))
        }
        .chartXAxis(.hidden)
        .chartYScale(domain: priceMinimum(position)...priceMaximum(position))
        .frame(height: 180)
        .accessibilityLabel("Seeded Demo price chart for \(position.symbol)")
        .accessibilityValue(
          "Current price \(FinancialFormatters.spokenCurrency(position.currentPrice)); total return \(FinancialFormatters.percent(position.totalReturnPercent, showSign: true))."
        )
      }
      .treasuryCard()
    }
  }

  private func equityDetails(_ position: Position) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Position").font(.headline)
      LabeledValueRow(label: "Quantity", value: quantity(position.quantity))
      LabeledValueRow(
        label: "Average cost", value: currency(position.averageCost))
      LabeledValueRow(
        label: "Current price", value: currency(position.currentPrice))
      LabeledValueRow(
        label: "Today’s P&L",
        value: currency(position.todayChange, showSign: true),
        valueColor: financialColor(position.todayChange))
      LabeledValueRow(
        label: "Unrealized P&L",
        value: currency(position.totalReturn, showSign: true),
        valueColor: financialColor(position.totalReturn))
      LabeledValueRow(
        label: "Realized P&L",
        value:
          position.quoteTimestamp == .distantPast
          ? "Not supplied"
          : currency(position.realizedPnL, showSign: true))
      LabeledValueRow(label: "Sector", value: position.sector)
      DisclosureGroup("Tax lots") {
        Text(
          position.quoteTimestamp == .distantPast
            ? "Tax-lot details were not supplied by the API. WHOX Treasury does not invent unavailable brokerage tax data."
            : "Tax-lot details are not available in this Demo fixture. WHOX Treasury does not invent unavailable brokerage tax data."
        )
        .font(.caption).foregroundStyle(.secondary)
      }
      if session.mode == .demo {
        Button("Review Exit", systemImage: "rectangle.and.pencil.and.ellipsis") {
          showingCloseReview = true
        }
        .buttonStyle(.borderedProminent)
        .frame(maxWidth: .infinity)
      } else {
        DisclosureNotice(
          title: "Close review unavailable",
          message:
            "No authoritative \(session.mode.title) close-proposal endpoint is enabled. Review or close this position directly at the brokerage.",
          symbol: "arrow.up.right.square")
      }
    }
    .treasuryCard()
  }

  private func optionDetails(_ position: Position) -> some View {
    VStack(spacing: 18) {
      VStack(alignment: .leading, spacing: 12) {
        Text("Options position").font(.headline)
        LabeledValueRow(label: "Underlying", value: position.symbol)
        LabeledValueRow(label: "Strategy", value: position.strategyName ?? "Option")
        ForEach(position.optionLegs) { leg in
          LabeledValueRow(
            label: "\(leg.side.rawValue.capitalized) \(leg.type.rawValue.capitalized)",
            value:
              session.preferences.privacyMode
              ? privacyPlaceholder
              : "\(leg.quantity) × \(FinancialFormatters.currency(leg.strike)) · \(leg.expiration.formatted(date: .abbreviated, time: .omitted))"
          )
        }
        LabeledValueRow(
          label: "Average debit", value: currency(position.averageCost))
        LabeledValueRow(
          label: "Current value", value: currency(position.marketValue))
        LabeledValueRow(
          label: "Unrealized P&L",
          value: currency(position.totalReturn, showSign: true),
          valueColor: financialColor(position.totalReturn))
        if let expiration = position.expiration {
          LabeledValueRow(
            label: "Days to expiration",
            value: String(
              Calendar.current.dateComponents([.day], from: .now, to: expiration).day ?? 0))
        }
        if let maximumLoss = position.maximumLoss {
          LabeledValueRow(
            label: "Maximum known loss", value: currency(maximumLoss),
            valueColor: .red)
        }
        if let maximumProfit = position.maximumProfit {
          LabeledValueRow(
            label: "Maximum profit", value: currency(maximumProfit))
        } else {
          LabeledValueRow(label: "Maximum profit", value: "Not mathematically bounded")
        }
        if let breakeven = position.breakeven {
          LabeledValueRow(
            label: "Breakeven at expiration", value: currency(breakeven))
        }
      }
      .treasuryCard()

      if session.preferences.privacyMode {
        DisclosureNotice(
          title: "Payoff values hidden",
          message: "Turn off privacy mode to display exact contract payoff values.",
          symbol: "eye.slash"
        )
        .treasuryCard()
      } else {
        payoffChart(position)
      }

      VStack(alignment: .leading, spacing: 10) {
        Text("Warnings").font(.headline)
        DisclosureNotice(
          title: "Assignment and exercise",
          message:
            "Review broker instructions before expiration. Push notifications are not the only expiration control.",
          symbol: "calendar.badge.exclamationmark", color: .orange)
        DisclosureNotice(
          title: "Liquidity",
          message: position.liquidityNote ?? "No approved liquidity data is available.",
          symbol: "drop.degreesign", color: .orange)
        DisclosureNotice(
          title: "Earnings and dividends",
          message:
            "No verified event is included in this fixture. Confirm current data before any action.",
          symbol: "building.columns")
      }
      .treasuryCard()

      if session.mode == .demo {
        Button("Review Close", systemImage: "rectangle.and.pencil.and.ellipsis") {
          showingCloseReview = true
        }
        .buttonStyle(.borderedProminent).controlSize(.large).frame(maxWidth: .infinity)
      } else {
        DisclosureNotice(
          title: "Close review unavailable",
          message:
            "No authoritative \(session.mode.title) close-proposal endpoint is enabled. Review or close this position directly at the brokerage.",
          symbol: "arrow.up.right.square")
      }
    }
  }

  private func payoffChart(_ position: Position) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Expiration payoff illustration").font(.headline)
      Chart(payoffPoints(position)) { point in
        AreaMark(
          x: .value("Underlying price", point.price), y: .value("Profit or loss", point.payoff)
        )
        .foregroundStyle(point.payoff >= 0 ? Color.green.opacity(0.22) : Color.red.opacity(0.22))
        LineMark(
          x: .value("Underlying price", point.price), y: .value("Profit or loss", point.payoff)
        )
        .foregroundStyle(Color.accentColor)
        RuleMark(y: .value("Break even", 0)).foregroundStyle(.secondary)
      }
      .frame(height: 200)
      .accessibilityLabel("Option payoff illustration at expiration")
      .accessibilityValue(
        "Maximum known loss \(FinancialFormatters.spokenCurrency(position.maximumLoss ?? 0)); breakeven \(FinancialFormatters.spokenCurrency(position.breakeven ?? 0))."
      )
      Text(
        "Illustrative expiration payoff from the seeded contract terms; excludes early exercise, assignment, fees, and liquidity effects."
      )
      .font(.caption).foregroundStyle(.secondary)
    }
    .treasuryCard()
  }

  private func thesis(_ position: Position) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Agent thesis history").font(.headline)
      ForEach(position.thesisHistory) { note in
        VStack(alignment: .leading, spacing: 3) {
          Text(note.date.formatted(date: .abbreviated, time: .shortened)).font(.caption)
            .foregroundStyle(.secondary)
          Text(note.summary).font(.subheadline)
        }
        if note.id != position.thesisHistory.last?.id { Divider() }
      }
    }
    .treasuryCard()
  }

  @ViewBuilder
  private func riskAllocation(_ position: Position) -> some View {
    if session.dashboard.accountValue.isFinite, session.dashboard.accountValue > 0,
      position.marketValue.isFinite
    {
      VStack(alignment: .leading, spacing: 10) {
        Text("Risk allocation").font(.headline)
        let percent = max(0, position.marketValue / session.dashboard.accountValue * 100)
        LabeledValueRow(label: "Portfolio allocation", value: FinancialFormatters.percent(percent))
        LabeledValueRow(
          label: "Global allocation cap",
          value: FinancialFormatters.percent(session.riskPolicy.maximumAllocationPercent))
        ProgressView(value: percent, total: session.riskPolicy.maximumAllocationPercent)
        if position.isExcluded {
          StatusBadge(title: "Excluded from new entries", symbol: "nosign", color: .orange)
        }
      }
      .treasuryCard()
    } else {
      DisclosureNotice(
        title: "Risk allocation unavailable",
        message: "A positive authoritative account value is required before allocation is shown.",
        symbol: "chart.pie"
      )
      .treasuryCard()
    }
  }

  private func activeOrders(_ position: Position) -> some View {
    let orders = session.activeOrders(for: position.symbol)
    return VStack(alignment: .leading, spacing: 8) {
      Text("Active orders").font(.headline)
      if orders.isEmpty {
        EmptyStateView(
          symbol: "tray", title: "No active orders",
          message: "No open \(session.mode.title) order currently references \(position.symbol)."
        )
        .frame(minHeight: 150)
      } else {
        ForEach(orders) { event in
          VStack(alignment: .leading, spacing: 10) {
            HStack {
              VStack(alignment: .leading, spacing: 3) {
                Text(event.order?.status.title ?? event.status).font(.subheadline.weight(.semibold))
                if let remaining = event.order?.remainingQuantity {
                  Text("\(quantity(remaining)) remaining")
                    .font(.caption).foregroundStyle(.secondary)
                }
              }
              Spacer()
              ModeBadge(mode: event.mode)
            }
            HStack {
              NavigationLink("Review order") { ActivityDetailView(eventID: event.id) }
              Spacer()
              Button("Cancel", role: .destructive) {
                Task { await session.cancelOrder(event.id) }
              }
              .disabled(session.orderCancellationsInFlight.contains(event.id))
              .accessibilityHint("Requires device authentication and authoritative confirmation")
            }
            .font(.subheadline)
          }
          .padding(.vertical, 6)
          if event.id != orders.last?.id { Divider() }
        }
      }
    }
    .treasuryCard()
  }

  @ToolbarContentBuilder
  private func positionToolbar(_ position: Position) -> some ToolbarContent {
    ToolbarItem(placement: .topBarTrailing) {
      Menu {
        if session.mode == .demo {
          Button(
            position.isWatchlisted ? "Remove from Watchlist" : "Add to Watchlist",
            systemImage: position.isWatchlisted ? "star.slash" : "star"
          ) {
            session.toggleWatchlist(positionID: position.id)
          }
        }
        Button(
          position.isExcluded ? "Allow Future Entries" : "Exclude Future Entries",
          systemImage: position.isExcluded ? "checkmark.circle" : "nosign"
        ) {
          Task { await session.toggleExclusion(positionID: position.id) }
        }
        .disabled(session.exclusionUpdateIsInFlight(positionID: position.id))
      } label: {
        Label("Position actions", systemImage: "ellipsis.circle")
      }
    }
  }

  private var privacyPlaceholder: String { "••••••" }

  private func currency(_ value: Double, showSign: Bool = false) -> String {
    FinancialFormatters.currency(
      value, showSign: showSign, hide: session.preferences.privacyMode)
  }

  private func quantity(_ value: Double) -> String {
    session.preferences.privacyMode
      ? privacyPlaceholder : FinancialFormatters.quantity(value)
  }

  private func financialColor(_ value: Double) -> Color {
    session.preferences.privacyMode ? .secondary : TreasurySemanticColor.change(value)
  }

  private func demoPricePoints(_ position: Position) -> [PricePoint] {
    let count = chartRange.sampleCount
    return (0..<count).map { index in
      let fraction = Double(index) / Double(max(1, count - 1))
      let start = position.currentPrice / (1 + position.totalReturnPercent / 100)
      let trend = start + (position.currentPrice - start) * fraction
      let wave = sin(Double(index) * 0.72) * max(position.currentPrice * 0.012, 0.15)
      return PricePoint(
        date: .now.addingTimeInterval(Double(index - count) * 86_400),
        price: max(0.01, trend + wave))
    }
  }

  private func priceMinimum(_ position: Position) -> Double {
    (demoPricePoints(position).map(\.price).min() ?? 0) * 0.97
  }
  private func priceMaximum(_ position: Position) -> Double {
    (demoPricePoints(position).map(\.price).max() ?? 1) * 1.03
  }

  private func payoffPoints(_ position: Position) -> [PayoffPoint] {
    guard let leg = position.optionLegs.first else { return [] }
    let premium = position.averageCost * 100
    return stride(
      from: max(1, leg.strike * 0.72), through: leg.strike * 1.28, by: leg.strike * 0.02
    ).map { price in
      let intrinsic = leg.type == .put ? max(leg.strike - price, 0) : max(price - leg.strike, 0)
      let payoff = (intrinsic * 100 - premium) * Double(leg.quantity)
      return PayoffPoint(price: price, payoff: payoff)
    }
  }
}

private struct PricePoint: Identifiable {
  let id = UUID()
  let date: Date
  let price: Double
}

private struct PayoffPoint: Identifiable {
  var id: Double { price }
  let price: Double
  let payoff: Double
}

private struct CloseReviewSheet: View {
  @Environment(AppSession.self) private var session
  @Environment(\.dismiss) private var dismiss
  let position: Position
  @State private var quantity: Double

  init(position: Position) {
    self.position = position
    _quantity = State(
      initialValue: position.kind == .option
        ? 1 : min(position.quantity, max(1, position.quantity / 2)))
  }

  var body: some View {
    NavigationStack {
      Form {
        Section("Proposed close") {
          LabeledContent("Position", value: position.symbol)
          Stepper(
            value: $quantity,
            in: position.kind == .option
              ? 1...position.quantity : min(0.0001, position.quantity)...position.quantity,
            step: position.kind == .option ? 1 : 0.25
          ) {
            LabeledContent("Quantity", value: FinancialFormatters.quantity(quantity))
          }
          LabeledContent(
            "Estimated proceeds",
            value: FinancialFormatters.currency(
              quantity * position.currentPrice * (position.kind == .option ? 100 : 1)))
          LabeledContent("Order shape", value: "Limit review")
        }
        Section("Before creating the review") {
          Label(
            "The estimate is not a guaranteed execution price.",
            systemImage: "exclamationmark.triangle")
          Label(
            "Market status, liquidity, account state, and risk settings are rechecked.",
            systemImage: "checkmark.shield")
          Label("This Demo action never reaches a broker.", systemImage: "sparkles.rectangle.stack")
        }
        Section {
          Button("Authenticate and Create Demo Review") {
            Task {
              await session.createDemoCloseReview(positionID: position.id, quantity: quantity)
              dismiss()
            }
          }
          .frame(maxWidth: .infinity)
        }
      }
      .navigationTitle("Review Close")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
    }
    .presentationDetents([.medium, .large])
  }
}
