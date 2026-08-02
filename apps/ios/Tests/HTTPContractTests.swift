import AuthenticationServices
import Foundation
import XCTest

@testable import Yield

final class HTTPContractTests: XCTestCase {
  override func setUp() {
    super.setUp()
    FixtureURLProtocol.reset()
  }

  func testPairingDecodesCanonicalAPIShapeAndSendsIdempotency() async throws {
    let expires = "2026-08-01T12:10:00Z"
    let json = """
      {"pairingId":"DE7B296D-C4ED-4DF1-8C09-E44DA8297745","code":"ABCD-2345","setupUrl":"https://connect.whox.ai/pair?id=demo","expiresAt":"\(expires)","status":"connected","connection":{"status":"connected","maskedAccountIdentifier":"Agentic •••• 4821","accountType":"Robinhood Agentic Account","lastSuccessfulSync":"2026-08-01T12:00:00Z","capabilities":["equity"],"equityTradingAvailable":true,"optionsTradingAvailable":false}}
      """
    FixtureURLProtocol.responseData = Data(json.utf8)
    let client = HTTPBrokerPairingClient(
      baseURL: URL(string: "https://api.whox.ai/")!, urlSession: fixtureSession
    ) { "app-token" }
    let pairing = try await client.createPairing()
    XCTAssertEqual(pairing.code, "ABCD-2345")
    XCTAssertEqual(
      FixtureURLProtocol.lastRequest?.value(forHTTPHeaderField: "Idempotency-Key")?.isEmpty, false)
    XCTAssertEqual(
      FixtureURLProtocol.lastRequest?.value(forHTTPHeaderField: "Authorization"), "Bearer app-token"
    )

    let snapshot = try await client.status(for: pairing.id)
    XCTAssertEqual(snapshot.status, .connected)
    XCTAssertEqual(snapshot.connection?.maskedAccount, "Agentic •••• 4821")
    XCTAssertEqual(snapshot.connection?.optionsPermission, "Options restricted")
  }

  func testMobileAuthorizationStartUsesBoundTokenFreeContract() async throws {
    let pairingID = UUID()
    FixtureURLProtocol.responseData = Data(
      """
      {"authorizationUrl":"https://agent.robinhood.com/oauth/authorize?client_id=treasury&response_type=code&code_challenge=safe","callbackScheme":"yield","returnUrl":"yield://broker-connection/callback","pairingId":"\(pairingID.uuidString)","expiresAt":"2027-08-01T12:10:00Z"}
      """.utf8)
    let client = HTTPBrokerPairingClient(
      baseURL: URL(string: "https://api.whox.ai/")!, urlSession: fixtureSession
    ) { "app-token" }

    let handoff = try await client.startInAppAuthorization(pairingID: pairingID)

    XCTAssertEqual(handoff.pairingID, pairingID)
    XCTAssertEqual(handoff.callbackScheme, "yield")
    XCTAssertEqual(handoff.returnURL.absoluteString, "yield://broker-connection/callback")
    let request = try XCTUnwrap(FixtureURLProtocol.lastRequest)
    XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertEqual(request.url?.path, "/v1/brokers/robinhood/mobile-oauth/start")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer app-token")
    XCTAssertNotNil(request.value(forHTTPHeaderField: "Idempotency-Key"))
    let body = try XCTUnwrap(FixtureURLProtocol.lastRequestBody)
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    XCTAssertEqual(object["pairingId"] as? String, pairingID.uuidString)
  }

  func testMobileAuthorizationAbortRestoresPendingPairing() async throws {
    let pairingID = UUID()
    FixtureURLProtocol.responseData = Data(
      "{\"pairingId\":\"\(pairingID.uuidString)\",\"status\":\"pending\"}".utf8)
    let client = HTTPBrokerPairingClient(
      baseURL: URL(string: "https://api.whox.ai/")!, urlSession: fixtureSession
    ) { "app-token" }

    try await client.abortInAppAuthorization(pairingID: pairingID)

    let request = try XCTUnwrap(FixtureURLProtocol.lastRequest)
    XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertEqual(request.url?.path, "/v1/brokers/robinhood/mobile-oauth/abort")
    XCTAssertNotNil(request.value(forHTTPHeaderField: "Idempotency-Key"))
    let body = try XCTUnwrap(FixtureURLProtocol.lastRequestBody)
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    XCTAssertEqual(object["pairingId"] as? String, pairingID.uuidString)
  }

  func testEntitlementSyncUsesCanonicalJWSWireShape() async throws {
    FixtureURLProtocol.responseData = Data(
      "{\"entitledProductIDs\":[\"ai.whox.yield.equity.monthly\"],\"reconciledAt\":\"2026-08-01T12:00:00Z\"}"
        .utf8)
    let client = HTTPEntitlementSyncClient(
      baseURL: URL(string: "https://api.whox.ai/")!, urlSession: fixtureSession
    ) { "app-token" }
    let envelope = VerifiedTransactionEnvelope(
      productID: "ai.whox.yield.equity.monthly", transactionID: "123", originalTransactionID: "100",
      signedTransactionJWS: "header.payload.signature")
    let result = try await client.sync(envelope)
    XCTAssertEqual(result.entitledProductIDs, ["ai.whox.yield.equity.monthly"])
    let request = try XCTUnwrap(FixtureURLProtocol.lastRequest)
    XCTAssertNotNil(request.value(forHTTPHeaderField: "Idempotency-Key"))
    let body = try XCTUnwrap(FixtureURLProtocol.lastRequestBody)
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    XCTAssertEqual(object["signedTransactionJWS"] as? String, "header.payload.signature")
    XCTAssertNil(object["verified"])
    XCTAssertNil(object["jsonRepresentation"])
  }

  func testAppleAuthUsesStableInstallIDAndDecodesCanonicalResponse() async throws {
    let json = """
      {"userID":"user-1","displayName":"Alex","email":"relay@example.com","accessToken":"access","accessTokenExpiresAt":"2026-08-01T12:15:00Z","refreshToken":"refresh","refreshTokenExpiresAt":"2026-09-01T12:00:00Z","sessionID":"session-1"}
      """
    FixtureURLProtocol.responseData = Data(json.utf8)
    let store = CapturingCredentialStore()
    let client = HTTPAuthClient(
      baseURL: URL(string: "https://api.whox.ai/")!,
      installIdentityProvider: StaticInstallIdentityProvider(value: "install-123"),
      credentialStore: store,
      urlSession: fixtureSession
    )
    let payload = AppleCredentialPayload(
      userIdentifier: "apple-user", identityToken: Data("header.payload.signature".utf8),
      authorizationCode: Data("auth-code".utf8), email: nil, givenName: nil,
      nonce: "cryptographic-raw-nonce")
    let session = try await client.exchangeAppleCredential(payload)
    XCTAssertEqual(session.userID, "user-1")
    let storedPayload = await store.payload()
    XCTAssertEqual(storedPayload?.refreshToken, "refresh")
    let request = try XCTUnwrap(FixtureURLProtocol.lastRequest)
    XCTAssertEqual(request.url?.path, "/v1/auth/apple")
    let object = try XCTUnwrap(
      JSONSerialization.jsonObject(with: try XCTUnwrap(FixtureURLProtocol.lastRequestBody))
        as? [String: Any])
    XCTAssertEqual(object["deviceId"] as? String, "install-123")
    XCTAssertNil(object["deviceID"])
    XCTAssertEqual(object["identityToken"] as? String, "header.payload.signature")
    XCTAssertEqual(object["nonce"] as? String, "cryptographic-raw-nonce")
    XCTAssertNil(object["email"])
    XCTAssertNil(object["appleUserIdentifier"])

    try await client.clearLocalSession()
    let clearedPayload = await store.payload()
    XCTAssertNil(clearedPayload)
  }

