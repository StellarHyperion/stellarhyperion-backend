/**
 * Low-cardinality PostgreSQL connection pool saturation and query latency telemetry.
 *
 * Strictly records bounded numeric counters and latency buckets per fixed workload category.
 * Never inspects, stores, or logs SQL query text, bind parameters, wallet identifiers, or
 * connection strings.
 */

export const DB_WORKLOADS = [
  "api",
  "ingestion",
  "rails",
  "keeper",
  "health",
  "maintenance",
] as const;

export type DbWorkload = (typeof DB_WORKLOADS)[number];

export interface QueryLatencyBuckets {
  readonly le5ms: number;
  readonly le25ms: number;
  readonly le100ms: number;
  readonly le500ms: number;
  readonly le2000ms: number;
  readonly gt2000ms: number;
}

export interface WorkloadLatencyMetrics {
  readonly totalQueries: number;
  readonly failedQueries: number;
  readonly totalDurationMs: number;
  readonly maxMs: number;
  readonly acquireCount: number;
  readonly acquireWaitMaxMs: number;
  readonly acquireWaitOverThresholdCount: number;
  readonly transactionsCommitted: number;
  readonly transactionsAborted: number;
  readonly latencyBuckets: QueryLatencyBuckets;
}

export interface PoolSaturationSnapshot {
  readonly maxConnections: number;
  readonly totalConnections: number;
  readonly idleConnections: number;
  readonly activeConnections: number;
  readonly waitingClients: number;
  readonly utilizationRatio: number;
  readonly saturationThresholdRatio: number;
  readonly acquireWarnMs: number;
  readonly saturated: boolean;
  readonly saturationEvents: number;
  readonly acquireWaitMaxMs: number;
  readonly lastSaturatedAt: string | null;
}

export interface DbTelemetrySnapshot {
  readonly pool: PoolSaturationSnapshot;
  readonly workloads: Readonly<Record<DbWorkload, WorkloadLatencyMetrics>>;
}

export interface PoolStatsSource {
  readonly totalCount?: number;
  readonly idleCount?: number;
  readonly waitingCount?: number;
}

export interface TelemetryWarnLogger {
  warn?: (fields: Record<string, unknown>, msg: string) => void;
}

export interface DbTelemetryOptions {
  readonly maxConnections: number;
  readonly saturationThresholdRatio?: number | undefined;
  readonly acquireWarnMs?: number | undefined;
  readonly warnCooldownMs?: number | undefined;
  readonly logger?: TelemetryWarnLogger | undefined;
}

interface MutableWorkloadState {
  totalQueries: number;
  failedQueries: number;
  totalDurationMs: number;
  maxMs: number;
  acquireCount: number;
  acquireWaitMaxMs: number;
  acquireWaitOverThresholdCount: number;
  transactionsCommitted: number;
  transactionsAborted: number;
  le5ms: number;
  le25ms: number;
  le100ms: number;
  le500ms: number;
  le2000ms: number;
  gt2000ms: number;
}

function createMutableWorkloadState(): MutableWorkloadState {
  return {
    totalQueries: 0,
    failedQueries: 0,
    totalDurationMs: 0,
    maxMs: 0,
    acquireCount: 0,
    acquireWaitMaxMs: 0,
    acquireWaitOverThresholdCount: 0,
    transactionsCommitted: 0,
    transactionsAborted: 0,
    le5ms: 0,
    le25ms: 0,
    le100ms: 0,
    le500ms: 0,
    le2000ms: 0,
    gt2000ms: 0,
  };
}

function snapshotWorkload(state: MutableWorkloadState): WorkloadLatencyMetrics {
  return {
    totalQueries: state.totalQueries,
    failedQueries: state.failedQueries,
    totalDurationMs: Number(state.totalDurationMs.toFixed(3)),
    maxMs: Number(state.maxMs.toFixed(3)),
    acquireCount: state.acquireCount,
    acquireWaitMaxMs: Number(state.acquireWaitMaxMs.toFixed(3)),
    acquireWaitOverThresholdCount: state.acquireWaitOverThresholdCount,
    transactionsCommitted: state.transactionsCommitted,
    transactionsAborted: state.transactionsAborted,
    latencyBuckets: {
      le5ms: state.le5ms,
      le25ms: state.le25ms,
      le100ms: state.le100ms,
      le500ms: state.le500ms,
      le2000ms: state.le2000ms,
      gt2000ms: state.gt2000ms,
    },
  };
}

