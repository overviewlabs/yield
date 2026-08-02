import Foundation
import XCTest

@testable import Yield

final class PairingServiceTests: XCTestCase {
  func testExponentialBackoffCaps() {
    let policy = PairingBackoffPolicy(baseSeconds: 1, maximumSeconds: 15)
    XCTAssertEqual(policy.delay(forAttempt: 0), 1)
    XCTAssertEqual(policy.delay(forAttempt: 1), 2)
    XCTAssertEqual(policy.delay(forAttempt: 4), 15)
    XCTAssertEqual(policy.delay(forAttempt: 20), 15)
  }

  func testDemoPairingLinkMatchesLocalWebContract() async throws {
    let client = DemoBrokerPairingClient(
      connectBaseURL: URL(string: "http://localhost:4173/pair")!
    )
    let session = try await client.createPairing()
    let components = try XCTUnwrap(
      URLComponents(url: session.setupURL, resolvingAgainstBaseURL: false))
    XCTAssertEqual(session.code, "SAFE-482K")
    XCTAssertEqual(components.host, "localhost")
    XCTAssertEqual(components.port, 4173)
    XCTAssertEqual(components.path, "/pair")
    XCTAssertEqual(
      components.queryItems?.first(where: { $0.name == "pairing_code" })?.value, "SAFE-482K")
    XCTAssertFalse(
      components.queryItems?.contains(where: { $0.name.localizedCaseInsensitiveContains("token") })
        ?? true)
  }

  func testMobileAuthorizationPolicyAcceptsOnlyBoundTokenFreeReturn() throws {
    let pairingID = UUID()
    let pairing = PairingSession(
      id: pairingID, code: "TEST-CODE",
      setupURL: URL(string: "https://connect.whox.ai/pair/test")!,
      expiresAt: .now.addingTimeInterval(600))
    let handoff = MobileAuthorizationHandoff(
      authorizationURL: URL(
        string:
          "https://agent.robinhood.com/oauth/authorize?client_id=treasury&response_type=code&code_challenge=safe"
      )!,
      callbackScheme: "yield",
      returnURL: URL(string: "yield://broker-connection/callback")!,
      pairingID: pairingID, expiresAt: .now.addingTimeInterval(300))

    XCTAssertNoThrow(try MobileAuthorizationURLPolicy.validate(handoff, pairing: pairing))
    let callback = URL(
      string:
        "yield://broker-connection/callback?result=verification_pending&pairingId=\(pairingID.uuidString)"
    )!
    XCTAssertEqual(
      try MobileAuthorizationURLPolicy.result(
        from: callback, expectedReturnURL: handoff.returnURL, pairingID: pairingID),
      .verificationPending)
  }

  func testMobileAuthorizationPolicyRejectsNonRobinhoodAndCredentialBearingURLs() {
    let pairingID = UUID()
    let pairing = PairingSession(
      id: pairingID, code: "TEST-CODE",
      setupURL: URL(string: "https://connect.whox.ai/pair/test")!,
      expiresAt: .now.addingTimeInterval(600))
    let returnURL = URL(string: "yield://broker-connection/callback")!
    let invalidURLs = [
      "https://robinhood.com.evil.example/oauth/authorize",
      "http://agent.robinhood.com/oauth/authorize",
      "https://agent.robinhood.com:8443/oauth/authorize",
      "https://agent.robinhood.com/oauth/authorize?access_token=broker-secret",
      "https://agent.robinhood.com/oauth/authorize#fragment",
    ]

    for rawURL in invalidURLs {
      let handoff = MobileAuthorizationHandoff(
        authorizationURL: URL(string: rawURL)!, callbackScheme: "yield",
        returnURL: returnURL, pairingID: pairingID, expiresAt: .now.addingTimeInterval(300))
      XCTAssertThrowsError(try MobileAuthorizationURLPolicy.validate(handoff, pairing: pairing))
    }
  }

  func testMobileAuthorizationPolicyRejectsUnboundOrSensitiveCallbacks() {
    let pairingID = UUID()
    let returnURL = URL(string: "yield://broker-connection/callback")!
    let invalidCallbacks = [
      "yield://broker-connection/callback?result=connected&pairingId=\(pairingID.uuidString)",
      "yield://broker-connection/callback?result=verification_pending&pairingId=\(UUID().uuidString)",
      "yield://broker-connection/callback?result=verification_pending&pairingId=\(pairingID.uuidString)&token=secret",
      "yield://broker-connection/callback?result=verification_pending&result=failed&pairingId=\(pairingID.uuidString)",
      "yield://broker-connection/callback?result=verification_pending&pairingId=\(pairingID.uuidString)#fragment",
      "yield://other/callback?result=verification_pending&pairingId=\(pairingID.uuidString)",
    ]

    for rawURL in invalidCallbacks {
      XCTAssertThrowsError(
        try MobileAuthorizationURLPolicy.result(
          from: URL(string: rawURL)!, expectedReturnURL: returnURL, pairingID: pairingID))
    }
  }

