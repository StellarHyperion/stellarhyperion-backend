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
import { bigintOf, bigintOrNull, integer, text, textOrNull } from "../../db/rows.js";
import type { PendingTransfer, RailReport } from "../types.js";
import type { VerifiedDelivery } from "../axelar/delivery.js";
import type { DeliveryLog } from "../axelar/events.js";
import {
  evaluateCctpMessageFeeAccounting,
  reconcileCctpBurnToMint,
  type CctpFeeAccounting,
  type CctpFeeDiagnosticCode,
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

export interface StoredCctpFeeReconciliation {
  readonly transferId: bigint;
  readonly sourceDecimals: number;
  readonly destinationDecimals: number;
  readonly sourceBurnedAmount: bigint;
  readonly cctpBurnAmount: bigint;
  readonly forwardingBudgetMaxFee: bigint;
  readonly executedFeeDeduction: bigint | null;
  readonly plannedMinPayout: bigint;
  readonly actualMintPayout: bigint | null;
  readonly status: "pending" | "reconciled" | "failed";
  readonly diagnosticCode: string | null;
  readonly diagnosticDetail: string | null;
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

export async function upsertCctpFeeReconciliation(
  db: Queryable,
  entry: {
    readonly transferId: bigint;
    readonly accounting: CctpFeeAccounting;
    readonly status: "pending" | "reconciled" | "failed";
    readonly diagnosticCode: CctpFeeDiagnosticCode | null;
    readonly diagnosticDetail: string | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO cctp_fee_reconciliation
       (transfer_id, source_decimals, destination_decimals, source_burned_amount,
        cctp_burn_amount, forwarding_budget_max_fee, executed_fee_deduction,
        planned_min_payout, actual_mint_payout, status, diagnostic_code,
        diagnostic_detail, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
     ON CONFLICT (transfer_id) DO UPDATE
       SET source_burned_amount = EXCLUDED.source_burned_amount,
           cctp_burn_amount = EXCLUDED.cctp_burn_amount,
           forwarding_budget_max_fee = EXCLUDED.forwarding_budget_max_fee,
           executed_fee_deduction = CASE
             WHEN cctp_fee_reconciliation.status = 'reconciled' AND EXCLUDED.status <> 'reconciled'
               THEN cctp_fee_reconciliation.executed_fee_deduction
             ELSE EXCLUDED.executed_fee_deduction
           END,
           planned_min_payout = EXCLUDED.planned_min_payout,
           actual_mint_payout = CASE
             WHEN cctp_fee_reconciliation.status = 'reconciled' AND EXCLUDED.status <> 'reconciled'
               THEN cctp_fee_reconciliation.actual_mint_payout
             ELSE EXCLUDED.actual_mint_payout
           END,
           status = CASE
             WHEN cctp_fee_reconciliation.status = 'reconciled' AND EXCLUDED.status <> 'reconciled'
               THEN 'reconciled'
             ELSE EXCLUDED.status
           END,
           diagnostic_code = CASE
             WHEN cctp_fee_reconciliation.status = 'reconciled' AND EXCLUDED.status <> 'reconciled'
               THEN NULL
             ELSE EXCLUDED.diagnostic_code
           END,
           diagnostic_detail = CASE
             WHEN cctp_fee_reconciliation.status = 'reconciled' AND EXCLUDED.status <> 'reconciled'
               THEN NULL
             ELSE EXCLUDED.diagnostic_detail
           END,
           updated_at = now()`,
    [
      entry.transferId.toString(),
      entry.accounting.sourceDecimals,
      entry.accounting.destinationDecimals,
      entry.accounting.sourceBurnedAmount.toString(),
      entry.accounting.cctpBurnAmount.toString(),
      entry.accounting.forwardingBudgetMaxFee.toString(),
      entry.accounting.executedFeeDeduction === null
        ? null
        : entry.accounting.executedFeeDeduction.toString(),
      entry.accounting.plannedMinPayout.toString(),
      entry.accounting.actualMintPayout === null
        ? null
        : entry.accounting.actualMintPayout.toString(),
      entry.status,
      entry.diagnosticCode,
      entry.diagnosticDetail,
    ],
  );
}

export async function getCctpFeeReconciliation(
  db: Queryable,
  transferId: bigint,
): Promise<StoredCctpFeeReconciliation | null> {
  const { rows } = await db.query(
    `SELECT transfer_id, source_decimals, destination_decimals, source_burned_amount,
            cctp_burn_amount, forwarding_budget_max_fee, executed_fee_deduction,
            planned_min_payout, actual_mint_payout, status, diagnostic_code, diagnostic_detail
       FROM cctp_fee_reconciliation
      WHERE transfer_id = $1`,
    [transferId.toString()],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    transferId: bigintOf(row, "transfer_id"),
    sourceDecimals: integer(row, "source_decimals"),
    destinationDecimals: integer(row, "destination_decimals"),
    sourceBurnedAmount: bigintOf(row, "source_burned_amount"),
    cctpBurnAmount: bigintOf(row, "cctp_burn_amount"),
    forwardingBudgetMaxFee: bigintOf(row, "forwarding_budget_max_fee"),
    executedFeeDeduction: bigintOrNull(row, "executed_fee_deduction"),
    plannedMinPayout: bigintOf(row, "planned_min_payout"),
    actualMintPayout: bigintOrNull(row, "actual_mint_payout"),
    status: text(row, "status") as "pending" | "reconciled" | "failed",
    diagnosticCode: textOrNull(row, "diagnostic_code"),
    diagnosticDetail: textOrNull(row, "diagnostic_detail"),
  };
}

async function persistReconciliationSafely(
  db: Transactional,
  entry: Parameters<typeof upsertCctpFeeReconciliation>[1],
): Promise<void> {
  await db.transaction((tx) => upsertCctpFeeReconciliation(tx, entry)).catch(() => undefined);
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
  const preCheck = evaluateCctpMessageFeeAccounting(raw, expected, {
    requireFinalized: Boolean(report.forwardTxHash),
  });

  if (!preCheck.ok) {
    if (preCheck.accounting !== null) {
      const isRetryableFinality = preCheck.code === "insufficient_finality";
      await persistReconciliationSafely(db, {
        transferId: transfer.transferId,
        accounting: preCheck.accounting,
        status: isRetryableFinality ? "pending" : "failed",
        diagnosticCode: preCheck.code,
        diagnosticDetail: preCheck.detail,
      });
    }
    return null;
  }

  if (!report.forwardTxHash) {
    // Transfer is attested/in-flight with no destination forward tx yet: record planned minimum
    // payout while keeping actualMintPayout null!
    await persistReconciliationSafely(db, {
      transferId: transfer.transferId,
      accounting: {
        ...preCheck.accounting,
        executedFeeDeduction: report.status === "attested" ? preCheck.burn.feeExecuted : null,
        actualMintPayout: null,
      },
      status: "pending",
      diagnosticCode: null,
      diagnosticDetail: null,
    });
    return null;
  }

  const client = options?.evmClient ?? createDefaultEvmClient(destination.defaultRpcUrl);
  if ((await client.getChainId()) !== destination.chainId) {
    throw new Error("CCTP destination RPC chain mismatch.");
  }
  const receipt = await client.getTransactionReceipt({ hash: report.forwardTxHash });
  if (receipt.status !== "success") {
    await persistReconciliationSafely(db, {
      transferId: transfer.transferId,
      accounting: { ...preCheck.accounting, actualMintPayout: null },
      status: "pending",
      diagnosticCode: null,
      diagnosticDetail: "candidate forward transaction reverted",
    });
    return null;
  }
  const head = await client.getBlockNumber();
  if (head - receipt.blockNumber + 1n < BigInt(destination.confirmations)) {
    await persistReconciliationSafely(db, {
      transferId: transfer.transferId,
      accounting: { ...preCheck.accounting, actualMintPayout: null },
      status: "pending",
      diagnosticCode: null,
      diagnosticDetail: null,
    });
    return null;
  }
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) {
    return null;
  }

  const reconciled = reconcileCctpBurnToMint(receipt.logs, raw, expected);
  if (!reconciled.ok) {
    if (reconciled.accounting !== null) {
      const isFailure = reconciled.code === "inconsistent_mint_payout";
      await persistReconciliationSafely(db, {
        transferId: transfer.transferId,
        accounting: reconciled.accounting,
        status: isFailure ? "failed" : "pending",
        diagnosticCode: reconciled.code,
        diagnosticDetail: reconciled.detail,
      });
    }
    return null;
  }

  await persistReconciliationSafely(db, {
    transferId: transfer.transferId,
    accounting: reconciled.accounting,
    status: "reconciled",
    diagnosticCode: null,
    diagnosticDetail: null,
  });

  return {
    at: {
      chainKey: transfer.destinationChain,
      block: receipt.blockNumber,
      txHash: receipt.transactionHash,
      logIndex: reconciled.payment.logIndex,
      observedAt: new Date(Number(block.timestamp) * 1000),
    },
    row: {
      route: transfer.route,
      sourceChain: transfer.originChain,
      sourceNonce: transfer.nonce,
      railMessageId: reconciled.message.nonce,
      recipient: expected.recipient.toLowerCase(),
      token: token.address.toLowerCase(),
      amount: reconciled.accounting.actualMintPayout,
      delivered: true,
      claimId: null,
    },
  };
}
