/**
 * A Soroban RPC that behaves the way the real one was measured to behave.
 *
 * The point of this file is that the fake implements the awkward parts rather than the convenient
 * ones. A fake that scanned to the head on every call, or that returned a cursor pointing at the
 * last event it happened to return, would let the watcher pass its tests and stall against a real
 * node. So this one reproduces, from the probes recorded in `src/chains/stellar/cursor.ts`:
 *
 *   - a ten thousand ledger scan window, which is why an empty page still advances
 *   - 9999 ledgers for a cursor-resumed request rather than 10000, the real off-by-one
 *   - an end-of-window cursor with event index 0xFFFFFFFF when the window runs out first, and the
 *     last event's own id when the page fills first
 *   - the window clamped to the head, so arriving at the head reports a cursor at the head
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import pino, { type Logger } from "pino";

import type { RawStellarEvent } from "../src/chains/stellar/events.js";
import type { EventsPage, EventsQuery, LatestLedger } from "../src/chains/stellar/rpc.js";
import { StellarRpcError } from "../src/chains/stellar/rpc.js";
import type { Queryable, QueryResultRows, Transactional } from "../src/db/pool.js";
import { FIXTURES_DIR } from "./helpers.js";

/** Matches the real node's default. A request outside it is refused rather than served short. */
const RETENTION_LEDGERS = 120_960;
const START_WINDOW = 10_000;
const CURSOR_WINDOW = 9_999;
const END_OF_WINDOW_INDEX = 4_294_967_295;

export const ROUTER_HISTORY: readonly RawStellarEvent[] = JSON.parse(
  readFileSync(join(FIXTURES_DIR, "stellar-router-history.json"), "utf8"),
) as RawStellarEvent[];

/** The router's real deployment and the ledger its first event actually landed in. */
export const LIVE_ROUTER = "CDMOLDF4SJDEDRWTDF7XAYMSRE6L3YEHHIRF57CFWNQYNC6ZOZ5LWCWF";

export function toid(ledger: number, txIndex = 0, opIndex = 0): bigint {
  return (BigInt(ledger) << 32n) | (BigInt(txIndex) << 20n) | BigInt(opIndex);
}

function idOf(toidValue: bigint, eventIndex: number): string {
  return `${toidValue.toString().padStart(19, "0")}-${String(eventIndex).padStart(10, "0")}`;
}

/** An event with just enough shape to be indexed, for the cases a captured one cannot express. */
export function syntheticEvent(
  overrides: Partial<RawStellarEvent> & { readonly ledger: number },
): RawStellarEvent {
  const ledger = overrides.ledger;
  return {
    type: "contract",
    ledgerClosedAt: new Date(Date.UTC(2026, 9, 1) + ledger * 5000).toISOString(),
    contractId: LIVE_ROUTER,
    id: idOf(toid(ledger), 0),
    txHash: `tx-${String(ledger)}`,
    operationIndex: 0,
    transactionIndex: 0,
    inSuccessfulContractCall: true,
    // `config` is a tag the decoder knows and ignores, so it exercises the loop without needing
    // a whole event body.
    topicJson: [{ symbol: "hyperion" }, { symbol: "config" }],
    valueJson: { map: [] },
    ...overrides,
  };
}

export interface FakeRpcOptions {
  readonly events?: readonly RawStellarEvent[];
  readonly latestLedger?: number;
  /**
   * Report this as `oldestLedger` while still serving the request.
   *
   * Not a contrivance. Probing testnet twice in a row returned oldestLedger 4872997 and then
   * refused a request for it as outside "4873028 - 4993987", so the window genuinely moves between
   * a response and the next request. This is how a test reaches the watcher's gap report without
   * the refusal firing first.
   */
  readonly oldestLedger?: number;
}

export class FakeRpc {
  readonly requests: EventsQuery[] = [];
  private readonly log: readonly RawStellarEvent[];
  private head: number;

  private readonly oldestOverride: number | null;

  constructor(options: FakeRpcOptions = {}) {
    this.log = [...(options.events ?? [])].sort((a, b) => a.id.localeCompare(b.id));
    const highest = this.log.reduce((max, event) => Math.max(max, event.ledger), 0);
    this.head = options.latestLedger ?? highest + 1;
    this.oldestOverride = options.oldestLedger ?? null;
  }

  get latest(): number {
    return this.head;
  }

  advanceHeadTo(ledger: number): void {
    this.head = ledger;
  }

