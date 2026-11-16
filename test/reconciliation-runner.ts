import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

import type { Queryable, QueryResultRows, Transactional } from "../src/db/pool.js";

const MIGRATION_FILES = [
  "1790900000000_initial-schema.sql",
  "1791000000000_cursor-block-hash.sql",
  "1791100000000_cursor-autovacuum-tuning.sql",
] as const;

export interface NormalizedOutboundFact {
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
  readonly railRef: string | null;
  readonly originBlock: string;
  readonly originTx: string;
  readonly originLogIndex: number | null;
}

export interface NormalizedInboundFact {
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
  readonly destinationLogIndex: number | null;
}

export interface NormalizedClaimFact {
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

export interface NormalizedAttestationFact {
  readonly originChain: string;
  readonly nonce: string;
  readonly route: number;
  readonly status: string;
  readonly railStatus: string | null;
  readonly railReference: string | null;
}

export interface ReferenceHistorySnapshot {
  readonly outbound: readonly NormalizedOutboundFact[];
  readonly inbound: readonly NormalizedInboundFact[];
  readonly claims: readonly NormalizedClaimFact[];
  readonly attestations: readonly NormalizedAttestationFact[];
}

export interface HistoryDigests {
  readonly outboundDigest: string;
  readonly inboundDigest: string;
  readonly claimDigest: string;
  readonly attestationDigest: string;
  readonly combinedMonetaryAndClaimDigest: string;
}

export interface BlockInterval {
  readonly from: bigint;
  readonly to: bigint;
}

export interface ChainExpectedRange {
  readonly chainKey: string;
  readonly family: "stellar" | "evm";
  readonly contract: string;
  readonly fromHeight: bigint;
  readonly targetHeight: bigint;
  readonly expectedEventHeights: readonly bigint[];
}

export interface ChainCoverageReport {
  readonly chainKey: string;
  readonly family: "stellar" | "evm";
  readonly cursorPosition: bigint | null;
  readonly targetHeight: bigint;
  readonly cursorLag: bigint;
  readonly contractMatches: boolean;
  readonly missingIntervals: readonly BlockInterval[];
}

export interface DigestMismatch {
  readonly category: "outbound" | "inbound" | "claims" | "attestations";
  readonly key: string;
  readonly reason: "missing_in_db" | "unexpected_in_db" | "field_mismatch";
  readonly expected: unknown;
  readonly actual: unknown;
}

export interface UnbackedDeliveredAttestation {
  readonly originChain: string;
  readonly nonce: string;
  readonly route: number;
}

export interface ReconciliationReport {
  readonly complete: boolean;
  readonly chains: readonly ChainCoverageReport[];
  readonly expectedDigests: HistoryDigests;
  readonly actualDigests: HistoryDigests;
  readonly digestsMatch: {
    readonly outbound: boolean;
    readonly inbound: boolean;
    readonly claims: boolean;
    readonly attestations: boolean;
    readonly monetaryAndClaims: boolean;
  };
  readonly digestMismatches: readonly DigestMismatch[];
  readonly unbackedDeliveredAttestations: readonly UnbackedDeliveredAttestation[];
  readonly rowCounts: {
    readonly outboundCount: number;
    readonly inboundCount: number;
    readonly claimCount: number;
    readonly attestationCount: number;
  };
}

export interface PGliteTestDb extends Transactional {
  readonly pg: PGlite;
  close(): Promise<void>;
}

export function loadUpMigrationSql(fileName: string): string {
  const fullPath = fileURLToPath(new URL(`../migrations/${fileName}`, import.meta.url));
  const raw = readFileSync(fullPath, "utf8");
  return raw.split(/^--\s*Down Migration\b/m)[0] ?? raw;
}

export async function applyRepositoryMigrations(db: Queryable): Promise<void> {
  for (const name of MIGRATION_FILES) {
    const upSql = loadUpMigrationSql(name);
    await db.query(upSql);
  }
}

export async function createMigratedPGliteDb(): Promise<PGliteTestDb> {
  const pg = new PGlite();

  const runQuery = async (
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResultRows> => {
    const normalizedParams = params.map((param) =>
      param instanceof Date ? param.toISOString() : param,
    );
    const result =
      normalizedParams.length === 0
        ? await (async () => {
            if (sql.includes(";")) {
              await pg.exec(sql);
              return { rows: [], fields: [], affectedRows: 0 };
            }
            return pg.query(sql);
          })()
        : await pg.query(sql, normalizedParams);

    const int8Cols = result.fields
      .filter((field) => field.dataTypeID === 20)
      .map((field) => field.name);

    const rows = result.rows.map((raw) => {
      const copy = { ...(raw as Record<string, unknown>) };
      for (const col of int8Cols) {
        const val = copy[col];
        if (typeof val === "number" || typeof val === "bigint") {
          copy[col] = String(val);
        }
      }
      return copy;
    });

    return {
      rows,
      rowCount: result.affectedRows ?? rows.length,
    };
  };

  const wrapper: PGliteTestDb = {
    pg,
    query: runQuery,
    async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
      await pg.exec("BEGIN");
      try {
        const value = await work({ query: runQuery });
        await pg.exec("COMMIT");
        return value;
      } catch (err) {
        await pg.exec("ROLLBACK");
        throw err;
      }
    },
    async close(): Promise<void> {
      await pg.close();
    },
  };

  await applyRepositoryMigrations(wrapper);
  return wrapper;
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function compareBigIntStrings(a: string, b: string): number {
  const ba = BigInt(a);
  const bb = BigInt(b);
  if (ba < bb) return -1;
  if (ba > bb) return 1;
  return 0;
}

export function sortReferenceSnapshot(
  snapshot: ReferenceHistorySnapshot,
): ReferenceHistorySnapshot {
  const outbound = [...snapshot.outbound].sort((a, b) => {
    const chainCmp = a.originChain.localeCompare(b.originChain);
    return chainCmp !== 0 ? chainCmp : compareBigIntStrings(a.nonce, b.nonce);
  });

  const inbound = [...snapshot.inbound].sort((a, b) => {
    const destCmp = a.destinationChain.localeCompare(b.destinationChain);
    if (destCmp !== 0) return destCmp;
    if (a.route !== b.route) return a.route - b.route;
    const srcCmp = a.sourceChain.localeCompare(b.sourceChain);
    return srcCmp !== 0 ? srcCmp : compareBigIntStrings(a.sourceNonce, b.sourceNonce);
  });

  const claims = [...snapshot.claims].sort((a, b) => {
    const chainCmp = a.chain.localeCompare(b.chain);
    return chainCmp !== 0 ? chainCmp : compareBigIntStrings(a.claimId, b.claimId);
  });

  const attestations = [...snapshot.attestations].sort((a, b) => {
    const chainCmp = a.originChain.localeCompare(b.originChain);
    if (chainCmp !== 0) return chainCmp;
    const nonceCmp = compareBigIntStrings(a.nonce, b.nonce);
    return nonceCmp !== 0 ? nonceCmp : a.route - b.route;
  });

  return { outbound, inbound, claims, attestations };
}

export function computeReferenceRangeDigests(snapshot: ReferenceHistorySnapshot): HistoryDigests {
  const sorted = sortReferenceSnapshot(snapshot);
  const outboundDigest = sha256Json(sorted.outbound);
  const inboundDigest = sha256Json(sorted.inbound);
  const claimDigest = sha256Json(sorted.claims);
  const attestationDigest = sha256Json(sorted.attestations);
  const combinedMonetaryAndClaimDigest = sha256Json({
    outbound: sorted.outbound,
    inbound: sorted.inbound,
    claims: sorted.claims,
  });

  return {
    outboundDigest,
    inboundDigest,
    claimDigest,
    attestationDigest,
    combinedMonetaryAndClaimDigest,
  };
}

function coalesceHeights(heights: readonly bigint[]): readonly BlockInterval[] {
  if (heights.length === 0) return [];
  const sorted = [...new Set(heights)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const intervals: BlockInterval[] = [];
  let start = sorted[0]!;
  let prev = start;

  for (let i = 1; i < sorted.length; i += 1) {
    const cur = sorted[i]!;
    if (cur === prev + 1n) {
      prev = cur;
    } else {
      intervals.push({ from: start, to: prev });
      start = cur;
      prev = cur;
    }
  }
  intervals.push({ from: start, to: prev });
  return intervals;
}

function nullableText(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "bigint" || typeof val === "boolean") {
    return String(val);
  }
  return JSON.stringify(val);
}

function nullableInt(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  return Number(val);
}

export async function readDatabaseHistorySnapshot(
  db: Queryable,
): Promise<ReferenceHistorySnapshot> {
  const outboundRes = await db.query(
    `SELECT origin_chain, route, nonce::text AS nonce, sender, token,
            gross_amount::text AS gross_amount, fee::text AS fee, net_amount::text AS net_amount,
            destination_chain, destination, rail_ref,
            origin_block::text AS origin_block, origin_tx, origin_log_index
       FROM outbound_transfer`,
  );

  const inboundRes = await db.query(
    `SELECT destination_chain, route, source_chain, source_nonce::text AS source_nonce,
            rail_message_id, recipient, token, amount::text AS amount,
            delivered, claim_id::text AS claim_id,
            destination_block::text AS destination_block, destination_tx, destination_log_index
       FROM inbound_delivery`,
  );

  const claimRes = await db.query(
    `SELECT chain, claim_id::text AS claim_id, recipient, token, amount::text AS amount,
            route, source_chain, source_nonce::text AS source_nonce,
            settled, settled_by, settled_tx
       FROM pending_claim`,
  );

  const attRes = await db.query(
    `SELECT o.origin_chain, o.nonce::text AS nonce, a.route, a.status,
            a.rail_status, a.rail_reference
       FROM rail_attestation a
       JOIN outbound_transfer o ON o.id = a.transfer_id`,
  );

  const outbound: NormalizedOutboundFact[] = outboundRes.rows.map((r) => ({
    originChain: String(r.origin_chain),
    route: Number(r.route),
    nonce: String(r.nonce),
    sender: String(r.sender),
    token: String(r.token),
    grossAmount: String(r.gross_amount),
    fee: String(r.fee),
    netAmount: String(r.net_amount),
    destinationChain: String(r.destination_chain),
    destination: String(r.destination),
    railRef: nullableText(r.rail_ref),
    originBlock: String(r.origin_block),
    originTx: String(r.origin_tx),
    originLogIndex: nullableInt(r.origin_log_index),
  }));

  const inbound: NormalizedInboundFact[] = inboundRes.rows.map((r) => ({
    destinationChain: String(r.destination_chain),
    route: Number(r.route),
    sourceChain: String(r.source_chain),
    sourceNonce: String(r.source_nonce),
    railMessageId: nullableText(r.rail_message_id),
    recipient: String(r.recipient),
    token: String(r.token),
    amount: String(r.amount),
    delivered: Boolean(r.delivered),
    claimId: nullableText(r.claim_id),
    destinationBlock: String(r.destination_block),
    destinationTx: String(r.destination_tx),
    destinationLogIndex: nullableInt(r.destination_log_index),
  }));

  const claims: NormalizedClaimFact[] = claimRes.rows.map((r) => ({
    chain: String(r.chain),
    claimId: String(r.claim_id),
    recipient: String(r.recipient),
    token: String(r.token),
    amount: String(r.amount),
    route: Number(r.route),
    sourceChain: String(r.source_chain),
    sourceNonce: String(r.source_nonce),
    settled: Boolean(r.settled),
    settledBy: nullableText(r.settled_by),
    settledTx: nullableText(r.settled_tx),
  }));

  const attestations: NormalizedAttestationFact[] = attRes.rows.map((r) => ({
    originChain: String(r.origin_chain),
    nonce: String(r.nonce),
    route: Number(r.route),
    status: String(r.status),
    railStatus: nullableText(r.rail_status),
    railReference: nullableText(r.rail_reference),
  }));

  return sortReferenceSnapshot({ outbound, inbound, claims, attestations });
}

function diffKeyedFacts<T>(
  category: DigestMismatch["category"],
  expectedItems: readonly T[],
  actualItems: readonly T[],
  keyOf: (item: T) => string,
): DigestMismatch[] {
  const mismatches: DigestMismatch[] = [];
  const expectedMap = new Map<string, T>();
  for (const item of expectedItems) {
    expectedMap.set(keyOf(item), item);
  }
  const actualMap = new Map<string, T>();
  for (const item of actualItems) {
    actualMap.set(keyOf(item), item);
  }

  for (const [key, exp] of expectedMap.entries()) {
    const act = actualMap.get(key);
    if (act === undefined) {
      mismatches.push({
        category,
        key,
        reason: "missing_in_db",
        expected: exp,
        actual: null,
      });
    } else if (JSON.stringify(exp) !== JSON.stringify(act)) {
      mismatches.push({
        category,
        key,
        reason: "field_mismatch",
        expected: exp,
        actual: act,
      });
    }
  }

  for (const [key, act] of actualMap.entries()) {
    if (!expectedMap.has(key)) {
      mismatches.push({
        category,
        key,
        reason: "unexpected_in_db",
        expected: null,
        actual: act,
      });
    }
  }

  return mismatches;
}

export async function reconcileRestoredDatabase(options: {
  readonly db: Queryable;
  readonly expectedRanges: readonly ChainExpectedRange[];
  readonly reference: ReferenceHistorySnapshot;
}): Promise<ReconciliationReport> {
  const { db, expectedRanges, reference } = options;
  const sortedExpected = sortReferenceSnapshot(reference);
  const actualSnapshot = await readDatabaseHistorySnapshot(db);

  const expectedDigests = computeReferenceRangeDigests(sortedExpected);
  const actualDigests = computeReferenceRangeDigests(actualSnapshot);

  const digestMismatches: DigestMismatch[] = [
    ...diffKeyedFacts(
      "outbound",
      sortedExpected.outbound,
      actualSnapshot.outbound,
      (x) => `${x.originChain}:${x.nonce}`,
    ),
    ...diffKeyedFacts(
      "inbound",
      sortedExpected.inbound,
      actualSnapshot.inbound,
      (x) => `${x.destinationChain}:${String(x.route)}:${x.sourceChain}:${x.sourceNonce}`,
    ),
    ...diffKeyedFacts(
      "claims",
      sortedExpected.claims,
      actualSnapshot.claims,
      (x) => `${x.chain}:${x.claimId}`,
    ),
    ...diffKeyedFacts(
      "attestations",
      sortedExpected.attestations,
      actualSnapshot.attestations,
      (x) => `${x.originChain}:${x.nonce}:${String(x.route)}`,
    ),
  ];

  // Check that no rail_attestation claims status='delivered' without a confirmed inbound_delivery.
  const unbackedRes = await db.query(
    `SELECT o.origin_chain, o.nonce::text AS nonce, a.route
       FROM rail_attestation a
       JOIN outbound_transfer o ON o.id = a.transfer_id
       LEFT JOIN inbound_delivery d
              ON d.destination_chain = o.destination_chain
             AND d.route = o.route
             AND d.source_chain = o.origin_chain
             AND d.source_nonce = o.nonce
      WHERE a.status = 'delivered'
        AND d.id IS NULL`,
  );
  const unbackedDeliveredAttestations: UnbackedDeliveredAttestation[] = unbackedRes.rows.map(
    (r) => ({
      originChain: String(r.origin_chain),
      nonce: String(r.nonce),
      route: Number(r.route),
    }),
  );

  // Inspect per-chain cursor position and missing event heights / tail intervals.
  const cursorRes = await db.query(
    `SELECT chain_key, family, contract, last_processed::text AS last_processed
       FROM indexer_cursor`,
  );
  const cursorByChain = new Map<
    string,
    { readonly family: string; readonly contract: string; readonly position: bigint }
  >();
  for (const row of cursorRes.rows) {
    cursorByChain.set(String(row.chain_key), {
      family: String(row.family),
      contract: String(row.contract),
      position: BigInt(String(row.last_processed)),
    });
  }

  const observedHeightsByChain = new Map<string, Set<bigint>>();
  for (const out of actualSnapshot.outbound) {
    const set = observedHeightsByChain.get(out.originChain) ?? new Set<bigint>();
    set.add(BigInt(out.originBlock));
    observedHeightsByChain.set(out.originChain, set);
  }
  for (const inb of actualSnapshot.inbound) {
    const set = observedHeightsByChain.get(inb.destinationChain) ?? new Set<bigint>();
    set.add(BigInt(inb.destinationBlock));
    observedHeightsByChain.set(inb.destinationChain, set);
  }

  const chains: ChainCoverageReport[] = expectedRanges.map((range) => {
    const stored = cursorByChain.get(range.chainKey);
    const cursorPosition = stored?.position ?? null;
    const contractMatches =
      stored === undefined
        ? false
        : range.family === "evm"
          ? stored.contract.toLowerCase() === range.contract.toLowerCase()
          : stored.contract === range.contract;

    const cursorLag =
      cursorPosition === null
        ? range.targetHeight - range.fromHeight + 1n
        : cursorPosition < range.targetHeight
          ? range.targetHeight - cursorPosition
          : 0n;

    const observed = observedHeightsByChain.get(range.chainKey) ?? new Set<bigint>();
    const missingEventHeights = range.expectedEventHeights.filter((h) => !observed.has(h));
    const missingIntervals: BlockInterval[] = [...coalesceHeights(missingEventHeights)];

    const unindexedFrom = cursorPosition === null ? range.fromHeight : cursorPosition + 1n;
    if (unindexedFrom <= range.targetHeight) {
      missingIntervals.push({ from: unindexedFrom, to: range.targetHeight });
    }

    return {
      chainKey: range.chainKey,
      family: range.family,
      cursorPosition,
      targetHeight: range.targetHeight,
      cursorLag,
      contractMatches,
      missingIntervals,
    };
  });

  const digestsMatch = {
    outbound: expectedDigests.outboundDigest === actualDigests.outboundDigest,
    inbound: expectedDigests.inboundDigest === actualDigests.inboundDigest,
    claims: expectedDigests.claimDigest === actualDigests.claimDigest,
    attestations: expectedDigests.attestationDigest === actualDigests.attestationDigest,
    monetaryAndClaims:
      expectedDigests.combinedMonetaryAndClaimDigest ===
      actualDigests.combinedMonetaryAndClaimDigest,
  };

  const allChainsCovered = chains.every(
    (c) => c.contractMatches && c.cursorLag === 0n && c.missingIntervals.length === 0,
  );

  const complete =
    allChainsCovered &&
    digestsMatch.monetaryAndClaims &&
    digestsMatch.attestations &&
    digestMismatches.length === 0 &&
    unbackedDeliveredAttestations.length === 0;

  return {
    complete,
    chains,
    expectedDigests,
    actualDigests,
    digestsMatch,
    digestMismatches,
    unbackedDeliveredAttestations,
    rowCounts: {
      outboundCount: actualSnapshot.outbound.length,
      inboundCount: actualSnapshot.inbound.length,
      claimCount: actualSnapshot.claims.length,
      attestationCount: actualSnapshot.attestations.length,
    },
  };
}

export interface ReplayableStep {
  tick(signal: AbortSignal): Promise<boolean>;
}

export async function replayMissingHistoryIntervals(options: {
  readonly db: Transactional;
  readonly rewindCursors?: readonly {
    readonly chainKey: string;
    readonly rewindToHeight: bigint | null;
    readonly rewindHash?: string | null;
  }[];
  readonly watchers: readonly ReplayableStep[];
  readonly railPasses?: readonly ReplayableStep[];
  readonly maxTicksPerWorker?: number;
}): Promise<{ readonly ticksExecuted: number }> {
  const { db, rewindCursors = [], watchers, railPasses = [], maxTicksPerWorker = 32 } = options;

  if (rewindCursors.length > 0) {
    await db.transaction(async (tx) => {
      for (const item of rewindCursors) {
        if (item.rewindToHeight === null) {
          await tx.query("DELETE FROM indexer_cursor WHERE chain_key = $1", [item.chainKey]);
        } else {
          await tx.query(
            `UPDATE indexer_cursor
                SET last_processed = $2,
                    last_processed_hash = $3,
                    updated_at = now()
              WHERE chain_key = $1`,
            [item.chainKey, item.rewindToHeight.toString(), item.rewindHash ?? null],
          );
        }
      }
    });
  }

  let ticksExecuted = 0;
  for (const watcher of watchers) {
    for (let step = 0; step < maxTicksPerWorker; step += 1) {
      ticksExecuted += 1;
      const more = await watcher.tick(AbortSignal.timeout(10_000));
      if (!more) break;
    }
  }

  for (const pass of railPasses) {
    for (let step = 0; step < maxTicksPerWorker; step += 1) {
      ticksExecuted += 1;
      const more = await pass.tick(AbortSignal.timeout(10_000));
      if (!more) break;
    }
  }

  return { ticksExecuted };
}
