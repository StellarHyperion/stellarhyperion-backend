/**
 * Soroban event cursors, and the one piece of arithmetic the watcher's correctness rests on.
 *
 * `getEvents` does not scan to the head of the chain. It scans a bounded window and returns a
 * cursor saying where it stopped, and that single fact decides the whole shape of the watcher.
 * Everything here was measured against the live testnet RPC rather than assumed, because every
 * one of these details produces a plausible wrong answer if it is guessed:
 *
 *   - The window is ten thousand ledgers. `startLedger=4880000` came back with no events and a
 *     cursor at ledger 4889999, with the head twelve thousand ledgers further on. So an empty
 *     page means "nothing in this window", never "nothing left to read", and a watcher that
 *     treats the two as the same either stalls forever or skips a window.
 *   - A cursor-resumed request scans 9999 ledgers rather than 10000. An off-by-one in the RPC's
 *     own range arithmetic, and the reason this file never computes the next start ledger itself:
 *     the returned cursor is the only account of where the scan actually stopped.
 *   - Events come back in ascending id order, where an id is `<toid>-<event index>` and a toid is
 *     `(ledger << 32) | (tx index << 20) | op index`. The ledger is the top 32 bits.
 *   - A window that ends without filling the page reports an end-of-window cursor whose event
 *     index is `0xFFFFFFFF`, a value no real event carries. A page that fills first reports the
 *     last event's own id. The difference is what separates "this ledger is complete" from
 *     "this ledger is half read", which is what the database cursor has to mean.
 *
 * That last point is why the schema stores a ledger number and not an opaque string. The only
 * cursor the watcher ever persists is a ledger boundary, and a boundary is exactly reconstructible
 * from the ledger: `endOfLedgerCursor` round trips byte for byte against a cursor the live RPC
 * produced. So the stored position stays a number an operator can read and compare against a
 * block explorer, and resume is still exact.
 */

/** The event index the RPC uses for an end-of-window marker. No real event has it. */
const END_OF_WINDOW_INDEX = 0xffff_ffff;

/** Observed window width for a `startLedger` request. Used for reporting, never for resuming. */
export const SCAN_WINDOW_LEDGERS = 10_000;
/** Minimum adaptive scan window width in ledgers. */
export const MIN_SCAN_WINDOW_LEDGERS = 100;

export class EventCursorError extends Error {
  constructor(cursor: string, reason: string) {
    super(`event cursor ${JSON.stringify(cursor)} ${reason}`);
    this.name = "EventCursorError";
  }
}

export class EventCompletenessError extends Error {
  constructor(reason: string) {
    super(`event source completeness check failed: ${reason}`);
    this.name = "EventCompletenessError";
  }
}

export interface CursorPosition {
  /** The ledger the cursor sits in. */
  readonly ledger: number;
  /**
   * True when the cursor is the end-of-window marker, so `ledger` is read to its last event.
   *
   * False when it points at one real event, which means that event's ledger may hold more events
   * the page did not reach.
   */
  readonly completesLedger: boolean;
}

interface CursorParts extends CursorPosition {
  readonly toid: bigint;
  readonly eventIndex: number;
}

/**
 * The cursor meaning "every event up to and including `ledger` has been read".
 *
 * `((ledger + 1) << 32) - 1` is the largest id any event in `ledger` could have, so resuming from
 * it yields the first event of `ledger + 1`. Verified at the boundary against the live RPC: the
 * cursor for the ledger holding the router's first event excludes that event and returns the next
 * one, and the cursor for the ledger before it includes it.
 */
export function endOfLedgerCursor(ledger: number): string {
  if (!Number.isInteger(ledger) || ledger < 0) {
    throw new RangeError(`ledger must be a non-negative integer, got ${String(ledger)}`);
  }
  const toid = ((BigInt(ledger) + 1n) << 32n) - 1n;
  // Zero padded to the widths the RPC itself emits. The RPC compares cursors as strings, so a
  // cursor of the right value and the wrong width is a different cursor.
  return `${toid.toString().padStart(19, "0")}-${String(END_OF_WINDOW_INDEX).padStart(10, "0")}`;
}

/**
 * Where a cursor the RPC handed back actually points.
 *
 * Parsed rather than trusted. A cursor shape that changed under us would otherwise show up as a
 * watcher silently rewinding to ledger zero and re-reading the chain from the beginning.
 */
