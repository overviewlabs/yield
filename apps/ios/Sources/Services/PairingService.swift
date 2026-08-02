import AuthenticationServices
import Foundation
import Observation
import UIKit

enum PairingClientError: LocalizedError, Equatable {
  case invalidResponse
  case unauthorized
  case notFound
  case unavailable

  var errorDescription: String? {
    switch self {
    case .invalidResponse:
      "The connection service returned an unreadable response. Regenerate the setup session."
    case .unauthorized: "Your Yield session expired. Sign in again before connecting."
    case .notFound: "The pairing session is already expired or canceled. Generate a new code."
    case .unavailable:
      "The connection service is temporarily unavailable. Your brokerage account was not changed."
    }
  }
}

protocol BrokerPairingClient: Sendable {
  func createPairing() async throws -> PairingSession
  func startInAppAuthorization(pairingID: UUID) async throws -> MobileAuthorizationHandoff
  func abortInAppAuthorization(pairingID: UUID) async throws
  func status(for id: UUID) async throws -> PairingStatusSnapshot
  func cancelPairing(id: UUID) async throws
  func disconnectConnection() async throws
}

struct MobileAuthorizationHandoff: Equatable, Sendable {
  let authorizationURL: URL
  let callbackScheme: String
  let returnURL: URL
  let pairingID: UUID
  let expiresAt: Date
}

enum MobileAuthorizationResult: String, Equatable, Sendable {
  case verificationPending = "verification_pending"
  case canceled
  case failed
}

enum MobileAuthorizationError: LocalizedError, Equatable {
  case alreadyInProgress
  case invalidHandoff
  case invalidReturn
  case presentationUnavailable
  case unavailable

  var errorDescription: String? {
    switch self {
    case .alreadyInProgress:
      "A Robinhood setup window is already open. Finish or close it before trying again."
    case .invalidHandoff:
      "The connection service returned an invalid setup link. Regenerate the pairing."
    case .invalidReturn:
      "Robinhood returned an invalid completion message. No connection was accepted on this device."
    case .presentationUnavailable:
      "The secure Robinhood setup window could not be presented. Keep this pairing and use Copy or Share to open the link in another trusted browser."
    case .unavailable:
      "The secure Robinhood setup window closed unexpectedly. Keep this pairing and use Copy or Share to open the link in another trusted browser."
    }
  }
}

enum MobileAuthorizationURLPolicy {
  private static let callbackScheme = "yield"
  private static let callbackHost = "broker-connection"
  private static let callbackPath = "/callback"
  private static let prohibitedAuthorizationQueryNames: Set<String> = [
    "access_token", "authorization_code", "credential", "id_token", "password",
    "refresh_token", "secret", "token",
  ]

  static func validate(_ handoff: MobileAuthorizationHandoff, pairing: PairingSession) throws {
    guard handoff.pairingID == pairing.id,
      handoff.expiresAt > .now,
      handoff.expiresAt <= pairing.expiresAt,
      handoff.callbackScheme == callbackScheme,
      handoff.authorizationURL.absoluteString.utf8.count <= 4_096,
      handoff.authorizationURL.scheme?.lowercased() == "https",
      isRobinhoodAuthorizationHost(handoff.authorizationURL.host),
      handoff.authorizationURL.port == nil || handoff.authorizationURL.port == 443,
      handoff.authorizationURL.user == nil,
      handoff.authorizationURL.password == nil,
      handoff.authorizationURL.fragment == nil,
      isExactReturnURL(handoff.returnURL),
      !containsProhibitedAuthorizationValue(handoff.authorizationURL)
    else { throw MobileAuthorizationError.invalidHandoff }
  }

