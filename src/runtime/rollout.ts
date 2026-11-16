import type { Logger } from "pino";

import type { Queryable, QueryResultRows, Transactional } from "../db/pool.js";
import { bigintOf, boolean, maybeOne, one, text, timestamp, type Row } from "../db/rows.js";
import type { ReadinessReport, ReadinessSource } from "./readiness.js";

export const REQUIRED_SCHEMA_TABLES = [
  "admin_action",
  "inbound_delivery",
  "indexer_cursor",
  "indexer_rollout_lease",
  "outbound_transfer",
  "pending_claim",
  "rail_attestation",
  "route_health",
] as const;

export type RolloutPhase = "starting" | "admitted" | "draining" | "stopped" | "failed";

export interface SchemaAdmissionCheckResult {
  readonly admitted: boolean;
  readonly presentTables: readonly string[];
  readonly missingTables: readonly string[];
  readonly detail: string;
}

export async function verifySchemaAdmission(
  db: Queryable,
  requiredTables: readonly string[] = REQUIRED_SCHEMA_TABLES,
): Promise<SchemaAdmissionCheckResult> {
  const { rows } = await db.query(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_type = 'BASE TABLE'
      ORDER BY table_name ASC`,
  );
  const presentSet = new Set(rows.map((row) => text(row, "table_name")));
  const missingTables = requiredTables.filter((table) => !presentSet.has(table));
  if (missingTables.length > 0) {
    return {
      admitted: false,
      presentTables: [...presentSet].sort(),
      missingTables,
      detail: `database schema incomplete; missing tables: ${missingTables.join(", ")}`,
    };
  }
  return {
    admitted: true,
    presentTables: [...presentSet].sort(),
    missingTables: [],
    detail: `verified ${String(requiredTables.length)} required schema tables`,
  };
}

export interface RolloutLeaseRecord {
  readonly leaseKey: string;
  readonly holderId: string;
  readonly fenceToken: bigint;
  readonly draining: boolean;
  readonly acquiredAt: Date;
  readonly expiresAt: Date;
  readonly updatedAt: Date;
}

export type RolloutLeaseAttempt =
  | { readonly acquired: true; readonly lease: RolloutLeaseRecord }
  | {
      readonly acquired: false;
      readonly activeHolderId: string;
      readonly expiresAt: Date;
    };

export interface RolloutLeaseStorePort {
  inspect(leaseKey: string): Promise<RolloutLeaseRecord | null>;
  tryAcquireOrRenew(
    leaseKey: string,
    holderId: string,
    leaseTtlMs: number,
    nowMs?: number,
  ): Promise<RolloutLeaseAttempt>;
  verifyFence(
    queryable: Queryable,
    leaseKey: string,
    holderId: string,
    fenceToken: bigint,
    nowMs?: number,
  ): Promise<void>;
  releaseAllForHolder(holderId: string, nowMs?: number): Promise<number>;
}

export class RolloutLeaseLostError extends Error {
  readonly leaseKey: string;
  readonly holderId: string;
  readonly expectedFenceToken: bigint;

  constructor(leaseKey: string, holderId: string, expectedFenceToken: bigint, reason: string) {
    super(
      `Rollout watcher lease lost for ${leaseKey} (holder=${holderId}, fence=${String(expectedFenceToken)}): ${reason}`,
    );
    this.name = "RolloutLeaseLostError";
    this.leaseKey = leaseKey;
    this.holderId = holderId;
    this.expectedFenceToken = expectedFenceToken;
  }
}

function parseRolloutLeaseRow(row: Row): RolloutLeaseRecord {
  return {
    leaseKey: text(row, "lease_key"),
    holderId: text(row, "holder_id"),
    fenceToken: bigintOf(row, "fence_token"),
    draining: boolean(row, "draining"),
    acquiredAt: timestamp(row, "acquired_at"),
    expiresAt: timestamp(row, "expires_at"),
    updatedAt: timestamp(row, "updated_at"),
  };
}

export class PostgresRolloutLeaseStore implements RolloutLeaseStorePort {
  constructor(
    private readonly db: Queryable,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  private resolveNow(nowMs?: number): Date {
    return new Date(nowMs ?? this.clock());
  }

  async inspect(leaseKey: string): Promise<RolloutLeaseRecord | null> {
    const { rows } = await this.db.query(
      `SELECT lease_key, holder_id, fence_token, draining, acquired_at, expires_at, updated_at
         FROM indexer_rollout_lease
        WHERE lease_key = $1`,
      [leaseKey],
    );
    const row = maybeOne(rows, "indexer_rollout_lease.inspect");
    return row ? parseRolloutLeaseRow(row) : null;
  }

  async tryAcquireOrRenew(
    leaseKey: string,
    holderId: string,
    leaseTtlMs: number,
    nowMs?: number,
  ): Promise<RolloutLeaseAttempt> {
    const now = this.resolveNow(nowMs);
    const expiresAt = new Date(now.getTime() + leaseTtlMs);

    const { rows } = await this.db.query(
      `INSERT INTO indexer_rollout_lease (
         lease_key, holder_id, fence_token, draining, acquired_at, expires_at, updated_at
       )
       VALUES ($1, $2, 1, false, $3, $4, $3)
       ON CONFLICT (lease_key) DO UPDATE SET
         holder_id = EXCLUDED.holder_id,
         fence_token = CASE
           WHEN indexer_rollout_lease.holder_id = EXCLUDED.holder_id
                AND NOT indexer_rollout_lease.draining
                AND indexer_rollout_lease.expires_at > $3
             THEN indexer_rollout_lease.fence_token
           ELSE indexer_rollout_lease.fence_token + 1
         END,
         draining = false,
         acquired_at = CASE
           WHEN indexer_rollout_lease.holder_id = EXCLUDED.holder_id
                AND NOT indexer_rollout_lease.draining
                AND indexer_rollout_lease.expires_at > $3
             THEN indexer_rollout_lease.acquired_at
           ELSE $3
         END,
         expires_at = $4,
         updated_at = $3
       WHERE (
               indexer_rollout_lease.holder_id = EXCLUDED.holder_id
               AND NOT indexer_rollout_lease.draining
               AND indexer_rollout_lease.expires_at > $3
             )
          OR indexer_rollout_lease.expires_at <= $3
          OR indexer_rollout_lease.draining
       RETURNING lease_key, holder_id, fence_token, draining, acquired_at, expires_at, updated_at`,
      [leaseKey, holderId, now.toISOString(), expiresAt.toISOString()],
    );

    if (rows.length === 0) {
      const current = await this.inspect(leaseKey);
      return {
        acquired: false,
        activeHolderId: current?.holderId ?? "unknown",
        expiresAt: current?.expiresAt ?? expiresAt,
      };
    }

    return {
      acquired: true,
      lease: parseRolloutLeaseRow(one(rows, "indexer_rollout_lease.tryAcquireOrRenew")),
    };
  }

  async verifyFence(
    queryable: Queryable,
    leaseKey: string,
    holderId: string,
    fenceToken: bigint,
    nowMs?: number,
  ): Promise<void> {
    const now = this.resolveNow(nowMs);
    const { rows } = await queryable.query(
      `SELECT fence_token
         FROM indexer_rollout_lease
        WHERE lease_key = $1
          AND holder_id = $2
          AND fence_token = $3
          AND NOT draining
          AND expires_at > $4`,
      [leaseKey, holderId, String(fenceToken), now.toISOString()],
    );
    if (rows.length === 0) {
      throw new RolloutLeaseLostError(
        leaseKey,
        holderId,
        fenceToken,
        "lease expired, entered drain or transferred to a newer container instance",
      );
    }
  }

  async releaseAllForHolder(holderId: string, nowMs?: number): Promise<number> {
    const now = this.resolveNow(nowMs);
    const { rowCount } = await this.db.query(
      `UPDATE indexer_rollout_lease
          SET draining = true,
              expires_at = $2,
              updated_at = $2
        WHERE holder_id = $1`,
      [holderId, now.toISOString()],
    );
    return rowCount;
  }
}

export interface StartupProbeReport {
  readonly status: "admitted" | "starting" | "draining" | "failed";
  readonly httpStatus: 200 | 503;
  readonly instanceId: string;
  readonly phase: RolloutPhase;
  readonly detail: string;
  readonly missingTables: readonly string[];
}

export interface RolloutCoordinatorOptions {
  readonly db: Transactional;
  readonly instanceId: string;
  readonly leaseTtlMs: number;
  readonly drainGraceMs?: number | undefined;
  readonly logger: Logger;
  readonly leaseStore?: RolloutLeaseStorePort | undefined;
  readonly clock?: (() => number) | undefined;
}

const MUTATING_SQL_RE = /^\s*(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE)\b/i;

export class RolloutCoordinator implements ReadinessSource {
  private currentPhase: RolloutPhase = "starting";
  private schemaDetail = "schema admission check has not run yet";
  private missingSchemaTables: readonly string[] = [];
  private writesBlockedAfterDrain = false;
  readonly leaseStore: RolloutLeaseStorePort;
  private readonly nowFn: () => number;

  constructor(private readonly options: RolloutCoordinatorOptions) {
    this.nowFn = options.clock ?? (() => Date.now());
    this.leaseStore = options.leaseStore ?? new PostgresRolloutLeaseStore(options.db, this.nowFn);
  }

  get instanceId(): string {
    return this.options.instanceId;
  }

  get leaseTtlMs(): number {
    return this.options.leaseTtlMs;
  }

  get phase(): RolloutPhase {
    return this.currentPhase;
  }

  now(): number {
    return this.nowFn();
  }

  async admitSchema(): Promise<SchemaAdmissionCheckResult> {
    try {
      const check = await verifySchemaAdmission(this.options.db);
      this.schemaDetail = check.detail;
      this.missingSchemaTables = check.missingTables;
      if (!check.admitted) {
        this.currentPhase = "failed";
        return check;
      }
      if (this.currentPhase === "starting" || this.currentPhase === "failed") {
        this.currentPhase = "admitted";
      }
      return check;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.currentPhase = "failed";
      this.schemaDetail = `schema admission query failed: ${msg}`;
      return {
        admitted: false,
        presentTables: [],
        missingTables: [...REQUIRED_SCHEMA_TABLES],
        detail: this.schemaDetail,
      };
    }
  }

  startupReport(): StartupProbeReport {
    if (this.currentPhase === "admitted") {
      return {
        status: "admitted",
        httpStatus: 200,
        instanceId: this.options.instanceId,
        phase: this.currentPhase,
        detail: this.schemaDetail,
        missingTables: [],
      };
    }
    if (this.currentPhase === "draining" || this.currentPhase === "stopped") {
      return {
        status: "draining",
        httpStatus: 503,
        instanceId: this.options.instanceId,
        phase: this.currentPhase,
        detail: "instance is draining for rollout and not accepting new work",
        missingTables: [],
      };
    }
    return {
      status: this.currentPhase === "failed" ? "failed" : "starting",
      httpStatus: 503,
      instanceId: this.options.instanceId,
      phase: this.currentPhase,
      detail: this.schemaDetail,
      missingTables: this.missingSchemaTables,
    };
  }

  readiness(): ReadinessReport {
    if (this.currentPhase === "admitted") {
      return {
        name: "rollout",
        state: "ready",
        detail: `admitted (${this.options.instanceId}): ${this.schemaDetail}`,
      };
    }
    if (this.currentPhase === "draining" || this.currentPhase === "stopped") {
      return {
        name: "rollout",
        state: "down",
        detail: `draining (${this.options.instanceId}): releasing watcher leases and shedding HTTP traffic`,
      };
    }
    return {
      name: "rollout",
      state: "down",
      detail: `not admitted (${this.options.instanceId}): ${this.schemaDetail}`,
    };
  }

  /**
   * Transitions this container into drain mode, optionally waits `drainGraceMs` so load balancers
   * stop sending HTTP traffic while `/health` stays 200, stops background workers, fences off
   * further writes and releases all held watcher leases in PostgreSQL.
   */
  async drainAndRelease(reason: string, stopWorkers: () => Promise<void>): Promise<number> {
    if (this.currentPhase === "stopped") return 0;
    const hadAdmission = this.currentPhase === "admitted" || this.currentPhase === "draining";
    if (hadAdmission) {
      this.currentPhase = "draining";
    }
    this.options.logger.info(
      { instanceId: this.options.instanceId, reason, hadAdmission },
      "entering container rollout drain; /ready now returns 503",
    );

    const graceMs = hadAdmission ? (this.options.drainGraceMs ?? 0) : 0;
    if (graceMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, graceMs));
    }

    await stopWorkers();
    this.writesBlockedAfterDrain = true;
    const released = hadAdmission
      ? await this.leaseStore.releaseAllForHolder(this.options.instanceId, this.now())
      : 0;
    if (this.currentPhase !== "failed") {
      this.currentPhase = "stopped";
    }
    this.options.logger.info(
      { instanceId: this.options.instanceId, releasedLeases: released },
      "completed watcher drain and released rollout leases",
    );
    return released;
  }

  createFencedDb(
    baseDb: Transactional,
    leaseKey: string,
    getActiveFenceToken: () => bigint | null,
  ): Transactional {
    const assertWritable = async (queryable: Queryable): Promise<void> => {
      if (this.writesBlockedAfterDrain || this.currentPhase === "stopped") {
        throw new RolloutLeaseLostError(
          leaseKey,
          this.options.instanceId,
          getActiveFenceToken() ?? 0n,
          "instance has drained and released watcher ownership",
        );
      }
      const token = getActiveFenceToken();
      if (token === null) {
        throw new RolloutLeaseLostError(
          leaseKey,
          this.options.instanceId,
          0n,
          "watcher has no active rollout lease token",
        );
      }
      await this.leaseStore.verifyFence(
        queryable,
        leaseKey,
        this.options.instanceId,
        token,
        this.now(),
      );
    };

    return {
      query: async (sql: string, params: readonly unknown[] = []): Promise<QueryResultRows> => {
        if (MUTATING_SQL_RE.test(sql)) {
          await assertWritable(baseDb);
        }
        return baseDb.query(sql, params);
      },
      transaction: async <T>(work: (tx: Queryable) => Promise<T>): Promise<T> => {
        if (this.writesBlockedAfterDrain || this.currentPhase === "stopped") {
          throw new RolloutLeaseLostError(
            leaseKey,
            this.options.instanceId,
            getActiveFenceToken() ?? 0n,
            "instance has drained and released watcher ownership",
          );
        }
        return baseDb.transaction(async (tx) => {
          const wrappedTx: Queryable = {
            query: async (
              sql: string,
              params: readonly unknown[] = [],
            ): Promise<QueryResultRows> => {
              return tx.query(sql, params);
            },
          };
          const result = await work(wrappedTx);
          // Re-verify lease ownership inside the open transaction right before COMMIT so a
          // stalled container that lost its lease mid-page rolls back all cursor and event writes!
          await assertWritable(tx);
          return result;
        });
      },
    };
  }
}

export interface LeasedPassTarget extends ReadinessSource {
  readonly name: string;
  tick(signal: AbortSignal): Promise<boolean>;
}

export class LeasedPass implements LeasedPassTarget {
  private activeFenceToken: bigint | null = null;
  private standbyHolderId: string | null = null;

  constructor(
    private readonly leaseKey: string,
    private readonly coordinator: RolloutCoordinator,
    private readonly buildInner: (getActiveFenceToken: () => bigint | null) => LeasedPassTarget,
    private readonly logger: Logger,
  ) {
    this.inner = this.buildInner(() => this.activeFenceToken);
  }

  private readonly inner: LeasedPassTarget;

  get name(): string {
    return this.inner.name;
  }

  get currentFenceToken(): bigint | null {
    return this.activeFenceToken;
  }

  async tick(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || this.coordinator.phase !== "admitted") {
      this.activeFenceToken = null;
      return false;
    }

    const attempt = await this.coordinator.leaseStore.tryAcquireOrRenew(
      this.leaseKey,
      this.coordinator.instanceId,
      this.coordinator.leaseTtlMs,
      this.coordinator.now(),
    );

    if (!attempt.acquired) {
      if (this.standbyHolderId !== attempt.activeHolderId) {
        this.standbyHolderId = attempt.activeHolderId;
        this.logger.info(
          {
            leaseKey: this.leaseKey,
            instanceId: this.coordinator.instanceId,
            activeHolderId: attempt.activeHolderId,
            expiresAt: attempt.expiresAt.toISOString(),
          },
          "standby container waiting for active peer to release watcher rollout lease",
        );
      }
      this.activeFenceToken = null;
      return false;
    }

    this.standbyHolderId = null;
    this.activeFenceToken = attempt.lease.fenceToken;
    return this.inner.tick(signal);
  }

  async readiness(): Promise<ReadinessReport> {
    if (this.standbyHolderId !== null) {
      return {
        name: this.name,
        state: "ready",
        detail: `standby: shared cursor lease held by ${this.standbyHolderId}`,
      };
    }
    return this.inner.readiness();
  }
}