function parseEventCursorParts(cursor: string): CursorParts {
  const parts = cursor.split("-");
  const [toidText, indexText] = parts;
  if (parts.length !== 2 || toidText === undefined || indexText === undefined) {
    throw new EventCursorError(cursor, "is not a toid and an event index separated by a dash");
  }
  if (!/^\d+$/.test(toidText) || !/^\d+$/.test(indexText)) {
    throw new EventCursorError(cursor, "has a non numeric part");
  }

  const toid = BigInt(toidText);
  const ledger = Number(toid >> 32n);
  if (!Number.isSafeInteger(ledger)) {
    throw new EventCursorError(cursor, "names a ledger too large to be real");
  }
  const eventIndex = Number(indexText);
  if (!Number.isSafeInteger(eventIndex) || eventIndex < 0 || eventIndex > END_OF_WINDOW_INDEX) {
    throw new EventCursorError(cursor, "has an out-of-range event index");
  }
  return {
    ledger,
    completesLedger: eventIndex === END_OF_WINDOW_INDEX,
    toid,
    eventIndex,
  };
}

export function parseEventCursor(cursor: string): CursorPosition {
  const { ledger, completesLedger } = parseEventCursorParts(cursor);
  return { ledger, completesLedger };
}

/** Compare two RPC event cursors numerically by `(toid, eventIndex)`. */
export function compareEventCursors(a: string, b: string): number {
  const left = parseEventCursorParts(a);
  const right = parseEventCursorParts(b);
  if (left.toid < right.toid) return -1;
  if (left.toid > right.toid) return 1;
  if (left.eventIndex < right.eventIndex) return -1;
  if (left.eventIndex > right.eventIndex) return 1;
  return 0;
}

/**
 * The last ledger a page leaves fully read.
 *
 * On an end-of-window cursor that is the cursor's own ledger: the scan reached the end of the
 * window, so everything in it is read whether or not anything was found.
 *
 * On a mid-ledger cursor it is the ledger before, because the page stopped partway through and
 * the rest of that ledger has not been seen. The events that were seen are still written: every
 * insert is an upsert on a natural key, so the next pass re-reads that ledger and writes nothing
 * new. Paying for one duplicated read is what buys a cursor that cannot describe a half written
 * ledger, and the RPC's own documentation asks clients to deduplicate on event id for the same
 * reason.
 */
export function completeThrough(position: Pick<CursorPosition, "ledger" | "completesLedger">): number {
  return position.completesLedger ? position.ledger : position.ledger - 1;
}

export interface PageCompletenessInput {
  readonly events: readonly unknown[];
  readonly cursor: string | null;
  readonly latestLedger: number;
  readonly oldestLedger: number;
  readonly requestCursor?: string | undefined;
  readonly requestStartLedger?: number | undefined;
  readonly requestEndLedger?: number | undefined;
}

export interface ValidatedPageBoundary {
  readonly position: CursorPosition | null;
  readonly through: number | null;
}

/**
 * Validate provider ledger ranges, event/cursor ordering, and end markers before declaring a
 * scan boundary complete.
 */
