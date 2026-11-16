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
import type { Logger } from "pino";

import type { Queryable, Transactional } from "../../db/pool.js";
import type { ReadinessReport } from "../../runtime/readiness.js";
import {
  EventCursorError,
  boundedBackfillTarget,
  completeThrough,
  endOfLedgerCursor,
  nextBackfillLedger,
  parseEventCursor,
} from "./cursor.js";
import { decodeStellarEvent, type RawStellarEvent } from "./events.js";
import type { EventSource, EventsPage, EventsQuery } from "./rpc.js";
import { StellarRpcError, sanitizeStellarRpcReason } from "./rpc.js";
import {
  enqueueBackfillJob,
  listBackfillJobs,
  markBackfillUnresolved,
  readBackfillJob,
  readCursor,
  recordActionQueued,
  recordActionSettled,
  recordBridgeIn,
  recordBridgeOut,
  recordClaimParked,
  recordClaimSettled,
  recordPauseSet,
  recordRouteConfigured,
  recordTokenRegistered,
  saveBackfillProgress,
  writeCursor,
  type BackfillJobStatus,
  type EventContext,
  type StellarBackfillJob,
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
}

export interface WatcherProgress {
  /** The last ledger proven complete, which is what the cursor holds. */
  readonly ledger: number;
  readonly decoded: number;
  readonly skipped: number;
  /** How far behind the chain's head this watcher is, in ledgers. */
  readonly behind: number;
  readonly at: Date;
}

export class StellarWatcher {
  private lastProgress: WatcherProgress | null = null;
  /** Tags seen once and logged once. A contract ahead of this build should not be a log flood. */
  private readonly reportedUnknown = new Set<string>();

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
    const { chainKey, router, db, logger } = this.options;

    const stored = await readCursor(db, chainKey);
    if (stored !== null && stored.contract !== router) {
      // A different router at a different address shares no history with this cursor. Carrying it
      // over would skip everything the new deployment has ever done, and it would do it silently,
      // which is the worst available outcome. Stopping is the only honest move.
      throw new Error(
        `the cursor for ${chainKey} was written for router ${stored.contract} and this process is watching ${router}. ` +
          "A redeployed router needs its cursor reset rather than reused.",
      );
    }

    const base = stored === null ? this.options.startLedger - 1 : Number(stored.position);
    const scan = await this.scan(base, stored === null, signal);

    if (scan.oldestLedger > base + 1 && stored !== null) {
      // The retention window moved past where we stopped. Anything between the two is gone from
      // this node, and carrying on from the window edge would leave a hole nothing ever reports.
      logger.error(
        { chain: chainKey, from: base + 1, oldestLedger: scan.oldestLedger },
        "fell behind the rpc retention window; ledgers between the cursor and the oldest retained ledger were never read",
      );
    }

    if (scan.through <= base && scan.events.length === 0) {
      // No window crossed and nothing read. Report where we still are so readiness keeps telling
      // the truth about the lag rather than going quiet.
      this.lastProgress = {
        ledger: base,
        decoded: 0,
        skipped: 0,
        behind: Math.max(scan.latestLedger - base, 0),
        at: new Date(),
      };
      return false;
    }

    let decoded = 0;
    let skipped = 0;
    let closedAt = stored?.observedAt ?? null;
    for (const raw of scan.events) {
      if (raw.ledger <= scan.through) closedAt = new Date(raw.ledgerClosedAt);
    }

    // One transaction for the page and the cursor. This is the restart guarantee, and splitting it
    // would turn every crash into either a lost page or a duplicated one.
    await db.transaction(async (tx: Queryable) => {
      for (const raw of scan.events) {
        if (raw.type !== "contract" || raw.inSuccessfulContractCall === false) {
          // getEvents no longer returns the deprecated success flag (RPC30).
          // Diagnostic events are excluded by current RPC; retain legacy explicit-failure checks.
          // https://github.com/stellar/stellar-rpc/releases/tag/v30.0.0
          skipped += 1;
          continue;
        }
        const context: EventContext = {
          chainKey,
          ledger: raw.ledger,
          txHash: raw.txHash,
          closedAt: new Date(raw.ledgerClosedAt),
        };
        if (await this.apply(tx, context, raw)) decoded += 1;
        else skipped += 1;
      }

      await writeCursor(tx, {
        chainKey,
        family: "stellar",
        contract: router,
        position: BigInt(scan.through),
        observedAt: closedAt,
        // Nothing to record: a closed ledger cannot be replaced by a different one.
        hash: null,
      });
    });

