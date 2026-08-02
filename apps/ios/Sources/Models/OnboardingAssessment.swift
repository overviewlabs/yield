import Foundation

enum MinimumAgeStatus: String, CaseIterable, Codable, Identifiable, Sendable {
  case unanswered
  case meetsRequirement
  case doesNotMeetRequirement

  var id: String { rawValue }

  var title: String {
    switch self {
    case .unanswered: "Select an answer"
    case .meetsRequirement: "I meet the minimum age requirement"
    case .doesNotMeetRequirement: "I do not meet the minimum age requirement"
    }
  }
}

enum IndividualAccountStatus: String, CaseIterable, Codable, Identifiable, Sendable {
  case unanswered
  case actingForOwnAccount
  case actingForAnotherParty

  var id: String { rawValue }

  var title: String {
    switch self {
    case .unanswered: "Select an answer"
    case .actingForOwnAccount: "My own individual account"
    case .actingForAnotherParty: "Another person, entity, or account type"
    }
  }
}

enum AdviserClientClassification: String, CaseIterable, Codable, Identifiable, Sendable {
  case unanswered
  case selfDirected
  case adviserClient
  case needsReview

  var id: String { rawValue }

  var title: String {
    switch self {
    case .unanswered: "Select an answer"
    case .selfDirected: "Self-directed; no adviser-client relationship"
    case .adviserClient: "I have an adviser-client relationship"
    case .needsReview: "I need help determining this"
    }
  }
}

enum EligibilityAssessmentStatus: Equatable, Sendable {
  case incomplete
  case eligibleForDemo
  case unavailable
}

struct EligibilityAssessment: Equatable, Sendable {
  let status: EligibilityAssessmentStatus
  let messages: [String]

  var permitsDemoOnboarding: Bool { status == .eligibleForDemo }
}

enum EligibilityValidator {
  static func assess(_ draft: OnboardingDraft, gates: ReleaseGates = .locked)
    -> EligibilityAssessment
  {
    let country = normalized(draft.country)
    let state = normalized(draft.state)
    var incomplete: [String] = []
    var unavailable: [String] = []

    if country.isEmpty {
      incomplete.append("Enter your country or jurisdiction.")
    } else if !supportedUnitedStatesNames.contains(country.lowercased()) {
      unavailable.append(
        "This Demo onboarding currently supports only United States residents. Production availability has not been determined for the entered jurisdiction."
      )
    } else if state.isEmpty {
      incomplete.append("Enter your state of residence.")
    }

    switch draft.minimumAgeStatus {
    case .unanswered:
      incomplete.append("Confirm whether you meet the minimum age requirement.")
    case .doesNotMeetRequirement:
      unavailable.append("The minimum age requirement is not met.")
    case .meetsRequirement:
      break
    }

    switch draft.individualAccountStatus {
    case .unanswered:
      incomplete.append("Confirm the type of account you are acting for.")
    case .actingForAnotherParty:
      unavailable.append(
        "This build supports onboarding only for a person acting for their own account.")
    case .actingForOwnAccount:
      break
    }

    switch draft.adviserClientClassification {
    case .unanswered:
      incomplete.append("Select the adviser-client classification that applies to you.")
    case .needsReview:
      unavailable.append(
        "An adviser-client classification must be established before account onboarding can continue."
      )
    case .adviserClient where !gates.advisoryComplianceApproved:
      unavailable.append(
        "Adviser-client onboarding is unavailable while the advisory-compliance release gate is disabled."
      )
    case .selfDirected, .adviserClient:
      break
    }

    if !draft.understandsNotBroker {
      incomplete.append("Acknowledge that Metis is not a bank or broker.")
    }

    if !unavailable.isEmpty {
      return EligibilityAssessment(status: .unavailable, messages: unavailable + incomplete)
    }
    if !incomplete.isEmpty {
      return EligibilityAssessment(status: .incomplete, messages: incomplete)
    }
    return EligibilityAssessment(
      status: .eligibleForDemo,
      messages: [
        "Required Demo eligibility fields are complete. This is not a brokerage KYC, options-approval, or production legal-eligibility determination."
      ]
    )
  }

  private static let supportedUnitedStatesNames: Set<String> = [
    "united states", "united states of america", "u.s.", "u.s.a.", "us", "usa",
  ]

  private static func normalized(_ value: String) -> String {
    value.trimmingCharacters(in: .whitespacesAndNewlines)
  }
}

enum InvestorRiskClassification: String, Codable, Sendable {
  case conservative
  case moderate
  case growth
  case aggressive

  var title: String { rawValue.capitalized }
}

enum OptionsInvestorClassification: String, Codable, Sendable {
  case restricted
  case eligiblePendingBrokerPermission

  var title: String {
    switch self {
    case .restricted: "Options Restricted"
    case .eligiblePendingBrokerPermission: "Options Eligible Pending Broker Permission"
    }
  }
}

struct InvestorAssessmentResult: Equatable, Sendable {
  let riskClassification: InvestorRiskClassification
  let optionsClassification: OptionsInvestorClassification
  let score: Int
  let rationale: [String]
}

