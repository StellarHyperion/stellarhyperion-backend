import type { KeeperContext } from "../keeper/types.js";
import type { Logger } from "pino";

export interface DigestRecord {
  readonly chain: string;
  readonly range: { from: bigint; to: bigint };
  readonly monetarySum: bigint;
  readonly claimCount: number;
}

export interface ReconciliationResult {
  readonly restored: DigestRecord;
  readonly source: DigestRecord;
  readonly missingIntervals: { from: bigint; to: bigint }[];
  readonly duplicateChecks: { hash: string; alreadyExists: boolean }[];
}

export async function reconcileIndexedHistory(
  ctx: KeeperContext,
  restoredFrom: bigint,
  restoredTo: bigint,
  sourceFrom: bigint,
  sourceTo: bigint,
): Promise<ReconciliationResult> {
  const logger = ctx.logger;
  const chain = ctx.config.indexer.stellar?.chain ?? "unknown";

  const sourceMonetarySum = await ctx.db.query(
    "SELECT COALESCE(SUM(net_amount), 0) AS monetary_sum FROM outbound_transfer WHERE origin_chain = $1 AND origin_block >= $2 AND origin_block <= $3",
    [chain, sourceFrom.toString(), sourceTo.toString()],
  );
  const sourceClaimCount = await ctx.db.query(
    "SELECT COUNT(*) AS claim_count FROM pending_claim WHERE chain = $1",
    [chain],
  );
  const restoredMonetarySum = await ctx.db.query(
    "SELECT COALESCE(SUM(net_amount), 0) AS monetary_sum FROM outbound_transfer_restored WHERE origin_chain = $1 AND origin_block >= $2 AND origin_block <= $3",
    [chain, restoredFrom.toString(), restoredTo.toString()],
  );
  const restoredClaimCount = await ctx.db.query(
    "SELECT COUNT(*) AS claim_count FROM pending_claim_restored WHERE chain = $1",
    [chain],
  );
  const sourceSum = Number(sourceMonetarySum.rows[0]?.monetary_sum ?? 0);
  const restoredSum = Number(restoredMonetarySum.rows[0]?.monetary_sum ?? 0);
  const sourceClaims = Number(sourceClaimCount.rows[0]?.claim_count ?? 0);
  const restoredClaims = Number(restoredClaimCount.rows[0]?.claim_count ?? 0);
  const monetaryMatch = sourceSum === restoredSum;
  const claimCountMatch = sourceClaims === restoredClaims;
  const missingIntervals: { from: bigint; to: bigint }[] = [];
  if (!monetaryMatch || !claimCountMatch) {
    let current = restoredTo;
    while (current > restoredFrom) {
      const prev = current - BigInt(10_000);
      if (prev < restoredFrom) prev = restoredFrom;
      missingIntervals.push({ from: prev, to: current });
      current = prev;
    }
  }
  const duplicateChecks: { hash: string; alreadyExists: boolean }[] = [];
  for (let i = restoredFrom; i <= restoredTo; i += BigInt(1000)) {
    const hash = `${i}-replay`;
    const alreadyExists = await ctx.db.query(
      "SELECT COUNT(*) > 0 AS already_exists FROM outbound_transfer WHERE origin_tx = $1",
      [hash],
    );
    duplicateChecks.push({
      hash,
      alreadyExists: Boolean(alreadyExists.rows[0]?.already_exists),
    });
  }
  logger.info(
    {
      chain,
      restored: { from: restoredFrom, to: restoredTo, monetarySum: restoredSum, claimCount: restoredClaims },
      source: { from: sourceFrom, to: sourceTo, monetarySum: sourceSum, claimCount: sourceClaims },
      missingIntervals: missingIntervals.length,
      duplicateChecks: duplicateChecks.filter((check) => check.alreadyExists).length,
    },
    "indexed-history reconciliation complete",
  );
  return {
    restored: {
      chain,
      range: { from: restoredFrom, to: restoredTo },
      monetarySum: restoredSum,
      claimCount: restoredClaims,
    },
    source: {
      chain,
      range: { from: sourceFrom, to: sourceTo },
      monetarySum: sourceSum,
      claimCount: sourceClaims,
    },
    missingIntervals,
    duplicateChecks,
  };
}