    const behind = Math.max(scan.latestLedger - scan.through, 0);
    this.lastProgress = { ledger: scan.through, decoded, skipped, behind, at: new Date() };
    logger.info(
      { chain: chainKey, ledger: scan.through, decoded, skipped, behind, pages: scan.pages },
      "stellar window indexed",
    );

    // Behind the head means there is another window waiting, so say we progressed and let the
    // poller come straight back rather than sleeping out the interval mid-backfill.
    return behind > 0;
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
  }> {
    const { router, pageSize, logger, chainKey } = this.options;
    const maxPages = this.options.maxPagesPerTick ?? MAX_PAGES_PER_TICK;

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
        // Not something the live RPC does, and bailing is still better than inventing a position.
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
      // Still inside one ledger. Keep pulling with the RPC's own cursor until it is drained.
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
        // Almost always the start ledger or the cursor having fallen out of the node's retention
        // window. Said plainly, because the fix is an archive source rather than another retry.
        this.options.logger.error(
          { err: error, chain: this.options.chainKey },
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
  ): Promise<boolean> {
    return applyStellarEvent(tx, context, raw, this.options.logger, this.reportedUnknown);
  }
}

export interface RunBackfillJobOptions {
  readonly jobId: bigint;
  readonly expectedRouter: string;
  readonly historicalRpc: EventSource | null;
  readonly db: Transactional;
  readonly logger: Logger;
  readonly pageSize?: number;
  readonly maxLedgersPerPass?: number;
  readonly maxPagesPerWindow?: number;
}

export interface BackfillRunResult {
  readonly jobId: bigint;
  readonly status: BackfillJobStatus;
  readonly completedLedger: bigint | null;
  readonly decoded: number;
  readonly skipped: number;
  readonly reason: string | null;
}

export interface StellarBackfillRunnerOptions {
  readonly chainKey: string;
  readonly router: string;
  readonly historicalRpc: EventSource | null;
  readonly db: Transactional;
  readonly logger: Logger;
  readonly pageSize?: number;
  readonly maxLedgersPerPass?: number;
  readonly maxPagesPerWindow?: number;
}

/**
 * Bounded historical backfill runner using an explicitly configured historical `EventSource` and
 * durable per-job replay state in `stellar_backfill_job` (never modifying live `indexer_cursor`).
 */
export class StellarBackfillRunner {
  private lastUnresolvedCount = 0;

  constructor(private readonly options: StellarBackfillRunnerOptions) {}

  get name(): string {
    return `backfill:${this.options.chainKey}`;
  }

  readiness(): ReadinessReport {
    if (this.lastUnresolvedCount > 0) {
      return {
        name: this.name,
        state: "degraded",
        detail: `${String(this.lastUnresolvedCount)} historical backfill job(s) remain unresolved`,
      };
    }
    return {
      name: this.name,
      state: "ready",
      detail:
        this.options.historicalRpc === null
          ? "no historical backfill jobs pending"
          : "historical backfill provider ready",
    };
  }

  enqueue(fromLedger: bigint, toLedger: bigint): Promise<StellarBackfillJob> {
    return enqueueBackfillJob(this.options.db, {
      chainKey: this.options.chainKey,
      contract: this.options.router,
      fromLedger,
      toLedger,
    });
  }

  runJob(jobId: bigint, signal: AbortSignal): Promise<BackfillRunResult> {
    return runBackfillJob(
      {
        jobId,
        expectedRouter: this.options.router,
        historicalRpc: this.options.historicalRpc,
        db: this.options.db,
        logger: this.options.logger,
        ...(this.options.pageSize === undefined ? {} : { pageSize: this.options.pageSize }),
        ...(this.options.maxLedgersPerPass === undefined
          ? {}
          : { maxLedgersPerPass: this.options.maxLedgersPerPass }),
        ...(this.options.maxPagesPerWindow === undefined
          ? {}
          : { maxPagesPerWindow: this.options.maxPagesPerWindow }),
      },
      signal,
    );
  }

