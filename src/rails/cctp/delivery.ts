import {
  CHAINS,
  RAIL_CONTRACTS,
  RouteKind,
  assetOn,
  isChainKey,
  isEvmChain,
  isStellarDeployment,
  toEvmAddress,
} from "@hyperion/protocol";
import { createPublicClient, http, type Hex } from "viem";
import type { AppConfig } from "../../config/config.js";
import type { Queryable, Transactional } from "../../db/pool.js";
import {
  bigintOf,
  bigintOrNull,
  integer,
  text,
  textOrNull,
  timestampOrNull,
} from "../../db/rows.js";
import type { PendingTransfer, RailReport } from "../types.js";
import type { VerifiedDelivery } from "../axelar/delivery.js";
import type { DeliveryLog } from "../axelar/events.js";
import { locateCctpPaymentLogs, type ExpectedCctpTransfer } from "./events.js";

const STELLAR_CCTP_MESSENGER = "CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP";

export interface CctpReceipt {
  readonly status: "success" | "reverted";
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly transactionHash: Hex;
  readonly logs: readonly DeliveryLog[];
}

export interface CctpBlock {
  readonly hash: Hex | null;
  readonly timestamp: bigint;
}

/**
 * Strictly read-only destination RPC interface. Neither verification nor revalidation ever exposes
 * or invokes transaction broadcast, `writeContract`, or Circle mint methods.
 */
export interface CctpReadOnlyEvmClient {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getTransactionReceipt(args: { hash: Hex }): Promise<CctpReceipt>;
  getBlock(args: { blockNumber: bigint }): Promise<CctpBlock>;
}

export type CctpEvmClient = CctpReadOnlyEvmClient;

export interface VerifyCctpDeliveryOptions {
  readonly evmClient?: CctpReadOnlyEvmClient;
}

export type CctpProofRevalidationState = "canonical" | "orphaned" | "reconciled";

export type CctpProofOrphanReason =
  | "block_hash_mismatch"
  | "receipt_missing"
  | "receipt_reverted"
  | "insufficient_confirmations"
  | "payment_logs_missing"
  | "amount_or_token_mismatch";

export interface StoredCctpDeliveryProof {
  readonly transferId: bigint;
  readonly originChain: string;
  readonly sourceNonce: bigint;
  readonly destinationChain: string;
  readonly railMessageId: string;
  readonly rawMessageBytes: string;
  readonly recipient: string;
  readonly tokenAddress: string;
  readonly mintedAmount: bigint;
  readonly txHash: string;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly messageLogIndex: number;
  readonly mintLogIndex: number;
  readonly revalidationState: CctpProofRevalidationState;
  readonly orphanReason: string | null;
  readonly lastCheckedHead: bigint | null;
  readonly revalidatedAt: Date | null;
}

export interface RevalidateCctpOptions {
  readonly destinationChain?: string;
  readonly limit?: number;
  readonly evmClientForChain?: (chainKey: string, defaultRpcUrl: string) => CctpReadOnlyEvmClient;
}

export interface RevalidateCctpSummary {
  readonly checked: number;
  readonly canonical: number;
  readonly orphaned: number;
}

function createDefaultEvmClient(rpcUrl: string): CctpReadOnlyEvmClient {
  const client = createPublicClient({
    transport: http(rpcUrl, { timeout: 15_000, retryCount: 0 }),
  });
  return {
    getChainId: () => client.getChainId(),
    getBlockNumber: () => client.getBlockNumber(),
    getTransactionReceipt: async ({ hash }) => {
      const receipt = await client.getTransactionReceipt({ hash });
      return {
        status: receipt.status,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        transactionHash: receipt.transactionHash,
        logs: receipt.logs,
      };
    },
    getBlock: async ({ blockNumber }) => {
      const block = await client.getBlock({ blockNumber });
      return { hash: block.hash, timestamp: block.timestamp };
    },
  };
}

function resolveExpectedCctpTransfer(
  config: AppConfig,
  destinationChain: string,
  storedOutbound: {
    readonly token: string;
    readonly netAmount: bigint;
    readonly destination: string;
  },
): ExpectedCctpTransfer | null {
  if (!isChainKey(destinationChain)) return null;
  const source = config.deployments.networks["stellar-testnet"];
  const destination = CHAINS[destinationChain];
  const contracts = RAIL_CONTRACTS[destinationChain]?.cctp;
  const token = assetOn(destinationChain, "USDC");
  const sourceToken = source?.tokens.USDC;
  const adapter = source?.adapters[RouteKind.Cctp];
  if (
    !source ||
    !isStellarDeployment(source) ||
    !sourceToken ||
    !("sacId" in sourceToken) ||
    !adapter ||
    !isEvmChain(destination) ||
    !contracts ||
    token?.family !== "evm" ||
    destination.cctpDomain === null ||
    storedOutbound.token !== sourceToken.sacId
  ) {
    return null;
  }
  return {
    sourceToken: sourceToken.sacId,
    sourceAdapter: adapter,
    sourceMessenger: STELLAR_CCTP_MESSENGER,
    destinationDomain: destination.cctpDomain,
    destinationMessenger: contracts.tokenMessengerV2,
    transmitter: contracts.messageTransmitterV2,
    token: token.address,
    recipient: toEvmAddress(storedOutbound.destination as Hex),
    sourceAmount: storedOutbound.netAmount,
  };
}

