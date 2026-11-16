import type { nativeToScVal } from "@stellar/stellar-sdk";
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";
import {
  CHAINS,
  RAIL_CONTRACTS,
  RouteKind,
  isChainKey,
  isEvmChain,
  toHex,
  toEvmAddress,
} from "@hyperion/protocol";
import { createPublicClient, http, stringToHex } from "viem";
import type { AppConfig } from "../../config/config.js";
import type { Transactional } from "../../db/pool.js";
import { bigintOf, text } from "../../db/rows.js";
import type { InboundRow, Position } from "../../chains/writers.js";
import { CandidateReceiptCache, type CandidateReceiptRpcClient } from "../receipt-cache.js";
import type { PendingTransfer, RailReport } from "../types.js";

import { ITS_ABI, matchingPayment } from "./events.js";
export interface VerifiedDelivery {
  readonly at: Position;
  readonly row: InboundRow;
}

export interface ItsEvmClient extends CandidateReceiptRpcClient {
  readContract(args: {
    readonly address: `0x${string}`;
    readonly abi: typeof ITS_ABI;
    readonly functionName: "registeredTokenAddress";
    readonly args: readonly [`0x${string}`];
  }): Promise<`0x${string}`>;
}

export interface ItsDeliveryOptions {
  readonly receiptCache?: CandidateReceiptCache;
  readonly evmClientFactory?: (chainKey: string, rpcUrl: string) => ItsEvmClient;
  readonly stellarView?: (
    contract: string,
    method: string,
    args?: ReturnType<typeof nativeToScVal>[],
  ) => Promise<unknown>;
}

// The rail API supplies a candidate receipt. Only matching confirmed chain events establish delivery.
export async function verifyItsDelivery(
  config: AppConfig,
  db: Transactional,
  transfer: PendingTransfer,
  report: RailReport,
  options: ItsDeliveryOptions = {},
): Promise<VerifiedDelivery | null> {
  const execution = report.execution;
  const source = config.indexer.stellar;
  if (
    !execution ||
    !source ||
    transfer.route !== RouteKind.AxelarIts ||
    transfer.originChain !== source.chain ||
    !isChainKey(transfer.destinationChain)
  )
    return null;
  const destination = CHAINS[transfer.destinationChain];
  const its = RAIL_CONTRACTS[transfer.destinationChain]?.axelar?.interchainTokenService;
  if (!isEvmChain(destination) || !its?.startsWith("0x")) return null;
  const { rows } = await db.query(
    "SELECT sender, token, net_amount, destination FROM outbound_transfer WHERE id = $1",
    [String(transfer.transferId)],
  );
  const stored = rows[0];
  if (!stored) return null;
  const token = text(stored, "token");
  const amount = bigintOf(stored, "net_amount");
  const recipient = toEvmAddress(text(stored, "destination") as `0x${string}`);
  const deployment = config.deployments.networks[source.chain];
  if (!deployment) return null;
  const adapter = deployment.adapters[RouteKind.AxelarIts];
  if (!adapter) return null;
  const view =
    options.stellarView ??
    (async (contract: string, method: string, args: ReturnType<typeof nativeToScVal>[] = []) => {
      const stellar = new rpc.Server(source.rpcUrl, { timeout: 15_000 });
      const tx = new TransactionBuilder(new Account(deployment.admin, "0"), {
        fee: BASE_FEE,
        networkPassphrase: source.networkPassphrase,
      })
        .addOperation(new Contract(contract).call(method, ...args))
        .setTimeout(60)
        .build();
      const result = await stellar.simulateTransaction(tx);
      if (!rpc.Api.isSimulationSuccess(result) || !result.result)
        throw new Error("Source lane cannot be verified.");
      return scValToNative(result.result.retval) as unknown;
    });
  const id = await view(adapter, "token_id_for", [new Address(token).toScVal()]);
  if (!(id instanceof Uint8Array) || id.length !== 32)
    throw new Error("Source token id is invalid.");
  const tokenId = toHex(id);
  const client: ItsEvmClient = options.evmClientFactory
    ? options.evmClientFactory(transfer.destinationChain, destination.defaultRpcUrl)
    : createPublicClient({
        transport: http(destination.defaultRpcUrl, { timeout: 15_000, retryCount: 0 }),
      });
  const cache = options.receiptCache ?? new CandidateReceiptCache({ maxEntries: 1 });
  const receipt = await cache.getConfirmedReceipt({
    chainKey: transfer.destinationChain,
    expectedChainId: destination.chainId,
    confirmations: destination.confirmations,
    txHash: execution.txHash,
    client,
  });
  if (!receipt) return null;
  const destinationToken = await client.readContract({
    address: its as `0x${string}`,
    abi: ITS_ABI,
    functionName: "registeredTokenAddress",
    args: [tokenId],
  });
  const adapterConfig = (await view(adapter, "get_config")) as { its?: string };
  if (!adapterConfig.its) return null;
  const sourceName = await view(adapterConfig.its, "chain_name");
  if (typeof sourceName !== "string") return null;
  const payment = matchingPayment(receipt.logs, {
    its,
    token: destinationToken,
    commandId: execution.commandId,
    tokenId,
    sourceChain: sourceName,
    sourceAddress: stringToHex(text(stored, "sender")),
    recipient,
    amount,
  });
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
      railMessageId: execution.commandId,
      recipient: recipient.toLowerCase(),
      token: destinationToken.toLowerCase(),
      amount,
      delivered: true,
      claimId: null,
    },
  };
}
