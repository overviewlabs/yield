import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import {
  Environment,
  InAppOwnershipType,
  SignedDataVerifier,
  Type,
  VerificationException,
  VerificationStatus,
  type JWSRenewalInfoDecodedPayload,
  type JWSTransactionDecodedPayload,
  type ResponseBodyV2DecodedPayload
} from "@apple/app-store-server-library";
import { DomainError } from "@whox/contracts";
import {
  AppleStoreKitServerNotificationVerifier,
  AppleStoreKitTransactionVerifier,
  createAppleSignedDataVerifiers,
  parseAppleRootCertificateBundle,
  type AppleSignedDataVerifier,
  type VerifiedAppStoreServerNotification
} from "../src/apple-storekit.js";
import {
  StoreKitServerNotificationService,
  type AppStoreServerNotificationRepository
} from "../src/storekit-notifications.js";
import { loadAppleStoreKitRuntime } from "../src/storekit-runtime.js";
import { createApiServer } from "../src/server.js";

const accountToken = "abcdefab-cdef-4abc-8def-abcdefabcdef";
const signedTransaction = `${"a".repeat(16)}.${"b".repeat(16)}.${"c".repeat(16)}`;
const signedRenewal = `${"d".repeat(16)}.${"e".repeat(16)}.${"f".repeat(16)}`;
const signedNotification = `${"g".repeat(16)}.${"h".repeat(16)}.${"i".repeat(16)}`;

const transaction = Object.freeze({
  originalTransactionId: "original-1",
  transactionId: "transaction-1",
  bundleId: "ai.whox.yield",
  productId: "ai.whox.yield.equity.monthly",
  purchaseDate: Date.parse("2026-08-01T14:00:00.000Z"),
  expiresDate: Date.parse("2026-09-01T14:00:00.000Z"),
  type: Type.AUTO_RENEWABLE_SUBSCRIPTION,
  appAccountToken: accountToken,
  inAppOwnershipType: InAppOwnershipType.PURCHASED,
  signedDate: Date.parse("2026-08-01T14:00:01.000Z"),
  environment: Environment.SANDBOX
}) satisfies JWSTransactionDecodedPayload;

class FakeAppleVerifier implements AppleSignedDataVerifier {
  public transactionCalls = 0;
  public renewalCalls = 0;
  public notificationCalls = 0;
  public transaction: JWSTransactionDecodedPayload = { ...transaction };
  public renewal: JWSRenewalInfoDecodedPayload = {
    originalTransactionId: "original-1",
    productId: "ai.whox.yield.equity.monthly",
    autoRenewProductId: "ai.whox.yield.equity.monthly",
    appAccountToken: accountToken,
    signedDate: Date.parse("2026-08-01T14:00:01.000Z"),
    environment: Environment.SANDBOX
  };
  public notification: ResponseBodyV2DecodedPayload = {
    notificationType: "SUBSCRIBED",
    subtype: "INITIAL_BUY",
    notificationUUID: "20000000-0000-4000-8000-000000000001",
    version: "2.0",
    signedDate: Date.parse("2026-08-01T14:00:01.000Z"),
    data: {
      environment: Environment.SANDBOX,
      bundleId: "ai.whox.yield",
      appAppleId: 123456789,
      signedTransactionInfo: signedTransaction,
      signedRenewalInfo: signedRenewal,
      status: 1
    }
  };

  public async verifyAndDecodeTransaction(): Promise<JWSTransactionDecodedPayload> {
    this.transactionCalls += 1;
    return this.transaction;
  }
  public async verifyAndDecodeRenewalInfo(): Promise<JWSRenewalInfoDecodedPayload> {
    this.renewalCalls += 1;
    return this.renewal;
  }
  public async verifyAndDecodeNotification(): Promise<ResponseBodyV2DecodedPayload> {
    this.notificationCalls += 1;
    return this.notification;
  }
}

const hasCode = (code: string) => (error: unknown): boolean => error instanceof DomainError && error.code === code;

function localJws(payload: Readonly<Record<string, unknown>>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "local-testing-signature"
  ].join(".");
}

