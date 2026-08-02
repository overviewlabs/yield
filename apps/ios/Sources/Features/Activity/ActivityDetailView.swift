import SwiftUI

struct ActivityDetailView: View {
  @Environment(AppSession.self) private var session
  let eventID: String
  @State private var showingRejectConfirmation = false
  @State private var showingAdjustment = false
  @State private var showingOrderCancelConfirmation = false

  var body: some View {
    Group {
      if let event {
        ScrollView {
          VStack(spacing: 18) {
            header(event)
            if let proposal = event.proposal {
              proposalDetail(proposal)
            } else if let order = event.order {
              orderDetail(order)
            } else if let run = event.agentRun {
              runDetail(run)
            } else if let risk = event.riskEvent {
              riskDetail(risk)
            } else {
              generalDetail(event)
            }
          }
          .padding()
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle(event.type.title.dropLast(event.type.title.hasSuffix("s") ? 1 : 0))
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(
          "Reject this proposal?", isPresented: $showingRejectConfirmation,
          titleVisibility: .visible
        ) {
          Button("Reject Proposal", role: .destructive) {
            if let id = event.proposal?.id { Task { await session.rejectProposal(id) } }
          }
          Button("Cancel", role: .cancel) {}
        } message: {
          Text("The proposal will be marked rejected and no order will be submitted.")
        }
        .confirmationDialog(
          "Cancel the remaining order?", isPresented: $showingOrderCancelConfirmation,
          titleVisibility: .visible
        ) {
          Button("Cancel Remaining Order", role: .destructive) {
            Task { await session.cancelOrder(event.id) }
          }
          Button("Keep Order", role: .cancel) {}
        } message: {
          Text(
            "Cancellation is not guaranteed until WHOX confirms the authoritative order state. Any quantity already filled remains filled."
          )
        }
        .sheet(isPresented: $showingAdjustment) {
          if let proposal = event.proposal { ProposalAdjustmentSheet(proposal: proposal) }
        }
      } else {
        EmptyStateView(
          symbol: "questionmark.folder", title: "Activity unavailable",
          message: "The record could not be found. Refresh the timeline.")
      }
    }
  }

  private var event: ActivityEvent? { session.activities.first(where: { $0.id == eventID }) }

  private func header(_ event: ActivityEvent) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top) {
        ZStack {
          Circle().fill(.tint.opacity(0.12)).frame(width: 52, height: 52)
          Image(systemName: event.type.symbol).font(.title2).foregroundStyle(.tint)
        }
        VStack(alignment: .leading, spacing: 4) {
          Text(event.status).font(.title2.bold())
          Text(session.preferences.privacyMode ? "Activity details hidden" : event.summary)
            .foregroundStyle(.secondary)
        }
        Spacer()
        ModeBadge(mode: event.mode)
      }
      Divider()
      LabeledValueRow(
        label: "Timestamp",
        value: FinancialFormatters.timestampWithTimeZone(event.timestamp),
        symbol: "clock")
      if let agent = event.agentName {
        LabeledValueRow(
          label: "Agent", value: agent, symbol: "point.3.connected.trianglepath.dotted")
      }
      if let symbol = event.symbol {
        LabeledValueRow(label: "Symbol", value: symbol, symbol: "building.2")
      }
    }
    .treasuryCard()
  }

  private func proposalDetail(_ proposal: TradeProposal) -> some View {
    VStack(spacing: 18) {
      VStack(alignment: .leading, spacing: 12) {
        Text("Proposal").font(.headline)
        LabeledValueRow(
          label: "Agent version", value: "\(proposal.agentName) · v\(proposal.agentVersion)")
        LabeledValueRow(label: "Created", value: FinancialFormatters.timestamp(proposal.createdAt))
        LabeledValueRow(
          label: "Data freshness", value: FinancialFormatters.timestamp(proposal.dataTimestamp))
        LabeledValueRow(
          label: "Quote timestamp", value: FinancialFormatters.timestamp(proposal.quoteTimestamp))
        LabeledValueRow(label: "Instrument", value: "\(proposal.symbol) · \(proposal.instrument)")
        LabeledValueRow(
          label: "Action",
          value: "\(proposal.side) \(quantity(proposal.quantity))")
        LabeledValueRow(
          label: "Estimated notional",
          value: currency(proposal.estimatedNotional))
        LabeledValueRow(label: "Order", value: "\(proposal.orderType) · \(proposal.timeInForce)")
        if let limit = proposal.limitPrice {
          LabeledValueRow(label: "Limit price", value: currency(limit))
        }
        LabeledValueRow(
          label: "Approval expires",
          value: FinancialFormatters.timestamp(proposal.approvalExpiresAt),
          valueColor: proposal.approvalExpiresAt <= .now ? .red : .primary)
      }
      .treasuryCard()

      textBlock("Thesis summary", proposal.thesisSummary, "doc.text.magnifyingglass")
      listBlock("Entry reasoning", proposal.entryReasoning, "arrow.right.circle")
      textBlock("Exit plan", proposal.exitPlan, "rectangle.portrait.and.arrow.right")
      textBlock("Invalidating condition", proposal.invalidatingCondition, "xmark.octagon")

      VStack(alignment: .leading, spacing: 12) {
        Text("Risk and allocation").font(.headline)
        LabeledValueRow(label: "Expected holding period", value: proposal.expectedHoldingPeriod)
        LabeledValueRow(
          label: "Risk amount", value: currency(proposal.riskAmount))
        if let loss = proposal.maximumLoss {
          LabeledValueRow(
            label: "Maximum calculable loss", value: currency(loss),
            valueColor: .red)
        }
        LabeledValueRow(
          label: "Allocation after execution",
          value: percent(proposal.allocationAfter))
        LabeledValueRow(label: "Subscription entitlement", value: proposal.entitlement)
        LabeledValueRow(label: "Brokerage permission", value: proposal.brokeragePermission)
      }
      .treasuryCard()

      if !proposal.knownCatalysts.isEmpty {
        listBlock("Known verified catalysts", proposal.knownCatalysts, "calendar.badge.clock")
      }
      if !proposal.warnings.isEmpty {
        listBlock("Warnings", proposal.warnings, "exclamationmark.triangle", color: .orange)
      }
      riskChecks(proposal)
      textBlock("Broker review", proposal.brokerReview, "checkmark.seal")

      if proposal.state == .awaitingUserApproval {
        VStack(spacing: 10) {
          Button("Approve and Submit", systemImage: "checkmark.shield") {
            Task { await session.approveProposal(proposal.id) }
          }
          .buttonStyle(.borderedProminent).controlSize(.large).frame(maxWidth: .infinity)
          .disabled(!proposal.isApprovable || session.preferences.privacyMode)
          .accessibilityHint(
            session.mode == .demo
              ? "Requires device authentication; this Demo action cannot reach a broker"
              : "Requires device authentication and fresh authoritative account and risk checks")
          if session.mode == .demo {
            Button("Adjust Within Limits", systemImage: "slider.horizontal.3") {
              showingAdjustment = true
            }
            .buttonStyle(.bordered).controlSize(.large).frame(maxWidth: .infinity)
          }
          Button("Reject", role: .destructive) { showingRejectConfirmation = true }
            .buttonStyle(.bordered).controlSize(.large).frame(maxWidth: .infinity)
          if let position = session.positions.first(where: { $0.symbol == proposal.symbol }) {
            NavigationLink("View Underlying") { PositionDetailView(positionID: position.id) }
          }
          if let agent = session.agents.first(where: { $0.id == proposal.agentID }) {
            Button("Pause Agent") { Task { await session.toggleAgent(agent.id) } }
          }
          DisclosureNotice(
            title: session.preferences.privacyMode
              ? "Reveal values before approval" : "No swipe approval",
            message:
              session.preferences.privacyMode
              ? "Approval remains disabled while privacy mode hides the proposal’s financial values."
              : "Final approval is available only here after complete review and device authentication.",
            symbol: session.preferences.privacyMode ? "eye.slash" : "hand.tap")
        }
      } else {
        StatusBadge(
          title: proposal.state.title,
          symbol: proposal.state == .filled ? "checkmark.circle.fill" : "xmark.circle",
          color: proposal.state == .filled ? .green : .secondary
        )
        .frame(maxWidth: .infinity)
      }
    }
  }

  private func riskChecks(_ proposal: TradeProposal) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Deterministic risk checks").font(.headline)
      ForEach(proposal.riskChecks) { check in
        HStack(alignment: .top, spacing: 10) {
          Image(
            systemName: check.outcome == .passed
              ? "checkmark.circle.fill"
              : check.outcome == .warning ? "exclamationmark.triangle.fill" : "xmark.octagon.fill"
          )
          .foregroundStyle(
            check.outcome == .passed ? .green : check.outcome == .warning ? .orange : .red)
          VStack(alignment: .leading, spacing: 3) {
            Text(check.title).font(.subheadline.weight(.semibold))
            Text(check.explanation).font(.caption).foregroundStyle(.secondary)
          }
          Spacer()
        }
      }
    }
    .treasuryCard()
  }

  private func orderDetail(_ order: OrderDetail) -> some View {
    VStack(spacing: 18) {
      VStack(alignment: .leading, spacing: 12) {
        Text("Order").font(.headline)
        LabeledValueRow(label: "Proposal", value: order.proposalID)
        LabeledValueRow(label: "Broker order ID", value: order.brokerOrderID ?? "Not assigned")
        LabeledValueRow(label: "Action", value: "\(order.side) · \(order.instrumentType)")
        LabeledValueRow(label: "Order", value: "\(order.orderType) · \(order.timeInForce)")
        if let limitPrice = order.limitPrice {
          LabeledValueRow(label: "Limit price", value: currency(limitPrice))
        }
        if let submittedAt = order.submittedAt {
          LabeledValueRow(label: "Submitted", value: FinancialFormatters.timestamp(submittedAt))
        } else {
          LabeledValueRow(label: "Submitted", value: "Not submitted")
        }
        if let terminalAt = order.terminalAt {
          LabeledValueRow(label: "Terminal at", value: FinancialFormatters.timestamp(terminalAt))
        }
        LabeledValueRow(label: "Current status", value: order.status.title)
        if let price = order.averageFillPrice {
          LabeledValueRow(label: "Average fill price", value: currency(price))
        }
        LabeledValueRow(
          label: "Remaining quantity", value: quantity(order.remainingQuantity))
        if let reason = order.statusReason {
          LabeledValueRow(label: "Reason", value: reason, valueColor: .orange)
        }
        LabeledValueRow(label: "Reconciliation", value: order.reconciliationStatus)
      }
      .treasuryCard()
      VStack(alignment: .leading, spacing: 12) {
        Text("Fills").font(.headline)
        if order.fills.isEmpty { Text("No fills recorded.").foregroundStyle(.secondary) }
        ForEach(order.fills) { fill in
          LabeledValueRow(
            label: FinancialFormatters.timestamp(fill.timestamp),
            value: "\(quantity(fill.quantity)) @ \(currency(fill.price))"
          )
        }
      }
      .treasuryCard()
      auditTimeline(order.auditTimeline)
      if order.isCancelable {
        Button("Cancel Remaining Order", systemImage: "xmark.octagon", role: .destructive) {
          showingOrderCancelConfirmation = true
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
        .frame(maxWidth: .infinity)
        .disabled(session.orderCancellationsInFlight.contains(eventID))
        .accessibilityHint(
          "Requires device authentication. Filled quantity cannot be canceled, and cancellation is not final until confirmed."
        )
      }
    }
  }

  private func runDetail(_ run: AgentRunDetail) -> some View {
    VStack(spacing: 18) {
      VStack(alignment: .leading, spacing: 12) {
        Text("Run summary").font(.headline)
        LabeledValueRow(label: "Started", value: FinancialFormatters.timestamp(run.startedAt))
        LabeledValueRow(label: "Ended", value: FinancialFormatters.timestamp(run.endedAt))
        LabeledValueRow(label: "Symbols evaluated", value: String(run.symbolsEvaluated))
        LabeledValueRow(label: "Candidates rejected", value: String(run.candidatesRejected))
        LabeledValueRow(label: "Outcome", value: run.outcome)
        LabeledValueRow(label: "Strategy version", value: run.strategyVersion)
        if let reason = run.noTradeReason {
          LabeledValueRow(label: "No-trade reason", value: reason)
        }
      }
      .treasuryCard()
      listBlock("Data sources used", run.dataSources, "externaldrive")
      listBlock("Risk filters applied", run.riskFilters, "shield")
      if run.errors.isEmpty {
        DisclosureNotice(
          title: "No run errors",
          message:
            "The structured audit record contains no error for this \(session.mode.title) run.",
          symbol: "checkmark.circle", color: .green
        ).treasuryCard()
      } else {
        listBlock("Errors", run.errors, "exclamationmark.triangle", color: .red)
      }
      DisclosureNotice(
        title: "Structured rationale only",
        message:
          "This audit shows verifiable inputs and outcomes, not hidden model chain-of-thought.",
        symbol: "lock.doc"
      )
      .treasuryCard()
    }
  }

  private func riskDetail(_ risk: RiskEventDetail) -> some View {
    VStack(spacing: 18) {
      VStack(alignment: .leading, spacing: 12) {
        Text("Risk event").font(.headline)
        LabeledValueRow(label: "Rule", value: risk.rule)
        LabeledValueRow(label: "Observed", value: risk.observedValue)
        LabeledValueRow(label: "Threshold", value: risk.threshold)
        LabeledValueRow(label: "Response", value: risk.response)
        LabeledValueRow(
          label: "Resolved", value: risk.resolvedAt.map(FinancialFormatters.timestamp) ?? "Open")
      }
      .treasuryCard()
      DisclosureNotice(
        title: "Fail-closed response",
        message:
          "New entries stop when a critical risk check fails. Monitoring and reconciliation continue, and positions remain visible.",
        symbol: "shield.lefthalf.filled", color: .orange
      )
      .treasuryCard()
    }
  }

  private func generalDetail(_ event: ActivityEvent) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Audit record").font(.headline)
      Text(session.preferences.privacyMode ? "Activity details hidden" : event.summary)
      LabeledValueRow(label: "Event ID", value: event.id)
      LabeledValueRow(label: "Mode", value: event.mode.title)
      DisclosureNotice(
        title: "Complete \(session.mode.title) record",
        message:
          session.mode == .demo
          ? "This event is immutable within the seeded Demo timeline."
          : "This event is displayed from the authoritative \(session.mode.title) audit timeline."
      )
    }
    .treasuryCard()
  }

  private var privacyPlaceholder: String { "••••••" }

  private func currency(_ value: Double) -> String {
    FinancialFormatters.currency(value, hide: session.preferences.privacyMode)
  }

  private func quantity(_ value: Double) -> String {
    session.preferences.privacyMode
      ? privacyPlaceholder : FinancialFormatters.quantity(value)
  }

  private func percent(_ value: Double) -> String {
    session.preferences.privacyMode
      ? privacyPlaceholder : FinancialFormatters.percent(value)
  }

  private func textBlock(_ title: String, _ text: String, _ symbol: String) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Label(title, systemImage: symbol).font(.headline)
      Text(text).font(.subheadline).foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, alignment: .leading).treasuryCard()
  }

  private func listBlock(
    _ title: String, _ items: [String], _ symbol: String, color: Color = .primary
  ) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Label(title, systemImage: symbol).font(.headline).foregroundStyle(color)
      ForEach(items, id: \.self) {
        Label($0, systemImage: "circle.fill").font(.subheadline).foregroundStyle(.secondary)
          .symbolRenderingMode(.hierarchical)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading).treasuryCard()
  }

  private func auditTimeline(_ items: [String]) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Audit timeline").font(.headline)
      ForEach(Array(items.enumerated()), id: \.offset) { index, item in
        HStack(alignment: .top, spacing: 10) {
          Image(systemName: index == items.count - 1 ? "checkmark.circle.fill" : "circle.fill")
            .foregroundStyle(index == items.count - 1 ? .green : .secondary)
          Text(item).font(.subheadline)
        }
      }
    }
    .treasuryCard()
  }
}

