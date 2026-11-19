/**
 * The Stellar watcher: one pass over the router's events, written with the cursor that passes them.
 *
 * The correctness claim is narrow and worth stating exactly, because the useful version of it is
 * not the obvious one. After any crash, at any point, the database holds every event up to the
 * cursor, possibly some events after it, and no event twice. The cursor is a lower bound on
 * completeness rather than a high water mark.
 *
 * All three parts earn their keep. "Every event up to the cursor" holds because a page of events
 * and the cursor advance past it are one transaction. "Possibly some after it" is the honest
 * description of a page that stopped partway through a ledger: those events are real and final, so
 * they are written rather than thrown away, and the cursor stays at the last ledger that is
 * provably whole. "No event twice" holds because every insert is an upsert on a natural key, which
 * is what makes re-reading a ledger after a restart a no-op rather than a duplicate.
 *
 * What it does not claim is a reorg story, and that is not an omission. Stellar has deterministic
 * finality: a closed ledger is closed. There is no equivalent of the window the EVM watcher has to
 * re-scan, which is why the two watchers are separate files rather than one with a flag.
 *
 * The shape of the loop is set by one measured fact about `getEvents`, recorded in `cursor.ts`: it
 * scans a bounded window rather than scanning to the head. An empty page therefore means "nothing
 * in this window", not "nothing left to read", and a watcher that confuses the two re-reads one
 * window forever and never arrives.
 */
import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type { Queryable, Transactional } from "../../db/pool.js";
import type { ReadinessReport } from "../../runtime/readiness.js";
import {
  boundedWindowEnd,
  completeThrough,
  computeScanWindowEnd,
  endOfLedgerCursor,
  parseEventCursor,
  parseLedgerRangeError,
  validateRangePage,
  SCAN_WINDOW_LEDGERS,
  type AdaptiveWindowConfig,
  DEFAULT_ADAPTIVE_WINDOW_CONFIG,
  nextScanWindowLedgers,
  validateScanPage,
} from "./cursor.js";
import { decodeStellarEvent, type RawStellarEvent, type StellarEvent } from "./events.js";
import type { EventSource, EventsQuery, RetainedHistoryWindow } from "./rpc.js";
import { StellarRpcError, retentionWindowOf } from "./rpc.js";
import {
  type ChainCursor,
  recordDeploymentRevision,
  recordQuarantinedEvent,
  boundDecodeError,
  type CursorRepairProposal,
  type EventIdentityConflict,
  type VerifiedLedgerBoundary,
  inspectEventConflict,
  persistScanJournal,
  planCursorRepairFromDb,
  acquireLease,
  advanceGapReplay,
  assertLeaseHeld,
  countUnreconciledGaps,
  listHistoryGaps,
  readBackfillCursor,
  readCursor,
  recordActionQueued,
  recordActionSettled,
  recordBridgeIn,
  recordBridgeOut,
  recordClaimParked,
  recordClaimSettled,
  recordHistoryGap,
  recordPauseSet,
  recordRouteConfigured,
  recordTokenRegistered,
  releaseLease,
  writeBackfillCursor,
  writeCursor,
  type EventContext,
} from "./store.js";

/**
 * How far behind the head still counts as current.
 *
 * Ledgers close in about five seconds and the default poll interval is five seconds, so a healthy
 * watcher sits nought to two ledgers back depending on where in a ledger the last tick landed.
 * Five is that with room for a slow page, and about twenty five seconds of lag, which is under the
 * time any rail takes to deliver. Past it the number itself goes in the readiness detail, because
 * "six ledgers behind" and "six thousand ledgers behind" want different responses from whoever
 * reads it.
 */
const CURRENT_WITHIN_LEDGERS = 5;

/**
 * A ceiling on pages read in one tick.
 *
 * The inner loop only runs while a full page lands entirely inside one ledger, which takes a
 * single ledger holding more router events than the page size. Reaching the ceiling means that
 * happened at a scale worth a log line rather than a silent stall, and the tick still commits
 * what it read.
 */
const MAX_PAGES_PER_TICK = 20;

const MAX_PROGRESS_JOURNALS = 100;

export interface ScanProgressJournal {
  readonly chainKey: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly requestedRange: { readonly from: number; readonly to: number | null };
  readonly committedRange: { readonly from: number; readonly to: number } | null;
  readonly eventCounts: {
    readonly fetched: number;
    readonly decoded: number;
    readonly skipped: number;
    readonly conflicts: number;
  };
  readonly pages: number;
  readonly interruptionReason: string | null;
}

const DEFAULT_LEASE_TTL_MS = 30_000;

export interface StellarWatcherOptions {
  readonly chainKey: string;
  readonly router: string;
  /** The ledger to start a fresh cursor from. */
  readonly startLedger: number;
  readonly pageSize: number;
  readonly rpc: EventSource;
  readonly db: Transactional;
  readonly logger: Logger;
  readonly maxPagesPerTick?: number;
  readonly deploymentRevision?: number;
  readonly adaptiveWindow?: AdaptiveWindowConfig;
  /** Unique worker identity for expiring database lease ownership (#31). */
  readonly ownerId?: string;
  /** Lease TTL in milliseconds (#31). Defaults to 30_000. */
  readonly leaseTtlMs?: number;
  /** Release the lease at the end of each tick (useful for scheduled/one-shot workers). */
  readonly releaseLeaseOnTick?: boolean;
  /** Explicitly configured historical event provider for bounded backfill (#30). */
  readonly historicalRpc?: EventSource;
  /** Maximum ledgers scanned per bounded backfill pass (#30). */
  readonly backfillMaxLedgersPerTick?: number;
  /** Maximum pages scanned per bounded backfill pass (#30). */
  readonly backfillMaxPagesPerTick?: number;
}

