import Foundation

protocol RuntimeReadinessChecking: Sendable {
  func requireReady(for mode: TreasuryMode) async throws
}

struct HTTPRuntimeReadinessChecker: RuntimeReadinessChecking {
  let baseURL: URL
  var urlSession: URLSession = .shared

  func requireReady(for mode: TreasuryMode) async throws {
    var request = URLRequest(url: baseURL.appending(path: "readyz"))
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    let (data, response) = try await urlSession.data(for: request)
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      throw RuntimeAssemblyError.backendUnavailable
    }
    let health: Health
    do {
      health = try JSONDecoder().decode(Health.self, from: data)
    } catch {
      throw RuntimeAssemblyError.backendUnavailable
    }
    guard health.status == "ready", health.mode == mode.rawValue else {
      throw RuntimeAssemblyError.backendModeMismatch
    }
    guard mode == .demo || health.persistent else {
      throw RuntimeAssemblyError.backendUnavailable
    }
    if mode == .live || health.liveTradingReachable {
      throw RuntimeAssemblyError.liveLocked
    }
  }

  private struct Health: Decodable {
    let status: String
    let mode: String
    let persistent: Bool
    let liveTradingReachable: Bool
  }
}

enum RuntimeAssemblyError: LocalizedError, Equatable {
  case configurationMissing
  case invalidBaseURL
  case liveLocked
  case backendUnavailable
  case backendModeMismatch

  var errorDescription: String? {
    switch self {
    case .configurationMissing:
      "Runtime mode is missing. Demo is not selected implicitly, and Paper remains unavailable."
    case .invalidBaseURL:
      "Paper mode requires an explicit HTTPS WHOX API base URL. No Demo values were substituted."
    case .liveLocked:
      "Live mode is disabled by the release gates and cannot be assembled by this build."
    case .backendUnavailable:
      "The Paper backend readiness check failed. Paper data and account actions remain unavailable."
    case .backendModeMismatch:
      "The backend mode does not match Paper. Data loading is blocked to prevent relabeling."
    }
  }
}

actor UnavailableTreasuryRepository: TreasuryRepository {
  func planCatalog() async throws -> PlanCatalogContext {
    throw RuntimeAssemblyError.configurationMissing
  }
  func dashboard() async throws -> DashboardSnapshot {
    throw RuntimeAssemblyError.configurationMissing
  }
  func positions() async throws -> [Position] { throw RuntimeAssemblyError.configurationMissing }
  func agents() async throws -> [InvestmentAgent] {
    throw RuntimeAssemblyError.configurationMissing
  }
  func activities() async throws -> [ActivityEvent] {
    throw RuntimeAssemblyError.configurationMissing
  }
  func riskPolicy() async throws -> RiskPolicy { throw RuntimeAssemblyError.configurationMissing }
  func activateAgent(definitionID: String, configuration: AgentConfigurationInput) async throws {
    throw RuntimeAssemblyError.configurationMissing
  }
  func updateAgent(activationID: String, configuration: AgentConfigurationInput) async throws {
    throw RuntimeAssemblyError.configurationMissing
  }
  func pauseAgent(activationID: String) async throws {
    throw RuntimeAssemblyError.configurationMissing
  }
  func resumeAgent(activationID: String) async throws {
    throw RuntimeAssemblyError.configurationMissing
  }
  func approveProposal(id: String, mode: TreasuryMode) async throws -> ActivityEvent {
    throw RuntimeAssemblyError.configurationMissing
  }
  func rejectProposal(id: String) async throws -> ActivityEvent {
    throw RuntimeAssemblyError.configurationMissing
  }
  func cancelOrder(id: String) async throws -> ActivityEvent {
    throw RuntimeAssemblyError.configurationMissing
  }
  func saveRiskPolicy(_ policy: RiskPolicy) async throws -> RiskPolicy {
    throw RuntimeAssemblyError.configurationMissing
  }
  func pauseAll() async throws { throw RuntimeAssemblyError.configurationMissing }
  func resumeAll() async throws { throw RuntimeAssemblyError.configurationMissing }
  func settings() async throws -> RemoteSettings {
    throw RuntimeAssemblyError.configurationMissing
  }
  func saveSettings(_ settings: RemoteSettings) async throws -> RemoteSettings {
    throw RuntimeAssemblyError.configurationMissing
  }
  func registerPushToken(_ token: String, environment: String) async throws {
    throw RuntimeAssemblyError.configurationMissing
  }
  func unregisterPushToken() async throws {
    throw RuntimeAssemblyError.configurationMissing
  }
  func requestAccountDeletion() async throws -> AccountDeletionDisposition {
    throw RuntimeAssemblyError.configurationMissing
  }
}

