/**
 * Deterministic indexer crash-injection harness.
 *
 * Wraps any `Transactional` handle (live `Database` or in-memory `PGlite`) so faults can be
 * injected deterministically before and after event writes, rail attestation writes, and cursor
 * commits. After an injected crash, callers instantiate a fresh worker (`StellarWatcher`,
 * `EvmWatcher`, or `RailPass`) against the surviving database to prove atomic rollback or
 * post-commit replay without duplicate source records.
 */
import { PGlite } from "@electric-sql/pglite";

import type { Queryable, QueryResultRows, Transactional } from "../src/db/pool.js";
import { createSeededRandom, loadUpMigrations } from "./helpers.js";

export const ALL_CRASH_BOUNDARIES = [
  "before_begin",
  "before_event_write",
  "after_event_write",
  "before_attestation_write",
  "after_attestation_write",
  "before_cursor_write",
  "after_cursor_write",
  "before_commit",
  "after_commit",
] as const;

export type CrashBoundary = (typeof ALL_CRASH_BOUNDARIES)[number];

export interface CrashFaultRule {
  readonly seed: number;
  readonly boundary: CrashBoundary;
  /** 1-based occurrence count of `boundary` at which to inject a crash. */
  readonly occurrence: number;
}

export interface CrashTraceEntry {
  readonly step: number;
  readonly boundary: CrashBoundary;
  readonly occurrence: number;
  readonly transactionId: number | null;
  readonly statementKind: "transaction" | "event_write" | "attestation_write" | "cursor_write";
  readonly statementSummary: string;
  readonly injected: boolean;
}

export interface CursorSnapshotRow {
  readonly chainKey: string;
  readonly family: string;
  readonly contract: string;
  readonly lastProcessed: string;
  readonly lastProcessedHash: string | null;
}

export interface OutboundSnapshotRow {
  readonly originChain: string;
  readonly route: number;
  readonly nonce: string;
  readonly sender: string;
  readonly token: string;
  readonly grossAmount: string;
  readonly fee: string;
  readonly netAmount: string;
  readonly destinationChain: string;
  readonly destination: string;
  readonly originBlock: string;
  readonly originTx: string;
}

export interface InboundSnapshotRow {
  readonly destinationChain: string;
  readonly route: number;
  readonly sourceChain: string;
  readonly sourceNonce: string;
  readonly railMessageId: string | null;
  readonly recipient: string;
  readonly token: string;
  readonly amount: string;
  readonly delivered: boolean;
  readonly claimId: string | null;
  readonly destinationBlock: string;
  readonly destinationTx: string;
}

export interface ClaimSnapshotRow {
  readonly chain: string;
  readonly claimId: string;
  readonly recipient: string;
  readonly token: string;
  readonly amount: string;
  readonly route: number;
  readonly sourceChain: string;
  readonly sourceNonce: string;
  readonly settled: boolean;
  readonly settledBy: string | null;
  readonly settledTx: string | null;
}

export interface AttestationSnapshotRow {
  readonly originChain: string;
  readonly nonce: string;
  readonly route: number;
  readonly status: string;
  readonly railStatus: string | null;
  readonly railReference: string | null;
  readonly checkFailures: number;
}

export interface AdminActionSnapshotRow {
  readonly chain: string;
  readonly actionId: string;
  readonly kind: number;
  readonly state: string;
  readonly actor: string | null;
}

export interface DatabaseSnapshot {
  readonly cursors: readonly CursorSnapshotRow[];
  readonly outboundTransfers: readonly OutboundSnapshotRow[];
  readonly inboundDeliveries: readonly InboundSnapshotRow[];
  readonly pendingClaims: readonly ClaimSnapshotRow[];
  readonly railAttestations: readonly AttestationSnapshotRow[];
  readonly adminActions: readonly AdminActionSnapshotRow[];
}

export interface SnapshotFilter {
  readonly chains?: readonly string[];
}

export function redactCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/[^:\s/]+:)[^@\s]+@/gi, "$1[REDACTED]@");
}