export interface WatcherProgress {
  /** The last ledger proven complete, which is what the cursor holds. */
  readonly ledger: number;
  readonly decoded: number;
  readonly skipped: number;
  readonly quarantined: number;
  readonly revision: number;
  readonly windowLedgers: number;
  /** How far behind the chain's head this watcher is, in ledgers. */
  readonly behind: number;
  readonly at: Date;
}

export class StellarWatcher {
  private lastProgress: WatcherProgress | null = null;
  private scanWindowLedgers: number;
  private readonly reportedReplacements = new Set<string>();
  private readonly progressJournals: ScanProgressJournal[] = [];
  private readonly recordedConflicts: EventIdentityConflict[] = [];
  private readonly drainController = new AbortController();
  private draining = false;
  private inFlightTick: Promise<boolean> | null = null;
  private lastRetainedHistory: RetainedHistoryWindow | null = null;

  private openGapCount = 0;
  private readonly ownerId: string;
  private readonly leaseTtlMs: number;
  /** Tags seen once and logged once. A contract ahead of this build should not be a log flood. */
  private readonly reportedUnknown = new Set<string>();

  constructor(private readonly options: StellarWatcherOptions) {
    const config = options.adaptiveWindow ?? DEFAULT_ADAPTIVE_WINDOW_CONFIG;
    if (
      !Number.isSafeInteger(config.minLedgers) ||
      !Number.isSafeInteger(config.maxLedgers) ||
      config.minLedgers < 1 ||
      config.maxLedgers < config.minLedgers ||
      config.maxLedgers > SCAN_WINDOW_LEDGERS ||
      !Number.isFinite(config.targetDurationMs) ||
      config.targetDurationMs <= 0 ||
      !Number.isFinite(config.fastDurationMs) ||
      config.fastDurationMs < 0 ||
      config.fastDurationMs > config.targetDurationMs
    )
      throw new Error("invalid adaptive scan-window configuration");
    if (
      options.deploymentRevision !== undefined &&
      (!Number.isSafeInteger(options.deploymentRevision) || options.deploymentRevision < 1)
    )
      throw new Error("invalid deployment revision");
    this.scanWindowLedgers = config.maxLedgers;
    this.ownerId = options.ownerId ?? randomUUID();
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  }

  get windowLedgers(): number {
    return this.scanWindowLedgers;
  }

  get name(): string {
    return this.options.chainKey;
  }

  get progress(): WatcherProgress | null {
    return this.lastProgress;
  }

  get journals(): readonly ScanProgressJournal[] {
    return this.progressJournals;
  }

  get lastJournal(): ScanProgressJournal | null {
    return this.progressJournals[this.progressJournals.length - 1] ?? null;
  }

  get conflicts(): readonly EventIdentityConflict[] {
    return this.recordedConflicts;
  }

  get isDraining(): boolean {
    return this.draining;
  }

  /**
   * Gracefully drain the watcher: stop issuing new RPC requests and wait for any in-flight
   * event transaction to finish committing or rolling back.
   */
  async drain(): Promise<void> {
    this.draining = true;
    this.drainController.abort();
    if (this.inFlightTick !== null) {
      await this.inFlightTick.catch(() => undefined);
    }
    await this.release();
  }

  /**
   * Build a read-only, unsigned database repair proposal from verified completed ledger boundaries
   * recorded in scan journals and retained-history evidence.
   */
  async planRepair(retainedHistory?: RetainedHistoryWindow | null): Promise<CursorRepairProposal> {
    const verifiedBoundaries: VerifiedLedgerBoundary[] = [];
    const { rows: journals } = await this.options.db.query(
      `SELECT journal FROM stellar_scan_journal WHERE chain_key = $1 AND contract = $2 ORDER BY id`,
      [this.options.chainKey, this.options.router],
    );
    for (const row of journals) {
      const journal = row.journal as ScanProgressJournal;
      if (journal.committedRange !== null)
        verifiedBoundaries.push({
          from: journal.committedRange.from,
          ledger: journal.committedRange.to,
          cursor: endOfLedgerCursor(journal.committedRange.to),
          source: "journal",
        });
    }
    const { rows: evidence } = await this.options.db.query(
      `SELECT evidence FROM stellar_event_conflict WHERE chain_key = $1 AND contract = $2`,
      [this.options.chainKey, this.options.router],
    );
    return planCursorRepairFromDb(this.options.db, {
      chainKey: this.options.chainKey,
      expectedContract: this.options.router,
      startLedger: this.options.startLedger,
      retainedHistory: retainedHistory ?? this.lastRetainedHistory,
      verifiedBoundaries,
      conflicts: evidence.map((row) => row.evidence as EventIdentityConflict),
    });
  }

