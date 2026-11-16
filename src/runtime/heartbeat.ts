/**
 * Persistent worker heartbeats for split API and indexer deployments.
 *
 * When the HTTP server runs in a serverless function or an API-only replica, it has no in-memory
 * handle to the chain watchers or rail pollers. A passing `SELECT 1` proves Postgres is reachable,
 * not that any background worker is still advancing cursors. Persisting bounded, credential-free
 * heartbeats per `(worker_name, replica_id)` gives `/ready` and `/v1/metrics` durable freshness,
 * evidence-gap, and workload visibility across process boundaries.
 */
import { randomBytes } from "node:crypto";

import type { AppConfig } from "../config/config.js";
import type { Queryable } from "../db/pool.js";
import {
  bigintOrNull,
  boolean,
  integer,
  integerOrNull,
  text,
  timestamp,
  timestampOrNull,
} from "../db/rows.js";
import {
  MAX_DIAGNOSTIC_LENGTH,
  MAX_REPLICA_ID_LENGTH,
  sanitizeDiagnosticText,
  sanitizeReplicaId,
} from "../logging/logger.js";
import type { ReadinessReport, ReadinessState } from "./readiness.js";

export type WorkerKind = "chain" | "rail" | "keeper";

export const MIN_BOUNDED_HEARTBEAT_MS = Date.UTC(2020, 0, 1);
export const MAX_HEARTBEAT_FUTURE_SKEW_MS = 60_000;
export const MAX_REPORTED_HEARTBEAT_AGE_MS = 365 * 24 * 60 * 60 * 1000;
export const DEFAULT_HEARTBEAT_STALE_MULTIPLIER = 3;
export const MIN_HEARTBEAT_STALE_MS = 15_000;
export const MAX_HEARTBEAT_QUERY_ROWS = 100;

const VALID_KINDS: readonly WorkerKind[] = ["chain", "rail", "keeper"];
const VALID_STATES: readonly ReadinessState[] = ["ready", "degraded", "down"];

export interface WorkerHeartbeatSnapshot {
  readonly workerKind: WorkerKind;
  readonly completedPosition?: bigint | null;
  readonly lagUnits?: number | null;
  readonly evidenceGap?: boolean;
  readonly workloadPending?: number | null;
  readonly lastProgressAt?: Date | null;
}

export interface WorkerHeartbeatWrite {
  readonly workerName: string;
  readonly replicaId: string;
  readonly workerKind: WorkerKind;
  readonly state: ReadinessState;
  readonly detail: string;
  readonly heartbeatAt?: Date;
  readonly lastProgressAt?: Date | null;
  readonly completedPosition?: bigint | null;
  readonly lagUnits?: number | null;
  readonly consecutiveFailures?: number;
  readonly expectedIntervalMs: number;
  readonly evidenceGap?: boolean;
  readonly workloadPending?: number | null;
}

export interface EvaluatedWorkerHeartbeat {
  readonly worker: string;
  readonly replicaId: string;
  readonly kind: WorkerKind;
  readonly state: ReadinessState;
  readonly detail: string;
  readonly heartbeatAt: string;
  readonly lastProgressAt: string | null;
  readonly completedPosition: string | null;
  readonly lagUnits: number | null;
  readonly consecutiveFailures: number;
  readonly expectedIntervalMs: number;
  readonly staleAfterMs: number;
  readonly ageMs: number;
  readonly stale: boolean;
  readonly timestampOutOfBounds: boolean;
  readonly evidenceGap: boolean;
  readonly workloadPending: number | null;
  readonly fresh: boolean;
}

export interface PersistentHeartbeatSummary {
  readonly status: "ready" | "degraded";
  readonly detail: string;
  readonly evaluatedAt: string;
  readonly expectedWorkers: readonly string[];
  readonly freshWorkers: readonly string[];
  readonly staleWorkers: readonly string[];
  readonly missingWorkers: readonly string[];
  readonly evidenceGapWorkers: readonly string[];
  readonly degradedWorkers: readonly string[];
  readonly totalWorkloadPending: number;
  readonly heartbeats: readonly EvaluatedWorkerHeartbeat[];
}

export interface EvaluateHeartbeatOptions {
  readonly now?: () => Date;
  readonly staleMultiplier?: number;
  readonly minStaleMs?: number;
  readonly maxRows?: number;
}