  static func result(
    from callbackURL: URL, expectedReturnURL: URL, pairingID: UUID
  ) throws -> MobileAuthorizationResult {
    guard callbackURL.absoluteString.utf8.count <= 2_048,
      isExactReturnURL(expectedReturnURL),
      callbackURL.scheme?.lowercased() == callbackScheme,
      callbackURL.host?.lowercased() == callbackHost,
      callbackURL.path == callbackPath,
      callbackURL.user == nil,
      callbackURL.password == nil,
      callbackURL.fragment == nil,
      let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
      let queryItems = components.queryItems,
      queryItems.count == 2,
      Set(queryItems.map(\.name)) == Set(["pairingId", "result"]),
      queryItems.filter({ $0.name == "pairingId" }).count == 1,
      queryItems.filter({ $0.name == "result" }).count == 1,
      let returnedPairingID = queryItems.first(where: { $0.name == "pairingId" })?.value,
      UUID(uuidString: returnedPairingID) == pairingID,
      let rawResult = queryItems.first(where: { $0.name == "result" })?.value,
      let result = MobileAuthorizationResult(rawValue: rawResult)
    else { throw MobileAuthorizationError.invalidReturn }
    return result
  }

  private static func isExactReturnURL(_ url: URL) -> Bool {
    url.scheme?.lowercased() == callbackScheme
      && url.host?.lowercased() == callbackHost
      && url.path == callbackPath
      && url.user == nil
      && url.password == nil
      && url.query == nil
      && url.fragment == nil
  }

  private static func containsProhibitedAuthorizationValue(_ url: URL) -> Bool {
    guard let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else {
      return false
    }
    return items.contains { prohibitedAuthorizationQueryNames.contains($0.name.lowercased()) }
  }

  private static func isRobinhoodAuthorizationHost(_ host: String?) -> Bool {
    guard let host = host?.lowercased() else { return false }
    return host == "robinhood.com" || host.hasSuffix(".robinhood.com")
  }
}

@MainActor
protocol BrokerAuthorizationPresenting: AnyObject {
  func authorize(
    using handoff: MobileAuthorizationHandoff, pairing: PairingSession
  ) async throws -> MobileAuthorizationResult
  func cancel()
}

@MainActor
final class ASWebAuthenticationBrokerAuthorizationPresenter: NSObject,
  BrokerAuthorizationPresenting, ASWebAuthenticationPresentationContextProviding
{
  private var authenticationSession: ASWebAuthenticationSession?
  private var continuation: CheckedContinuation<MobileAuthorizationResult, any Error>?
  private var presentationAnchor: ASPresentationAnchor?

  func authorize(
    using handoff: MobileAuthorizationHandoff, pairing: PairingSession
  ) async throws -> MobileAuthorizationResult {
    guard authenticationSession == nil, continuation == nil else {
      throw MobileAuthorizationError.alreadyInProgress
    }
    try MobileAuthorizationURLPolicy.validate(handoff, pairing: pairing)
    guard let anchor = Self.activePresentationAnchor() else {
      throw MobileAuthorizationError.presentationUnavailable
    }
    presentationAnchor = anchor

    return try await withCheckedThrowingContinuation { continuation in
      self.continuation = continuation
      let callback = ASWebAuthenticationSession.Callback.customScheme(handoff.callbackScheme)
      let session = ASWebAuthenticationSession(
        url: handoff.authorizationURL, callback: callback
      ) { [weak self] callbackURL, error in
        Task { @MainActor in
          self?.complete(
            callbackURL: callbackURL, error: error, handoff: handoff, pairing: pairing)
        }
      }
      session.presentationContextProvider = self
      // Reuse the user's system-browser Robinhood session to reduce sign-in friction. Cookies and
      // credentials remain inside AuthenticationServices and are never exposed to WHOX code.
      session.prefersEphemeralWebBrowserSession = false
      authenticationSession = session
      guard session.canStart, session.start() else {
        finish(throwing: MobileAuthorizationError.presentationUnavailable)
        return
      }
    }
  }

  func cancel() {
    guard authenticationSession != nil || continuation != nil else { return }
    let session = authenticationSession
    authenticationSession = nil
    presentationAnchor = nil
    let pending = continuation
    continuation = nil
    session?.cancel()
    pending?.resume(returning: .canceled)
  }

  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    guard let presentationAnchor else {
      preconditionFailure("Authentication presentation anchor was cleared before presentation.")
    }
    return presentationAnchor
  }

  private func complete(
    callbackURL: URL?, error: (any Error)?, handoff: MobileAuthorizationHandoff,
    pairing: PairingSession
  ) {
    guard continuation != nil else { return }
    if let webError = error as? ASWebAuthenticationSessionError,
      webError.code == .canceledLogin
    {
      finish(returning: .canceled)
      return
    }
    guard error == nil, let callbackURL else {
      finish(throwing: MobileAuthorizationError.unavailable)
      return
    }
    do {
      let result = try MobileAuthorizationURLPolicy.result(
        from: callbackURL, expectedReturnURL: handoff.returnURL, pairingID: pairing.id)
      finish(returning: result)
    } catch {
      finish(throwing: error)
    }
  }

  private func finish(returning result: MobileAuthorizationResult) {
    authenticationSession = nil
    presentationAnchor = nil
    let pending = continuation
    continuation = nil
    pending?.resume(returning: result)
  }

  private func finish(throwing error: any Error) {
    authenticationSession?.cancel()
    authenticationSession = nil
    presentationAnchor = nil
    let pending = continuation
    continuation = nil
    pending?.resume(throwing: error)
  }

  private static func activePresentationAnchor() -> ASPresentationAnchor? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
      .filter { $0.activationState == .foregroundActive }
    return scenes.lazy.compactMap { scene in
      scene.windows.first(where: \.isKeyWindow) ?? scene.windows.first(where: { !$0.isHidden })
    }.first
  }
}