  private isCancelled(signal: AbortSignal): boolean {
    return this.draining || signal.aborted;
  }

  private recordJournal(journal: ScanProgressJournal): void {
    this.progressJournals.push(journal);
    if (this.progressJournals.length > MAX_PROGRESS_JOURNALS) {
      this.progressJournals.shift();
    }
  }

  async release(): Promise<boolean> {
    return releaseLease(this.options.db, {
      chainKey: this.options.chainKey,
      contract: this.options.router,
      ownerId: this.ownerId,
    });
  }

  /**
   * Readiness from cached state, never from a network call.
   *
   * Degraded at worst, never down, and that is a deliberate ceiling rather than optimism. `/ready`
   * takes the worst report in the process, and one chain being unreachable is not a reason to stop
   * answering questions about the chains that are reachable. A watcher that cannot read its chain
   * is something to alert on; taking the replica out of rotation would only move the outage.
   */
  readiness(): ReadinessReport {
    const progress = this.lastProgress;
    if (progress === null) {
      return {
        name: this.name,
        state: "degraded",
        detail: "has not completed a pass yet, so nothing it could be asked about is indexed",
      };
    }
    if (this.recordedConflicts.length > 0)
      return {
        name: this.name,
        state: "degraded",
        detail: "unreconciled event identity conflicts remain",
      };
    if (this.openGapCount > 0) {
      return {
        name: this.name,
        state: "degraded",
        detail: `${String(this.openGapCount)} unreconciled Stellar history gap(s) remain at ledger ${String(progress.ledger)}; history is incomplete`,
      };
    }
    if (progress.behind > CURRENT_WITHIN_LEDGERS) {
      return {
        name: this.name,
        state: "degraded",
        detail: `${String(progress.behind)} ledgers behind the head at ledger ${String(progress.ledger)}, so a recent transfer may not be recorded yet`,
      };
    }
    return {
      name: this.name,
      state: "ready",
      detail: `current at ledger ${String(progress.ledger)}`,
    };
  }

  /**
   * One pass. Returns true when it made progress and should be run again immediately, which is how
   * a watcher starting thousands of ledgers back catches up without sleeping between windows.
   */
  async tick(signal: AbortSignal): Promise<boolean> {
    if (this.inFlightTick !== null) return this.inFlightTick;
    const effectiveSignal = AbortSignal.any([signal, this.drainController.signal]);
    if (this.draining || effectiveSignal.aborted) {
      const now = new Date();
      this.recordJournal({
        chainKey: this.options.chainKey,
        startedAt: now,
        finishedAt: now,
        requestedRange: {
          from: (this.lastProgress?.ledger ?? this.options.startLedger - 1) + 1,
          to: null,
        },
        committedRange: null,
        eventCounts: { fetched: 0, decoded: 0, skipped: 0, conflicts: 0 },
        pages: 0,
        interruptionReason: "cancelled",
      });
      return false;
    }

    const run = this.runTick(effectiveSignal);
    this.inFlightTick = run;
    try {
      return await run;
    } finally {
      this.inFlightTick = null;
    }
  }

