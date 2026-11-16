import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { AddressKind, encodeStellarAddress } from "@hyperion/protocol";

import {
  settleAction,
  settleClaim,
  writeAction,
  writeAttestation,
  writeClaim,
  writeHealthSample,
  writeInbound,
  writeOutbound,
  type InboundRow,
  type OutboundRow,
  type Position,
} from "../src/chains/writers.js";
import type { Queryable, QueryResultRows, Transactional } from "../src/db/pool.js";
import { outstandingForRail, pendingForRail } from "../src/rails/queue.js";

const MIGRATION_FILES = [
  "1790900000000_initial-schema.sql",
  "1791000000000_cursor-block-hash.sql",
  "1791100000000_cursor-autovacuum-tuning.sql",
] as const;

export type BenchmarkScaleName = "small" | "medium";

export interface BenchmarkScaleConfig {
  readonly name: BenchmarkScaleName | "custom";
  readonly seed: number;
  readonly outboundCount: number;
  readonly senderPoolSize: number;
  readonly recipientPoolSize: number;
  readonly adminActionCount: number;
  readonly healthSampleCount: number;
  readonly replayWindowSize: number;
  readonly queryIterations: number;
}

export const BENCHMARK_SCALES: Readonly<Record<BenchmarkScaleName, BenchmarkScaleConfig>> = {
  small: {
    name: "small",
    seed: 0x1420_0001,
    outboundCount: 100,
    senderPoolSize: 25,
    recipientPoolSize: 25,
    adminActionCount: 12,
    healthSampleCount: 24,
    replayWindowSize: 12,
    queryIterations: 5,
  },
  medium: {
    name: "medium",
    seed: 0x1420_0002,
    outboundCount: 240,
    senderPoolSize: 50,
    recipientPoolSize: 50,
    adminActionCount: 24,
    healthSampleCount: 48,
    replayWindowSize: 24,
    queryIterations: 7,
  },
};

export interface BenchmarkThresholds {
  readonly defaultQueryMaxP95Ms: number;
  readonly ingestionBatchMaxMs: number;
  readonly replayWindowMaxMs: number;
  readonly perOperationMaxP95Ms?: Readonly<Record<string, number>>;
}

export const DEFAULT_BENCHMARK_THRESHOLDS: BenchmarkThresholds = {
  defaultQueryMaxP95Ms: 500,
  ingestionBatchMaxMs: 15_000,
  replayWindowMaxMs: 5_000,
};

export interface PlanNodeSummary {
  readonly nodeType: string;
  readonly relationName: string | null;
  readonly indexName: string | null;
  readonly totalCost: number | null;
  readonly planRows: number | null;
}

export interface QueryBenchmarkMeasurement {
  readonly operation: string;
  readonly iterations: number;
  readonly minMs: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly maxAllowedP95Ms: number;
  readonly lastRowCount: number;
  readonly planNodes: readonly PlanNodeSummary[];
}

export interface PlanRegression {
  readonly operation: string;
  readonly reason: string;
  readonly planNodes: readonly PlanNodeSummary[];
}

export interface LatencyRegression {
  readonly operation: string;
  readonly observedMs: number;
  readonly thresholdMs: number;
}

export interface GeneratedHistorySummary {
  readonly outboundTransfers: number;
  readonly inboundDeliveries: number;
  readonly pendingClaimsTotal: number;
  readonly pendingClaimsUnsettled: number;
  readonly railAttestationsTotal: number;
  readonly railAttestationsActive: number;
  readonly adminActions: number;
  readonly routeHealthSamples: number;
  readonly sampleSenderStellar: string;
  readonly sampleSenderEvm: string;
  readonly sampleOriginChain: string;
  readonly sampleNonce: bigint;
  readonly sampleHighBlock: bigint;
}

export interface BenchmarkReport {
  readonly passed: boolean;
  readonly scale: string;
  readonly seed: number;
  readonly history: GeneratedHistorySummary;
  readonly initialIngestionMs: number;
  readonly replayIngestionMs: number;
  readonly measurements: readonly QueryBenchmarkMeasurement[];
  readonly planRegressions: readonly PlanRegression[];
  readonly latencyRegressions: readonly LatencyRegression[];
}

