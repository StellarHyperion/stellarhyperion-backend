/**
 * The Stellar watcher: one pass over the router's events, written with the cursor that passes them.
 *
 * The correctness claim is narrow and worth stating exactly, because the useful version of it is
 * not the obvious one. After any crash, at any point, the database holds every event up to the
 * cursor, possibly some events after it, and no event twice, except for any unavailable ledger
 * intervals explicitly recorded in `stellar_history_gap`.
 *
 * All three parts earn their keep. "Every event up to the cursor" holds because a page of events
 * and the cursor advance past it are one transaction. "Possibly some after it" is the honest
 * description of a page that stopped partway through a ledger: those events are real and final, so
 * they are written rather than thrown away, and the cursor stays at the last ledger that is
 * provably whole. "No event twice" holds because every insert is an upsert on a natural key, which
 * is what makes re-reading a ledger after a restart or archive backfill a no-op rather than a
 * duplicate.
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
import type { Logger } from "pino";

import type { Queryable, Transactional } from "../../db/pool.js";
import type { ReadinessReport } from "../../runtime/readiness.js";
import {
  completeThrough,
  endOfLedgerCursor,
  ledgerSpanCount,
  parseEventCursor,
  unreconciledStartLedger,
} from "./cursor.js";
import { decodeStellarEvent, type RawStellarEvent } from "./events.js";
import type { EventSource, EventsQuery, RetentionWindow } from "./rpc.js";
import { StellarRpcError, parseRetentionWindow } from "./rpc.js";
import {
  advanceOrCloseHistoryGap,
  listHistoryGaps,
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
  remainingGapLedgers,
  writeCursor,
  type EventContext,
  type HistoryGapStatus,
  type StellarHistoryGap,
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
  /**
   * When true, a retention refusal records the missing `[expected, oldestLedger - 1]` interval in
   * `stellar_history_gap` and resumes live indexing from `oldestLedger` while keeping historical
   * coverage marked incomplete until archive backfill closes the gap.
   */
  readonly advancePastRetentionGap?: boolean;
}

export interface WatcherProgress {
  /** The last ledger proven complete, which is what the cursor holds. */
  readonly ledger: number;
  readonly decoded: number;
  readonly skipped: number;
  /** How far behind the chain's head this watcher is, in ledgers. */
  readonly behind: number;
  readonly at: Date;
  readonly historyComplete?: boolean;
  readonly openGaps?: number;
}

export interface ReconcileHistoryGapOptions {
  readonly gap: StellarHistoryGap;
  readonly rpc: EventSource;
  readonly db: Transactional;
  readonly logger: Logger;
  readonly pageSize?: number;
  readonly maxPagesPerWindow?: number;
}

export interface ReconcileHistoryGapResult {
  readonly gapId: bigint;
  readonly status: HistoryGapStatus;
  readonly completedThrough: bigint;
  readonly decoded: number;
  readonly skipped: number;
}

interface LocalGapBounds {
  readonly fromLedger: bigint;
  readonly toLedger: bigint;
}

function gapKey(fromLedger: bigint, toLedger: bigint): string {
  return `${fromLedger.toString()}:${toLedger.toString()}`;
}

export class StellarWatcher {
  private lastProgress: WatcherProgress | null = null;
  /** Tags seen once and logged once. A contract ahead of this build should not be a log flood. */
  private readonly reportedUnknown = new Set<string>();
  private readonly localOpenGaps = new Map<string, LocalGapBounds>();
  private dbOpenGaps: readonly StellarHistoryGap[] = [];

  constructor(private readonly options: StellarWatcherOptions) {}

  get name(): string {
    return this.options.chainKey;
  }

  get progress(): WatcherProgress | null {
    return this.lastProgress;
  }

