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
import type { VerifiedDelivery } from "../axelar/delivery.js";
import { CandidateReceiptCache, type CandidateReceiptRpcClient } from "../receipt-cache.js";
import { matchingCctpPayment, verifiedCctpMessage, type ExpectedCctpTransfer } from "./events.js";

export interface CctpDeliveryOptions {
  readonly receiptCache?: CandidateReceiptCache;
  readonly evmClientFactory?: (chainKey: string, rpcUrl: string) => CandidateReceiptRpcClient;
}

export async function verifyCctpDelivery(
  config: AppConfig,
  db: Transactional,
  transfer: PendingTransfer,
  report: RailReport,
  options: CctpDeliveryOptions = {},
): Promise<VerifiedDelivery | null> {
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
  const client: CandidateReceiptRpcClient = options.evmClientFactory
    ? options.evmClientFactory(transfer.destinationChain, destination.defaultRpcUrl)
    : createPublicClient({
        transport: http(destination.defaultRpcUrl, { timeout: 15000, retryCount: 0 }),
      });
  const cache = options.receiptCache ?? new CandidateReceiptCache({ maxEntries: 1 });
  const receipt = await cache.getConfirmedReceipt({
    chainKey: transfer.destinationChain,
    expectedChainId: destination.chainId,
    confirmations: destination.confirmations,
    txHash: report.forwardTxHash,
    client,
  });
  if (!receipt) return null;
  const payment = matchingCctpPayment(receipt.logs, raw, expected);
  if (!payment) return null;
  return {
    at: {
      chainKey: transfer.destinationChain,
      block: receipt.blockNumber,
      txHash: receipt.transactionHash,
      logIndex: payment.logIndex,
      observedAt: new Date(Number(receipt.blockTimestampSeconds) * 1000),
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
