import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/config.js";
import { ConfigError } from "../../src/config/env.js";
import type { Database } from "../../src/db/pool.js";
import {
  PUBLIC_API_BUDGETS,
  RedisRateLimitStore,
  type RateLimitStore,
  type SharedCounterRedis,
} from "../../src/http/rate-limit.js";
import { buildServer } from "../../src/http/server.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const ACTIVE_DEPLOYMENTS = join(THIS_DIR, "..", "..", "deployments", "testnet.json");

class FakeDb {
  query(text: string): Promise<{ rows: readonly Record<string, unknown>[]; rowCount: number }> {
    if (text.includes("FROM outbound_transfer t")) {
      return Promise.resolve({
        rows: [
          {
            id: "7",
            origin_chain: "stellar-testnet",
            route: 0,
            nonce: "42",
            sender: "GDXRQQETEZHGRJTE3U7DYGIWGGYGMM6EAS5NWGPGN2WXFXZYZ6QZIANA",
            token: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
            gross_amount: "10000000",
            fee: "30000",
            net_amount: "9970000",
            destination_chain: "sepolia",
            destination: "0x0000000000000000000000006ef8032ffe4943f27388172549f6700f18bb8b38",
            rail_ref: null,
            origin_block: "5433810",
            origin_tx: "source-tx-42",
            observed_at: new Date("2026-10-30T12:00:00Z"),
            attestation_status: "delivered",
            rail_status: "complete",
            rail_reference: "iris-42",
            attested_at: new Date("2026-10-30T12:01:00Z"),
            last_error: null,
            inbound_delivered: true,
            destination_block: "400",
            destination_tx: "0xdest42",
            received_token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
            received_amount: "897000",
            delivered_at: new Date("2026-10-30T12:02:00Z"),
            claim_id: null,
            claim_settled: false,
          },
        ],
        rowCount: 1,
      });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }
}

class InMemoryRedisCounter implements SharedCounterRedis {
  private readonly entries = new Map<string, { value: number; expiresAt: number }>();

  constructor(private readonly now: () => number) {}

  incr(key: string): Promise<number> {
    const current = this.entries.get(key);
    const nowMs = this.now();
    if (current === undefined || current.expiresAt <= nowMs) {
      this.entries.set(key, { value: 1, expiresAt: nowMs + 60_000 });
      return Promise.resolve(1);
    }
    current.value += 1;
    return Promise.resolve(current.value);
  }

  pttl(key: string): Promise<number> {
    const current = this.entries.get(key);
    if (current === undefined) return Promise.resolve(-2);
    const remaining = current.expiresAt - this.now();
    return Promise.resolve(remaining > 0 ? remaining : -2);
  }

