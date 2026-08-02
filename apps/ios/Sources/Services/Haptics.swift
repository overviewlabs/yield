import UIKit

@MainActor
enum Haptics {
  static func success(enabled: Bool) {
    guard enabled else { return }
    UINotificationFeedbackGenerator().notificationOccurred(.success)
  }

  static func warning(enabled: Bool) {
    guard enabled else { return }
    UINotificationFeedbackGenerator().notificationOccurred(.warning)
  }
}
