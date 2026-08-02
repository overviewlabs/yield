import XCTest

@testable import Metis

final class OrderLifecycleTests: XCTestCase {
  func testWireOrderStatesExposeOnlyActuallyCancelableLifecycleStates() {
    XCTAssertTrue(
      OrderDetail(
        proposalID: "proposal", brokerOrderID: nil, submittedAt: nil, terminalAt: nil,
        side: "Buy", instrumentType: "Equity", orderType: "Limit", limitPrice: 100,
        timeInForce: "Day", status: .pending, fills: [], averageFillPrice: nil,
        remainingQuantity: 1, statusReason: nil, reconciliationStatus: "Not scheduled",
        auditTimeline: []
      ).isCancelable)
    XCTAssertTrue(
      OrderDetail(
        proposalID: "proposal", brokerOrderID: "paper-order", submittedAt: .now,
        terminalAt: nil, side: "Buy", instrumentType: "Equity", orderType: "Limit",
        limitPrice: 100, timeInForce: "Day", status: .partiallyFilled, fills: [],
        averageFillPrice: nil, remainingQuantity: 0.5, statusReason: nil,
        reconciliationStatus: "Queued", auditTimeline: []
      ).isCancelable)
    XCTAssertFalse(
      OrderDetail(
        proposalID: "proposal", brokerOrderID: "paper-order", submittedAt: .now,
        terminalAt: .now, side: "Buy", instrumentType: "Equity", orderType: "Limit",
        limitPrice: 100, timeInForce: "Day", status: .filled, fills: [], averageFillPrice: 99,
        remainingQuantity: 0, statusReason: nil, reconciliationStatus: "Reconciled",
        auditTimeline: []
      ).isCancelable)
    XCTAssertFalse(
      OrderDetail(
        proposalID: "proposal", brokerOrderID: "paper-order", submittedAt: .now,
        terminalAt: nil, side: "Buy", instrumentType: "Equity", orderType: "Limit",
        limitPrice: 100, timeInForce: "Day", status: .unknown, fills: [],
        averageFillPrice: nil, remainingQuantity: 1, statusReason: "Broker state unknown",
        reconciliationStatus: "Failed", auditTimeline: []
      ).isCancelable)
  }

  @MainActor
  func testDemoActiveOrderIsListedAndAuthoritativelyRemovedAfterCancellation() async throws {
    let suiteName = "OrderLifecycleTests.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let session = AppSession(
      repository: DemoTreasuryRepository(), defaults: defaults,
      arguments: ["tests", "-skipOnboarding", "-mockBiometricSuccess"])

    XCTAssertEqual(session.activeOrders(for: "VTI").map(\.id), ["act-open-order"])
    await session.cancelOrder("act-open-order")

    XCTAssertTrue(session.activeOrders(for: "VTI").isEmpty)
    XCTAssertEqual(
      session.activities.first(where: { $0.id == "act-open-order" })?.order?.status, .canceled)
    XCTAssertNil(session.alertMessage)
  }
}