function summarizeSql(sql: string): string {
  const collapsed = redactCredentials(sql.replace(/\s+/g, " ").trim());
  return collapsed.length <= 96 ? collapsed : `${collapsed.slice(0, 93)}...`;
}

export class CrashInjectionError extends Error {
  readonly seed: number;
  readonly boundary: CrashBoundary;
  readonly occurrence: number;
  readonly step: number;
  readonly statementSummary: string;

  constructor(details: {
    readonly seed: number;
    readonly boundary: CrashBoundary;
    readonly occurrence: number;
    readonly step: number;
    readonly statementSummary: string;
  }) {
    super(
      `injected crash [seed=${String(details.seed)} boundary=${details.boundary} ` +
        `occurrence=${String(details.occurrence)} step=${String(details.step)}]`,
    );
    this.name = "CrashInjectionError";
    this.seed = details.seed;
    this.boundary = details.boundary;
    this.occurrence = details.occurrence;
    this.step = details.step;
    this.statementSummary = details.statementSummary;
  }
}

export class CrashHarnessFailureError extends Error {
  readonly seed: number;
  readonly operationBoundary: CrashBoundary;
  readonly occurrence: number;
  readonly trace: readonly CrashTraceEntry[];
  readonly snapshot: DatabaseSnapshot;

  constructor(details: {
    readonly reason: string;
    readonly seed: number;
    readonly operationBoundary: CrashBoundary;
    readonly occurrence: number;
    readonly trace: readonly CrashTraceEntry[];
    readonly snapshot: DatabaseSnapshot;
    readonly cause?: unknown;
  }) {
    const safeReason = redactCredentials(details.reason);
    const snapshotJson = redactCredentials(JSON.stringify(details.snapshot));
    super(
      `crash harness invariant failed: ${safeReason} ` +
        `(seed=${String(details.seed)}, boundary=${details.operationBoundary}, ` +
        `occurrence=${String(details.occurrence)}, snapshot=${snapshotJson})`,
      details.cause === undefined ? undefined : { cause: details.cause },
    );
    this.name = "CrashHarnessFailureError";
    this.seed = details.seed;
    this.operationBoundary = details.operationBoundary;
    this.occurrence = details.occurrence;
    this.trace = details.trace;
    this.snapshot = details.snapshot;
  }
}

type ClassifiedWrite = "event_write" | "attestation_write" | "cursor_write" | "other";

function classifyStatement(sql: string): ClassifiedWrite {
  const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
  if (
    normalized.startsWith("insert into indexer_cursor") ||
    normalized.startsWith("insert into public.indexer_cursor") ||
    normalized.startsWith("update indexer_cursor")
  ) {
    return "cursor_write";
  }
  if (
    normalized.startsWith("insert into rail_attestation") ||
    normalized.startsWith("insert into public.rail_attestation") ||
    normalized.startsWith("update rail_attestation")
  ) {
    return "attestation_write";
  }
  if (
    /^(insert\s+into|update)\s+(public\.)?(outbound_transfer|inbound_delivery|pending_claim|admin_action|route_health)\b/.test(
      normalized,
    )
  ) {
    return "event_write";
  }
  return "other";
}

/**
 * Deterministic fault-injecting `Transactional` proxy.
 */
export class CrashInjectingDatabase implements Transactional {
  private readonly occurrences = new Map<CrashBoundary, number>();
  private readonly traceLog: CrashTraceEntry[] = [];
  private activeRule: CrashFaultRule | null = null;
  private haltedError: CrashInjectionError | null = null;
  private stepCounter = 0;
  private txCounter = 0;
  commitsCompleted = 0;
  rollbacksTriggered = 0;

  constructor(
    private readonly inner: Transactional,
    initialRule: CrashFaultRule | null = null,
  ) {
    this.activeRule = initialRule;
  }

  get trace(): readonly CrashTraceEntry[] {
    return this.traceLog;
  }

  armFault(rule: CrashFaultRule): void {
    this.haltedError = null;
    this.activeRule = rule;
  }

  clearFault(): void {
    this.haltedError = null;
    this.activeRule = null;
  }

