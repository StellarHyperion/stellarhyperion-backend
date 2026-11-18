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
  type AdaptiveWindowConfig,
  DEFAULT_ADAPTIVE_WINDOW_CONFIG,
  SCAN_WINDOW_LEDGERS,
  endOfLedgerCursor,
  nextScanWindowLedgers,
  validateScanPage,
} from "./cursor.js";
import { decodeStellarEvent, type RawStellarEvent, type StellarEvent } from "./events.js";
import type { EventSource, EventsQuery } from "./rpc.js";
import { StellarRpcError } from "./rpc.js";
import {
  type ChainCursor,
  readCursor,
  recordActionQueued,
  recordActionSettled,
  recordBridgeIn,
  recordBridgeOut,
  recordClaimParked,
  recordClaimSettled,
  recordDeploymentRevision,
  recordPauseSet,
  recordQuarantinedEvent,
  recordRouteConfigured,
  recordTokenRegistered,
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
  /** Optional explicit watched deployment revision; increments automatically on router change. */
  readonly deploymentRevision?: number;
  /** Optional adaptive scan-window sizing configuration. */
  readonly adaptiveWindow?: AdaptiveWindowConfig;
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
  /** Tags seen once and logged once. A contract ahead of this build should not be a log flood. */
  private readonly reportedUnknown = new Set<string>();
  /** Router transitions logged once per `(old -> new)` pair. */
  private readonly reportedReplacements = new Set<string>();

  constructor(private readonly options: StellarWatcherOptions) {
    this.scanWindowLedgers = options.adaptiveWindow?.maxLedgers ?? SCAN_WINDOW_LEDGERS;
  }

  get name(): string {
    return this.options.chainKey;
  }

  get progress(): WatcherProgress | null {
    return this.lastProgress;
  }

  get windowLedgers(): number {
    return this.scanWindowLedgers;
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
    const deployment = this.resolveDeployment(stored);
    const { base, fresh, revision, previous } = deployment;

    const scan = await this.scan(base, fresh, signal);

    if (scan.oldestLedger > base + 1 && !fresh) {
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
        quarantined: 0,
        revision,
        windowLedgers: this.scanWindowLedgers,
        behind: Math.max(scan.latestLedger - base, 0),
        at: new Date(),
      };
      return false;
    }

    let decoded = 0;
    let skipped = 0;
    let quarantined = 0;
    let closedAt = fresh ? null : (stored?.observedAt ?? null);
    for (const raw of scan.events) {
      if (raw.ledger <= scan.through) closedAt = new Date(raw.ledgerClosedAt);
    }

    // One transaction for the page, quarantined events, revision record, and the cursor.
    await db.transaction(async (tx: Queryable) => {
      if (fresh) {
        await recordDeploymentRevision(tx, {
          chainKey,
          deploymentRevision: revision,
          contract: router,
          startLedger: BigInt(this.options.startLedger),
          previousContract: previous?.contract ?? null,
          previousCursor: previous?.cursor ?? null,
        });
      }

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
        const outcome = await this.apply(tx, context, raw, revision);
        if (outcome === "decoded") decoded += 1;
        else if (outcome === "quarantined") {
          quarantined += 1;
          skipped += 1;
        } else {
          skipped += 1;
        }
      }

      await writeCursor(tx, {
        chainKey,
        family: "stellar",
        contract: router,
        position: BigInt(scan.through),
        observedAt: closedAt,
        // Nothing to record: a closed ledger cannot be replaced by a different one.
        hash: null,
        deploymentRevision: revision,
      });
    });

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
      {
        chain: chainKey,
        ledger: scan.through,
        decoded,
        skipped,
        quarantined,
        revision,
        windowLedgers: this.scanWindowLedgers,
        behind,
        pages: scan.pages,
      },
      "stellar window indexed",
    );

    // Behind the head means there is another window waiting, so say we progressed and let the
    // poller come straight back rather than sleeping out the interval mid-backfill.
    return behind > 0;
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
    const windowConfig = this.options.adaptiveWindow ?? DEFAULT_ADAPTIVE_WINDOW_CONFIG;

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
      const requestedWindow = this.scanWindowLedgers;
      const endLedger =
        requestedWindow < windowConfig.maxLedgers
          ? pagination.startLedger !== undefined
            ? pagination.startLedger + requestedWindow
            : pages === 0
              ? base + 1 + requestedWindow
              : undefined
          : undefined;
      const query: EventsQuery = {
        ...pagination,
        ...(endLedger === undefined ? {} : { endLedger }),
        contractIds: [router],
        limit: pageSize,
      };

      const startedAt = performance.now();
      const page = await this.fetch(query, signal);
      const elapsedMs = performance.now() - startedAt;

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
          elapsedMs,
        },
        windowConfig,
      );

      pages += 1;
      events.push(...(page.events as readonly RawStellarEvent[]));
      latestLedger = page.latestLedger;
      oldestLedger = page.oldestLedger;

      if (page.cursor === null || validated.through === null) {
        // Not something the live RPC does, and bailing is still better than inventing a position.
        logger.warn(
          { chain: chainKey, pages },
          "the rpc returned a page with no cursor, so this pass cannot say what it finished reading",
        );
        break;
      }

      if (validated.through > through) {
        through = validated.through;
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
    deploymentRevision: number,
  ): Promise<"decoded" | "skipped" | "quarantined"> {
    let event: StellarEvent;
    try {
      event = decodeStellarEvent(raw);
    } catch (error) {
      const decodeError = error instanceof Error ? error.message : String(error);
      this.options.logger.warn(
        {
          chain: context.chainKey,
          eventId: raw.id,
          ledger: raw.ledger,
          txHash: raw.txHash,
          err: decodeError,
        },
        "quarantining stellar event that failed to decode",
      );
      await recordQuarantinedEvent(tx, {
        chainKey: context.chainKey,
        contract: this.options.router,
        deploymentRevision,
        raw,
        reason: "decode_error",
        tag: null,
        decodeError,
      });
      return "quarantined";
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
        await recordQuarantinedEvent(tx, {
          chainKey: context.chainKey,
          contract: this.options.router,
          deploymentRevision,
          raw,
          reason: "unknown_tag",
          tag: event.tag,
          decodeError: null,
        });
        return "quarantined";
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
