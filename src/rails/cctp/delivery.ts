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
import { RailError } from "../types.js";
import type { VerifiedDelivery } from "../axelar/delivery.js";
import type { DeliveryLog } from "../axelar/events.js";
import { matchingCctpPayment, verifiedCctpMessage, type ExpectedCctpTransfer } from "./events.js";

export interface CctpReceiptRpcClient {
  getChainId(): Promise<number>;
  getTransactionReceipt(args: { hash: Hex }): Promise<{
    readonly status: "success" | "reverted";
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

export interface CctpDeliveryVerifyOptions {
  readonly signal?: AbortSignal;
  readonly evmClient?: CctpReceiptRpcClient;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new RailError("cctp", "cancelled", "cancelled");
  }
}

export async function verifyCctpDelivery(
  config: AppConfig,
  db: Transactional,
  transfer: PendingTransfer,
  report: RailReport,
  options: CctpDeliveryVerifyOptions = {},
): Promise<VerifiedDelivery | null> {
  throwIfAborted(options.signal);
  if (
    transfer.route !== RouteKind.Cctp ||
    transfer.originChain !== "stellar-testnet" ||
    !report.forwardTxHash ||
    !report.messageBytes ||
    !/^0x[0-9a-fA-F]+$/.test(report.messageBytes) ||
    !isChainKey(transfer.destinationChain)
  )
    return null;
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
  )
    return null;
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
  const message = verifiedCctpMessage(raw, expected);
  if (!message) return null;
  throwIfAborted(options.signal);
  const client: CctpReceiptRpcClient =
    options.evmClient ??
    createPublicClient({
      transport: http(destination.defaultRpcUrl, {
        timeout: 15000,
        retryCount: 0,
        ...(options.signal !== undefined ? { fetchOptions: { signal: options.signal } } : {}),
      }),
    });
  if ((await client.getChainId()) !== destination.chainId)
    throw new Error("CCTP destination RPC chain mismatch.");
  throwIfAborted(options.signal);
  const receipt = await client.getTransactionReceipt({ hash: report.forwardTxHash });
  throwIfAborted(options.signal);
  if (receipt.status !== "success") return null;
  const head = await client.getBlockNumber();
  throwIfAborted(options.signal);
  if (head - receipt.blockNumber + 1n < BigInt(destination.confirmations)) return null;
  const payment = matchingCctpPayment(receipt.logs, raw, expected);
  if (!payment) return null;
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  throwIfAborted(options.signal);
  if (block.hash !== receipt.blockHash) return null;
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
