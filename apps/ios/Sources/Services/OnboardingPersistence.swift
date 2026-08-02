import Foundation

struct AuthoritativeOnboardingProgress: Decodable, Equatable, Sendable {
  let currentStep: Int
  let completed: Bool
  let resumable: Bool
  let eligibilityStatus: String
  let riskAssessmentStatus: String
  let legalConsentsComplete: Bool
}

struct AuthoritativeEligibilityDecision: Equatable, Sendable {
  let status: String
  let messages: [String]

  var isEligible: Bool { status == "eligible" }
}

struct AuthoritativeRiskDecision: Equatable, Sendable {
  let classification: InvestorRiskClassification
  let optionsClassification: OptionsInvestorClassification
}

protocol OnboardingPersisting: Sendable {
  func currentProgress() async throws -> AuthoritativeOnboardingProgress
  func currentLegalDocuments() async throws -> [LegalDocument]
  func recordEligibility(_ draft: OnboardingDraft) async throws
    -> AuthoritativeEligibilityDecision
  func recordRiskAssessment(_ draft: OnboardingDraft) async throws -> AuthoritativeRiskDecision
  func recordLegalConsents(_ documents: [LegalDocument]) async throws -> Bool
  func persistStep(_ step: Int) async throws -> AuthoritativeOnboardingProgress
}

struct HTTPOnboardingPersistence: OnboardingPersisting {
  let baseURL: URL
  var urlSession: URLSession = .shared
  let credentialProvider: @Sendable () async throws -> String

  func currentProgress() async throws -> AuthoritativeOnboardingProgress {
    try await get("v1/onboarding")
  }

  func currentLegalDocuments() async throws -> [LegalDocument] {
    let response: LegalDocumentsResponse = try await get("v1/legal-documents")
    return try LegalDocumentCatalog.authoritativeDocuments(from: response.data)
  }

  func recordEligibility(_ draft: OnboardingDraft) async throws
    -> AuthoritativeEligibilityDecision
  {
    let response: EligibilityResponse = try await mutate(
      "v1/eligibility",
      body: EligibilityRequest(
        country: draft.country,
        state: draft.state,
        minimumAgeStatus: draft.minimumAgeStatus.rawValue,
        individualAccountStatus: draft.individualAccountStatus.rawValue,
        understandsNotBroker: draft.understandsNotBroker,
        adviserClientClassification: draft.adviserClientClassification.rawValue
      ))
    return AuthoritativeEligibilityDecision(
      status: response.status, messages: response.reasons.map(\.message))
  }

  func recordRiskAssessment(_ draft: OnboardingDraft) async throws -> AuthoritativeRiskDecision {
    let response: RiskResponse = try await mutate(
      "v1/risk-assessments",
      body: RiskRequest(
        objective: draft.objective,
        holdingPeriod: draft.holdingPeriod,
        experience: draft.experience,
        stockExperience: draft.stockExperience,
        optionsExperience: draft.optionsExperience,
        lossTolerance: draft.lossTolerance,
        dependsOnFunds: draft.dependsOnFunds,
        liquidityNeed: draft.liquidityNeed,
        volatilityComfort: draft.volatilityComfort,
        confirmationPreference: draft.confirmationPreference,
        understandsOptionsPremiumLoss: draft.understandsOptionsPremiumLoss,
        investorProfileAcknowledged: draft.investorProfileAcknowledged
      ))
    guard let classification = InvestorRiskClassification(rawValue: response.classification) else {
      throw HTTPRepositoryError.invalidResponse
    }
    let options: OptionsInvestorClassification
    switch response.optionsClassification {
    case "options_restricted": options = .restricted
    case "options_eligible_pending_broker_permission":
      options = .eligiblePendingBrokerPermission
    default: throw HTTPRepositoryError.invalidResponse
    }
    return AuthoritativeRiskDecision(
      classification: classification, optionsClassification: options)
  }

