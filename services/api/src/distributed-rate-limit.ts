import { createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { DomainError } from "@whox/contracts";
import { createClient } from "redis";

export interface RateLimitResult {
  readonly remaining: number;
  readonly resetAt: number;
}

export interface ApiRateLimiter {
  consume(key: string, now?: number): RateLimitResult | Promise<RateLimitResult>;
  healthy?(): boolean | Promise<boolean>;
  close?(): void | Promise<void>;
}

interface RedisRateClient {
  readonly isOpen: boolean;
  connect(): Promise<unknown>;
  eval(
    script: string,
    options: { readonly keys: readonly string[]; readonly arguments: readonly string[] }
  ): Promise<unknown>;
  ping(): Promise<string>;
  quit(): Promise<unknown>;
  on(event: "error", listener: (error: unknown) => void): unknown;
}

export const REDIS_SLIDING_RATE_LIMIT_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]) - tonumber(ARGV[2]))
local count = redis.call('ZCARD', KEYS[1])
local maximum = tonumber(ARGV[3])
if count >= maximum then
  local first = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return {0, 0, tonumber(first[2]) + tonumber(ARGV[2])}
end
redis.call('ZADD', KEYS[1], tonumber(ARGV[1]), ARGV[4])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
local first = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
return {1, maximum - count - 1, tonumber(first[2]) + tonumber(ARGV[2])}
`;

/**
 * An atomic, replica-safe rate limiter for Paper. Connection begins eagerly,
 * but startup remains synchronous; the first health check/request awaits it.
 * Redis failure blocks the request instead of silently falling back to a
 * process-local limiter that replicas could bypass.
 */
export class RedisSlidingWindowRateLimiter implements ApiRateLimiter {
  readonly #connection: Promise<unknown>;

  public constructor(
    private readonly client: RedisRateClient,
    private readonly maximum: number,
    private readonly windowMs: number,
    private readonly prefix = "whox:api:rate"
  ) {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 1_000_000) {
      throw new TypeError("Rate-limit maximum is invalid");
    }
    if (!Number.isInteger(windowMs) || windowMs < 100 || windowMs > 86_400_000) {
      throw new TypeError("Rate-limit window is invalid");
    }
    if (!/^[A-Za-z0-9:_-]{1,100}$/.test(prefix)) throw new TypeError("Rate-limit prefix is invalid");
    client.on("error", () => {});
    this.#connection = client.connect();
  }

  public static fromUrl(url: string, maximum: number, windowMs: number): RedisSlidingWindowRateLimiter {
    if (!/^rediss?:\/\//.test(url)) throw new TypeError("REDIS_URL must use redis:// or rediss://");
    return new RedisSlidingWindowRateLimiter(createClient({ url }) as RedisRateClient, maximum, windowMs);
  }

  public async consume(key: string, now = Date.now()): Promise<RateLimitResult> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new DomainError("RATE_LIMIT_KEY_INVALID", "Rate-limit key is invalid", 500);
    if (!Number.isFinite(now) || now < 0) throw new TypeError("Rate-limit clock is invalid");
    await this.#connection;
    const result = await this.client.eval(REDIS_SLIDING_RATE_LIMIT_SCRIPT, {
      keys: [`${this.prefix}:${key}`],
      arguments: [String(Math.floor(now)), String(this.windowMs), String(this.maximum), `${Math.floor(now)}:${randomBytes(12).toString("hex")}`]
    });
    if (!Array.isArray(result) || result.length !== 3) {
      throw new DomainError("REDIS_RATE_LIMIT_INVALID", "Redis returned an invalid rate-limit result", 500);
    }
    const allowed = Number(result[0]) === 1;
    const remaining = Number(result[1]);
    const resetAt = Number(result[2]);
    if (!Number.isInteger(remaining) || remaining < 0 || remaining > this.maximum || !Number.isFinite(resetAt)) {
      throw new DomainError("REDIS_RATE_LIMIT_INVALID", "Redis returned an invalid rate-limit result", 500);
    }
    if (!allowed) {
      throw new DomainError("RATE_LIMITED", "Too many requests; try again later", 429, {
        retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1_000))
      });
    }
    return Object.freeze({ remaining, resetAt });
  }

  public async healthy(): Promise<boolean> {
    try {
      await this.#connection;
      return await this.client.ping() === "PONG";
    } catch {
      return false;
    }
  }

  public async close(): Promise<void> {
    try { await this.#connection; } catch { return; }
    if (this.client.isOpen) await this.client.quit();
  }
}

export function rateLimitClientKey(address: string, secret: Buffer): string {
  if (secret.length < 32) throw new TypeError("Rate-limit key secret must contain at least 32 bytes");
  if (isIP(address) === 0) throw new DomainError("CLIENT_ADDRESS_INVALID", "Client address is invalid", 400);
  return createHmac("sha256", secret).update(address).digest("hex");
}

/**
 * Select the address appended by the outermost configured trusted proxy.
 * Direct deployments keep trustedProxyHops at zero and ignore X-Forwarded-For.
 */
export function trustedClientAddress(
  socketAddress: string | undefined,
  forwardedFor: string | readonly string[] | undefined,
  trustedProxyHops: number
): string {
  const direct = socketAddress ?? "";
  if (!Number.isInteger(trustedProxyHops) || trustedProxyHops < 0 || trustedProxyHops > 5) {
    throw new TypeError("Trusted proxy hop count is invalid");
  }
  if (trustedProxyHops === 0) {
    if (isIP(direct) === 0) throw new DomainError("CLIENT_ADDRESS_INVALID", "Client address is invalid", 400);
    return direct;
  }
  if (typeof forwardedFor !== "string" || forwardedFor.length > 1_024) {
    throw new DomainError("FORWARDED_ADDRESS_INVALID", "Forwarded client address is invalid", 400);
  }
  const addresses = forwardedFor.split(",").map((value) => value.trim()).filter(Boolean);
  const index = addresses.length - trustedProxyHops;
  const selected = index >= 0 ? addresses[index] : undefined;
  if (selected === undefined || isIP(selected) === 0) {
    throw new DomainError("FORWARDED_ADDRESS_INVALID", "Forwarded client address is invalid", 400);
  }
  return selected;
}