struct RuntimeConfiguration: Equatable, Sendable {
  let mode: String?
  let apiBaseURL: String?

  static func app(bundle: Bundle = .main) -> RuntimeConfiguration {
    RuntimeConfiguration(
      mode: bundle.object(forInfoDictionaryKey: "WHOXRuntimeMode") as? String,
      apiBaseURL: bundle.object(forInfoDictionaryKey: "WHOXAPIBaseURL") as? String
    )
  }
}

@MainActor
enum RuntimeAssembly {
  static func makeSession(
    configuration: RuntimeConfiguration = .app(),
    urlSession: URLSession = .shared,
    credentialStore: any SessionCredentialStoring = KeychainSessionCredentialStore(),
    stepUpProvider: any ProposalStepUpProviding = UnavailableProposalStepUpProvider(),
    arguments: [String] = ProcessInfo.processInfo.arguments
  ) -> AppSession {
    switch configuration.mode?.lowercased() {
    case "demo":
      return AppSession(runtimeMode: .demo, arguments: arguments)
    case "paper":
      guard let rawURL = configuration.apiBaseURL,
        let baseURL = URL(string: rawURL),
        baseURL.scheme?.lowercased() == "https",
        baseURL.host != nil
      else {
        return unavailableSession(error: .invalidBaseURL, arguments: arguments)
      }
      let auth = HTTPAuthClient(
        baseURL: baseURL, credentialStore: credentialStore, urlSession: urlSession)
      let token: @Sendable () async throws -> String = { try await auth.accessToken() }
      let userID: @Sendable () async throws -> String = {
        guard let value = try await credentialStore.load()?.userID, !value.isEmpty else {
          throw AuthClientError.unauthorized
        }
        return value
      }
      let repository = HTTPTreasuryRepository(
        baseURL: baseURL,
        urlSession: urlSession,
        expectedMode: .paper,
        proposalStepUpProvider: stepUpProvider,
        authenticatedUserIDProvider: userID,
        credentialProvider: token
      )
      let pairing = PairingService(
        client: HTTPBrokerPairingClient(
          baseURL: baseURL, urlSession: urlSession, stepUpProvider: stepUpProvider,
          credentialProvider: token),
        authorizationPresenter: ASWebAuthenticationBrokerAuthorizationPresenter())
      let storeKit = StoreKitService(
        entitlementSyncClient: HTTPEntitlementSyncClient(
          baseURL: baseURL, urlSession: urlSession, credentialProvider: token),
        arguments: arguments)
      return AppSession(
        runtimeMode: .paper,
        repository: repository,
        storeKit: storeKit,
        pairingService: pairing,
        authClient: auth,
        onboardingPersistence: HTTPOnboardingPersistence(
          baseURL: baseURL, urlSession: urlSession, credentialProvider: token),
        readinessChecker: HTTPRuntimeReadinessChecker(baseURL: baseURL, urlSession: urlSession),
        arguments: arguments
      )
    case "live":
      return unavailableSession(error: .liveLocked, arguments: arguments)
    default:
      return unavailableSession(error: .configurationMissing, arguments: arguments)
    }
  }

  private static func unavailableSession(
    error: RuntimeAssemblyError, arguments: [String]
  ) -> AppSession {
    AppSession(
      runtimeMode: .paper,
      repository: UnavailableTreasuryRepository(),
      startupBlocker: error.localizedDescription,
      arguments: arguments
    )
  }
}
