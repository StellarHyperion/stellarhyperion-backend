/**
 * Persisted worker run correlation across hosted catch-up jobs and background passes.
 *
 * Links safe public run identifiers to chain scan windows and rail verification transitions in
 * PostgreSQL so API-only processes can inspect catch-up completeness across restarts without
 * conflating separate scheduled executions or leaking credentials.
 */
import { randomBytes } from "node:crypto";

import type { Queryable } from "../db/pool.js";

export type WorkerRunStatus = "running" | "partial" | "completed" | "failed";

const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/;
const STELLAR_SECRET_PATTERN = /^S[A-Z2-7]{55}$/;
const EVM_HEX_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const UNSAFE_SUBSTRING_PATTERN =
  /(?::\/\/|@|\?|&|=|bearer\s+|postgres(?:ql)?:|rediss?:|password|secret|token|apikey|api_key)/i;

/**
 * Check whether an operator-supplied or generated run identifier is safe for public logs,
 * database persistence, and HTTP metrics responses.
 */
export function isSafePublicRunId(candidate: string): boolean {
  if (!SAFE_RUN_ID_PATTERN.test(candidate)) return false;
  if (STELLAR_SECRET_PATTERN.test(candidate)) return false;
  if (EVM_HEX_KEY_PATTERN.test(candidate)) return false;
  if (UNSAFE_SUBSTRING_PATTERN.test(candidate)) return false;
  return true;
}

/** Generate a fresh safe public operation identifier for one scheduled execution. */
export function generateSafeRunId(now: Date = new Date()): string {
  const compactIso = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const suffix = randomBytes(4).toString("hex");
  return `run_${compactIso}_${suffix}`;
}

export function resolveSafeRunId(
  candidate?: string | null,
  now: Date = new Date(),
): { readonly runId: string; readonly rejectedCandidate: boolean } {
  const trimmed = candidate?.trim() ?? "";
  if (trimmed.length === 0) {
    return { runId: generateSafeRunId(now), rejectedCandidate: false };
  }
  if (isSafePublicRunId(trimmed)) {
    return { runId: trimmed, rejectedCandidate: false };
  }
  return { runId: generateSafeRunId(now), rejectedCandidate: true };
}

export interface ScanJournalEntryInput {
  readonly chainKey: string;
  readonly family: "stellar" | "evm";
  readonly fromPosition: bigint;
  readonly toPosition: bigint;
  readonly decodedCount: number;
  readonly skippedCount: number;
  readonly behindCount: number;
}

export interface VerificationTransitionInput {
  readonly transferId: bigint;
  readonly route: number;
  readonly previousStatus: string | null;
  readonly nextStatus: string;
  /** True strictly when canonical destination receipt/event proof verified delivery. */
  readonly verifiedDelivery: boolean;
}

export interface WorkerScanJournalRow {
  readonly chainKey: string;
  readonly family: "stellar" | "evm";
  readonly fromPosition: string;
  readonly toPosition: string;
  readonly decodedCount: number;
  readonly skippedCount: number;
  readonly behindCount: string;
  readonly caughtUp: boolean;
  readonly recordedAt: string;
}

export interface WorkerVerificationJournalRow {
  readonly transferId: string;
  readonly route: number;
  readonly previousStatus: string | null;
  readonly nextStatus: string;
  readonly verifiedDelivery: boolean;
  readonly recordedAt: string;
}

export interface WorkerRunSummary {
  readonly runId: string;
  readonly network: string;
  readonly status: WorkerRunStatus;
  readonly expectedChains: readonly string[];
  readonly expectedRails: readonly string[];
  readonly caughtUpChains: readonly string[];
  readonly caughtUpRails: readonly string[];
  readonly scanWindows: number;
  readonly verificationTransitions: number;
  readonly verifiedDeliveries: number;
  readonly endedReason: string | null;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly endedAt: string | null;
}

export interface WorkerRunDetail extends WorkerRunSummary {
  readonly scans: readonly WorkerScanJournalRow[];
  readonly verifications: readonly WorkerVerificationJournalRow[];
}

export interface WorkerRunCorrelationSnapshot {
  readonly latestRun: WorkerRunDetail | null;
  readonly recentRuns: readonly WorkerRunSummary[];
}

export interface WorkerRunTrackerOptions {
  readonly db: Queryable;
  readonly network: string;
  readonly expectedChains: readonly string[];
  readonly expectedRails: readonly string[];
  readonly now?: () => Date;
}

function isUndefinedTableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "42P01"
  );
}

/**
 * Tracks a single scheduled worker execution, persisting linked scan and verification journals
 * while isolating separate runs across restarts.
 */
