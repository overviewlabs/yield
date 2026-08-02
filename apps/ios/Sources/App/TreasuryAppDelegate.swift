import UIKit

final class TreasuryAppDelegate: NSObject, UIApplicationDelegate {
  func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    Task { @MainActor in
      NotificationAuthorizationService.shared.receive(deviceToken: deviceToken)
    }
  }

  func application(
    _ application: UIApplication,
    didFailToRegisterForRemoteNotificationsWithError error: any Error
  ) {
    Task { @MainActor in
      NotificationAuthorizationService.shared.receiveRegistrationFailure(error)
    }
  }
}
