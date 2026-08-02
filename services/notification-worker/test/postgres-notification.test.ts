import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import { DomainError } from "@whox/contracts";
import { Pool } from "pg";
import { PostgresNotificationRepository, type NotificationJobPayload } from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const pool = databaseUrl === undefined ? undefined : new Pool({ connectionString: databaseUrl });
after(async () => await pool?.end());

const payload = (key: string): NotificationJobPayload => Object.freeze({
  notificationType: "proposal_ready",
  priority: "normal",
  title: "Proposal ready",
  privateBody: "Review the pending AAPL proposal.",
  publicBody: "Open WHOX Treasury to review.",
  deepLink: "whoxtreasury://proposals",
  occurredAt: "2026-08-01T14:00:00.000Z",
  notificationIdempotencyKey: key
});

describe("PostgreSQL notification persistence", { skip: databaseUrl === undefined }, () => {
  it("loads server-owned privacy policy, records failures, retries, and preserves tenant isolation", async () => {
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const key = `notification-postgres-${randomUUID()}`;
    await pool!.query(`INSERT INTO users(id,status,account_mode,onboarding_step) VALUES($1,'active','paper',14),($2,'active','paper',14)`, [userId, otherUserId]);
    await pool!.query(`INSERT INTO user_profiles(user_id,profile) VALUES($1,$3::jsonb),($2,'{}'::jsonb)`, [
      userId,
      otherUserId,
      JSON.stringify({ notificationPreferences: { detailedPreviewsEnabled: true, criticalNotificationsEnabled: true, quietHours: { startMinute: 1320, endMinute: 420, utcOffsetMinutes: -240 } } })
    ]);

    const repository = new PostgresNotificationRepository(pool!);
    const policy = await repository.deliveryPolicy(userId);
    assert.deepEqual(policy, { detailedPreviewsEnabled: true, criticalNotificationsEnabled: true, quietHours: { startMinute: 1320, endMinute: 420, utcOffsetMinutes: -240 } });

    const queued = await repository.recordQueued(userId, payload(key), "2026-08-01T14:00:00.000Z");
    await repository.markFailed(userId, queued.id, "2026-08-01T14:00:01.000Z", "APNS_DELIVERY_FAILED");
    const failed = await pool!.query<{ status: string; attempts: number; audits: string }>(`SELECT n.status,n.attempts,(SELECT count(*)::text FROM audit_events WHERE resource_id=n.id::text AND action='notification.delivery_failed') AS audits FROM notifications n WHERE n.id=$1`, [queued.id]);
    assert.deepEqual(failed.rows[0], { status: "failed", attempts: 1, audits: "1" });

    const retry = await repository.recordQueued(userId, payload(key), "2026-08-01T14:01:00.000Z");
    assert.equal(retry.id, queued.id);
    await repository.markDelivered(userId, retry.id, "2026-08-01T14:01:01.000Z");
    const delivered = await pool!.query<{ status: string; attempts: number }>(`SELECT status,attempts FROM notifications WHERE id=$1`, [queued.id]);
    assert.deepEqual(delivered.rows[0], { status: "delivered", attempts: 2 });
    await assert.rejects(repository.recordQueued(userId, { ...payload(key), title: "Different" }, "2026-08-01T14:02:00.000Z"), (error: unknown) => error instanceof DomainError && error.code === "NOTIFICATION_IDEMPOTENCY_REUSED");
    await assert.rejects(repository.markDelivered(otherUserId, queued.id, "2026-08-01T14:02:01.000Z"), (error: unknown) => error instanceof DomainError && error.code === "NOTIFICATION_STATE_INVALID");
  });
});
