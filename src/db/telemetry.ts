/**
 * Bounded database pool saturation and per-workload query latency telemetry (#110).
 *
 * Memory is strictly bounded via a fixed-capacity ring buffer per workload so long-running
 * API and indexer processes never accumulate unbounded latency samples. SQL parameters are
 * never recorded, stored, or logged.
 */

export type DbWorkload =
  | "health"
  | "metrics"
  | "transfers"
  | "claims"
  | "routes"
  | "indexer"
  | "rails"
  | "keeper"
  | "maintenance"
  | "diagnostics"
  | "transaction"
  | "other";

export interface QueryOptions {
  readonly workload?: DbWorkload;
  /** Cancel only the borrowed connection's current query, without reusing it first. */
  readonly signal?: AbortSignal;
}

export interface PoolSaturationSnapshot {
  readonly maxConnections: number;
  readonly totalConnections: number;
  readonly idleConnections: number;
  readonly activeConnections: number;
  readonly waitingRequests: number;
  readonly utilizationRatio: number;
  readonly saturated: boolean;
}

export interface WorkloadLatencyStats {
  readonly count: number;
  readonly errorCount: number;
  readonly sampleCount: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly avgMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly lastQueryAt: string | null;
}

export interface DbTelemetrySnapshot {
  readonly pool: PoolSaturationSnapshot;
  readonly workloads: Readonly<Record<string, WorkloadLatencyStats>>;
}

export interface PoolStatsSource {
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
  readonly maxConnections: number;
}

export const DEFAULT_MAX_SAMPLES_PER_WORKLOAD = 256;

/**
 * Classify a SQL statement into a bounded workload label without inspecting parameters.
 */
export function classifySqlWorkload(sql: string): DbWorkload {
  const normalized = sql.trim().toLowerCase();
  if (normalized === "select 1") return "health";
  if (
    normalized === "begin" ||
    normalized === "commit" ||
    normalized === "rollback" ||
    normalized.startsWith("begin ")
  ) {
    return "transaction";
  }
  if (normalized.includes("pgmigrations") || normalized.includes("pg_stat")) {
    return "diagnostics";
  }
  if (
    normalized.includes("indexer_cursor") ||
    normalized.includes("indexer_lease") ||
    normalized.includes("stellar_history_gap") ||
    normalized.includes("stellar_backfill_cursor") ||
    normalized.includes("stellar_event_") ||
    normalized.includes("stellar_scan_journal")
  ) {
    return "indexer";
  }
  if (normalized.includes("delete from rail_attestation")) {
    return "maintenance";
  }
  if (normalized.includes("rail_attestation")) {
    return "rails";
  }
  if (
    /^(?:insert|update|delete|with)\b/.test(normalized) &&
    (normalized.includes("outbound_transfer") || normalized.includes("inbound_delivery"))
  )
    return "indexer";
  if (normalized.includes("pending_claim")) {
    return "claims";
  }
  if (normalized.includes("route_health")) {
    return "routes";
  }
  if (normalized.includes("outbound_transfer") || normalized.includes("inbound_delivery")) {
    return "transfers";
  }
  return "other";
}

class BoundedLatencyRing {
  private readonly samples: number[];
  private writeIndex = 0;
  private filled = 0;
  private totalCount = 0;
  private errorCount = 0;
  private lastQueryAtMs: number | null = null;

  constructor(private readonly capacity: number) {
    this.samples = new Array<number>(capacity).fill(0);
  }

  record(durationMs: number, ok: boolean, nowMs: number): void {
    const clamped = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
    this.samples[this.writeIndex] = clamped;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    if (this.filled < this.capacity) {
      this.filled += 1;
    }
    this.totalCount += 1;
    if (!ok) {
      this.errorCount += 1;
    }
    this.lastQueryAtMs = nowMs;
  }

  snapshot(): WorkloadLatencyStats {
    if (this.filled === 0) {
      return {
        count: this.totalCount,
        errorCount: this.errorCount,
        sampleCount: 0,
        minMs: 0,
        maxMs: 0,
        avgMs: 0,
        p50Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
        lastQueryAt:
          this.lastQueryAtMs !== null ? new Date(this.lastQueryAtMs).toISOString() : null,
      };
    }

    const active = this.samples.slice(0, this.filled).sort((a, b) => a - b);
    let sum = 0;
    for (const value of active) {
      sum += value;
    }

    return {
      count: this.totalCount,
      errorCount: this.errorCount,
      sampleCount: this.filled,
      minMs: roundMs(active[0] ?? 0),
      maxMs: roundMs(active[active.length - 1] ?? 0),
      avgMs: roundMs(sum / this.filled),
      p50Ms: roundMs(percentile(active, 0.5)),
      p95Ms: roundMs(percentile(active, 0.95)),
      p99Ms: roundMs(percentile(active, 0.99)),
      lastQueryAt: this.lastQueryAtMs !== null ? new Date(this.lastQueryAtMs).toISOString() : null,
    };
  }
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export class DbTelemetryCollector {
  private readonly workloads = new Map<string, BoundedLatencyRing>();
  private readonly maxSamplesPerWorkload: number;

  constructor(maxSamplesPerWorkload = DEFAULT_MAX_SAMPLES_PER_WORKLOAD) {
    if (
      !Number.isSafeInteger(maxSamplesPerWorkload) ||
      maxSamplesPerWorkload < 1 ||
      maxSamplesPerWorkload > 4096
    )
      throw new RangeError("database latency sample capacity must be1–4096");
    this.maxSamplesPerWorkload = maxSamplesPerWorkload;
  }

  record(workload: DbWorkload, durationMs: number, ok: boolean, nowMs = Date.now()): void {
    const boundedWorkloads: readonly string[] = [
      "health",
      "metrics",
      "transfers",
      "claims",
      "routes",
      "indexer",
      "rails",
      "keeper",
      "maintenance",
      "diagnostics",
      "transaction",
      "other",
    ];
    if (!boundedWorkloads.includes(workload)) workload = "other";
    let ring = this.workloads.get(workload);
    if (ring === undefined) {
      ring = new BoundedLatencyRing(this.maxSamplesPerWorkload);
      this.workloads.set(workload, ring);
    }
    ring.record(durationMs, ok, nowMs);
  }

  poolSnapshot(source: PoolStatsSource): PoolSaturationSnapshot {
    const maxConnections = Math.max(0, source.maxConnections);
    const totalConnections = Math.max(0, source.totalCount);
    const idleConnections = Math.max(0, source.idleCount);
    const activeConnections = Math.max(0, totalConnections - idleConnections);
    const waitingRequests = Math.max(0, source.waitingCount);
    const utilizationRatio =
      maxConnections > 0 ? Math.round((activeConnections / maxConnections) * 10_000) / 10_000 : 0;
    const saturated =
      waitingRequests > 0 || (maxConnections > 0 && activeConnections >= maxConnections);

    return {
      maxConnections,
      totalConnections,
      idleConnections,
      activeConnections,
      waitingRequests,
      utilizationRatio,
      saturated,
    };
  }

  snapshot(source: PoolStatsSource): DbTelemetrySnapshot {
    const workloads: Record<string, WorkloadLatencyStats> = {};
    for (const [name, ring] of [...this.workloads.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      workloads[name] = ring.snapshot();
    }
    return {
      pool: this.poolSnapshot(source),
      workloads,
    };
  }
}