  latestLedger(): Promise<LatestLedger> {
    return Promise.resolve({ sequence: this.head, closeTime: 0, protocolVersion: 29 });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async events(query: EventsQuery): Promise<EventsPage> {
    this.requests.push(query);
    const oldest = Math.max(this.head - RETENTION_LEDGERS, 1);

    let from: number;
    let after: string | null = null;
    if (query.cursor !== undefined) {
      after = query.cursor;
      const cursorLedger = Number(BigInt(query.cursor.split("-")[0] ?? "0") >> 32n);
      from = cursorLedger;
      if (cursorLedger < oldest) {
        throw new StellarRpcError(
          "getEvents",
          `startLedger must be within the ledger range: ${String(oldest)} - ${String(this.head)}`,
          false,
        );
      }
    } else {
      from = query.startLedger ?? 0;
      if (from < oldest || from > this.head) {
        throw new StellarRpcError(
          "getEvents",
          `startLedger must be within the ledger range: ${String(oldest)} - ${String(this.head)}`,
          false,
        );
      }
    }

    const width = query.cursor === undefined ? START_WINDOW : CURSOR_WINDOW;
    const windowEnd = Math.min(from + width - 1, this.head);

    const inWindow = this.log.filter((event) => {
      if (event.ledger > windowEnd) return false;
      if (after !== null) return event.id > after;
      return event.ledger >= from;
    });

    const page = inWindow.slice(0, query.limit);
    const filled = page.length === query.limit && inWindow.length > page.length;
    const last = page[page.length - 1];
    // A page that filled before the window ran out reports the last event's own id. One that ran
    // out of window first reports the end-of-window marker, which is what lets an empty page
    // still advance a cursor.
    const cursor =
      filled && last !== undefined
        ? last.id
        : idOf(((BigInt(windowEnd) + 1n) << 32n) - 1n, END_OF_WINDOW_INDEX);

    return {
      events: page,
      cursor,
      latestLedger: this.head,
      oldestLedger: this.oldestOverride ?? oldest,
    };
  }
}

export interface RecordedQuery {
  readonly text: string;
  readonly params: readonly unknown[];
  /** Null outside a transaction, otherwise which transaction it belonged to. */
  readonly transaction: number | null;
}

/**
 * A database that answers the cursor read and remembers everything else.
 *
 * Deliberately not an in-memory Postgres. What the watcher tests need to see is which statements
 * ran, with which parameters, and whether they were inside the same transaction as the cursor
 * advance, and all three of those are things a real pool cannot be asked about afterwards.
 */
export class RecordingDb implements Transactional {
  readonly queries: RecordedQuery[] = [];
  readonly commits: number[] = [];
  readonly rollbacks: number[] = [];
  cursorRow: Record<string, unknown> | null = null;
  /** Set to make every statement inside the next transaction throw. */
  failInTransaction: Error | null = null;

  private open: number | null = null;
  private transactions = 0;

  query(text: string, params: readonly unknown[] = []): Promise<QueryResultRows> {
    this.queries.push({ text, params, transaction: this.open });
    if (this.failInTransaction !== null && this.open !== null) {
      return Promise.reject(this.failInTransaction);
    }
    if (text.includes("FROM indexer_cursor")) {
      return Promise.resolve({
        rows: this.cursorRow === null ? [] : [this.cursorRow],
        rowCount: 1,
      });
    }
    // Zero rows affected, which is what makes `recordClaimSettled` report an unmatched settlement.
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    const id = ++this.transactions;
    this.open = id;
    try {
      const value = await work(this);
      this.commits.push(id);
      return value;
    } catch (error) {
      this.rollbacks.push(id);
      throw error;
    } finally {
      this.open = null;
    }
  }

  /** Statements matching a fragment, which is how a test names the one it cares about. */
  matching(fragment: string): readonly RecordedQuery[] {
    return this.queries.filter((entry) => entry.text.includes(fragment));
  }
}

/** A logger that records instead of printing, so a failing test shows the lines it meant to. */
export interface CapturedLog {
  readonly level: string;
  readonly message: string;
}

export function capturingLogger(): { logger: Logger; lines: CapturedLog[] } {
  const lines: CapturedLog[] = [];
  const logger = pino(
    { level: "trace" },
    {
      write(line: string) {
        const parsed = JSON.parse(line) as { level: number; msg: string };
        lines.push({ level: String(parsed.level), message: parsed.msg });
      },
    },
  );
  return { logger, lines };
}