  private async runTick(signal: AbortSignal): Promise<boolean> {
    const { chainKey, router, db, logger } = this.options;

    const lease = await acquireLease(db, {
      chainKey,
      contract: router,
      ownerId: this.ownerId,
      ttlMs: this.leaseTtlMs,
    });
    if (lease === null) {
      logger.debug(
        { chain: chainKey, router, ownerId: this.ownerId },
        "skipping stellar tick; lease held by another worker",
      );
      return false;
    }

    const startedAt = new Date();
    let requestedFrom = this.options.startLedger;
    let requestedTo: number | null = null;
    let committedRange: { from: number; to: number } | null = null;
    let fetched = 0,
      decoded = 0,
      skipped = 0,
      conflicts = 0,
      pages = 0;
    let interruptionReason: string | null = null;
    let journalPersisted = false;
    const journal = (): ScanProgressJournal => ({
      chainKey,
      startedAt,
      finishedAt: new Date(),
      requestedRange: { from: requestedFrom, to: requestedTo },
      committedRange,
      eventCounts: { fetched, decoded, skipped, conflicts },
      pages,
      interruptionReason,
    });
    try {
      const stored = await readCursor(db, chainKey);
      const deployment = this.resolveDeployment(stored);
      const { base, fresh, revision, previous } = deployment;
      const expectedRevision = stored === null ? null : stored.revision;
      requestedFrom = base + 1;
      const scan = await this.scan(base, fresh, signal);
      interruptionReason = scan.interruptionReason;
      pages = scan.pages;
      fetched = scan.events.length;
      requestedTo = computeScanWindowEnd(requestedFrom, fresh, scan.latestLedger);
      this.lastRetainedHistory = retentionWindowOf(scan);

      const hasRetentionGap = scan.oldestLedger > base + 1;
      if (hasRetentionGap) {
        // The retention window moved past where we stopped. Anything between the two is gone from
        // this node, and carrying on from the window edge would leave a hole nothing ever reports.
        logger.error(
          { chain: chainKey, from: base + 1, oldestLedger: scan.oldestLedger },
          "fell behind the rpc retention window; ledgers between the cursor and the oldest retained ledger were never read",
        );
      }

      if (scan.through <= base && scan.events.length === 0) {
        if (hasRetentionGap) {
          await recordHistoryGap(db, {
            chainKey,
            contract: router,
            startLedger: base + 1,
            endLedger: scan.oldestLedger - 1,
            reason: "rpc_retention_window_moved",
          });
        }
        this.openGapCount = await countUnreconciledGaps(db, chainKey, router);
        // No window crossed and nothing read. Report where we still are so readiness keeps telling
        // the truth about the lag rather than going quiet.
        this.lastProgress = {
          ledger: base,
          decoded: 0,
          skipped: 0,
          quarantined: 0,
          revision,
          windowLedgers: this.scanWindowLedgers,
          behind: Math.max(scan.latestLedger - base, 0),
          at: new Date(),
        };
        return false;
      }

      let closedAt = fresh ? null : (stored?.observedAt ?? null);
      let quarantined = 0;

      // One transaction for the page and the cursor. This is the restart guarantee, and splitting it
      // would turn every crash into either a lost page or a duplicated one.
      await db.transaction(async (tx: Queryable) => {
        await assertLeaseHeld(tx, {
          chainKey,
          contract: router,
          ownerId: this.ownerId,
          ttlMs: this.leaseTtlMs,
        });

        if (fresh)
          await recordDeploymentRevision(tx, {
            chainKey,
            contract: router,
            deploymentRevision: revision,
            startLedger: BigInt(this.options.startLedger),
            previousContract: previous?.contract ?? null,
            previousCursor: previous?.cursor ?? null,
          });
        const applied = await this.applyEvents(tx, chainKey, scan.events, scan.through, revision);
        quarantined = applied.quarantined;
        decoded = applied.decoded;
        skipped = applied.skipped;
        conflicts = applied.conflicts;
        if (applied.closedAt !== null) closedAt = applied.closedAt;

        if (hasRetentionGap) {
          await recordHistoryGap(tx, {
            chainKey,
            contract: router,
            startLedger: base + 1,
            endLedger: scan.oldestLedger - 1,
            reason: "rpc_retention_window_moved",
          });
        }

        await assertLeaseHeld(tx, {
          chainKey,
          contract: router,
          ownerId: this.ownerId,
          ttlMs: this.leaseTtlMs,
        });
        await writeCursor(tx, {
          chainKey,
          family: "stellar",
          contract: router,
          position: BigInt(scan.through),
          observedAt: closedAt,
          // Nothing to record: a closed ledger cannot be replaced by a different one.
          hash: null,
          expectedRevision,
          deploymentRevision: revision,
          expectedContract: stored?.contract ?? router,
          expectedDeploymentRevision: stored?.deploymentRevision ?? revision,
        });
        committedRange =
          scan.through >= Math.max(base + 1, scan.oldestLedger)
            ? { from: Math.max(base + 1, scan.oldestLedger), to: scan.through }
            : null;
        await persistScanJournal(tx, router, journal());
      });

      journalPersisted = true;
      if (conflicts > 0)
        logger.warn(
          { chain: chainKey, conflicts },
          "conflicting payload detected; durable reconciliation evidence retained",
        );
      const { rows: durableConflicts } = await db.query(
        `SELECT evidence FROM stellar_event_conflict WHERE chain_key = $1 AND contract = $2 ORDER BY evidence->>'detectedAt' DESC LIMIT 100`,
        [chainKey, router],
      );
      this.recordedConflicts.splice(
        0,
        this.recordedConflicts.length,
        ...durableConflicts.map((row) => row.evidence as EventIdentityConflict),
      );
      this.openGapCount = await countUnreconciledGaps(db, chainKey, router);
      const behind = Math.max(scan.latestLedger - scan.through, 0);
      this.lastProgress = {
        ledger: scan.through,
        decoded,
        skipped,
        quarantined,
        revision,
        windowLedgers: this.scanWindowLedgers,
        behind,
        at: new Date(),
      };
      logger.info(
        { chain: chainKey, ledger: scan.through, decoded, skipped, behind, pages: scan.pages },
        "stellar window indexed",
      );

      // Behind the head means there is another window waiting, so say we progressed and let the
      // poller come straight back rather than sleeping out the interval mid-backfill.
      return !signal.aborted && !this.draining && behind > 0;
    } catch (error) {
      if (!journalPersisted) committedRange = null;
      interruptionReason =
        error instanceof Error && error.message === "deadlock detected"
          ? "deadlock detected"
          : "scan_failed";
      throw error;
    } finally {
      const entry = journal();
      if (!journalPersisted) await persistScanJournal(db, router, entry);
      this.recordJournal(entry);
      if (this.options.releaseLeaseOnTick) {
        await this.release().catch(() => undefined);
      }
    }
  }

