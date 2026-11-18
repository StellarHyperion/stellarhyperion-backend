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

export class EventCursorError extends Error {
  constructor(cursor: string, reason: string) {
    super(`event cursor ${JSON.stringify(cursor)} ${reason}`);
    this.name = "EventCursorError";
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
function parseEventCursorParts(
  cursor: string,
): CursorPosition & { readonly toid: bigint; readonly eventIndex: number } {
  const parts = cursor.split("-");
  const [toidText, indexText] = parts;
  if (parts.length !== 2 || toidText === undefined || indexText === undefined) {
    throw new EventCursorError(cursor, "is not a toid and an event index separated by a dash");
  }
  if (!/^\d+$/.test(toidText) || !/^\d+$/.test(indexText)) {
    throw new EventCursorError(cursor, "has a non numeric part");
  }

  const toid = BigInt(toidText);
  if (toid >= 1n << 64n) throw new EventCursorError(cursor, "exceeds wire limits");
  const ledger = Number(toid >> 32n);
  if (!Number.isSafeInteger(ledger)) {
    throw new EventCursorError(cursor, "names a ledger too large to be real");
  }
  const eventIndex = Number(indexText);
  if (!Number.isSafeInteger(eventIndex) || eventIndex < 0 || eventIndex > END_OF_WINDOW_INDEX)
    throw new EventCursorError(cursor, "invalid event index");
  return { ledger, completesLedger: eventIndex === END_OF_WINDOW_INDEX, toid, eventIndex };
}

export function parseEventCursor(cursor: string): CursorPosition {
  const { ledger, completesLedger } = parseEventCursorParts(cursor);
  return { ledger, completesLedger };
}
export class EventCompletenessError extends Error {
  constructor(reason: string) {
    super(`event source completeness check failed: ${reason}`);
    this.name = "EventCompletenessError";
  }
}
export const MIN_SCAN_WINDOW_LEDGERS = 100;

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
export function completeThrough(position: CursorPosition): number {
  return position.completesLedger ? position.ledger : position.ledger - 1;
}

export interface LedgerRange {
  readonly oldestLedger: number;
  readonly latestLedger: number;
}

/**
 * Extract the retained `[oldestLedger, latestLedger]` bounds from a Soroban RPC range refusal.
 *
 * Returns null when the message does not carry two integers in that shape.
 */
export function parseLedgerRangeError(message: string): LedgerRange | null {
  const match = /ledger range[^0-9]*(\d+)\s*-\s*(\d+)/i.exec(message);
  if (match === null) return null;
  const oldestLedger = Number(match[1]);
  const latestLedger = Number(match[2]);
  if (
    !Number.isSafeInteger(oldestLedger) ||
    !Number.isSafeInteger(latestLedger) ||
    oldestLedger < 0 ||
    latestLedger < oldestLedger
  ) {
    return null;
  }
  return { oldestLedger, latestLedger };
}

/**
 * Compute the inclusive end ledger for one bounded backfill step.
 */
export function boundedWindowEnd(fromLedger: number, toLedger: number, maxLedgers: number): number {
  if (!Number.isInteger(fromLedger) || fromLedger < 0) {
    throw new RangeError(`fromLedger must be a non-negative integer, got ${String(fromLedger)}`);
  }
  if (!Number.isInteger(toLedger) || toLedger < fromLedger) {
    throw new RangeError(
      `toLedger must be an integer >= fromLedger (${String(fromLedger)}), got ${String(toLedger)}`,
    );
  }
  if (!Number.isInteger(maxLedgers) || maxLedgers <= 0) {
    throw new RangeError(`maxLedgers must be a positive integer, got ${String(maxLedgers)}`);
  }
  return Math.min(toLedger, fromLedger + maxLedgers - 1);
}

/**
 * The inclusive upper ledger bound a single `getEvents` scan window can cover.
 *
 * Fresh `startLedger` requests scan `SCAN_WINDOW_LEDGERS` ledgers; cursor-resumed requests scan
 * `SCAN_WINDOW_LEDGERS - 1` due to the RPC's off-by-one range arithmetic. Clamped to
 * `latestLedger` when the head is closer.
 */
export function computeScanWindowEnd(
  fromLedger: number,
  fresh: boolean,
  latestLedger: number,
): number {
  const width = fresh ? SCAN_WINDOW_LEDGERS : SCAN_WINDOW_LEDGERS - 1;
  return Math.max(fromLedger, Math.min(fromLedger + width - 1, latestLedger));
}

/** Whether `ledger` falls inside the RPC's retained `[oldestLedger, latestLedger]` range. */
export function isWithinRetentionWindow(
  ledger: number,
  oldestLedger: number,
  latestLedger: number,
): boolean {
  return ledger >= oldestLedger && ledger <= latestLedger;
}

/** Verify range and event ordering before treating a provider cursor as completion. */
export function validateRangePage(
  page: {
    readonly oldestLedger: number;
    readonly latestLedger: number;
    readonly cursor: string | null;
    readonly events: readonly unknown[];
  },
  from: number,
  end: number | undefined,
  requestedCursor?: string,
): void {
  if (
    !Number.isSafeInteger(page.oldestLedger) ||
    !Number.isSafeInteger(page.latestLedger) ||
    page.oldestLedger < 0 ||
    page.latestLedger < from ||
    page.oldestLedger > from
  ) {
    throw new Error("provider cannot verify the requested retained range");
  }
  const order = (id: string): bigint => {
    const parts = id.split("-");
    if (parts.length !== 2 || !parts.every((part) => /^\d+$/.test(part)))
      throw new Error("invalid event cursor");
    const toid = BigInt(parts[0] ?? "");
    const index = BigInt(parts[1] ?? "");
    if (toid >= 1n << 64n || index >= 1n << 32n)
      throw new Error("event cursor exceeds wire limits");
    return (toid << 32n) + index;
  };
  let previous = requestedCursor === undefined ? -1n : order(requestedCursor);
  for (const input of page.events) {
    const raw = input as { id: string; ledger: number };
    const pos = parseEventCursor(raw.id);
    const current = order(raw.id);
    if (
      current <= previous ||
      pos.completesLedger ||
      pos.ledger !== raw.ledger ||
      raw.ledger < from ||
      raw.ledger > page.latestLedger ||
      (end !== undefined && raw.ledger > end)
    ) {
      throw new Error("provider returned unordered events or an unverifiable ledger");
    }
    previous = current;
  }
  if (page.cursor === null) return;
  const terminal = parseEventCursor(page.cursor);
  const cursorOrder = order(page.cursor);
  if (
    cursorOrder < previous ||
    terminal.ledger > page.latestLedger ||
    (end !== undefined && terminal.ledger > end) ||
    (page.events.length === 0 && !terminal.completesLedger)
  ) {
    throw new Error("provider returned an unverifiable terminal cursor");
  }
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
    throw new EventCompletenessError(`returned cursor ${cursor} precedes last event ${previousId}`);
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
  if (
    requestEndLedger !== undefined &&
    position.completesLedger &&
    position.ledger >= requestEndLedger
  ) {
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
