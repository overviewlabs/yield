import Foundation
import UIKit
import UserNotifications

@MainActor
final class NotificationAuthorizationService {
  static let shared = NotificationAuthorizationService()

  private(set) var remoteToken: String?
  private var registrationHandler: ((String) -> Void)?
  private var failureHandler: ((String) -> Void)?

  func installCallbacks(
    onRegistration: @escaping (String) -> Void,
    onFailure: @escaping (String) -> Void
  ) {
    registrationHandler = onRegistration
    failureHandler = onFailure
    if let remoteToken { onRegistration(remoteToken) }
  }

  func request() async -> Bool {
    do {
      let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [
        .alert, .badge, .sound,
      ])
      if granted { UIApplication.shared.registerForRemoteNotifications() }
      return granted
    } catch {
      return false
    }
  }

  func currentStatus() async -> UNAuthorizationStatus {
    await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
  }

  func refreshRemoteRegistration() async -> Bool {
    let status = await currentStatus()
    switch status {
    case .authorized, .provisional, .ephemeral:
      UIApplication.shared.registerForRemoteNotifications()
      return true
    case .notDetermined, .denied:
      return false
    @unknown default:
      return false
    }
  }

  func receive(deviceToken: Data) {
    let token = deviceToken.map { String(format: "%02x", $0) }.joined()
    guard !token.isEmpty else { return }
    remoteToken = token
    registrationHandler?(token)
  }

  func receiveRegistrationFailure(_ error: any Error) {
    failureHandler?(error.localizedDescription)
  }

  var apnsEnvironment: String {
    let configured = Bundle.main.object(forInfoDictionaryKey: "WHOXAPNSEnvironment") as? String
    return configured == "production" ? "production" : "sandbox"
  }
}
