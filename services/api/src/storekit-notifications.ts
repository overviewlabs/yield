import { DomainError } from "@whox/contracts";
import { Pool, type PoolClient } from "pg";
import type {
  AppStoreServerNotificationVerifier,
  VerifiedAppStoreServerNotification
} from "./apple-storekit.js";

export interface AppStoreServerNotificationResult {
  readonly notificationUUID: string;
  readonly duplicate: boolean;
  readonly subscriptionUpdated: boolean;
}

export interface AppStoreServerNotificationRepository {
  process(notification: VerifiedAppStoreServerNotification): Promise<AppStoreServerNotificationResult>;
  healthy(): Promise<boolean>;
  close(): Promise<void>;
}

export interface AppStoreServerNotificationHandler {
  readonly environment: "Sandbox" | "Production";
  process(signedPayload: string): Promise<AppStoreServerNotificationResult>;
}

export class StoreKitServerNotificationService implements AppStoreServerNotificationHandler {
  public readonly environment: "Sandbox" | "Production";

  public constructor(
    private readonly verifier: AppStoreServerNotificationVerifier,
    private readonly repository: AppStoreServerNotificationRepository
  ) {
    this.environment = verifier.environment;
  }

  public async process(signedPayload: string): Promise<AppStoreServerNotificationResult> {
    return await this.repository.process(await this.verifier.verify(signedPayload));
  }
}

export class UnavailableStoreKitServerNotificationHandler implements AppStoreServerNotificationHandler {
  public constructor(public readonly environment: "Sandbox" | "Production") {}
  public async process(): Promise<AppStoreServerNotificationResult> {
    throw new DomainError(
      "STOREKIT_NOTIFICATIONS_UNAVAILABLE",
      `App Store Server Notifications V2 ${this.environment} verification is not configured`,
      503
    );
  }
}

type SubscriptionStatus = "active" | "grace_period" | "billing_retry" | "expired" | "revoked" | "refunded";

function subscriptionStatus(notification: VerifiedAppStoreServerNotification): SubscriptionStatus | undefined {
  switch (notification.appStoreStatus) {
    case 1: return "active";
    case 2: return "expired";
    case 3: return "billing_retry";
    case 4: return "grace_period";
    case 5: return notification.notificationType === "REFUND" ? "refunded" : "revoked";
    default: break;
  }
  switch (notification.notificationType) {
    case "SUBSCRIBED":
    case "OFFER_REDEEMED":
    case "DID_RENEW":
    case "RENEWAL_EXTENDED":
    case "REFUND_REVERSED": return "active";
    case "EXPIRED":
    case "GRACE_PERIOD_EXPIRED": return "expired";
    case "DID_FAIL_TO_RENEW": return notification.subtype === "GRACE_PERIOD" ? "grace_period" : "billing_retry";
    case "REFUND": return "refunded";
    case "REVOKE": return "revoked";
    default: {
      const transaction = notification.transaction;
      if (transaction?.revokedAt !== undefined) return "revoked";
      if (transaction?.expiresAt !== undefined && transaction.expiresAt <= notification.signedAt) return "expired";
      return transaction === undefined ? undefined : "active";
    }
  }
}

function normalizedPayload(notification: VerifiedAppStoreServerNotification): Readonly<Record<string, unknown>> {
  return Object.freeze({
    notificationUUID: notification.notificationUUID,
    notificationType: notification.notificationType,
    ...(notification.subtype === undefined ? {} : { subtype: notification.subtype }),
    version: notification.version,
    environment: notification.environment,
    signedAt: notification.signedAt,
    ...(notification.appStoreStatus === undefined ? {} : { appStoreStatus: notification.appStoreStatus }),
    ...(notification.transaction === undefined ? {} : {
      transaction: {
        transactionID: notification.transaction.transactionID,
        originalTransactionID: notification.transaction.originalTransactionID,
        productID: notification.transaction.productID,
        ...(notification.transaction.purchasedAt === undefined ? {} : { purchasedAt: notification.transaction.purchasedAt }),
        ...(notification.transaction.expiresAt === undefined ? {} : { expiresAt: notification.transaction.expiresAt }),
        ...(notification.transaction.revokedAt === undefined ? {} : { revokedAt: notification.transaction.revokedAt })
      }
    }),
    ...(notification.renewal === undefined ? {} : {
      renewal: {
        originalTransactionID: notification.renewal.originalTransactionID,
        ...(notification.renewal.productID === undefined ? {} : { productID: notification.renewal.productID }),
        ...(notification.renewal.autoRenewProductID === undefined ? {} : { autoRenewProductID: notification.renewal.autoRenewProductID }),
        ...(notification.renewal.isInBillingRetryPeriod === undefined ? {} : { isInBillingRetryPeriod: notification.renewal.isInBillingRetryPeriod }),
        ...(notification.renewal.gracePeriodExpiresAt === undefined ? {} : { gracePeriodExpiresAt: notification.renewal.gracePeriodExpiresAt }),
        ...(notification.renewal.renewalAt === undefined ? {} : { renewalAt: notification.renewal.renewalAt })
      }
    })
  });
}

