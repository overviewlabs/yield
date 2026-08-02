import Observation
import StoreKit
import UIKit

enum PurchasePhase: Equatable {
  case idle
  case loadingProducts
  case purchasing(String)
  case pending
  case purchased(String)
  case canceled
  case failed(String)
}

@MainActor
@Observable
final class StoreKitService {
  private(set) var productsByID: [String: Product] = [:]
  /// Verified on-device transactions are suitable for local merchandising only.
  private(set) var localVerifiedProductIDs: Set<String> = []
  /// Only server-reconciled IDs may authorize server-run agent features.
  private(set) var serverEntitlementProductIDs: Set<String> = []
  private(set) var phase: PurchasePhase = .idle
  private(set) var lastEntitlementSync = Date.distantPast
  private(set) var statusMessage: String?
  @ObservationIgnored private var updateTask: Task<Void, Never>?
  @ObservationIgnored private let entitlementSyncClient: any EntitlementSyncClient
  @ObservationIgnored private let arguments: [String]
  @ObservationIgnored private var appAccountToken: UUID?

  init(
    entitlementSyncClient: any EntitlementSyncClient = DemoEntitlementSyncClient(),
    arguments: [String] = ProcessInfo.processInfo.arguments
  ) {
    self.entitlementSyncClient = entitlementSyncClient
    self.arguments = arguments
  }

  func start(plans: [SubscriptionPlan]) async {
    await loadProducts(plans: plans)
    await refreshEntitlements()
    guard updateTask == nil else { return }
    updateTask = Task { [weak self] in
      for await result in Transaction.updates {
        guard let self else { return }
        if case .verified(let transaction) = result {
          _ = await self.consumeVerified(transaction, jwsRepresentation: result.jwsRepresentation)
        }
      }
    }
  }

  func loadProducts(plans: [SubscriptionPlan]) async {
    phase = .loadingProducts
    do {
      let products = try await Product.products(for: plans.map(\.productID))
      productsByID = Dictionary(uniqueKeysWithValues: products.map { ($0.id, $0) })
      phase = .idle
    } catch {
      phase = .failed(
        "App Store products could not be loaded. Demo remains available; Paper requires its approved backend configuration."
      )
    }
  }

  func localizedPrice(for plan: SubscriptionPlan) -> String? {
    productsByID[plan.productID]?.displayPrice
  }

  /// Associates new App Store transactions with the authenticated WHOX account.
  /// StoreKit includes this UUID in its signed transaction and renewal payloads,
  /// allowing server notifications to resolve the tenant without trusting client data.
  func setAppAccountToken(_ token: UUID?) {
    appAccountToken = token
  }

  #if DEBUG
    var appAccountTokenForTesting: UUID? { appAccountToken }
  #endif

  func purchase(_ plan: SubscriptionPlan) async {
    guard let product = productsByID[plan.productID] else {
      phase = .failed("This App Store product is unavailable in the current storefront.")
      return
    }
    phase = .purchasing(plan.productID)
    do {
      let options: Set<Product.PurchaseOption> =
        appAccountToken.map {
          [.appAccountToken($0)]
        } ?? []
      switch try await product.purchase(options: options) {
      case .success(let verification):
        switch verification {
        case .verified(let transaction):
          if await consumeVerified(transaction, jwsRepresentation: verification.jwsRepresentation) {
            phase = .purchased(transaction.productID)
          }
        case .unverified:
          phase = .failed("The App Store transaction could not be verified.")
        }
      case .pending:
        phase = .pending
      case .userCancelled:
        phase = .canceled
      @unknown default:
        phase = .failed("The App Store returned an unknown purchase result.")
      }
    } catch {
      phase = .failed("The purchase was not completed. No plan change was applied.")
    }
  }

  func restorePurchases() async {
    if arguments.contains("-mockStoreKitRestoreSuccess") {
      await Task.yield()
      phase = .idle
      statusMessage = "Purchases restored and access refreshed."
      return
    }
    do {
      try await AppStore.sync()
      await refreshEntitlements()
      phase = .idle
      statusMessage = "Purchases restored and access refreshed."
    } catch {
      phase = .failed(
        "Purchases could not be restored. Check your App Store account and try again.")
      statusMessage = nil
    }
  }

  func refreshEntitlements() async {
    var verifiedIDs: Set<String> = []
    var authoritativeIDs = serverEntitlementProductIDs
    for await result in Transaction.currentEntitlements {
      if case .verified(let transaction) = result,
        transaction.revocationDate == nil,
        transaction.expirationDate.map({ $0 > .now }) ?? true
      {
        verifiedIDs.insert(transaction.productID)
        do {
          let acknowledgement = try await entitlementSyncClient.sync(
            envelope(for: transaction, jwsRepresentation: result.jwsRepresentation))
          authoritativeIDs = acknowledgement.entitledProductIDs
        } catch {
          phase = .failed(
            "App Store access was verified locally, but server entitlement sync failed. Agent access remains disabled."
          )
        }
      }
    }
    localVerifiedProductIDs = verifiedIDs
    serverEntitlementProductIDs = authoritativeIDs.intersection(verifiedIDs)
    lastEntitlementSync = .now
  }

  func manageSubscriptions(in scene: UIWindowScene) async {
    do {
      try await AppStore.showManageSubscriptions(in: scene)
    } catch {
      phase = .failed(
        "Subscription management could not be opened. Try again from App Store settings.")
    }
  }

  @discardableResult
  private func consumeVerified(_ transaction: Transaction, jwsRepresentation: String) async -> Bool
  {
    localVerifiedProductIDs.insert(transaction.productID)
    do {
      let acknowledgement = try await entitlementSyncClient.sync(
        envelope(for: transaction, jwsRepresentation: jwsRepresentation))
      serverEntitlementProductIDs = acknowledgement.entitledProductIDs.intersection(
        localVerifiedProductIDs)
      await transaction.finish()
      lastEntitlementSync = acknowledgement.reconciledAt
      return true
    } catch {
      phase = .failed(
        "The purchase is verified by the App Store but not yet by the WHOX server. Agent access remains disabled."
      )
      return false
    }
  }

  private func envelope(for transaction: Transaction, jwsRepresentation: String)
    -> VerifiedTransactionEnvelope
  {
    VerifiedTransactionEnvelope(
      productID: transaction.productID,
      transactionID: String(transaction.id),
      originalTransactionID: String(transaction.originalID),
      signedTransactionJWS: jwsRepresentation
    )
  }
}
