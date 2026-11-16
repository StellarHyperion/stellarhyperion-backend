/**
 * Public API rate limiting with explicit reverse-proxy trust and shared deployment budgets.
 *
 * Three properties matter in production and serverless deployments:
 * 1. Forwarded headers are ignored unless `trustProxyHops > 0`, and when trusted only the Nth hop
 *    from the right is read so a caller cannot spoof leftmost `X-Forwarded-For` entries.
 * 2. Health and operational probes carry dedicated budgets isolated from public read and stream
 *    traffic so client load never blinds load-balancer or operator checks.
 * 3. Shared store errors degrade cleanly to a bounded in-memory window counter without exposing
 *    Redis or database connection details in HTTP responses or logs.
 */
import { createHash } from "node:crypto";
import { isIP } from "node:net";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export type RateLimitScope = "probe" | "operational" | "public_read" | "public_stream";

declare module "fastify" {
  interface FastifyContextConfig {
    rateLimitScope?: RateLimitScope;
  }
}

export interface ScopeBudget {
  readonly clientMax: number;
  readonly deploymentMax: number;
  readonly windowMs: number;
  readonly maxConcurrentPerClient?: number;
}

export const PUBLIC_API_BUDGETS: Readonly<Record<RateLimitScope, ScopeBudget>> = {
  probe: {
    clientMax: 300,
    deploymentMax: 3_000,
    windowMs: 60_000,
  },
  operational: {
    clientMax: 60,
    deploymentMax: 600,
    windowMs: 60_000,
  },
  public_read: {
    clientMax: 120,
    deploymentMax: 1_200,
    windowMs: 60_000,
  },
  public_stream: {
    clientMax: 30,
    deploymentMax: 300,
    windowMs: 60_000,
    maxConcurrentPerClient: 5,
  },
};

export interface WindowHit {
  readonly count: number;
  readonly resetAtMs: number;
}

export interface RateLimitStore {
  consume(key: string, windowMs: number, nowMs: number): Promise<WindowHit> | WindowHit;
}

export interface SharedCounterRedis {
  incr(key: string): Promise<number>;
  pttl(key: string): Promise<number>;
  pexpire(key: string, milliseconds: number): Promise<unknown>;
}

export interface ProxyTrustConfig {
  readonly trustProxyHops: number;
  readonly trustedProxies?: readonly string[];
}

export interface RateLimitConfig {
  readonly enabled?: boolean;
  readonly network: string;
  readonly trustProxyHops?: number;
  readonly trustedProxies?: readonly string[];
  readonly budgets?: Partial<Record<RateLimitScope, Partial<ScopeBudget>>>;
  readonly store?: RateLimitStore;
  readonly maxLocalEntries?: number;
  readonly now?: () => number;
}

const MAX_FORWARDED_HEADER_LENGTH = 2_048;
const DEFAULT_MAX_LOCAL_ENTRIES = 10_000;

const URL_CREDENTIALS_RE = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/\s@]+@)/g;
const SECRET_KV_RE =
  /\b((?:password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*)([^\s,;]+)/gi;

function scrubLogReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(URL_CREDENTIALS_RE, "$1[redacted]@")
    .replace(SECRET_KV_RE, "$1[redacted]")
    .slice(0, 200);
}