function accountToken(notification: VerifiedAppStoreServerNotification): string | null {
  return notification.transaction?.appAccountToken ?? notification.renewal?.appAccountToken ?? null;
}

function originalTransactionID(notification: VerifiedAppStoreServerNotification): string | null {
  return notification.transaction?.originalTransactionID ?? notification.renewal?.originalTransactionID ?? null;
}

function errorCode(error: unknown): string {
  if (error instanceof DomainError) return error.code;
  return "STOREKIT_NOTIFICATION_PERSISTENCE_FAILED";
}

/**
 * Durable, globally idempotent notification storage. This must receive a
 * database login that can SET ROLE only to whox_app_store_notifications; it is
 * intentionally separate from DATABASE_URL used by the public tenant API.
 */
export class PostgresAppStoreServerNotificationRepository implements AppStoreServerNotificationRepository {
  readonly #pool: Pool;
  readonly #runtimeRole: string;

  public constructor(databaseUrl: string, runtimeRole = "whox_app_store_notifications") {
    if (databaseUrl.trim() === "") throw new TypeError("APP_STORE_DATABASE_URL is required");
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole)) throw new TypeError("App Store database runtime role is invalid");
    this.#runtimeRole = runtimeRole;
    this.#pool = new Pool({ connectionString: databaseUrl, application_name: "whox-app-store-notifications", max: 4 });
  }

  async #begin(client: PoolClient): Promise<void> {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${this.#runtimeRole}`);
    await client.query("SET LOCAL statement_timeout='10s'");
    await client.query("SET LOCAL lock_timeout='5s'");
  }

  async #recordFailure(notification: VerifiedAppStoreServerNotification, code: string): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await this.#begin(client);
      await client.query(
        `INSERT INTO app_store_server_notifications(
          notification_uuid,environment,notification_type,subtype,version,signed_at,
          signed_payload_digest,processing_status,attempt_count,last_attempt_at,error_code,normalized_payload
        ) VALUES($1,$2,$3,$4,$5,$6,$7,'failed',1,clock_timestamp(),$8,$9::jsonb)
        ON CONFLICT(notification_uuid) DO UPDATE SET
          processing_status=CASE WHEN app_store_server_notifications.processing_status='processed' THEN 'processed' ELSE 'failed' END,
          attempt_count=app_store_server_notifications.attempt_count+1,
          last_attempt_at=clock_timestamp(),
          error_code=CASE WHEN app_store_server_notifications.processing_status='processed' THEN NULL ELSE EXCLUDED.error_code END
        WHERE app_store_server_notifications.signed_payload_digest=EXCLUDED.signed_payload_digest`,
        [
          notification.notificationUUID,
          notification.environment.toLowerCase(),
          notification.notificationType,
          notification.subtype ?? null,
          notification.version,
          notification.signedAt,
          notification.signedPayloadDigest,
          code,
          JSON.stringify(normalizedPayload(notification))
        ]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async process(notification: VerifiedAppStoreServerNotification): Promise<AppStoreServerNotificationResult> {
    const client = await this.#pool.connect();
    let began = false;
    let committedError: DomainError | undefined;
    try {
      await this.#begin(client);
      began = true;
      const inserted = await client.query(
        `INSERT INTO app_store_server_notifications(
          notification_uuid,environment,notification_type,subtype,version,signed_at,
          signed_payload_digest,processing_status,attempt_count,last_attempt_at,normalized_payload
        ) VALUES($1,$2,$3,$4,$5,$6,$7,'processing',1,clock_timestamp(),$8::jsonb)
        ON CONFLICT(notification_uuid) DO NOTHING`,
        [
          notification.notificationUUID,
          notification.environment.toLowerCase(),
          notification.notificationType,
          notification.subtype ?? null,
          notification.version,
          notification.signedAt,
          notification.signedPayloadDigest,
          JSON.stringify(normalizedPayload(notification))
        ]
      );
      const claimed = await client.query<{ signedPayloadDigest: string; processingStatus: string }>(
        `SELECT signed_payload_digest AS "signedPayloadDigest",processing_status AS "processingStatus"
         FROM app_store_server_notifications WHERE notification_uuid=$1 FOR UPDATE`,
        [notification.notificationUUID]
      );
      const row = claimed.rows[0];
      if (row === undefined) throw new DomainError("STOREKIT_NOTIFICATION_PERSISTENCE_FAILED", "Notification replay journal is unavailable", 503);
      if (row.signedPayloadDigest !== notification.signedPayloadDigest) {
        throw new DomainError("STOREKIT_NOTIFICATION_REPLAY_CONFLICT", "Notification UUID was reused with a different signed payload", 409);
      }
      if (row.processingStatus === "processed") {
        await client.query("COMMIT");
        began = false;
        return Object.freeze({ notificationUUID: notification.notificationUUID, duplicate: true, subscriptionUpdated: false });
      }
      if (inserted.rowCount === 0) {
        await client.query(
          `UPDATE app_store_server_notifications SET processing_status='processing',attempt_count=attempt_count+1,
           last_attempt_at=clock_timestamp(),error_code=NULL WHERE notification_uuid=$1`,
          [notification.notificationUUID]
        );
      }

      const originalID = originalTransactionID(notification);
      if (originalID === null) {
        await client.query(
          `UPDATE app_store_server_notifications SET processing_status='processed',processed_at=clock_timestamp()
           WHERE notification_uuid=$1`,
          [notification.notificationUUID]
        );
        await client.query("COMMIT");
        began = false;
        return Object.freeze({ notificationUUID: notification.notificationUUID, duplicate: false, subscriptionUpdated: false });
      }

      const resolved = await client.query<{ userId: string | null }>(
        `SELECT app.resolve_storekit_notification_tenant($1,$2,$3)::text AS "userId"`,
        [originalID, notification.environment.toLowerCase(), accountToken(notification)]
      );
      const userId = resolved.rows[0]?.userId ?? null;
      if (userId === null) {
        await client.query(
          `UPDATE app_store_server_notifications SET processing_status='unmatched',original_transaction_id=$2,
           transaction_id=$3,error_code='STOREKIT_NOTIFICATION_TENANT_UNRESOLVED' WHERE notification_uuid=$1`,
          [notification.notificationUUID, originalID, notification.transaction?.transactionID ?? null]
        );
        await client.query("COMMIT");
        began = false;
        committedError = new DomainError(
          "STOREKIT_NOTIFICATION_TENANT_UNRESOLVED",
          "Verified notification is not yet associated with a WHOX account",
          503
        );
      } else {
        await client.query("SELECT set_config('app.user_id',$1,true)", [userId]);
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `${notification.environment}:${originalID}`
        ]);
        const status = subscriptionStatus(notification);
        let subscriptionId: string | undefined;
        let subscriptionUpdated = false;
        const current = await client.query<{ id: string }>(
          `SELECT id::text FROM subscriptions WHERE user_id=$1 AND original_transaction_id=$2 AND environment=$3`,
          [userId, originalID, notification.environment.toLowerCase()]
        );
        subscriptionId = current.rows[0]?.id;
        const stale = subscriptionId === undefined ? false : (await client.query<{ stale: boolean }>(
          `SELECT EXISTS(
             SELECT 1 FROM subscription_events WHERE subscription_id=$1 AND event_timestamp>$2::timestamptz
           ) AS stale`,
          [subscriptionId, notification.signedAt]
        )).rows[0]?.stale === true;
        if (notification.transaction !== undefined) {
          const plan = await client.query<{ id: string }>(
            "SELECT id::text FROM plans WHERE product_id=$1 AND active=true",
            [notification.transaction.productID]
          );
          const planId = plan.rows[0]?.id;
          if (planId === undefined) throw new DomainError("SUBSCRIPTION_PRODUCT_UNKNOWN", "Verified App Store product is not configured", 422);
          const effectiveAt = notification.transaction.purchasedAt ?? notification.signedAt;
          const expiresAt = status === "grace_period"
            ? notification.renewal?.gracePeriodExpiresAt ?? notification.transaction.expiresAt ?? null
            : notification.transaction.expiresAt ?? null;
          const revokedAt = status === "revoked" || status === "refunded"
            ? notification.transaction.revokedAt ?? notification.signedAt
            : null;
          if (!stale) {
            const upserted = await client.query<{ id: string }>(
              `INSERT INTO subscriptions(user_id,plan_id,original_transaction_id,status,environment,effective_at,expires_at,revoked_at)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8)
               ON CONFLICT(original_transaction_id,environment) DO UPDATE SET
                 plan_id=EXCLUDED.plan_id,status=EXCLUDED.status,effective_at=LEAST(subscriptions.effective_at,EXCLUDED.effective_at),
                 expires_at=EXCLUDED.expires_at,revoked_at=EXCLUDED.revoked_at,updated_at=clock_timestamp()
               WHERE subscriptions.user_id=EXCLUDED.user_id
               RETURNING id::text`,
              [
                userId,
                planId,
                originalID,
                status ?? "active",
                notification.environment.toLowerCase(),
                effectiveAt,
                expiresAt,
                revokedAt
              ]
            );
            subscriptionId = upserted.rows[0]?.id;
            if (subscriptionId === undefined) throw new DomainError("STOREKIT_ACCOUNT_TOKEN_MISMATCH", "Original transaction belongs to a different WHOX account", 409);
            subscriptionUpdated = true;
          }
        } else {
          if (subscriptionId === undefined) throw new DomainError("STOREKIT_NOTIFICATION_TENANT_UNRESOLVED", "Subscription has not been synchronized", 503);
          if (status !== undefined && !stale) {
            const expiresAt = status === "grace_period" ? notification.renewal?.gracePeriodExpiresAt ?? null : null;
            await client.query(
              `UPDATE subscriptions SET status=$3,
               expires_at=CASE WHEN $4::timestamptz IS NULL THEN expires_at ELSE $4::timestamptz END,
               revoked_at=CASE WHEN $3 IN ('revoked','refunded') THEN $5::timestamptz ELSE NULL END,
               updated_at=clock_timestamp() WHERE id=$1 AND user_id=$2`,
              [subscriptionId, userId, status, expiresAt, notification.signedAt]
            );
            subscriptionUpdated = true;
          }
        }
        const transactionID = notification.transaction?.transactionID ?? `notification:${notification.notificationUUID}`;
        await client.query(
          `INSERT INTO subscription_events(
            subscription_id,transaction_id,event_type,signed_payload_digest,event_timestamp,idempotency_key,payload
           ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING`,
          [
            subscriptionId,
            transactionID,
            `app_store:${notification.notificationType}:${notification.subtype ?? "none"}`,
            notification.signedPayloadDigest,
            notification.signedAt,
            `app-store-notification:${notification.notificationUUID}`,
            JSON.stringify(normalizedPayload(notification))
          ]
        );
        await client.query(
          `UPDATE app_store_server_notifications SET processing_status='processed',processed_at=clock_timestamp(),
           user_id=$2,original_transaction_id=$3,transaction_id=$4,error_code=NULL WHERE notification_uuid=$1`,
          [notification.notificationUUID, userId, originalID, notification.transaction?.transactionID ?? null]
        );
        await client.query("COMMIT");
        began = false;
        return Object.freeze({ notificationUUID: notification.notificationUUID, duplicate: false, subscriptionUpdated });
      }
    } catch (error) {
      if (began) await client.query("ROLLBACK").catch(() => undefined);
      try { await this.#recordFailure(notification, errorCode(error)); } catch { /* preserve the original failure */ }
      if (error instanceof DomainError) throw error;
      throw new DomainError("STOREKIT_NOTIFICATION_PERSISTENCE_FAILED", "Verified notification could not be durably processed", 503);
    } finally {
      client.release();
    }
    if (committedError !== undefined) throw committedError;
    throw new DomainError("STOREKIT_NOTIFICATION_PERSISTENCE_FAILED", "Verified notification processing did not complete", 503);
  }

  public async healthy(): Promise<boolean> {
    const client = await this.#pool.connect();
    try {
      await this.#begin(client);
      const result = await client.query<{ ready: boolean }>(
        `SELECT to_regclass('public.app_store_server_notifications') IS NOT NULL AND
         to_regprocedure('app.resolve_storekit_notification_tenant(text,text,text)') IS NOT NULL AS ready`
      );
      await client.query("ROLLBACK");
      return result.rows[0]?.ready === true;
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      return false;
    } finally { client.release(); }
  }

  public async close(): Promise<void> {
    await this.#pool.end();
  }
}