  resetTrace(): void {
    this.occurrences.clear();
    this.traceLog.length = 0;
    this.haltedError = null;
    this.stepCounter = 0;
    this.txCounter = 0;
    this.commitsCompleted = 0;
    this.rollbacksTriggered = 0;
  }

  async query(text: string, params: readonly unknown[] = []): Promise<QueryResultRows> {
    if (this.haltedError !== null) throw this.haltedError;
    const kind = classifyStatement(text);
    const summary = summarizeSql(text);
    if (kind === "event_write") {
      this.checkpoint("before_event_write", null, "event_write", summary);
    } else if (kind === "attestation_write") {
      this.checkpoint("before_attestation_write", null, "attestation_write", summary);
    } else if (kind === "cursor_write") {
      this.checkpoint("before_cursor_write", null, "cursor_write", summary);
    }

    const result = await this.inner.query(text, params);

    if (kind === "event_write") {
      this.checkpoint("after_event_write", null, "event_write", summary);
    } else if (kind === "attestation_write") {
      this.checkpoint("after_attestation_write", null, "attestation_write", summary);
    } else if (kind === "cursor_write") {
      this.checkpoint("after_cursor_write", null, "cursor_write", summary);
    }
    return result;
  }

  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    if (this.haltedError !== null) throw this.haltedError;
    const txId = ++this.txCounter;
    this.checkpoint("before_begin", txId, "transaction", "BEGIN");

    let value: T;
    try {
      value = await this.inner.transaction(async (rawTx) => {
        const wrappedTx: Queryable = {
          query: async (
            text: string,
            params: readonly unknown[] = [],
          ): Promise<QueryResultRows> => {
            const kind = classifyStatement(text);
            const summary = summarizeSql(text);
            if (kind === "event_write") {
              this.checkpoint("before_event_write", txId, "event_write", summary);
            } else if (kind === "attestation_write") {
              this.checkpoint("before_attestation_write", txId, "attestation_write", summary);
            } else if (kind === "cursor_write") {
              this.checkpoint("before_cursor_write", txId, "cursor_write", summary);
            }

            const result = await rawTx.query(text, params);

            if (kind === "event_write") {
              this.checkpoint("after_event_write", txId, "event_write", summary);
            } else if (kind === "attestation_write") {
              this.checkpoint("after_attestation_write", txId, "attestation_write", summary);
            } else if (kind === "cursor_write") {
              this.checkpoint("after_cursor_write", txId, "cursor_write", summary);
            }
            return result;
          },
        };

        const out = await work(wrappedTx);
        this.checkpoint("before_commit", txId, "transaction", "COMMIT");
        return out;
      });
    } catch (error) {
      this.rollbacksTriggered += 1;
      throw error;
    }

    this.commitsCompleted += 1;
    this.checkpoint("after_commit", txId, "transaction", "POST_COMMIT");
    return value;
  }

  private checkpoint(
    boundary: CrashBoundary,
    transactionId: number | null,
    statementKind: CrashTraceEntry["statementKind"],
    statementSummary: string,
  ): void {
    const nextOccurrence = (this.occurrences.get(boundary) ?? 0) + 1;
    this.occurrences.set(boundary, nextOccurrence);
    const step = ++this.stepCounter;

    const rule = this.activeRule;
    const shouldInject =
      rule !== null && rule.boundary === boundary && rule.occurrence === nextOccurrence;

    this.traceLog.push({
      step,
      boundary,
      occurrence: nextOccurrence,
      transactionId,
      statementKind,
      statementSummary,
      injected: shouldInject,
    });

    if (shouldInject) {
      this.activeRule = null;
      const crash = new CrashInjectionError({
        seed: rule.seed,
        boundary,
        occurrence: nextOccurrence,
        step,
        statementSummary,
      });
      this.haltedError = crash;
      throw crash;
    }
  }
}

export interface PGliteDatabase extends Transactional {
  close(): Promise<void>;
}

/**
 * Boot an isolated in-memory Postgres 16 (`PGlite`) instance with all production migrations applied.
 */