/**
 * Bounded in-memory fixed-window counter store with deterministic expiry cleanup and FIFO eviction.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, { count: number; resetAtMs: number }>();
  private readonly maxEntries: number;

  constructor(maxEntries = DEFAULT_MAX_LOCAL_ENTRIES) {
    this.maxEntries = Math.max(64, maxEntries);
  }

  get size(): number {
    return this.buckets.size;
  }

  consume(key: string, windowMs: number, nowMs: number): WindowHit {
    const existing = this.buckets.get(key);
    if (existing !== undefined && existing.resetAtMs > nowMs) {
      existing.count += 1;
      return { count: existing.count, resetAtMs: existing.resetAtMs };
    }

    if (this.buckets.size >= this.maxEntries) {
      this.evict(nowMs);
    }

    const resetAtMs = nowMs + windowMs;
    this.buckets.set(key, { count: 1, resetAtMs });
    return { count: 1, resetAtMs };
  }

  private evict(nowMs: number): void {
    for (const [k, entry] of this.buckets) {
      if (entry.resetAtMs <= nowMs) {
        this.buckets.delete(k);
      }
      if (this.buckets.size < this.maxEntries) {
        return;
      }
    }
    const oldestKey = this.buckets.keys().next().value;
    if (oldestKey !== undefined) {
      this.buckets.delete(oldestKey);
    }
  }
}

/**
 * Shared deployment counter adapter backed by Redis `INCR` + `PEXPIRE` for multi-replica hosting.
 */
export class RedisRateLimitStore implements RateLimitStore {
  constructor(
    private readonly redis: SharedCounterRedis,
    private readonly prefix = "hyperion:rl",
  ) {}

  async consume(key: string, windowMs: number, nowMs: number): Promise<WindowHit> {
    const storageKey = `${this.prefix}:${key}`;
    const count = await this.redis.incr(storageKey);
    let ttlMs = await this.redis.pttl(storageKey);
    if (count === 1 || ttlMs < 0) {
      await this.redis.pexpire(storageKey, windowMs);
      ttlMs = windowMs;
    }
    return {
      count,
      resetAtMs: nowMs + Math.max(1, ttlMs),
    };
  }
}

export function normalizeIpAddress(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) return null;
  let candidate = raw.trim();
  if (candidate === "" || candidate.length > 128) return null;

  // Strip bracketed IPv6 with optional port: [2001:db8::1]:443 -> 2001:db8::1
  if (candidate.startsWith("[")) {
    const closing = candidate.indexOf("]");
    if (closing <= 1) return null;
    candidate = candidate.slice(1, closing);
  } else if (candidate.includes(".") && candidate.split(":").length === 2) {
    // Strip IPv4 host:port: 203.0.113.10:54321 -> 203.0.113.10
    const hostPart = candidate.split(":")[0];
    if (hostPart !== undefined) {
      candidate = hostPart;
    }
  }

  // Normalize IPv4-mapped IPv6 addresses so ::ffff:203.0.113.10 and 203.0.113.10 share one bucket.
  if (candidate.toLowerCase().startsWith("::ffff:")) {
    const mapped = candidate.slice(7);
    if (isIP(mapped) === 4) {
      return mapped;
    }
  }

  const version = isIP(candidate);
  if (version === 0) return null;
  return candidate.toLowerCase();
}

export function resolveClientAddress(
  request: Pick<FastifyRequest, "headers" | "raw">,
  proxy: ProxyTrustConfig,
): string {
  const socketIp = normalizeIpAddress(request.raw.socket.remoteAddress) ?? "127.0.0.1";
  const hops = Math.max(0, Math.trunc(proxy.trustProxyHops));
  if (hops === 0) {
    return socketIp;
  }

  if (proxy.trustedProxies !== undefined && proxy.trustedProxies.length > 0) {
    const allowed = new Set(
      proxy.trustedProxies
        .map((entry) => normalizeIpAddress(entry))
        .filter((entry): entry is string => entry !== null),
    );
    if (!allowed.has(socketIp)) {
      return socketIp;
    }
  }

  const rawHeader = request.headers["x-forwarded-for"];
  const joined = Array.isArray(rawHeader) ? rawHeader.join(",") : rawHeader;
  if (
    typeof joined !== "string" ||
    joined.length === 0 ||
    joined.length > MAX_FORWARDED_HEADER_LENGTH
  ) {
    return socketIp;
  }

  const entries = joined
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (entries.length < hops) {
    return socketIp;
  }

  // Select the Nth hop from the right, which is the entry appended by the outermost trusted proxy.
  // Any leftmost entries injected by the client before reaching that proxy are ignored.
  const selected = entries[entries.length - hops];
  return normalizeIpAddress(selected) ?? socketIp;
}