  private resolveDeployment(stored: ChainCursor | null): {
    readonly base: number;
    readonly fresh: boolean;
    readonly revision: number;
    readonly previous: { readonly contract: string; readonly cursor: bigint } | null;
  } {
    const { chainKey, router, startLedger, deploymentRevision, logger } = this.options;
    if (stored === null) {
      return {
        base: startLedger - 1,
        fresh: true,
        revision: deploymentRevision ?? 1,
        previous: null,
      };
    }

    if (stored.contract !== router) {
      const nextRevision = Math.max(stored.deploymentRevision + 1, deploymentRevision ?? 1);
      const transitionKey = `${stored.contract}->${router}:${String(nextRevision)}`;
      if (!this.reportedReplacements.has(transitionKey)) {
        this.reportedReplacements.add(transitionKey);
        logger.warn(
          {
            chain: chainKey,
            previousRouter: stored.contract,
            router,
            previousRevision: stored.deploymentRevision,
            deploymentRevision: nextRevision,
            startLedger,
          },
          "router contract changed; starting new watched deployment revision without reusing previous cursor",
        );
      }
      return {
        base: startLedger - 1,
        fresh: true,
        revision: nextRevision,
        previous: { contract: stored.contract, cursor: stored.position },
      };
    }

    if (deploymentRevision !== undefined && deploymentRevision < stored.deploymentRevision) {
      throw new Error(
        `configured deployment revision ${String(deploymentRevision)} for ${chainKey} is older than stored revision ${String(stored.deploymentRevision)}`,
      );
    }

    if (deploymentRevision !== undefined && deploymentRevision > stored.deploymentRevision) {
      return {
        base: startLedger - 1,
        fresh: true,
        revision: deploymentRevision,
        previous: { contract: stored.contract, cursor: stored.position },
      };
    }

    return {
      base: Number(stored.position),
      fresh: false,
      revision: stored.deploymentRevision,
      previous: null,
    };
  }

  /**
   * Run one bounded historical-provider backfill pass (#30).
   *
   * Uses `options.historicalRpc` and persists replay progress separately from `indexer_cursor`
   * (either on `stellar_history_gap.replayed_through` or `stellar_backfill_cursor`).
   */
  async backfillTick(
    signal: AbortSignal,
    explicitRange?: {
      readonly startLedger: number;
      readonly endLedger: number;
      readonly jobKey?: string;
    },
  ): Promise<boolean> {
    if (this.inFlightTick !== null) await this.inFlightTick;
    if (this.draining) return false;
    const effective = AbortSignal.any([signal, this.drainController.signal]);
    const run = this.runBackfillTick(effective, explicitRange);
    this.inFlightTick = run;
    try {
      return await run;
    } finally {
      this.inFlightTick = null;
    }
  }

  private async runBackfillTick(
    signal: AbortSignal,
    explicitRange?: {
      readonly startLedger: number;
      readonly endLedger: number;
      readonly jobKey?: string;
    },
  ): Promise<boolean> {
    if (signal.aborted || this.draining) return false;
    const historicalRpc = this.options.historicalRpc;
    if (historicalRpc === undefined) {
      throw new Error("historical event provider is not configured for stellar backfill");
    }

    const { chainKey, router, db, logger } = this.options;
    const lease = await acquireLease(db, {
      chainKey,
      contract: router,
      ownerId: this.ownerId,
      ttlMs: this.leaseTtlMs,
    });
    if (lease === null) {
      logger.debug(
        { chain: chainKey, router, ownerId: this.ownerId },
        "skipping stellar backfill; lease held by another worker",
      );
      return false;
    }

    const startedAt = new Date();
    const maxLedgers = this.options.backfillMaxLedgersPerTick ?? SCAN_WINDOW_LEDGERS;
    const maxPages = this.options.backfillMaxPagesPerTick ?? MAX_PAGES_PER_TICK;

    try {
      if (explicitRange !== undefined) {
        const jobKey = explicitRange.jobKey ?? "default";
        const cursor = await readBackfillCursor(db, chainKey, router, jobKey);
        if (cursor !== null && cursor.status === "completed") {
          return false;
        }
        const fromLedger = cursor === null ? explicitRange.startLedger : Number(cursor.nextLedger);
        if (fromLedger > explicitRange.endLedger) {
          return false;
        }
        const targetEnd = boundedWindowEnd(fromLedger, explicitRange.endLedger, maxLedgers);
        const scan = await this.scanRange(historicalRpc, fromLedger, targetEnd, maxPages, signal);
        const completed = scan.through >= explicitRange.endLedger;

        await db.transaction(async (tx: Queryable) => {
          await assertLeaseHeld(tx, {
            chainKey,
            contract: router,
            ownerId: this.ownerId,
            ttlMs: this.leaseTtlMs,
          });
          const applied = await this.applyEvents(
            tx,
            chainKey,
            scan.events.filter((raw) => raw.ledger <= scan.through),
            scan.through,
          );
          await assertLeaseHeld(tx, {
            chainKey,
            contract: router,
            ownerId: this.ownerId,
            ttlMs: this.leaseTtlMs,
          });
          await writeBackfillCursor(tx, {
            chainKey,
            contract: router,
            jobKey,
            startLedger: explicitRange.startLedger,
            endLedger: explicitRange.endLedger,
            nextLedger: scan.through + 1,
            status: completed ? "completed" : "running",
            expectedRevision: cursor === null ? null : cursor.revision,
          });
          await persistScanJournal(tx, router, {
            chainKey,
            startedAt,
            finishedAt: new Date(),
            requestedRange: { from: fromLedger, to: targetEnd },
            committedRange:
              scan.through >= fromLedger ? { from: fromLedger, to: scan.through } : null,
            eventCounts: {
              fetched: scan.events.length,
              decoded: applied.decoded,
              skipped: applied.skipped,
              conflicts: applied.conflicts,
            },
            pages: scan.pages,
            interruptionReason: scan.through < targetEnd ? "bounded_pass" : null,
          });
        });

        return !completed;
      }

      const gaps = await listHistoryGaps(db, {
        chainKey,
        contract: router,
        statuses: ["open", "reconciling"],
      });
      const gap = gaps[0];
      if (gap === undefined) {
        this.openGapCount = 0;
        return false;
      }

      const gapEnd = Number(gap.endLedger);
      const fromLedger =
        gap.replayedThrough === null ? Number(gap.startLedger) : Number(gap.replayedThrough) + 1;
      const targetEnd = boundedWindowEnd(fromLedger, gapEnd, maxLedgers);
      const scan = await this.scanRange(historicalRpc, fromLedger, targetEnd, maxPages, signal);
      const reconciled = scan.through >= gapEnd;

      await db.transaction(async (tx: Queryable) => {
        await assertLeaseHeld(tx, {
          chainKey,
          contract: router,
          ownerId: this.ownerId,
          ttlMs: this.leaseTtlMs,
        });
        const applied = await this.applyEvents(
          tx,
          chainKey,
          scan.events.filter((raw) => raw.ledger <= scan.through),
          scan.through,
        );
        await assertLeaseHeld(tx, {
          chainKey,
          contract: router,
          ownerId: this.ownerId,
          ttlMs: this.leaseTtlMs,
        });
        await advanceGapReplay(tx, {
          id: gap.id,
          replayedThrough: scan.through,
          reconciled,
        });
        await persistScanJournal(tx, router, {
          chainKey,
          startedAt,
          finishedAt: new Date(),
          requestedRange: { from: fromLedger, to: targetEnd },
          committedRange:
            scan.through >= fromLedger ? { from: fromLedger, to: scan.through } : null,
          eventCounts: {
            fetched: scan.events.length,
            decoded: applied.decoded,
            skipped: applied.skipped,
            conflicts: applied.conflicts,
          },
          pages: scan.pages,
          interruptionReason: scan.through < targetEnd ? "bounded_pass" : null,
        });
      });

      this.openGapCount = await countUnreconciledGaps(db, chainKey, router);
      return this.openGapCount > 0 || !reconciled;
    } finally {
      if (this.options.releaseLeaseOnTick) {
        await this.release().catch(() => undefined);
      }
    }
  }