  /**
   * Readiness from cached state, never from a network call.
   *
   * Distinguishes live cursor freshness (`cursorFresh`) from historical coverage completeness
   * (`historyComplete`). A watcher that caught up to the head after a retention gap has a fresh
   * cursor and incomplete history, so it reports `degraded` until backfill closes the gap.
   */
  readiness(): ReadinessReport {
    const progress = this.lastProgress;
    const gapSummary = this.openGapSummary();
    const historyComplete = gapSummary.openGapCount === 0;

    if (progress === null) {
      const detail = historyComplete
        ? "has not completed a pass yet, so nothing it could be asked about is indexed"
        : `has not completed a pass yet and has ${String(gapSummary.openGapCount)} open history gap(s) covering ${gapSummary.missingLedgers.toString()} missing ledgers`;
      return {
        name: this.name,
        state: "degraded",
        detail,
        cursorFresh: false,
        historyComplete,
        openHistoryGaps: gapSummary.openGapCount,
      };
    }
    if (progress.behind > CURRENT_WITHIN_LEDGERS) {
      return {
        name: this.name,
        state: "degraded",
        detail: `${String(progress.behind)} ledgers behind the head at ledger ${String(progress.ledger)}, so a recent transfer may not be recorded yet`,
        cursorFresh: false,
        historyComplete,
        openHistoryGaps: gapSummary.openGapCount,
      };
    }
    if (!historyComplete) {
      return {
        name: this.name,
        state: "degraded",
        detail: `current at ledger ${String(progress.ledger)}, but historical coverage is incomplete (${String(gapSummary.openGapCount)} open gap(s) across ${gapSummary.missingLedgers.toString()} ledgers)`,
        cursorFresh: true,
        historyComplete: false,
        openHistoryGaps: gapSummary.openGapCount,
      };
    }
    return {
      name: this.name,
      state: "ready",
      detail: `current at ledger ${String(progress.ledger)}`,
      cursorFresh: true,
      historyComplete: true,
      openHistoryGaps: 0,
    };
  }

