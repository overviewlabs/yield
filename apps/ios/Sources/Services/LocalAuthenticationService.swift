import Foundation
import LocalAuthentication

enum LocalAuthenticationFailure: LocalizedError, Equatable {
  case unavailable
  case denied

  var errorDescription: String? {
    switch self {
    case .unavailable: "Device authentication is unavailable. Set a device passcode and try again."
    case .denied: "Authentication was not completed. No sensitive action was taken."
    }
  }
}

@MainActor
final class LocalAuthenticationService {
  private let arguments: [String]

  init(arguments: [String] = ProcessInfo.processInfo.arguments) {
    self.arguments = arguments
  }

  var biometryName: String {
    let context = LAContext()
    var error: NSError?
    _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
    return switch context.biometryType {
    case .faceID: "Face ID"
    case .touchID: "Touch ID"
    default: "Device Authentication"
    }
  }

  func authenticate(reason: String) async throws {
    if arguments.contains("-mockBiometricSuccess") { return }
    if arguments.contains("-mockBiometricFailure") { throw LocalAuthenticationFailure.denied }

    let context = LAContext()
    context.localizedCancelTitle = "Cancel"
    context.localizedFallbackTitle = "Use Passcode"
    var evaluationError: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &evaluationError) else {
      throw LocalAuthenticationFailure.unavailable
    }
    do {
      let authenticated = try await context.evaluatePolicy(
        .deviceOwnerAuthentication,
        localizedReason: reason
      )
      guard authenticated else { throw LocalAuthenticationFailure.denied }
    } catch {
      throw LocalAuthenticationFailure.denied
    }
  }
}
