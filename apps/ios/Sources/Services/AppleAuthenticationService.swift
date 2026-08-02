import AuthenticationServices
import CryptoKit
import Foundation
import Security

struct AppleCredentialPayload: Sendable {
  let userIdentifier: String
  let identityToken: Data
  let authorizationCode: Data?
  let email: String?
  let givenName: String?
  let nonce: String
}

enum AppleAuthenticationError: LocalizedError {
  case unsupportedCredential
  case missingIdentityToken
  case missingNonce
  case nonceGenerationFailed
  case revoked

  var errorDescription: String? {
    switch self {
    case .unsupportedCredential: "Apple returned an unsupported credential. Please try again."
    case .missingIdentityToken:
      "Apple did not provide a verifiable identity token. Please try again."
    case .missingNonce: "The Sign in with Apple request could not be matched to its response."
    case .nonceGenerationFailed: "A secure Sign in with Apple request could not be created."
    case .revoked: "Sign in with Apple access was revoked. Sign in again to continue."
    }
  }
}

struct AppleAuthenticationService: Sendable {
  func prepare(_ request: ASAuthorizationAppleIDRequest) throws -> String {
    let nonce = try Self.randomNonce()
    request.nonce = Self.sha256(nonce)
    return nonce
  }

  func payload(
    from result: Result<ASAuthorization, any Error>, rawNonce: String?
  ) throws -> AppleCredentialPayload {
    guard let rawNonce, !rawNonce.isEmpty else { throw AppleAuthenticationError.missingNonce }
    let authorization = try result.get()
    guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential else {
      throw AppleAuthenticationError.unsupportedCredential
    }
    guard let identityToken = credential.identityToken else {
      throw AppleAuthenticationError.missingIdentityToken
    }
    return AppleCredentialPayload(
      userIdentifier: credential.user,
      identityToken: identityToken,
      authorizationCode: credential.authorizationCode,
      email: credential.email,
      givenName: credential.fullName?.givenName,
      nonce: rawNonce
    )
  }

  static func sha256(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  static func randomNonce(byteCount: Int = 32) throws -> String {
    var bytes = [UInt8](repeating: 0, count: byteCount)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
      throw AppleAuthenticationError.nonceGenerationFailed
    }
    return Data(bytes).base64EncodedString(options: [.endLineWithLineFeed])
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  func credentialIsAuthorized(userIdentifier: String) async -> Bool {
    await withCheckedContinuation { continuation in
      ASAuthorizationAppleIDProvider().getCredentialState(forUserID: userIdentifier) { state, _ in
        continuation.resume(returning: state == .authorized)
      }
    }
  }
}
