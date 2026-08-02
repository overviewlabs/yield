import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { DomainError } from "@whox/contracts";
import {
  REDIS_SLIDING_RATE_LIMIT_SCRIPT,
  RedisSlidingWindowRateLimiter,
  rateLimitClientKey,
  trustedClientAddress
} from "../src/distributed-rate-limit.js";
import { createApiServer } from "../src/server.js";

class FakeRedisClient {
  public isOpen = false;
  public result: unknown = [1, 239, 61_000];
  public keys: readonly string[] = [];
  public arguments: readonly string[] = [];
  public async connect(): Promise<void> { this.isOpen = true; }
  public async eval(script: string, options: { readonly keys: readonly string[]; readonly arguments: readonly string[] }): Promise<unknown> {
    assert.match(script, /ZREMRANGEBYSCORE/);
    this.keys = options.keys;
    this.arguments = options.arguments;
    return this.result;
  }
  public async ping(): Promise<string> { return "PONG"; }
  public async quit(): Promise<void> { this.isOpen = false; }
  public on(): void {}
}

describe("distributed API rate limiting", () => {
  it("uses one atomic Redis script and fails a denied request with retry metadata", async () => {
    const client = new FakeRedisClient();
    const limiter = new RedisSlidingWindowRateLimiter(client, 240, 60_000);
    const key = "a".repeat(64);
    assert.deepEqual(await limiter.consume(key, 1_000), { remaining: 239, resetAt: 61_000 });
    assert.deepEqual(client.keys, [`whox:api:rate:${key}`]);
    assert.deepEqual(client.arguments.slice(0, 3), ["1000", "60000", "240"]);
    client.result = [0, 0, 61_000];
    await assert.rejects(limiter.consume(key, 2_000), (error: unknown) => error instanceof DomainError && error.code === "RATE_LIMITED" && error.details?.retryAfterSeconds === 59);
    assert.equal(await limiter.healthy(), true);
    await limiter.close();
    assert.equal(client.isOpen, false);
  });

  it("hashes addresses and trusts only the configured proxy hop", () => {
    const secret = Buffer.alloc(32, 7);
    const direct = trustedClientAddress("127.0.0.1", "198.51.100.20", 0);
    const behindAlb = trustedClientAddress("10.0.0.5", "203.0.113.4, 198.51.100.20", 1);
    assert.equal(direct, "127.0.0.1");
    assert.equal(behindAlb, "198.51.100.20");
    assert.match(rateLimitClientKey(behindAlb, secret), /^[a-f0-9]{64}$/);
    assert.throws(() => trustedClientAddress("10.0.0.5", "attacker.invalid", 1), /Forwarded client address/);
  });

  it("keeps the Lua implementation stable enough for infrastructure review", () => {
    assert.match(REDIS_SLIDING_RATE_LIMIT_SCRIPT, /PEXPIRE/);
    assert.match(REDIS_SLIDING_RATE_LIMIT_SCRIPT, /maximum - count - 1/);
  });

  it("uses the configured trusted hop and limiter in the HTTP boundary", async () => {
    const consumed: string[] = [];
    let healthChecks = 0;
    const secret = Buffer.alloc(32, 9);
    const server = createApiServer({
      rateLimitKeySecret: secret,
      trustedProxyHops: 1,
      rateLimiter: {
        consume(key) { consumed.push(key); return { remaining: 239, resetAt: 61_000 }; },
        healthy() { healthChecks += 1; return true; }
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const response = await fetch(`${origin}/v1/help`, { headers: { "x-forwarded-for": "203.0.113.9" } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("ratelimit-remaining"), "239");
      assert.deepEqual(consumed, [rateLimitClientKey("203.0.113.9", secret)]);
      const ready = await fetch(`${origin}/readyz`);
      assert.equal(ready.status, 200);
      assert.equal(healthChecks, 1);
      assert.equal(consumed.length, 1, "orchestrator readiness probes do not consume the public client budget");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    }
  });
});