  /**
   * One pass. Returns true when it made progress and should be run again immediately, which is how
   * a watcher starting thousands of ledgers back catches up without sleeping between windows.
   */
  async tick(signal: AbortSignal): Promise<boolean> {
    const { chainKey, router, db, logger } = this.options;

    const stored = await readCursor(db, chainKey);
    if (stored !== null && stored.contract !== router) {
      throw new Error(
        `the cursor for ${chainKey} was written for router ${stored.contract} and this process is watching ${router}. ` +
          "A redeployed router needs its cursor reset rather than reused.",
      );
    }

    await this.refreshOpenGaps();

    const base = stored === null ? this.options.startLedger - 1 : Number(stored.position);
    const expectedFirst = base + 1;

    let scan: {
      readonly events: readonly RawStellarEvent[];
      readonly through: number;
      readonly latestLedger: number;
      readonly oldestLedger: number;
      readonly pages: number;
    };

    try {
      scan = await this.scan(base, stored === null, this.options.startLedger, signal);
    } catch (error) {
      const window = await this.detectRetentionGap(error, expectedFirst, signal);
      if (window !== null && window.oldestLedger > expectedFirst) {
        const fromLedger = BigInt(expectedFirst);
        const toLedger = BigInt(window.oldestLedger - 1);
        await recordHistoryGap(db, {
          chainKey,
          contract: router,
          fromLedger,
          toLedger,
          reason: "rpc_retention_refused",
        });
        this.rememberGap(fromLedger, toLedger);
        await this.refreshOpenGaps();

        if (this.options.advancePastRetentionGap === true) {
          logger.warn(
            {
              chain: chainKey,
              fromLedger: fromLedger.toString(),
              toLedger: toLedger.toString(),
              resumingAt: window.oldestLedger,
            },
            "persisted unavailable ledger gap and advancing live watcher to retention edge",
          );
          scan = await this.scan(window.oldestLedger - 1, true, window.oldestLedger, signal);
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }

    const slidingGap =
      scan.oldestLedger > expectedFirst
        ? {
            fromLedger: BigInt(expectedFirst),
            toLedger: BigInt(scan.oldestLedger - 1),
          }
        : null;

    if (slidingGap !== null) {
      logger.error(
        { chain: chainKey, from: expectedFirst, oldestLedger: scan.oldestLedger },
        "fell behind the rpc retention window; ledgers between the cursor and the oldest retained ledger were never read",
      );
    }

    if (scan.through <= base && scan.events.length === 0) {
      if (slidingGap !== null) {
        await recordHistoryGap(db, {
          chainKey,
          contract: router,
          fromLedger: slidingGap.fromLedger,
          toLedger: slidingGap.toLedger,
          reason: "rpc_retention_window",
        });
        this.rememberGap(slidingGap.fromLedger, slidingGap.toLedger);
        await this.refreshOpenGaps();
      }
      const gapSummary = this.openGapSummary();
      this.lastProgress = {
        ledger: base,
        decoded: 0,
        skipped: 0,
        behind: Math.max(scan.latestLedger - base, 0),
        at: new Date(),
        historyComplete: gapSummary.openGapCount === 0,
        openGaps: gapSummary.openGapCount,
      };
      return false;
    }

    let decoded = 0;
    let skipped = 0;
    let closedAt = stored?.observedAt ?? null;
    for (const raw of scan.events) {
      if (raw.ledger <= scan.through) closedAt = new Date(raw.ledgerClosedAt);
    }

    // One transaction for the page, any newly observed retention gap, and the cursor.
    await db.transaction(async (tx: Queryable) => {
      if (slidingGap !== null) {
        await recordHistoryGap(tx, {
          chainKey,
          contract: router,
          fromLedger: slidingGap.fromLedger,
          toLedger: slidingGap.toLedger,
          reason: "rpc_retention_window",
        });
      }

      for (const raw of scan.events) {
        if (raw.type !== "contract" || raw.inSuccessfulContractCall === false) {
          skipped += 1;
          continue;
        }
        const context: EventContext = {
          chainKey,
          ledger: raw.ledger,
          txHash: raw.txHash,
          closedAt: new Date(raw.ledgerClosedAt),
        };
        if (await applyStellarEvent(tx, context, raw, logger, this.reportedUnknown)) decoded += 1;
        else skipped += 1;
      }

      await writeCursor(tx, {
        chainKey,
        family: "stellar",
        contract: router,
        position: BigInt(scan.through),
        observedAt: closedAt,
        hash: null,
      });
    });

    if (slidingGap !== null) {
      this.rememberGap(slidingGap.fromLedger, slidingGap.toLedger);
      await this.refreshOpenGaps();
    }

    const gapSummary = this.openGapSummary();
    const behind = Math.max(scan.latestLedger - scan.through, 0);
    this.lastProgress = {
      ledger: scan.through,
      decoded,
      skipped,
      behind,
      at: new Date(),
      historyComplete: gapSummary.openGapCount === 0,
      openGaps: gapSummary.openGapCount,
    };
    logger.info(
      {
        chain: chainKey,
        ledger: scan.through,
        decoded,
        skipped,
        behind,
        pages: scan.pages,
        openGaps: gapSummary.openGapCount,
      },
      "stellar window indexed",
    );

    return behind > 0;
  }

  /**
   * Reconcile all open or partially reconciled history gaps for this watcher's chain and router
   * using an archive-capable `EventSource`, without rewinding live `indexer_cursor` progress.
   */
  async reconcileHistoryGaps(
    archiveRpc: EventSource,
    signal: AbortSignal,
  ): Promise<readonly ReconcileHistoryGapResult[]> {
    const gaps = await listHistoryGaps(this.options.db, {
      chainKey: this.options.chainKey,
      contract: this.options.router,
      includeClosed: false,
    });
    const results: ReconcileHistoryGapResult[] = [];
    for (const gap of gaps) {
      if (signal.aborted) break;
      const res = await reconcileHistoryGap(
        {
          gap,
          rpc: archiveRpc,
          db: this.options.db,
          logger: this.options.logger,
          pageSize: this.options.pageSize,
          ...(this.options.maxPagesPerTick === undefined
            ? {}
            : { maxPagesPerWindow: this.options.maxPagesPerTick }),
        },
        signal,
      );
      if (res.status === "closed") {
        this.localOpenGaps.delete(gapKey(gap.fromLedger, gap.toLedger));
      }
      results.push(res);
    }
    await this.refreshOpenGaps();
    if (this.lastProgress !== null) {
      const gapSummary = this.openGapSummary();
      this.lastProgress = {
        ...this.lastProgress,
        historyComplete: gapSummary.openGapCount === 0,
        openGaps: gapSummary.openGapCount,
      };
    }
    return results;
  }

  private rememberGap(fromLedger: bigint, toLedger: bigint): void {
    this.localOpenGaps.set(gapKey(fromLedger, toLedger), { fromLedger, toLedger });
  }

  private async refreshOpenGaps(): Promise<void> {
    const rows = await listHistoryGaps(this.options.db, {
      chainKey: this.options.chainKey,
      contract: this.options.router,
      includeClosed: false,
    });
    this.dbOpenGaps = rows;
    if (rows.length > 0) {
      this.localOpenGaps.clear();
      for (const row of rows) {
        this.localOpenGaps.set(gapKey(row.fromLedger, row.toLedger), {
          fromLedger: row.fromLedger,
          toLedger: row.toLedger,
        });
      }
    }
  }

  private openGapSummary(): { readonly openGapCount: number; readonly missingLedgers: bigint } {
    if (this.dbOpenGaps.length > 0) {
      let missingLedgers = 0n;
      for (const gap of this.dbOpenGaps) {
        missingLedgers += remainingGapLedgers(gap);
      }
      return { openGapCount: this.dbOpenGaps.length, missingLedgers };
    }
    let missingLedgers = 0n;
    for (const gap of this.localOpenGaps.values()) {
      missingLedgers += ledgerSpanCount(gap.fromLedger, gap.toLedger);
    }
    return { openGapCount: this.localOpenGaps.size, missingLedgers };
  }

  private async detectRetentionGap(
    error: unknown,
    expectedFirst: number,
    signal: AbortSignal,
  ): Promise<RetentionWindow | null> {
    if (!(error instanceof StellarRpcError) || error.retryable) {
      return null;
    }
    if (error.retentionWindow !== null) {
      return error.retentionWindow;
    }
    const parsed = parseRetentionWindow(error.message);
    if (parsed !== null) {
      return parsed;
    }
    if (!/ledger range|must be within|retention/i.test(error.message)) {
      return null;
    }
    if (typeof this.options.rpc.latestLedger === "function") {
      try {
        const head = await this.options.rpc.latestLedger(signal);
        if (head.sequence > expectedFirst) {
          const probe = await this.options.rpc.events(
            {
              startLedger: head.sequence,
              contractIds: [this.options.router],
              limit: 1,
            },
            signal,
          );
          if (probe.oldestLedger > 0 && probe.latestLedger >= probe.oldestLedger) {
            return { oldestLedger: probe.oldestLedger, latestLedger: probe.latestLedger };
          }
        }
      } catch {
        // Preserve the original retention error when fallback probing fails.
      }
    }
    return null;
  }

  /**
   * Read forward from `base` until a whole ledger has been crossed.
   */
  private async scan(
    base: number,
    fresh: boolean,
    initialStartLedger: number,
    signal: AbortSignal,
  ): Promise<{
    readonly events: readonly RawStellarEvent[];
    readonly through: number;
    readonly latestLedger: number;
    readonly oldestLedger: number;
    readonly pages: number;
  }> {
    const { router, pageSize, logger, chainKey } = this.options;
    const maxPages = this.options.maxPagesPerTick ?? MAX_PAGES_PER_TICK;

    const events: RawStellarEvent[] = [];
    let through = base;
    let latestLedger = 0;
    let oldestLedger = 0;
    let pages = 0;
    let pagination: Pick<EventsQuery, "startLedger" | "cursor"> = fresh
      ? { startLedger: initialStartLedger }
      : { cursor: endOfLedgerCursor(base) };

    while (pages < maxPages) {
      const page = await this.fetch(
        { ...pagination, contractIds: [router], limit: pageSize },
        signal,
      );
      pages += 1;
      events.push(...(page.events as readonly RawStellarEvent[]));
      latestLedger = page.latestLedger;
      oldestLedger = page.oldestLedger;

      if (page.cursor === null) {
        logger.warn(
          { chain: chainKey, pages },
          "the rpc returned a page with no cursor, so this pass cannot say what it finished reading",
        );
        break;
      }

      const candidate = completeThrough(parseEventCursor(page.cursor));
      if (candidate > through) {
        through = candidate;
        break;
      }
      pagination = { cursor: page.cursor };
    }

    if (pages >= maxPages && through <= base) {
      logger.error(
        { chain: chainKey, ledger: base + 1, pages, pageSize },
        "a single ledger holds more router events than this many pages could drain; raise STELLAR_EVENT_PAGE_SIZE",
      );
    }

    return { events, through, latestLedger, oldestLedger, pages };
  }

  private async fetch(query: EventsQuery, signal: AbortSignal) {
    try {
      return await this.options.rpc.events(query, signal);
    } catch (error) {
      if (error instanceof StellarRpcError && !error.retryable) {
        this.options.logger.error(
          { err: error, chain: this.options.chainKey },
          "the rpc refused this range permanently; the watcher cannot close this gap from here",
        );
      }
      throw error;
    }
  }
}

/**
 * Replay an unavailable ledger interval from an archive-capable `EventSource` into the canonical
 * event tables and close the gap once `gap.toLedger` is durably covered.
 *
 * Uses the exact same idempotent `ON CONFLICT` writers as live ingestion and never rewinds
 * `indexer_cursor`, so replaying overlapping or already-seen ledgers never duplicates transfers.
 */
export async function reconcileHistoryGap(
  options: ReconcileHistoryGapOptions,
  signal: AbortSignal,
): Promise<ReconcileHistoryGapResult> {
  const { gap, rpc, db, logger } = options;
  const pageSize = options.pageSize ?? 200;
  const maxPagesPerWindow = options.maxPagesPerWindow ?? MAX_PAGES_PER_TICK;
  const reportedUnknown = new Set<string>();

  if (gap.status === "closed") {
    return {
      gapId: gap.id,
      status: "closed",
      completedThrough: gap.toLedger,
      decoded: 0,
      skipped: 0,
    };
  }

  const targetLedger = Number(gap.toLedger);
  let nextLedger = Number(unreconciledStartLedger(gap.fromLedger, gap.reconciledThrough));
  let completedThrough = gap.reconciledThrough ?? gap.fromLedger - 1n;
  let status: HistoryGapStatus = gap.status;
  let totalDecoded = 0;
  let totalSkipped = 0;

  while (nextLedger <= targetLedger && !signal.aborted) {
    const windowEvents: RawStellarEvent[] = [];
    let pagination: Pick<EventsQuery, "startLedger" | "cursor"> = { startLedger: nextLedger };
    let pages = 0;
    let windowThrough = nextLedger - 1;

    while (pages < maxPagesPerWindow) {
      const page = await rpc.events(
        { ...pagination, contractIds: [gap.contract], limit: pageSize },
        signal,
      );
      pages += 1;

      if (page.oldestLedger > nextLedger) {
        throw new StellarRpcError(
          "getEvents",
          `archive provider oldestLedger ${String(page.oldestLedger)} exceeds gap start ${String(nextLedger)}`,
          false,
        );
      }

      windowEvents.push(...(page.events as readonly RawStellarEvent[]));
      if (page.cursor === null) {
        throw new StellarRpcError(
          "getEvents",
          "archive provider returned a page with no cursor during gap backfill",
          true,
        );
      }

      const candidate = completeThrough(parseEventCursor(page.cursor));
      if (candidate >= nextLedger) {
        windowThrough = Math.min(candidate, targetLedger);
        break;
      }
      pagination = { cursor: page.cursor };
    }

    if (windowThrough < nextLedger) {
      throw new Error(
        `ledger ${String(nextLedger)} exceeded ${String(maxPagesPerWindow)} pages during gap backfill`,
      );
    }

    const boundedEvents = windowEvents.filter(
      (raw) => raw.ledger >= nextLedger && raw.ledger <= windowThrough,
    );

    let windowDecoded = 0;
    let windowSkipped = 0;
    const completedBigInt = BigInt(windowThrough);

    await db.transaction(async (tx: Queryable) => {
      for (const raw of boundedEvents) {
        if (raw.type !== "contract" || raw.inSuccessfulContractCall === false) {
          windowSkipped += 1;
          continue;
        }
        const context: EventContext = {
          chainKey: gap.chainKey,
          ledger: raw.ledger,
          txHash: raw.txHash,
          closedAt: new Date(raw.ledgerClosedAt),
        };
        if (await applyStellarEvent(tx, context, raw, logger, reportedUnknown)) {
          windowDecoded += 1;
        } else {
          windowSkipped += 1;
        }
      }

      status = await advanceOrCloseHistoryGap(tx, gap, completedBigInt);
    });

    totalDecoded += windowDecoded;
    totalSkipped += windowSkipped;
    completedThrough = completedBigInt;
    nextLedger = windowThrough + 1;
  }

  logger.info(
    {
      chain: gap.chainKey,
      gapId: gap.id.toString(),
      fromLedger: gap.fromLedger.toString(),
      toLedger: gap.toLedger.toString(),
      completedThrough: completedThrough.toString(),
      status,
      decoded: totalDecoded,
      skipped: totalSkipped,
    },
    "stellar history gap reconciliation pass finished",
  );

  return {
    gapId: gap.id,
    status,
    completedThrough,
    decoded: totalDecoded,
    skipped: totalSkipped,
  };
}

async function applyStellarEvent(
  tx: Queryable,
  context: EventContext,
  raw: RawStellarEvent,
  logger: Logger,
  reportedUnknown: Set<string>,
): Promise<boolean> {
  const event = decodeStellarEvent(raw);

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
        logger.warn(
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
      await recordPauseSet(tx, context, event.data);
      return true;
    case "routeConfigured":
      await recordRouteConfigured(tx, context, event.data, context.chainKey);
      return true;
    case "ignored":
      return false;
    case "unknown":
      if (!reportedUnknown.has(event.tag)) {
        reportedUnknown.add(event.tag);
        logger.warn(
          { chain: context.chainKey, tag: event.tag },
          "the router emitted an event tag this build does not know; it is running ahead of the indexer",
        );
      }
      return false;
    default:
      return assertNever(event);
  }
}

/** A compile time exhaustiveness check. The runtime throw is a formality. */
function assertNever(value: never): never {
  throw new Error(`unhandled event kind: ${JSON.stringify(value)}`);
}