  func recordLegalConsents(_ documents: [LegalDocument]) async throws -> Bool {
    let authoritativeDocuments = try LegalDocumentCatalog.validateAuthoritative(documents)
    let versions = Dictionary(
      uniqueKeysWithValues: authoritativeDocuments.map { ($0.id, $0.version) })
    let response: LegalResponse = try await mutate(
      "v1/legal-consents", body: LegalRequest(accepted: true, documentVersions: versions))
    return response.accepted && response.allRequiredCurrentDocumentsAccepted
  }

  func persistStep(_ step: Int) async throws -> AuthoritativeOnboardingProgress {
    guard (1...14).contains(step) else { throw HTTPRepositoryError.invalidResponse }
    return try await mutate("v1/onboarding/step", method: "PATCH", body: StepRequest(step: step))
  }

  private func get<Response: Decodable>(_ path: String) async throws -> Response {
    var request = URLRequest(url: baseURL.appending(path: path))
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    return try await send(request)
  }

  private func mutate<Response: Decodable, Body: Encodable>(
    _ path: String, method: String = "POST", body: Body
  ) async throws -> Response {
    var request = URLRequest(url: baseURL.appending(path: path))
    request.httpMethod = method
    request.httpBody = try JSONEncoder.apiOnboarding.encode(body)
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue(UUID().uuidString, forHTTPHeaderField: "Idempotency-Key")
    return try await send(request)
  }

  private func send<Response: Decodable>(_ request: URLRequest) async throws -> Response {
    var authenticated = request
    authenticated.setValue(
      "Bearer \(try await credentialProvider())", forHTTPHeaderField: "Authorization")
    authenticated.setValue(UUID().uuidString, forHTTPHeaderField: "X-Correlation-ID")
    let (data, response) = try await urlSession.data(for: authenticated)
    guard let http = response as? HTTPURLResponse else { throw HTTPRepositoryError.invalidResponse }
    switch http.statusCode {
    case 200..<300: break
    case 401: throw HTTPRepositoryError.signedOut
    case 403: throw HTTPRepositoryError.forbidden
    case 404: throw HTTPRepositoryError.notFound
    case 409, 422: throw HTTPRepositoryError.conflict
    case 429: throw HTTPRepositoryError.rateLimited
    case 500...599: throw HTTPRepositoryError.unavailable
    default: throw HTTPRepositoryError.invalidResponse
    }
    do {
      return try JSONDecoder.apiOnboarding.decode(Response.self, from: data)
    } catch {
      throw HTTPRepositoryError.invalidResponse
    }
  }

  private struct EligibilityRequest: Encodable {
    let country: String
    let state: String
    let minimumAgeStatus: String
    let individualAccountStatus: String
    let understandsNotBroker: Bool
    let adviserClientClassification: String
  }

  private struct EligibilityResponse: Decodable {
    let status: String
    let reasons: [Reason]

    struct Reason: Decodable { let message: String }
  }

  private struct RiskRequest: Encodable {
    let objective: String
    let holdingPeriod: String
    let experience: String
    let stockExperience: String
    let optionsExperience: String
    let lossTolerance: Double
    let dependsOnFunds: Bool
    let liquidityNeed: String
    let volatilityComfort: String
    let confirmationPreference: String
    let understandsOptionsPremiumLoss: Bool
    let investorProfileAcknowledged: Bool
  }

  private struct RiskResponse: Decodable {
    let classification: String
    let optionsClassification: String
  }

  private struct LegalRequest: Encodable {
    let accepted: Bool
    let documentVersions: [String: String]
  }

  private struct LegalResponse: Decodable {
    let accepted: Bool
    let allRequiredCurrentDocumentsAccepted: Bool
  }

  fileprivate struct LegalDocumentsResponse: Decodable {
    let data: [LegalDocumentDTO]
  }