export function generateProcessReplicaId(explicit?: string | null): string {
  if (explicit !== undefined && explicit !== null && explicit.trim() !== "") {
    return sanitizeReplicaId(explicit, fallbackReplicaId());
  }
  return fallbackReplicaId();
}

function fallbackReplicaId(): string {
  return `replica-${randomBytes(4).toString("hex")}`;
}

export function sanitizeWorkerName(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^a-zA-Z0-9._:-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.:_]+|[-.:_]+$/g, "")
    .slice(0, MAX_REPLICA_ID_LENGTH);
  return cleaned === "" ? "worker-unknown" : cleaned;
}

function clampHeartbeatDate(candidate: Date | undefined, referenceMs: number): Date {
  if (candidate === undefined) {
    return new Date(referenceMs);
  }
  const ms = candidate.getTime();
  if (Number.isNaN(ms) || ms < MIN_BOUNDED_HEARTBEAT_MS || ms > referenceMs) {
    return new Date(referenceMs);
  }
  return candidate;
}

function clampOptionalDate(candidate: Date | null | undefined, maxMs: number): Date | null {
  if (candidate === undefined || candidate === null) {
    return null;
  }
  const ms = candidate.getTime();
  if (Number.isNaN(ms) || ms < MIN_BOUNDED_HEARTBEAT_MS) {
    return null;
  }
  if (ms > maxMs) {
    return new Date(maxMs);
  }
  return candidate;
}

function clampNonNegativeInt(value: number | null | undefined): number | null {
  if (value === undefined || value === null || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(Math.trunc(value), 2_147_483_647));
}

export async function recordWorkerHeartbeat(
  db: Queryable,
  input: WorkerHeartbeatWrite,
  options: { readonly now?: () => Date } = {},
): Promise<void> {
  const nowDate = options.now?.() ?? new Date();
  const refMs = nowDate.getTime();
  const workerName = sanitizeWorkerName(input.workerName);
  const replicaId = sanitizeReplicaId(input.replicaId, "replica-default");
  const detail = sanitizeDiagnosticText(input.detail, MAX_DIAGNOSTIC_LENGTH);
  const heartbeatAt = clampHeartbeatDate(input.heartbeatAt, refMs);
  const lastProgressAt = clampOptionalDate(input.lastProgressAt, heartbeatAt.getTime());
  const completedPosition =
    input.completedPosition !== undefined &&
    input.completedPosition !== null &&
    input.completedPosition >= 0n
      ? input.completedPosition.toString()
      : null;
  const lagUnits = clampNonNegativeInt(input.lagUnits);
  const consecutiveFailures = clampNonNegativeInt(input.consecutiveFailures ?? 0) ?? 0;
  const expectedIntervalMs = Math.max(
    250,
    Math.min(Math.trunc(input.expectedIntervalMs || 5_000), 86_400_000),
  );
  const evidenceGap = input.evidenceGap === true;
  const workloadPending = clampNonNegativeInt(input.workloadPending);

  await db.query(
    `INSERT INTO worker_heartbeat (
       worker_name,
       replica_id,
       worker_kind,
       state,
       detail,
       heartbeat_at,
       last_progress_at,
       completed_position,
       lag_units,
       consecutive_failures,
       expected_interval_ms,
       evidence_gap,
       workload_pending,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $6)
     ON CONFLICT (worker_name, replica_id) DO UPDATE SET
       worker_kind          = EXCLUDED.worker_kind,
       state                = EXCLUDED.state,
       detail               = EXCLUDED.detail,
       heartbeat_at         = EXCLUDED.heartbeat_at,
       last_progress_at     = COALESCE(EXCLUDED.last_progress_at, worker_heartbeat.last_progress_at),
       completed_position   = COALESCE(EXCLUDED.completed_position, worker_heartbeat.completed_position),
       lag_units            = EXCLUDED.lag_units,
       consecutive_failures = EXCLUDED.consecutive_failures,
       expected_interval_ms = EXCLUDED.expected_interval_ms,
       evidence_gap         = EXCLUDED.evidence_gap,
       workload_pending     = EXCLUDED.workload_pending,
       updated_at           = EXCLUDED.updated_at`,
    [
      workerName,
      replicaId,
      input.workerKind,
      input.state,
      detail,
      heartbeatAt,
      lastProgressAt,
      completedPosition,
      lagUnits,
      consecutiveFailures,
      expectedIntervalMs,
      evidenceGap,
      workloadPending,
    ],
  );
}

