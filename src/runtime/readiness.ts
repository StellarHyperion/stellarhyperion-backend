/**
 * What "ready" means, as a thing a component reports rather than a thing the HTTP layer guesses.
 *
 * `/health` and `/ready` are answering two different questions and the distinction is not
 * cosmetic. A liveness probe that checks Postgres restarts the API every time the database
 * hiccups, which turns a brief database problem into a rolling outage. A readiness probe that
 * does not check Postgres sends traffic to a process that cannot answer a single query. So
 * liveness is "this process is still a process" and readiness is "this process can do its job",
 * and anything with a dependency belongs in the second one.
 *
 * This interface is the seam the rail pollers and the keeper plug into later: each one reports
 * its own readiness and the HTTP layer only aggregates.
 */

import type { Queryable } from "../db/pool.js";
import { integer, json, text, textOrNull, timestamp, timestampOrNull } from "../db/rows.js";
import { sanitizeDiagnosticText } from "../logging/logger.js";

export type ReadinessState = "ready" | "degraded" | "down";

export interface ReadinessReport {
  /** Stable, lowercase, dash separated. Shows up in the `/ready` body and in alerts. */
  readonly name: string;
  readonly state: ReadinessState;
  /** One sentence a human can act on. Never a stack trace and never a connection string. */
  readonly detail: string;
}

export interface ReadinessSource {
  /**
   * Answer from cached state, not by making a network call.
   *
   * Readiness is polled by a load balancer every couple of seconds. A check that talks to an RPC
   * endpoint turns the probe into load, and a slow endpoint into a false negative. Components
   * record their own last known good state as they work and report it from memory here. The one
   * exception is the database, which gets a `SELECT 1`, because that is cheaper than the probe
   * itself and because it is the dependency nothing else can compensate for.
   */
  readiness(): ReadinessReport | Promise<ReadinessReport>;
}

/**
 * The worst state wins.
 *
 * A single degraded watcher makes the process degraded rather than down, because it can still
 * answer about the chains that are working. Anything down makes the whole thing down.
 */
export function worstOf(reports: readonly ReadinessReport[]): ReadinessState {
  if (reports.some((report) => report.state === "down")) return "down";
  if (reports.some((report) => report.state === "degraded")) return "degraded";
  return "ready";
}

/** Readiness that only reports what it is told, for a component with nothing to check. */
export function fixedReadiness(
  name: string,
  state: ReadinessState,
  detail: string,
): ReadinessSource {
  return { readiness: () => ({ name, state, detail }) };
}

export interface RedisPingable {
  ping(): Promise<unknown>;
}

export interface BullMQWorkerState {
  readonly name?: string;
  isPaused?(): boolean | Promise<boolean>;
  isRunning?(): boolean;
}

export interface RedisHealthOptions {
  readonly timeoutMs?: number | undefined;
  readonly workers?: readonly BullMQWorkerState[] | undefined;
}

export const DEFAULT_REDIS_TIMEOUT_MS = 2000;

/**
 * Check Redis connectivity and BullMQ worker readiness.
 *
 * Pings Redis with a default timeout of 2000ms. If Redis fails or times out,
 * reports state "down". If Redis is responding but BullMQ workers are paused,
 * reports state "degraded".
 */
export async function checkRedisHealth(
  redis: RedisPingable,
  options: RedisHealthOptions = {},
): Promise<ReadinessReport> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REDIS_TIMEOUT_MS;

  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`timeout after ${String(timeoutMs)}ms`));
      }, timeoutMs);
    });

    try {
      await Promise.race([redis.ping(), timeoutPromise]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  } catch (error) {
    const message = sanitizeDiagnosticText(error instanceof Error ? error.message : String(error));
    return {
      name: "redis",
      state: "down",
      detail: message.includes("timeout")
        ? `redis ping timed out after ${String(timeoutMs)}ms`
        : `redis unreachable: ${message}`,
    };
  }

  if (options.workers !== undefined && options.workers.length > 0) {
    for (const worker of options.workers) {
      const isPaused = typeof worker.isPaused === "function" ? await worker.isPaused() : false;
      const isRunning = typeof worker.isRunning === "function" ? worker.isRunning() : true;
      if (isPaused || !isRunning) {
        return {
          name: "redis",
          state: "degraded",
          detail: `worker ${worker.name ?? "bullmq"} is ${isPaused ? "paused" : "not running"}`,
        };
      }
    }
  }

  return {
    name: "redis",
    state: "ready",
    detail: "answering",
  };
}

export function redisReadiness(
  redis: RedisPingable,
  options: RedisHealthOptions = {},
): ReadinessSource {
  return {
    readiness: () => checkRedisHealth(redis, options),
  };
}

