import { createDecipheriv, createHash, createPrivateKey, sign } from "node:crypto";
import { connect, constants, type ClientHttp2Session, type IncomingHttpHeaders, type OutgoingHttpHeaders } from "node:http2";
import { DomainError } from "@whox/contracts";
import type { Pool, PoolClient } from "pg";
import type { PushMessage, PushProvider } from "./index.js";

export type APNsEnvironment = "sandbox" | "production";

export interface APNsDeviceTarget {
  readonly id: string;
  readonly token: string;
  readonly environment: APNsEnvironment;
}

export interface APNsDeviceTargetSource {
  activeTargets(userId: string): Promise<readonly APNsDeviceTarget[]>;
  invalidate(userId: string, targetId: string, invalidatedAt: string): Promise<void>;
}

export interface APNsTransportRequest {
  readonly host: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface APNsTransportResponse {
  readonly status: number;
  readonly reason?: string;
}

export interface APNsTransport {
  send(request: APNsTransportRequest): Promise<APNsTransportResponse>;
  close(): Promise<void>;
}

export interface APNsProviderConfiguration {
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKey: string;
  readonly topic: string;
  readonly allowedEnvironments: ReadonlySet<APNsEnvironment>;
}

interface DeviceTokenRow {
  readonly id: string;
  readonly environment: string;
  readonly envelope: unknown;
}

const permanentTokenReasons = new Set(["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"]);
const providerAuthorizationReasons = new Set(["InvalidProviderToken", "ExpiredProviderToken", "MissingProviderToken", "BadCertificate", "BadCertificateEnvironment", "TopicDisallowed"]);

export class PostgresAPNsDeviceTargetSource implements APNsDeviceTargetSource {
  readonly #encryptionKey: Buffer;

  public constructor(private readonly pool: Pool, encryptionSecret: Buffer) {
    if (encryptionSecret.length < 32) throw new TypeError("Device-token encryption secret must contain at least 32 bytes");
    this.#encryptionKey = createHash("sha256").update(encryptionSecret).digest();
  }

  public async activeTargets(userId: string): Promise<readonly APNsDeviceTarget[]> {
    return await this.#withTenant(userId, async (client) => {
      const result = await client.query<DeviceTokenRow>(`SELECT dt.id::text,dt.environment,dt.token_envelope AS envelope
        FROM device_tokens dt JOIN devices d ON d.id=dt.device_id AND d.user_id=dt.user_id
        WHERE dt.user_id=$1 AND dt.invalidated_at IS NULL AND d.revoked_at IS NULL
        ORDER BY dt.created_at`, [userId]);
      return Object.freeze(result.rows.map((row) => Object.freeze({
        id: row.id,
        environment: parseEnvironment(row.environment),
        token: decryptDeviceTokenEnvelope(row.envelope, this.#encryptionKey)
      })));
    });
  }

