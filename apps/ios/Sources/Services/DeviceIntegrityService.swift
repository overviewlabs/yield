import CryptoKit
import DeviceCheck
import Foundation

enum DeviceIntegrityMethod: String, Sendable {
  case appAttest
  case deviceCheck
  case unavailable
}

struct DeviceIntegrityEvidence: Sendable {
  let method: DeviceIntegrityMethod
  let keyID: String?
  let evidence: Data
}

enum DeviceIntegrityError: LocalizedError {
  case unavailable
  case challengeMissing
  case generationFailed

  var errorDescription: String? {
    switch self {
    case .unavailable: "Device integrity verification is unavailable on this device."
    case .challengeMissing: "The integrity challenge is missing or expired."
    case .generationFailed:
      "Device integrity evidence could not be generated. Sensitive server actions remain disabled."
    }
  }
}

protocol DeviceIntegrityChallengeClient: Sendable {
  func challenge() async throws -> Data
  func register(_ evidence: DeviceIntegrityEvidence) async throws
}

/// Development boundary for Apple App Attest with a DeviceCheck fallback. Server challenges are mandatory;
/// the client never treats local support checks as proof of integrity.
struct AppleDeviceIntegrityService: Sendable {
  let challengeClient: any DeviceIntegrityChallengeClient

  func registerDevice() async throws -> DeviceIntegrityMethod {
    let challenge = try await challengeClient.challenge()
    guard !challenge.isEmpty else { throw DeviceIntegrityError.challengeMissing }
    let hash = Data(SHA256.hash(data: challenge))

    if DCAppAttestService.shared.isSupported {
      let keyID = try await generateAppAttestKey()
      let attestation = try await attest(keyID: keyID, hash: hash)
      try await challengeClient.register(
        .init(method: .appAttest, keyID: keyID, evidence: attestation))
      return .appAttest
    }

    guard DCDevice.current.isSupported else { throw DeviceIntegrityError.unavailable }
    let token = try await deviceCheckToken()
    try await challengeClient.register(.init(method: .deviceCheck, keyID: nil, evidence: token))
    return .deviceCheck
  }

  private func generateAppAttestKey() async throws -> String {
    try await withCheckedThrowingContinuation { continuation in
      DCAppAttestService.shared.generateKey { keyID, error in
        if let keyID {
          continuation.resume(returning: keyID)
        } else {
          continuation.resume(throwing: error ?? DeviceIntegrityError.generationFailed)
        }
      }
    }
  }

  private func attest(keyID: String, hash: Data) async throws -> Data {
    try await withCheckedThrowingContinuation { continuation in
      DCAppAttestService.shared.attestKey(keyID, clientDataHash: hash) { data, error in
        if let data {
          continuation.resume(returning: data)
        } else {
          continuation.resume(throwing: error ?? DeviceIntegrityError.generationFailed)
        }
      }
    }
  }

  private func deviceCheckToken() async throws -> Data {
    try await withCheckedThrowingContinuation { continuation in
      DCDevice.current.generateToken { data, error in
        if let data {
          continuation.resume(returning: data)
        } else {
          continuation.resume(throwing: error ?? DeviceIntegrityError.generationFailed)
        }
      }
    }
  }
}