export async function getCctpDeliveryProof(
  db: Queryable,
  transferId: bigint,
): Promise<StoredCctpDeliveryProof | null> {
  const { rows } = await db.query(
    `SELECT transfer_id, origin_chain, source_nonce, destination_chain, rail_message_id,
            raw_message_bytes, recipient, token_address, minted_amount, tx_hash,
            block_number, block_hash, message_log_index, mint_log_index,
            revalidation_state, orphan_reason, last_checked_head, revalidated_at
       FROM cctp_delivery_proof
      WHERE transfer_id = $1`,
    [transferId.toString()],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    transferId: bigintOf(row, "transfer_id"),
    originChain: text(row, "origin_chain"),
    sourceNonce: bigintOf(row, "source_nonce"),
    destinationChain: text(row, "destination_chain"),
    railMessageId: text(row, "rail_message_id"),
    rawMessageBytes: text(row, "raw_message_bytes"),
    recipient: text(row, "recipient"),
    tokenAddress: text(row, "token_address"),
    mintedAmount: bigintOf(row, "minted_amount"),
    txHash: text(row, "tx_hash"),
    blockNumber: bigintOf(row, "block_number"),
    blockHash: text(row, "block_hash"),
    messageLogIndex: integer(row, "message_log_index"),
    mintLogIndex: integer(row, "mint_log_index"),
    revalidationState: text(row, "revalidation_state") as CctpProofRevalidationState,
    orphanReason: textOrNull(row, "orphan_reason"),
    lastCheckedHead: bigintOrNull(row, "last_checked_head"),
    revalidatedAt: timestampOrNull(row, "revalidated_at"),
  };
}