  public async invalidate(userId: string, targetId: string, invalidatedAt: string): Promise<void> {
    await this.#withTenant(userId, async (client) => {
      await client.query(`UPDATE device_tokens SET invalidated_at=COALESCE(invalidated_at,$3::timestamptz),updated_at=$3::timestamptz
        WHERE id=$1 AND user_id=$2`, [targetId, userId, invalidatedAt]);
    });
  }

  async #withTenant<T>(userId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE whox_notification_worker");
      await client.query("SET LOCAL statement_timeout='10s'");
      await client.query(`SELECT set_config('app.user_id',$1,true)`, [userId]);
      const value = await work(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export class NodeHttp2APNsTransport implements APNsTransport {
  readonly #sessions = new Map<string, ClientHttp2Session>();

  public async send(request: APNsTransportRequest): Promise<APNsTransportResponse> {
    const session = this.#session(request.host);
    return await new Promise<APNsTransportResponse>((resolve, reject) => {
      const headers: OutgoingHttpHeaders = {
        ":method": "POST",
        ":path": request.path,
        ...request.headers
      };
      const stream = session.request(headers, { endStream: false });
      let status = 0;
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      stream.setEncoding("utf8");
      stream.setTimeout(8_000, () => {
        fail(new DomainError("APNS_TRANSPORT_TIMEOUT", "APNs did not respond before the delivery timeout", 503));
        stream.close(constants.NGHTTP2_CANCEL);
      });
      stream.on("response", (response: IncomingHttpHeaders) => { status = Number(response[":status"] ?? 0); });
      stream.on("data", (chunk: string) => {
        const value = Buffer.from(chunk, "utf8");
        size += value.length;
        if (size <= 16_384) chunks.push(value);
      });
      stream.on("end", () => {
        if (settled) return;
        settled = true;
        const text = Buffer.concat(chunks).toString("utf8");
        let reason: string | undefined;
        if (text !== "") {
          try {
            const body = JSON.parse(text) as Readonly<Record<string, unknown>>;
            if (typeof body.reason === "string") reason = body.reason;
          } catch {
            reason = "MalformedAPNsResponse";
          }
        }
        resolve(Object.freeze({ status, ...(reason === undefined ? {} : { reason }) }));
      });
      stream.on("error", fail);
      stream.end(request.body, "utf8");
    });
  }

  public async close(): Promise<void> {
    for (const session of this.#sessions.values()) session.close();
    this.#sessions.clear();
  }

  #session(host: string): ClientHttp2Session {
    const existing = this.#sessions.get(host);
    if (existing !== undefined && !existing.closed && !existing.destroyed) return existing;
    const session = connect(`https://${host}`);
    this.#sessions.set(host, session);
    const discard = (): void => { if (this.#sessions.get(host) === session) this.#sessions.delete(host); };
    session.once("close", discard);
    session.once("goaway", discard);
    session.on("error", discard);
    return session;
  }
}

export class APNsPushProvider implements PushProvider {
  readonly #privateKey: ReturnType<typeof createPrivateKey>;
  #cachedToken?: { readonly value: string; readonly expiresAt: number };

  public constructor(
    private readonly configuration: APNsProviderConfiguration,
    private readonly targets: APNsDeviceTargetSource,
    private readonly transport: APNsTransport = new NodeHttp2APNsTransport(),
    private readonly now: () => Date = () => new Date()
  ) {
    if (!/^[A-Z0-9]{8,20}$/.test(configuration.teamId) || !/^[A-Z0-9]{8,20}$/.test(configuration.keyId)) throw new TypeError("APNs team ID and key ID are invalid");
    if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(configuration.topic)) throw new TypeError("APNs topic must be an approved bundle identifier");
    if (configuration.allowedEnvironments.size === 0) throw new TypeError("At least one APNs environment must be allowed");
    this.#privateKey = createPrivateKey(configuration.privateKey);
    if (this.#privateKey.asymmetricKeyType !== "ec" || this.#privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new TypeError("APNs signing key must be an EC P-256 private key");
  }

  public async deliver(message: PushMessage): Promise<void> {
    const targets = (await this.targets.activeTargets(message.userId)).filter((target) => this.configuration.allowedEnvironments.has(target.environment));
    if (targets.length === 0) throw new DomainError("PUSH_TARGET_UNAVAILABLE", "No active APNs device target is registered", 503);
    const requestBody = pushBody(message);
    const authorization = `bearer ${this.#providerToken()}`;
    const collapseId = createHash("sha256").update(message.collapseId).digest("hex");
    const attemptedAt = this.now().toISOString();
    const results = await Promise.all(targets.map(async (target) => {
      const host = target.environment === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
      try {
        const response = await this.transport.send(Object.freeze({
          host,
          path: `/3/device/${target.token}`,
          headers: Object.freeze({
            authorization,
            "apns-topic": this.configuration.topic,
            "apns-push-type": "alert",
            "apns-priority": message.priority === "summary" ? "5" : "10",
            "apns-expiration": "0",
            "apns-collapse-id": collapseId
          }),
          body: requestBody
        }));
        return { target, response } as const;
      } catch (error) {
        return { target, error } as const;
      }
    }));
    let delivered = 0;
    const failures: unknown[] = [];
    for (const result of results) {
      if ("error" in result) { failures.push(result.error); continue; }
      if (result.response.status === 200) { delivered += 1; continue; }
      if (result.response.status === 410 || permanentTokenReasons.has(result.response.reason ?? "")) {
        await this.targets.invalidate(message.userId, result.target.id, attemptedAt);
        continue;
      }
      const reason = result.response.reason ?? `HTTP_${result.response.status}`;
      if (providerAuthorizationReasons.has(reason)) failures.push(new DomainError("APNS_AUTHORIZATION_FAILED", "APNs rejected the configured provider authorization", 503));
      else failures.push(new DomainError("APNS_DELIVERY_FAILED", "APNs did not accept the notification", 503, { reason, status: result.response.status }));
    }
    // Notifications are advisory and the app remains the source of truth. If
    // one registered target accepted this collapse ID, acknowledge the fan-out
    // instead of retrying every target that already succeeded. Only an
    // all-target failure is retried by the durable queue.
    if (delivered > 0) return;
    if (failures.length > 0) throw failures[0];
    throw new DomainError("PUSH_TARGET_UNAVAILABLE", "No active APNs device target accepted the notification", 503);
  }

  public async close(): Promise<void> { await this.transport.close(); }

  #providerToken(): string {
    const current = Math.floor(this.now().getTime() / 1_000);
    if (this.#cachedToken !== undefined && this.#cachedToken.expiresAt > current) return this.#cachedToken.value;
    const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: this.configuration.keyId }), "utf8").toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iss: this.configuration.teamId, iat: current }), "utf8").toString("base64url");
    const signingInput = `${header}.${payload}`;
    const signature = sign("sha256", Buffer.from(signingInput, "ascii"), { key: this.#privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    const value = `${signingInput}.${signature}`;
    this.#cachedToken = Object.freeze({ value, expiresAt: current + 50 * 60 });
    return value;
  }
}

