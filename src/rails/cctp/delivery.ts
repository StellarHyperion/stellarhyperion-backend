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
import type { Logger } from "pino";
import type { Hex } from "viem";
import {
  createDestinationVerifierClient,
  type DestinationClientFactory,
  type DestinationFailoverEvent,
  type DestinationVerifierClient,
} from "../../chains/evm/client.js";
import { destinationRpcUrlsFor, type AppConfig } from "../../config/config.js";
import type { Transactional } from "../../db/pool.js";
import { bigintOf, text } from "../../db/rows.js";
import type { PendingTransfer, RailReport } from "../types.js";
import type { VerifiedDelivery } from "../axelar/delivery.js";
import { matchingCctpPayment, verifiedCctpMessage, type ExpectedCctpTransfer } from "./events.js";

export interface DestinationVerificationOptions {
  readonly client?: DestinationVerifierClient;
  readonly clientFactory?: DestinationClientFactory;
  readonly fetchFn?: typeof globalThis.fetch;
  readonly logger?: Logger;
  readonly signal?: AbortSignal;
  readonly onFailover?: (event: DestinationFailoverEvent) => void;
}

export async function verifyCctpDelivery(
  config: AppConfig,
  db: Transactional,
  transfer: PendingTransfer,
  report: RailReport,
  options: DestinationVerificationOptions = {},
): Promise<VerifiedDelivery | null> {
  const expectedOrigin = config.network === "mainnet" ? "stellar" : "stellar-testnet";
  if (
    transfer.route !== RouteKind.Cctp ||
    transfer.originChain !== expectedOrigin ||
    !report.forwardTxHash ||
    !report.messageBytes ||
    !/^0x[0-9a-fA-F]+$/.test(report.messageBytes) ||
    !isChainKey(transfer.destinationChain)
  )
    return null;
  const source = config.deployments.networks[expectedOrigin];
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

  const rpcUrls = destinationRpcUrlsFor(config, transfer.destinationChain);
  const timeoutMs = config.rails.destinationTimeoutMs;
  const client =
    options.client ??
    options.clientFactory?.({
      chain: transfer.destinationChain,
      chainId: destination.chainId,
      rpcUrls,
      timeoutMs,
      ...(options.logger ? { logger: options.logger } : {}),
    }) ??
    createDestinationVerifierClient(rpcUrls, destination.chainId, {
      chainKey: transfer.destinationChain,
      timeoutMs,
      ...(options.logger ? { logger: options.logger } : {}),
      ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
      ...(options.onFailover ? { onFailover: options.onFailover } : {}),
    });

  if ((await client.getChainId(options.signal)) !== destination.chainId)
    throw new Error("CCTP destination RPC chain mismatch.");
  const receipt = await client.getTransactionReceipt(report.forwardTxHash, options.signal);
  if (
    receipt.transactionHash.toLowerCase() !== report.forwardTxHash.toLowerCase() ||
    receipt.status !== "success"
  )
    return null;
  const head = await client.getBlockNumber(options.signal);
  if (
    head < receipt.blockNumber ||
    head - receipt.blockNumber + 1n < BigInt(destination.confirmations)
  )
    return null;
  const payment = matchingCctpPayment(receipt.logs, raw, expected);
  if (!payment) return null;
  const block = await client.getBlock(receipt.blockNumber, options.signal);
  if (
    block.number !== receipt.blockNumber ||
    block.hash.toLowerCase() !== receipt.blockHash.toLowerCase()
  )
    return null;
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