export async function openPGliteDatabase(): Promise<PGliteDatabase> {
  const pg = await PGlite.create();
  for (const migration of loadUpMigrations()) {
    await pg.exec(migration.upSql);
  }

  return {
    async query(text: string, params: readonly unknown[] = []): Promise<QueryResultRows> {
      const result = await pg.query<Record<string, unknown>>(text, [...params]);
      return {
        rows: result.rows,
        rowCount: result.affectedRows ?? result.rowCount ?? 0,
      };
    },
    async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
      return pg.transaction(async (tx) => {
        const wrapped: Queryable = {
          async query(text: string, params: readonly unknown[] = []): Promise<QueryResultRows> {
            const result = await tx.query<Record<string, unknown>>(text, [...params]);
            return {
              rows: result.rows,
              rowCount: result.affectedRows ?? result.rowCount ?? 0,
            };
          },
        };
        return work(wrapped);
      });
    },
    async close(): Promise<void> {
      await pg.close();
    },
  };
}

export async function resetHarnessTables(db: Queryable, chains?: readonly string[]): Promise<void> {
  if (chains === undefined) {
    await db.query(
      `TRUNCATE TABLE
         rail_attestation,
         inbound_delivery,
         outbound_transfer,
         pending_claim,
         admin_action,
         route_health,
         indexer_cursor
       RESTART IDENTITY CASCADE`,
    );
    return;
  }

  for (const chain of chains) {
    await db.query(
      `DELETE FROM rail_attestation
        WHERE transfer_id IN (SELECT id FROM outbound_transfer WHERE origin_chain = $1)`,
      [chain],
    );
    await db.query(
      "DELETE FROM inbound_delivery WHERE destination_chain = $1 OR source_chain = $1",
      [chain],
    );
    await db.query(
      "DELETE FROM outbound_transfer WHERE origin_chain = $1 OR destination_chain = $1",
      [chain],
    );
    await db.query("DELETE FROM pending_claim WHERE chain = $1 OR source_chain = $1", [chain]);
    await db.query("DELETE FROM admin_action WHERE chain = $1", [chain]);
    await db.query("DELETE FROM route_health WHERE origin_chain = $1 OR destination_chain = $1", [
      chain,
    ]);
    await db.query("DELETE FROM indexer_cursor WHERE chain_key = $1", [chain]);
  }
}

