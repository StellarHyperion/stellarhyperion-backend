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
import type { AppConfig, CctpRetentionConfig } from "../../config/config.js";
import type { Queryable, Transactional } from "../../db/pool.js";
import {
  bigintOf,
  bigintOrNull,
  boolean,
  integer,
  integerOrNull,
  text,
  textOrNull,
  timestampOrNull,
} from "../../db/rows.js";
import type { PendingTransfer, RailReport } from "../types.js";
import type { VerifiedDelivery } from "../axelar/delivery.js";
import type { DeliveryLog } from "../axelar/events.js";
import {
  matchCctpReceiptEvidence,
  verifiedCctpMessage,
  type ExpectedCctpTransfer,
  type VerifiedCctpMessageDetail,
} from "./events.js";
import { sanitizePublicHexArtifact } from "./iris.js";

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

export interface CctpEvmClient {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getTransactionReceipt(args: { hash: Hex }): Promise<CctpReceipt>;
  getBlock(args: { blockNumber: bigint }): Promise<CctpBlock>;
}

export interface VerifyCctpDeliveryOptions {
  readonly evmClient?: CctpEvmClient;
  readonly recordedAt?: Date;
}

export interface CctpVerificationAssumptions {
  readonly sourceToken: string;
  readonly sourceAdapter: string;
  readonly sourceMessenger: string;
  readonly destinationChain: string;
  readonly destinationChainId: number;
  readonly destinationDomain: number;
  readonly destinationMessenger: string;
  readonly messageTransmitter: string;
  readonly destinationToken: string;
  readonly recipient: string;
  readonly sourceAmount: string;
  readonly confirmationsRequired: number;
  readonly headBlockAtVerification: string | null;
  readonly minFinalityThreshold: number;
}

export interface CctpAuditReconstruction {
  readonly transferId: bigint;
  readonly originChain: string;
  readonly originNonce: bigint;
  readonly destinationChain: string;
  readonly confirmedPayout: boolean;
  readonly rawPayloadRetained: boolean;
  readonly rawPrunedAt: Date | null;
  readonly messageIdentity: {
    readonly nonce: string;
    readonly messageHash: string;
    readonly bodyHash: string;
    readonly sourceDomain: number;
    readonly destinationDomain: number;
    readonly finalityThresholdExecuted: number;
  };
  readonly accounting: {
    readonly sourceAmount: string;
    readonly burnAmount: string;
    readonly feeExecuted: string;
    readonly mintAmount: string;
    readonly mintRecipient: string;
  };
  readonly receiptEvidence: {
    readonly forwardTxHash: string | null;
    readonly receiptTxHash: string | null;
    readonly receiptBlockNumber: bigint | null;
    readonly receiptBlockHash: string | null;
    readonly messageLogIndex: number | null;
    readonly mintLogIndex: number | null;
  };
  readonly verificationAssumptions: CctpVerificationAssumptions;
}

export interface CctpProofRetentionStatus extends CctpRetentionConfig {
  readonly preserveConfirmedSummary: true;
  readonly updatedAt: Date;
}

export interface CctpProofPruneResult {
  readonly compactedConfirmedCount: number;
  readonly deletedUnconfirmedCount: number;
  readonly policy: CctpProofRetentionStatus;
}