  /**
   * Read forward from `base` until a whole ledger has been crossed.
   *
   * Normally one request. The loop exists for the one case a ledger based cursor cannot describe
   * on its own: a full page landing entirely inside a single ledger, where stopping would advance
   * the cursor to the ledger before and read the same page again forever.
   */
  private async scan(
    base: number,
    fresh: boolean,
    signal: AbortSignal,
  ): Promise<{
    readonly events: readonly RawStellarEvent[];
    readonly through: number;
    readonly latestLedger: number;
    readonly oldestLedger: number;
    readonly pages: number;
    readonly interruptionReason: string | null;
  }> {
    const { router, pageSize, logger, chainKey } = this.options;
    const maxPages = this.options.maxPagesPerTick ?? MAX_PAGES_PER_TICK;

    const windowConfig = this.options.adaptiveWindow ?? DEFAULT_ADAPTIVE_WINDOW_CONFIG;
    const requestedWindow = this.scanWindowLedgers;
    const endLedger =
      requestedWindow < SCAN_WINDOW_LEDGERS ? base + 1 + requestedWindow : undefined;
    const events: RawStellarEvent[] = [];
    let through = base;
    let latestLedger = 0;
    let oldestLedger = 0;
    let pages = 0;
    // A fresh cursor starts by ledger. Everything after resumes from a cursor, which is the only
    // account of where the previous scan actually stopped.
    let pagination: Pick<EventsQuery, "startLedger" | "cursor"> = fresh
      ? { startLedger: this.options.startLedger }
      : { cursor: endOfLedgerCursor(base) };

    while (pages < maxPages && !signal.aborted && !this.draining) {
      const query: EventsQuery = {
        ...pagination,
        ...(endLedger === undefined ? {} : { endLedger }),
        contractIds: [router],
        limit: pageSize,
      };
      const startedAt = performance.now();
      const page = await this.fetch(query, base, signal);
      const validated = validateScanPage({
        events: page.events,
        cursor: page.cursor,
        latestLedger: page.latestLedger,
        oldestLedger: page.oldestLedger,
        requestCursor: pagination.cursor,
        requestStartLedger: pagination.startLedger,
        requestEndLedger: endLedger,
      });
      this.scanWindowLedgers = nextScanWindowLedgers(
        {
          currentLedgers: requestedWindow,
          eventCount: page.events.length,
          pageLimit: pageSize,
          elapsedMs: performance.now() - startedAt,
        },
        windowConfig,
      );
      pages += 1;
      events.push(...(page.events as readonly RawStellarEvent[]));
      latestLedger = page.latestLedger;
      oldestLedger = page.oldestLedger;

      if (page.cursor === null) {
        // Not something the live RPC does, and bailing is still better than inventing a position.
        logger.warn(
          { chain: chainKey, pages },
          "the rpc returned a page with no cursor, so this pass cannot say what it finished reading",
        );
        break;
      }

      const candidate = validated.through ?? through;
      if (candidate > through) {
        through = candidate;
        break;
      }
      // Still inside one ledger. Keep pulling with the RPC's own cursor until it is drained.
      pagination = { cursor: page.cursor };
    }

    if (pages >= maxPages && through <= base) {
      logger.error(
        { chain: chainKey, ledger: base + 1, pages, pageSize },
        "a single ledger holds more router events than this many pages could drain; raise STELLAR_EVENT_PAGE_SIZE",
      );
    }

    return {
      events,
      through,
      latestLedger,
      oldestLedger,
      pages,
      interruptionReason:
        signal.aborted || this.draining
          ? "cancelled"
          : pages >= (this.options.maxPagesPerTick ?? MAX_PAGES_PER_TICK) && through <= base
            ? "max_pages_reached"
            : null,
    };
  }

