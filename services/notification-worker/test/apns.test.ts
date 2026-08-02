import assert from "node:assert/strict";
import { createCipheriv, createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import type { APNsDeviceTarget, APNsDeviceTargetSource, APNsTransport, APNsTransportRequest, APNsTransportResponse } from "../src/apns.js";
import { APNsPushProvider, decryptDeviceTokenEnvelope } from "../src/apns.js";

class Targets implements APNsDeviceTargetSource {
  public readonly invalidated: string[] = [];
  public constructor(private readonly values: readonly APNsDeviceTarget[]) {}
  public async activeTargets(): Promise<readonly APNsDeviceTarget[]> { return this.values; }
  public async invalidate(_userId: string, targetId: string): Promise<void> { this.invalidated.push(targetId); }
}

class Transport implements APNsTransport {
  public readonly requests: APNsTransportRequest[] = [];
  public constructor(private readonly responder: (request: APNsTransportRequest) => APNsTransportResponse) {}
  public async send(request: APNsTransportRequest): Promise<APNsTransportResponse> { this.requests.push(request); return this.responder(request); }
  public async close(): Promise<void> {}
}

const privateKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const configuration = { teamId: "TEAMID1234", keyId: "KEYID12345", privateKey, topic: "ai.whox.yield", allowedEnvironments: new Set(["sandbox", "production"] as const) } as const;
const message = { userId: "user-1", title: "Proposal ready", body: "Open Yield to review.", priority: "normal", deepLink: "yield://proposals", collapseId: "notification-key-1" } as const;

describe("APNs provider", () => {
  it("sends privacy-safe payloads to each environment and invalidates permanent token failures", async () => {
    const targets = new Targets([
      { id: "target-1", token: "a".repeat(64), environment: "sandbox" },
      { id: "target-2", token: "b".repeat(64), environment: "production" }
    ]);
    const transport = new Transport((request) => request.path.endsWith("b".repeat(64)) ? { status: 410, reason: "Unregistered" } : { status: 200 });
    const provider = new APNsPushProvider(configuration, targets, transport, () => new Date("2026-08-01T14:00:00Z"));
    await provider.deliver(message);
    assert.equal(transport.requests.length, 2);
    assert.deepEqual(transport.requests.map((item) => item.host).sort(), ["api.push.apple.com", "api.sandbox.push.apple.com"]);
    const payload = JSON.parse(transport.requests[0]!.body) as { aps: { alert: { body: string } }; route: string };
    assert.equal(payload.aps.alert.body, message.body);
    assert.equal(payload.route, message.deepLink);
    assert.match(transport.requests[0]!.headers.authorization!, /^bearer [^.]+\.[^.]+\.[^.]+$/);
    assert.deepEqual(targets.invalidated, ["target-2"]);
  });

  it("fails closed when no registered target can accept delivery", async () => {
    const provider = new APNsPushProvider(configuration, new Targets([]), new Transport(() => ({ status: 200 })));
    await assert.rejects(provider.deliver(message), (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "PUSH_TARGET_UNAVAILABLE");
  });

  it("acknowledges partial fan-out without retrying successful devices", async () => {
    const targets = new Targets([
      { id: "target-ok", token: "a".repeat(64), environment: "sandbox" },
      { id: "target-failed", token: "b".repeat(64), environment: "sandbox" }
    ]);
    const transport = new Transport((request) => request.path.endsWith("a".repeat(64)) ? { status: 200 } : { status: 503, reason: "ServiceUnavailable" });
    const provider = new APNsPushProvider(configuration, targets, transport, () => new Date("2026-08-01T14:00:00Z"));
    await assert.doesNotReject(provider.deliver(message));
    assert.equal(transport.requests.length, 2);
  });

  it("decrypts only the authenticated AES-GCM envelope used by the API", () => {
    const secret = Buffer.from("device-token-secret-that-is-long-enough");
    const key = createHash("sha256").update(secret).digest();
    const iv = randomBytes(12);
    const token = "c".repeat(64);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    const envelope = { v: 1, iv: iv.toString("base64url"), ciphertext: ciphertext.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") };
    assert.equal(decryptDeviceTokenEnvelope(envelope, key), token);
    assert.throws(() => decryptDeviceTokenEnvelope({ ...envelope, tag: randomBytes(16).toString("base64url") }, key), /cannot be decrypted/);
  });
});
