import SwiftUI

struct RootView: View {
  @Environment(AppSession.self) private var session

  var body: some View {
    ZStack {
      Group {
        if let blocker = session.startupBlocker {
          ContentUnavailableView {
            Label("Paper runtime unavailable", systemImage: "network.slash")
          } description: {
            Text(blocker)
          } actions: {
            Button("Retry Readiness Check") { Task { await session.bootstrap() } }
              .buttonStyle(.borderedProminent)
          }
          .padding()
          .accessibilityIdentifier("runtimeUnavailableView")
        } else if session.isOnboardingComplete || session.isAppReviewPreviewActive {
          MainTabView()
        } else {
          OnboardingFlowView()
        }
      }

      if session.isPrivacyShieldVisible || session.isAppLocked {
        PrivacyShieldView(isLocked: session.isAppLocked) {
          Task { await session.unlockApp() }
        }
        .transition(.opacity)
        .zIndex(10)
      }
    }
    .animation(.easeInOut(duration: 0.18), value: session.isPrivacyShieldVisible)
    .alert(
      "Yield",
      isPresented: Binding(
        get: { session.alertMessage != nil },
        set: { if !$0 { session.alertMessage = nil } }
      )
    ) {
      Button("OK", role: .cancel) { session.alertMessage = nil }
    } message: {
      Text(session.alertMessage ?? "")
    }
  }
}