async function persistConfirmedProof(
  tx: Queryable,
  entry: {
    readonly transferId: bigint;
    readonly originChain: string;
    readonly sourceNonce: bigint;
    readonly destinationChain: string;
    readonly railMessageId: string;
    readonly rawMessageBytes: string;
    readonly recipient: string;
    readonly tokenAddress: string;
    readonly mintedAmount: bigint;
    readonly txHash: string;
    readonly blockNumber: bigint;
    readonly blockHash: string;
    readonly messageLogIndex: number;
    readonly mintLogIndex: number;
    readonly headBlock: bigint;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO cctp_delivery_proof
       (transfer_id, origin_chain, source_nonce, destination_chain, rail_message_id,
        raw_message_bytes, recipient, token_address, minted_amount, tx_hash,
        block_number, block_hash, message_log_index, mint_log_index,
        revalidation_state, orphan_reason, last_checked_head, revalidated_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
             'canonical', NULL, $15, now(), now())
     ON CONFLICT (transfer_id) DO UPDATE
       SET rail_message_id = EXCLUDED.rail_message_id,
           raw_message_bytes = EXCLUDED.raw_message_bytes,
           recipient = EXCLUDED.recipient,
           token_address = EXCLUDED.token_address,
           minted_amount = EXCLUDED.minted_amount,
           tx_hash = EXCLUDED.tx_hash,
           block_number = EXCLUDED.block_number,
           block_hash = EXCLUDED.block_hash,
           message_log_index = EXCLUDED.message_log_index,
           mint_log_index = EXCLUDED.mint_log_index,
           revalidation_state = CASE
             WHEN cctp_delivery_proof.revalidation_state = 'orphaned' THEN 'reconciled'
             ELSE 'canonical'
           END,
           orphan_reason = NULL,
           last_checked_head = EXCLUDED.last_checked_head,
           revalidated_at = now(),
           updated_at = now()`,
    [
      entry.transferId.toString(),
      entry.originChain,
      entry.sourceNonce.toString(),
      entry.destinationChain,
      entry.railMessageId.toLowerCase(),
      entry.rawMessageBytes.toLowerCase(),
      entry.recipient.toLowerCase(),
      entry.tokenAddress.toLowerCase(),
      entry.mintedAmount.toString(),
      entry.txHash.toLowerCase(),
      entry.blockNumber.toString(),
      entry.blockHash.toLowerCase(),
      entry.messageLogIndex,
      entry.mintLogIndex,
      entry.headBlock.toString(),
    ],
  );
}

export async function verifyCctpDelivery(
  config: AppConfig,
  db: Transactional,
  transfer: PendingTransfer,
  report: RailReport,
  options?: VerifyCctpDeliveryOptions,
): Promise<VerifiedDelivery | null> {
  const candidates =
    report.candidateForwardTxHashes && report.candidateForwardTxHashes.length > 0
      ? report.candidateForwardTxHashes
      : report.forwardTxHash
        ? [report.forwardTxHash]
        : [];
  if (
    transfer.route !== RouteKind.Cctp ||
    transfer.originChain !== "stellar-testnet" ||
    candidates.length === 0 ||
    !report.messageBytes ||
    !/^0x[0-9a-fA-F]+$/.test(report.messageBytes) ||
    !isChainKey(transfer.destinationChain)
  ) {
    return null;
  }

  const destination = CHAINS[transfer.destinationChain];
  if (!isEvmChain(destination)) return null;

  const { rows } = await db.query(
    "SELECT token, net_amount, destination FROM outbound_transfer WHERE id = $1",
    [String(transfer.transferId)],
  );
  const stored = rows[0];
  if (!stored) return null;

  const expected = resolveExpectedCctpTransfer(config, transfer.destinationChain, {
    token: text(stored, "token"),
    netAmount: bigintOf(stored, "net_amount"),
    destination: text(stored, "destination"),
  });
  if (!expected) return null;

  const raw = report.messageBytes as Hex;
  const client = options?.evmClient ?? createDefaultEvmClient(destination.defaultRpcUrl);
  if ((await client.getChainId()) !== destination.chainId) {
    throw new Error("CCTP destination RPC chain mismatch.");
  }
  const head = await client.getBlockNumber();

  for (const candidateHash of candidates) {
    let receipt: CctpReceipt;
    try {
      receipt = await client.getTransactionReceipt({ hash: candidateHash });
    } catch {
      continue;
    }
    if (receipt.status !== "success") continue;
    if (head - receipt.blockNumber + 1n < BigInt(destination.confirmations)) continue;
    const located = locateCctpPaymentLogs(receipt.logs, raw, expected);
    if (!located) continue;
    const messageLogIndex = located.messageLog.logIndex;
    const mintLogIndex = located.mintLog.logIndex;
    if (messageLogIndex === null || mintLogIndex === null) continue;
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    if (block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) continue;

    await db
      .transaction((tx) =>
        persistConfirmedProof(tx, {
          transferId: transfer.transferId,
          originChain: transfer.originChain,
          sourceNonce: transfer.nonce,
          destinationChain: transfer.destinationChain,
          railMessageId: located.verified.message.nonce,
          rawMessageBytes: raw,
          recipient: expected.recipient.toLowerCase(),
          tokenAddress: expected.token.toLowerCase(),
          mintedAmount: located.verified.amount,
          txHash: receipt.transactionHash,
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
          messageLogIndex,
          mintLogIndex,
          headBlock: head,
        }),
      )
      .catch(() => undefined);

    return {
      at: {
        chainKey: transfer.destinationChain,
        block: receipt.blockNumber,
        txHash: receipt.transactionHash,
        logIndex: located.mintLog.logIndex,
        observedAt: new Date(Number(block.timestamp) * 1000),
      },
      row: {
        route: transfer.route,
        sourceChain: transfer.originChain,
        sourceNonce: transfer.nonce,
        railMessageId: located.verified.message.nonce,
        recipient: expected.recipient.toLowerCase(),
        token: expected.token.toLowerCase(),
        amount: located.verified.amount,
        delivered: true,
        claimId: null,
      },
    };
  }

  return null;
}

/**
 * Revalidates previously confirmed CCTP destination proofs against later canonical blocks in
 * strictly read-only mode. Orphaned/reorged proofs immediately clear confirmed `inbound_delivery`
 * state and return `rail_attestation` to `'attested'` without invoking any write or mint RPC.
 */
export async function revalidateCctpDeliveries(
  config: AppConfig,
  db: Transactional,
  options?: RevalidateCctpOptions,
): Promise<RevalidateCctpSummary> {
  const limit = Math.max(1, Math.min(options?.limit ?? 50, 500));
  const params: unknown[] = [];
  let chainFilter = "";
  if (options?.destinationChain) {
    params.push(options.destinationChain);
    chainFilter = `AND p.destination_chain = $${String(params.length)}`;
  }
  params.push(limit);

  const { rows } = await db.query(
    `SELECT p.transfer_id, p.origin_chain, p.source_nonce, p.destination_chain,
            p.rail_message_id, p.raw_message_bytes, p.recipient, p.token_address,
            p.minted_amount, p.tx_hash, p.block_number, p.block_hash,
            p.message_log_index, p.mint_log_index, p.revalidation_state,
            t.token AS source_token, t.net_amount AS source_net_amount,
            t.destination AS source_destination
       FROM cctp_delivery_proof p
       JOIN outbound_transfer t ON t.id = p.transfer_id
      WHERE p.revalidation_state IN ('canonical', 'reconciled')
        ${chainFilter}
      ORDER BY p.revalidated_at ASC NULLS FIRST, p.transfer_id ASC
      LIMIT $${String(params.length)}`,
    params,
  );

  let checked = 0;
  let canonical = 0;
  let orphaned = 0;

  for (const row of rows) {
    const transferId = bigintOf(row, "transfer_id");
    const originChain = text(row, "origin_chain");
    const sourceNonce = bigintOf(row, "source_nonce");
    const destinationChain = text(row, "destination_chain");
    const txHash = text(row, "tx_hash") as Hex;
    const storedBlockNumber = bigintOf(row, "block_number");
    const storedBlockHash = text(row, "block_hash").toLowerCase();
    const rawMessageBytes = text(row, "raw_message_bytes") as Hex;
    const storedToken = text(row, "token_address").toLowerCase();
    const storedAmount = bigintOf(row, "minted_amount");

    if (!isChainKey(destinationChain)) continue;
    const destination = CHAINS[destinationChain];
    if (!isEvmChain(destination)) continue;

    const expected = resolveExpectedCctpTransfer(config, destinationChain, {
      token: text(row, "source_token"),
      netAmount: bigintOf(row, "source_net_amount"),
      destination: text(row, "source_destination"),
    });
    if (!expected) continue;

    const client =
      options?.evmClientForChain?.(destinationChain, destination.defaultRpcUrl) ??
      createDefaultEvmClient(destination.defaultRpcUrl);
    if ((await client.getChainId()) !== destination.chainId) {
      throw new Error("CCTP destination RPC chain mismatch during revalidation.");
    }

    checked += 1;
    const head = await client.getBlockNumber();
    const canonicalBlock = await client.getBlock({ blockNumber: storedBlockNumber });

    let receipt: CctpReceipt | null = null;
    try {
      receipt = await client.getTransactionReceipt({ hash: txHash });
    } catch {
      receipt = null;
    }

    let orphanReason: CctpProofOrphanReason | null = null;
    if (canonicalBlock.hash?.toLowerCase() !== storedBlockHash) {
      orphanReason = "block_hash_mismatch";
    } else if (receipt === null) {
      orphanReason = "receipt_missing";
    } else if (
      receipt.status !== "success" ||
      receipt.blockNumber !== storedBlockNumber ||
      receipt.blockHash.toLowerCase() !== storedBlockHash
    ) {
      orphanReason = receipt.status !== "success" ? "receipt_reverted" : "block_hash_mismatch";
    } else if (head - receipt.blockNumber + 1n < BigInt(destination.confirmations)) {
      orphanReason = "insufficient_confirmations";
    } else {
      const located = locateCctpPaymentLogs(receipt.logs, rawMessageBytes, expected);
      if (!located) {
        orphanReason = "payment_logs_missing";
      } else if (
        located.verified.amount !== storedAmount ||
        expected.token.toLowerCase() !== storedToken
      ) {
        orphanReason = "amount_or_token_mismatch";
      }
    }

    if (orphanReason === null) {
      canonical += 1;
      await db.transaction(async (tx) => {
        await tx.query(
          `UPDATE cctp_delivery_proof
              SET orphan_reason = NULL,
                  last_checked_head = $2,
                  revalidated_at = now(),
                  updated_at = now()
            WHERE transfer_id = $1`,
          [transferId.toString(), head.toString()],
        );
      });
    } else {
      orphaned += 1;
      await db.transaction(async (tx) => {
        await tx.query(
          `UPDATE cctp_delivery_proof
              SET revalidation_state = 'orphaned',
                  orphan_reason = $2,
                  last_checked_head = $3,
                  revalidated_at = now(),
                  updated_at = now()
            WHERE transfer_id = $1`,
          [transferId.toString(), orphanReason, head.toString()],
        );
        await tx.query(
          `DELETE FROM inbound_delivery
            WHERE destination_chain = $1
              AND route = $2
              AND source_chain = $3
              AND source_nonce = $4`,
          [destinationChain, RouteKind.Cctp, originChain, sourceNonce.toString()],
        );
        await tx.query(
          `UPDATE rail_attestation
              SET status = 'attested',
                  last_error = $2,
                  updated_at = now()
            WHERE transfer_id = $1
              AND status = 'delivered'`,
          [transferId.toString(), `destination proof orphaned: ${orphanReason}`],
        );
      });
    }
  }

  return { checked, canonical, orphaned };
}