  func testAppleRequestUsesCryptographicNonceHash() throws {
    let request = ASAuthorizationAppleIDProvider().createRequest()
    let rawNonce = try AppleAuthenticationService().prepare(request)

    XCTAssertFalse(rawNonce.isEmpty)
    XCTAssertEqual(request.nonce, AppleAuthenticationService.sha256(rawNonce))
    XCTAssertEqual(request.nonce?.count, 64)
    XCTAssertNotEqual(rawNonce, try AppleAuthenticationService.randomNonce())
  }

  func testAccountDeletionUsesAuthenticatedIdempotentServerBoundary() async throws {
    FixtureURLProtocol.statusCode = 202
    FixtureURLProtocol.responseData = Data(
      "{\"deletionRequested\":true,\"brokerRevocationPending\":true,\"retentionNotice\":\"Records subject to legal retention are preserved and access is restricted.\"}"
        .utf8)
    let stepUp = CapturingStepUpProvider()
    let repository = HTTPTreasuryRepository(
      baseURL: URL(string: "https://api.whox.ai/")!, urlSession: fixtureSession,
      proposalStepUpProvider: stepUp,
      authenticatedUserIDProvider: { "user-1" }, credentialProvider: { "app-token" })

    let disposition = try await repository.requestAccountDeletion()

    XCTAssertEqual(disposition, .serverAccepted(brokerRevocationPending: true))
    let request = try XCTUnwrap(FixtureURLProtocol.lastRequest)
    XCTAssertEqual(request.url?.path, "/v1/account")
    XCTAssertEqual(request.httpMethod, "DELETE")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer app-token")
    XCTAssertNotNil(request.value(forHTTPHeaderField: "Idempotency-Key"))
    let calls = await stepUp.calls()
    XCTAssertEqual(calls, [.init(action: .deleteAccount, resourceID: "user-1")])
    let object = try XCTUnwrap(
      JSONSerialization.jsonObject(
        with: try XCTUnwrap(FixtureURLProtocol.lastRequestBody)) as? [String: Any])
    XCTAssertEqual(object["deviceId"] as? String, "install-123")
    XCTAssertEqual((object["stepUpProof"] as? [String: String])?["assertion"], "signed")
  }

  func testDashboardHistoryAndPositionsMapCanonicalEnvelopesWithoutRelabeling() async throws {
    FixtureURLProtocol.responseProvider = { request in
      switch request.url?.path {
      case "/v1/dashboard":
        return (
          200,
          Data(
            """
            {"mode":"demo","dataClassification":"demo","portfolio":{"value":12430,"todayChange":-120,"todayChangePercent":-0.0096,"asOf":"2026-08-01T14:00:00Z","dataClassification":"demo"},"agentStatus":{"riskState":"within_limits"},"risk":{"dailyLossUsed":120,"dailyLossLimit":500,"allocationUsed":0.32,"buyingPowerReserve":0.42}}
            """.utf8)
        )
      case "/v1/portfolio/history":
        return (
          200,
          Data(
            """
            {"mode":"demo","range":"1M","data":[{"timestamp":"2026-07-01T20:00:00Z","value":12000},{"timestamp":"2026-08-01T14:00:00Z","value":12430}],"benchmark":null,"dataClassification":"demo"}
            """.utf8)
        )
      case "/v1/positions":
        return (
          200,
          Data(
            """
            {"data":[{"id":"position-aapl","symbol":"AAPL","companyName":"Apple Inc.","instrumentType":"equity","quantity":5,"averageCost":184,"marketValue":1000,"todayPnl":-12,"unrealizedPnl":80,"dataClassification":"demo"}],"nextCursor":null}
            """.utf8)
        )
      default: return (404, Data())
      }
    }
    let repository = demoHTTPRepository()

    let dashboard = try await repository.dashboard()
    let positions = try await repository.positions()

    XCTAssertEqual(dashboard.mode, .demo)
    XCTAssertEqual(dashboard.todayPercent, -0.96, accuracy: 0.0001)
    XCTAssertEqual(dashboard.history.count, 2)
    XCTAssertTrue(dashboard.dataLabel.contains("Demo"))
    XCTAssertEqual(positions.first?.currentPrice, 200)
    XCTAssertEqual(positions.first?.todayPercent ?? 0, -1.18577, accuracy: 0.001)

    let paperRepository = HTTPTreasuryRepository(
      baseURL: URL(string: "https://api.whox.ai/")!, urlSession: fixtureSession,
      expectedMode: .paper
    ) { "app-token" }
    do {
      _ = try await paperRepository.dashboard()
      XCTFail("Demo payloads must never be relabeled as Paper")
    } catch let error as APIWireMappingError {
      XCTAssertEqual(error, .environmentMismatch(expected: .paper, received: "demo"))
    }
  }

  func testAgentCatalogAndActivationEnvelopesAreCombined() async throws {
    FixtureURLProtocol.responseProvider = { request in
      if request.url?.path == "/v1/user-agents" {
        return (
          200,
          Data(
            """
            {"data":[{"id":"activation-1","userId":"user-1","agentId":"foundation-equity","status":"monitoring","allocation":0.4,"approvalMode":"confirm_every_trade","configurationVersion":1,"configuration":{"symbol":"VTI","targetOrderAmount":600},"createdAt":"2026-08-01T12:00:00Z","updatedAt":"2026-08-01T14:00:00Z"}]}
            """.utf8)
        )
      }
      if request.url?.path == "/v1/agents" {
        return (200, Data(Self.agentCatalogJSON.utf8))
      }
      return (404, Data())
    }

    let agents = try await demoHTTPRepository().agents()

    XCTAssertEqual(agents.count, 1)
    XCTAssertEqual(agents[0].id, "foundation-equity")
    XCTAssertTrue(agents[0].isActive)
    XCTAssertEqual(agents[0].runtimeStatus, .monitoring)
    XCTAssertEqual(agents[0].operatingMode, .confirmEveryTrade)
    XCTAssertEqual(agents[0].allocationPercent, 40)
    XCTAssertEqual(agents[0].activationID, "activation-1")
    XCTAssertEqual(agents[0].configuredSymbol, "VTI")
    XCTAssertEqual(agents[0].targetOrderAmount, 600)
  }