export function bullmqWorkersReadiness(
  workers: readonly BullMQWorkerState[],
  name = "bullmq",
): ReadinessSource {
  return {
    readiness: async () => {
      for (const worker of workers) {
        const isPaused = typeof worker.isPaused === "function" ? await worker.isPaused() : false;
        const isRunning = typeof worker.isRunning === "function" ? worker.isRunning() : true;
        if (isPaused || !isRunning) {
          return {
            name,
            state: "degraded",
            detail: `worker ${worker.name ?? "unnamed"} is ${isPaused ? "paused" : "not running"}`,
          };
        }
      }
      return {
        name,
        state: "ready",
        detail: "active and non-paused",
      };
    },
  };
}

export class ReadinessRegistry {
  private readonly sources: ReadinessSource[] = [];

  register(source: ReadinessSource): void {
    this.sources.push(source);
  }

  registerRedis(redis: RedisPingable, options?: RedisHealthOptions): void {
    this.sources.push(redisReadiness(redis, options));
  }

  registerBullmq(workers: readonly BullMQWorkerState[], name?: string): void {
    this.sources.push(bullmqWorkersReadiness(workers, name));
  }

  async check(): Promise<{ state: ReadinessState; checks: ReadinessReport[] }> {
    const checks: ReadinessReport[] = [];
    for (const source of this.sources) {
      try {
        checks.push(await source.readiness());
      } catch (error) {
        checks.push({
          name: "unknown",
          state: "down",
          detail: `readiness check threw: ${sanitizeDiagnosticText(error instanceof Error ? error.message : String(error))}`,
        });
      }
    }
    return { state: worstOf(checks), checks };
  }
}

export type WorkerKind = "chain" | "rail" | "keeper" | "other";

export interface WorkerHeartbeatInput {
  readonly workerName: string;
  readonly workerKind: WorkerKind;
  readonly chainKey: string | null;
  readonly state: ReadinessState;
  readonly detail: string;
  readonly completed: boolean;
  readonly lastCursorBlock?: bigint | null;
  readonly consecutiveFailures: number;
  readonly lastError: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly at?: Date;
}

export interface WorkerHeartbeatRecord {
  readonly workerName: string;
  readonly workerKind: WorkerKind;
  readonly chainKey: string | null;
  readonly state: ReadinessState;
  readonly detail: string;
  readonly lastHeartbeatAt: Date;
  readonly lastCompletedAt: Date | null;
  readonly lastCursorBlock: string | null;
  readonly consecutiveFailures: number;
  readonly lastError: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export const DEFAULT_HEARTBEAT_STALE_MS = 120_000;
const MAX_HEARTBEAT_ROWS = 512;
const WORKER_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export function sanitizeHeartbeatMetadata(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  function bounded(value: unknown, depth: number): unknown {
    if (typeof value === "string") return sanitizeDiagnosticText(value).slice(0, 256);
    if (typeof value === "boolean" || value === null) return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (depth >= 3) return null;
    if (Array.isArray(value)) return value.slice(0, 16).map((item) => bounded(item, depth + 1));
    if (typeof value !== "object") return null;
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 32)
        .filter(
          ([key]) =>
            /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) &&
            !/secret|password|auth|key|token|signer|connection|url|cookie|seed|mnemonic/i.test(key),
        )
        .map(([key, item]) => [key, bounded(item, depth + 1)]),
    );
  }
  return bounded(input, 0) as Readonly<Record<string, unknown>>;
}

export interface HeartbeatFreshness {
  readonly stale: boolean;
  readonly ageSeconds: number;
  readonly report: ReadinessReport;
}

/**
 * Evaluate whether a persisted worker heartbeat is still fresh enough to trust.
 * Stale heartbeats degrade readiness rather than reporting an out-of-date "ready".
 */
export function evaluateHeartbeatFreshness(
  record: WorkerHeartbeatRecord,
  now = new Date(),
  staleAfterMs = DEFAULT_HEARTBEAT_STALE_MS,
): HeartbeatFreshness {
  const elapsed = now.getTime() - record.lastHeartbeatAt.getTime();
  const invalid = !Number.isFinite(elapsed) || elapsed < -30_000;
  const ageMs = invalid ? 0 : Math.max(0, elapsed);
  const ageSeconds = Math.floor(ageMs / 1000);
  const stale = invalid || ageMs > staleAfterMs;

  if (stale) {
    return {
      stale: true,
      ageSeconds,
      report: {
        name: record.workerName,
        state: record.state === "down" ? "down" : "degraded",
        detail: invalid
          ? "invalid heartbeat timestamp; worker freshness is unverified"
          : `stale heartbeat (${String(ageSeconds)}s old): ${sanitizeDiagnosticText(record.detail)}`,
      },
    };
  }

  return {
    stale: false,
    ageSeconds,
    report: {
      name: record.workerName,
      state: record.state,
      detail: sanitizeDiagnosticText(record.detail),
    },
  };
}