  /**
   * Run one bounded pass across active (`pending` or `running`) backfill jobs.
   * Returns `true` when at least one job remains `running` and has further ledgers to replay.
   */
  async tick(signal: AbortSignal): Promise<boolean> {
    const active = await listBackfillJobs(this.options.db, {
      chainKey: this.options.chainKey,
      contract: this.options.router,
      statuses: ["pending", "running"],
    });

    let moreWork = false;
    for (const job of active) {
      if (signal.aborted) break;
      const result = await this.runJob(job.id, signal);
      if (result.status === "running") {
        moreWork = true;
      }
    }

    const unresolved = await listBackfillJobs(this.options.db, {
      chainKey: this.options.chainKey,
      contract: this.options.router,
      statuses: ["unresolved"],
    });
    this.lastUnresolvedCount = unresolved.length;
    return moreWork;
  }
}

export async function runBackfillJob(
  options: RunBackfillJobOptions,
  signal: AbortSignal,
): Promise<BackfillRunResult> {
  const { jobId, expectedRouter, historicalRpc, db, logger } = options;
  const pageSize = options.pageSize ?? 200;
  const maxLedgersPerPass = options.maxLedgersPerPass ?? 10_000;
  const maxPagesPerWindow = options.maxPagesPerWindow ?? MAX_PAGES_PER_TICK;
  const reportedUnknown = new Set<string>();

  const job = await readBackfillJob(db, jobId);
  if (job === null) {
    throw new Error(`stellar_backfill_job ${jobId.toString()} does not exist`);
  }
  if (job.status === "completed") {
    return {
      jobId: job.id,
      status: "completed",
      completedLedger: job.toLedger,
      decoded: 0,
      skipped: 0,
      reason: null,
    };
  }

  const failUnresolved = async (
    reason: string,
    completedLedger: bigint | null,
    decoded: number,
    skipped: number,
  ): Promise<BackfillRunResult> => {
    const sanitized = sanitizeStellarRpcReason(reason);
    await markBackfillUnresolved(db, job.id, sanitized);
    logger.warn(
      {
        chain: job.chainKey,
        jobId: job.id.toString(),
        fromLedger: job.fromLedger.toString(),
        toLedger: job.toLedger.toString(),
        completedLedger: completedLedger === null ? null : completedLedger.toString(),
        reason: sanitized,
      },
      "stellar historical backfill job marked unresolved",
    );
    return {
      jobId: job.id,
      status: "unresolved",
      completedLedger,
      decoded,
      skipped,
      reason: sanitized,
    };
  };

  if (job.contract !== expectedRouter) {
    return failUnresolved(
      `backfill job router ${job.contract} does not match configured router ${expectedRouter}`,
      job.completedLedger,
      0,
      0,
    );
  }

  if (historicalRpc === null) {
    return failUnresolved(
      "historical event provider is not configured (set STELLAR_HISTORICAL_RPC_URL)",
      job.completedLedger,
      0,
      0,
    );
  }

  let currentCompleted = job.completedLedger;
  let currentResumeCursor = resolveBoundaryResumeCursor(job.completedLedger, job.resumeCursor);
  const startOfPass = nextBackfillLedger(job.fromLedger, currentCompleted);
  const passTarget = boundedBackfillTarget(startOfPass, job.toLedger, maxLedgersPerPass);

  let nextLedger = Number(startOfPass);
  const passTargetNum = Number(passTarget);
  let status: BackfillJobStatus = currentCompleted === null ? "pending" : "running";
  let totalDecoded = 0;
  let totalSkipped = 0;

  while (nextLedger <= passTargetNum && !signal.aborted) {
    const windowEvents: RawStellarEvent[] = [];
    let pagination: Pick<EventsQuery, "startLedger" | "cursor"> =
      currentCompleted === null
        ? { startLedger: nextLedger }
        : { cursor: currentResumeCursor ?? endOfLedgerCursor(Number(currentCompleted)) };
    let pages = 0;
    let windowThrough = nextLedger - 1;
    let windowLatestLedger = 0;

    while (pages < maxPagesPerWindow) {
      let page: EventsPage;
      try {
        page = await historicalRpc.events(
          { ...pagination, contractIds: [job.contract], limit: pageSize },
          signal,
        );
      } catch (error) {
        if (error instanceof StellarRpcError && !error.retryable) {
          return failUnresolved(error.message, currentCompleted, totalDecoded, totalSkipped);
        }
        throw error;
      }
      pages += 1;
      windowLatestLedger = page.latestLedger;

      if (page.oldestLedger > nextLedger) {
        return failUnresolved(
          `historical provider oldestLedger ${String(page.oldestLedger)} exceeds requested ledger ${String(nextLedger)}`,
          currentCompleted,
          totalDecoded,
          totalSkipped,
        );
      }
      if (page.latestLedger > 0 && page.latestLedger < nextLedger) {
        return failUnresolved(
          `historical provider latestLedger ${String(page.latestLedger)} is behind requested ledger ${String(nextLedger)}`,
          currentCompleted,
          totalDecoded,
          totalSkipped,
        );
      }
      if (page.cursor === null) {
        return failUnresolved(
          "historical provider returned a page with no cursor",
          currentCompleted,
          totalDecoded,
          totalSkipped,
        );
      }

      const rawPageEvents = page.events as readonly RawStellarEvent[];
      for (const raw of rawPageEvents) {
        if (raw.contractId !== job.contract) {
          return failUnresolved(
            `historical provider returned event for unexpected contract ${raw.contractId}`,
            currentCompleted,
            totalDecoded,
            totalSkipped,
          );
        }
      }
      windowEvents.push(...rawPageEvents);

      let candidate: number;
      try {
        candidate = completeThrough(parseEventCursor(page.cursor));
      } catch (error) {
        const message =
          error instanceof EventCursorError ? error.message : "invalid cursor from provider";
        return failUnresolved(message, currentCompleted, totalDecoded, totalSkipped);
      }

      if (candidate >= nextLedger) {
        windowThrough = Math.min(candidate, passTargetNum);
        break;
      }
      pagination = { cursor: page.cursor };
    }

    if (windowThrough < nextLedger) {
      return failUnresolved(
        `ledger ${String(nextLedger)} could not be drained within ${String(maxPagesPerWindow)} pages`,
        currentCompleted,
        totalDecoded,
        totalSkipped,
      );
    }

    const boundedEvents = windowEvents.filter(
      (raw) => raw.ledger >= nextLedger && raw.ledger <= windowThrough,
    );
    const completedBigInt = BigInt(windowThrough);
    const boundaryCursor = endOfLedgerCursor(windowThrough);

    let windowDecoded = 0;
    let windowSkipped = 0;

    status = await db.transaction(async (tx: Queryable) => {
      for (const raw of boundedEvents) {
        if (raw.type !== "contract" || raw.inSuccessfulContractCall === false) {
          windowSkipped += 1;
          continue;
        }
        const context: EventContext = {
          chainKey: job.chainKey,
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

      return saveBackfillProgress(tx, {
        jobId: job.id,
        toLedger: job.toLedger,
        completedLedger: completedBigInt,
        resumeCursor: boundaryCursor,
      });
    });

    totalDecoded += windowDecoded;
    totalSkipped += windowSkipped;
    currentCompleted = completedBigInt;
    currentResumeCursor = boundaryCursor;
    nextLedger = windowThrough + 1;

    if (
      status !== "completed" &&
      windowLatestLedger > 0 &&
      windowLatestLedger <= windowThrough &&
      BigInt(windowThrough) < job.toLedger
    ) {
      return failUnresolved(
        `historical provider latestLedger ${String(windowLatestLedger)} stops before target ledger ${job.toLedger.toString()}`,
        currentCompleted,
        totalDecoded,
        totalSkipped,
      );
    }
  }

  logger.info(
    {
      chain: job.chainKey,
      jobId: job.id.toString(),
      fromLedger: job.fromLedger.toString(),
      toLedger: job.toLedger.toString(),
      completedLedger: currentCompleted === null ? null : currentCompleted.toString(),
      status,
      decoded: totalDecoded,
      skipped: totalSkipped,
    },
    "stellar historical backfill pass finished",
  );

  return {
    jobId: job.id,
    status,
    completedLedger: currentCompleted,
    decoded: totalDecoded,
    skipped: totalSkipped,
    reason: null,
  };
}

function resolveBoundaryResumeCursor(
  completedLedger: bigint | null,
  storedCursor: string | null,
): string | null {
  if (completedLedger === null) return null;
  const expectedLedger = Number(completedLedger);
  if (storedCursor !== null) {
    try {
      const parsed = parseEventCursor(storedCursor);
      if (parsed.completesLedger && parsed.ledger === expectedLedger) {
        return storedCursor;
      }
    } catch {
      // Reconstruct the exact canonical boundary cursor below.
    }
  }
  return endOfLedgerCursor(expectedLedger);
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
