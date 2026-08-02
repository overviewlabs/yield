import Foundation

struct VerifiedTransactionEnvelope: Codable, Sendable {
  let productID: String
  let transactionID: String
  let originalTransactionID: String
  let signedTransactionJWS: String

  var hasCompactJWS: Bool { CompactJWS.isWellFormed(signedTransactionJWS) }
}

enum CompactJWS {
  static func isWellFormed(_ value: String) -> Bool {
    let segments = value.split(separator: ".", omittingEmptySubsequences: false)
    return segments.count == 3 && segments.allSatisfy { !$0.isEmpty }
  }
}

struct ServerEntitlementAcknowledgement: Codable, Sendable {
  let entitledProductIDs: Set<String>
  let reconciledAt: Date
}

enum EntitlementResolver {
  static func tiers(
    for productIDs: Set<String>,
    plans: [SubscriptionPlan]
  ) -> Set<PlanTier> {
    Set(plans.compactMap { productIDs.contains($0.productID) ? $0.tier : nil })
  }
}

protocol EntitlementSyncClient: Sendable {
  func sync(_ envelope: VerifiedTransactionEnvelope) async throws
    -> ServerEntitlementAcknowledgement
}

actor DemoEntitlementSyncClient: EntitlementSyncClient {
  private var acknowledged: Set<String> = []

  func sync(_ envelope: VerifiedTransactionEnvelope) async throws
    -> ServerEntitlementAcknowledgement
  {
    guard envelope.hasCompactJWS else { throw EntitlementSyncError.invalidResponse }
    acknowledged.insert(envelope.productID)
    return ServerEntitlementAcknowledgement(entitledProductIDs: acknowledged, reconciledAt: .now)
  }
}

enum EntitlementSyncError: LocalizedError {
  case invalidResponse
  case unauthorized
  case rejected

  var errorDescription: String? {
    switch self {
    case .invalidResponse: "The entitlement service returned an unreadable response."
    case .unauthorized: "Your app session expired before the purchase could be synchronized."
    case .rejected:
      "The server could not verify this App Store transaction. Agent access remains disabled."
    }
  }
}

/// Posts the App Store-signed transaction to WHOX. The server remains authoritative for agent access.
/// The credential closure supplies only a short-lived WHOX app token.
struct HTTPEntitlementSyncClient: EntitlementSyncClient {
  let baseURL: URL
  var urlSession: URLSession = .shared
  let credentialProvider: @Sendable () async throws -> String

  func sync(_ envelope: VerifiedTransactionEnvelope) async throws
    -> ServerEntitlementAcknowledgement
  {
    guard envelope.hasCompactJWS else { throw EntitlementSyncError.invalidResponse }
    var request = URLRequest(url: baseURL.appending(path: "v1/subscription/sync"))
    request.httpMethod = "POST"
    request.httpBody = try JSONEncoder().encode(envelope)
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue(UUID().uuidString, forHTTPHeaderField: "Idempotency-Key")
    request.setValue(
      "Bearer \(try await credentialProvider())", forHTTPHeaderField: "Authorization")
    let (data, response) = try await urlSession.data(for: request)
    guard let http = response as? HTTPURLResponse else {
      throw EntitlementSyncError.invalidResponse
    }
    if http.statusCode == 401 { throw EntitlementSyncError.unauthorized }
    guard (200..<300).contains(http.statusCode) else { throw EntitlementSyncError.rejected }
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return try decoder.decode(ServerEntitlementAcknowledgement.self, from: data)
  }
}