export function createEmptyDbTelemetrySnapshot(maxConnections = 10): DbTelemetrySnapshot {
  const empty = snapshotWorkload(createMutableWorkloadState());
  return {
    pool: {
      maxConnections,
      totalConnections: 0,
      idleConnections: 0,
      activeConnections: 0,
      waitingClients: 0,
      utilizationRatio: 0,
      saturationThresholdRatio: 0.8,
      acquireWarnMs: 200,
      saturated: false,
      saturationEvents: 0,
      acquireWaitMaxMs: 0,
      lastSaturatedAt: null,
    },
    workloads: {
      api: empty,
      ingestion: empty,
      rails: empty,
      keeper: empty,
      health: empty,
      maintenance: empty,
    },
  };
}

export class DbTelemetryCollector {
  private readonly maxConnections: number;
  private readonly saturationThresholdRatio: number;
  private readonly acquireWarnMs: number;
  private readonly warnCooldownMs: number;
  private readonly logger: TelemetryWarnLogger | undefined;
  private readonly workloads: Record<DbWorkload, MutableWorkloadState>;

  private inFlightQueries = 0;
  private activeCheckouts = 0;
  private waitingConnects = 0;
  private saturationEvents = 0;
  private acquireWaitMaxMs = 0;
  private lastSaturatedAt: string | null = null;
  private lastWarnAtMs = 0;

  constructor(
    private readonly poolStats: PoolStatsSource,
    options: DbTelemetryOptions,
  ) {
    this.maxConnections = Math.max(1, options.maxConnections);
    this.saturationThresholdRatio = options.saturationThresholdRatio ?? 0.8;
    this.acquireWarnMs = options.acquireWarnMs ?? 200;
    this.warnCooldownMs = options.warnCooldownMs ?? 5_000;
    this.logger = options.logger;
    this.workloads = {
      api: createMutableWorkloadState(),
      ingestion: createMutableWorkloadState(),
      rails: createMutableWorkloadState(),
      keeper: createMutableWorkloadState(),
      health: createMutableWorkloadState(),
      maintenance: createMutableWorkloadState(),
    };
  }

  beginQuery(workload: DbWorkload): void {
    this.inFlightQueries += 1;
    this.observeSaturation(workload, 0);
  }

  endQuery(workload: DbWorkload, durationMs: number, failed: boolean): void {
    this.inFlightQueries = Math.max(0, this.inFlightQueries - 1);
    this.recordQueryDuration(workload, durationMs, failed);
  }

  recordClientQuery(workload: DbWorkload, durationMs: number, failed: boolean): void {
    this.recordQueryDuration(workload, durationMs, failed);
  }

  beginAcquire(workload: DbWorkload): void {
    this.waitingConnects += 1;
    this.observeSaturation(workload, 0);
  }

  endAcquire(workload: DbWorkload, acquireDurationMs: number, succeeded: boolean): void {
    this.waitingConnects = Math.max(0, this.waitingConnects - 1);
    if (succeeded) {
      this.activeCheckouts += 1;
    }
    const clampedMs = Math.max(0, acquireDurationMs);
    const state = this.workloads[workload];
    state.acquireCount += 1;
    if (clampedMs > state.acquireWaitMaxMs) {
      state.acquireWaitMaxMs = clampedMs;
    }
    if (clampedMs > this.acquireWaitMaxMs) {
      this.acquireWaitMaxMs = clampedMs;
    }
    if (clampedMs >= this.acquireWarnMs) {
      state.acquireWaitOverThresholdCount += 1;
    }
    this.observeSaturation(workload, clampedMs);
  }

  releaseCheckout(): void {
    this.activeCheckouts = Math.max(0, this.activeCheckouts - 1);
  }