  func testPlanCatalogUsesServerAssignmentsEffectiveLimitAndResearchUniverse() async throws {
    FixtureURLProtocol.responseProvider = { request in
      switch request.url?.path {
      case "/v1/plans":
        return (200, Data(Self.planCatalogJSON.utf8))
      case "/v1/subscription":
        return (
          200,
          Data(
            "{\"status\":\"active\",\"planId\":\"equity_pro\",\"productId\":\"ai.whox.yield.equitypro.monthly\",\"source\":\"verified_storekit\",\"renewsAt\":null}"
              .utf8)
        )
      case "/v1/entitlements":
        return (
          200,
          Data(
            "{\"stockTrading\":true,\"optionsTrading\":false,\"multiLegOptions\":false,\"maximumActiveAgents\":2,\"automaticMode\":true,\"monitoringFrequencyMinutes\":60,\"advancedAnalytics\":true,\"customWatchlists\":true,\"scannerAccess\":true,\"agentCatalog\":[\"foundation-equity\",\"equity-momentum\",\"quality-swing\"],\"prioritySupport\":true}"
              .utf8)
        )
      default: return (404, Data())
      }
    }

    let context = try await demoHTTPRepository().planCatalog()

    XCTAssertEqual(context.plans.map(\.tier), [.equityPro])
    XCTAssertEqual(context.currentPlanTier, .equityPro)
    XCTAssertEqual(context.maximumActiveAgents, 2)
    XCTAssertEqual(
      context.researchUniverseByPlan[.equityPro]?["foundation-equity"],
      ["AAPL", "MSFT", "VTI"])
  }

  func testPlanCatalogRejectsNonCanonicalResearchUniverse() throws {
    let features = APIEntitlementsDTO(
      stockTrading: true, optionsTrading: false, multiLegOptions: false,
      maximumActiveAgents: 1, automaticMode: false, monitoringFrequencyMinutes: 1_440,
      advancedAnalytics: false, customWatchlists: false, scannerAccess: false,
      agentCatalog: ["foundation-equity"], prioritySupport: false)
    let catalog = APIPlanCatalogEnvelopeDTO(
      data: [
        APIPlanCatalogDTO(
          id: "equity", name: "Equity", productID: "ai.whox.yield.equity.monthly",
          features: features, agentCatalogVersion: 1,
          agents: [
            APIPlanAgentAssignmentDTO(
              agentID: "foundation-equity", displayName: "Foundation Equity",
              agentVersion: "1.0.0", catalogPosition: 1, releaseStatus: "paper",
              deterministicStrategyVersion: "foundation-equity-rules-1.0.0",
              researchUniverse: ["MSFT", "AAPL"])
          ])
      ],
      priceSource: "StoreKit; display prices must be supplied by the client StoreKit response")
    let subscription = APISubscriptionDTO(
      status: "active", planID: "equity", productID: "ai.whox.yield.equity.monthly",
      source: "verified_storekit")

    XCTAssertThrowsError(
      try APIPlanCatalogContextMapper.domain(
        catalog: catalog, subscription: subscription, entitlements: features)
    ) { error in
      XCTAssertEqual(error as? APIWireMappingError, .invalidField("research universe"))
    }
  }

  func testPaperAgentSettingsAndPushMutationsUseCanonicalServerContracts() async throws {
    let stepUp = CapturingStepUpProvider()
    let agentResponse = Data(
      "{\"id\":\"activation-1\",\"userId\":\"user-1\",\"agentId\":\"foundation-equity\",\"status\":\"paused\",\"allocation\":0.25,\"approvalMode\":\"observe\",\"configurationVersion\":1,\"configuration\":{\"symbol\":\"VTI\",\"targetOrderAmount\":600},\"createdAt\":\"2026-08-01T12:00:00Z\",\"updatedAt\":\"2026-08-01T14:00:00Z\"}"
        .utf8)
    FixtureURLProtocol.responseProvider = { request in
      switch (request.httpMethod, request.url?.path) {
      case ("POST", "/v1/user-agents"),
        ("PATCH", "/v1/user-agents/activation-1"),
        ("POST", "/v1/user-agents/activation-1/pause"),
        ("POST", "/v1/user-agents/activation-1/resume"):
        return (200, agentResponse)
      case ("GET", "/v1/settings"):
        return (
          200,
          Data(
            "{\"privacyMode\":false,\"appearance\":\"system\",\"notificationPreferences\":{\"detailedPreviewsEnabled\":false,\"criticalNotificationsEnabled\":false}}"
              .utf8)
        )
      case ("PATCH", "/v1/settings"):
        return (
          200,
          Data(
            "{\"privacyMode\":true,\"appearance\":\"dark\",\"notificationPreferences\":{\"detailedPreviewsEnabled\":false,\"criticalNotificationsEnabled\":false,\"quietHours\":{\"startMinute\":1320,\"endMinute\":420,\"utcOffsetMinutes\":-240}}}"
              .utf8)
        )
      case ("POST", "/v1/devices/push-token"):
        return (200, Data("{\"registered\":true,\"environment\":\"sandbox\"}".utf8))
      case ("DELETE", "/v1/devices/push-token"):
        return (200, Data("{\"unregistered\":true}".utf8))
      default: return (404, Data())
      }
    }
    let repository = HTTPTreasuryRepository(
      baseURL: URL(string: "https://api.whox.ai/")!, urlSession: fixtureSession,
      expectedMode: .paper, proposalStepUpProvider: stepUp
    ) { "app-token" }
    let configuration = AgentConfigurationInput(
      allocationPercent: 25, operatingMode: .observe, symbol: "VTI", targetOrderAmount: 600)

    try await repository.activateAgent(
      definitionID: "foundation-equity", configuration: configuration)
    try await repository.updateAgent(
      activationID: "activation-1", configuration: configuration)
    try await repository.pauseAgent(activationID: "activation-1")
    try await repository.resumeAgent(activationID: "activation-1")
    let initialSettings = try await repository.settings()
    let savedSettings = try await repository.saveSettings(
      RemoteSettings(
        privacyMode: true, appearance: .dark,
        notifications: RemoteNotificationSettings(
          detailedPreviewsEnabled: false, criticalNotificationsEnabled: false,
          quietHoursStartMinute: 1320, quietHoursEndMinute: 420,
          quietHoursUTCOffsetMinutes: -240)))
    try await repository.registerPushToken(
      String(repeating: "ab", count: 32), environment: "sandbox")
    try await repository.unregisterPushToken()
    let stepUpCalls = await stepUp.calls()

    XCTAssertFalse(initialSettings.privacyMode)
    XCTAssertEqual(savedSettings.appearance, .dark)
    XCTAssertEqual(
      stepUpCalls, [.init(action: .resumeUserAgent, resourceID: "activation-1")])
    let activationIndex = try XCTUnwrap(
      FixtureURLProtocol.requests.firstIndex {
        $0.httpMethod == "POST" && $0.url?.path == "/v1/user-agents"
      })
    let activation = try XCTUnwrap(
      JSONSerialization.jsonObject(
        with: try XCTUnwrap(FixtureURLProtocol.requestBodies[activationIndex])) as? [String: Any])
    XCTAssertEqual(activation["agentId"] as? String, "foundation-equity")
    XCTAssertEqual(activation["allocation"] as? Double, 0.25)
    XCTAssertEqual((activation["configuration"] as? [String: Any])?["symbol"] as? String, "VTI")
    let settingsIndex = try XCTUnwrap(
      FixtureURLProtocol.requests.firstIndex {
        $0.httpMethod == "PATCH" && $0.url?.path == "/v1/settings"
      })
    let settingsBody = try XCTUnwrap(
      JSONSerialization.jsonObject(
        with: try XCTUnwrap(FixtureURLProtocol.requestBodies[settingsIndex])) as? [String: Any])
    let notificationBody = try XCTUnwrap(
      settingsBody["notificationPreferences"] as? [String: Any])
    XCTAssertEqual(
      (notificationBody["quietHours"] as? [String: Any])?["startMinute"] as? Int, 1320)
    let unregister = try XCTUnwrap(
      FixtureURLProtocol.requests.last {
        $0.httpMethod == "DELETE" && $0.url?.path == "/v1/devices/push-token"
      })
    XCTAssertNil(
      FixtureURLProtocol.requestBodies[FixtureURLProtocol.requests.firstIndex(of: unregister)!])
    XCTAssertNotNil(unregister.value(forHTTPHeaderField: "Idempotency-Key"))
  }