export async function readWorkerHeartbeats(
  db: Queryable,
  options: EvaluateHeartbeatOptions = {},
): Promise<readonly EvaluatedWorkerHeartbeat[]> {
  const nowDate = options.now?.() ?? new Date();
  const refMs = nowDate.getTime();
  const staleMultiplier = options.staleMultiplier ?? DEFAULT_HEARTBEAT_STALE_MULTIPLIER;
  const minStaleMs = options.minStaleMs ?? MIN_HEARTBEAT_STALE_MS;
  const maxRows = Math.max(1, Math.min(options.maxRows ?? MAX_HEARTBEAT_QUERY_ROWS, 500));

  const { rows } = await db.query(
    `SELECT worker_name,
            replica_id,
            worker_kind,
            state,
            detail,
            heartbeat_at,
            last_progress_at,
            completed_position,
            lag_units,
            consecutive_failures,
            expected_interval_ms,
            evidence_gap,
            workload_pending
       FROM worker_heartbeat
      ORDER BY worker_name ASC, heartbeat_at DESC
      LIMIT $1`,
    [maxRows],
  );

  return rows.map((row) => {
    const worker = sanitizeWorkerName(text(row, "worker_name"));
    const replicaId = sanitizeReplicaId(text(row, "replica_id"), "replica-redacted");
    const rawKind = text(row, "worker_kind");
    const kind: WorkerKind = VALID_KINDS.includes(rawKind as WorkerKind)
      ? (rawKind as WorkerKind)
      : "chain";
    const rawState = text(row, "state");
    const state: ReadinessState = VALID_STATES.includes(rawState as ReadinessState)
      ? (rawState as ReadinessState)
      : "degraded";
    const detail = sanitizeDiagnosticText(text(row, "detail"), MAX_DIAGNOSTIC_LENGTH);

    const rawHeartbeat = timestamp(row, "heartbeat_at");
    const rawMs = rawHeartbeat.getTime();
    const maxAllowedMs = refMs + MAX_HEARTBEAT_FUTURE_SKEW_MS;
    const timestampOutOfBounds = rawMs < MIN_BOUNDED_HEARTBEAT_MS || rawMs > maxAllowedMs;
    const boundedMs = Math.max(MIN_BOUNDED_HEARTBEAT_MS, Math.min(rawMs, refMs));

    const rawProgress = timestampOrNull(row, "last_progress_at");
    const boundedProgress =
      rawProgress === null
        ? null
        : new Date(
            Math.max(MIN_BOUNDED_HEARTBEAT_MS, Math.min(rawProgress.getTime(), refMs)),
          ).toISOString();

    const completedPosition = bigintOrNull(row, "completed_position");
    const lagUnits = integerOrNull(row, "lag_units");
    const consecutiveFailures = Math.max(0, integer(row, "consecutive_failures"));
    const expectedIntervalMs = Math.max(250, integer(row, "expected_interval_ms"));
    const evidenceGap = boolean(row, "evidence_gap");
    const workloadPending = integerOrNull(row, "workload_pending");

    const staleAfterMs = Math.max(expectedIntervalMs * staleMultiplier, minStaleMs);
    const ageMs = Math.max(0, Math.min(refMs - boundedMs, MAX_REPORTED_HEARTBEAT_AGE_MS));
    const stale = timestampOutOfBounds || ageMs > staleAfterMs;
    const fresh = !stale && state === "ready" && !evidenceGap;

    return {
      worker,
      replicaId,
      kind,
      state,
      detail,
      heartbeatAt: new Date(boundedMs).toISOString(),
      lastProgressAt: boundedProgress,
      completedPosition: completedPosition === null ? null : completedPosition.toString(),
      lagUnits,
      consecutiveFailures,
      expectedIntervalMs,
      staleAfterMs,
      ageMs,
      stale,
      timestampOutOfBounds,
      evidenceGap,
      workloadPending,
      fresh,
    };
  });
}

export function expectedChainWorkers(config: AppConfig): readonly string[] {
  const names: string[] = [];
  if (config.indexer.stellar !== null) {
    names.push(config.indexer.stellar.chain);
  }
  for (const chain of config.indexer.evm) {
    names.push(chain.chain);
  }
  return names;
}