@MainActor
final class DemoBrokerAuthorizationPresenter: BrokerAuthorizationPresenting {
  func authorize(
    using handoff: MobileAuthorizationHandoff, pairing: PairingSession
  ) async throws -> MobileAuthorizationResult {
    try MobileAuthorizationURLPolicy.validate(handoff, pairing: pairing)
    return .verificationPending
  }

  func cancel() {}
}

struct PairingBackoffPolicy: Equatable, Sendable {
  let baseSeconds: Double
  let maximumSeconds: Double

  static let production = PairingBackoffPolicy(baseSeconds: 1, maximumSeconds: 15)

  func delay(forAttempt attempt: Int) -> Double {
    min(baseSeconds * pow(2, Double(max(0, attempt))), maximumSeconds)
  }
}

actor DemoBrokerPairingClient: BrokerPairingClient {
  private var session: PairingSession?
  private var canceledIDs: Set<UUID> = []
  private var polls = 0
  private let connectAfterPolls: Int
  private let connectBaseURL: URL
  private var forcedConnected = false

  init(connectAfterPolls: Int = 3, connectBaseURL: URL? = nil) {
    self.connectAfterPolls = connectAfterPolls
    self.connectBaseURL =
      connectBaseURL
      ?? ProcessInfo.processInfo.environment["CONNECT_WEB_URL"].flatMap(URL.init(string:))
      ?? URL(string: "http://localhost:4173/pair")!
  }

  func createPairing() async throws -> PairingSession {
    let code = "SAFE-482K"
    let id = UUID()
    guard var components = URLComponents(url: connectBaseURL, resolvingAgainstBaseURL: false) else {
      throw PairingClientError.invalidResponse
    }
    if components.path.isEmpty || components.path == "/" { components.path = "/pair" }
    var queryItems = components.queryItems ?? []
    queryItems.removeAll { $0.name == "pairing_code" }
    queryItems.append(URLQueryItem(name: "pairing_code", value: code))
    components.queryItems = queryItems
    guard let setupURL = components.url else { throw PairingClientError.invalidResponse }
    let created = PairingSession(
      id: id,
      code: code,
      setupURL: setupURL,
      expiresAt: .now.addingTimeInterval(600)
    )
    session = created
    polls = 0
    forcedConnected = false
    return created
  }

  func startInAppAuthorization(pairingID: UUID) async throws -> MobileAuthorizationHandoff {
    guard let session, session.id == pairingID, !session.isExpired else {
      throw PairingClientError.notFound
    }
    return MobileAuthorizationHandoff(
      authorizationURL: URL(
        string: "https://agent.robinhood.com/demo/setup?pairing_id=\(pairingID.uuidString)"
      )!,
      callbackScheme: "yield",
      returnURL: URL(string: "yield://broker-connection/callback")!,
      pairingID: pairingID,
      expiresAt: session.expiresAt
    )
  }

  func abortInAppAuthorization(pairingID: UUID) async throws {
    guard let session, session.id == pairingID, !session.isExpired else {
      throw PairingClientError.notFound
    }
  }

  func status(for id: UUID) async throws -> PairingStatusSnapshot {
    guard let session, session.id == id else { throw PairingClientError.invalidResponse }
    if canceledIDs.contains(id) {
      return PairingStatusSnapshot(
        status: .canceled, connection: nil, message: "Pairing was canceled.")
    }
    guard !session.isExpired else {
      return PairingStatusSnapshot(
        status: .expired, connection: nil, message: "The pairing code expired.")
    }
    polls += 1
    if forcedConnected || polls >= connectAfterPolls {
      return PairingStatusSnapshot(
        status: .connected, connection: DemoFixtures.brokerConnection,
        message: "Demo pairing completed. No brokerage credential was created.")
    }
    return PairingStatusSnapshot(
      status: .pending, connection: nil,
      message:
        "Waiting for Robinhood completion. No broker token is ever returned to this app.")
  }

  func cancelPairing(id: UUID) async throws {
    canceledIDs.insert(id)
  }

  func disconnectConnection() async throws {
    session = nil
    forcedConnected = false
  }

  func markConnected(id: UUID) {
    guard session?.id == id else { return }
    forcedConnected = true
  }
}