describe("Apple StoreKit signed-data adapters", () => {
  it("matches every client field and requires the signed WHOX appAccountToken", async () => {
    const apple = new FakeAppleVerifier();
    const verifier = new AppleStoreKitTransactionVerifier(new Map([["Sandbox", apple]]));
    const input = {
      productID: transaction.productId!,
      transactionID: transaction.transactionId!,
      originalTransactionID: transaction.originalTransactionId!,
      signedTransactionJWS: localJws({ environment: "Sandbox" })
    };
    apple.transaction = { ...apple.transaction, appAccountToken: accountToken.toUpperCase() };
    const verified = await verifier.verify(input, accountToken);
    assert.equal(verified.appAccountToken, accountToken);
    assert.equal(verified.expiresAt, "2026-09-01T14:00:00.000Z");
    assert.match(verified.signedPayloadDigest!, /^[0-9a-f]{64}$/);
    await assert.rejects(verifier.verify({ ...input, transactionID: "other" }, accountToken), hasCode("SUBSCRIPTION_UNVERIFIED"));
    await assert.rejects(verifier.verify(input, "10000000-0000-4000-8000-000000000002"), hasCode("STOREKIT_ACCOUNT_TOKEN_MISMATCH"));
    await assert.rejects(verifier.verify(input), hasCode("STOREKIT_ACCOUNT_TOKEN_REQUIRED"));
  });

  it("verifies the outer notification and each nested JWS before normalizing it", async () => {
    const apple = new FakeAppleVerifier();
    const verifier = new AppleStoreKitServerNotificationVerifier("Sandbox", apple);
    const value = await verifier.verify(signedNotification);
    assert.equal(value.notificationUUID, "20000000-0000-4000-8000-000000000001");
    assert.equal(value.transaction?.originalTransactionID, "original-1");
    assert.equal(value.renewal?.originalTransactionID, "original-1");
    assert.deepEqual([apple.notificationCalls, apple.transactionCalls, apple.renewalCalls], [1, 1, 1]);
    apple.renewal = { ...apple.renewal, originalTransactionId: "other-original" };
    await assert.rejects(verifier.verify(signedNotification), hasCode("STOREKIT_NOTIFICATION_INCONSISTENT"));
  });

  it("maps Apple retryable certificate-status failures to a fail-closed 503", async () => {
    const apple = new FakeAppleVerifier();
    apple.verifyAndDecodeNotification = async () => {
      throw new VerificationException(VerificationStatus.RETRYABLE_VERIFICATION_FAILURE);
    };
    const verifier = new AppleStoreKitServerNotificationVerifier("Sandbox", apple);
    await assert.rejects(verifier.verify(signedNotification), hasCode("STOREKIT_VERIFICATION_RETRYABLE"));
  });

  it("uses Apple's official model-validation path locally and rejects the same unsigned data in Sandbox", async () => {
    const payload = {
      ...transaction,
      environment: Environment.LOCAL_TESTING
    };
    const unsigned = localJws(payload);
    const local = new SignedDataVerifier([], false, Environment.LOCAL_TESTING, "ai.whox.yield");
    const decoded = await local.verifyAndDecodeTransaction(unsigned);
    assert.equal(decoded.transactionId, "transaction-1");
    const sandbox = new SignedDataVerifier([], false, Environment.SANDBOX, "ai.whox.yield");
    await assert.rejects(sandbox.verifyAndDecodeTransaction(unsigned), VerificationException);
  });

  it("rejects invalid trust bundles and requires a numeric App Apple ID for Production", () => {
    assert.throws(() => parseAppleRootCertificateBundle("not a certificate"), hasCode("STOREKIT_ROOT_CA_REQUIRED"));
    assert.throws(
      () => createAppleSignedDataVerifiers({
        rootCertificates: [Buffer.from("placeholder")],
        bundleId: "ai.whox.yield",
        environments: ["Production"]
      }),
      hasCode("STOREKIT_APP_APPLE_ID_REQUIRED")
    );
  });

  it("never reaches durable state when JWS verification fails", async () => {
    let persisted = false;
    const verifier = {
      environment: "Sandbox" as const,
      async verify(): Promise<VerifiedAppStoreServerNotification> {
        throw new DomainError("SUBSCRIPTION_UNVERIFIED", "invalid", 422);
      }
    };
    const repository: AppStoreServerNotificationRepository = {
      async process() { persisted = true; throw new Error("must not run"); },
      async healthy() { return true; },
      async close() {}
    };
    const service = new StoreKitServerNotificationService(verifier, repository);
    await assert.rejects(service.process(signedNotification), hasCode("SUBSCRIPTION_UNVERIFIED"));
    assert.equal(persisted, false);
  });

  it("leaves Demo unchanged and fails Paper startup before accepting shared database credentials", () => {
    assert.equal(loadAppleStoreKitRuntime("demo", {}), undefined);
    assert.throws(() => loadAppleStoreKitRuntime("paper", {}), hasCode("STOREKIT_RUNTIME_CONFIGURATION_REQUIRED"));
    assert.throws(
      () => loadAppleStoreKitRuntime("paper", {
        DATABASE_URL: "postgresql://tenant-runtime",
        APP_STORE_DATABASE_URL: "postgresql://tenant-runtime",
        STOREKIT_ENVIRONMENTS: "sandbox",
        APPLE_ROOT_CA_BUNDLE: "unused",
        APPLE_BUNDLE_ID: "ai.whox.yield"
      }),
      hasCode("STOREKIT_DATABASE_CREDENTIAL_NOT_ISOLATED")
    );
  });

  it("exposes environment-specific public V2 routes and fails closed when one is not configured", async () => {
    let received = "";
    const handler = {
      environment: "Sandbox" as const,
      async process(signedPayload: string) {
        received = signedPayload;
        return { notificationUUID: "20000000-0000-4000-8000-000000000001", duplicate: false, subscriptionUpdated: true };
      }
    };
    const server = createApiServer({
      mode: "demo",
      storeKitNotificationHandlers: new Map([["Sandbox", handler]])
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const accepted = await fetch(`${base}/v1/storekit/notifications/sandbox`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signedPayload: signedNotification })
      });
      assert.equal(accepted.status, 200);
      assert.equal(received, signedNotification);
      assert.equal((await accepted.json() as { subscriptionUpdated: boolean }).subscriptionUpdated, true);
      const unavailable = await fetch(`${base}/v1/storekit/notifications/production`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signedPayload: signedNotification })
      });
      assert.equal(unavailable.status, 503);
      assert.equal((await unavailable.json() as { error: { code: string } }).error.code, "STOREKIT_NOTIFICATIONS_UNAVAILABLE");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
