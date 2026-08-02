import Foundation

struct RiskValidationIssue: Identifiable, Equatable, Sendable {
  let id: String
  let message: String
}

enum RiskPolicyValidator {
  static func validate(_ policy: RiskPolicy) -> [RiskValidationIssue] {
    var issues: [RiskValidationIssue] = []

    if !(1...80).contains(policy.maximumAllocationPercent) {
      issues.append(
        .init(
          id: "allocation",
          message: "Account allocation must be between 1% and the 80% platform cap."))
    }
    if policy.maximumPositionAmount <= 0 || policy.maximumPositionAmount > 25_000 {
      issues.append(
        .init(
          id: "position",
          message: "Position amount must be positive and no more than the $25,000 platform cap."))
    }
    if policy.maximumOrderAmount <= 0
      || policy.maximumOrderAmount > min(policy.maximumPositionAmount, 10_000)
    {
      issues.append(
        .init(
          id: "order",
          message:
            "Order amount must be positive, cannot exceed the position limit, and is capped at $10,000."
        ))
    }
    if policy.dailyLossLimit <= 0 || policy.dailyLossLimit > 5_000 {
      issues.append(
        .init(
          id: "loss",
          message: "Daily loss limit must be positive and no more than the $5,000 platform cap."))
    }
    if !(3...20).contains(policy.drawdownHaltPercent) {
      issues.append(
        .init(id: "drawdown", message: "Drawdown halt must be between 3% and the 20% platform cap.")
      )
    }
    if !(10...90).contains(policy.buyingPowerReservePercent) {
      issues.append(
        .init(id: "reserve", message: "Buying-power reserve must remain between 10% and 90%."))
    }
    if !(1...30).contains(policy.maximumPositions) {
      issues.append(
        .init(
          id: "positions",
          message: "Maximum simultaneous positions must be between 1 and the platform cap of 30."))
    }
    if policy.minimumDaysToExpiration < 14 {
      issues.append(
        .init(
          id: "minimum-dte",
          message: "Initial options policy requires at least 14 days to expiration."))
    }
    if policy.maximumDaysToExpiration < policy.minimumDaysToExpiration
      || policy.maximumDaysToExpiration > 365
    {
      issues.append(
        .init(
          id: "maximum-dte",
          message: "Maximum days to expiration must follow the minimum and cannot exceed 365 days.")
      )
    }
    if policy.maximumContracts < 1 || policy.maximumContracts > 10 {
      issues.append(
        .init(
          id: "contracts",
          message: "Contracts per trade must be between 1 and the platform cap of 10."))
    }
    if policy.maximumOptionsLoss <= 0
      || policy.maximumOptionsLoss > min(policy.maximumOrderAmount, 2_500)
    {
      issues.append(
        .init(
          id: "options-loss",
          message:
            "Maximum options loss must be positive, cannot exceed the order limit, and is capped at $2,500."
        ))
    }
    if !(0.5...10).contains(policy.maximumBidAskSpreadPercent) {
      issues.append(
        .init(
          id: "spread",
          message: "Maximum bid-ask spread must be between 0.5% and the platform cap of 10%."))
    }

    return issues
  }
}