/// Production boundary for the app API. `credentialProvider` supplies a short-lived WHOX app session,
/// never a Robinhood or MCP token. Pairing responses intentionally contain status and masked capabilities only.
struct HTTPBrokerPairingClient: BrokerPairingClient {
  private let baseURL: URL
  private let urlSession: URLSession
  private let stepUpProvider: any ProposalStepUpProviding
  private let credentialProvider: @Sendable () async throws -> String

  init(
    baseURL: URL, urlSession: URLSession = .shared,
    stepUpProvider: any ProposalStepUpProviding = UnavailableProposalStepUpProvider(),
    credentialProvider: @escaping @Sendable () async throws -> String
  ) {
    self.baseURL = baseURL
    self.urlSession = urlSession
    self.stepUpProvider = stepUpProvider
    self.credentialProvider = credentialProvider
  }

  func createPairing() async throws -> PairingSession {
    var request = URLRequest(url: baseURL.appending(path: "v1/brokers/robinhood/pairings"))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue(UUID().uuidString, forHTTPHeaderField: "Idempotency-Key")
    try await authorize(&request)
    let (data, response) = try await urlSession.data(for: request)
    try validate(response)
    return try decoder.decode(APIPairingResponse.self, from: data).pairingSession
  }

  func startInAppAuthorization(pairingID: UUID) async throws -> MobileAuthorizationHandoff {
    var request = URLRequest(
      url: baseURL.appending(path: "v1/brokers/robinhood/mobile-oauth/start"))
    request.httpMethod = "POST"
    request.httpBody = try JSONEncoder().encode(MobileAuthorizationStartBody(pairingID: pairingID))
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue(UUID().uuidString, forHTTPHeaderField: "Idempotency-Key")
    try await authorize(&request)
    let (data, response) = try await urlSession.data(for: request)
    try validate(response)
    let decoded = try decoder.decode(MobileAuthorizationStartResponse.self, from: data)
    guard decoded.pairingID == pairingID else { throw PairingClientError.invalidResponse }
    return decoded.handoff
  }

  func abortInAppAuthorization(pairingID: UUID) async throws {
    var request = URLRequest(
      url: baseURL.appending(path: "v1/brokers/robinhood/mobile-oauth/abort"))
    request.httpMethod = "POST"
    request.httpBody = try JSONEncoder().encode(MobileAuthorizationStartBody(pairingID: pairingID))
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue(UUID().uuidString, forHTTPHeaderField: "Idempotency-Key")
    try await authorize(&request)
    let (data, response) = try await urlSession.data(for: request)
    try validate(response)
    let decoded = try decoder.decode(MobileAuthorizationAbortResponse.self, from: data)
    guard decoded.pairingID == pairingID, decoded.status == "pending" else {
      throw PairingClientError.invalidResponse
    }
  }