  recordTransactionOutcome(workload: DbWorkload, committed: boolean): void {
    const state = this.workloads[workload];
    if (committed) {
      state.transactionsCommitted += 1;
    } else {
      state.transactionsAborted += 1;
    }
  }

  snapshot(): DbTelemetrySnapshot {
    const pool = this.computePoolSnapshot();
    return {
      pool,
      workloads: {
        api: snapshotWorkload(this.workloads.api),
        ingestion: snapshotWorkload(this.workloads.ingestion),
        rails: snapshotWorkload(this.workloads.rails),
        keeper: snapshotWorkload(this.workloads.keeper),
        health: snapshotWorkload(this.workloads.health),
        maintenance: snapshotWorkload(this.workloads.maintenance),
      },
    };
  }

  private recordQueryDuration(workload: DbWorkload, durationMs: number, failed: boolean): void {
    const clamped = Math.max(0, durationMs);
    const state = this.workloads[workload];
    state.totalQueries += 1;
    if (failed) state.failedQueries += 1;
    state.totalDurationMs += clamped;
    if (clamped > state.maxMs) {
      state.maxMs = clamped;
    }
    if (clamped <= 5) {
      state.le5ms += 1;
    } else if (clamped <= 25) {
      state.le25ms += 1;
    } else if (clamped <= 100) {
      state.le100ms += 1;
    } else if (clamped <= 500) {
      state.le500ms += 1;
    } else if (clamped <= 2000) {
      state.le2000ms += 1;
    } else {
      state.gt2000ms += 1;
    }
  }

  private computePoolSnapshot(): PoolSaturationSnapshot {
    const poolTotal = Math.max(0, this.poolStats.totalCount ?? 0);
    const poolIdle = Math.max(0, this.poolStats.idleCount ?? 0);
    const poolWaiting = Math.max(0, this.poolStats.waitingCount ?? 0);

    const poolActive = Math.max(0, poolTotal - poolIdle);
    const trackedActive = this.activeCheckouts + this.inFlightQueries;
    const activeConnections = Math.min(this.maxConnections, Math.max(poolActive, trackedActive));
    const totalConnections = Math.max(poolTotal, activeConnections + poolIdle);
    const waitingFromOverflow = Math.max(0, trackedActive - this.maxConnections);
    const waitingClients = Math.max(poolWaiting, this.waitingConnects, waitingFromOverflow);
    const utilizationRatio = Number(
      Math.min(1, activeConnections / this.maxConnections).toFixed(4),
    );
    const saturated = waitingClients > 0 || utilizationRatio >= this.saturationThresholdRatio;

    return {
      maxConnections: this.maxConnections,
      totalConnections,
      idleConnections: poolIdle,
      activeConnections,
      waitingClients,
      utilizationRatio,
      saturationThresholdRatio: this.saturationThresholdRatio,
      acquireWarnMs: this.acquireWarnMs,
      saturated,
      saturationEvents: this.saturationEvents,
      acquireWaitMaxMs: Number(this.acquireWaitMaxMs.toFixed(3)),
      lastSaturatedAt: this.lastSaturatedAt,
    };
  }

  private observeSaturation(workload: DbWorkload, acquireWaitMs: number): void {
    const current = this.computePoolSnapshot();
    const slowAcquire = acquireWaitMs >= this.acquireWarnMs;
    if (!current.saturated && !slowAcquire) return;

    this.saturationEvents += 1;
    const now = new Date();
    this.lastSaturatedAt = now.toISOString();

    if (this.logger?.warn && now.getTime() - this.lastWarnAtMs >= this.warnCooldownMs) {
      this.lastWarnAtMs = now.getTime();
      this.logger.warn(
        {
          workload,
          activeConnections: current.activeConnections,
          waitingClients: current.waitingClients,
          maxConnections: current.maxConnections,
          utilizationRatio: current.utilizationRatio,
          acquireWaitMs: Number(acquireWaitMs.toFixed(3)),
        },
        "postgres pool saturation warning threshold reached",
      );
    }
  }
}
