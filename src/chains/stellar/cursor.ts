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

export class EventSourceCompletenessError extends Error {
  constructor(reason: string) {
    super(`stellar event source completeness check failed: ${reason}`);
    this.name = "EventSourceCompletenessError";
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
export function parseEventCursor(cursor: string): CursorPosition {
  const parts = cursor.split("-");
  const [toidText, indexText] = parts;
  if (parts.length !== 2 || toidText === undefined || indexText === undefined) {
    throw new EventCursorError(cursor, "is not a toid and an event index separated by a dash");
  }
  if (!/^\d+$/.test(toidText) || !/^\d+$/.test(indexText)) {
    throw new EventCursorError(cursor, "has a non numeric part");
  }
  if ((toidText.length !== 19 && toidText.length !== 20) || indexText.length !== 10) {
    throw new EventCursorError(cursor, "does not match canonical padded cursor width");
  }

  const toid = BigInt(toidText);
  const index = BigInt(indexText);
  if (index > BigInt(END_OF_WINDOW_INDEX)) {
    throw new EventCursorError(cursor, "has an event index exceeding uint32 bounds");
  }
  const ledger = Number(toid >> 32n);
  if (!Number.isSafeInteger(ledger)) {
    throw new EventCursorError(cursor, "names a ledger too large to be real");
  }
  const completesLedger = Number(index) === END_OF_WINDOW_INDEX;
  if (completesLedger && cursor !== endOfLedgerCursor(ledger)) {
    throw new EventCursorError(
      cursor,
      "carries the end-of-window index without the end-of-ledger toid boundary",
    );
  }
  return { ledger, completesLedger };
}

export function compareEventCursors(left: string, right: string): -1 | 0 | 1 {
  parseEventCursor(left);
  parseEventCursor(right);
  const [leftToidText, leftIndexText] = left.split("-");
  const [rightToidText, rightIndexText] = right.split("-");
  const leftToid = BigInt(leftToidText ?? "0");
  const rightToid = BigInt(rightToidText ?? "0");
  if (leftToid !== rightToid) {
    return leftToid < rightToid ? -1 : 1;
  }
  const leftIndex = BigInt(leftIndexText ?? "0");
  const rightIndex = BigInt(rightIndexText ?? "0");
  if (leftIndex === rightIndex) return 0;
  return leftIndex < rightIndex ? -1 : 1;
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
export function completeThrough(position: CursorPosition): number {
  return position.completesLedger ? position.ledger : position.ledger - 1;
}

export interface RawEventEnvelope {
  readonly id: string;
  readonly ledger: number;
  readonly contractId: string;
  readonly type: string;
  readonly txHash: string;
  readonly ledgerClosedAt: string;
}

export interface ValidatedEventsPage<TEvent extends RawEventEnvelope = RawEventEnvelope> {
  readonly events: readonly TEvent[];
  readonly cursor: string;
  readonly candidateThrough: number;
  readonly repeatedTerminalMarker: boolean;
}

function isEnvelope(value: unknown): value is RawEventEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.ledger === "number" &&
    typeof record.contractId === "string" &&
    typeof record.type === "string" &&
    typeof record.txHash === "string" &&
    typeof record.ledgerClosedAt === "string"
  );
}

/**
 * Validate provider ledger metadata, event ordering, contract identity, and completion markers
 * before accepting a page or advancing a scan boundary.
 */
export function validateEventsPageCompleteness<TEvent extends RawEventEnvelope = RawEventEnvelope>(
  page: {
    readonly events: readonly unknown[];
    readonly cursor: string | null;
    readonly latestLedger: number;
    readonly oldestLedger: number;
  },
  context: {
    readonly expectedContract: string;
    readonly query: {
      readonly startLedger?: number;
      readonly cursor?: string;
      readonly limit: number;
    };
  },
): ValidatedEventsPage<TEvent> {
  if (
    !Number.isSafeInteger(page.latestLedger) ||
    !Number.isSafeInteger(page.oldestLedger) ||
    page.latestLedger < 0 ||
    page.oldestLedger < 0 ||
    page.oldestLedger > page.latestLedger
  ) {
    throw new EventSourceCompletenessError(
      `invalid provider ledger bounds oldest=${String(page.oldestLedger)} latest=${String(page.latestLedger)}`,
    );
  }

  if (context.query.startLedger !== undefined && context.query.startLedger > page.latestLedger) {
    throw new EventSourceCompletenessError(
      `requested startLedger ${String(context.query.startLedger)} exceeds provider latestLedger ${String(page.latestLedger)}`,
    );
  }

  if (page.events.length > context.query.limit) {
    throw new EventSourceCompletenessError(
      `provider returned ${String(page.events.length)} events exceeding requested limit ${String(context.query.limit)}`,
    );
  }

  if (page.cursor === null) {
    throw new EventSourceCompletenessError("provider response omitted completion cursor");
  }

  let parsedPageCursor: CursorPosition;
  try {
    parsedPageCursor = parseEventCursor(page.cursor);
  } catch (error) {
    throw new EventSourceCompletenessError(error instanceof Error ? error.message : String(error));
  }

  if (parsedPageCursor.ledger > page.latestLedger) {
    throw new EventSourceCompletenessError(
      `page cursor ledger ${String(parsedPageCursor.ledger)} exceeds provider latestLedger ${String(page.latestLedger)}`,
    );
  }

  let minLedger = 0;
  if (context.query.cursor !== undefined) {
    const requestedPos = parseEventCursor(context.query.cursor);
    const cursorCmp = compareEventCursors(page.cursor, context.query.cursor);
    if (cursorCmp < 0) {
      throw new EventSourceCompletenessError(
        `page cursor ${page.cursor} regressed behind requested cursor ${context.query.cursor}`,
      );
    }
    if (cursorCmp === 0) {
      if (page.events.length > 0) {
        throw new EventSourceCompletenessError(
          `repeated cursor ${page.cursor} accompanied non-empty events page`,
        );
      }
      return {
        events: [],
        cursor: page.cursor,
        candidateThrough: completeThrough(parsedPageCursor),
        repeatedTerminalMarker: true,
      };
    }
    minLedger = requestedPos.completesLedger ? requestedPos.ledger + 1 : requestedPos.ledger;
  } else if (context.query.startLedger !== undefined) {
    minLedger = context.query.startLedger;
    if (parsedPageCursor.ledger < minLedger) {
      throw new EventSourceCompletenessError(
        `page cursor ledger ${String(parsedPageCursor.ledger)} precedes startLedger ${String(minLedger)}`,
      );
    }
  }

  const verifiedEvents: TEvent[] = [];
  let previousEventCursor: string | null = context.query.cursor ?? null;

  for (const raw of page.events) {
    if (!isEnvelope(raw)) {
      throw new EventSourceCompletenessError("provider returned malformed event envelope");
    }
    if (raw.contractId !== context.expectedContract) {
      throw new EventSourceCompletenessError(
        `event ${raw.id} belongs to unexpected contract ${raw.contractId}`,
      );
    }

    let eventCursorPos: CursorPosition;
    try {
      eventCursorPos = parseEventCursor(raw.id);
    } catch (error) {
      throw new EventSourceCompletenessError(
        `invalid event id ${JSON.stringify(raw.id)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (eventCursorPos.completesLedger) {
      throw new EventSourceCompletenessError(
        `event ${raw.id} illegally carries end-of-window index`,
      );
    }
    if (eventCursorPos.ledger !== raw.ledger) {
      throw new EventSourceCompletenessError(
        `event ${raw.id} encodes ledger ${String(eventCursorPos.ledger)} while envelope reports ${String(raw.ledger)}`,
      );
    }
    if (raw.ledger < minLedger || raw.ledger > page.latestLedger) {
      throw new EventSourceCompletenessError(
        `event ${raw.id} at ledger ${String(raw.ledger)} falls outside [${String(minLedger)}, ${String(page.latestLedger)}]`,
      );
    }
    if (previousEventCursor !== null && compareEventCursors(raw.id, previousEventCursor) <= 0) {
      throw new EventSourceCompletenessError(
        `event ${raw.id} is not strictly ordered after ${previousEventCursor}`,
      );
    }

    previousEventCursor = raw.id;
    verifiedEvents.push(raw as TEvent);
  }

  const lastEvent = verifiedEvents[verifiedEvents.length - 1];
  if (lastEvent !== undefined && compareEventCursors(page.cursor, lastEvent.id) < 0) {
    throw new EventSourceCompletenessError(
      `page cursor ${page.cursor} precedes final event ${lastEvent.id}`,
    );
  }

  if (!parsedPageCursor.completesLedger) {
    if (verifiedEvents.length < context.query.limit) {
      throw new EventSourceCompletenessError(
        `truncated mid-ledger page returned ${String(verifiedEvents.length)} of ${String(context.query.limit)} events without an end-of-window marker`,
      );
    }
    if (lastEvent?.id !== page.cursor) {
      throw new EventSourceCompletenessError(
        `mid-ledger page cursor ${page.cursor} does not match final event id ${lastEvent?.id ?? "none"}`,
      );
    }
  }

  return {
    events: verifiedEvents,
    cursor: page.cursor,
    candidateThrough: completeThrough(parsedPageCursor),
    repeatedTerminalMarker: false,
  };
}
