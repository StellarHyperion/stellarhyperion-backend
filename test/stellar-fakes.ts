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
    const windowEnd = Math.min(
      from + width - 1,
      this.head,
      query.endLedger === undefined ? this.head : query.endLedger - 1,
    );

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
  leaseRow: { owner_id: string; lease_until: Date } | null = null;
  readonly gaps: {
    id: bigint;
    chain_key: string;
    contract: string;
    start_ledger: string;
    end_ledger: string;
    status: "open" | "reconciling" | "reconciled";
    replayed_through: string | null;
    reason: string;
    detected_at: Date;
    reconciled_at: Date | null;
  }[] = [];
  backfillRow: Record<string, unknown> | null = null;
  readonly heartbeatRows: Record<string, unknown>[] = [];
  readonly workerRuns: Record<string, unknown>[] = [];
  /** Set to make every statement inside the next transaction throw. */
  failInTransaction: Error | null = null;
  /** What the open ingestion rejection count reports, to exercise the boundary limit. */
  openRejections = 0;
  /** Source events recorded so far; each insert is treated as a first observation. */
  sourceEvents = 0;

  private identities = new Map<string, unknown>();
  private conflicts = new Map<string, unknown>();
  private journals: unknown[] = [];

  private open: number | null = null;
  private transactions = 0;
  private nextGapId = 1n;

  query(text: string, params: readonly unknown[] = []): Promise<QueryResultRows> {
    this.queries.push({ text, params, transaction: this.open });
    if (this.failInTransaction !== null && this.open !== null) {
      return Promise.reject(this.failInTransaction);
    }
    if (/INSERT INTO source_event\s*\(/.test(text)) {
      this.sourceEvents += 1;
      return Promise.resolve({ rows: [{ id: String(this.sourceEvents) }], rowCount: 1 });
    }
    if (text.includes("AS open FROM ingestion_rejection")) {
      return Promise.resolve({ rows: [{ open: this.openRejections }], rowCount: 1 });
    }
    if (text.includes("INSERT INTO indexer_worker_run")) {
      const previous = this.workerRuns.find((row) => row.run_id === params[0]);
      const row = {
        run_id: params[0],
        execution_id: params[1],
        worker_name: params[2],
        worker_kind: params[3],
        chain_key: params[4],
        state: params[5],
        successful_ticks: String(Number(previous?.successful_ticks ?? 0) + Number(params[6])),
        failed_ticks: String(Number(previous?.failed_ticks ?? 0) + Number(params[7])),
        started_at: previous?.started_at ?? new Date(),
        updated_at: new Date(),
        last_caught_up_at:
          params[5] === "caught_up" ? new Date() : (previous?.last_caught_up_at ?? null),
        stopped_at: params[5] === "stopped" ? new Date() : null,
        stellar_scans: 0,
        evm_scans: 0,
        verification_transitions: 0,
      };
      if (previous !== undefined) Object.assign(previous, row);
      else this.workerRuns.push(row);
      return Promise.resolve({ rows: [{ run_id: params[0] }], rowCount: 1 });
    }
    if (text.includes("FROM indexer_worker_run r"))
      return Promise.resolve({ rows: this.workerRuns, rowCount: this.workerRuns.length });
    if (text.includes("/* historical_coverage_snapshot */")) {
      // This fake records gap state but does not model committed source coverage.
      const count = (status: string) =>
        String(this.gaps.filter((gap) => gap.status === status).length);
      return Promise.resolve({
        rows: [
          {
            snapshot: {
              historyGaps: {
                open: count("open"),
                reconciling: count("reconciling"),
                reconciled: count("reconciled"),
              },
              sources: [],
            },
          },
        ],
        rowCount: 1,
      });
    }
    if (text.includes("FROM indexer_cursor")) {
      return Promise.resolve({
        rows: this.cursorRow === null ? [] : [this.cursorRow],
        rowCount: this.cursorRow === null ? 0 : 1,
      });
    }
    if (text.includes("FROM indexer_worker_heartbeat")) {
      return Promise.resolve({
        rows: this.heartbeatRows,
        rowCount: this.heartbeatRows.length,
      });
    }
    if (text.includes("INSERT INTO indexer_worker_heartbeat")) {
      const workerName = String(params[0]);
      const existing = this.heartbeatRows.find((r) => r.worker_name === workerName);
      const row: Record<string, unknown> = {
        worker_name: workerName,
        worker_kind: String(params[1]),
        chain_key: params[2] ?? null,
        state: String(params[3]),
        detail: String(params[4]),
        last_heartbeat_at: params[5],
        last_completed_at: params[6] ?? existing?.last_completed_at ?? null,
        last_cursor_block: params[7] ?? existing?.last_cursor_block ?? null,
        consecutive_failures: Number(params[8]),
        last_error: params[9] ?? null,
        metadata: typeof params[10] === "string" ? JSON.parse(params[10]) : (params[10] ?? {}),
      };
      if (existing !== undefined) {
        Object.assign(existing, row);
      } else {
        this.heartbeatRows.push(row);
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    if (text.includes("INSERT INTO indexer_cursor") || text.includes("UPDATE indexer_cursor")) {
      if (text.includes("ON CONFLICT (chain_key) DO NOTHING")) {
        if (this.cursorRow !== null) {
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        this.cursorRow = {
          last_processed: String(params[3]),
          contract: String(params[2]),
          last_processed_at: params[4] ?? null,
          last_processed_hash: params[5] ?? null,
          revision: "1",
          deployment_revision: Number(params[6] ?? 1),
        };
        return Promise.resolve({ rows: [{ revision: "1" }], rowCount: 1 });
      }
      if (
        text.includes("WHERE indexer_cursor.revision =") ||
        text.includes("WHERE chain_key = $1 AND revision =")
      ) {
        const expected = asText(params[6]);
        const current = this.cursorRow === null ? null : asText(this.cursorRow.revision, "1");
        if (current === null || current !== expected) {
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        const nextRev = String(BigInt(current) + 1n);
        this.cursorRow = {
          last_processed: asText(params[3]),
          contract: asText(params[2]),
          last_processed_at: params[4] ?? null,
          last_processed_hash: params[5] ?? null,
          revision: nextRev,
          deployment_revision: Number(params[7] ?? this.cursorRow?.deployment_revision ?? 1),
        };
        return Promise.resolve({ rows: [{ revision: nextRev }], rowCount: 1 });
      }
      const nextRev =
        this.cursorRow === null ? "1" : String(BigInt(asText(this.cursorRow.revision, "1")) + 1n);
      this.cursorRow = {
        last_processed: String(params[3]),
        contract: String(params[2]),
        last_processed_at: params[4] ?? null,
        last_processed_hash: params[5] ?? null,
        revision: nextRev,
      };
      return Promise.resolve({ rows: [{ revision: nextRev }], rowCount: 1 });
    }
    if (text.includes("INSERT INTO indexer_lease")) {
      const ownerId = String(params[2]);
      const ttlMs = Number(params[3]);
      const now = Date.now();
      if (
        this.leaseRow !== null &&
        this.leaseRow.lease_until.getTime() > now &&
        this.leaseRow.owner_id !== ownerId
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      this.leaseRow = { owner_id: ownerId, lease_until: new Date(now + ttlMs) };
      return Promise.resolve({ rows: [this.leaseRow], rowCount: 1 });
    }
    if (text.includes("UPDATE indexer_lease")) {
      const ownerId = String(params[2]);
      const ttlMs = params[3] === null || params[3] === undefined ? null : Number(params[3]);
      const now = Date.now();
      if (this.leaseRow?.owner_id !== ownerId || this.leaseRow.lease_until.getTime() <= now) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (ttlMs !== null) {
        this.leaseRow = { owner_id: ownerId, lease_until: new Date(now + ttlMs) };
      }
      return Promise.resolve({ rows: [{ owner_id: ownerId }], rowCount: 1 });
    }
    if (text.includes("DELETE FROM indexer_lease")) {
      const ownerId = asText(params[2]);
      if (this.leaseRow?.owner_id === ownerId) {
        this.leaseRow = null;
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (text.includes("INSERT INTO stellar_history_gap")) {
      const chainKey = String(params[0]);
      const contract = String(params[1]);
      const startLedger = String(params[2]);
      const endLedger = String(params[3]);
      const reason = String(params[4]);
      const existing = this.gaps.find(
        (g) =>
          g.chain_key === chainKey &&
          g.contract === contract &&
          g.start_ledger === startLedger &&
          g.end_ledger === endLedger,
      );
      if (existing === undefined) {
        this.gaps.push({
          id: this.nextGapId++,
          chain_key: chainKey,
          contract,
          start_ledger: startLedger,
          end_ledger: endLedger,
          status: "open",
          replayed_through: null,
          reason,
          detected_at: new Date(),
          reconciled_at: null,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    if (
      text.includes("SELECT count(*)::int AS count") &&
      text.includes("FROM stellar_history_gap")
    ) {
      const chainKey = asText(params[0]);
      const contract = params[1] === undefined ? undefined : asText(params[1]);
      const count = this.gaps.filter(
        (g) =>
          g.chain_key === chainKey &&
          (contract === undefined || g.contract === contract) &&
          g.status !== "reconciled",
      ).length;
      return Promise.resolve({ rows: [{ count }], rowCount: 1 });
    }
    if (text.includes("FROM stellar_history_gap")) {
      const chainKey = String(params[0]);
      const filtered = this.gaps.filter((g) => g.chain_key === chainKey);
      return Promise.resolve({ rows: filtered, rowCount: filtered.length });
    }
    if (text.includes("UPDATE stellar_history_gap")) {
      const id = BigInt(String(params[0]));
      const replayedThrough = String(params[1]);
      const reconciled = Boolean(params[2]);
      const target = this.gaps.find((g) => g.id === id);
      if (target !== undefined) {
        target.replayed_through = replayedThrough;
        target.status = reconciled ? "reconciled" : "reconciling";
        target.reconciled_at = reconciled ? new Date() : null;
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (text.includes("FROM stellar_backfill_cursor")) {
      return Promise.resolve({
        rows: this.backfillRow === null ? [] : [this.backfillRow],
        rowCount: this.backfillRow === null ? 0 : 1,
      });
    }
    if (text.includes("INSERT INTO stellar_backfill_cursor")) {
      if (this.backfillRow !== null) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      this.backfillRow = {
        chain_key: String(params[0]),
        contract: String(params[1]),
        job_key: String(params[2]),
        start_ledger: String(params[3]),
        end_ledger: String(params[4]),
        next_ledger: String(params[5]),
        status: String(params[6]),
        revision: "1",
      };
      return Promise.resolve({ rows: [{ revision: "1" }], rowCount: 1 });
    }
    if (text.includes("UPDATE stellar_backfill_cursor")) {
      const expected = asText(params[7]);
      const current = this.backfillRow === null ? null : asText(this.backfillRow.revision, "1");
      if (current === null || current !== expected) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      const nextRev = String(BigInt(current) + 1n);
      this.backfillRow = {
        chain_key: String(params[0]),
        contract: String(params[1]),
        job_key: String(params[2]),
        start_ledger: String(params[3]),
        end_ledger: String(params[4]),
        next_ledger: String(params[5]),
        status: String(params[6]),
        revision: nextRev,
      };
      return Promise.resolve({ rows: [{ revision: nextRev }], rowCount: 1 });
    }
    const key = JSON.stringify(
      typeof params[2] === "string" && !params[2].startsWith("event:")
        ? [params[0], params[2]]
        : params.slice(0, 3),
    );
    if (text.includes("INSERT INTO stellar_event_identity")) {
      if (!this.identities.has(key)) this.identities.set(key, JSON.parse(params[3] as string));
    } else if (text.includes("FROM stellar_event_identity")) {
      return Promise.resolve({ rows: [{ evidence: this.identities.get(key) }], rowCount: 1 });
    } else if (text.includes("INSERT INTO stellar_event_conflict")) {
      this.conflicts.set(key, JSON.parse(params[4] as string));
    } else if (text.includes("FROM stellar_event_conflict")) {
      return Promise.resolve({
        rows: [...this.conflicts.values()].map((evidence) => ({ evidence })),
        rowCount: this.conflicts.size,
      });
    } else if (text.includes("INSERT INTO stellar_scan_journal")) {
      this.journals.push(JSON.parse(params[2] as string));
    } else if (text.includes("FROM stellar_scan_journal")) {
      return Promise.resolve({
        rows: this.journals.map((journal) => ({ journal })),
        rowCount: this.journals.length,
      });
    }
    if (text.includes("INSERT INTO outbound_transfer")) {
      const origin_chain = asText(params[0]);
      const origin_router = asText(params[1]);
      const route = Number(params[2]);
      const nonce = BigInt(asText(params[3]));
      const sender = asText(params[4]);
      const token = asText(params[5]);
      const gross_amount = BigInt(asText(params[6]));
      const fee = BigInt(asText(params[7]));
      const net_amount = BigInt(asText(params[8]));
      const destination_chain = asText(params[9]);
      const destination = asText(params[10]);
      const rail_ref = params[11] === null || params[11] === undefined ? null : asText(params[11]);
      const origin_block = BigInt(asText(params[12]));
      const origin_tx = asText(params[13]);
      const origin_log_index =
        params[14] === null || params[14] === undefined ? null : Number(params[14]);
      const observed_at = params[15] instanceof Date ? params[15] : new Date(asText(params[15]));

      const existing = this.outboundTransfers.find(
        (t) =>
          t.origin_chain === origin_chain && t.origin_router === origin_router && t.nonce === nonce,
      );
      if (existing) {
        existing.route = route;
        existing.sender = sender;
        existing.token = token;
        existing.gross_amount = gross_amount;
        existing.fee = fee;
        existing.net_amount = net_amount;
        existing.destination_chain = destination_chain;
        existing.destination = destination;
        if (rail_ref !== null) existing.rail_ref = rail_ref;
        existing.origin_block = origin_block;
        existing.origin_tx = origin_tx;
        existing.origin_log_index = origin_log_index;
        return Promise.resolve({ rows: [{ id: existing.id.toString() }], rowCount: 1 });
      }
      const id = BigInt(this.outboundTransfers.length + 1);
      this.outboundTransfers.push({
        id,
        origin_chain,
        origin_router,
        route,
        nonce,
        sender,
        token,
        gross_amount,
        fee,
        net_amount,
        destination_chain,
        destination,
        rail_ref,
        origin_block,
        origin_tx,
        origin_log_index,
        observed_at,
      });
      return Promise.resolve({ rows: [{ id: id.toString() }], rowCount: 1 });
    }
    if (text.includes("INSERT INTO rail_attestation")) {
      const transfer_id = BigInt(asText(params[0]));
      const route = Number(params[1]);
      const status = asText(params[2]);
      const rail_status = params[3] === null || params[3] === undefined ? null : asText(params[3]);
      const rail_reference =
        params[4] === null || params[4] === undefined ? null : asText(params[4]);
      const attested_at =
        params[5] === null || params[5] === undefined
          ? null
          : params[5] instanceof Date
            ? params[5]
            : new Date(asText(params[5]));
      const last_checked_at =
        params[6] === null || params[6] === undefined
          ? null
          : params[6] instanceof Date
            ? params[6]
            : new Date(asText(params[6]));
      const check_failures = Number(params[7] ?? 0);
      const last_error = params[8] === null || params[8] === undefined ? null : asText(params[8]);
      const next_attempt_at =
        params[9] === null || params[9] === undefined
          ? null
          : params[9] instanceof Date
            ? params[9]
            : new Date(asText(params[9]));
      const retry_class =
        params[10] === null || params[10] === undefined ? null : asText(params[10]);
      const retry_attempts = Number(params[11] ?? 0);

      const existing = this.railAttestations.get(transfer_id);
      this.railAttestations.set(transfer_id, {
        transfer_id,
        route,
        status,
        rail_status: rail_status ?? existing?.rail_status ?? null,
        rail_reference: rail_reference ?? existing?.rail_reference ?? null,
        attested_at: existing?.attested_at ?? attested_at,
        last_checked_at,
        check_failures,
        last_error,
        next_attempt_at,
        retry_class,
        retry_attempts,
      });
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    if (
      text.includes("FROM outbound_transfer t") &&
      text.includes("LEFT JOIN rail_attestation a")
    ) {
      if (text.includes("SELECT count(*)::int AS n")) {
        const route = Number(params[0]);
        const matching = this.outboundTransfers.filter((t) => {
          if (t.route !== route) return false;
          const a = this.railAttestations.get(t.id);
          return a === undefined || a.status === "pending" || a.status === "attested";
        });
        return Promise.resolve({ rows: [{ n: matching.length }], rowCount: 1 });
      }

      const route = Number(params[0]);
      const maxCheckFailures = Number(params[1]);
      const now = params[2] instanceof Date ? params[2] : new Date(asText(params[2]));
      const notCheckedSince = params[3] instanceof Date ? params[3] : new Date(asText(params[3]));
      const limit = Number(params[4]);
      const excludedIds = Array.isArray(params[5]) ? params[5].map((item) => asText(item)) : [];
      const onlyTransferId =
        params[6] === null || params[6] === undefined ? null : asText(params[6]);

      const candidates = this.outboundTransfers.filter((t) => {
        if (t.route !== route) return false;
        if (excludedIds.includes(t.id.toString())) return false;
        if (onlyTransferId !== null && t.id.toString() !== onlyTransferId) return false;
        const a = this.railAttestations.get(t.id);
        if (a !== undefined && a.status !== "pending" && a.status !== "attested") return false;
        if ((a?.check_failures ?? 0) >= maxCheckFailures) return false;
        if (a?.retry_class === "permanent" || a?.retry_class === "exhausted") return false;
        if (a?.next_attempt_at !== null && a?.next_attempt_at !== undefined) {
          if (a.next_attempt_at.getTime() > now.getTime()) return false;
        } else {
          if (a?.last_checked_at !== null && a?.last_checked_at !== undefined) {
            if (a.last_checked_at.getTime() >= notCheckedSince.getTime()) return false;
          }
        }
        return true;
      });

      candidates.sort((t1, t2) => {
        const a1 = this.railAttestations.get(t1.id);
        const a2 = this.railAttestations.get(t2.id);
        const n1 = a1?.next_attempt_at?.getTime() ?? null;
        const n2 = a2?.next_attempt_at?.getTime() ?? null;
        if (n1 === null && n2 !== null) return -1;
        if (n1 !== null && n2 === null) return 1;
        if (n1 !== null && n2 !== null && n1 !== n2) return n1 - n2;
        const l1 = a1?.last_checked_at?.getTime() ?? null;
        const l2 = a2?.last_checked_at?.getTime() ?? null;
        if (l1 === null && l2 !== null) return -1;
        if (l1 !== null && l2 === null) return 1;
        if (l1 !== null && l2 !== null && l1 !== l2) return l1 - l2;
        return Number(t1.id - t2.id);
      });

      const page = candidates.slice(0, limit);
      const rows = page.map((t) => {
        const a = this.railAttestations.get(t.id);
        return {
          id: t.id.toString(),
          route: t.route,
          origin_chain: t.origin_chain,
          destination_chain: t.destination_chain,
          nonce: t.nonce.toString(),
          origin_tx: t.origin_tx,
          status: a?.status ?? null,
          check_failures: a?.check_failures ?? 0,
          retry_attempts: a?.retry_attempts ?? 0,
          delivered: false,
        };
      });
      return Promise.resolve({ rows, rowCount: rows.length });
    }
    if (
      text.includes("FROM rail_attestation") ||
      (text.includes("rail_attestation") && text.includes("outbound_transfer"))
    ) {
      if (params.length > 0) {
        const tid = BigInt(asText(params[0]));
        let a = this.railAttestations.get(tid);
        if (!a) {
          const t = this.outboundTransfers.find((item) => item.nonce === tid || item.id === tid);
          if (t) a = this.railAttestations.get(t.id);
        }
        if (a) {
          return Promise.resolve({
            rows: [
              {
                transfer_id: a.transfer_id.toString(),
                route: a.route,
                status: a.status,
                rail_status: a.rail_status,
                rail_reference: a.rail_reference,
                attested_at: a.attested_at,
                last_checked_at: a.last_checked_at,
                check_failures: a.check_failures,
                last_error: a.last_error,
                next_attempt_at: a.next_attempt_at,
                retry_class: a.retry_class,
                retry_attempts: a.retry_attempts,
              },
            ],
            rowCount: 1,
          });
        }
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    // Zero rows affected, which is what makes `recordClaimSettled` report an unmatched settlement.
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    const id = ++this.transactions;
    this.open = id;
    const identities = new Map(this.identities);
    const conflicts = new Map(this.conflicts);
    const journals = [...this.journals];
    const outboundTransfers = this.outboundTransfers.map((t) => ({ ...t }));
    const railAttestations = new Map(this.railAttestations);
    try {
      const value = await work(this);
      this.commits.push(id);
      return value;
    } catch (error) {
      this.identities = identities;
      this.conflicts = conflicts;
      this.journals = journals;
      this.outboundTransfers.length = 0;
      this.outboundTransfers.push(...outboundTransfers);
      this.railAttestations.clear();
      for (const [k, v] of railAttestations) this.railAttestations.set(k, v);
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

  ping(): Promise<void> {
    return Promise.resolve();
  }
}

function asText(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return fallback;
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

export function seedOutboundTransfer(
  db: RecordingDb,
  fields: {
    readonly id?: bigint;
    readonly route?: number;
    readonly originChain?: string;
    readonly destinationChain?: string;
    readonly nonce?: bigint;
    readonly originTx?: string;
    readonly destination?: string;
    readonly sender?: string;
    readonly token?: string;
  } = {},
): bigint {
  const id = fields.id ?? BigInt(db.outboundTransfers.length + 1);
  db.outboundTransfers.push({
    id,
    origin_chain: fields.originChain ?? "sepolia",
    origin_router: "router-1",
    route: fields.route ?? 0,
    nonce: fields.nonce ?? id,
    sender: fields.sender ?? "0x1111111111111111111111111111111111111111",
    token: fields.token ?? "0x3333333333333333333333333333333333333333",
    gross_amount: 1000000n,
    fee: 1000n,
    net_amount: 999000n,
    destination_chain: fields.destinationChain ?? "stellar-testnet",
    destination: fields.destination ?? "0x2222222222222222222222222222222222222222",
    rail_ref: "0x0000",
    origin_block: 1000n,
    origin_tx: fields.originTx ?? `0x${id.toString(16).padStart(64, "0")}`,
    origin_log_index: 0,
    observed_at: new Date(),
  });
  return id;
}