private struct ProposalAdjustmentSheet: View {
  @Environment(AppSession.self) private var session
  @Environment(\.dismiss) private var dismiss
  let proposal: TradeProposal
  @State private var quantity: Double

  init(proposal: TradeProposal) {
    self.proposal = proposal
    _quantity = State(initialValue: proposal.quantity)
  }

  var body: some View {
    NavigationStack {
      Form {
        Section("Permitted revision") {
          VStack(alignment: .leading, spacing: 8) {
            LabeledContent("Quantity", value: FinancialFormatters.quantity(quantity))
            Slider(value: $quantity, in: 0.25...max(proposal.quantity * 1.5, 0.5), step: 0.25)
          }
          LabeledContent(
            "Estimated notional",
            value: FinancialFormatters.currency(
              quantity * proposal.estimatedNotional / max(proposal.quantity, 0.0001)))
          LabeledContent(
            "Current order limit",
            value: FinancialFormatters.currency(session.riskPolicy.maximumOrderAmount))
        }
        Section {
          Text(
            "Adjusting never edits an approved order. It requests a fresh proposal, quote check, account snapshot, deterministic risk review, and approval expiration."
          )
        }
        Section {
          Button("Request Revised Demo Proposal") {
            session.recordDemoProposalAdjustment(proposalID: proposal.id, quantity: quantity)
            dismiss()
          }
          .frame(maxWidth: .infinity)
        }
      }
      .navigationTitle("Adjust Proposal")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
    }
    .presentationDetents([.medium, .large])
  }
}