  func status(for id: UUID) async throws -> PairingStatusSnapshot {
    var request = URLRequest(
      url: baseURL.appending(path: "v1/brokers/robinhood/pairings/\(id.uuidString)"))
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    try await authorize(&request)
    let (data, response) = try await urlSession.data(for: request)
    try validate(response)
    return try decoder.decode(APIPairingResponse.self, from: data).statusSnapshot
  }

  func cancelPairing(id: UUID) async throws {
    var request = URLRequest(
      url: baseURL.appending(path: "v1/brokers/robinhood/pairings/\(id.uuidString)"))
    request.httpMethod = "DELETE"
    request.setValue(UUID().uuidString, forHTTPHeaderField: "Idempotency-Key")
    try await authorize(&request)
    let (_, response) = try await urlSession.data(for: request)
    try validate(response)
  }

  func disconnectConnection() async throws {
    let authorization = try await stepUpProvider.authorization(
      for: .disconnectBrokerConnection, resourceID: "robinhood_mcp")
    var request = URLRequest(
      url: baseURL.appending(path: "v1/brokers/robinhood/connection"))
    request.httpMethod = "DELETE"
    request.httpBody = try JSONEncoder().encode(DisconnectBody(authorization: authorization))
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue(UUID().uuidString, forHTTPHeaderField: "Idempotency-Key")
    try await authorize(&request)
    let (data, response) = try await urlSession.data(for: request)
    try validate(response)
    let result = try decoder.decode(DisconnectResponse.self, from: data)
    guard result.status == "disconnected", result.tokensRevoked else {
      throw PairingClientError.invalidResponse
    }
  }

  private var decoder: JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return decoder
  }

  private func authorize(_ request: inout URLRequest) async throws {
    let appAccessToken = try await credentialProvider()
    request.setValue("Bearer \(appAccessToken)", forHTTPHeaderField: "Authorization")
  }

  private func validate(_ response: URLResponse) throws {
    guard let http = response as? HTTPURLResponse else { throw PairingClientError.invalidResponse }
    if http.statusCode == 401 { throw PairingClientError.unauthorized }
    if http.statusCode == 404 { throw PairingClientError.notFound }
    guard (200..<300).contains(http.statusCode) else { throw PairingClientError.unavailable }
  }

  private struct APIPairingResponse: Decodable {
    let pairingID: UUID
    let code: String
    let setupURL: URL
    let expiresAt: Date
    let status: APIStatus
    let connection: APIBrokerConnection?

    enum CodingKeys: String, CodingKey {
      case pairingID = "pairingId"
      case code
      case setupURL = "setupUrl"
      case expiresAt
      case status
      case connection
    }

    var pairingSession: PairingSession {
      PairingSession(id: pairingID, code: code, setupURL: setupURL, expiresAt: expiresAt)
    }

    var statusSnapshot: PairingStatusSnapshot {
      PairingStatusSnapshot(
        status: status.lifecycleStatus,
        connection: connection?.domainModel,
        message: status.userMessage
      )
    }
  }

  private enum APIStatus: String, Decodable {
    case pending
    case authorizing
    case connected
    case expired
    case canceled
    case error

    var lifecycleStatus: PairingLifecycleStatus {
      switch self {
      case .pending: .pending
      case .authorizing: .authorizing
      case .connected: .connected
      case .expired: .expired
      case .canceled: .canceled
      case .error: .failed
      }
    }

    var userMessage: String {
      switch self {
      case .pending: "Waiting for Robinhood completion."
      case .authorizing: "Robinhood authorization is in progress."
      case .connected: "Robinhood Agentic Account connection completed."
      case .expired: "The pairing code expired."
      case .canceled: "Pairing was canceled."
      case .error: "Pairing failed safely. No brokerage credential was returned to this device."
      }
    }
  }

  private struct APIBrokerConnection: Decodable {
    let status: APIConnectionStatus
    let maskedAccountIdentifier: String?
    let accountType: String?
    let lastSuccessfulSync: Date?
    let capabilities: [String]
    let equityTradingAvailable: Bool
    let optionsTradingAvailable: Bool

    var domainModel: BrokerConnection {
      BrokerConnection(
        status: status.domainStatus,
        maskedAccount: maskedAccountIdentifier,
        accountType: accountType ?? "Robinhood Agentic Account",
        capabilities: capabilities,
        optionsPermission: optionsTradingAvailable
          ? "Options trading available" : "Options restricted",
        lastSync: lastSuccessfulSync
      )
    }
  }

  private enum APIConnectionStatus: String, Decodable {
    case disconnected
    case pending
    case connected
    case expired
    case error

    var domainStatus: ConnectionStatus {
      switch self {
      case .disconnected: .disconnected
      case .pending: .pairing
      case .connected: .connected
      case .expired: .expired
      case .error: .error
      }
    }
  }

  private struct DisconnectResponse: Decodable {
    let status: String
    let tokensRevoked: Bool
  }

  private struct MobileAuthorizationStartBody: Encodable {
    let pairingID: UUID

    enum CodingKeys: String, CodingKey {
      case pairingID = "pairingId"
    }
  }

  private struct MobileAuthorizationStartResponse: Decodable {
    let authorizationURL: URL
    let callbackScheme: String
    let returnURL: URL
    let pairingID: UUID
    let expiresAt: Date

    enum CodingKeys: String, CodingKey {
      case authorizationURL = "authorizationUrl"
      case callbackScheme
      case returnURL = "returnUrl"
      case pairingID = "pairingId"
      case expiresAt
    }

    var handoff: MobileAuthorizationHandoff {
      MobileAuthorizationHandoff(
        authorizationURL: authorizationURL, callbackScheme: callbackScheme, returnURL: returnURL,
        pairingID: pairingID, expiresAt: expiresAt)
    }
  }

  private struct MobileAuthorizationAbortResponse: Decodable {
    let pairingID: UUID
    let status: String

    enum CodingKeys: String, CodingKey {
      case pairingID = "pairingId"
      case status
    }
  }

  private struct DisconnectBody: Encodable {
    let deviceID: String
    let stepUpProof: [String: String]

    init(authorization: ProposalApprovalAuthorization) {
      deviceID = authorization.deviceID
      stepUpProof = authorization.proof
    }

    enum CodingKeys: String, CodingKey {
      case deviceID = "deviceId"
      case stepUpProof
    }
  }
}