export interface DedicatedBenchmarkDb extends Transactional {
  close(): Promise<void>;
}

/** Deterministic Mulberry32 PRNG -- never touches Math.random(). */
export function createDeterministicPrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function deterministicHex(nextFloat: () => number, byteLength: number): `0x${string}` {
  const parts: string[] = [];
  for (let i = 0; i < byteLength; i += 1) {
    const byte = Math.floor(nextFloat() * 256) & 0xff;
    parts.push(byte.toString(16).padStart(2, "0"));
  }
  return `0x${parts.join("")}`;
}

export async function applyBenchmarkMigrations(db: Queryable): Promise<void> {
  for (const file of MIGRATION_FILES) {
    const fullPath = fileURLToPath(new URL(`../migrations/${file}`, import.meta.url));
    const sql = readFileSync(fullPath, "utf8").split(/^--\s*Down Migration\b/m)[0] ?? "";
    await db.query(sql);
  }
}

export async function createDedicatedBenchmarkPGliteDb(): Promise<DedicatedBenchmarkDb> {
  const pg = new PGlite();
  let txLock: Promise<void> = Promise.resolve();

  const runQuery = async (
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResultRows> => {
    const normalized = params.map((p) => (p instanceof Date ? p.toISOString() : p));
    const result =
      normalized.length === 0 && sql.includes(";")
        ? await (async () => {
            await pg.exec(sql);
            return { rows: [], fields: [], affectedRows: 0 };
          })()
        : await pg.query(sql, normalized);

    const int8Cols = result.fields.filter((f) => f.dataTypeID === 20).map((f) => f.name);
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
    return { rows, rowCount: result.affectedRows ?? rows.length };
  };

  const db: DedicatedBenchmarkDb = {
    query: runQuery,
    async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
      const prev = txLock;
      let release!: () => void;
      txLock = new Promise<void>((resolve) => {
        release = resolve;
      });
      await prev;
      await pg.exec("BEGIN");
      try {
        const out = await work({ query: runQuery });
        await pg.exec("COMMIT");
        return out;
      } catch (err) {
        await pg.exec("ROLLBACK");
        throw err;
      } finally {
        release();
      }
    },
    async close(): Promise<void> {
      await pg.close();
    },
  };

  await applyBenchmarkMigrations(db);
  return db;
}

interface ReplayableRecord {
  readonly outboundAt: Position;
  readonly outboundRow: OutboundRow;
  readonly inbound?: { readonly at: Position; readonly row: InboundRow };
}

interface SeededWorkload {
  readonly summary: GeneratedHistorySummary;
  readonly initialIngestionMs: number;
  readonly replayWindow: readonly ReplayableRecord[];
}