  private async scanRange(
    source: EventSource,
    fromLedger: number,
    endLedger: number,
    maxPages: number,
    signal: AbortSignal,
  ): Promise<{
    readonly events: readonly RawStellarEvent[];
    readonly through: number;
    readonly pages: number;
  }> {
    const { router, pageSize, logger, chainKey } = this.options;
    const events: RawStellarEvent[] = [];
    let through = fromLedger - 1;
    let pages = 0;
    let pagination: Pick<EventsQuery, "startLedger" | "endLedger" | "cursor"> = {
      startLedger: fromLedger,
      endLedger: endLedger + 1,
    };

    while (pages < maxPages && !signal.aborted && !this.draining) {
      const page = await source.events(
        { ...pagination, contractIds: [router], limit: pageSize },
        signal,
      );
      validateRangePage(page, fromLedger, endLedger, pagination.cursor);
      pages += 1;
      if (
        !Number.isSafeInteger(page.oldestLedger) ||
        !Number.isSafeInteger(page.latestLedger) ||
        page.oldestLedger > fromLedger ||
        page.latestLedger < fromLedger
      ) {
        throw new Error("historical provider cannot verify the requested retained range");
      }
      for (const raw of page.events as readonly RawStellarEvent[]) {
        if (raw.ledger >= fromLedger && raw.ledger <= endLedger) {
          events.push(raw);
        }
      }
      if (page.cursor === null) {
        logger.warn(
          { chain: chainKey, pages },
          "the historical provider returned a page with no cursor",
        );
        break;
      }
      const candidate = Math.min(completeThrough(parseEventCursor(page.cursor)), endLedger);
      if (candidate > through) {
        through = candidate;
      }
      if (through >= endLedger) {
        break;
      }
      pagination = { cursor: page.cursor, endLedger: endLedger + 1 };
    }

    return { events, through: Math.max(through, fromLedger - 1), pages };
  }

  private async applyEvents(
    tx: Queryable,
    chainKey: string,
    events: readonly RawStellarEvent[],
    maxLedger: number,
    deploymentRevision?: number,
  ): Promise<{
    readonly decoded: number;
    readonly skipped: number;
    readonly conflicts: number;
    readonly quarantined: number;
    readonly closedAt: Date | null;
  }> {
    let decoded = 0;
    let skipped = 0;
    let conflicts = 0;
    let quarantined = 0;
    const revision =
      deploymentRevision ??
      (await readCursor(tx, chainKey))?.deploymentRevision ??
      this.options.deploymentRevision ??
      1;
    let closedAt: Date | null = null;
    for (const raw of events) {
      if (raw.contractId !== this.options.router)
        throw new Error("provider returned an event from an unrequested router");
      if (raw.ledger <= maxLedger) {
        closedAt = new Date(raw.ledgerClosedAt);
      }
      if (raw.type !== "contract" || raw.inSuccessfulContractCall === false) {
        // getEvents no longer returns the deprecated success flag (RPC30).
        // Diagnostic events are excluded by current RPC; retain legacy explicit-failure checks.
        // https://github.com/stellar/stellar-rpc/releases/tag/v30.0.0
        skipped += 1;
        continue;
      }
      const context: EventContext = {
        chainKey,
        router: this.options.router,
        ledger: raw.ledger,
        txHash: raw.txHash,
        closedAt: new Date(raw.ledgerClosedAt),
      };
      let event: StellarEvent;
      try {
        event = decodeStellarEvent(raw);
      } catch (error) {
        const decodeError = boundDecodeError(error instanceof Error ? error.name : "decode failed");
        this.options.logger.warn(
          { chain: chainKey, eventId: raw.id, ledger: raw.ledger, err: decodeError },
          "quarantining stellar event that failed to decode",
        );
        await recordQuarantinedEvent(tx, {
          chainKey,
          contract: this.options.router,
          deploymentRevision: revision,
          raw,
          reason: "decode_error",
          tag: null,
          decodeError,
        });
        quarantined += 1;
        skipped += 1;
        continue;
      }
      if (event.kind === "unknown") {
        await recordQuarantinedEvent(tx, {
          chainKey,
          contract: this.options.router,
          deploymentRevision: revision,
          raw,
          reason: "unknown_tag",
          tag: event.tag.slice(0, 128),
          decodeError: null,
        });
        // Do not freeze a decoded identity before a decoder exists. A later replay may classify
        // the same source event, while successful row writes still require durable conflict checks.
        quarantined += 1;
        await this.apply(tx, context, raw, event);
        skipped += 1;
        continue;
      }
      const conflict = await inspectEventConflict(tx, chainKey, raw, event);
      if (conflict !== null) {
        conflicts += 1;
        continue;
      }
      if (await this.apply(tx, context, raw, event)) {
        decoded += 1;
        await tx.query(
          `UPDATE stellar_event_quarantine SET replayed_at = clock_timestamp()
          WHERE chain_key = $1 AND contract = $2 AND event_id = $3 AND replayed_at IS NULL`,
          [chainKey, this.options.router, raw.id],
        );
      } else skipped += 1;
    }
    return { decoded, skipped, conflicts, quarantined, closedAt };
  }

