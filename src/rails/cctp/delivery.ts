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
import type { Transactional } from "../../db/pool.js";
import { bigintOf, text } from "../../db/rows.js";
import type { PendingTransfer, RailReport } from "../types.js";
import type { DeliveryLog } from "../axelar/events.js";
import type { VerifiedDelivery } from "../axelar/delivery.js";
import { recordProofRejection, type ProofRejectionLogger } from "../proof-reasons.js";
import { classifyCctpMessage, classifyCctpReceipt, type ExpectedCctpTransfer } from "./events.js";

export interface CctpPublicClientLike {
  getChainId(): Promise<number>;
  getTransactionReceipt(args: { hash: Hex }): Promise<{
    readonly status: string;
    readonly blockNumber: bigint;
    readonly blockHash: Hex;
    readonly transactionHash: Hex;
    readonly logs: readonly DeliveryLog[];
  }>;
  getBlockNumber(): Promise<bigint>;
  getBlock(args: { blockNumber: bigint }): Promise<{
    readonly hash: Hex | null;
    readonly timestamp: bigint;
  }>;
}

export interface CctpDeliveryDeps {
  readonly publicClient?: CctpPublicClientLike | undefined;
  readonly logger?: ProofRejectionLogger | undefined;
}

export async function verifyCctpDelivery(
  config: AppConfig,
  db: Transactional,
  transfer: PendingTransfer,
  report: RailReport,
  deps: CctpDeliveryDeps = {},
): Promise<VerifiedDelivery | null> {
  if (
    transfer.route !== RouteKind.Cctp ||
    transfer.originChain !== "stellar-testnet" ||
    !report.forwardTxHash
  ) {
    return null;
  }

  if (
    !report.messageBytes ||
    !/^0x[0-9a-fA-F]+$/.test(report.messageBytes) ||
    !isChainKey(transfer.destinationChain)
  ) {
    await recordProofRejection(db, "cctp", "provider_inconsistency", deps.logger);
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
  if (text(stored, "token") !== sourceToken.sacId) {
    await recordProofRejection(db, "cctp", "token_mismatch", deps.logger);
    return null;
  }

  const expected: ExpectedCctpTransfer = {
    sourceToken: sourceToken.sacId,
    sourceAdapter: adapter,
    sourceMessenger: "CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP",
    destinationDomain: destination.cctpDomain,
    destinationMessenger: contracts.tokenMessengerV2,
    transmitter: contracts.messageTransmitterV2,
    token: token.address,
    recipient: toEvmAddress(text(stored, "destination") as Hex),
    sourceAmount: bigintOf(stored, "net_amount"),
  };

  const raw = report.messageBytes as Hex;
  const msgOutcome = classifyCctpMessage(raw, expected);
  if (!msgOutcome.ok) {
    await recordProofRejection(db, "cctp", msgOutcome.reason, deps.logger);
    return null;
  }

  const client: CctpPublicClientLike =
    deps.publicClient ??
    createPublicClient({
      transport: http(destination.defaultRpcUrl, { timeout: 15000, retryCount: 0 }),
    });

  if ((await client.getChainId()) !== destination.chainId) {
    await recordProofRejection(db, "cctp", "provider_inconsistency", deps.logger);
    throw new Error("CCTP destination RPC chain mismatch.");
  }

  let receipt: Awaited<ReturnType<CctpPublicClientLike["getTransactionReceipt"]>>;
  try {
    receipt = await client.getTransactionReceipt({ hash: report.forwardTxHash });
  } catch (error) {
    if (isReceiptNotFound(error)) {
      await recordProofRejection(db, "cctp", "provider_inconsistency", deps.logger);
      return null;
    }
    throw error;
  }

  if (receipt.status !== "success") {
    await recordProofRejection(db, "cctp", "provider_inconsistency", deps.logger);
    return null;
  }

  const head = await client.getBlockNumber();
  if (head - receipt.blockNumber + 1n < BigInt(destination.confirmations)) {
    await recordProofRejection(db, "cctp", "insufficient_finality", deps.logger);
    return null;
  }

  const receiptOutcome = classifyCctpReceipt(receipt.logs, raw, expected);
  if (!receiptOutcome.ok) {
    await recordProofRejection(db, "cctp", receiptOutcome.reason, deps.logger);
    return null;
  }

  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (block.hash !== receipt.blockHash) {
    await recordProofRejection(db, "cctp", "insufficient_finality", deps.logger);
    return null;
  }

  return {
    at: {
      chainKey: transfer.destinationChain,
      block: receipt.blockNumber,
      txHash: receipt.transactionHash,
      logIndex: receiptOutcome.payment.logIndex,
      observedAt: new Date(Number(block.timestamp) * 1000),
    },
    row: {
      route: transfer.route,
      sourceChain: transfer.originChain,
      sourceNonce: transfer.nonce,
      railMessageId: receiptOutcome.verified.message.nonce,
      recipient: expected.recipient.toLowerCase(),
      token: token.address.toLowerCase(),
      amount: receiptOutcome.verified.amount,
      delivered: true,
      claimId: null,
    },
  };
}

function isReceiptNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TransactionReceiptNotFoundError" ||
      /receipt.*could not be found|not found/i.test(error.message))
  );
}