export function validateScanPage(input: PageCompletenessInput): ValidatedPageBoundary {
  const {
    events,
    cursor,
    latestLedger,
    oldestLedger,
    requestCursor,
    requestStartLedger,
    requestEndLedger,
  } = input;

  if (!Number.isSafeInteger(latestLedger) || latestLedger <= 0) {
    throw new EventCompletenessError(`invalid latestLedger ${String(latestLedger)}`);
  }
  if (!Number.isSafeInteger(oldestLedger) || oldestLedger < 0 || oldestLedger > latestLedger) {
    throw new EventCompletenessError(
      `invalid provider ledger range ${String(oldestLedger)}..${String(latestLedger)}`,
    );
  }
  if (requestStartLedger !== undefined && latestLedger < requestStartLedger) {
    throw new EventCompletenessError(
      `provider latestLedger ${String(latestLedger)} is behind requested startLedger ${String(requestStartLedger)}`,
    );
  }

  let previousId: string | null = null;
  for (const raw of events) {
    if (typeof raw !== "object" || raw === null) {
      throw new EventCompletenessError("event entry is not an object");
    }
    const candidate = raw as { readonly id?: unknown; readonly ledger?: unknown };
    if (typeof candidate.id !== "string" || candidate.id.length === 0) {
      throw new EventCompletenessError("event is missing a string id");
    }
    if (typeof candidate.ledger !== "number" || !Number.isSafeInteger(candidate.ledger)) {
      throw new EventCompletenessError(`event ${candidate.id} has invalid ledger`);
    }

    const eventPos = parseEventCursor(candidate.id);
    if (eventPos.completesLedger) {
      throw new EventCompletenessError(`event ${candidate.id} carries end-of-window index`);
    }
    if (eventPos.ledger !== candidate.ledger) {
      throw new EventCompletenessError(
        `event ${candidate.id} ledger ${String(eventPos.ledger)} disagrees with event.ledger ${String(candidate.ledger)}`,
      );
    }
    if (candidate.ledger > latestLedger || (oldestLedger > 0 && candidate.ledger < oldestLedger)) {
      throw new EventCompletenessError(
        `event ${candidate.id} at ledger ${String(candidate.ledger)} falls outside provider range ${String(oldestLedger)}..${String(latestLedger)}`,
      );
    }
    if (requestStartLedger !== undefined && candidate.ledger < requestStartLedger) {
      throw new EventCompletenessError(
        `event ${candidate.id} at ledger ${String(candidate.ledger)} precedes startLedger ${String(requestStartLedger)}`,
      );
    }
    if (requestEndLedger !== undefined && candidate.ledger >= requestEndLedger) {
      throw new EventCompletenessError(
        `event ${candidate.id} at ledger ${String(candidate.ledger)} meets or exceeds endLedger ${String(requestEndLedger)}`,
      );
    }
    if (requestCursor !== undefined && compareEventCursors(requestCursor, candidate.id) >= 0) {
      throw new EventCompletenessError(
        `event ${candidate.id} is not strictly after requested cursor ${requestCursor}`,
      );
    }
    if (previousId !== null && compareEventCursors(previousId, candidate.id) >= 0) {
      throw new EventCompletenessError(
        `events are out of order: ${previousId} followed by ${candidate.id}`,
      );
    }
    previousId = candidate.id;
  }

  if (cursor === null) {
    return { position: null, through: null };
  }

  const position = parseEventCursor(cursor);
  if (requestCursor !== undefined && compareEventCursors(requestCursor, cursor) >= 0) {
    throw new EventCompletenessError(
      `returned cursor ${cursor} did not advance past requested cursor ${requestCursor}`,
    );
  }
  if (previousId !== null && compareEventCursors(previousId, cursor) > 0) {
    throw new EventCompletenessError(
      `returned cursor ${cursor} precedes last event ${previousId}`,
    );
  }
  if (events.length === 0 && !position.completesLedger) {
    throw new EventCompletenessError(
      `empty page returned mid-ledger cursor ${cursor} instead of an end-of-window marker`,
    );
  }

  const through = completeThrough(position);
  if (through > latestLedger) {
    throw new EventCompletenessError(
      `cursor ${cursor} claims complete through ${String(through)} past latestLedger ${String(latestLedger)}`,
    );
  }
  if (requestEndLedger !== undefined && position.completesLedger && position.ledger >= requestEndLedger) {
    throw new EventCompletenessError(
      `end marker ${cursor} at ledger ${String(position.ledger)} exceeds exclusive endLedger ${String(requestEndLedger)}`,
    );
  }

  return { position, through };
}

export interface AdaptiveWindowConfig {
  readonly minLedgers: number;
  readonly maxLedgers: number;
  readonly targetDurationMs: number;
  readonly fastDurationMs: number;
}

export const DEFAULT_ADAPTIVE_WINDOW_CONFIG: AdaptiveWindowConfig = {
  minLedgers: MIN_SCAN_WINDOW_LEDGERS,
  maxLedgers: SCAN_WINDOW_LEDGERS,
  targetDurationMs: 2_000,
  fastDurationMs: 500,
};

export interface WindowSample {
  readonly currentLedgers: number;
  readonly eventCount: number;
  readonly pageLimit: number;
  readonly elapsedMs: number;
}

/**
 * Adjust the next requested ledger window based on provider response size and elapsed time.
 * Always clamped to `[config.minLedgers, config.maxLedgers]`.
 */
export function nextScanWindowLedgers(
  sample: WindowSample,
  config: AdaptiveWindowConfig = DEFAULT_ADAPTIVE_WINDOW_CONFIG,
): number {
  const current = Math.min(config.maxLedgers, Math.max(config.minLedgers, sample.currentLedgers));
  const saturated = sample.pageLimit > 0 && sample.eventCount >= sample.pageLimit;
  const slow = sample.elapsedMs > config.targetDurationMs;

  if (saturated || slow) {
    return Math.max(config.minLedgers, Math.floor(current / 2));
  }

  const sparse = sample.pageLimit > 0 && sample.eventCount <= Math.floor(sample.pageLimit / 4);
  const fast = sample.elapsedMs <= config.fastDurationMs;
  if (sparse && fast) {
    return Math.min(config.maxLedgers, current * 2);
  }

  return current;
}