  pexpire(key: string, milliseconds: number): Promise<unknown> {
    const current = this.entries.get(key);
    if (current !== undefined) {
      current.expiresAt = this.now() + milliseconds;
    }
    return Promise.resolve(1);
  }
}

describe("public API rate limiting and shared deployment budgets", () => {
  const baseConfig = loadConfig({
    env: completeEnv({
      HYPERION_DEPLOYMENTS_FILE: ACTIVE_DEPLOYMENTS,
      INDEXER_ENABLED: "false",
      RAILS_ENABLED: "false",
      KEEPER_ENABLED: "false",
    }),
  });

  it("ignores spoofed forwarded headers by default and takes only the trusted right-hand hop when configured", async () => {
    const { logger } = capturingLogger();
    const clock = Date.parse("2026-10-30T12:00:00.000Z");

    const untrustedApp = buildServer({
      config: baseConfig,
      logger,
      db: new FakeDb() as unknown as Database,
      readiness: [],
      rateLimit: {
        enabled: true,
        trustProxyHops: 0,
        now: () => clock,
        budgets: {
          public_read: { clientMax: 2, deploymentMax: 100, windowMs: 60_000 },
        },
      },
    });

    // Rotating X-Forwarded-For on every request must NOT bypass the 2-request client budget.
    const r1 = await untrustedApp.inject({
      method: "GET",
      url: "/v1/transfers",
      remoteAddress: "198.51.100.25",
      headers: { "x-forwarded-for": "203.0.113.1" },
    });
    const r2 = await untrustedApp.inject({
      method: "GET",
      url: "/v1/transfers",
      remoteAddress: "198.51.100.25",
      headers: { "x-forwarded-for": "203.0.113.2" },
    });
    const r3 = await untrustedApp.inject({
      method: "GET",
      url: "/v1/transfers",
      remoteAddress: "198.51.100.25",
      headers: { "x-forwarded-for": "203.0.113.3" },
    });

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r3.statusCode).toBe(429);
    expect(r3.json().error).toBe("too_many_requests");
    await untrustedApp.close();

    // With trustProxyHops = 1 behind a trusted edge proxy, leftmost client-injected hops cannot spoof identity.
    const singleProxyApp = buildServer({
      config: baseConfig,
      logger,
      db: new FakeDb() as unknown as Database,
      readiness: [],
      rateLimit: {
        enabled: true,
        trustProxyHops: 1,
        trustedProxies: ["10.0.0.10"],
        now: () => clock,
        budgets: {
          public_read: { clientMax: 1, deploymentMax: 100, windowMs: 60_000 },
        },
      },
    });

    const p1 = await singleProxyApp.inject({
      method: "GET",
      url: "/v1/claims",
      remoteAddress: "10.0.0.10",
      headers: { "x-forwarded-for": "192.0.2.11, 203.0.113.88" },
    });
    const p2 = await singleProxyApp.inject({
      method: "GET",
      url: "/v1/claims",
      remoteAddress: "10.0.0.10",
      headers: { "x-forwarded-for": "192.0.2.99, 203.0.113.88" },
    });
    expect(p1.statusCode).toBe(200);
    expect(p2.statusCode).toBe(429);
    await singleProxyApp.close();
  });

  it("isolates health and operational probe budgets from public read and stream saturation", async () => {
    const { logger } = capturingLogger();
    const clock = Date.parse("2026-10-30T12:00:00.000Z");

    expect(PUBLIC_API_BUDGETS.probe.clientMax).toBe(300);
    expect(PUBLIC_API_BUDGETS.operational.clientMax).toBe(60);
    expect(PUBLIC_API_BUDGETS.public_read.clientMax).toBe(120);
    expect(PUBLIC_API_BUDGETS.public_stream.clientMax).toBe(30);

    const app = buildServer({
      config: baseConfig,
      logger,
      db: new FakeDb() as unknown as Database,
      readiness: [],
      rateLimit: {
        enabled: true,
        now: () => clock,
        budgets: {
          public_read: { clientMax: 1, deploymentMax: 50, windowMs: 60_000 },
          public_stream: { clientMax: 1, deploymentMax: 50, windowMs: 60_000 },
          probe: { clientMax: 5, deploymentMax: 50, windowMs: 60_000 },
          operational: { clientMax: 3, deploymentMax: 50, windowMs: 60_000 },
        },
      },
    });

    // Exhaust public_read and public_stream for this caller.
    expect((await app.inject("/v1/routes/health")).statusCode).toBe(200);
    expect((await app.inject("/v1/routes/health")).statusCode).toBe(429);

    const stream1 = await app.inject("/v1/transfers/7/stream");
    expect(stream1.statusCode).toBe(200);
    expect(stream1.headers["x-ratelimit-scope"]).toBe("public_stream");
    expect((await app.inject("/v1/transfers/7/stream")).statusCode).toBe(429);

    // Health, readiness, and metrics continue answering under their own documented budgets.
    const health = await app.inject("/health");
    expect(health.statusCode).toBe(200);
    expect(health.headers["x-ratelimit-scope"]).toBe("probe");
    expect(health.headers["x-ratelimit-limit"]).toBe("5");

    const ready = await app.inject("/ready");
    expect(ready.statusCode).toBe(200);
    expect(ready.headers["x-ratelimit-scope"]).toBe("probe");

    const metrics = await app.inject("/v1/metrics");
    expect(metrics.statusCode).toBe(200);
    expect(metrics.headers["x-ratelimit-scope"]).toBe("operational");
    expect(metrics.headers["x-ratelimit-limit"]).toBe("3");

    await app.close();
  });

  it("enforces shared deployment budgets across replicas and returns stable credential-free retry metadata", async () => {
    const { logger, lines } = capturingLogger();
    let clock = Date.parse("2026-10-30T12:00:00.000Z");
    const sharedRedis = new InMemoryRedisCounter(() => clock);
    const sharedStore = new RedisRateLimitStore(sharedRedis);

    const replicaA = buildServer({
      config: baseConfig,
      logger,
      db: new FakeDb() as unknown as Database,
      readiness: [],
      rateLimit: {
        enabled: true,
        trustProxyHops: 1,
        store: sharedStore,
        now: () => clock,
        budgets: {
          public_read: { clientMax: 10, deploymentMax: 2, windowMs: 60_000 },
        },
      },
    });
    const replicaB = buildServer({
      config: baseConfig,
      logger,
      db: new FakeDb() as unknown as Database,
      readiness: [],
      rateLimit: {
        enabled: true,
        trustProxyHops: 1,
        store: sharedStore,
        now: () => clock,
        budgets: {
          public_read: { clientMax: 10, deploymentMax: 2, windowMs: 60_000 },
        },
      },
    });

    // Three distinct client IPs across two separate server replicas share deploymentMax = 2.
    const hitA = await replicaA.inject({
      method: "GET",
      url: "/v1/transfers/7",
      headers: { "x-forwarded-for": "203.0.113.10" },
    });
    expect(hitA.statusCode).toBe(200);
    expect(hitA.json().origin.grossAmount).toBe("10000000");

    clock += 15_000;
    const hitB = await replicaB.inject({
      method: "GET",
      url: "/v1/transfers/7",
      headers: { "x-forwarded-for": "203.0.113.11" },
    });
    expect(hitB.statusCode).toBe(200);

    const hitC = await replicaA.inject({
      method: "GET",
      url: "/v1/transfers/7",
      headers: { "x-forwarded-for": "203.0.113.12", "x-request-id": "req-shared-429" },
    });
    expect(hitC.statusCode).toBe(429);
    expect(hitC.headers["retry-after"]).toBe("45");
    expect(hitC.json()).toEqual({
      error: "too_many_requests",
      message:
        "rate limit exceeded; status endpoints must not be polled faster than their documented budget",
      scope: "public_read",
      limit: 10,
      remaining: 0,
      windowSeconds: 60,
      retryAfterSeconds: 45,
      resetAt: new Date(Date.parse("2026-10-30T12:01:00.000Z")).toISOString(),
      requestId: "req-shared-429",
    });

    await replicaA.close();
    await replicaB.close();

    // Verify failing shared store degrades cleanly without leaking Redis URLs, keys, or secrets.
    const redisSecret = ["redis://default", "secret_rl_pw_99@redis.internal:6379/0"].join(":");
    const brokenStore: RateLimitStore = {
      consume(): Promise<never> {
        return Promise.reject(
          new Error(`READONLY shared counter failed on ${redisSecret} key hyperion:rl:secret`),
        );
      },
    };

    const fallbackApp = buildServer({
      config: baseConfig,
      logger,
      db: new FakeDb() as unknown as Database,
      readiness: [],
      rateLimit: {
        enabled: true,
        store: brokenStore,
        now: () => clock,
        budgets: {
          public_read: { clientMax: 1, deploymentMax: 10, windowMs: 60_000 },
        },
      },
    });

    const f1 = await fallbackApp.inject("/v1/transfers");
    const f2 = await fallbackApp.inject("/v1/transfers");
    expect(f1.statusCode).toBe(200);
    expect(f2.statusCode).toBe(429);
    expect(f2.payload).not.toContain("secret_rl_pw_99");
    expect(f2.payload).not.toContain("redis.internal");
    expect(f2.payload).not.toContain("hyperion:rl");
    expect(JSON.stringify(lines)).not.toContain("secret_rl_pw_99");

    await fallbackApp.close();
  });

  it("defaults HTTP_TRUST_PROXY_HOPS to zero and rejects out-of-range values", () => {
    expect(baseConfig.http.trustProxyHops).toBe(0);
    const withOne = loadConfig({
      env: completeEnv({
        HYPERION_DEPLOYMENTS_FILE: ACTIVE_DEPLOYMENTS,
        KEEPER_ENABLED: "false",
        HTTP_TRUST_PROXY_HOPS: "2",
      }),
    });
    expect(withOne.http.trustProxyHops).toBe(2);

    expect(() =>
      loadConfig({
        env: completeEnv({
          HYPERION_DEPLOYMENTS_FILE: ACTIVE_DEPLOYMENTS,
          KEEPER_ENABLED: "false",
          HTTP_TRUST_PROXY_HOPS: "99",
        }),
      }),
    ).toThrow(ConfigError);
  });
});