@MainActor
@Observable
final class PairingService {
  private(set) var session: PairingSession?
  /// Short-lived, PKCE-bound Robinhood destination returned by the WHOX server.
  /// It contains no broker token or authorization code and may be reopened or
  /// moved to another trusted browser while the authorization remains valid.
  private(set) var browserAuthorizationURL: URL?
  private(set) var browserAuthorizationExpiresAt: Date?
  private(set) var lifecycleStatus: PairingLifecycleStatus?
  private(set) var connectedConnection: BrokerConnection?
  private(set) var isPolling = false
  private(set) var isAuthorizingInApp = false
  private(set) var statusMessage =
    "Start securely in the app. You can reopen, copy, share, or scan the same short-lived authorization if needed."
  private(set) var lastScheduledDelay: Double?
  private(set) var pollAttempt = 0
  @ObservationIgnored private let client: any BrokerPairingClient
  @ObservationIgnored private let authorizationPresenter: any BrokerAuthorizationPresenting
  @ObservationIgnored private let backoff: PairingBackoffPolicy
  @ObservationIgnored private var pollTask: Task<Void, Never>?
  @ObservationIgnored private var authorizationAttemptID: UUID?

  init(
    client: any BrokerPairingClient = DemoBrokerPairingClient(),
    authorizationPresenter: any BrokerAuthorizationPresenting = DemoBrokerAuthorizationPresenter(),
    backoff: PairingBackoffPolicy = .production
  ) {
    self.client = client
    self.authorizationPresenter = authorizationPresenter
    self.backoff = backoff
  }

  func generate() async {
    guard await cancelCurrent(notifyServer: true) else { return }
    do {
      let created = try await client.createPairing()
      session = created
      browserAuthorizationURL = nil
      browserAuthorizationExpiresAt = nil
      lifecycleStatus = .pending
      connectedConnection = nil
      statusMessage =
        "Setup is ready. Continue in Robinhood’s secure sign-in browser."
      startPolling()
    } catch {
      lifecycleStatus = .failed
      statusMessage =
        (error as? LocalizedError)?.errorDescription ?? "Pairing could not be started."
    }
  }