export class WorkerRunTracker {
  private currentRunId: string | null = null;
  private currentStatus: WorkerRunStatus | null = null;
  private readonly caughtUpChains = new Set<string>();
  private readonly caughtUpRails = new Set<string>();
  private scanWindows = 0;
  private verificationTransitions = 0;
  private verifiedDeliveries = 0;
  private hadError = false;

  constructor(private readonly options: WorkerRunTrackerOptions) {}

  get activeRunId(): string | null {
    return this.currentRunId;
  }

  get status(): WorkerRunStatus | null {
    return this.currentStatus;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /**
   * Begin a new correlated worker run.
   *
   * Any prior unclosed `running` rows left behind by a crashed process are closed as `partial`
   * (`interrupted_by_restart`) so separate executions are never conflated.
   */
  async beginRun(requestedRunId?: string | null): Promise<{
    readonly runId: string;
    readonly rejectedCandidate: boolean;
  }> {
    const at = this.now();
    const resolved = resolveSafeRunId(requestedRunId ?? process.env.HYPERION_WORKER_RUN_ID, at);

    // If this candidate already exists from an earlier job, mint a fresh distinct ID instead of conflating.
    let runId = resolved.runId;
    const exists = await this.runExists(runId);
    if (exists) {
      runId = generateSafeRunId(at);
    }

    this.currentRunId = runId;
    this.currentStatus = "running";
    this.caughtUpChains.clear();
    this.caughtUpRails.clear();
    this.scanWindows = 0;
    this.verificationTransitions = 0;
    this.verifiedDeliveries = 0;
    this.hadError = false;

    await this.safeExec(async () => {
      await this.options.db.query(
        `UPDATE worker_run
            SET status = 'partial',
                ended_reason = 'interrupted_by_restart',
                updated_at = $1,
                ended_at = COALESCE(ended_at, $1)
          WHERE status = 'running'`,
        [at],
      );

      await this.options.db.query(
        `INSERT INTO worker_run (
           run_id, network, status, expected_chains, expected_rails,
           caught_up_chains, caught_up_rails, started_at, updated_at
         ) VALUES ($1, $2, 'running', $3, $4, '{}', '{}', $5, $5)`,
        [
          runId,
          this.options.network,
          [...this.options.expectedChains],
          [...this.options.expectedRails],
          at,
        ],
      );
    });

    return { runId, rejectedCandidate: resolved.rejectedCandidate };
  }

  /** Record a scanned ledger/block range and update catch-up status for that chain. */
  async recordScan(input: ScanJournalEntryInput, queryable?: Queryable): Promise<void> {
    const runId = this.currentRunId;
    if (runId === null) return;

    const at = this.now();
    const caughtUp = input.behindCount === 0;
    if (caughtUp) {
      this.caughtUpChains.add(input.chainKey);
    } else {
      this.caughtUpChains.delete(input.chainKey);
    }
    this.scanWindows += 1;

    const target = queryable ?? this.options.db;
    await this.safeExec(async () => {
      await target.query(
        `INSERT INTO worker_scan_journal (
           run_id, chain_key, family, from_position, to_position,
           decoded_count, skipped_count, behind_count, caught_up, recorded_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          runId,
          input.chainKey,
          input.family,
          input.fromPosition.toString(),
          input.toPosition.toString(),
          input.decodedCount,
          input.skippedCount,
          input.behindCount,
          caughtUp,
          at,
        ],
      );

      await target.query(
        `UPDATE worker_run
            SET scan_windows = scan_windows + 1,
                caught_up_chains = $2,
                updated_at = $3
          WHERE run_id = $1`,
        [runId, [...this.caughtUpChains].sort(), at],
      );
    });
  }

  /** Record when a chain pass checked head and found no new blocks/ledgers to read. */
  async recordIdleHeadObservation(chainKey: string, behindCount: number): Promise<void> {
    const runId = this.currentRunId;
    if (runId === null) return;

    const at = this.now();
    if (behindCount === 0) {
      this.caughtUpChains.add(chainKey);
    } else {
      this.caughtUpChains.delete(chainKey);
    }

    await this.safeExec(async () => {
      await this.options.db.query(
        `UPDATE worker_run
            SET caught_up_chains = $2,
                updated_at = $3
          WHERE run_id = $1`,
        [runId, [...this.caughtUpChains].sort(), at],
      );
    });
  }

  /** Record a rail verification transition linked to the active worker run. */
  async recordVerificationTransition(
    input: VerificationTransitionInput,
    queryable?: Queryable,
  ): Promise<void> {
    const runId = this.currentRunId;
    if (runId === null) return;

    const at = this.now();
    this.verificationTransitions += 1;
    if (input.verifiedDelivery) {
      this.verifiedDeliveries += 1;
    }

    const target = queryable ?? this.options.db;
    await this.safeExec(async () => {
      await target.query(
        `INSERT INTO worker_verification_journal (
           run_id, transfer_id, route, previous_status, next_status,
           verified_delivery, recorded_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          runId,
          input.transferId.toString(),
          input.route,
          input.previousStatus,
          input.nextStatus,
          input.verifiedDelivery,
          at,
        ],
      );

      await target.query(
        `UPDATE worker_run
            SET verification_transitions = verification_transitions + 1,
                verified_deliveries = verified_deliveries + $2,
                updated_at = $3
          WHERE run_id = $1`,
        [runId, input.verifiedDelivery ? 1 : 0, at],
      );
    });
  }

  /** Record whether a rail pass drained its pending queue without failures. */
  async recordRailPassOutcome(
    railName: string,
    outstanding: number,
    failures: number,
  ): Promise<void> {
    const runId = this.currentRunId;
    if (runId === null) return;

    const at = this.now();
    if (outstanding === 0 && failures === 0) {
      this.caughtUpRails.add(railName);
    } else {
      this.caughtUpRails.delete(railName);
    }
    if (failures > 0) {
      this.hadError = true;
    }

    await this.safeExec(async () => {
      await this.options.db.query(
        `UPDATE worker_run
            SET caught_up_rails = $2,
                updated_at = $3
          WHERE run_id = $1`,
        [runId, [...this.caughtUpRails].sort(), at],
      );
    });
  }

  /** Mark that a worker pass encountered an unhandled error during this run. */
  recordWorkerFailure(): void {
    this.hadError = true;
  }

  /**
   * Finalize the run, distinguishing a completed catch-up from a partial or failed execution.
   */
  async finishRun(explicitReason?: string): Promise<WorkerRunSummary | null> {
    const runId = this.currentRunId;
    if (runId === null) return null;

    const at = this.now();
    const allChainsCaughtUp = this.options.expectedChains.every((chain) =>
      this.caughtUpChains.has(chain),
    );
    const allRailsCaughtUp = this.options.expectedRails.every((rail) =>
      this.caughtUpRails.has(rail),
    );
    const madeAnyProgress =
      this.scanWindows > 0 ||
      this.verificationTransitions > 0 ||
      this.caughtUpChains.size > 0 ||
      this.caughtUpRails.size > 0;

    let finalStatus: WorkerRunStatus;
    let defaultReason: string;
    if (this.hadError && !madeAnyProgress) {
      finalStatus = "failed";
      defaultReason = "worker_error_without_progress";
    } else if (allChainsCaughtUp && allRailsCaughtUp && !this.hadError) {
      finalStatus = "completed";
      defaultReason = "caught_up";
    } else {
      finalStatus = "partial";
      defaultReason = this.hadError ? "partial_with_worker_errors" : "stopped_before_full_catch_up";
    }

    const endedReason = explicitReason ?? defaultReason;
    this.currentStatus = finalStatus;
    this.currentRunId = null;

    await this.safeExec(async () => {
      await this.options.db.query(
        `UPDATE worker_run
            SET status = $2,
                caught_up_chains = $3,
                caught_up_rails = $4,
                ended_reason = $5,
                updated_at = $6,
                ended_at = $6
          WHERE run_id = $1`,
        [
          runId,
          finalStatus,
          [...this.caughtUpChains].sort(),
          [...this.caughtUpRails].sort(),
          endedReason,
          at,
        ],
      );
    });

    return {
      runId,
      network: this.options.network,
      status: finalStatus,
      expectedChains: [...this.options.expectedChains],
      expectedRails: [...this.options.expectedRails],
      caughtUpChains: [...this.caughtUpChains].sort(),
      caughtUpRails: [...this.caughtUpRails].sort(),
      scanWindows: this.scanWindows,
      verificationTransitions: this.verificationTransitions,
      verifiedDeliveries: this.verifiedDeliveries,
      endedReason,
      startedAt: at.toISOString(),
      updatedAt: at.toISOString(),
      endedAt: at.toISOString(),
    };
  }

  private async runExists(runId: string): Promise<boolean> {
    try {
      const res = await this.options.db.query(
        "SELECT run_id FROM worker_run WHERE run_id = $1 LIMIT 1",
        [runId],
      );
      return res.rows.some((row) => row.run_id === runId);
    } catch (error) {
      if (isUndefinedTableError(error)) return false;
      throw error;
    }
  }

  private async safeExec(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      if (isUndefinedTableError(error)) return;
      throw error;
    }
  }
}

