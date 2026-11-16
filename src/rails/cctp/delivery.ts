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
import {
  RailError,
  type CctpResourceLimitCode,
  type PendingTransfer,
  type RailReport,
} from "../types.js";
import type { VerifiedDelivery } from "../axelar/delivery.js";
import type { DeliveryLog } from "../axelar/events.js";
import {
  assertCctpHexByteLimit,
  assertCctpReceiptResourceLimits,
  matchingCctpPayment,
  resolveCctpResourceLimits,
  verifiedCctpMessage,
  type CctpResourceLimits,
  type ExpectedCctpTransfer,
} from "./events.js";

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
  readonly limits?: Partial<CctpResourceLimits>;
}

export type CctpDeliveryVerificationOutcome =
  | { readonly outcome: "verified"; readonly delivery: VerifiedDelivery }
  | { readonly outcome: "invalid_payment_evidence" }
  | {
      readonly outcome: "resource_limit";
      readonly code: CctpResourceLimitCode;
      readonly error: RailError;
    };

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

export function assertReportResourceLimits(report: RailReport, limits: CctpResourceLimits): void {
  const rawCandidate = report.messageBytes ?? report.message ?? null;
  if (typeof rawCandidate === "string") {
    assertCctpHexByteLimit(
      rawCandidate,
      limits.maxMessageHexBytes,
      "message_bytes_exceeded",
      "message",
    );
  }
  const attCandidate = report.attestationSignature ?? report.attestation ?? null;
  if (typeof attCandidate === "string" && attCandidate !== "PENDING") {
    assertCctpHexByteLimit(
      attCandidate,
      limits.maxAttestationHexBytes,
      "attestation_bytes_exceeded",
      "attestation",
    );
  }
}

export async function verifyCctpDelivery(
  config: AppConfig,
  db: Transactional,
  transfer: PendingTransfer,
  report: RailReport,
  options?: VerifyCctpDeliveryOptions,
): Promise<VerifiedDelivery | null> {
  const limits = resolveCctpResourceLimits(options?.limits);
  assertReportResourceLimits(report, limits);

  if (
    transfer.route !== RouteKind.Cctp ||
    transfer.originChain !== "stellar-testnet" ||
    !report.forwardTxHash ||
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
    sourceMessenger: "CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP",
    destinationDomain: destination.cctpDomain,
    destinationMessenger: contracts.tokenMessengerV2,
    transmitter: contracts.messageTransmitterV2,
    token: token.address,
    recipient: toEvmAddress(text(stored, "destination") as Hex),
    sourceAmount: bigintOf(stored, "net_amount"),
  };
  const raw = report.messageBytes as Hex;
  const message = verifiedCctpMessage(raw, expected, limits);
  if (!message) return null;

  const client = options?.evmClient ?? createDefaultEvmClient(destination.defaultRpcUrl);
  if ((await client.getChainId()) !== destination.chainId) {
    throw new Error("CCTP destination RPC chain mismatch.");
  }
  const receipt = await client.getTransactionReceipt({ hash: report.forwardTxHash });
  assertCctpReceiptResourceLimits(receipt.logs, limits);
  if (receipt.status !== "success") return null;
  const head = await client.getBlockNumber();
  if (head - receipt.blockNumber + 1n < BigInt(destination.confirmations)) return null;
  const payment = matchingCctpPayment(receipt.logs, raw, expected, limits);
  if (!payment) return null;
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) return null;
  return {
    at: {
      chainKey: transfer.destinationChain,
      block: receipt.blockNumber,
      txHash: receipt.transactionHash,
      logIndex: payment.logIndex,
      observedAt: new Date(Number(block.timestamp) * 1000),
    },
    row: {
      route: transfer.route,
      sourceChain: transfer.originChain,
      sourceNonce: transfer.nonce,
      railMessageId: message.message.nonce,
      recipient: expected.recipient.toLowerCase(),
      token: token.address.toLowerCase(),
      amount: message.amount,
      delivered: true,
      claimId: null,
    },
  };
}

export async function verifyCctpDeliveryClassified(
  config: AppConfig,
  db: Transactional,
  transfer: PendingTransfer,
  report: RailReport,
  options?: VerifyCctpDeliveryOptions,
): Promise<CctpDeliveryVerificationOutcome> {
  try {
    const delivery = await verifyCctpDelivery(config, db, transfer, report, options);
    if (!delivery) return { outcome: "invalid_payment_evidence" };
    return { outcome: "verified", delivery };
  } catch (error) {
    if (error instanceof RailError && error.kind === "resourceLimit") {
      return {
        outcome: "resource_limit",
        code: error.limitCode ?? "message_bytes_exceeded",
        error,
      };
    }
    throw error;
  }
}