  @MainActor
  func testDesktopHandoffRequestsServerDeliveryWithoutOpeningMobileBrowser() async {
    let client = MobileAuthorizationPairingClient(result: .failed)
    let presenter = CapturingAuthorizationPresenter(result: .verificationPending)
    let service = PairingService(
      client: client, authorizationPresenter: presenter,
      backoff: .init(baseSeconds: 60, maximumSeconds: 60))

    let delivered = await service.sendDesktopHandoff(to: "person@example.com")

    XCTAssertTrue(delivered)
    XCTAssertEqual(presenter.authorizationCount, 0)
    XCTAssertEqual(service.lifecycleStatus, .authorizing)
    XCTAssertTrue(service.isPolling)
    XCTAssertTrue(service.statusMessage.contains("person@example.com"))
  }

  @MainActor
  func testSafariPresenterOpensValidatedAuthorizationURL() async throws {
    let pairingID = UUID()
    let pairing = PairingSession(
      id: pairingID, code: "TEST-CODE",
      setupURL: URL(string: "https://connect.whox.ai/pair/test")!,
      expiresAt: .now.addingTimeInterval(600))
    let handoff = MobileAuthorizationHandoff(
      authorizationURL: URL(string: "https://agent.robinhood.com/oauth/authorize")!,
      callbackScheme: "yield",
      returnURL: URL(string: "yield://broker-connection/callback")!,
      pairingID: pairingID, expiresAt: .now.addingTimeInterval(300))
    var openedURL: URL?
    let presenter = SafariBrokerAuthorizationPresenter { url in
      openedURL = url
      return true
    }

    let result = try await presenter.authorize(using: handoff, pairing: pairing)

    XCTAssertEqual(openedURL, handoff.authorizationURL)
    XCTAssertEqual(result, .verificationPending)
  }

  @MainActor
  func testExternalSafariCallbackIsPairingBoundAndRefreshesStatus() async {
    let client = MobileAuthorizationPairingClient(result: .failed)
    let presenter = CapturingAuthorizationPresenter(result: .verificationPending)
    let service = PairingService(
      client: client, authorizationPresenter: presenter,
      backoff: .init(baseSeconds: 60, maximumSeconds: 60))
    await service.connectInApp()
    let pairingID = service.session!.id
    let callback = URL(
      string:
        "yield://broker-connection/callback?result=verification_pending&pairingId=\(pairingID.uuidString)"
    )!

    let handled = await service.handleAuthorizationCallback(callback)

    XCTAssertTrue(handled)
    XCTAssertEqual(service.lifecycleStatus, .authorizing)
    XCTAssertEqual(
      service.statusMessage,
      "Robinhood returned to Yield. Verifying the connection with the WHOX server.")
  }

  @MainActor
  func testDemoPairingCompletesWithoutBrokerToken() async {
    let client = DemoBrokerPairingClient(connectAfterPolls: 1)
    let service = PairingService(
      client: client, backoff: .init(baseSeconds: 0.01, maximumSeconds: 0.02))
    await service.generate()
    await service.pollNow()
    XCTAssertEqual(service.lifecycleStatus, .connected)
    XCTAssertEqual(service.connectedConnection?.maskedAccount, "Agentic •••• 4821")
    XCTAssertEqual(service.session?.code, "SAFE-482K")
    XCTAssertEqual(service.session?.setupURL.query, "pairing_code=SAFE-482K")
  }

  @MainActor
  func testInAppAuthorizationAdoptsOnlyCanonicalServerConnection() async {
    let client = MobileAuthorizationPairingClient(result: .verificationPending)
    let presenter = CapturingAuthorizationPresenter(result: .verificationPending)
    let service = PairingService(
      client: client, authorizationPresenter: presenter,
      backoff: .init(baseSeconds: 60, maximumSeconds: 60))

    await service.connectInApp()

    XCTAssertEqual(service.lifecycleStatus, .connected)
    XCTAssertEqual(service.connectedConnection?.maskedAccount, "Agentic •••• 4821")
    XCTAssertFalse(service.isAuthorizingInApp)
    XCTAssertEqual(presenter.authorizationCount, 1)
  }

