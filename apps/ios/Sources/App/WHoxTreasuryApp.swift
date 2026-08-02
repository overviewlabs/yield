import SwiftUI

@main
struct WHoxTreasuryApp: App {
  @UIApplicationDelegateAdaptor(TreasuryAppDelegate.self) private var appDelegate
  @State private var session = RuntimeAssembly.makeSession()
  @Environment(\.scenePhase) private var scenePhase

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(session)
        .tint(Color.accentColor)
        .preferredColorScheme(session.preferences.appearance.colorScheme)
        .task { await session.bootstrap() }
        .onOpenURL { session.handle(url: $0) }
        .onChange(of: scenePhase) { _, phase in
          Task { await session.handleScenePhase(active: phase == .active) }
        }
    }
  }
}

extension AppearancePreference {
  fileprivate var colorScheme: ColorScheme? {
    switch self {
    case .system: nil
    case .light: .light
    case .dark: .dark
    }
  }
}