  func testActivityApprovalRejectionAndStepUpWireContracts() async throws {
    let activityJSON =
      "{\"data\":[" + Self.proposalRecordJSON
      + "," + Self.orderRecordJSON + "],\"nextCursor\":null}"
    FixtureURLProtocol.responseProvider = { request in
      if request.url?.path == "/v1/activity" {
        return (200, Data(activityJSON.utf8))
      }
      if request.url?.path.hasSuffix("/approve") == true {
        return (
          200,
          Data(
            Self.proposalRecordJSON.replacingOccurrences(
              of: "AWAITING_USER_APPROVAL", with: "APPROVED"
            ).utf8)
        )
      }
      if request.url?.path.hasSuffix("/reject") == true {
        return (
          200,
          Data(
            Self.proposalRecordJSON.replacingOccurrences(
              of: "AWAITING_USER_APPROVAL", with: "USER_REJECTED"
            ).utf8)
        )
      }
      if request.url?.path == "/v1/orders/order-2/cancel" {
        return (200, Data(Self.canceledOrderRecordJSON.utf8))
      }
      return (404, Data())
    }
    let repository = HTTPTreasuryRepository(
      baseURL: URL(string: "https://api.whox.ai/")!,
      urlSession: fixtureSession,
      expectedMode: .demo,
      proposalStepUpProvider: StaticProposalStepUpProvider(
        authorization: .init(
          deviceID: "install-123", proof: ["method": "app_attest", "assertion": "signed"])
      )
    ) { "app-token" }

    let activity = try await repository.activities()
    let approved = try await repository.approveProposal(id: "proposal-1", mode: .demo)
    let rejected = try await repository.rejectProposal(id: "proposal-1")
    let canceled = try await repository.cancelOrder(id: "order-2")

    XCTAssertEqual(activity.count, 2)
    XCTAssertEqual(activity.first?.proposal?.state, .awaitingUserApproval)
    XCTAssertEqual(activity.last?.order?.status, .filled)
    XCTAssertEqual(activity.last?.order?.averageFillPrice, 199.50)
    XCTAssertEqual(activity.last?.order?.fills.count, 1)
    XCTAssertEqual(activity.last?.order?.limitPrice, 200)
    XCTAssertEqual(approved.proposal?.state, .approved)
    XCTAssertEqual(rejected.proposal?.state, .userRejected)
    XCTAssertEqual(canceled.order?.status, .canceled)
    XCTAssertEqual(canceled.order?.remainingQuantity, 1)
    let approvalIndex = try XCTUnwrap(
      FixtureURLProtocol.requests.firstIndex { $0.url?.path.hasSuffix("/approve") == true })
    let body = try XCTUnwrap(FixtureURLProtocol.requestBodies[approvalIndex])
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    XCTAssertEqual(object["deviceId"] as? String, "install-123")
    XCTAssertEqual(object["mode"] as? String, "demo")
    XCTAssertEqual((object["stepUpProof"] as? [String: String])?["assertion"], "signed")
    XCTAssertNotNil(
      FixtureURLProtocol.requests[approvalIndex].value(forHTTPHeaderField: "Idempotency-Key"))
    let cancellation = try XCTUnwrap(
      FixtureURLProtocol.requests.first {
        $0.httpMethod == "POST" && $0.url?.path == "/v1/orders/order-2/cancel"
      })
    XCTAssertNotNil(cancellation.value(forHTTPHeaderField: "Idempotency-Key"))
  }

  func testRiskPolicyPauseAndResumeUseCanonicalNamesAndAcknowledgements() async throws {
    FixtureURLProtocol.responseProvider = { request in
      switch (request.httpMethod, request.url?.path) {
      case ("GET", "/v1/risk-policy"):
        return (200, Data(Self.riskPolicyJSON.utf8))
      case ("POST", "/v1/risk-policy/preview"):
        return (
          200,
          Data(
            "{\"relaxationRequired\":true,\"stepUpResourceId\":\"risk-policy:policy-1:v1:7e4dd65e97fc2f46992f809782e68c646ac2c208bfddc24a3cdd9e8f944417d6\",\"currentPolicyId\":\"policy-1\",\"currentVersion\":1}"
              .utf8)
        )
      case ("PATCH", "/v1/risk-policy"):
        return (
          200,
          Data(
            Self.riskPolicyJSON.replacingOccurrences(
              of: "\"maximumDailyLoss\":500", with: "\"maximumDailyLoss\":501"
            ).utf8)
        )
      case ("POST", "/v1/risk/pause-all"):
        return (
          200,
          Data(
            "{\"paused\":true,\"occurredAt\":\"2026-08-01T14:00:00Z\",\"positionsUntouched\":true}"
              .utf8)
        )
      case ("POST", "/v1/risk/resume-all"):
        return (
          200,
          Data(
            "{\"resumed\":true,\"occurredAt\":\"2026-08-01T14:01:00Z\",\"positionsUntouched\":true}"
              .utf8)
        )
      default: return (404, Data())
      }
    }
    let stepUp = CapturingStepUpProvider()
    let repository = HTTPTreasuryRepository(
      baseURL: URL(string: "https://api.whox.ai/")!, urlSession: fixtureSession,
      expectedMode: .demo, proposalStepUpProvider: stepUp,
      authenticatedUserIDProvider: { "user-1" }, credentialProvider: { "app-token" })

    var policy = try await repository.riskPolicy()
    XCTAssertEqual(policy.maximumAllocationPercent, 60)
    XCTAssertEqual(policy.drawdownHaltPercent, 10)
    policy.dailyLossLimit = 501
    let savedPolicy = try await repository.saveRiskPolicy(policy)
    try await repository.pauseAll()
    try await repository.resumeAll()

    XCTAssertEqual(savedPolicy.maximumAllocationPercent, 60)
    XCTAssertEqual(savedPolicy.dailyLossLimit, 501)
    XCTAssertEqual(savedPolicy.excludedSymbols, [])

    let patchIndex = try XCTUnwrap(
      FixtureURLProtocol.requests.firstIndex {
        $0.url?.path == "/v1/risk-policy" && $0.httpMethod == "PATCH"
      })
    let object = try XCTUnwrap(
      JSONSerialization.jsonObject(
        with: try XCTUnwrap(FixtureURLProtocol.requestBodies[patchIndex])) as? [String: Any])
    XCTAssertEqual(object["maximumAccountAllocation"] as? Double, 0.6)
    XCTAssertEqual(object["maximumPortfolioDrawdown"] as? Double, 0.1)
    XCTAssertNil(object["maximumAllocationPercent"])
    XCTAssertEqual(object["deviceId"] as? String, "install-123")
    XCTAssertEqual((object["stepUpProof"] as? [String: String])?["assertion"], "signed")
    let stepUpCalls = await stepUp.calls()
    XCTAssertEqual(
      stepUpCalls,
      [
        .init(
          action: .relaxRiskPolicy,
          resourceID:
            "risk-policy:policy-1:v1:7e4dd65e97fc2f46992f809782e68c646ac2c208bfddc24a3cdd9e8f944417d6"
        ),
        .init(action: .resumeAllUserAgents, resourceID: "user-1"),
      ])
  }