  @MainActor
  func testReconnectRequiresAcknowledgedDisconnectBeforeCreatingReplacementPairing() async throws {
    let client = ReconnectPairingClient()
    let presenter = CapturingAuthorizationPresenter(result: .verificationPending)
    let service = PairingService(
      client: client, authorizationPresenter: presenter,
      backoff: .init(baseSeconds: 60, maximumSeconds: 60))

    await service.connectInApp()
    let initialCreatedIDs = await client.createdIDs()
    XCTAssertEqual(initialCreatedIDs.count, 1)

    try await service.prepareReconnect()
    await service.connectInApp()
    let replacementPairingID = service.session?.id
    XCTAssertNotEqual(replacementPairingID, initialCreatedIDs.first)
    XCTAssertEqual(service.lifecycleStatus, .connected)

    await service.connectInApp()

    let createdIDs = await client.createdIDs()
    let startedIDs = await client.startedIDs()
    let canceledIDs = await client.canceledIDs()
    let disconnectCount = await client.disconnectCount()
    XCTAssertEqual(createdIDs.count, 2)
    XCTAssertEqual(startedIDs, createdIDs)
    XCTAssertTrue(canceledIDs.isEmpty)
    XCTAssertEqual(disconnectCount, 1)
    XCTAssertEqual(service.session?.id, replacementPairingID)
    XCTAssertEqual(service.lifecycleStatus, .connected)
    XCTAssertEqual(service.connectedConnection?.maskedAccount, "Agentic •••• 4821")
    XCTAssertEqual(presenter.authorizationCount, 2)
  }

  @MainActor
  func testCanceledInAppAuthorizationKeepsPairingForFallback() async {
    let client = MobileAuthorizationPairingClient(result: .canceled)
    let service = PairingService(
      client: client, authorizationPresenter: CapturingAuthorizationPresenter(result: .canceled),
      backoff: .init(baseSeconds: 60, maximumSeconds: 60))

    await service.connectInApp()

    XCTAssertEqual(service.lifecycleStatus, .authorizing)
    XCTAssertNotNil(service.session)
    XCTAssertEqual(
      service.browserAuthorizationURL,
      URL(string: "https://agent.robinhood.com/oauth/authorize"))
    XCTAssertEqual(service.browserAuthorizationExpiresAt, service.session?.expiresAt)
    XCTAssertNil(service.connectedConnection)
    XCTAssertFalse(service.isAuthorizingInApp)
    let abortCount = await client.abortCount()
    XCTAssertEqual(abortCount, 0)
  }

  @MainActor
  func testCanceledBrowserAuthorizationKeepsLinkForRetry() async {
    let client = AbortFailingMobilePairingClient()
    let service = PairingService(
      client: client, authorizationPresenter: CapturingAuthorizationPresenter(result: .canceled),
      backoff: .init(baseSeconds: 60, maximumSeconds: 60))

    await service.connectInApp()

    let createCount = await client.createCount()
    XCTAssertEqual(createCount, 1)
    XCTAssertEqual(service.lifecycleStatus, .authorizing)
    XCTAssertTrue(service.statusMessage.contains("browser"))
    XCTAssertEqual(
      service.browserAuthorizationURL,
      URL(string: "https://agent.robinhood.com/oauth/authorize"))
    XCTAssertEqual(service.browserAuthorizationExpiresAt, service.session?.expiresAt)
    XCTAssertNotNil(service.session)
  }

  @MainActor
  func testPairingCancellationStopsPolling() async {
    let service = PairingService(
      client: DemoBrokerPairingClient(connectAfterPolls: 99),
      backoff: .init(baseSeconds: 1, maximumSeconds: 2))
    await service.generate()
    XCTAssertTrue(service.isPolling)
    await service.cancel()
    XCTAssertEqual(service.lifecycleStatus, .canceled)
    XCTAssertFalse(service.isPolling)
    XCTAssertNil(service.session)
  }

  @MainActor
  func testPairingCancellationPreservesCodeUntilServerConfirms() async {
    let pairing = PairingSession(
      id: UUID(), code: "TEST-CODE",
      setupURL: URL(string: "https://connect.whox.ai/pair?pairing_code=TEST-CODE")!,
      expiresAt: .now.addingTimeInterval(600))
    let service = PairingService(
      client: FailingCancellationPairingClient(session: pairing),
      backoff: .init(baseSeconds: 60, maximumSeconds: 60))
    await service.generate()

    await service.cancel()

    XCTAssertEqual(service.session?.id, pairing.id)
    XCTAssertEqual(service.lifecycleStatus, .pending)
    XCTAssertTrue(service.isPolling)
    XCTAssertTrue(service.statusMessage.contains("temporarily unavailable"))
  }

