import Foundation

struct AuthenticatedUserSession: Codable, Sendable {
  let userID: String
  let displayName: String
  let email: String
  let accessToken: String?
  let accessTokenExpiresAt: Date?
  let sessionID: String?
}

protocol AuthClient: Sendable {
  func exchangeAppleCredential(_ payload: AppleCredentialPayload) async throws
    -> AuthenticatedUserSession
  func restoreSession() async throws -> AuthenticatedUserSession?
  func accessToken() async throws -> String
  func logout() async throws
  func revokeSession(id: String) async throws
  func revokeOtherSessions() async throws -> Int
  func clearLocalSession() async throws
}

enum AuthClientError: LocalizedError {
  case invalidCredential
  case unauthorized
  case serviceUnavailable
  case invalidResponse

  var errorDescription: String? {
    switch self {
    case .invalidCredential: "Apple sign-in could not be verified. No account was created."
    case .unauthorized: "Apple sign-in was declined by the WHOX authentication service."
    case .serviceUnavailable: "Sign-in is temporarily unavailable. Please try again."
    case .invalidResponse: "Sign-in completed, but the account response could not be verified."
    }
  }
}

actor DemoAuthClient: AuthClient {
  func exchangeAppleCredential(_ payload: AppleCredentialPayload) async throws
    -> AuthenticatedUserSession
  {
    guard !payload.identityToken.isEmpty else { throw AuthClientError.invalidCredential }
    return AuthenticatedUserSession(
      userID: "demo-apple-\(payload.userIdentifier)",
      displayName: payload.givenName ?? "Apple User",
      email: payload.email ?? "Private Apple relay email",
      accessToken: nil,
      accessTokenExpiresAt: nil,
      sessionID: "demo-session"
    )
  }

  func restoreSession() async throws -> AuthenticatedUserSession? { nil }
  func accessToken() async throws -> String { throw AuthClientError.unauthorized }
  func logout() async throws {}
  func revokeSession(id: String) async throws {}
  func revokeOtherSessions() async throws -> Int { 0 }
  func clearLocalSession() async throws {}
}

struct HTTPAuthClient: AuthClient {
  let baseURL: URL
  let installIdentityProvider: any InstallIdentityProviding
  let credentialStore: any SessionCredentialStoring
  let urlSession: URLSession
  private let sessionController: HTTPSessionController

  init(
    baseURL: URL,
    installIdentityProvider: any InstallIdentityProviding = KeychainInstallIdentityProvider(),
    credentialStore: any SessionCredentialStoring = KeychainSessionCredentialStore(),
    urlSession: URLSession = .shared
  ) {
    self.baseURL = baseURL
    self.installIdentityProvider = installIdentityProvider
    self.credentialStore = credentialStore
    self.urlSession = urlSession
    self.sessionController = HTTPSessionController(
      baseURL: baseURL, credentialStore: credentialStore, urlSession: urlSession)
  }