  func testAuthoritativeOnboardingCallsEligibilityRiskLegalAndStepProgress() async throws {
    FixtureURLProtocol.responseProvider = { request in
      switch request.url?.path {
      case "/v1/legal-documents":
        return (200, Data(Self.currentLegalDocumentsJSON.utf8))
      case "/v1/eligibility":
        return (200, Data("{\"status\":\"eligible\",\"reasons\":[]}".utf8))
      case "/v1/risk-assessments":
        return (
          200,
          Data(
            "{\"classification\":\"growth\",\"optionsClassification\":\"options_restricted\"}"
              .utf8)
        )
      case "/v1/legal-consents":
        return (
          200,
          Data(
            "{\"accepted\":true,\"allRequiredCurrentDocumentsAccepted\":true}".utf8)
        )
      case "/v1/onboarding/step":
        return (200, Data(Self.completedOnboardingJSON.utf8))
      case "/v1/onboarding": return (200, Data(Self.completedOnboardingJSON.utf8))
      default: return (404, Data())
      }
    }
    let client = HTTPOnboardingPersistence(
      baseURL: URL(string: "https://api.whox.ai/")!, urlSession: fixtureSession
    ) { "app-token" }
    var draft = OnboardingDraft(riskPolicy: DemoFixtures.recommendedRiskPolicy)
    draft.country = "United States"
    draft.state = "New York"
    draft.minimumAgeStatus = .meetsRequirement
    draft.individualAccountStatus = .actingForOwnAccount
    draft.adviserClientClassification = .selfDirected
    draft.understandsNotBroker = true
    draft.investorProfileAcknowledged = true

    let eligibilityDecision = try await client.recordEligibility(draft)
    let riskDecision = try await client.recordRiskAssessment(draft)
    let legalDocuments = try await client.currentLegalDocuments()
    let legalAccepted = try await client.recordLegalConsents(legalDocuments)
    let progress = try await client.persistStep(14)
    XCTAssertTrue(eligibilityDecision.isEligible)
    XCTAssertEqual(riskDecision.classification, .growth)
    XCTAssertEqual(
      legalDocuments.map(\.id),
      [
        "terms", "privacy", "ai-risk", "broker", "subscription", "electronic", "performance",
        "ai-data",
      ])
    XCTAssertTrue(legalDocuments.allSatisfy { $0.version == "PAPER-2026.08" })
    XCTAssertTrue(legalDocuments.allSatisfy(\.productionApproved))
    XCTAssertTrue(legalDocuments.allSatisfy(\.required))
    XCTAssertEqual(
      legalDocuments.first?.contentURL,
      URL(string: "https://legal.whox.ai/terms/PAPER-2026.08"))
    XCTAssertEqual(legalDocuments.first?.contentSHA256, String(repeating: "a", count: 64))
    XCTAssertNotNil(legalDocuments.first?.publishedAt)
    XCTAssertTrue(legalAccepted)
    XCTAssertTrue(progress.completed)

    let eligibilityIndex = try XCTUnwrap(
      FixtureURLProtocol.requests.firstIndex { $0.url?.path == "/v1/eligibility" })
    let eligibility = try XCTUnwrap(
      JSONSerialization.jsonObject(
        with: try XCTUnwrap(FixtureURLProtocol.requestBodies[eligibilityIndex])) as? [String: Any])
    XCTAssertEqual(eligibility["minimumAgeStatus"] as? String, "meetsRequirement")
    XCTAssertEqual(eligibility["individualAccountStatus"] as? String, "actingForOwnAccount")
    let legalDocumentsIndex = try XCTUnwrap(
      FixtureURLProtocol.requests.firstIndex { $0.url?.path == "/v1/legal-documents" })
    let legalDocumentsRequest = FixtureURLProtocol.requests[legalDocumentsIndex]
    XCTAssertEqual(legalDocumentsRequest.httpMethod, "GET")
    XCTAssertEqual(legalDocumentsRequest.value(forHTTPHeaderField: "Accept"), "application/json")
    XCTAssertEqual(
      legalDocumentsRequest.value(forHTTPHeaderField: "Authorization"), "Bearer app-token")
    XCTAssertNil(legalDocumentsRequest.value(forHTTPHeaderField: "Idempotency-Key"))
    XCTAssertNil(FixtureURLProtocol.requestBodies[legalDocumentsIndex])
    let legalConsentIndex = try XCTUnwrap(
      FixtureURLProtocol.requests.firstIndex { $0.url?.path == "/v1/legal-consents" })
    let legalConsent = try XCTUnwrap(
      JSONSerialization.jsonObject(
        with: try XCTUnwrap(FixtureURLProtocol.requestBodies[legalConsentIndex]))
        as? [String: Any])
    XCTAssertEqual(legalConsent["accepted"] as? Bool, true)
    XCTAssertEqual(
      legalConsent["documentVersions"] as? [String: String],
      [
        "terms": "PAPER-2026.08",
        "privacy": "PAPER-2026.08",
        "ai-risk": "PAPER-2026.08",
        "broker": "PAPER-2026.08",
        "subscription": "PAPER-2026.08",
        "electronic": "PAPER-2026.08",
        "performance": "PAPER-2026.08",
        "ai-data": "PAPER-2026.08",
      ])
    let stepIndex = try XCTUnwrap(
      FixtureURLProtocol.requests.firstIndex { $0.url?.path == "/v1/onboarding/step" })
    let step = try XCTUnwrap(
      JSONSerialization.jsonObject(
        with: try XCTUnwrap(FixtureURLProtocol.requestBodies[stepIndex])) as? [String: Any])
    XCTAssertEqual(step["step"] as? Int, 14)
    XCTAssertTrue(
      FixtureURLProtocol.requests.allSatisfy {
        $0.value(forHTTPHeaderField: "Authorization") == "Bearer app-token"
      })
  }