function toStringArray(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string");
}

function parseRunSummary(row: Record<string, unknown>): WorkerRunSummary | null {
  if (typeof row.run_id !== "string" || !isSafePublicRunId(row.run_id)) return null;
  const status = row.status;
  if (
    status !== "running" &&
    status !== "partial" &&
    status !== "completed" &&
    status !== "failed"
  ) {
    return null;
  }
  return {
    runId: row.run_id,
    network: typeof row.network === "string" ? row.network : "unknown",
    status,
    expectedChains: toStringArray(row.expected_chains),
    expectedRails: toStringArray(row.expected_rails),
    caughtUpChains: toStringArray(row.caught_up_chains),
    caughtUpRails: toStringArray(row.caught_up_rails),
    scanWindows: Number(row.scan_windows ?? 0),
    verificationTransitions: Number(row.verification_transitions ?? 0),
    verifiedDeliveries: Number(row.verified_deliveries ?? 0),
    endedReason: typeof row.ended_reason === "string" ? row.ended_reason : null,
    startedAt: new Date(row.started_at as string | number | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | number | Date).toISOString(),
    endedAt:
      row.ended_at !== null && row.ended_at !== undefined
        ? new Date(row.ended_at as string | number | Date).toISOString()
        : null,
  };
}

function scalarString(value: unknown, fallback = "0"): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return fallback;
}