  @MainActor
  func testReconnectFailurePreservesTheCurrentLocalConnectionState() async {
    let pairing = PairingSession(
      id: UUID(), code: "TEST-CODE",
      setupURL: URL(string: "https://connect.whox.ai/pair?pairing_code=TEST-CODE")!,
      expiresAt: .now.addingTimeInterval(600))
    let service = PairingService(
      client: FailingCancellationPairingClient(session: pairing),
      backoff: .init(baseSeconds: 60, maximumSeconds: 60))
    await service.generate()

    do {
      try await service.prepareReconnect()
      XCTFail("Reconnect must wait for a server revocation acknowledgment")
    } catch {
      XCTAssertEqual(service.session?.id, pairing.id)
      XCTAssertEqual(service.lifecycleStatus, .pending)
      XCTAssertTrue(service.isPolling)
    }
  }

  @MainActor
  func testExpiredPairingFailsClosed() async {
    let expired = PairingSession(
      id: UUID(), code: "TEST-CODE", setupURL: URL(string: "https://connect.whox.ai/pair/test")!,
      expiresAt: .distantPast)
    let client = FixedPairingClient(
      session: expired, snapshot: .init(status: .expired, connection: nil, message: "Expired"))
    let service = PairingService(client: client, backoff: .init(baseSeconds: 1, maximumSeconds: 2))
    await service.generate()
    await service.pollNow()
    XCTAssertEqual(service.lifecycleStatus, .expired)
    XCTAssertFalse(service.isPolling)
  }
}

private actor FailingCancellationPairingClient: BrokerPairingClient {
  let session: PairingSession
  init(session: PairingSession) { self.session = session }
  func createPairing() async throws -> PairingSession { session }
  func startInAppAuthorization(pairingID: UUID) async throws -> MobileAuthorizationHandoff {
    throw PairingClientError.unavailable
  }
  func abortInAppAuthorization(pairingID: UUID) async throws {}
  func status(for id: UUID) async throws -> PairingStatusSnapshot {
    PairingStatusSnapshot(status: .pending, connection: nil, message: nil)
  }
  func cancelPairing(id: UUID) async throws { throw PairingClientError.unavailable }
  func disconnectConnection() async throws { throw PairingClientError.unavailable }
}

private actor FixedPairingClient: BrokerPairingClient {
  let session: PairingSession
  let snapshot: PairingStatusSnapshot
  init(session: PairingSession, snapshot: PairingStatusSnapshot) {
    self.session = session
    self.snapshot = snapshot
  }
  func createPairing() async throws -> PairingSession { session }
  func startInAppAuthorization(pairingID: UUID) async throws -> MobileAuthorizationHandoff {
    MobileAuthorizationHandoff(
      authorizationURL: URL(string: "https://agent.robinhood.com/oauth/authorize")!,
      callbackScheme: "yield",
      returnURL: URL(string: "yield://broker-connection/callback")!,
      pairingID: pairingID, expiresAt: session.expiresAt)
  }
  func abortInAppAuthorization(pairingID: UUID) async throws {}
  func status(for id: UUID) async throws -> PairingStatusSnapshot { snapshot }
  func cancelPairing(id: UUID) async throws {}
  func disconnectConnection() async throws {}
}

private actor MobileAuthorizationPairingClient: BrokerPairingClient {
  private let pairing = PairingSession(
    id: UUID(), code: "TEST-CODE",
    setupURL: URL(string: "https://connect.whox.ai/pair/test")!,
    expiresAt: .now.addingTimeInterval(600))
  private let result: MobileAuthorizationResult
  private var mobileAuthorizationStarted = false
  private var mobileAuthorizationAborts = 0

  init(result: MobileAuthorizationResult) { self.result = result }

  func createPairing() async throws -> PairingSession { pairing }

  func startInAppAuthorization(pairingID: UUID) async throws -> MobileAuthorizationHandoff {
    guard pairingID == pairing.id else { throw PairingClientError.notFound }
    mobileAuthorizationStarted = true
    return MobileAuthorizationHandoff(
      authorizationURL: URL(string: "https://agent.robinhood.com/oauth/authorize")!,
      callbackScheme: "yield",
      returnURL: URL(string: "yield://broker-connection/callback")!,
      pairingID: pairingID, expiresAt: pairing.expiresAt)
  }

  func status(for id: UUID) async throws -> PairingStatusSnapshot {
    guard id == pairing.id else { throw PairingClientError.notFound }
    guard mobileAuthorizationStarted, result == .verificationPending else {
      return PairingStatusSnapshot(status: .pending, connection: nil, message: "Pending")
    }
    return PairingStatusSnapshot(
      status: .connected, connection: DemoFixtures.brokerConnection, message: "Connected")
  }

  func abortInAppAuthorization(pairingID: UUID) async throws {
    guard pairingID == pairing.id else { throw PairingClientError.notFound }
    mobileAuthorizationAborts += 1
    mobileAuthorizationStarted = false
  }

  func cancelPairing(id: UUID) async throws {}
  func disconnectConnection() async throws {}
  func abortCount() -> Int { mobileAuthorizationAborts }
}