  func testCurrentLegalDocumentsRejectInvalidOrNonproductionCatalogs() async {
    let invalidPayloads: [(name: String, json: String)] = [
      ("empty", "{\"data\":[]}"),
      (
        "nonproduction",
        Self.currentLegalDocumentsJSON.replacingOccurrences(
          of: "\"productionApproved\":true", with: "\"productionApproved\":false")
      ),
      (
        "not required",
        Self.currentLegalDocumentsJSON.replacingOccurrences(
          of: "\"required\":true", with: "\"required\":false")
      ),
      (
        "insecure URL",
        Self.currentLegalDocumentsJSON.replacingOccurrences(
          of: "https://legal.whox.ai/terms", with: "http://legal.whox.ai/terms")
      ),
      (
        "credential-bearing URL",
        Self.currentLegalDocumentsJSON.replacingOccurrences(
          of: "https://legal.whox.ai/terms", with: "https://user@legal.whox.ai/terms")
      ),
      (
        "malformed hash",
        Self.currentLegalDocumentsJSON.replacingOccurrences(
          of: String(repeating: "a", count: 64), with: "not-a-sha256")
      ),
      (
        "duplicate identifier",
        Self.currentLegalDocumentsJSON.replacingOccurrences(
          of: "\"id\":\"privacy\"", with: "\"id\":\"terms\"")
      ),
      (
        "invalid publication date",
        Self.currentLegalDocumentsJSON.replacingOccurrences(
          of: "2026-08-01T14:00:00.000Z", with: "not-a-date")
      ),
    ]
    let client = HTTPOnboardingPersistence(
      baseURL: URL(string: "https://api.whox.ai/")!, urlSession: fixtureSession
    ) { "app-token" }

    for payload in invalidPayloads {
      FixtureURLProtocol.responseData = Data(payload.json.utf8)
      do {
        _ = try await client.currentLegalDocuments()
        XCTFail("Accepted invalid legal-document catalog: \(payload.name)")
      } catch HTTPRepositoryError.invalidResponse {
        // Expected: malformed or unsafe catalogs must never become consentable.
      } catch {
        XCTFail("Unexpected error for \(payload.name): \(error)")
      }
    }
  }

  func testCurrentLegalDocumentsMapsServerUnavailabilityWithoutUsingFixtures() async {
    FixtureURLProtocol.statusCode = 503
    FixtureURLProtocol.responseData = Data(
      "{\"error\":{\"code\":\"LEGAL_DOCUMENTS_UNAVAILABLE\"}}".utf8)
    let client = HTTPOnboardingPersistence(
      baseURL: URL(string: "https://api.whox.ai/")!, urlSession: fixtureSession
    ) { "app-token" }

    do {
      _ = try await client.currentLegalDocuments()
      XCTFail("A 503 legal-document catalog must fail closed")
    } catch HTTPRepositoryError.unavailable {
      XCTAssertEqual(FixtureURLProtocol.lastRequest?.url?.path, "/v1/legal-documents")
    } catch {
      XCTFail("Unexpected error: \(error)")
    }
  }

  func testExpiredAccessTokenRotatesThenRestoresRevokesAndLogsOut() async throws {
    let initial = SessionCredentialPayload(
      accessToken: "expired-access",
      accessTokenExpiresAt: .distantPast,
      refreshToken: "refresh-one",
      refreshTokenExpiresAt: .now.addingTimeInterval(3600),
      sessionID: "session-current",
      userID: "user-1",
      displayName: "Alex",
      email: "relay@example.com")
    let store = CapturingCredentialStore(initial)
    FixtureURLProtocol.responseProvider = { request in
      switch (request.httpMethod, request.url?.path) {
      case ("POST", "/v1/auth/refresh"):
        return (
          200,
          Data(
            """
            {"accessToken":"rotated-access","accessExpiresAt":"2099-08-01T12:15:00Z","refreshToken":"refresh-two","refreshExpiresAt":"2099-09-01T12:00:00Z","sessionId":"session-current"}
            """.utf8)
        )
      case ("GET", "/v1/sessions"):
        return (
          200,
          Data(
            "{\"data\":[{\"sessionId\":\"session-current\"},{\"sessionId\":\"session-other\"}]}"
              .utf8)
        )
      case ("DELETE", "/v1/sessions/session-other"): return (204, Data())
      case ("POST", "/v1/auth/logout"): return (204, Data())
      default: return (404, Data())
      }
    }
    let client = HTTPAuthClient(
      baseURL: URL(string: "https://api.whox.ai/")!,
      credentialStore: store,
      urlSession: fixtureSession)

    let restored = try await client.restoreSession()
    let rotatedPayload = await store.payload()
    let revokedCount = try await client.revokeOtherSessions()
    XCTAssertEqual(restored?.accessToken, "rotated-access")
    XCTAssertEqual(rotatedPayload?.refreshToken, "refresh-two")
    XCTAssertEqual(revokedCount, 1)
    XCTAssertEqual(
      FixtureURLProtocol.requests.last?.value(forHTTPHeaderField: "Authorization"),
      "Bearer rotated-access")
    try await client.logout()
    let clearedPayload = await store.payload()
    XCTAssertNil(clearedPayload)
  }

  func testBrokerDisconnectRequiresServerTokenRevocationAcknowledgement() async throws {
    FixtureURLProtocol.responseData = Data(
      "{\"status\":\"disconnected\",\"tokensRevoked\":true}".utf8)
    let stepUp = CapturingStepUpProvider()
    let client = HTTPBrokerPairingClient(
      baseURL: URL(string: "https://api.whox.ai/")!, urlSession: fixtureSession,
      stepUpProvider: stepUp
    ) { "app-token" }

    try await client.disconnectConnection()

    XCTAssertEqual(FixtureURLProtocol.lastRequest?.httpMethod, "DELETE")
    XCTAssertEqual(
      FixtureURLProtocol.lastRequest?.url?.path, "/v1/brokers/robinhood/connection")
    XCTAssertNotNil(
      FixtureURLProtocol.lastRequest?.value(forHTTPHeaderField: "Idempotency-Key"))
    let calls = await stepUp.calls()
    XCTAssertEqual(
      calls, [.init(action: .disconnectBrokerConnection, resourceID: "robinhood_mcp")])
    let body = try XCTUnwrap(FixtureURLProtocol.lastRequestBody)
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    XCTAssertEqual(object["deviceId"] as? String, "install-123")
    XCTAssertEqual((object["stepUpProof"] as? [String: String])?["assertion"], "signed")
  }

  func testPaperReadinessUsesReadyzAndRequiresPersistentDependencies() async throws {
    FixtureURLProtocol.responseData = Data(
      "{\"status\":\"ready\",\"mode\":\"paper\",\"persistent\":true,\"liveTradingReachable\":false}"
        .utf8)
    let checker = HTTPRuntimeReadinessChecker(
      baseURL: URL(string: "https://api.whox.ai/")!, urlSession: fixtureSession)

    try await checker.requireReady(for: .paper)

    XCTAssertEqual(FixtureURLProtocol.lastRequest?.url?.path, "/readyz")
    FixtureURLProtocol.responseData = Data(
      "{\"status\":\"ready\",\"mode\":\"paper\",\"persistent\":false,\"liveTradingReachable\":false}"
        .utf8)
    do {
      try await checker.requireReady(for: .paper)
      XCTFail("Paper must reject an ephemeral readiness response")
    } catch let error as RuntimeAssemblyError {
      XCTAssertEqual(error, .backendUnavailable)
    }
  }