export function classifyRouteScope(request: FastifyRequest): RateLimitScope {
  const explicit = request.routeOptions.config.rateLimitScope;
  if (explicit !== undefined) {
    return explicit;
  }
  const pathOnly = request.url.split("?")[0] ?? request.url;
  if (pathOnly === "/health" || pathOnly === "/ready") {
    return "probe";
  }
  if (pathOnly === "/v1/metrics") {
    return "operational";
  }
  if (pathOnly.endsWith("/stream")) {
    return "public_stream";
  }
  return "public_read";
}

function hashClientKey(clientIp: string): string {
  return createHash("sha256").update(clientIp).digest("hex").slice(0, 24);
}

function resolveScopeBudgets(
  overrides?: Partial<Record<RateLimitScope, Partial<ScopeBudget>>>,
): Record<RateLimitScope, ScopeBudget> {
  const scopes: readonly RateLimitScope[] = [
    "probe",
    "operational",
    "public_read",
    "public_stream",
  ];
  const merged = {} as Record<RateLimitScope, ScopeBudget>;
  for (const scope of scopes) {
    const base = PUBLIC_API_BUDGETS[scope];
    const patch = overrides?.[scope];
    const concurrent = patch?.maxConcurrentPerClient ?? base.maxConcurrentPerClient;
    merged[scope] = {
      clientMax: Math.max(1, Math.trunc(patch?.clientMax ?? base.clientMax)),
      deploymentMax: Math.max(1, Math.trunc(patch?.deploymentMax ?? base.deploymentMax)),
      windowMs: Math.max(1_000, Math.trunc(patch?.windowMs ?? base.windowMs)),
      ...(concurrent !== undefined
        ? { maxConcurrentPerClient: Math.max(1, Math.trunc(concurrent)) }
        : {}),
    };
  }
  return merged;
}