export async function recordWorkerHeartbeat(
  db: Queryable,
  input: WorkerHeartbeatInput,
): Promise<void> {
  const now = input.at ?? new Date();
  if (
    !WORKER_ID.test(input.workerName) ||
    (input.chainKey !== null && !WORKER_ID.test(input.chainKey))
  ) {
    throw new RangeError("worker heartbeat identity is invalid or exceeds128 characters");
  }
  if (
    !Number.isFinite(now.getTime()) ||
    now.getTime() > Date.now() + 30_000 ||
    !Number.isSafeInteger(input.consecutiveFailures) ||
    input.consecutiveFailures < 0
  ) {
    throw new RangeError("invalid worker heartbeat timestamp or failure count");
  }
  const detail = sanitizeDiagnosticText(input.detail);
  const lastError = input.lastError === null ? null : sanitizeDiagnosticText(input.lastError);
  const cursorBlock =
    input.lastCursorBlock === undefined || input.lastCursorBlock === null
      ? null
      : input.lastCursorBlock.toString();

  await db.query(
    `INSERT INTO indexer_worker_heartbeat
       (worker_name, worker_kind, chain_key, state, detail, last_heartbeat_at,
        last_completed_at, last_cursor_block, consecutive_failures, last_error, metadata,
        updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $6)
     ON CONFLICT (worker_name) DO UPDATE
       SET worker_kind = EXCLUDED.worker_kind,
           chain_key = EXCLUDED.chain_key,
           state = EXCLUDED.state,
           detail = EXCLUDED.detail,
           last_heartbeat_at = EXCLUDED.last_heartbeat_at,
           last_completed_at = COALESCE(
             EXCLUDED.last_completed_at,
             indexer_worker_heartbeat.last_completed_at
           ),
           last_cursor_block = COALESCE(
             EXCLUDED.last_cursor_block,
             indexer_worker_heartbeat.last_cursor_block
           ),
           consecutive_failures = EXCLUDED.consecutive_failures,
           last_error = EXCLUDED.last_error,
           metadata = EXCLUDED.metadata,
           updated_at = EXCLUDED.updated_at
     WHERE indexer_worker_heartbeat.last_heartbeat_at <= EXCLUDED.last_heartbeat_at`,
    [
      input.workerName,
      input.workerKind,
      input.chainKey,
      input.state,
      detail,
      now,
      input.completed ? now : null,
      cursorBlock,
      input.consecutiveFailures,
      lastError,
      JSON.stringify(sanitizeHeartbeatMetadata(input.metadata ?? {})),
    ],
  );
}

export async function readWorkerHeartbeats(db: Queryable): Promise<WorkerHeartbeatRecord[]> {
  const { rows } = await db.query(
    `SELECT worker_name, worker_kind, chain_key, state, detail, last_heartbeat_at,
            last_completed_at, last_cursor_block, consecutive_failures, last_error, metadata
       FROM indexer_worker_heartbeat
      ORDER BY last_heartbeat_at DESC, worker_name ASC LIMIT ${MAX_HEARTBEAT_ROWS}`,
  );

  return rows.map((row) => {
    const rawMeta = json(row, "metadata");
    const metadata =
      typeof rawMeta === "object" && rawMeta !== null && !Array.isArray(rawMeta)
        ? (rawMeta as Record<string, unknown>)
        : {};
    return {
      workerName: WORKER_ID.test(text(row, "worker_name"))
        ? text(row, "worker_name")
        : "invalid-worker-identity",
      workerKind: text(row, "worker_kind") as WorkerKind,
      chainKey: textOrNull(row, "chain_key"),
      state: text(row, "state") as ReadinessState,
      detail: sanitizeDiagnosticText(text(row, "detail")),
      lastHeartbeatAt: timestamp(row, "last_heartbeat_at"),
      lastCompletedAt: timestampOrNull(row, "last_completed_at"),
      lastCursorBlock: textOrNull(row, "last_cursor_block"),
      consecutiveFailures: integer(row, "consecutive_failures"),
      lastError: row.last_error === null ? null : sanitizeDiagnosticText(text(row, "last_error")),
      metadata: sanitizeHeartbeatMetadata(metadata),
    };
  });
}

export type DeploymentMode = "all-in-one" | "api-only" | "indexer-only" | "keeper-only" | "custom";
export type DependencyPolicy = "required" | "optional" | "disabled";
export type DependencyKind = "database" | "indexer" | "rails" | "keeper";

