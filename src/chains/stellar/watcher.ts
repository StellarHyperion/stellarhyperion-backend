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
  completeThrough,
  computeScanWindowEnd,
  endOfLedgerCursor,
  parseEventCursor,
} from "./cursor.js";
import { decodeStellarEvent, type RawStellarEvent } from "./events.js";
import type { EventSource, EventsQuery, RetainedHistoryWindow } from "./rpc.js";
import { StellarRpcError, retentionWindowOf } from "./rpc.js";
import {
  type CursorRepairProposal,
  inspectEventConflict,
  persistScanJournal,
  type EventContext,
  type EventIdentityConflict,
  type VerifiedLedgerBoundary,
  planCursorRepairFromDb,
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
  writeCursor,
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
  private readonly progressJournals: ScanProgressJournal[] = [];
  private readonly recordedConflicts: EventIdentityConflict[] = [];
  private readonly drainController = new AbortController();
  private draining = false;
  private inFlightTick: Promise<boolean> | null = null;
  private lastRetainedHistory: RetainedHistoryWindow | null = null;

  constructor(private readonly options: StellarWatcherOptions) {}

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
    const startedAt = new Date();
    let requestedFrom = this.options.startLedger;
    let requestedTo: number | null = null;
    let committedRange: { readonly from: number; readonly to: number } | null = null;
    let fetched = 0;
    let decoded = 0;
    let skipped = 0;
    let conflicts = 0;
    let pages = 0;
    let interruptionReason: string | null = null;
    let journalPersisted = false;
    const transactionConflicts: EventIdentityConflict[] = [];
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
      const fresh = stored === null;
      requestedFrom = base + 1;

      const scan = await this.scan(base, fresh, signal);
      pages = scan.pages;
      fetched = scan.events.length;
      if (scan.latestLedger > 0) {
        requestedTo = computeScanWindowEnd(requestedFrom, fresh, scan.latestLedger);
        this.lastRetainedHistory = retentionWindowOf({
          oldestLedger: scan.oldestLedger,
          latestLedger: scan.latestLedger,
        });
      }
      interruptionReason = scan.interruptionReason;

      if (scan.interruptionReason === "cancelled" && scan.through <= base) {
        return false;
      }

      if (scan.oldestLedger > base + 1) {
        // The retention window moved past where we stopped. Anything between the two is gone from
        // this node, and carrying on from the window edge would leave a hole nothing ever reports.
        throw new Error("requested Stellar history is outside provider retention");
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

      let closedAt = stored?.observedAt ?? null;
      for (const raw of scan.events) {
        if (raw.ledger <= scan.through) closedAt = new Date(raw.ledgerClosedAt);
      }

      // One transaction for the page and the cursor. This is the restart guarantee, and splitting it
      // would turn every crash into either a lost page or a duplicated one.
      // Once inside the transaction, let it finish committing or rolling back even if drain is
      // requested concurrently.
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
            router,
            ledger: raw.ledger,
            txHash: raw.txHash,
            closedAt: new Date(raw.ledgerClosedAt),
          };
          const outcome = await this.apply(tx, context, raw, transactionConflicts);
          if (outcome === "decoded") decoded += 1;
          else if (outcome === "conflict") conflicts += 1;
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
        if (scan.through > base) committedRange = { from: base + 1, to: scan.through };
        await persistScanJournal(tx, router, journal());
      });
      journalPersisted = true;
      this.recordedConflicts.push(...transactionConflicts);
      if (this.recordedConflicts.length > 100)
        this.recordedConflicts.splice(0, this.recordedConflicts.length - 100);

      const behind = Math.max(scan.latestLedger - scan.through, 0);
      this.lastProgress = { ledger: scan.through, decoded, skipped, behind, at: new Date() };
      logger.info(
        { chain: chainKey, ledger: scan.through, decoded, skipped, conflicts, behind, pages },
        "stellar window indexed",
      );

      // Behind the head means there is another window waiting, so say we progressed and let the
      // poller come straight back rather than sleeping out the interval mid-backfill.
      return !this.draining && !signal.aborted && behind > 0;
    } catch (error) {
      committedRange = null;
      interruptionReason =
        error instanceof Error && error.message === "deadlock detected"
          ? "deadlock detected"
          : "scan_failed";
      throw error;
    } finally {
      const finalJournal = journal();
      if (!journalPersisted) await persistScanJournal(db, router, finalJournal);
      this.recordJournal(finalJournal);
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

    const events: RawStellarEvent[] = [];
    let through = base;
    let latestLedger = 0;
    let oldestLedger = 0;
    let pages = 0;
    let interruptionReason: string | null = null;
    // A fresh cursor starts by ledger. Everything after resumes from a cursor, which is the only
    // account of where the previous scan actually stopped.
    let pagination: Pick<EventsQuery, "startLedger" | "cursor"> = fresh
      ? { startLedger: this.options.startLedger }
      : { cursor: endOfLedgerCursor(base) };

    while (pages < maxPages) {
      if (this.isCancelled(signal)) {
        interruptionReason = "cancelled";
        break;
      }

      let page;
      try {
        page = await this.fetch({ ...pagination, contractIds: [router], limit: pageSize }, signal);
      } catch (error) {
        if (this.isCancelled(signal)) {
          interruptionReason = "cancelled";
          break;
        }
        throw error;
      }

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
        interruptionReason = "missing_cursor";
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

    if (pages >= maxPages && through <= base && interruptionReason === null) {
      logger.error(
        { chain: chainKey, ledger: base + 1, pages, pageSize },
        "a single ledger holds more router events than this many pages could drain; raise STELLAR_EVENT_PAGE_SIZE",
      );
      interruptionReason = "max_pages_reached";
    }

    return { events, through, latestLedger, oldestLedger, pages, interruptionReason };
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
    transactionConflicts: EventIdentityConflict[],
  ): Promise<"decoded" | "skipped" | "conflict"> {
    const event = decodeStellarEvent(raw);
    const conflict = await inspectEventConflict(tx, context.chainKey, raw, event);
    if (conflict !== null) {
      transactionConflicts.push(conflict);
      this.options.logger.warn(
        {
          chain: context.chainKey,
          identity: conflict.identity,
          ledger: raw.ledger,
          txHash: raw.txHash,
          differingFields: conflict.differingFields,
        },
        "conflicting payload detected for canonical event identity; retaining reconciliation evidence",
      );
      return "conflict";
    }

    switch (event.kind) {
      case "bridgeOut":
        await recordBridgeOut(tx, context, event.data);
        return "decoded";
      case "bridgeIn":
        await recordBridgeIn(tx, context, event.data);
        return "decoded";
      case "claimParked":
        await recordClaimParked(tx, context, event.data);
        return "decoded";
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
        return matched ? "decoded" : "skipped";
      }
      case "actionQueued":
        await recordActionQueued(tx, context, event.data, raw.valueJson);
        return "decoded";
      case "actionExecuted":
        await recordActionSettled(tx, context, event.data, "executed");
        return "decoded";
      case "actionCancelled":
        await recordActionSettled(tx, context, event.data, "cancelled");
        return "decoded";
      case "tokenRegistered":
        await recordTokenRegistered(tx, context, event.data);
        return "decoded";
      case "pauseSet":
        // A pause is router wide and there is no table for it, so it is recorded as every rail
        // becoming unavailable for the reason the router would give. That is not a cosmetic
        // mapping: a pause is the one operational state somebody needs to see in the same place
        // they look at route health, rather than in a log they have to go and find.
        await recordPauseSet(tx, context, event.data);
        return "decoded";
      case "routeConfigured":
        // The sample needs a token and this event names none, so it is attributed to the chain
        // itself. A route being on or off is a property of the router, not of one asset.
        await recordRouteConfigured(tx, context, event.data, context.chainKey);
        return "decoded";
      case "ignored":
        return "skipped";
      case "unknown":
        if (!this.reportedUnknown.has(event.tag)) {
          this.reportedUnknown.add(event.tag);
          this.options.logger.warn(
            { chain: context.chainKey, tag: event.tag },
            "the router emitted an event tag this build does not know; it is running ahead of the indexer",
          );
        }
        return "skipped";
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