private actor AbortFailingMobilePairingClient: BrokerPairingClient {
  private var pairing: PairingSession?
  private var creations = 0

  func createPairing() async throws -> PairingSession {
    creations += 1
    let created = PairingSession(
      id: UUID(), code: "TEST-CODE",
      setupURL: URL(string: "https://connect.whox.ai/pair/test")!,
      expiresAt: .now.addingTimeInterval(600))
    pairing = created
    return created
  }

  func startInAppAuthorization(pairingID: UUID) async throws -> MobileAuthorizationHandoff {
    guard let pairing, pairing.id == pairingID else { throw PairingClientError.notFound }
    return MobileAuthorizationHandoff(
      authorizationURL: URL(string: "https://agent.robinhood.com/oauth/authorize")!,
      callbackScheme: "yield",
      returnURL: URL(string: "yield://broker-connection/callback")!,
      pairingID: pairingID, expiresAt: pairing.expiresAt)
  }

  func abortInAppAuthorization(pairingID: UUID) async throws {
    throw PairingClientError.unavailable
  }

  func status(for id: UUID) async throws -> PairingStatusSnapshot {
    PairingStatusSnapshot(status: .pending, connection: nil, message: "Pending")
  }

  func cancelPairing(id: UUID) async throws { pairing = nil }
  func disconnectConnection() async throws { pairing = nil }
  func createCount() -> Int { creations }
}

private actor ReconnectPairingClient: BrokerPairingClient {
  private var currentPairing: PairingSession?
  private var creations: [UUID] = []
  private var starts: [UUID] = []
  private var cancellations: [UUID] = []
  private var disconnections = 0

  func createPairing() async throws -> PairingSession {
    let pairing = PairingSession(
      id: UUID(), code: "TEST-CODE",
      setupURL: URL(string: "https://connect.whox.ai/pair/test")!,
      expiresAt: .now.addingTimeInterval(600))
    currentPairing = pairing
    creations.append(pairing.id)
    return pairing
  }

  func startInAppAuthorization(pairingID: UUID) async throws -> MobileAuthorizationHandoff {
    guard let currentPairing, currentPairing.id == pairingID else {
      throw PairingClientError.notFound
    }
    starts.append(pairingID)
    return MobileAuthorizationHandoff(
      authorizationURL: URL(string: "https://agent.robinhood.com/oauth/authorize")!,
      callbackScheme: "yield",
      returnURL: URL(string: "yield://broker-connection/callback")!,
      pairingID: pairingID, expiresAt: currentPairing.expiresAt)
  }

  func abortInAppAuthorization(pairingID: UUID) async throws {}

  func status(for id: UUID) async throws -> PairingStatusSnapshot {
    guard currentPairing?.id == id else { throw PairingClientError.notFound }
    guard starts.contains(id) else {
      return PairingStatusSnapshot(status: .pending, connection: nil, message: "Pending")
    }
    return PairingStatusSnapshot(
      status: .connected, connection: DemoFixtures.brokerConnection, message: "Connected")
  }

  func cancelPairing(id: UUID) async throws {
    cancellations.append(id)
    currentPairing = nil
  }

  func disconnectConnection() async throws {
    disconnections += 1
    currentPairing = nil
  }
  func createdIDs() -> [UUID] { creations }
  func startedIDs() -> [UUID] { starts }
  func canceledIDs() -> [UUID] { cancellations }
  func disconnectCount() -> Int { disconnections }
}

@MainActor
private final class CapturingAuthorizationPresenter: BrokerAuthorizationPresenting {
  private let result: MobileAuthorizationResult
  private(set) var authorizationCount = 0

  init(result: MobileAuthorizationResult) { self.result = result }

  func authorize(
    using handoff: MobileAuthorizationHandoff, pairing: PairingSession
  ) async throws -> MobileAuthorizationResult {
    authorizationCount += 1
    try MobileAuthorizationURLPolicy.validate(handoff, pairing: pairing)
    return result
  }

  func cancel() {}
}