export async function captureDatabaseSnapshot(
  db: Queryable,
  filter: SnapshotFilter = {},
): Promise<DatabaseSnapshot> {
  const chains = filter.chains;
  const hasChainFilter = chains !== undefined && chains.length > 0;

  const cursorRes = hasChainFilter
    ? await db.query(
        `SELECT chain_key, family, contract, last_processed::text AS last_processed, last_processed_hash
           FROM indexer_cursor
          WHERE chain_key = ANY($1)
          ORDER BY chain_key`,
        [chains],
      )
    : await db.query(
        `SELECT chain_key, family, contract, last_processed::text AS last_processed, last_processed_hash
           FROM indexer_cursor
          ORDER BY chain_key`,
      );

  const outboundRes = hasChainFilter
    ? await db.query(
        `SELECT origin_chain, route, nonce::text AS nonce, sender, token,
                gross_amount::text AS gross_amount, fee::text AS fee, net_amount::text AS net_amount,
                destination_chain, destination, origin_block::text AS origin_block, origin_tx
           FROM outbound_transfer
          WHERE origin_chain = ANY($1) OR destination_chain = ANY($1)
          ORDER BY origin_chain, nonce::numeric`,
        [chains],
      )
    : await db.query(
        `SELECT origin_chain, route, nonce::text AS nonce, sender, token,
                gross_amount::text AS gross_amount, fee::text AS fee, net_amount::text AS net_amount,
                destination_chain, destination, origin_block::text AS origin_block, origin_tx
           FROM outbound_transfer
          ORDER BY origin_chain, nonce::numeric`,
      );

  const inboundRes = hasChainFilter
    ? await db.query(
        `SELECT destination_chain, route, source_chain, source_nonce::text AS source_nonce,
                rail_message_id, recipient, token, amount::text AS amount, delivered,
                claim_id::text AS claim_id, destination_block::text AS destination_block, destination_tx
           FROM inbound_delivery
          WHERE destination_chain = ANY($1) OR source_chain = ANY($1)
          ORDER BY destination_chain, route, source_chain, source_nonce::numeric`,
        [chains],
      )
    : await db.query(
        `SELECT destination_chain, route, source_chain, source_nonce::text AS source_nonce,
                rail_message_id, recipient, token, amount::text AS amount, delivered,
                claim_id::text AS claim_id, destination_block::text AS destination_block, destination_tx
           FROM inbound_delivery
          ORDER BY destination_chain, route, source_chain, source_nonce::numeric`,
      );

  const claimRes = hasChainFilter
    ? await db.query(
        `SELECT chain, claim_id::text AS claim_id, recipient, token, amount::text AS amount,
                route, source_chain, source_nonce::text AS source_nonce, settled, settled_by, settled_tx
           FROM pending_claim
          WHERE chain = ANY($1) OR source_chain = ANY($1)
          ORDER BY chain, claim_id::numeric`,
        [chains],
      )
    : await db.query(
        `SELECT chain, claim_id::text AS claim_id, recipient, token, amount::text AS amount,
                route, source_chain, source_nonce::text AS source_nonce, settled, settled_by, settled_tx
           FROM pending_claim
          ORDER BY chain, claim_id::numeric`,
      );

  const attestationRes = hasChainFilter
    ? await db.query(
        `SELECT t.origin_chain, t.nonce::text AS nonce, a.route, a.status, a.rail_status,
                a.rail_reference, a.check_failures
           FROM rail_attestation a
           JOIN outbound_transfer t ON t.id = a.transfer_id
          WHERE t.origin_chain = ANY($1) OR t.destination_chain = ANY($1)
          ORDER BY t.origin_chain, t.nonce::numeric`,
        [chains],
      )
    : await db.query(
        `SELECT t.origin_chain, t.nonce::text AS nonce, a.route, a.status, a.rail_status,
                a.rail_reference, a.check_failures
           FROM rail_attestation a
           JOIN outbound_transfer t ON t.id = a.transfer_id
          ORDER BY t.origin_chain, t.nonce::numeric`,
      );

  const actionRes = hasChainFilter
    ? await db.query(
        `SELECT chain, action_id::text AS action_id, kind, state, actor
           FROM admin_action
          WHERE chain = ANY($1)
          ORDER BY chain, action_id::numeric`,
        [chains],
      )
    : await db.query(
        `SELECT chain, action_id::text AS action_id, kind, state, actor
           FROM admin_action
          ORDER BY chain, action_id::numeric`,
      );

  return {
    cursors: cursorRes.rows.map((row) => ({
      chainKey: String(row.chain_key),
      family: String(row.family),
      contract: String(row.contract),
      lastProcessed: String(row.last_processed),
      lastProcessedHash:
        typeof row.last_processed_hash === "string" ? row.last_processed_hash : null,
    })),
    outboundTransfers: outboundRes.rows.map((row) => ({
      originChain: String(row.origin_chain),
      route: Number(row.route),
      nonce: String(row.nonce),
      sender: String(row.sender),
      token: String(row.token),
      grossAmount: String(row.gross_amount),
      fee: String(row.fee),
      netAmount: String(row.net_amount),
      destinationChain: String(row.destination_chain),
      destination: String(row.destination),
      originBlock: String(row.origin_block),
      originTx: String(row.origin_tx),
    })),
    inboundDeliveries: inboundRes.rows.map((row) => ({
      destinationChain: String(row.destination_chain),
      route: Number(row.route),
      sourceChain: String(row.source_chain),
      sourceNonce: String(row.source_nonce),
      railMessageId: typeof row.rail_message_id === "string" ? row.rail_message_id : null,
      recipient: String(row.recipient),
      token: String(row.token),
      amount: String(row.amount),
      delivered: Boolean(row.delivered),
      claimId: typeof row.claim_id === "string" ? row.claim_id : null,
      destinationBlock: String(row.destination_block),
      destinationTx: String(row.destination_tx),
    })),
    pendingClaims: claimRes.rows.map((row) => ({
      chain: String(row.chain),
      claimId: String(row.claim_id),
      recipient: String(row.recipient),
      token: String(row.token),
      amount: String(row.amount),
      route: Number(row.route),
      sourceChain: String(row.source_chain),
      sourceNonce: String(row.source_nonce),
      settled: Boolean(row.settled),
      settledBy: typeof row.settled_by === "string" ? row.settled_by : null,
      settledTx: typeof row.settled_tx === "string" ? row.settled_tx : null,
    })),
    railAttestations: attestationRes.rows.map((row) => ({
      originChain: String(row.origin_chain),
      nonce: String(row.nonce),
      route: Number(row.route),
      status: String(row.status),
      railStatus: typeof row.rail_status === "string" ? row.rail_status : null,
      railReference: typeof row.rail_reference === "string" ? row.rail_reference : null,
      checkFailures: Number(row.check_failures),
    })),
    adminActions: actionRes.rows.map((row) => ({
      chain: String(row.chain),
      actionId: String(row.action_id),
      kind: Number(row.kind),
      state: String(row.state),
      actor: typeof row.actor === "string" ? row.actor : null,
    })),
  };
}