  @MainActor
  func testRuntimeAssemblyDoesNotImplicitlySelectDemoOrLive() {
    let missing = RuntimeAssembly.makeSession(
      configuration: .init(mode: nil, apiBaseURL: nil), arguments: ["tests"])
    XCTAssertEqual(missing.mode, .paper)
    XCTAssertNotNil(missing.startupBlocker)
    XCTAssertTrue(missing.positions.isEmpty)

    let live = RuntimeAssembly.makeSession(
      configuration: .init(mode: "live", apiBaseURL: "https://api.whox.ai"),
      arguments: ["tests"])
    XCTAssertEqual(live.mode, .paper)
    XCTAssertTrue(live.startupBlocker?.localizedCaseInsensitiveContains("live") == true)
  }

  private func demoHTTPRepository() -> HTTPTreasuryRepository {
    HTTPTreasuryRepository(
      baseURL: URL(string: "https://api.whox.ai/")!, urlSession: fixtureSession,
      expectedMode: .demo, proposalStepUpProvider: Self.staticStepUpProvider,
      authenticatedUserIDProvider: { "user-1" }, credentialProvider: { "app-token" })
  }

  private static let staticStepUpProvider = StaticProposalStepUpProvider(
    authorization: ProposalApprovalAuthorization(
      deviceID: "install-123", proof: ["method": "app_attest", "assertion": "signed"]))

  private static let completedOnboardingJSON =
    "{\"currentStep\":14,\"completed\":true,\"resumable\":true,\"eligibilityStatus\":\"eligible\",\"riskAssessmentStatus\":\"current\",\"legalConsentsComplete\":true}"

  private static let currentLegalDocumentsJSON = """
    {"data":[{"id":"terms","title":"Terms of Service","version":"PAPER-2026.08","productionApproved":true,"required":true,"contentURI":"https://legal.whox.ai/terms/PAPER-2026.08","contentSHA256":"\(String(repeating: "a", count: 64))","publishedAt":"2026-08-01T14:00:00.000Z"},{"id":"privacy","title":"Privacy Policy","version":"PAPER-2026.08","productionApproved":true,"required":true,"contentURI":"https://legal.whox.ai/privacy/PAPER-2026.08","contentSHA256":"\(String(repeating: "b", count: 64))","publishedAt":"2026-08-01T14:00:00.000Z"},{"id":"ai-risk","title":"AI Agent Risk Disclosure","version":"PAPER-2026.08","productionApproved":true,"required":true,"contentURI":"https://legal.whox.ai/ai-risk/PAPER-2026.08","contentSHA256":"\(String(repeating: "c", count: 64))","publishedAt":"2026-08-01T14:00:00.000Z"},{"id":"broker","title":"Brokerage Connection Disclosure","version":"PAPER-2026.08","productionApproved":true,"required":true,"contentURI":"https://legal.whox.ai/broker/PAPER-2026.08","contentSHA256":"\(String(repeating: "d", count: 64))","publishedAt":"2026-08-01T14:00:00.000Z"},{"id":"subscription","title":"Subscription Terms","version":"PAPER-2026.08","productionApproved":true,"required":true,"contentURI":"https://legal.whox.ai/subscription/PAPER-2026.08","contentSHA256":"\(String(repeating: "e", count: 64))","publishedAt":"2026-08-01T14:00:00.000Z"},{"id":"electronic","title":"Electronic Communications Consent","version":"PAPER-2026.08","productionApproved":true,"required":true,"contentURI":"https://legal.whox.ai/electronic/PAPER-2026.08","contentSHA256":"\(String(repeating: "f", count: 64))","publishedAt":"2026-08-01T14:00:00.000Z"},{"id":"performance","title":"Performance Presentation Disclosure","version":"PAPER-2026.08","productionApproved":true,"required":true,"contentURI":"https://legal.whox.ai/performance/PAPER-2026.08","contentSHA256":"\(String(repeating: "1", count: 64))","publishedAt":"2026-08-01T14:00:00.000Z"},{"id":"ai-data","title":"Data Processing and Third-Party AI Disclosure","version":"PAPER-2026.08","productionApproved":true,"required":true,"contentURI":"https://legal.whox.ai/ai-data/PAPER-2026.08","contentSHA256":"\(String(repeating: "2", count: 64))","publishedAt":"2026-08-01T14:00:00.000Z"}]}
    """

  private static let agentCatalogJSON = """
    {"data":[{"agentId":"foundation-equity","displayName":"Foundation Equity","version":"1.0.0","strategyCategory":"diversified_long_only","requiredSubscription":"equity","permittedAccountModes":["demo","paper"],"permittedInstruments":["equity"],"requiredBrokerageCapabilities":["get_equity_quotes"],"riskClassification":"moderate","typicalHoldingPeriod":"Weeks to months","analysisSchedule":"0 20 * * 1-5","entryCriteria":["liquidity passes"],"exitCriteria":["rebalance"],"dataDependencies":["portfolio"],"hardRiskRequirements":["long only"],"restrictedMarketConditions":["stale data"],"deterministicStrategyVersion":"foundation-equity-rules-1.0.0","status":"paper","disclosureText":"Investing involves loss risk.","changeLog":[{"version":"1.0.0","date":"2026-08-01","summary":"Initial paper release"}]}]}
    """

  private static let planCatalogJSON = """
    {"data":[{"id":"equity_pro","name":"Equity Pro","productId":"ai.whox.yield.equitypro.monthly","features":{"stockTrading":true,"optionsTrading":false,"multiLegOptions":false,"maximumActiveAgents":3,"automaticMode":true,"monitoringFrequencyMinutes":30,"advancedAnalytics":true,"customWatchlists":true,"scannerAccess":true,"agentCatalog":["foundation-equity","equity-momentum","quality-swing"],"prioritySupport":true},"agentCatalogVersion":1,"agents":[{"agentId":"foundation-equity","displayName":"Foundation Equity","agentVersion":"1.0.0","catalogPosition":1,"releaseStatus":"paper","deterministicStrategyVersion":"foundation-equity-rules-1.0.0","researchUniverse":["AAPL","MSFT","VTI"]},{"agentId":"equity-momentum","displayName":"Equity Momentum","agentVersion":"1.0.0","catalogPosition":2,"releaseStatus":"draft","deterministicStrategyVersion":"equity-momentum-rules-1.0.0","researchUniverse":["AAPL","MSFT","VTI"]},{"agentId":"quality-swing","displayName":"Quality Swing","agentVersion":"1.0.0","catalogPosition":3,"releaseStatus":"draft","deterministicStrategyVersion":"quality-swing-rules-1.0.0","researchUniverse":["AAPL","MSFT","VTI"]}]}],"priceSource":"StoreKit; display prices must be supplied by the client StoreKit response"}
    """