/**
 * Read persisted worker run correlation state from PostgreSQL for `/v1/metrics` and `/ready`.
 */
export async function readWorkerRunCorrelationSnapshot(
  db: Queryable,
  limit = 10,
): Promise<WorkerRunCorrelationSnapshot> {
  try {
    const runsResult = await db.query(
      `SELECT run_id, network, status, expected_chains, expected_rails,
              caught_up_chains, caught_up_rails, scan_windows,
              verification_transitions, verified_deliveries,
              ended_reason, started_at, updated_at, ended_at
         FROM worker_run
        ORDER BY started_at DESC, run_id DESC
        LIMIT $1`,
      [limit],
    );

    const recentRuns: WorkerRunSummary[] = [];
    for (const raw of runsResult.rows) {
      const parsed = parseRunSummary(raw);
      if (parsed !== null) recentRuns.push(parsed);
    }

    const latestSummary = recentRuns[0] ?? null;
    if (latestSummary === null) {
      return { latestRun: null, recentRuns: [] };
    }

    const scansResult = await db.query(
      `SELECT chain_key, family, from_position, to_position,
              decoded_count, skipped_count, behind_count, caught_up, recorded_at
         FROM worker_scan_journal
        WHERE run_id = $1
        ORDER BY id ASC`,
      [latestSummary.runId],
    );
    const scans: WorkerScanJournalRow[] = [];
    for (const row of scansResult.rows) {
      if (typeof row.chain_key !== "string") continue;
      if (row.family !== "stellar" && row.family !== "evm") continue;
      scans.push({
        chainKey: row.chain_key,
        family: row.family,
        fromPosition: scalarString(row.from_position),
        toPosition: scalarString(row.to_position),
        decodedCount: Number(row.decoded_count ?? 0),
        skippedCount: Number(row.skipped_count ?? 0),
        behindCount: scalarString(row.behind_count),
        caughtUp: Boolean(row.caught_up),
        recordedAt: new Date(row.recorded_at as string | number | Date).toISOString(),
      });
    }

    const verificationsResult = await db.query(
      `SELECT transfer_id, route, previous_status, next_status, verified_delivery, recorded_at
         FROM worker_verification_journal
        WHERE run_id = $1
        ORDER BY id ASC`,
      [latestSummary.runId],
    );
    const verifications: WorkerVerificationJournalRow[] = [];
    for (const row of verificationsResult.rows) {
      if (row.transfer_id === undefined || row.transfer_id === null) continue;
      if (typeof row.next_status !== "string") continue;
      verifications.push({
        transferId: scalarString(row.transfer_id),
        route: Number(row.route ?? 0),
        previousStatus: typeof row.previous_status === "string" ? row.previous_status : null,
        nextStatus: row.next_status,
        verifiedDelivery: Boolean(row.verified_delivery),
        recordedAt: new Date(row.recorded_at as string | number | Date).toISOString(),
      });
    }

    return {
      latestRun: {
        ...latestSummary,
        scans,
        verifications,
      },
      recentRuns,
    };
  } catch (error) {
    if (isUndefinedTableError(error)) {
      return { latestRun: null, recentRuns: [] };
    }
    throw error;
  }
}