enum InvestorAssessmentEvaluator {
  static let objectives = [
    "Capital preservation", "Income", "Long-term growth", "Aggressive growth",
  ]
  static let holdingPeriods = ["Under 1 year", "1-3 years", "3-5 years", "More than 5 years"]
  static let experienceLevels = ["None", "Limited", "Some experience", "Extensive"]
  static let liquidityNeeds = ["High", "Moderate", "Low"]
  static let volatilityComfortLevels = ["Low", "Some", "High"]
  static let confirmationPreferences = [
    "Observe only", "Confirm every trade", "Automation only if separately approved",
  ]

  static func validationIssues(for draft: OnboardingDraft) -> [String] {
    var issues: [String] = []
    if !objectives.contains(draft.objective) { issues.append("Select an investment objective.") }
    if !holdingPeriods.contains(draft.holdingPeriod) {
      issues.append("Select an intended holding period.")
    }
    if !experienceLevels.contains(draft.experience) {
      issues.append("Select your overall trading experience.")
    }
    if !experienceLevels.contains(draft.stockExperience) {
      issues.append("Select your stock experience.")
    }
    if !experienceLevels.contains(draft.optionsExperience) {
      issues.append("Select your options experience.")
    }
    if !liquidityNeeds.contains(draft.liquidityNeed) {
      issues.append("Select your need for liquidity.")
    }
    if !volatilityComfortLevels.contains(draft.volatilityComfort) {
      issues.append("Select your comfort with short-term volatility.")
    }
    if !confirmationPreferences.contains(draft.confirmationPreference) {
      issues.append("Select your preference for reviewing proposals.")
    }
    if !(3...30).contains(draft.lossTolerance) {
      issues.append("Maximum acceptable drawdown must be between 3% and 30%.")
    }
    if !draft.investorProfileAcknowledged {
      issues.append("Review and confirm that the investor-profile answers are accurate.")
    }
    return issues
  }

  static func evaluate(_ draft: OnboardingDraft) -> InvestorAssessmentResult {
    var score = 0
    var rationale: [String] = []

    switch draft.objective {
    case "Capital preservation":
      score -= 3
      rationale.append("Capital preservation lowers the risk classification.")
    case "Income":
      score -= 1
      rationale.append("An income objective supports a lower-risk profile.")
    case "Long-term growth":
      score += 1
      rationale.append("A long-term growth objective supports measured growth risk.")
    case "Aggressive growth":
      score += 3
      rationale.append("An aggressive-growth objective raises the risk classification.")
    default:
      rationale.append("The investment objective is incomplete.")
    }

    switch draft.holdingPeriod {
    case "Under 1 year": score -= 3
    case "1-3 years": score -= 1
    case "3-5 years": score += 1
    case "More than 5 years": score += 2
    default: break
    }
    rationale.append("The intended holding period is \(draft.holdingPeriod.lowercased()).")

    score += experienceScore(draft.experience)
    score += experienceScore(draft.stockExperience)
    rationale.append(
      "Reported experience is \(draft.experience.lowercased()) overall and \(draft.stockExperience.lowercased()) for stocks."
    )

    switch draft.lossTolerance {
    case ...7:
      score -= 3
    case ...12:
      score -= 1
    case 25...:
      score += 3
    case 18...:
      score += 2
    default:
      score += 1
    }
    rationale.append(
      "The stated maximum acceptable drawdown is \(Int(draft.lossTolerance.rounded()))%."
    )

    if draft.dependsOnFunds {
      score -= 4
      rationale.append(
        "Dependence on invested funds for near-term expenses lowers the classification.")
    }
    switch draft.liquidityNeed {
    case "High": score -= 3
    case "Moderate": score -= 1
    case "Low": score += 1
    default: break
    }
    switch draft.volatilityComfort {
    case "Low": score -= 2
    case "High": score += 2
    default: break
    }
    rationale.append(
      "Liquidity need is \(draft.liquidityNeed.lowercased()) and short-term volatility comfort is \(draft.volatilityComfort.lowercased())."
    )

    let riskClassification: InvestorRiskClassification
    switch score {
    case ...(-3): riskClassification = .conservative
    case -2...3: riskClassification = .moderate
    case 4...8: riskClassification = .growth
    default: riskClassification = .aggressive
    }
    rationale.append(
      "The deterministic score is \(score): Conservative is -3 or lower, Moderate is -2 through 3, Growth is 4 through 8, and Aggressive is 9 or higher."
    )

    let hasOptionsExperience = draft.optionsExperience != "None"
    let optionsEligible =
      hasOptionsExperience && draft.understandsOptionsPremiumLoss && !draft.dependsOnFunds
      && draft.liquidityNeed != "High"
    let optionsClassification: OptionsInvestorClassification =
      optionsEligible ? .eligiblePendingBrokerPermission : .restricted
    rationale.append(
      optionsEligible
        ? "Options knowledge and experience are recorded, but broker permission is still required."
        : "Options remain restricted because experience, premium-loss understanding, liquidity, or near-term-funds answers do not meet the internal threshold."
    )

    return InvestorAssessmentResult(
      riskClassification: riskClassification,
      optionsClassification: optionsClassification,
      score: score,
      rationale: rationale
    )
  }

  private static func experienceScore(_ value: String) -> Int {
    switch value {
    case "None": -2
    case "Limited": -1
    case "Some experience": 1
    case "Extensive": 2
    default: 0
    }
  }
}