  func exchangeAppleCredential(_ payload: AppleCredentialPayload) async throws
    -> AuthenticatedUserSession
  {
    guard let identityToken = String(data: payload.identityToken, encoding: .utf8) else {
      throw AuthClientError.invalidCredential
    }
    let body = AppleAuthRequest(
      identityToken: identityToken,
      authorizationCode: payload.authorizationCode.flatMap { String(data: $0, encoding: .utf8) },
      deviceID: try await installIdentityProvider.deviceID(),
      nonce: payload.nonce
    )
    var request = URLRequest(url: baseURL.appending(path: "v1/auth/apple"))
    request.httpMethod = "POST"
    request.httpBody = try JSONEncoder().encode(body)
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    let (data, response) = try await urlSession.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw AuthClientError.invalidResponse }
    if http.statusCode == 401 || http.statusCode == 403 { throw AuthClientError.unauthorized }
    guard (200..<300).contains(http.statusCode) else { throw AuthClientError.serviceUnavailable }
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    let wire = try decoder.decode(AuthWireResponse.self, from: data)
    try await credentialStore.store(
      SessionCredentialPayload(
        accessToken: wire.accessToken,
        accessTokenExpiresAt: wire.accessTokenExpiresAt,
        refreshToken: wire.refreshToken,
        refreshTokenExpiresAt: wire.refreshTokenExpiresAt,
        sessionID: wire.sessionID,
        userID: wire.userID,
        displayName: wire.displayName,
        email: wire.email
      )
    )
    return AuthenticatedUserSession(
      userID: wire.userID,
      displayName: wire.displayName,
      email: wire.email,
      accessToken: wire.accessToken,
      accessTokenExpiresAt: wire.accessTokenExpiresAt,
      sessionID: wire.sessionID
    )
  }

  func restoreSession() async throws -> AuthenticatedUserSession? {
    guard let payload = try await sessionController.restore() else { return nil }
    guard let userID = payload.userID else { return nil }
    return AuthenticatedUserSession(
      userID: userID,
      displayName: payload.displayName ?? "Treasury User",
      email: payload.email ?? "",
      accessToken: payload.accessToken,
      accessTokenExpiresAt: payload.accessTokenExpiresAt,
      sessionID: payload.sessionID
    )
  }

  func accessToken() async throws -> String {
    try await sessionController.validAccessToken()
  }

  func logout() async throws {
    try await sessionController.logout()
  }

  func revokeSession(id: String) async throws {
    try await sessionController.revokeSession(id: id)
  }

  func revokeOtherSessions() async throws -> Int {
    try await sessionController.revokeOtherSessions()
  }

  func clearLocalSession() async throws {
    try await credentialStore.clear()
  }

  private struct AppleAuthRequest: Encodable {
    let identityToken: String
    let authorizationCode: String?
    let deviceID: String
    let nonce: String

    enum CodingKeys: String, CodingKey {
      case identityToken
      case authorizationCode
      case deviceID = "deviceId"
      case nonce
    }
  }

  private struct AuthWireResponse: Decodable {
    let userID: String
    let displayName: String
    let email: String
    let accessToken: String
    let accessTokenExpiresAt: Date
    let refreshToken: String
    let refreshTokenExpiresAt: Date
    let sessionID: String
  }
}