export async function generateDeterministicBenchmarkHistory(
  db: Transactional,
  scale: BenchmarkScaleConfig,
): Promise<SeededWorkload> {
  const rand = createDeterministicPrng(scale.seed);
  const baseTimeMs = Date.parse("2026-10-16T00:00:00.000Z");

  // Pre-build realistic address pools with valid CRC16 Stellar strkeys and 20-byte EVM addresses.
  const stellarSenders: string[] = [];
  const evmSenders: string[] = [];
  for (let i = 0; i < scale.senderPoolSize; i += 1) {
    const kind = i % 5 === 0 ? AddressKind.Contract : AddressKind.Account;
    stellarSenders.push(encodeStellarAddress(kind, deterministicHex(rand, 32)));
    evmSenders.push(deterministicHex(rand, 20));
  }

  const stellarRecipients: string[] = [];
  const evmRecipientWords: string[] = [];
  const evmRecipients: string[] = [];
  for (let i = 0; i < scale.recipientPoolSize; i += 1) {
    stellarRecipients.push(encodeStellarAddress(AddressKind.Account, deterministicHex(rand, 32)));
    const evmAddr = deterministicHex(rand, 20);
    evmRecipients.push(evmAddr);
    evmRecipientWords.push(`0x${"0".repeat(24)}${evmAddr.slice(2)}`);
  }

  const stellarToken = encodeStellarAddress(AddressKind.Contract, deterministicHex(rand, 32));
  const evmToken = deterministicHex(rand, 20);
  const stellarRouter = encodeStellarAddress(AddressKind.Contract, deterministicHex(rand, 32));
  const evmRouter = deterministicHex(rand, 20);

  // Start nonces on sepolia above signed int64 max (2^63) for the final slice to prove NUMERIC(20,0) safety.
  const u64HighBase = 9_223_372_036_854_775_900n;
  let stellarNonce = 1n;
  let evmNonce = 1n;
  let nextClaimId = 1_000n;

  let inboundDeliveries = 0;
  let pendingClaimsTotal = 0;
  let pendingClaimsUnsettled = 0;
  let railAttestationsTotal = 0;
  let railAttestationsActive = 0;

  const replayWindow: ReplayableRecord[] = [];
  const startPerf = performance.now();

  await db.transaction(async (tx) => {
    for (let i = 0; i < scale.outboundCount; i += 1) {
      const fromStellar = i % 2 === 0;
      const originChain = fromStellar ? "stellar-testnet" : "sepolia";
      const destinationChain = fromStellar ? "sepolia" : "stellar-testnet";
      const route = i % 4;

      const useHighU64 = !fromStellar && i >= scale.outboundCount - 8;
      const nonce = fromStellar
        ? stellarNonce++
        : useHighU64
          ? u64HighBase + BigInt(i)
          : evmNonce++;

      const senderIdx = i % scale.senderPoolSize;
      const recipientIdx = (i * 7 + 3) % scale.recipientPoolSize;

      const sender = fromStellar
        ? (stellarSenders[senderIdx] ?? stellarSenders[0] ?? "")
        : (evmSenders[senderIdx] ?? evmSenders[0] ?? "");
      const token = fromStellar ? stellarToken : evmToken;
      const destination = fromStellar
        ? (evmRecipientWords[recipientIdx] ?? evmRecipientWords[0] ?? "")
        : (stellarRecipients[recipientIdx] ?? stellarRecipients[0] ?? "");
      const inboundRecipient = fromStellar
        ? (evmRecipients[recipientIdx] ?? evmRecipients[0] ?? "")
        : (stellarRecipients[recipientIdx] ?? stellarRecipients[0] ?? "");
      const inboundToken = fromStellar ? evmToken : stellarToken;

      // Exercise wide uint256 NUMERIC(78,0) values alongside standard 6- and 18-decimal amounts.
      const wideMultiplier = i % 17 === 0 ? 10n ** 28n : 1_000_000n;
      const netAmount = BigInt(100 + (i % 9_000)) * wideMultiplier;
      const fee = BigInt(1 + (i % 25)) * (wideMultiplier / 100n > 0n ? wideMultiplier / 100n : 1n);
      const grossAmount = netAmount + fee;

      const originBlock = fromStellar ? 5_000_000n + BigInt(i * 2) : 18_000_000n + BigInt(i * 3);
      const observedAt = new Date(baseTimeMs + i * 15_000);
      const originTx = deterministicHex(rand, 32);

      const outboundAt: Position = {
        chainKey: originChain,
        block: originBlock,
        txHash: originTx,
        logIndex: fromStellar ? null : i % 6,
        observedAt,
      };
      const outboundRow: OutboundRow = {
        route,
        nonce,
        sender,
        token,
        grossAmount,
        fee,
        netAmount,
        destinationChain,
        destination,
        railRef: route === 0 ? null : deterministicHex(rand, 32),
      };

      await writeOutbound(tx, outboundAt, outboundRow);
      const transferId = BigInt(i + 1);

      // Realistic lifecycle distribution so partial indexes remain selective (~12% active):
      // - 72% delivered directly on destination chain (inbound_delivery + rail_attestation='delivered')
      // - 13% parked as pending_claim (10% settled, 3% unsettled outstanding!)
      // - 9% in-flight rail_attestation ('pending' or 'attested') with NO inbound_delivery
      // - 6% terminal failed/expired rail_attestation with NO inbound_delivery
      const bucket = i % 100;
      let recordedInbound: { readonly at: Position; readonly row: InboundRow } | undefined;

      if (bucket < 72) {
        const destAt: Position = {
          chainKey: destinationChain,
          block: originBlock + 10n,
          txHash: deterministicHex(rand, 32),
          logIndex: fromStellar ? 0 : null,
          observedAt: new Date(observedAt.getTime() + 20_000),
        };
        const inboundRow: InboundRow = {
          route,
          sourceChain: originChain,
          sourceNonce: nonce,
          railMessageId: fromStellar ? deterministicHex(rand, 32) : null,
          recipient: inboundRecipient,
          token: inboundToken,
          amount: netAmount,
          delivered: true,
          claimId: null,
        };
        await writeInbound(tx, destAt, inboundRow);
        recordedInbound = { at: destAt, row: inboundRow };
        inboundDeliveries += 1;

        await writeAttestation(tx, {
          transferId,
          route,
          status: "delivered",
          railStatus: route === 0 ? "complete" : "executed",
          railReference: `ref-${String(i)}`,
          attestedAt: new Date(observedAt.getTime() + 10_000),
          checkedAt: new Date(observedAt.getTime() + 25_000),
          checkFailures: 0,
          lastError: null,
        });
        railAttestationsTotal += 1;
      } else if (bucket < 85) {
        const claimId = nextClaimId++;
        const destAt: Position = {
          chainKey: destinationChain,
          block: originBlock + 12n,
          txHash: deterministicHex(rand, 32),
          logIndex: fromStellar ? 1 : null,
          observedAt: new Date(observedAt.getTime() + 22_000),
        };
        const inboundRow: InboundRow = {
          route,
          sourceChain: originChain,
          sourceNonce: nonce,
          railMessageId: fromStellar ? deterministicHex(rand, 32) : null,
          recipient: inboundRecipient,
          token: inboundToken,
          amount: netAmount,
          delivered: false,
          claimId,
        };
        await writeInbound(tx, destAt, inboundRow);
        recordedInbound = { at: destAt, row: inboundRow };
        inboundDeliveries += 1;

        await writeClaim(tx, destAt, {
          claimId,
          recipient: inboundRecipient,
          token: inboundToken,
          amount: netAmount,
          route,
          sourceChain: originChain,
          sourceNonce: nonce,
          createdAt: destAt.observedAt,
        });
        pendingClaimsTotal += 1;

        if (bucket < 82) {
          await settleClaim(
            tx,
            {
              chainKey: destinationChain,
              block: originBlock + 25n,
              txHash: deterministicHex(rand, 32),
              logIndex: fromStellar ? 2 : null,
              observedAt: new Date(observedAt.getTime() + 60_000),
            },
            claimId,
            inboundRecipient,
          );
        } else {
          pendingClaimsUnsettled += 1;
        }

        await writeAttestation(tx, {
          transferId,
          route,
          status: "delivered",
          railStatus: route === 0 ? "complete" : "executed",
          railReference: `ref-${String(i)}`,
          attestedAt: new Date(observedAt.getTime() + 10_000),
          checkedAt: new Date(observedAt.getTime() + 25_000),
          checkFailures: 0,
          lastError: null,
        });
        railAttestationsTotal += 1;
      } else if (bucket < 94) {
        const activeStatus = bucket % 2 === 0 ? "pending" : "attested";
        await writeAttestation(tx, {
          transferId,
          route,
          status: activeStatus,
          railStatus: activeStatus === "pending" ? "pending_confirmations" : "approved",
          railReference: activeStatus === "attested" ? `ref-${String(i)}` : null,
          attestedAt: activeStatus === "attested" ? new Date(observedAt.getTime() + 8_000) : null,
          checkedAt: new Date(observedAt.getTime() + 5_000),
          checkFailures: i % 3 === 0 ? 1 : 0,
          lastError: i % 3 === 0 ? "upstream timeout" : null,
        });
        railAttestationsTotal += 1;
        railAttestationsActive += 1;
      } else {
        const terminalFailure = bucket % 2 === 0 ? "failed" : "expired";
        await writeAttestation(tx, {
          transferId,
          route,
          status: terminalFailure,
          railStatus: terminalFailure,
          railReference: `ref-fail-${String(i)}`,
          attestedAt: null,
          checkedAt: new Date(observedAt.getTime() + 30_000),
          checkFailures: 2,
          lastError: "fatal destination error",
        });
        railAttestationsTotal += 1;
      }

      if (replayWindow.length < scale.replayWindowSize) {
        replayWindow.push(
          recordedInbound !== undefined
            ? { outboundAt, outboundRow, inbound: recordedInbound }
            : { outboundAt, outboundRow },
        );
      }
    }

    for (let a = 0; a < scale.adminActionCount; a += 1) {
      const chainKey = a % 2 === 0 ? "stellar-testnet" : "sepolia";
      const actionId = BigInt(a + 1);
      const queuedAt = new Date(baseTimeMs + a * 60_000);
      const at: Position = {
        chainKey,
        block: 5_100_000n + BigInt(a),
        txHash: deterministicHex(rand, 32),
        logIndex: chainKey === "sepolia" ? 0 : null,
        observedAt: queuedAt,
      };
      await writeAction(tx, at, {
        actionId,
        kind: a % 4,
        payload: { kind: "SetPause", paused: a % 2 === 0 },
        eta: new Date(queuedAt.getTime() + 3_600_000),
        expiresAt: new Date(queuedAt.getTime() + 86_400_000),
      });
      if (a % 3 !== 0) {
        await settleAction(
          tx,
          { ...at, block: at.block + 20n, observedAt: new Date(queuedAt.getTime() + 4_000_000) },
          actionId,
          a % 2 === 0 ? "executed" : "cancelled",
          evmSenders[0] ?? null,
        );
      }
    }

    for (let h = 0; h < scale.healthSampleCount; h += 1) {
      const fromStellar = h % 2 === 0;
      await writeHealthSample(
        tx,
        {
          chainKey: fromStellar ? "stellar-testnet" : "sepolia",
          block: 5_200_000n + BigInt(h),
          txHash: deterministicHex(rand, 32),
          logIndex: null,
          observedAt: new Date(baseTimeMs + h * 30_000),
        },
        {
          originChain: fromStellar ? "stellar-testnet" : "sepolia",
          destinationChain: fromStellar ? "sepolia" : "stellar-testnet",
          route: h % 4,
          token: fromStellar ? stellarToken : evmToken,
          available: h % 7 !== 0,
          blocker: h % 7 === 0 ? 2 : 0,
          flowAvailable: 50_000_000_000n,
        },
      );
    }

    await tx.query(
      `INSERT INTO indexer_cursor (chain_key, family, contract, last_processed, last_processed_hash, last_processed_at)
       VALUES
         ('stellar-testnet', 'stellar', $1, $2, NULL, $5),
         ('sepolia', 'evm', $3, $4, $6, $5)
       ON CONFLICT (chain_key) DO UPDATE
         SET last_processed = EXCLUDED.last_processed,
             last_processed_hash = EXCLUDED.last_processed_hash,
             last_processed_at = EXCLUDED.last_processed_at`,
      [
        stellarRouter,
        String(5_000_000 + scale.outboundCount * 2),
        evmRouter,
        String(18_000_000 + scale.outboundCount * 3),
        new Date(baseTimeMs + scale.outboundCount * 15_000),
        deterministicHex(rand, 32),
      ],
    );
  });

  const initialIngestionMs = performance.now() - startPerf;
  await db.query("ANALYZE");

  const highBlockOffset = Math.max(0, scale.outboundCount - 20) * 2;
  return {
    summary: {
      outboundTransfers: scale.outboundCount,
      inboundDeliveries,
      pendingClaimsTotal,
      pendingClaimsUnsettled,
      railAttestationsTotal,
      railAttestationsActive,
      adminActions: scale.adminActionCount,
      routeHealthSamples: scale.healthSampleCount,
      sampleSenderStellar: stellarSenders[0] ?? "",
      sampleSenderEvm: evmSenders[0] ?? "",
      sampleOriginChain: "stellar-testnet",
      sampleNonce: 1n,
      sampleHighBlock: 5_000_000n + BigInt(highBlockOffset),
    },
    initialIngestionMs,
    replayWindow,
  };
}