export function assertSnapshotIntegrity(snapshot: DatabaseSnapshot): void {
  const outboundKeys = new Set<string>();
  for (const row of snapshot.outboundTransfers) {
    const key = `${row.originChain}:${row.nonce}`;
    if (outboundKeys.has(key)) {
      throw new Error(`duplicate outbound_transfer source record for ${key}`);
    }
    outboundKeys.add(key);
    if (!/^\d+$/.test(row.grossAmount) || !/^\d+$/.test(row.fee) || !/^\d+$/.test(row.netAmount)) {
      throw new Error(`non-integer string amount in outbound_transfer ${key}`);
    }
    if (BigInt(row.grossAmount) !== BigInt(row.fee) + BigInt(row.netAmount)) {
      throw new Error(`outbound_transfer fee split mismatch for ${key}`);
    }
  }

  const inboundHopKeys = new Set<string>();
  for (const row of snapshot.inboundDeliveries) {
    const hopKey = `${row.destinationChain}:${String(row.route)}:${row.sourceChain}:${row.sourceNonce}`;
    if (inboundHopKeys.has(hopKey)) {
      throw new Error(`duplicate inbound_delivery hop record for ${hopKey}`);
    }
    inboundHopKeys.add(hopKey);
    if (!/^\d+$/.test(row.amount)) {
      throw new Error(`non-integer string amount in inbound_delivery ${hopKey}`);
    }
  }

  const claimKeys = new Set<string>();
  for (const row of snapshot.pendingClaims) {
    const key = `${row.chain}:${row.claimId}`;
    if (claimKeys.has(key)) {
      throw new Error(`duplicate pending_claim record for ${key}`);
    }
    claimKeys.add(key);
  }

  // Provider status alone must never establish destination delivery unless an inbound_delivery
  // exists for the matching (source_chain, source_nonce, route).
  for (const att of snapshot.railAttestations) {
    if (att.status === "delivered") {
      const hasInbound = snapshot.inboundDeliveries.some(
        (inbound) =>
          inbound.sourceChain === att.originChain &&
          inbound.sourceNonce === att.nonce &&
          inbound.route === att.route,
      );
      if (!hasInbound) {
        throw new Error(
          `rail_attestation marked delivered for ${att.originChain}:${att.nonce} without destination inbound_delivery`,
        );
      }
    }
  }
}

export interface RestartableTickWorker {
  tick(signal: AbortSignal): Promise<boolean>;
}

export async function drainWorker(worker: RestartableTickWorker, maxTicks = 32): Promise<number> {
  let ticks = 0;
  while (ticks < maxTicks) {
    ticks += 1;
    const more = await worker.tick(AbortSignal.timeout(10_000));
    if (!more) return ticks;
  }
  throw new Error(`worker exceeded maxTicks (${String(maxTicks)}) without catching up`);
}