  private static let proposalRecordJSON = """
    {"id":"proposal-1","userId":"user-1","status":"AWAITING_USER_APPROVAL","proposal":{"proposalId":"proposal-1","userId":"user-1","accountId":"account-1","agentDefinitionId":"foundation-equity","agentVersion":"1.0.0","environment":"demo","instrumentType":"equity","symbol":"AAPL","optionLegs":[],"side":"buy","quantity":5,"notionalEstimate":1000,"orderType":"limit","limitPrice":200,"timeInForce":"day","strategyType":"foundation_equity","entryReason":"Diversification rule passed","exitPlan":"Rebalance","invalidationCondition":"Risk halt","dataTimestamp":"2026-08-01T13:58:00Z","quoteTimestamp":"2026-08-01T13:59:00Z","maximumLoss":1000,"breakevens":[],"estimatedPortfolioAllocationAfter":0.2,"riskAmount":1000,"confidenceCategoryWithoutProbabilityClaims":"moderate","requiredApprovalMode":"confirm_every_trade","expirationTimestamp":"2099-08-01T14:05:00Z","evidenceReferences":[],"warnings":["Demo order only"],"deterministicStrategyVersion":"foundation-equity-rules-1.0.0"},"updatedAt":"2026-08-01T14:00:00Z"}
    """

  private static let orderRecordJSON = """
    {"id":"order-1","userId":"user-1","proposalId":"proposal-1","status":"FILLED","symbol":"MSFT","side":"buy","quantity":2,"filledQuantity":2,"remainingQuantity":0,"averageFillPrice":199.5,"brokerOrderId":"broker-order-1","instrumentType":"equity","orderType":"limit","limitPrice":200,"timeInForce":"day","submittedAt":"2026-08-01T13:59:30Z","terminalAt":"2026-08-01T14:00:00Z","statusReason":null,"reconciliationStatus":"reconciled","fills":[{"id":"fill-1","timestamp":"2026-08-01T14:00:00Z","quantity":2,"price":199.5,"fees":0}],"auditTimeline":[{"status":"SUBMITTED","occurredAt":"2026-08-01T13:59:30Z","reasonCode":null},{"status":"FILLED","occurredAt":"2026-08-01T14:00:00Z","reasonCode":null}],"updatedAt":"2026-08-01T14:00:00Z","mode":"demo","dataClassification":"demo"}
    """

  private static let canceledOrderRecordJSON = """
    {"id":"order-2","userId":"user-1","proposalId":"proposal-2","status":"CANCELED","symbol":"AAPL","side":"buy","quantity":1,"filledQuantity":0,"remainingQuantity":1,"averageFillPrice":null,"brokerOrderId":"broker-order-2","instrumentType":"equity","orderType":"limit","limitPrice":190,"timeInForce":"day","submittedAt":"2026-08-01T13:59:30Z","terminalAt":"2026-08-01T14:00:00Z","statusReason":"USER_CANCELED_PAPER_ORDER","reconciliationStatus":"reconciled","fills":[],"auditTimeline":[{"status":"CANCELED","occurredAt":"2026-08-01T14:00:00Z","reasonCode":"USER_CANCELED_PAPER_ORDER"}],"updatedAt":"2026-08-01T14:00:00Z","mode":"demo","dataClassification":"demo"}
    """

  private static let riskPolicyJSON = """
    {"policyId":"policy-1","userId":"user-1","maximumAccountAllocation":0.6,"maximumPositionAmount":5000,"maximumNewOrderAmount":2000,"maximumDailyLoss":500,"maximumPortfolioDrawdown":0.1,"minimumBuyingPowerReserve":0.2,"maximumSimultaneousPositions":10,"maximumSymbolConcentration":0.15,"maximumSectorConcentration":0.3,"maximumTradesPerDay":5,"maximumDailyTurnover":0.3,"maximumOptionsExposure":0.1,"maximumOptionRiskPerTrade":500,"maximumContractsPerTrade":2,"minimumDaysToExpiration":21,"maximumDaysToExpiration":180,"maximumBidAskSpreadRatio":0.08,"maximumQuoteAgeSeconds":30,"maximumAccountSnapshotAgeSeconds":60,"maximumPriceDeviationRatio":0.02,"excludedSymbols":[],"excludedSectors":[],"fractionalSharesPermitted":true,"extendedHoursPermitted":false,"earningsTradesPermitted":false,"coveredCallsPermitted":false,"protectivePutsPermitted":false,"definedRiskSpreadsPermitted":false,"updatedAt":"2026-08-01T14:00:00Z","version":1}
    """

  private var fixtureSession: URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [FixtureURLProtocol.self]
    return URLSession(configuration: configuration)
  }
}

private actor CapturingStepUpProvider: ProposalStepUpProviding {
  struct Call: Equatable, Sendable {
    let action: SensitiveOperationAction
    let resourceID: String
  }

  private var recordedCalls: [Call] = []

  func authorization(
    for action: SensitiveOperationAction, resourceID: String
  ) async throws -> ProposalApprovalAuthorization {
    recordedCalls.append(Call(action: action, resourceID: resourceID))
    return ProposalApprovalAuthorization(
      deviceID: "install-123", proof: ["method": "app_attest", "assertion": "signed"])
  }

  func calls() -> [Call] { recordedCalls }
}

private actor CapturingCredentialStore: SessionCredentialStoring {
  private var stored: SessionCredentialPayload?
  init(_ initial: SessionCredentialPayload? = nil) { stored = initial }
  func load() async throws -> SessionCredentialPayload? { stored }
  func store(_ payload: SessionCredentialPayload) async throws { stored = payload }
  func clear() async throws { stored = nil }
  func payload() -> SessionCredentialPayload? { stored }
}

private final class FixtureURLProtocol: URLProtocol, @unchecked Sendable {
  private static let lock = NSLock()
  nonisolated(unsafe) static var responseData = Data()
  nonisolated(unsafe) static var statusCode = 200
  nonisolated(unsafe) static var lastRequest: URLRequest?
  nonisolated(unsafe) static var lastRequestBody: Data?
  nonisolated(unsafe) static var requests: [URLRequest] = []
  nonisolated(unsafe) static var requestBodies: [Data?] = []
  nonisolated(unsafe) static var responseProvider:
    (@Sendable (URLRequest) -> (statusCode: Int, data: Data))?

  static func reset() {
    lock.lock()
    defer { lock.unlock() }
    responseData = Data()
    statusCode = 200
    lastRequest = nil
    lastRequestBody = nil
    requests = []
    requestBodies = []
    responseProvider = nil
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    Self.lock.lock()
    Self.lastRequest = request
    Self.lastRequestBody = request.httpBody ?? Self.readBodyStream(request.httpBodyStream)
    Self.requests.append(request)
    Self.requestBodies.append(Self.lastRequestBody)
    let provider = Self.responseProvider
    let defaultFixture: (statusCode: Int, data: Data) = (Self.statusCode, Self.responseData)
    Self.lock.unlock()
    let fixture = provider?(request) ?? defaultFixture
    let response = HTTPURLResponse(
      url: request.url!, statusCode: fixture.statusCode, httpVersion: "HTTP/1.1",
      headerFields: ["Content-Type": "application/json"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: fixture.data)
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}

  private static func readBodyStream(_ stream: InputStream?) -> Data? {
    guard let stream else { return nil }
    stream.open()
    defer { stream.close() }
    var body = Data()
    var buffer = [UInt8](repeating: 0, count: 1_024)
    while stream.hasBytesAvailable {
      let count = stream.read(&buffer, maxLength: buffer.count)
      if count < 0 { return nil }
      if count == 0 { break }
      body.append(contentsOf: buffer.prefix(count))
    }
    return body
  }
}