/// Serializes Keychain restoration and refresh-token rotation so concurrent API requests cannot replay the
/// same single-use refresh token. It stores only WHOX session credentials, never brokerage credentials.
actor HTTPSessionController {
  private let baseURL: URL
  private let credentialStore: any SessionCredentialStoring
  private let urlSession: URLSession
  private let refreshLeeway: TimeInterval
  private let now: @Sendable () -> Date

  init(
    baseURL: URL,
    credentialStore: any SessionCredentialStoring,
    urlSession: URLSession,
    refreshLeeway: TimeInterval = 30,
    now: @escaping @Sendable () -> Date = Date.init
  ) {
    self.baseURL = baseURL
    self.credentialStore = credentialStore
    self.urlSession = urlSession
    self.refreshLeeway = refreshLeeway
    self.now = now
  }

  func restore() async throws -> SessionCredentialPayload? {
    guard try await credentialStore.load() != nil else { return nil }
    _ = try await validAccessToken()
    return try await credentialStore.load()
  }

  func validAccessToken() async throws -> String {
    guard let stored = try await credentialStore.load() else { throw AuthClientError.unauthorized }
    if stored.accessTokenExpiresAt.timeIntervalSince(now()) > refreshLeeway {
      return stored.accessToken
    }
    guard stored.refreshTokenExpiresAt > now() else {
      try await credentialStore.clear()
      throw AuthClientError.unauthorized
    }

    var request = URLRequest(url: baseURL.appending(path: "v1/auth/refresh"))
    request.httpMethod = "POST"
    request.httpBody = try JSONEncoder().encode(
      RefreshRequest(sessionID: stored.sessionID, refreshToken: stored.refreshToken))
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    let (data, response) = try await urlSession.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw AuthClientError.invalidResponse }
    if http.statusCode == 401 || http.statusCode == 403 {
      try await credentialStore.clear()
      throw AuthClientError.unauthorized
    }
    guard (200..<300).contains(http.statusCode) else { throw AuthClientError.serviceUnavailable }
    let rotated: RefreshResponse
    do {
      let decoder = JSONDecoder()
      decoder.dateDecodingStrategy = .iso8601
      rotated = try decoder.decode(RefreshResponse.self, from: data)
    } catch {
      throw AuthClientError.invalidResponse
    }
    guard rotated.sessionID == stored.sessionID else { throw AuthClientError.invalidResponse }
    let replacement = SessionCredentialPayload(
      accessToken: rotated.accessToken,
      accessTokenExpiresAt: rotated.accessTokenExpiresAt,
      refreshToken: rotated.refreshToken,
      refreshTokenExpiresAt: rotated.refreshTokenExpiresAt,
      sessionID: rotated.sessionID,
      userID: stored.userID,
      displayName: stored.displayName,
      email: stored.email
    )
    try await credentialStore.store(replacement)
    return replacement.accessToken
  }

  func logout() async throws {
    let token: String
    do {
      token = try await validAccessToken()
    } catch AuthClientError.unauthorized {
      try await credentialStore.clear()
      return
    }
    var request = URLRequest(url: baseURL.appending(path: "v1/auth/logout"))
    request.httpMethod = "POST"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    let (_, response) = try await urlSession.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw AuthClientError.invalidResponse }
    if http.statusCode == 401 || http.statusCode == 403 {
      try await credentialStore.clear()
      return
    }
    guard (200..<300).contains(http.statusCode) else { throw AuthClientError.serviceUnavailable }
    try await credentialStore.clear()
  }

  func revokeSession(id: String) async throws {
    let token = try await validAccessToken()
    var request = URLRequest(url: baseURL.appending(path: "v1/sessions/\(id)"))
    request.httpMethod = "DELETE"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    let (_, response) = try await urlSession.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw AuthClientError.invalidResponse }
    if http.statusCode == 401 || http.statusCode == 403 { throw AuthClientError.unauthorized }
    guard (200..<300).contains(http.statusCode) else { throw AuthClientError.serviceUnavailable }
  }

  func revokeOtherSessions() async throws -> Int {
    let stored = try await credentialStore.load()
    let token = try await validAccessToken()
    var request = URLRequest(url: baseURL.appending(path: "v1/sessions"))
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    let (data, response) = try await urlSession.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw AuthClientError.invalidResponse }
    if http.statusCode == 401 || http.statusCode == 403 { throw AuthClientError.unauthorized }
    guard (200..<300).contains(http.statusCode) else { throw AuthClientError.serviceUnavailable }
    let sessions: SessionEnvelope
    do {
      let decoder = JSONDecoder()
      decoder.dateDecodingStrategy = .iso8601
      sessions = try decoder.decode(SessionEnvelope.self, from: data)
    } catch {
      throw AuthClientError.invalidResponse
    }
    let otherIDs = sessions.data.map(\.sessionID).filter { $0 != stored?.sessionID }
    for id in otherIDs { try await revokeSession(id: id) }
    return otherIDs.count
  }

  private struct RefreshRequest: Encodable {
    let sessionID: String
    let refreshToken: String

    enum CodingKeys: String, CodingKey {
      case sessionID = "sessionId"
      case refreshToken
    }
  }

  private struct RefreshResponse: Decodable {
    let accessToken: String
    let accessTokenExpiresAt: Date
    let refreshToken: String
    let refreshTokenExpiresAt: Date
    let sessionID: String

    enum CodingKeys: String, CodingKey {
      case accessToken
      case accessTokenExpiresAt = "accessExpiresAt"
      case refreshToken
      case refreshTokenExpiresAt = "refreshExpiresAt"
      case sessionID = "sessionId"
    }
  }

  private struct SessionEnvelope: Decodable {
    let data: [SessionRecord]
  }

  private struct SessionRecord: Decodable {
    let sessionID: String

    enum CodingKeys: String, CodingKey { case sessionID = "sessionId" }
  }
}