interface RawExplainNode {
  readonly "Node Type"?: unknown;
  readonly "Relation Name"?: unknown;
  readonly "Index Name"?: unknown;
  readonly "Total Cost"?: unknown;
  readonly "Plan Rows"?: unknown;
  readonly Plans?: readonly RawExplainNode[];
}

function collectPlanNodes(node: RawExplainNode, out: PlanNodeSummary[]): void {
  if (typeof node["Node Type"] === "string") {
    out.push({
      nodeType: node["Node Type"],
      relationName: typeof node["Relation Name"] === "string" ? node["Relation Name"] : null,
      indexName: typeof node["Index Name"] === "string" ? node["Index Name"] : null,
      totalCost: typeof node["Total Cost"] === "number" ? node["Total Cost"] : null,
      planRows: typeof node["Plan Rows"] === "number" ? node["Plan Rows"] : null,
    });
  }
  if (Array.isArray(node.Plans)) {
    for (const child of node.Plans) {
      collectPlanNodes(child, out);
    }
  }
}

export async function explainQueryPlan(
  db: Transactional,
  sql: string,
  params: readonly unknown[],
): Promise<readonly PlanNodeSummary[]> {
  return db.transaction(async (tx) => {
    // Evaluate access paths under SSD planner cost parameters so small/medium deterministic scales
    // pick available btree and partial indexes consistently across PGlite and PostgreSQL, while any
    // missing/dropped index or non-sargable predicate still surfaces immediately as a Seq Scan!
    await tx.query("SET LOCAL random_page_cost = 1.1");
    await tx.query("SET LOCAL enable_seqscan = off");
    const { rows } = await tx.query(`EXPLAIN (FORMAT JSON) ${sql}`, params);
    const firstRow = rows[0] ?? {};
    const rawPlan = firstRow["QUERY PLAN"];
    const parsed: unknown = typeof rawPlan === "string" ? JSON.parse(rawPlan) : rawPlan;
    const nodes: PlanNodeSummary[] = [];
    if (Array.isArray(parsed) && parsed.length > 0) {
      const top = parsed[0] as { Plan?: RawExplainNode };
      if (top.Plan !== undefined) {
        collectPlanNodes(top.Plan, nodes);
      }
    }
    return nodes;
  });
}