export type ReadinessDependencyPolicies = Readonly<Record<DependencyKind, DependencyPolicy>>;

export interface EvaluatedReadinessReport extends ReadinessReport {
  readonly dependency: DependencyKind | "unknown";
  readonly policy: DependencyPolicy;
  readonly required: boolean;
  readonly effectiveState: ReadinessState | "disabled";
}

export interface PolicyResolutionInput {
  readonly mode?: DeploymentMode;
  readonly indexerEnabled: boolean;
  readonly railsEnabled: boolean;
  readonly keeperEnabled: boolean;
  readonly overrides?: Partial<ReadinessDependencyPolicies>;
}

export function inferDeploymentMode(flags: {
  readonly indexerEnabled: boolean;
  readonly railsEnabled: boolean;
  readonly keeperEnabled: boolean;
}): DeploymentMode {
  if (!flags.indexerEnabled && !flags.railsEnabled && !flags.keeperEnabled) {
    return "api-only";
  }
  if (flags.indexerEnabled && !flags.railsEnabled && !flags.keeperEnabled) {
    return "indexer-only";
  }
  if (!flags.indexerEnabled && !flags.railsEnabled && flags.keeperEnabled) {
    return "keeper-only";
  }
  return "all-in-one";
}

export function resolveReadinessPolicy(input: PolicyResolutionInput): ReadinessDependencyPolicies {
  const mode = input.mode ?? inferDeploymentMode(input);

  let base: ReadinessDependencyPolicies;
  switch (mode) {
    case "api-only":
      base = {
        database: "required",
        indexer: "disabled",
        rails: "disabled",
        keeper: "disabled",
      };
      break;
    case "indexer-only":
      base = {
        database: "required",
        indexer: "required",
        rails: input.railsEnabled ? "optional" : "disabled",
        keeper: input.keeperEnabled ? "optional" : "disabled",
      };
      break;
    case "keeper-only":
      base = {
        database: "required",
        indexer: "disabled",
        rails: "disabled",
        keeper: "required",
      };
      break;
    case "all-in-one":
    case "custom":
      base = {
        database: "required",
        indexer: input.indexerEnabled ? "required" : "disabled",
        rails: input.railsEnabled ? "required" : "disabled",
        keeper: input.keeperEnabled ? "required" : "disabled",
      };
      break;
  }

  return {
    database: input.overrides?.database ?? base.database,
    indexer: input.overrides?.indexer ?? base.indexer,
    rails: input.overrides?.rails ?? base.rails,
    keeper: input.overrides?.keeper ?? base.keeper,
  };
}

export function classifyReadinessDependency(name: string): DependencyKind | "unknown" {
  if (name === "postgres" || name === "database") return "database";
  if (name === "redis" || name === "bullmq" || name === "keeper") return "keeper";
  if (name === "rails" || name.startsWith("rail:")) return "rails";
  if (name === "unknown") return "unknown";
  return "indexer";
}

export function evaluateReadiness(
  reports: readonly ReadinessReport[],
  policies: ReadinessDependencyPolicies,
): { readonly state: ReadinessState; readonly checks: readonly EvaluatedReadinessReport[] } {
  const checks: EvaluatedReadinessReport[] = [];
  const effectiveStates: ReadinessState[] = [];

  for (const report of reports) {
    const dependency = classifyReadinessDependency(report.name);
    const policy: DependencyPolicy = dependency === "unknown" ? "required" : policies[dependency];
    const required = policy === "required";

    checks.push({
      ...report,
      dependency,
      policy,
      required,
      effectiveState:
        policy === "disabled"
          ? "disabled"
          : policy === "optional" && report.state === "down"
            ? "degraded"
            : report.state,
    });

    if (policy === "disabled") {
      effectiveStates.push("ready");
    } else if (policy === "optional") {
      effectiveStates.push(report.state === "down" ? "degraded" : report.state);
    } else {
      effectiveStates.push(report.state);
    }
  }

  for (const dependency of ["database", "indexer", "rails", "keeper"] as const) {
    if (
      policies[dependency] === "required" &&
      !checks.some((check) => check.dependency === dependency)
    ) {
      checks.push({
        name: dependency,
        dependency,
        policy: "required",
        required: true,
        state: "down",
        effectiveState: "down",
        detail: "required dependency has no readiness evidence",
      });
      effectiveStates.push("down");
    }
  }
  const state: ReadinessState = effectiveStates.includes("down")
    ? "down"
    : effectiveStates.includes("degraded")
      ? "degraded"
      : "ready";

  return { state, checks };
}
