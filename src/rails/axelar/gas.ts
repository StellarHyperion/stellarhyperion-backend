import { CHAINS, RAIL_CONTRACTS, RouteKind, isChainKey, isEvmChain } from "@hyperion/protocol";
import { createPublicClient, http, type Hex } from "viem";

import { recordAxelarGasScan, writeAxelarGasEvidence } from "../../chains/writers.js";
import type { AppConfig } from "../../config/config.js";
import type { Transactional } from "../../db/pool.js";
import { bigintOf, integerOrNull, text } from "../../db/rows.js";
import { inspectAxelarGasEvidence, type DeliveryLog, type GasLinkTarget } from "./events.js";

export interface AxelarGasReceiptClient {
  getTransactionReceipt(args: {
    readonly hash: Hex;
  }): Promise<{ readonly logs: readonly DeliveryLog[] }>;
}

export interface AxelarGasIngestionOptions {
  readonly signal?: AbortSignal;
  readonly clientForChain?: (chainKey: string) => AxelarGasReceiptClient;
}

export interface AxelarGasIngestionReport {
  readonly scanned: number;
  readonly events: number;
  readonly unresolved: number;
  readonly failed: number;
}

export async function ingestAxelarGasEvidence(
  config: AppConfig,
  db: Transactional,
  limit: number,
  options: AxelarGasIngestionOptions = {},
): Promise<AxelarGasIngestionReport> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new Error("Axelar gas ingestion batch must be between 1 and 1000.");
  const { rows } = await db.query(
    `SELECT DISTINCT ON (t.origin_chain, t.origin_tx) t.origin_chain, t.origin_tx
       FROM outbound_transfer t
      WHERE t.route IN ($1, $2)
        AND NOT EXISTS (
          SELECT 1 FROM axelar_gas_scan s
           WHERE s.origin_chain = t.origin_chain AND s.origin_tx = t.origin_tx
        )
      ORDER BY t.origin_chain, t.origin_tx, t.observed_at DESC
      LIMIT $3`,
    [RouteKind.AxelarIts, RouteKind.AxelarGmp, limit],
  );
  const report = { scanned: 0, events: 0, unresolved: 0, failed: 0 };
  for (const row of rows) {
    options.signal?.throwIfAborted();
    const chain = text(row, "origin_chain");
    const originTx = text(row, "origin_tx");
    if (!isChainKey(chain) || !isEvmChain(CHAINS[chain])) continue;
    const gasService = RAIL_CONTRACTS[chain]?.axelar?.gasService;
    if (
      typeof gasService !== "string" ||
      !gasService.startsWith("0x") ||
      !/^0x[0-9a-fA-F]{64}$/.test(originTx)
    )
      continue;
    const { rows: candidates } = await db.query(
      `SELECT id, origin_tx, origin_log_index, sender, destination_chain, destination
         FROM outbound_transfer
        WHERE origin_chain = $1 AND origin_tx = $2 AND route IN ($3, $4)`,
      [chain, originTx, RouteKind.AxelarIts, RouteKind.AxelarGmp],
    );
    const targets: readonly GasLinkTarget[] = candidates.map((candidate) => ({
      transferId: bigintOf(candidate, "id"),
      originTx: text(candidate, "origin_tx"),
      originLogIndex: integerOrNull(candidate, "origin_log_index"),
      sender: text(candidate, "sender"),
      destinationChain: text(candidate, "destination_chain"),
      destination: text(candidate, "destination"),
    }));
    const configured = config.indexer.evm.find((item) => item.chain === chain);
    const url = configured?.rpcUrls[0] ?? CHAINS[chain].defaultRpcUrl;
    const client =
      options.clientForChain?.(chain) ??
      createPublicClient({
        transport: http(url, {
          timeout: 15_000,
          retryCount: 0,
          ...(options.signal === undefined ? {} : { fetchOptions: { signal: options.signal } }),
        }),
      });
    let receipt: { readonly logs: readonly DeliveryLog[] };
    try {
      receipt = await client.getTransactionReceipt({ hash: originTx as Hex });
    } catch {
      report.failed += 1;
      continue;
    }
    const records = inspectAxelarGasEvidence(receipt.logs, gasService, originTx, targets);
    await db.transaction(async (tx) => {
      for (const record of records) {
        await writeAxelarGasEvidence(tx, {
          transferId: record.transferId,
          originChain: chain,
          sourceTxHash: originTx,
          sourceLogIndex: record.sourceLogIndex,
          sourceEvent: record.eventName,
          eventSignature: record.eventSignature,
          eventKind: record.kind,
          linkBasis: record.linkBasis,
          native: record.native,
          gasToken: record.gasToken,
          amount: record.amount,
          refundAddress: record.refundAddress,
          referenceTxHash: record.referenceTxHash,
          referenceLogIndex: record.referenceLogIndex,
          candidateCount: record.candidateCount,
          payload: record.payload,
        });
      }
      await recordAxelarGasScan(tx, {
        originChain: chain,
        originTx,
        eventCount: records.length,
        unresolvedCount: records.filter((record) => record.transferId === null).length,
      });
    });
    report.scanned += 1;
    report.events += records.length;
    report.unresolved += records.filter((record) => record.transferId === null).length;
  }
  return report;
}
