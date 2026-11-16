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
import { bigintOf, bigintOrNull, boolean, text, textOrNull } from "../../db/rows.js";
import type { PendingTransfer, RailReport } from "../types.js";
import type { VerifiedDelivery } from "../axelar/delivery.js";
import type { DeliveryLog } from "../axelar/events.js";
import {
  createCctpDiagnosticReport,
  inspectCctpMessage,
  inspectCctpPaymentLogs,
  sanitizeCctpDiagnosticText,
  type CctpDiagnosticCategory,
  type CctpDiagnosticReport,
  type ExpectedCctpTransfer,
} from "./events.js";

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
}

export interface StoredCctpVerificationDiagnostic {
  readonly transferId: bigint;
  readonly outcome: "verified" | "mismatch" | "missing_evidence";
  readonly category: CctpDiagnosticCategory;
  readonly retryable: boolean;
  readonly fieldName: string | null;
  readonly expectedSummary: string | null;
  readonly observedSummary: string | null;
  readonly detail: string;
  readonly candidateTxHash: string | null;
  readonly candidateBlock: bigint | null;
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

export async function recordCctpVerificationDiagnostic(
  db: Queryable,
  entry: {
    readonly transferId: bigint;
    readonly diagnostic: CctpDiagnosticReport;
    readonly candidateTxHash: string | null;
    readonly candidateBlock: bigint | null;
  },
): Promise<void> {
  const safeTxHash =
    entry.candidateTxHash !== null && /^0x[0-9a-fA-F]{64}$/.test(entry.candidateTxHash)
      ? entry.candidateTxHash.toLowerCase()
      : null;

  await db.query(
    `INSERT INTO cctp_verification_diagnostic
       (transfer_id, outcome, category, retryable, field_name, expected_summary,
        observed_summary, detail, candidate_tx_hash, candidate_block, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (transfer_id) DO UPDATE
       SET outcome = CASE
             WHEN cctp_verification_diagnostic.outcome = 'verified' AND EXCLUDED.outcome <> 'verified'
               THEN 'verified'
             ELSE EXCLUDED.outcome
           END,
           category = CASE
             WHEN cctp_verification_diagnostic.outcome = 'verified' AND EXCLUDED.outcome <> 'verified'
               THEN cctp_verification_diagnostic.category
             ELSE EXCLUDED.category
           END,
           retryable = CASE
             WHEN cctp_verification_diagnostic.outcome = 'verified' AND EXCLUDED.outcome <> 'verified'
               THEN false
             ELSE EXCLUDED.retryable
           END,
           field_name = CASE
             WHEN cctp_verification_diagnostic.outcome = 'verified' AND EXCLUDED.outcome <> 'verified'
               THEN cctp_verification_diagnostic.field_name
             ELSE EXCLUDED.field_name
           END,
           expected_summary = CASE
             WHEN cctp_verification_diagnostic.outcome = 'verified' AND EXCLUDED.outcome <> 'verified'
               THEN cctp_verification_diagnostic.expected_summary
             ELSE EXCLUDED.expected_summary
           END,
           observed_summary = CASE
             WHEN cctp_verification_diagnostic.outcome = 'verified' AND EXCLUDED.outcome <> 'verified'
               THEN cctp_verification_diagnostic.observed_summary
             ELSE EXCLUDED.observed_summary
           END,
           detail = CASE
             WHEN cctp_verification_diagnostic.outcome = 'verified' AND EXCLUDED.outcome <> 'verified'
               THEN cctp_verification_diagnostic.detail
             ELSE EXCLUDED.detail
           END,
           candidate_tx_hash = COALESCE(EXCLUDED.candidate_tx_hash, cctp_verification_diagnostic.candidate_tx_hash),
           candidate_block = COALESCE(EXCLUDED.candidate_block, cctp_verification_diagnostic.candidate_block),
           updated_at = now()`,
    [
      entry.transferId.toString(),
      entry.diagnostic.outcome,
      entry.diagnostic.category,
      entry.diagnostic.retryable,
      entry.diagnostic.fieldName,
      entry.diagnostic.expectedSummary,
      entry.diagnostic.observedSummary,
      sanitizeCctpDiagnosticText(entry.diagnostic.detail, 240),
      safeTxHash,
      entry.candidateBlock === null ? null : entry.candidateBlock.toString(),
    ],
  );
}

export async function getCctpVerificationDiagnostic(
  db: Queryable,
  transferId: bigint,
): Promise<StoredCctpVerificationDiagnostic | null> {
  const { rows } = await db.query(
    `SELECT transfer_id, outcome, category, retryable, field_name, expected_summary,
            observed_summary, detail, candidate_tx_hash, candidate_block
       FROM cctp_verification_diagnostic
      WHERE transfer_id = $1`,
    [transferId.toString()],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    transferId: bigintOf(row, "transfer_id"),
    outcome: text(row, "outcome") as StoredCctpVerificationDiagnostic["outcome"],
    category: text(row, "category") as CctpDiagnosticCategory,
    retryable: boolean(row, "retryable"),
    fieldName: textOrNull(row, "field_name"),
    expectedSummary: textOrNull(row, "expected_summary"),
    observedSummary: textOrNull(row, "observed_summary"),
    detail: text(row, "detail"),
    candidateTxHash: textOrNull(row, "candidate_tx_hash"),
    candidateBlock: bigintOrNull(row, "candidate_block"),
  };
}

async function persistDiagnosticSafely(
  db: Transactional,
  entry: Parameters<typeof recordCctpVerificationDiagnostic>[1],
): Promise<void> {
  await db.transaction((tx) => recordCctpVerificationDiagnostic(tx, entry)).catch(() => undefined);
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
  if (!stored) return null;

  const storedSourceToken = text(stored, "token");
  if (storedSourceToken !== sourceToken.sacId) {
    await persistDiagnosticSafely(db, {
      transferId: transfer.transferId,
      diagnostic: createCctpDiagnosticReport({
        outcome: "mismatch",
        category: "token_mismatch",
        retryable: false,
        fieldName: "sourceToken",
        expectedSummary: sourceToken.sacId,
        observedSummary: storedSourceToken,
        detail: "outbound transfer token disagreed with configured Stellar USDC SAC",
      }),
      candidateTxHash: report.forwardTxHash ?? null,
      candidateBlock: null,
    });
    return null;
  }

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

  if (!report.messageBytes || !/^0x[0-9a-fA-F]+$/.test(report.messageBytes)) {
    await persistDiagnosticSafely(db, {
      transferId: transfer.transferId,
      diagnostic: createCctpDiagnosticReport({
        outcome: "missing_evidence",
        category: "missing_message_bytes",
        retryable: true,
        fieldName: "messageBytes",
        expectedSummary: "hex CCTP v2 message",
        observedSummary: null,
        detail: "provider response has not supplied canonical CCTP message bytes yet",
      }),
      candidateTxHash: report.forwardTxHash ?? null,
      candidateBlock: null,
    });
    return null;
  }

  const raw = report.messageBytes as Hex;
  const msgCheck = inspectCctpMessage(raw, expected);
  if (!msgCheck.ok) {
    await persistDiagnosticSafely(db, {
      transferId: transfer.transferId,
      diagnostic: msgCheck.diagnostic,
      candidateTxHash: report.forwardTxHash ?? null,
      candidateBlock: null,
    });
    return null;
  }

  if (!report.forwardTxHash) {
    await persistDiagnosticSafely(db, {
      transferId: transfer.transferId,
      diagnostic: createCctpDiagnosticReport({
        outcome: "missing_evidence",
        category: "missing_forward_tx",
        retryable: true,
        fieldName: "forwardTxHash",
        expectedSummary: "destination transaction hash",
        observedSummary: null,
        detail: "attested CCTP message is awaiting destination forward transaction hash",
      }),
      candidateTxHash: null,
      candidateBlock: null,
    });
    return null;
  }

  const client = options?.evmClient ?? createDefaultEvmClient(destination.defaultRpcUrl);
  if ((await client.getChainId()) !== destination.chainId) {
    throw new Error("CCTP destination RPC chain mismatch.");
  }

  let receipt: CctpReceipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: report.forwardTxHash });
  } catch (cause) {
    const safeErr = sanitizeCctpDiagnosticText(
      cause instanceof Error ? cause.message : String(cause),
      160,
    );
    await persistDiagnosticSafely(db, {
      transferId: transfer.transferId,
      diagnostic: createCctpDiagnosticReport({
        outcome: "missing_evidence",
        category: "receipt_unavailable",
        retryable: true,
        fieldName: "forwardTxHash",
        expectedSummary: report.forwardTxHash,
        observedSummary: null,
        detail: `destination receipt not yet available: ${safeErr}`,
      }),
      candidateTxHash: report.forwardTxHash,
      candidateBlock: null,
    });
    return null;
  }

  if (receipt.status !== "success") {
    await persistDiagnosticSafely(db, {
      transferId: transfer.transferId,
      diagnostic: createCctpDiagnosticReport({
        outcome: "mismatch",
        category: "reverted_receipt",
        retryable: false,
        fieldName: "receipt.status",
        expectedSummary: "success",
        observedSummary: receipt.status,
        detail: "candidate destination forward transaction reverted",
      }),
      candidateTxHash: receipt.transactionHash,
      candidateBlock: receipt.blockNumber,
    });
    return null;
  }

  const head = await client.getBlockNumber();
  const confirmations = head >= receipt.blockNumber ? head - receipt.blockNumber + 1n : 0n;
  if (confirmations < BigInt(destination.confirmations)) {
    await persistDiagnosticSafely(db, {
      transferId: transfer.transferId,
      diagnostic: createCctpDiagnosticReport({
        outcome: "missing_evidence",
        category: "insufficient_confirmations",
        retryable: true,
        fieldName: "confirmations",
        expectedSummary: String(destination.confirmations),
        observedSummary: confirmations.toString(),
        detail: "destination receipt has not reached required block confirmations yet",
      }),
      candidateTxHash: receipt.transactionHash,
      candidateBlock: receipt.blockNumber,
    });
    return null;
  }

  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) {
    await persistDiagnosticSafely(db, {
      transferId: transfer.transferId,
      diagnostic: createCctpDiagnosticReport({
        outcome: "missing_evidence",
        category: "non_canonical_block",
        retryable: true,
        fieldName: "blockHash",
        expectedSummary: receipt.blockHash.toLowerCase(),
        observedSummary: block.hash ? block.hash.toLowerCase() : null,
        detail: "receipt block hash disagreed with canonical destination chain block",
      }),
      candidateTxHash: receipt.transactionHash,
      candidateBlock: receipt.blockNumber,
    });
    return null;
  }

  const paymentCheck = inspectCctpPaymentLogs(receipt.logs, raw, expected);
  await persistDiagnosticSafely(db, {
    transferId: transfer.transferId,
    diagnostic: paymentCheck.diagnostic,
    candidateTxHash: receipt.transactionHash,
    candidateBlock: receipt.blockNumber,
  });

  if (!paymentCheck.ok) {
    return null;
  }

  return {
    at: {
      chainKey: transfer.destinationChain,
      block: receipt.blockNumber,
      txHash: receipt.transactionHash,
      logIndex: paymentCheck.payment.logIndex,
      observedAt: new Date(Number(block.timestamp) * 1000),
    },
    row: {
      route: transfer.route,
      sourceChain: transfer.originChain,
      sourceNonce: transfer.nonce,
      railMessageId: paymentCheck.message.nonce,
      recipient: expected.recipient.toLowerCase(),
      token: token.address.toLowerCase(),
      amount: paymentCheck.amount,
      delivered: true,
      claimId: null,
    },
  };
}