function createDefaultEvmClient(rpcUrl: string): CctpEvmClient {
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

export async function syncCctpRetentionPolicy(
  db: Queryable,
  policy: CctpRetentionConfig,
): Promise<CctpProofRetentionStatus> {
  const { rows } = await db.query(
    `INSERT INTO cctp_proof_retention_policy
       (policy_key, raw_proof_retention_days, unconfirmed_proof_retention_days,
        preserve_confirmed_summary, updated_at)
     VALUES ('default', $1, $2, true, now())
     ON CONFLICT (policy_key) DO UPDATE
       SET raw_proof_retention_days = EXCLUDED.raw_proof_retention_days,
           unconfirmed_proof_retention_days = EXCLUDED.unconfirmed_proof_retention_days,
           preserve_confirmed_summary = true,
           updated_at = now()
     RETURNING raw_proof_retention_days, unconfirmed_proof_retention_days, updated_at`,
    [policy.rawProofRetentionDays, policy.unconfirmedProofRetentionDays],
  );
  const row = rows[0];
  return {
    rawProofRetentionDays: row
      ? integer(row, "raw_proof_retention_days")
      : policy.rawProofRetentionDays,
    unconfirmedProofRetentionDays: row
      ? integer(row, "unconfirmed_proof_retention_days")
      : policy.unconfirmedProofRetentionDays,
    preserveConfirmedSummary: true,
    updatedAt: (row ? timestampOrNull(row, "updated_at") : null) ?? new Date(),
  };
}

export async function getCctpRetentionPolicy(db: Queryable): Promise<CctpProofRetentionStatus> {
  const { rows } = await db.query(
    `SELECT raw_proof_retention_days, unconfirmed_proof_retention_days, updated_at
       FROM cctp_proof_retention_policy
      WHERE policy_key = 'default'`,
  );
  const row = rows[0];
  return {
    rawProofRetentionDays: row ? integer(row, "raw_proof_retention_days") : 90,
    unconfirmedProofRetentionDays: row ? integer(row, "unconfirmed_proof_retention_days") : 30,
    preserveConfirmedSummary: true,
    updatedAt: (row ? timestampOrNull(row, "updated_at") : null) ?? new Date(),
  };
}

export async function recordCctpProofAudit(
  db: Queryable,
  entry: {
    readonly transferId: bigint;
    readonly originChain: string;
    readonly originNonce: bigint;
    readonly destinationChain: string;
    readonly verified: VerifiedCctpMessageDetail;
    readonly confirmedPayout: boolean;
    readonly forwardTxHash: string | null;
    readonly receiptTxHash: string | null;
    readonly receiptBlockNumber: bigint | null;
    readonly receiptBlockHash: string | null;
    readonly messageLogIndex: number | null;
    readonly mintLogIndex: number | null;
    readonly verificationAssumptions: CctpVerificationAssumptions;
    readonly rawMessageBytes: string | null;
    readonly attestationSignature: string | null;
    readonly recordedAt?: Date | undefined;
  },
): Promise<void> {
  const sanitizedMessage = sanitizePublicHexArtifact(entry.rawMessageBytes);
  const sanitizedAttestation = sanitizePublicHexArtifact(entry.attestationSignature);
  const recordedAt = entry.recordedAt ?? new Date();

  await db.query(
    `INSERT INTO cctp_proof_audit
       (transfer_id, origin_chain, origin_nonce, destination_chain, message_nonce, message_hash,
        body_hash, source_domain, destination_domain, finality_threshold_executed, burn_amount,
        fee_executed, mint_amount, mint_recipient, confirmed_payout, forward_tx_hash,
        receipt_tx_hash, receipt_block_number, receipt_block_hash, message_log_index,
        mint_log_index, verification_assumptions, raw_message_bytes, attestation_signature,
        recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
             $20, $21, $22::jsonb, $23, $24, $25)
     ON CONFLICT (transfer_id, message_nonce) DO UPDATE
       SET confirmed_payout = cctp_proof_audit.confirmed_payout OR EXCLUDED.confirmed_payout,
           forward_tx_hash = COALESCE(EXCLUDED.forward_tx_hash, cctp_proof_audit.forward_tx_hash),
           receipt_tx_hash = COALESCE(EXCLUDED.receipt_tx_hash, cctp_proof_audit.receipt_tx_hash),
           receipt_block_number = COALESCE(EXCLUDED.receipt_block_number, cctp_proof_audit.receipt_block_number),
           receipt_block_hash = COALESCE(EXCLUDED.receipt_block_hash, cctp_proof_audit.receipt_block_hash),
           message_log_index = COALESCE(EXCLUDED.message_log_index, cctp_proof_audit.message_log_index),
           mint_log_index = COALESCE(EXCLUDED.mint_log_index, cctp_proof_audit.mint_log_index),
           verification_assumptions = CASE
             WHEN EXCLUDED.confirmed_payout AND NOT cctp_proof_audit.confirmed_payout
               THEN EXCLUDED.verification_assumptions
             ELSE cctp_proof_audit.verification_assumptions
           END,
           raw_message_bytes = COALESCE(cctp_proof_audit.raw_message_bytes, EXCLUDED.raw_message_bytes),
           attestation_signature = COALESCE(cctp_proof_audit.attestation_signature, EXCLUDED.attestation_signature)`,
    [
      entry.transferId.toString(),
      entry.originChain,
      entry.originNonce.toString(),
      entry.destinationChain,
      entry.verified.message.nonce.toLowerCase(),
      entry.verified.messageHash.toLowerCase(),
      entry.verified.bodyHash.toLowerCase(),
      entry.verified.message.sourceDomain,
      entry.verified.message.destinationDomain,
      entry.verified.message.finalityThresholdExecuted,
      entry.verified.burn.amount.toString(),
      entry.verified.burn.feeExecuted.toString(),
      entry.verified.amount.toString(),
      toEvmAddress(entry.verified.burn.mintRecipient).toLowerCase(),
      entry.confirmedPayout,
      sanitizePublicHexArtifact(entry.forwardTxHash),
      sanitizePublicHexArtifact(entry.receiptTxHash),
      entry.receiptBlockNumber === null ? null : entry.receiptBlockNumber.toString(),
      sanitizePublicHexArtifact(entry.receiptBlockHash),
      entry.messageLogIndex,
      entry.mintLogIndex,
      JSON.stringify(entry.verificationAssumptions),
      sanitizedMessage,
      sanitizedAttestation,
      recordedAt,
    ],
  );
}

/**
 * Applies explicit CCTP proof-retention pruning:
 * - Confirmed payouts (or any row backed by an `inbound_delivery` record) NEVER lose their
 *   canonical audit summary, hashes, receipt/block/log pointers, or original verification
 *   assumptions; only bulky raw hex envelopes past `rawProofRetentionDays` are compacted.
 * - Unconfirmed candidate rows are deleted only when terminal (`failed` or `expired`), unbacked by
 *   any `inbound_delivery`, and older than `unconfirmedProofRetentionDays`.
 */
export async function pruneCctpProofRecords(
  db: Transactional,
  options?: {
    readonly policy?: CctpRetentionConfig;
    readonly now?: Date;
  },
): Promise<CctpProofPruneResult> {
  const now = options?.now ?? new Date();
  return db.transaction(async (tx) => {
    const policy = options?.policy
      ? await syncCctpRetentionPolicy(tx, options.policy)
      : await getCctpRetentionPolicy(tx);

    const rawCutoff = new Date(now.getTime() - policy.rawProofRetentionDays * 86_400_000);
    const unconfirmedCutoff = new Date(
      now.getTime() - policy.unconfirmedProofRetentionDays * 86_400_000,
    );

    const compacted = await tx.query(
      `UPDATE cctp_proof_audit a
          SET raw_message_bytes = NULL,
              attestation_signature = NULL,
              raw_pruned_at = $1
        WHERE (
                a.confirmed_payout = true
                OR EXISTS (
                  SELECT 1
                    FROM inbound_delivery d
                   WHERE d.source_chain = a.origin_chain
                     AND d.source_nonce = a.origin_nonce
                )
              )
          AND a.recorded_at < $2
          AND (a.raw_message_bytes IS NOT NULL OR a.attestation_signature IS NOT NULL)`,
      [now, rawCutoff],
    );

    const deleted = await tx.query(
      `DELETE FROM cctp_proof_audit a
        WHERE a.confirmed_payout = false
          AND a.recorded_at < $1
          AND NOT EXISTS (
            SELECT 1
              FROM inbound_delivery d
             WHERE d.source_chain = a.origin_chain
               AND d.source_nonce = a.origin_nonce
          )
          AND EXISTS (
            SELECT 1
              FROM rail_attestation r
             WHERE r.transfer_id = a.transfer_id
               AND r.status IN ('failed', 'expired')
          )`,
      [unconfirmedCutoff],
    );

    return {
      compactedConfirmedCount: compacted.rowCount,
      deletedUnconfirmedCount: deleted.rowCount,
      policy,
    };
  });
}

export async function reconstructCctpProofAudit(
  db: Queryable,
  transferId: bigint,
): Promise<readonly CctpAuditReconstruction[]> {
  const { rows } = await db.query(
    `SELECT transfer_id, origin_chain, origin_nonce, destination_chain, message_nonce, message_hash,
            body_hash, source_domain, destination_domain, finality_threshold_executed, burn_amount,
            fee_executed, mint_amount, mint_recipient, confirmed_payout, forward_tx_hash,
            receipt_tx_hash, receipt_block_number, receipt_block_hash, message_log_index,
            mint_log_index, verification_assumptions, raw_message_bytes, raw_pruned_at
       FROM cctp_proof_audit
      WHERE transfer_id = $1
      ORDER BY confirmed_payout DESC, id ASC`,
    [transferId.toString()],
  );

  return rows.map((row) => {
    const rawAssumptions =
      typeof row.verification_assumptions === "string"
        ? (JSON.parse(row.verification_assumptions) as CctpVerificationAssumptions)
        : (row.verification_assumptions as CctpVerificationAssumptions);
    const rawBytes = textOrNull(row, "raw_message_bytes");
    const rawPrunedAt = timestampOrNull(row, "raw_pruned_at");

    return {
      transferId: bigintOf(row, "transfer_id"),
      originChain: text(row, "origin_chain"),
      originNonce: bigintOf(row, "origin_nonce"),
      destinationChain: text(row, "destination_chain"),
      confirmedPayout: boolean(row, "confirmed_payout"),
      rawPayloadRetained: rawBytes !== null,
      rawPrunedAt,
      messageIdentity: {
        nonce: text(row, "message_nonce"),
        messageHash: text(row, "message_hash"),
        bodyHash: text(row, "body_hash"),
        sourceDomain: integer(row, "source_domain"),
        destinationDomain: integer(row, "destination_domain"),
        finalityThresholdExecuted: integer(row, "finality_threshold_executed"),
      },
      accounting: {
        sourceAmount: rawAssumptions.sourceAmount,
        burnAmount: bigintOf(row, "burn_amount").toString(),
        feeExecuted: bigintOf(row, "fee_executed").toString(),
        mintAmount: bigintOf(row, "mint_amount").toString(),
        mintRecipient: text(row, "mint_recipient"),
      },
      receiptEvidence: {
        forwardTxHash: textOrNull(row, "forward_tx_hash"),
        receiptTxHash: textOrNull(row, "receipt_tx_hash"),
        receiptBlockNumber: bigintOrNull(row, "receipt_block_number"),
        receiptBlockHash: textOrNull(row, "receipt_block_hash"),
        messageLogIndex: integerOrNull(row, "message_log_index"),
        mintLogIndex: integerOrNull(row, "mint_log_index"),
      },
      verificationAssumptions: rawAssumptions,
    };
  });
}

export async function verifyCctpDelivery(
  config: AppConfig,
  db: Transactional,
  transfer: PendingTransfer,
  report: RailReport,
  options?: VerifyCctpDeliveryOptions,
): Promise<VerifiedDelivery | null> {
  if (
    transfer.route !== RouteKind.Cctp ||
    transfer.originChain !== "stellar-testnet" ||
    !report.messageBytes ||
    !/^0x[0-9a-fA-F]+$/.test(report.messageBytes) ||
    !isChainKey(transfer.destinationChain)
  ) {
    return null;
  }
  const source = config.deployments.networks["stellar-testnet"];
  const destination = CHAINS[transfer.destinationChain];
  const contracts = RAIL_CONTRACTS[transfer.destinationChain]?.cctp;
  const token = assetOn(transfer.destinationChain, "USDC");
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
    destination.cctpDomain === null
  ) {
    return null;
  }
  const { rows } = await db.query(
    "SELECT token, net_amount, destination FROM outbound_transfer WHERE id = $1",
    [String(transfer.transferId)],
  );
  const stored = rows[0];
  if (!stored || text(stored, "token") !== sourceToken.sacId) return null;
  const expected: ExpectedCctpTransfer = {
    sourceToken: sourceToken.sacId,
    sourceAdapter: adapter,
    sourceMessenger: STELLAR_CCTP_MESSENGER,
    destinationDomain: destination.cctpDomain,
    destinationMessenger: contracts.tokenMessengerV2,
    transmitter: contracts.messageTransmitterV2,
    token: token.address,
    recipient: toEvmAddress(text(stored, "destination") as Hex),
    sourceAmount: bigintOf(stored, "net_amount"),
  };
  const raw = report.messageBytes as Hex;
  const verifiedMsg = verifiedCctpMessage(raw, expected);
  if (!verifiedMsg) return null;

  const baseAssumptions: CctpVerificationAssumptions = {
    sourceToken: expected.sourceToken,
    sourceAdapter: expected.sourceAdapter,
    sourceMessenger: expected.sourceMessenger,
    destinationChain: transfer.destinationChain,
    destinationChainId: destination.chainId,
    destinationDomain: expected.destinationDomain,
    destinationMessenger: expected.destinationMessenger.toLowerCase(),
    messageTransmitter: expected.transmitter.toLowerCase(),
    destinationToken: expected.token.toLowerCase(),
    recipient: expected.recipient.toLowerCase(),
    sourceAmount: expected.sourceAmount.toString(),
    confirmationsRequired: destination.confirmations,
    headBlockAtVerification: null,
    minFinalityThreshold: 2000,
  };

  if (!report.forwardTxHash) {
    await db
      .transaction((tx) =>
        recordCctpProofAudit(tx, {
          transferId: transfer.transferId,
          originChain: transfer.originChain,
          originNonce: transfer.nonce,
          destinationChain: transfer.destinationChain,
          verified: verifiedMsg,
          confirmedPayout: false,
          forwardTxHash: null,
          receiptTxHash: null,
          receiptBlockNumber: null,
          receiptBlockHash: null,
          messageLogIndex: null,
          mintLogIndex: null,
          verificationAssumptions: baseAssumptions,
          rawMessageBytes: raw,
          attestationSignature: report.attestationSignature ?? report.attestation ?? null,
          recordedAt: options?.recordedAt,
        }),
      )
      .catch(() => undefined);
    return null;
  }

  const client = options?.evmClient ?? createDefaultEvmClient(destination.defaultRpcUrl);
  if ((await client.getChainId()) !== destination.chainId) {
    throw new Error("CCTP destination RPC chain mismatch.");
  }
  const receipt = await client.getTransactionReceipt({ hash: report.forwardTxHash });
  if (receipt.status !== "success") return null;
  const head = await client.getBlockNumber();
  if (head - receipt.blockNumber + 1n < BigInt(destination.confirmations)) return null;
  const matched = matchCctpReceiptEvidence(receipt.logs, raw, expected);
  if (!matched) return null;
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) return null;

  const confirmedAssumptions: CctpVerificationAssumptions = {
    ...baseAssumptions,
    headBlockAtVerification: head.toString(),
  };

  await db
    .transaction((tx) =>
      recordCctpProofAudit(tx, {
        transferId: transfer.transferId,
        originChain: transfer.originChain,
        originNonce: transfer.nonce,
        destinationChain: transfer.destinationChain,
        verified: matched.verified,
        confirmedPayout: true,
        forwardTxHash: report.forwardTxHash ?? null,
        receiptTxHash: receipt.transactionHash,
        receiptBlockNumber: receipt.blockNumber,
        receiptBlockHash: receipt.blockHash,
        messageLogIndex: matched.messageLog.logIndex,
        mintLogIndex: matched.paymentLog.logIndex,
        verificationAssumptions: confirmedAssumptions,
        rawMessageBytes: raw,
        attestationSignature: report.attestationSignature ?? report.attestation ?? null,
        recordedAt: options?.recordedAt,
      }),
    )
    .catch(() => undefined);

  return {
    at: {
      chainKey: transfer.destinationChain,
      block: receipt.blockNumber,
      txHash: receipt.transactionHash,
      logIndex: matched.paymentLog.logIndex,
      observedAt: new Date(Number(block.timestamp) * 1000),
    },
    row: {
      route: transfer.route,
      sourceChain: transfer.originChain,
      sourceNonce: transfer.nonce,
      railMessageId: matched.verified.message.nonce,
      recipient: expected.recipient.toLowerCase(),
      token: token.address.toLowerCase(),
      amount: matched.verified.amount,
      delivered: true,
      claimId: null,
    },
  };
}