export function buildSeededCrashRules(
  seed: number,
  boundaries: readonly CrashBoundary[],
  count: number,
  maxOccurrence = 2,
): readonly CrashFaultRule[] {
  const rng = createSeededRandom(seed);
  const rules: CrashFaultRule[] = [];
  for (let i = 0; i < count; i += 1) {
    rules.push({
      seed: rng.seed,
      boundary: rng.pick(boundaries),
      occurrence: rng.nextInt(1, maxOccurrence + 1),
    });
  }
  return rules;
}

export interface CrashScenarioOptions {
  readonly db: Transactional;
  readonly rule: CrashFaultRule;
  readonly createWorker: (faultDb: Transactional) => RestartableTickWorker;
  readonly filter?: SnapshotFilter;
  readonly expectedFinalSnapshot?: DatabaseSnapshot;
  readonly verifyMidCrash?: (midSnapshot: DatabaseSnapshot, crash: CrashInjectionError) => void;
}

export interface CrashScenarioResult {
  readonly crashed: boolean;
  readonly midCrashSnapshot: DatabaseSnapshot | null;
  readonly finalSnapshot: DatabaseSnapshot;
  readonly trace: readonly CrashTraceEntry[];
}

/**
 * Execute a worker under deterministic crash injection, verify atomic mid-crash state, restart a
 * fresh worker instance against the surviving database, and verify replay convergence.
 *
 * Any failure throws `CrashHarnessFailureError` retaining `seed`, `operationBoundary`, `trace`, and
 * `snapshot`.
 */
export async function runCrashRestartScenario(
  options: CrashScenarioOptions,
): Promise<CrashScenarioResult> {
  const faultDb = new CrashInjectingDatabase(options.db, options.rule);
  const filter = options.filter ?? {};
  let injectedCrash: CrashInjectionError | null = null;
  let midCrashSnapshot: DatabaseSnapshot | null = null;

  const firstWorker = options.createWorker(faultDb);
  try {
    await drainWorker(firstWorker);
  } catch (error) {
    if (error instanceof CrashInjectionError) {
      injectedCrash = error;
    } else {
      const snap = await captureDatabaseSnapshot(options.db, filter);
      throw new CrashHarnessFailureError({
        reason: error instanceof Error ? error.message : String(error),
        seed: options.rule.seed,
        operationBoundary: options.rule.boundary,
        occurrence: options.rule.occurrence,
        trace: [...faultDb.trace],
        snapshot: snap,
        cause: error,
      });
    }
  }

  try {
    if (injectedCrash !== null) {
      midCrashSnapshot = await captureDatabaseSnapshot(options.db, filter);
      assertSnapshotIntegrity(midCrashSnapshot);
      options.verifyMidCrash?.(midCrashSnapshot, injectedCrash);
    }

    faultDb.clearFault();
    const restartedWorker = options.createWorker(faultDb);
    await drainWorker(restartedWorker);

    const finalSnapshot = await captureDatabaseSnapshot(options.db, filter);
    assertSnapshotIntegrity(finalSnapshot);

    if (options.expectedFinalSnapshot !== undefined) {
      const actualJson = JSON.stringify(finalSnapshot);
      const expectedJson = JSON.stringify(options.expectedFinalSnapshot);
      if (actualJson !== expectedJson) {
        throw new Error("restarted database snapshot diverged from expected reference snapshot");
      }
    }

    return {
      crashed: injectedCrash !== null,
      midCrashSnapshot,
      finalSnapshot,
      trace: [...faultDb.trace],
    };
  } catch (error) {
    if (error instanceof CrashHarnessFailureError) throw error;
    const snap = await captureDatabaseSnapshot(options.db, filter);
    throw new CrashHarnessFailureError({
      reason: error instanceof Error ? error.message : String(error),
      seed: injectedCrash?.seed ?? options.rule.seed,
      operationBoundary: injectedCrash?.boundary ?? options.rule.boundary,
      occurrence: injectedCrash?.occurrence ?? options.rule.occurrence,
      trace: [...faultDb.trace],
      snapshot: snap,
      cause: error,
    });
  }
}