  fileprivate struct LegalDocumentDTO: Decodable {
    let id: String
    let title: String
    let version: String
    let productionApproved: Bool
    let required: Bool
    let contentURI: String
    let contentSHA256: String
    let publishedAt: String
  }

  private struct StepRequest: Encodable { let step: Int }
}

enum LegalDocumentCatalog {
  private static let baseRequiredIDs: Set<String> = [
    "terms", "privacy", "ai-risk", "broker", "subscription", "electronic", "performance",
    "ai-data",
  ]

  fileprivate static func authoritativeDocuments(
    from records: [HTTPOnboardingPersistence.LegalDocumentDTO], now: Date = .now
  ) throws -> [LegalDocument] {
    let documents = try records.map { record in
      guard let contentURL = safePublicationURL(record.contentURI),
        let publishedAt = publicationDate(record.publishedAt)
      else {
        throw HTTPRepositoryError.invalidResponse
      }
      return LegalDocument(
        id: record.id,
        title: record.title,
        version: record.version,
        productionApproved: record.productionApproved,
        required: record.required,
        contentURL: contentURL,
        contentSHA256: record.contentSHA256,
        publishedAt: publishedAt,
        summary:
          "Review the complete approved publication before accepting this exact version."
      )
    }
    return try validateAuthoritative(documents, now: now)
  }

  static func validateAuthoritative(
    _ documents: [LegalDocument], now: Date = .now
  ) throws -> [LegalDocument] {
    guard !documents.isEmpty, documents.count <= 32 else {
      throw HTTPRepositoryError.invalidResponse
    }
    let ids = documents.map(\.id)
    guard Set(ids).count == ids.count, baseRequiredIDs.isSubset(of: Set(ids)) else {
      throw HTTPRepositoryError.invalidResponse
    }
    for document in documents {
      guard isCanonicalIdentifier(document.id),
        isCleanNonempty(document.title, maximumLength: 200),
        isCleanNonempty(document.version, maximumLength: 100),
        document.productionApproved,
        document.required,
        let contentURL = document.contentURL,
        safePublicationURL(contentURL.absoluteString) == contentURL,
        let hash = document.contentSHA256,
        hash.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
        let publishedAt = document.publishedAt,
        publishedAt <= now.addingTimeInterval(300)
      else {
        throw HTTPRepositoryError.invalidResponse
      }
    }
    return documents
  }

  private static func isCanonicalIdentifier(_ value: String) -> Bool {
    value.range(of: "^[a-z0-9][a-z0-9-]{0,63}$", options: .regularExpression) != nil
  }

  private static func isCleanNonempty(_ value: String, maximumLength: Int) -> Bool {
    guard !value.isEmpty, value.count <= maximumLength,
      value == value.trimmingCharacters(in: .whitespacesAndNewlines)
    else { return false }
    return value.unicodeScalars.allSatisfy { !CharacterSet.controlCharacters.contains($0) }
  }

  private static func safePublicationURL(_ rawValue: String) -> URL? {
    guard rawValue == rawValue.trimmingCharacters(in: .whitespacesAndNewlines),
      !rawValue.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains),
      var components = URLComponents(string: rawValue),
      components.scheme?.lowercased() == "https",
      let host = components.host,
      !host.isEmpty,
      components.user == nil,
      components.password == nil,
      components.queryItems?.contains(where: { $0.name.isEmpty }) != true
    else { return nil }
    components.scheme = "https"
    guard let url = components.url, url.absoluteString == rawValue else { return nil }
    return url
  }

  private static func publicationDate(_ rawValue: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: rawValue) { return date }
    let wholeSeconds = ISO8601DateFormatter()
    wholeSeconds.formatOptions = [.withInternetDateTime]
    return wholeSeconds.date(from: rawValue)
  }
}

extension JSONEncoder {
  fileprivate static var apiOnboarding: JSONEncoder {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    return encoder
  }
}

extension JSONDecoder {
  fileprivate static var apiOnboarding: JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return decoder
  }
}
