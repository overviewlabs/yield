import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { DomainError } from "@whox/contracts";
import { Pool } from "pg";
import type { VerifiedAppStoreServerNotification } from "../src/apple-storekit.js";
import { PostgresAppStoreServerNotificationRepository } from "../src/storekit-notifications.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const hasCode = (code: string) => (error: unknown): boolean => error instanceof DomainError && error.code === code;

function notification(
  userId: string,
  notificationUUID: string,
  overrides: Partial<VerifiedAppStoreServerNotification> = {}
): VerifiedAppStoreServerNotification {
  return Object.freeze({
    notificationUUID,
    notificationType: "SUBSCRIBED",
    subtype: "INITIAL_BUY",
    version: "2.0",
    environment: "Sandbox",
    signedAt: "2026-08-01T14:00:00.000Z",
    signedPayloadDigest: "a".repeat(64),
    appStoreStatus: 1,
    transaction: Object.freeze({
      productID: "ai.whox.yield.equity.monthly",
      transactionID: `transaction-${notificationUUID}`,
      originalTransactionID: `original-${notificationUUID}`,
      environment: "Sandbox",
      signedPayloadDigest: "b".repeat(64),
      appAccountToken: userId,
      purchasedAt: "2026-08-01T13:59:00.000Z",
      expiresAt: "2026-09-01T14:00:00.000Z",
      signedAt: "2026-08-01T14:00:00.000Z"
    }),
    ...overrides
  });
}

describe("App Store Server Notifications PostgreSQL journal", { skip: databaseUrl === undefined }, () => {
  it("updates tenant subscriptions once, preserves newer state, and journals only normalized data", async () => {
    const admin = new Pool({ connectionString: databaseUrl! });
    const repository = new PostgresAppStoreServerNotificationRepository(databaseUrl!);
    const userId = randomUUID();
    const firstUUID = randomUUID();
    const originalID = `original-${firstUUID}`;
    try {
      await admin.query(
        `INSERT INTO users(id,status,display_name,account_mode) VALUES($1,'active','StoreKit test','paper')`,
        [userId]
      );
      const first = notification(userId, firstUUID);
      assert.deepEqual(await repository.process(first), {
        notificationUUID: firstUUID,
        duplicate: false,
        subscriptionUpdated: true
      });
      assert.deepEqual(await repository.process(first), {
        notificationUUID: firstUUID,
        duplicate: true,
        subscriptionUpdated: false
      });

      const graceUUID = randomUUID();
      const grace = notification(userId, graceUUID, {
        notificationType: "DID_FAIL_TO_RENEW",
        subtype: "GRACE_PERIOD",
        signedAt: "2026-08-01T15:00:00.000Z",
        signedPayloadDigest: "c".repeat(64),
        appStoreStatus: 4,
        transaction: Object.freeze({
          ...first.transaction!,
          transactionID: `transaction-${graceUUID}`,
          signedAt: "2026-08-01T15:00:00.000Z"
        }),
        renewal: Object.freeze({
          originalTransactionID: originalID,
          environment: "Sandbox",
          appAccountToken: userId,
          isInBillingRetryPeriod: true,
          gracePeriodExpiresAt: "2026-08-08T15:00:00.000Z",
          signedAt: "2026-08-01T15:00:00.000Z"
        })
      });
      assert.equal((await repository.process(grace)).subscriptionUpdated, true);

      const staleUUID = randomUUID();
      const stale = notification(userId, staleUUID, {
        notificationType: "EXPIRED",
        subtype: undefined,
        signedAt: "2026-08-01T14:30:00.000Z",
        signedPayloadDigest: "d".repeat(64),
        appStoreStatus: 2,
        transaction: Object.freeze({
          ...first.transaction!,
          transactionID: `transaction-${staleUUID}`,
          signedAt: "2026-08-01T14:30:00.000Z"
        })
      });
      assert.equal((await repository.process(stale)).subscriptionUpdated, false);

      const state = await admin.query<{ status: string; expiresAt: Date }>(
        `SELECT status,expires_at AS "expiresAt" FROM subscriptions
         WHERE user_id=$1 AND original_transaction_id=$2 AND environment='sandbox'`,
        [userId, originalID]
      );
      assert.equal(state.rows[0]?.status, "grace_period");
      assert.equal(state.rows[0]?.expiresAt.toISOString(), "2026-08-08T15:00:00.000Z");
      const events = await admin.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM subscription_events WHERE subscription_id=(SELECT id FROM subscriptions WHERE user_id=$1 AND original_transaction_id=$2)",
        [userId, originalID]
      );
      assert.equal(events.rows[0]?.count, "3");
      const journal = await admin.query<{ processingStatus: string; attemptCount: number; payload: string }>(
        `SELECT processing_status AS "processingStatus",attempt_count AS "attemptCount",normalized_payload::text AS payload
         FROM app_store_server_notifications WHERE notification_uuid=$1`,
        [firstUUID]
      );
      assert.equal(journal.rows[0]?.processingStatus, "processed");
      assert.equal(journal.rows[0]?.attemptCount, 1);
      assert.doesNotMatch(journal.rows[0]?.payload ?? "", new RegExp(userId, "i"));
      assert.doesNotMatch(journal.rows[0]?.payload ?? "", /signedPayload/i);

      await assert.rejects(
        repository.process({ ...first, signedPayloadDigest: "e".repeat(64) }),
        hasCode("STOREKIT_NOTIFICATION_REPLAY_CONFLICT")
      );
    } finally {
      await repository.close();
      await admin.end();
    }
  });

  it("durably records an unmatched verified notification before requesting an Apple retry", async () => {
    const admin = new Pool({ connectionString: databaseUrl! });
    const repository = new PostgresAppStoreServerNotificationRepository(databaseUrl!);
    const notificationUUID = randomUUID();
    try {
      await assert.rejects(
        repository.process(notification(randomUUID(), notificationUUID)),
        hasCode("STOREKIT_NOTIFICATION_TENANT_UNRESOLVED")
      );
      const result = await admin.query<{ processingStatus: string; errorCode: string }>(
        `SELECT processing_status AS "processingStatus",error_code AS "errorCode"
         FROM app_store_server_notifications WHERE notification_uuid=$1`,
        [notificationUUID]
      );
      assert.equal(result.rows[0]?.processingStatus, "unmatched");
      assert.equal(result.rows[0]?.errorCode, "STOREKIT_NOTIFICATION_TENANT_UNRESOLVED");
    } finally {
      await repository.close();
      await admin.end();
    }
  });
});