export async function summarizeWorkerHeartbeats(
  db: Queryable,
  config: AppConfig,
  options: EvaluateHeartbeatOptions = {},
): Promise<PersistentHeartbeatSummary> {
  const nowDate = options.now?.() ?? new Date();
  const heartbeats = await readWorkerHeartbeats(db, options);
  const expected = expectedChainWorkers(config);

  // Select the most recent replica heartbeat per logical worker so a retired replica does not
  // overshadow an active replacement.
  const latestByWorker = new Map<string, EvaluatedWorkerHeartbeat>();
  for (const hb of heartbeats) {
    if (!latestByWorker.has(hb.worker)) {
      latestByWorker.set(hb.worker, hb);
    }
  }

  const missingWorkers = expected.filter((worker) => !latestByWorker.has(worker));
  const freshWorkers: string[] = [];
  const staleWorkers: string[] = [];
  const evidenceGapWorkers: string[] = [];
  const degradedWorkers: string[] = [];
  let totalWorkloadPending = 0;

  for (const [worker, hb] of latestByWorker.entries()) {
    if (hb.workloadPending !== null && hb.workloadPending > 0) {
      totalWorkloadPending += hb.workloadPending;
    }
    if (hb.stale) {
      staleWorkers.push(worker);
    }
    if (hb.evidenceGap) {
      evidenceGapWorkers.push(worker);
    }
    if (hb.state !== "ready") {
      degradedWorkers.push(worker);
    }
    if (hb.fresh) {
      freshWorkers.push(worker);
    }
  }

  if (expected.length === 0 && latestByWorker.size === 0) {
    return {
      status: "degraded",
      detail:
        "no persistent worker heartbeats recorded; database health alone does not imply an active indexer",
      evaluatedAt: nowDate.toISOString(),
      expectedWorkers: expected,
      freshWorkers,
      staleWorkers,
      missingWorkers,
      evidenceGapWorkers,
      degradedWorkers,
      totalWorkloadPending,
      heartbeats,
    };
  }

  const reasons: string[] = [];
  if (missingWorkers.length > 0) {
    reasons.push(`missing heartbeat for ${missingWorkers.join(", ")}`);
  }
  if (staleWorkers.length > 0) {
    const formatted = staleWorkers
      .map((name) => {
        const hb = latestByWorker.get(name);
        if (!hb) return name;
        return hb.timestampOutOfBounds
          ? `${name} (invalid clock skew)`
          : `${name} (${String(Math.floor(hb.ageMs / 1000))}s old)`;
      })
      .join(", ");
    reasons.push(`stale heartbeat for ${formatted}`);
  }
  if (evidenceGapWorkers.length > 0) {
    reasons.push(`evidence gap reported on ${evidenceGapWorkers.join(", ")}`);
  }
  if (degradedWorkers.length > 0) {
    reasons.push(`degraded worker state on ${degradedWorkers.join(", ")}`);
  }

  if (reasons.length > 0) {
    return {
      status: "degraded",
      detail: sanitizeDiagnosticText(reasons.join("; "), MAX_DIAGNOSTIC_LENGTH),
      evaluatedAt: nowDate.toISOString(),
      expectedWorkers: expected,
      freshWorkers,
      staleWorkers,
      missingWorkers,
      evidenceGapWorkers,
      degradedWorkers,
      totalWorkloadPending,
      heartbeats,
    };
  }

  return {
    status: "ready",
    detail: sanitizeDiagnosticText(
      `fresh persistent heartbeats for ${freshWorkers.join(", ")}`,
      MAX_DIAGNOSTIC_LENGTH,
    ),
    evaluatedAt: nowDate.toISOString(),
    expectedWorkers: expected,
    freshWorkers,
    staleWorkers,
    missingWorkers,
    evidenceGapWorkers,
    degradedWorkers,
    totalWorkloadPending,
    heartbeats,
  };
}

export async function checkPersistentIndexerHeartbeats(
  db: Queryable,
  config: AppConfig,
  options: EvaluateHeartbeatOptions = {},
): Promise<ReadinessReport> {
  const summary = await summarizeWorkerHeartbeats(db, config, options);
  return {
    name: "indexer-heartbeat",
    state: summary.status,
    detail: summary.detail,
  };
}