export function decryptDeviceTokenEnvelope(value: unknown, encryptionKey: Buffer): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new DomainError("PUSH_TOKEN_ENVELOPE_INVALID", "APNs token envelope is invalid", 500);
  const envelope = value as Readonly<Record<string, unknown>>;
  if (envelope.v !== 1 || typeof envelope.iv !== "string" || typeof envelope.ciphertext !== "string" || typeof envelope.tag !== "string") throw new DomainError("PUSH_TOKEN_ENVELOPE_INVALID", "APNs token envelope is invalid", 500);
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(envelope.iv, "base64url"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const token = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]).toString("utf8");
    if (token.length < 32 || token.length > 4096 || token.length % 2 !== 0 || !/^[A-Fa-f0-9]+$/.test(token)) throw new Error("invalid token");
    return token;
  } catch {
    throw new DomainError("PUSH_TOKEN_ENVELOPE_INVALID", "APNs token envelope cannot be decrypted", 500);
  }
}

function parseEnvironment(value: string): APNsEnvironment {
  if (value !== "sandbox" && value !== "production") throw new DomainError("PUSH_TOKEN_ENVIRONMENT_INVALID", "APNs token environment is invalid", 500);
  return value;
}

function pushBody(message: PushMessage): string {
  const interruptionLevel = message.priority === "time_sensitive" || message.priority === "critical" ? "time-sensitive" : "active";
  const payload = {
    aps: {
      alert: { title: message.title, body: message.body },
      sound: "default",
      "interruption-level": interruptionLevel
    },
    ...(message.deepLink === undefined ? {} : { route: message.deepLink })
  };
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body, "utf8") > 4096) throw new DomainError("APNS_PAYLOAD_TOO_LARGE", "Notification payload exceeds the APNs limit", 422);
  return body;
}