  private async fetch(query: EventsQuery, base: number, signal: AbortSignal) {
    try {
      return await this.options.rpc.events(query, signal);
    } catch (error) {
      if (error instanceof StellarRpcError && !error.retryable) {
        const range = parseLedgerRangeError(error.message);
        if (range !== null && range.oldestLedger > base + 1) {
          await recordHistoryGap(this.options.db, {
            chainKey: this.options.chainKey,
            contract: this.options.router,
            startLedger: base + 1,
            endLedger: range.oldestLedger - 1,
            reason: "rpc_range_refused",
          }).catch(() => undefined);
          this.openGapCount = await countUnreconciledGaps(
            this.options.db,
            this.options.chainKey,
            this.options.router,
          ).catch(() => this.openGapCount);
        }
        // Almost always the start ledger or the cursor having fallen out of the node's retention
        // window. Said plainly, because the fix is an archive source rather than another retry.
        this.options.logger.error(
          { chain: this.options.chainKey, retryable: error.retryable },
          "the rpc refused this range permanently; the watcher cannot close this gap from here",
        );
      }
      throw error;
    }
  }

  private async apply(
    tx: Queryable,
    context: EventContext,
    raw: RawStellarEvent,
    event: StellarEvent,
  ): Promise<boolean> {
    switch (event.kind) {
      case "bridgeOut":
        await recordBridgeOut(tx, context, event.data);
        return true;
      case "bridgeIn":
        await recordBridgeIn(tx, context, event.data);
        return true;
      case "claimParked":
        await recordClaimParked(tx, context, event.data);
        return true;
      case "claimSettled": {
        const matched = await recordClaimSettled(tx, context, event.data);
        if (!matched) {
          // A settlement for a claim never seen parked. The park event is older than the retention
          // window, and inventing a row from a settlement would record a claim with no origin.
          this.options.logger.warn(
            { chain: context.chainKey, claimId: event.data.claimId.toString() },
            "settlement for a claim this indexer never saw parked",
          );
        }
        return matched;
      }
      case "actionQueued":
        await recordActionQueued(tx, context, event.data, raw.valueJson);
        return true;
      case "actionExecuted":
        await recordActionSettled(tx, context, event.data, "executed");
        return true;
      case "actionCancelled":
        await recordActionSettled(tx, context, event.data, "cancelled");
        return true;
      case "tokenRegistered":
        await recordTokenRegistered(tx, context, event.data);
        return true;
      case "pauseSet":
        // A pause is router wide and there is no table for it, so it is recorded as every rail
        // becoming unavailable for the reason the router would give. That is not a cosmetic
        // mapping: a pause is the one operational state somebody needs to see in the same place
        // they look at route health, rather than in a log they have to go and find.
        await recordPauseSet(tx, context, event.data);
        return true;
      case "routeConfigured":
        // The sample needs a token and this event names none, so it is attributed to the chain
        // itself. A route being on or off is a property of the router, not of one asset.
        await recordRouteConfigured(tx, context, event.data, context.chainKey);
        return true;
      case "ignored":
        return false;
      case "unknown":
        if (!this.reportedUnknown.has(event.tag) && this.reportedUnknown.size < 100) {
          this.reportedUnknown.add(event.tag);
          this.options.logger.warn(
            {
              chain: context.chainKey,
              tag: event.tag.replace(/[^a-zA-Z0-9_.-]/g, "?").slice(0, 128),
            },
            "the router emitted an event tag this build does not know; it is running ahead of the indexer",
          );
        }
        return false;
      default:
        // Unreachable while the switch covers the union, and the point is that it stops compiling
        // the moment a new event kind is added without a case here. An indexer that silently drops
        // a kind somebody added last week is the failure this line exists to prevent.
        return assertNever(event);
    }
  }
}

/** A compile time exhaustiveness check. The runtime throw is a formality. */
function assertNever(value: never): never {
  throw new Error(`unhandled event kind: ${JSON.stringify(value)}`);
}
