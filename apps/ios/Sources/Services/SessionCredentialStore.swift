import Foundation
import Security

protocol InstallIdentityProviding: Sendable {
  func deviceID() async throws -> String
}

struct StaticInstallIdentityProvider: InstallIdentityProviding {
  let value: String
  func deviceID() async throws -> String { value }
}

actor KeychainInstallIdentityProvider: InstallIdentityProviding {
  private let service = "ai.whox.treasury.install"
  private let account = "device-id"

  func deviceID() async throws -> String {
    if let existing = try KeychainValueStore.read(service: service, account: account),
      let value = String(data: existing, encoding: .utf8)
    {
      return value
    }
    let generated = UUID().uuidString.lowercased()
    try KeychainValueStore.write(Data(generated.utf8), service: service, account: account)
    return generated
  }
}

struct SessionCredentialPayload: Sendable, Equatable {
  let accessToken: String
  let accessTokenExpiresAt: Date
  let refreshToken: String
  let refreshTokenExpiresAt: Date
  let sessionID: String
  let userID: String?
  let displayName: String?
  let email: String?

  init(
    accessToken: String,
    accessTokenExpiresAt: Date,
    refreshToken: String,
    refreshTokenExpiresAt: Date,
    sessionID: String,
    userID: String? = nil,
    displayName: String? = nil,
    email: String? = nil
  ) {
    self.accessToken = accessToken
    self.accessTokenExpiresAt = accessTokenExpiresAt
    self.refreshToken = refreshToken
    self.refreshTokenExpiresAt = refreshTokenExpiresAt
    self.sessionID = sessionID
    self.userID = userID
    self.displayName = displayName
    self.email = email
  }
}

protocol SessionCredentialStoring: Sendable {
  func load() async throws -> SessionCredentialPayload?
  func store(_ payload: SessionCredentialPayload) async throws
  func clear() async throws
}

actor KeychainSessionCredentialStore: SessionCredentialStoring {
  private let service = "ai.whox.treasury.session"

  func load() async throws -> SessionCredentialPayload? {
    guard let encoded = try KeychainValueStore.read(service: service, account: "current") else {
      return nil
    }
    let stored = try JSONDecoder().decode(StoredPayload.self, from: encoded)
    return stored.payload
  }

  func store(_ payload: SessionCredentialPayload) async throws {
    let encoded = try JSONEncoder().encode(StoredPayload(payload))
    try KeychainValueStore.write(encoded, service: service, account: "current")
  }

  func clear() async throws {
    try KeychainValueStore.delete(service: service, account: "current")
  }

  private struct StoredPayload: Codable {
    let accessToken: String
    let accessTokenExpiresAt: Date
    let refreshToken: String
    let refreshTokenExpiresAt: Date
    let sessionID: String
    let userID: String?
    let displayName: String?
    let email: String?

    init(_ payload: SessionCredentialPayload) {
      accessToken = payload.accessToken
      accessTokenExpiresAt = payload.accessTokenExpiresAt
      refreshToken = payload.refreshToken
      refreshTokenExpiresAt = payload.refreshTokenExpiresAt
      sessionID = payload.sessionID
      userID = payload.userID
      displayName = payload.displayName
      email = payload.email
    }

    var payload: SessionCredentialPayload {
      SessionCredentialPayload(
        accessToken: accessToken,
        accessTokenExpiresAt: accessTokenExpiresAt,
        refreshToken: refreshToken,
        refreshTokenExpiresAt: refreshTokenExpiresAt,
        sessionID: sessionID,
        userID: userID,
        displayName: displayName,
        email: email
      )
    }
  }
}

enum KeychainStoreError: Error {
  case unexpectedStatus(OSStatus)
}

private enum KeychainValueStore {
  static func read(service: String, account: String) throws -> Data? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var result: CFTypeRef?
    let code = SecItemCopyMatching(query as CFDictionary, &result)
    if code == errSecItemNotFound { return nil }
    guard code == errSecSuccess else { throw KeychainStoreError.unexpectedStatus(code) }
    return result as? Data
  }

  static func write(_ value: Data, service: String, account: String) throws {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    let attributes: [String: Any] = [
      kSecValueData as String: value,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let updateCode = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if updateCode == errSecSuccess { return }
    guard updateCode == errSecItemNotFound else {
      throw KeychainStoreError.unexpectedStatus(updateCode)
    }
    var insert = query
    for (key, value) in attributes {
      insert[key] = value
    }
    let insertCode = SecItemAdd(insert as CFDictionary, nil)
    guard insertCode == errSecSuccess else { throw KeychainStoreError.unexpectedStatus(insertCode) }
  }

  static func delete(service: String, account: String) throws {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    let code = SecItemDelete(query as CFDictionary)
    guard code == errSecSuccess || code == errSecItemNotFound else {
      throw KeychainStoreError.unexpectedStatus(code)
    }
  }
}