  func regenerate() async {
    await generate()
  }

  func connectInApp() async {
    guard !isAuthorizingInApp else { return }
    if lifecycleStatus == .connected {
      statusMessage =
        "Disconnect the current Robinhood authorization before starting a replacement connection."
      return
    }
    if session == nil || lifecycleStatus?.isTerminal == true {
      await generate()
      guard lifecycleStatus == .pending else { return }
    }
    guard let pairing = session else { return }
    guard pairing.expiresAt > .now else {
      finish(status: .expired, message: "The pairing code expired. Generate a new single-use code.")
      return
    }

    let attemptID = UUID()
    authorizationAttemptID = attemptID
    isAuthorizingInApp = true
    lifecycleStatus = .authorizing
    statusMessage =
      "Opening Robinhood in Apple’s secure authentication browser. WHOX never receives your Robinhood password."
    do {
      let handoff = try await client.startInAppAuthorization(pairingID: pairing.id)
      guard authorizationAttemptID == attemptID else { return }
      try MobileAuthorizationURLPolicy.validate(handoff, pairing: pairing)
      browserAuthorizationURL = handoff.authorizationURL
      browserAuthorizationExpiresAt = handoff.expiresAt
      let result = try await authorizationPresenter.authorize(using: handoff, pairing: pairing)
      guard authorizationAttemptID == attemptID else { return }
      authorizationAttemptID = nil
      isAuthorizingInApp = false
      switch result {
      case .verificationPending:
        lifecycleStatus = .authorizing
        statusMessage =
          "Robinhood returned to Treasury. Verifying the connection with the WHOX server."
        await pollNow()
      case .canceled:
        lifecycleStatus = .authorizing
        statusMessage =
          "The secure browser was closed. The same short-lived Robinhood authorization remains active; reopen it or use Copy, Share, or QR in another trusted browser."
      case .failed:
        await replacePairingAfterMobileFailure(
          "Robinhood could not complete browser setup. A fresh pairing is ready for another attempt."
        )
        return
      }
    } catch {
      guard authorizationAttemptID == attemptID else { return }
      authorizationAttemptID = nil
      isAuthorizingInApp = false
      authorizationPresenter.cancel()
      let message =
        ((error as? LocalizedError)?.errorDescription
          ?? "Browser setup is temporarily unavailable.")
      if browserAuthorizationURL != nil {
        lifecycleStatus = .authorizing
        statusMessage =
          message
          + " The same short-lived Robinhood authorization remains available below for browser retry."
      } else {
        _ = await restorePendingPairing(
          pairing, message: message + " This pairing remains available for browser retry.")
      }
    }
  }

  func pollNow() async {
    guard let session else { return }
    guard session.expiresAt > .now else {
      finish(status: .expired, message: "The pairing code expired. Generate a new single-use code.")
      return
    }
    do {
      let snapshot = try await client.status(for: session.id)
      connectedConnection = snapshot.connection
      let preservesBrowserRetry =
        snapshot.status == .pending && browserAuthorizationURL != nil
      if !preservesBrowserRetry {
        lifecycleStatus = snapshot.status
        statusMessage = snapshot.message ?? statusText(for: snapshot.status)
      }
      if snapshot.status.isTerminal {
        let shouldReplaceFailedMobileAttempt =
          snapshot.status == .failed && authorizationAttemptID != nil
        authorizationAttemptID = nil
        isAuthorizingInApp = false
        authorizationPresenter.cancel()
        pollTask?.cancel()
        pollTask = nil
        isPolling = false
        browserAuthorizationURL = nil
        browserAuthorizationExpiresAt = nil
        if shouldReplaceFailedMobileAttempt {
          await replacePairingAfterMobileFailure(
            "Robinhood could not complete browser setup. A fresh pairing is ready for another attempt."
          )
        }
      }
    } catch {
      statusMessage =
        (error as? LocalizedError)?.errorDescription
        ?? "Connection status could not be refreshed. Retrying safely."
    }
  }