export function registerPublicRateLimiting(app: FastifyInstance, options: RateLimitConfig): void {
  const enabled = options.enabled ?? true;
  const budgets = resolveScopeBudgets(options.budgets);
  const fallbackStore = new MemoryRateLimitStore(options.maxLocalEntries);
  const sharedStore = options.store;
  const activeStreams = new Map<string, number>();
  const proxyConfig: ProxyTrustConfig = {
    trustProxyHops: options.trustProxyHops ?? 0,
    ...(options.trustedProxies ? { trustedProxies: options.trustedProxies } : {}),
  };
  const nowFn = options.now ?? (() => Date.now());

  const consumeSafe = async (
    request: FastifyRequest,
    key: string,
    windowMs: number,
    nowMs: number,
  ): Promise<WindowHit> => {
    if (sharedStore === undefined) {
      return fallbackStore.consume(key, windowMs, nowMs);
    }
    try {
      return await sharedStore.consume(key, windowMs, nowMs);
    } catch (error) {
      request.log.warn(
        { reason: scrubLogReason(error) },
        "shared rate-limit store unavailable; falling back to local bounded budget",
      );
      return fallbackStore.consume(key, windowMs, nowMs);
    }
  };

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.method === "OPTIONS") {
      return;
    }

    const scope = classifyRouteScope(request);
    const budget = budgets[scope];
    const windowSeconds = Math.max(1, Math.ceil(budget.windowMs / 1_000));

    if (!enabled) {
      applyRateHeaders(
        reply,
        scope,
        budget.clientMax,
        budget.clientMax,
        windowSeconds,
        windowSeconds,
      );
      return;
    }

    const nowMs = nowFn();
    const clientIp = resolveClientAddress(request, proxyConfig);
    const clientHash = hashClientKey(clientIp);
    const clientKey = `${options.network}:${scope}:client:${clientHash}`;
    const deploymentKey = `${options.network}:${scope}:deployment`;

    if (scope === "public_stream" && budget.maxConcurrentPerClient !== undefined) {
      const currentActive = activeStreams.get(clientHash) ?? 0;
      if (currentActive >= budget.maxConcurrentPerClient) {
        const retryAfterSeconds = Math.min(windowSeconds, 5);
        const resetAt = new Date(nowMs + retryAfterSeconds * 1_000).toISOString();
        applyRateHeaders(reply, scope, budget.clientMax, 0, windowSeconds, retryAfterSeconds);
        reply.header("Retry-After", String(retryAfterSeconds));
        return reply.code(429).send({
          error: "too_many_requests",
          message: "concurrent stream budget exceeded; close an active stream or retry shortly",
          scope,
          limit: budget.clientMax,
          remaining: 0,
          windowSeconds,
          retryAfterSeconds,
          resetAt,
          requestId: request.id,
        });
      }
    }

    const [clientHit, deploymentHit] = await Promise.all([
      consumeSafe(request, clientKey, budget.windowMs, nowMs),
      consumeSafe(request, deploymentKey, budget.windowMs, nowMs),
    ]);

    const clientRemaining = budget.clientMax - clientHit.count;
    const deploymentRemaining = budget.deploymentMax - deploymentHit.count;
    const exceeded = clientRemaining < 0 || deploymentRemaining < 0;

    const resetAtMs =
      clientRemaining < 0 && deploymentRemaining < 0
        ? Math.max(clientHit.resetAtMs, deploymentHit.resetAtMs)
        : clientRemaining < 0
          ? clientHit.resetAtMs
          : deploymentRemaining < 0
            ? deploymentHit.resetAtMs
            : clientHit.resetAtMs;

    const retryAfterSeconds = Math.max(1, Math.ceil((resetAtMs - nowMs) / 1_000));
    const remaining = Math.max(0, Math.min(clientRemaining, deploymentRemaining, budget.clientMax));

    applyRateHeaders(reply, scope, budget.clientMax, remaining, windowSeconds, retryAfterSeconds);

    if (exceeded) {
      reply.header("Retry-After", String(retryAfterSeconds));
      return reply.code(429).send({
        error: "too_many_requests",
        message:
          "rate limit exceeded; status endpoints must not be polled faster than their documented budget",
        scope,
        limit: budget.clientMax,
        remaining: 0,
        windowSeconds,
        retryAfterSeconds,
        resetAt: new Date(resetAtMs).toISOString(),
        requestId: request.id,
      });
    }

    if (scope === "public_stream" && budget.maxConcurrentPerClient !== undefined) {
      activeStreams.set(clientHash, (activeStreams.get(clientHash) ?? 0) + 1);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        const left = (activeStreams.get(clientHash) ?? 1) - 1;
        if (left <= 0) {
          activeStreams.delete(clientHash);
        } else {
          activeStreams.set(clientHash, left);
        }
      };
      request.raw.on("close", release);
      reply.raw.on("close", release);
      reply.raw.on("finish", release);
    }
  });
}

function applyRateHeaders(
  reply: FastifyReply,
  scope: RateLimitScope,
  limit: number,
  remaining: number,
  windowSeconds: number,
  resetSeconds: number,
): void {
  const entries: readonly [string, string][] = [
    ["RateLimit-Policy", `${String(limit)};w=${String(windowSeconds)};scope="${scope}"`],
    ["X-RateLimit-Scope", scope],
    ["X-RateLimit-Limit", String(limit)],
    ["X-RateLimit-Remaining", String(remaining)],
    ["X-RateLimit-Reset", String(resetSeconds)],
  ];
  for (const [header, value] of entries) {
    reply.header(header, value);
    if (!reply.raw.headersSent) {
      reply.raw.setHeader(header, value);
    }
  }
}