function computePercentile(sortedAsc: readonly number[], percentile: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((percentile / 100) * sortedAsc.length) - 1),
  );
  return sortedAsc[idx] ?? 0;
}

interface BenchmarkQuerySpec {
  readonly operation: string;
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly forbiddenSeqScanRelations: readonly string[];
  readonly requiredAnyIndexNames?: readonly string[];
  readonly execute?: () => Promise<number>;
}

export async function runDatabaseLoadBenchmark(
  db: Transactional,
  options: {
    readonly scale?: BenchmarkScaleName | BenchmarkScaleConfig;
    readonly thresholds?: Partial<BenchmarkThresholds>;
  } = {},
): Promise<BenchmarkReport> {
  const scaleConfig: BenchmarkScaleConfig =
    typeof options.scale === "string"
      ? BENCHMARK_SCALES[options.scale]
      : (options.scale ?? BENCHMARK_SCALES.small);

  const thresholds: BenchmarkThresholds = {
    ...DEFAULT_BENCHMARK_THRESHOLDS,
    ...options.thresholds,
  };

  const { summary, initialIngestionMs, replayWindow } = await generateDeterministicBenchmarkHistory(
    db,
    scaleConfig,
  );

  // Measure idempotent replay ingestion of an already-indexed window and verify zero duplicate rows.
  const beforeReplayCount = await db.query("SELECT count(*)::int AS n FROM outbound_transfer");
  const replayStart = performance.now();
  await db.transaction(async (tx) => {
    for (const item of replayWindow) {
      await writeOutbound(tx, item.outboundAt, item.outboundRow);
      if (item.inbound !== undefined) {
        await writeInbound(tx, item.inbound.at, item.inbound.row);
      }
    }
  });
  const replayIngestionMs = performance.now() - replayStart;
  const afterReplayCount = await db.query("SELECT count(*)::int AS n FROM outbound_transfer");
  if ((beforeReplayCount.rows[0]?.n as number) !== (afterReplayCount.rows[0]?.n as number)) {
    throw new Error("Replay ingestion duplicated outbound_transfer rows");
  }

  const recheckCutoff = new Date("2026-10-17T00:00:00.000Z");

  const specs: readonly BenchmarkQuerySpec[] = [
    {
      operation: "transfer_by_origin_nonce",
      sql: `SELECT t.id, t.origin_chain, t.route, t.nonce, t.gross_amount, t.fee, t.net_amount,
                   a.status AS attestation_status, d.delivered AS inbound_delivered
              FROM outbound_transfer t
              LEFT JOIN rail_attestation a ON a.transfer_id = t.id
              LEFT JOIN inbound_delivery d
                ON d.destination_chain = t.destination_chain
               AND d.route = t.route
               AND d.source_chain = t.origin_chain
               AND d.source_nonce = t.nonce
             WHERE t.origin_chain = $1 AND t.nonce = $2
             LIMIT 1`,
      params: [summary.sampleOriginChain, summary.sampleNonce.toString()],
      forbiddenSeqScanRelations: ["outbound_transfer", "inbound_delivery", "rail_attestation"],
      requiredAnyIndexNames: ["outbound_transfer_identity"],
    },
    {
      operation: "transfers_by_sender",
      sql: `SELECT id, origin_chain, route, nonce, gross_amount, fee, net_amount, observed_at
              FROM outbound_transfer
             WHERE origin_chain = $1 AND sender = $2
             ORDER BY observed_at DESC
             LIMIT 20`,
      params: ["stellar-testnet", summary.sampleSenderStellar],
      forbiddenSeqScanRelations: ["outbound_transfer"],
      requiredAnyIndexNames: ["outbound_transfer_by_sender"],
    },
    {
      operation: "reorg_position_scan",
      sql: `SELECT id, nonce, origin_block, origin_tx
              FROM outbound_transfer
             WHERE origin_chain = $1 AND origin_block >= $2
             ORDER BY origin_block DESC
             LIMIT 25`,
      params: ["stellar-testnet", summary.sampleHighBlock.toString()],
      forbiddenSeqScanRelations: ["outbound_transfer"],
      requiredAnyIndexNames: ["outbound_transfer_by_position"],
    },
    {
      operation: "outstanding_claims_scan",
      sql: `SELECT chain, claim_id, recipient, token, amount, created_at
              FROM pending_claim
             WHERE chain = $1 AND NOT settled
             ORDER BY created_at ASC
             LIMIT 20`,
      params: ["sepolia"],
      forbiddenSeqScanRelations: ["pending_claim"],
      requiredAnyIndexNames: ["pending_claim_outstanding"],
    },
    {
      operation: "rail_attestation_partial_poll",
      sql: `SELECT transfer_id, route, status, last_checked_at, check_failures
              FROM rail_attestation
             WHERE route = $1 AND status IN ('pending', 'attested')
             ORDER BY last_checked_at NULLS FIRST
             LIMIT 20`,
      params: [1],
      forbiddenSeqScanRelations: ["rail_attestation"],
      requiredAnyIndexNames: ["rail_attestation_outstanding"],
    },
    {
      operation: "proof_backlog_queue_scan",
      sql: `SELECT t.id, t.route, t.origin_chain, t.destination_chain, t.nonce, t.origin_tx,
                   a.status, COALESCE(a.check_failures, 0) AS check_failures
              FROM outbound_transfer t
              LEFT JOIN rail_attestation a ON a.transfer_id = t.id
             WHERE t.route = $1
               AND (a.transfer_id IS NULL OR a.status IN ('pending', 'attested'))
               AND COALESCE(a.check_failures, 0) < $2
               AND (a.last_checked_at IS NULL OR a.last_checked_at < $3)
             ORDER BY a.last_checked_at NULLS FIRST, t.id
             LIMIT $4`,
      params: [1, 5, recheckCutoff, 20],
      forbiddenSeqScanRelations: ["rail_attestation"],
      execute: async () => {
        const queued = await pendingForRail(db, {
          route: 1,
          limit: 20,
          notCheckedSince: recheckCutoff,
          maxCheckFailures: 5,
        });
        const backlog = await outstandingForRail(db, 1);
        return queued.length + backlog;
      },
    },
  ];

  const measurements: QueryBenchmarkMeasurement[] = [];
  const planRegressions: PlanRegression[] = [];
  const latencyRegressions: LatencyRegression[] = [];

  if (initialIngestionMs > thresholds.ingestionBatchMaxMs) {
    latencyRegressions.push({
      operation: "ingestion_initial_batch",
      observedMs: initialIngestionMs,
      thresholdMs: thresholds.ingestionBatchMaxMs,
    });
  }
  if (replayIngestionMs > thresholds.replayWindowMaxMs) {
    latencyRegressions.push({
      operation: "ingestion_replay_window",
      observedMs: replayIngestionMs,
      thresholdMs: thresholds.replayWindowMaxMs,
    });
  }

  for (const spec of specs) {
    const planNodes = await explainQueryPlan(db, spec.sql, spec.params);

    for (const forbiddenRel of spec.forbiddenSeqScanRelations) {
      const seqNode = planNodes.find(
        (n) => n.nodeType === "Seq Scan" && n.relationName === forbiddenRel,
      );
      if (seqNode !== undefined) {
        planRegressions.push({
          operation: spec.operation,
          reason: `Sequential scan detected on ${forbiddenRel}`,
          planNodes,
        });
      }
    }

    if (spec.requiredAnyIndexNames !== undefined && spec.requiredAnyIndexNames.length > 0) {
      const usedIndexes = new Set(
        planNodes.map((n) => n.indexName).filter((idx): idx is string => idx !== null),
      );
      const matched = spec.requiredAnyIndexNames.some((expected) => usedIndexes.has(expected));
      if (!matched) {
        planRegressions.push({
          operation: spec.operation,
          reason: `Expected one of indexes [${spec.requiredAnyIndexNames.join(", ")}], got [${[...usedIndexes].join(", ")}]`,
          planNodes,
        });
      }
    }

    // Warmup execution
    if (spec.execute !== undefined) {
      await spec.execute();
    } else {
      await db.query(spec.sql, spec.params);
    }

    const samples: number[] = [];
    let lastRowCount = 0;
    for (let iter = 0; iter < scaleConfig.queryIterations; iter += 1) {
      const t0 = performance.now();
      if (spec.execute !== undefined) {
        lastRowCount = await spec.execute();
      } else {
        const res = await db.query(spec.sql, spec.params);
        lastRowCount = res.rows.length;
      }
      samples.push(performance.now() - t0);
    }

    samples.sort((a, b) => a - b);
    const minMs = samples[0] ?? 0;
    const medianMs = computePercentile(samples, 50);
    const p95Ms = computePercentile(samples, 95);
    const maxMs = samples[samples.length - 1] ?? 0;
    const maxAllowedP95Ms =
      thresholds.perOperationMaxP95Ms?.[spec.operation] ?? thresholds.defaultQueryMaxP95Ms;

    if (p95Ms > maxAllowedP95Ms) {
      latencyRegressions.push({
        operation: spec.operation,
        observedMs: p95Ms,
        thresholdMs: maxAllowedP95Ms,
      });
    }

    measurements.push({
      operation: spec.operation,
      iterations: scaleConfig.queryIterations,
      minMs,
      medianMs,
      p95Ms,
      maxMs,
      maxAllowedP95Ms,
      lastRowCount,
      planNodes,
    });
  }

  return {
    passed: planRegressions.length === 0 && latencyRegressions.length === 0,
    scale: scaleConfig.name,
    seed: scaleConfig.seed,
    history: summary,
    initialIngestionMs,
    replayIngestionMs,
    measurements,
    planRegressions,
    latencyRegressions,
  };
}