  func cancel() async {
    guard await cancelCurrent(notifyServer: true) else { return }
    lifecycleStatus = .canceled
    statusMessage = "Pairing session canceled. No brokerage connection changed."
  }

  func completeDemo() async {
    guard let id = session?.id, let demo = client as? DemoBrokerPairingClient else { return }
    await demo.markConnected(id: id)
    await pollNow()
  }

  func disconnect() async throws {
    try await client.disconnectConnection()
    authorizationAttemptID = nil
    isAuthorizingInApp = false
    authorizationPresenter.cancel()
    pollTask?.cancel()
    pollTask = nil
    isPolling = false
    session = nil
    browserAuthorizationURL = nil
    browserAuthorizationExpiresAt = nil
    connectedConnection = nil
    lifecycleStatus = nil
    statusMessage = "Disconnected. Existing broker positions were not changed."
  }

  func prepareReconnect() async throws {
    try await disconnect()
  }

  func clearAfterAccountDeletion() {
    authorizationAttemptID = nil
    isAuthorizingInApp = false
    authorizationPresenter.cancel()
    pollTask?.cancel()
    pollTask = nil
    isPolling = false
    session = nil
    browserAuthorizationURL = nil
    browserAuthorizationExpiresAt = nil
    connectedConnection = nil
    lifecycleStatus = .canceled
    statusMessage = "Account deleted. No pairing session remains on this device."
  }

  private func startPolling() {
    pollTask?.cancel()
    pollAttempt = 0
    isPolling = true
    pollTask = Task { [weak self] in
      while let self, !Task.isCancelled {
        await self.pollNow()
        guard self.isPolling else { return }
        let delay = self.backoff.delay(forAttempt: self.pollAttempt)
        self.lastScheduledDelay = delay
        self.pollAttempt += 1
        do {
          try await Task.sleep(for: .seconds(delay))
        } catch {
          return
        }
      }
    }
  }

  @discardableResult
  private func cancelCurrent(notifyServer: Bool) async -> Bool {
    authorizationAttemptID = nil
    isAuthorizingInApp = false
    authorizationPresenter.cancel()
    pollTask?.cancel()
    pollTask = nil
    isPolling = false
    if notifyServer, let id = session?.id {
      do {
        try await client.cancelPairing(id: id)
      } catch PairingClientError.notFound {
        // A missing server pairing is already terminal, so clearing local state is safe.
      } catch {
        statusMessage =
          (error as? LocalizedError)?.errorDescription
          ?? "Pairing cancellation could not be confirmed. The code remains visible while status is retried."
        startPolling()
        return false
      }
    }
    session = nil
    browserAuthorizationURL = nil
    browserAuthorizationExpiresAt = nil
    return true
  }

  private func finish(status: PairingLifecycleStatus, message: String) {
    authorizationAttemptID = nil
    isAuthorizingInApp = false
    authorizationPresenter.cancel()
    pollTask?.cancel()
    pollTask = nil
    isPolling = false
    lifecycleStatus = status
    browserAuthorizationURL = nil
    browserAuthorizationExpiresAt = nil
    statusMessage = message
  }

  private func restorePendingPairing(_ pairing: PairingSession, message: String) async -> Bool {
    do {
      try await client.abortInAppAuthorization(pairingID: pairing.id)
      guard session?.id == pairing.id else { return false }
      lifecycleStatus = .pending
      browserAuthorizationURL = nil
      browserAuthorizationExpiresAt = nil
      statusMessage = message
      return true
    } catch {
      await replacePairingAfterMobileFailure(
        "The browser attempt could not be reset safely. Treasury canceled it and created a fresh pairing."
      )
      return false
    }
  }

  private func replacePairingAfterMobileFailure(_ message: String) async {
    await generate()
    if session != nil, lifecycleStatus == .pending { statusMessage = message }
  }

  private func statusText(for status: PairingLifecycleStatus) -> String {
    switch status {
    case .pending: "Waiting for Robinhood completion."
    case .authorizing: "Robinhood authorization is in progress."
    case .connected: "Connection completed."
    case .expired: "The pairing code expired."
    case .canceled: "Pairing was canceled."
    case .failed: "Pairing failed safely. No brokerage connection changed."
    }
  }
}
