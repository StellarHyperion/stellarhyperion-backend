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
  isStellarChain,
  toHex,
  toEvmAddress,
} from "@hyperion/protocol";
import { stringToHex, type Hex } from "viem";
import { createDestinationVerifierClient } from "../../chains/evm/client.js";
import { destinationRpcUrlsFor, type AppConfig } from "../../config/config.js";
import type { Transactional } from "../../db/pool.js";
import { bigintOf, text } from "../../db/rows.js";
import type { InboundRow, Position } from "../../chains/writers.js";
import type { DestinationVerificationOptions } from "../cctp/delivery.js";
import type { PendingTransfer, RailReport } from "../types.js";

import { ITS_ABI, matchingPayment } from "./events.js";
export interface VerifiedDelivery {
  readonly at: Position;
  readonly row: InboundRow;
}

export interface ItsDeliveryVerificationOptions extends DestinationVerificationOptions {
  readonly sourceView?: (
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
  options: ItsDeliveryVerificationOptions = {},
): Promise<VerifiedDelivery | null> {
  const execution = report.execution;
  const stellarChainKey =
    config.indexer.stellar?.chain ?? (config.network === "mainnet" ? "stellar" : "stellar-testnet");
  const stellarChain = CHAINS[stellarChainKey];
  if (
    !execution ||
    !isStellarChain(stellarChain) ||
    transfer.route !== RouteKind.AxelarIts ||
    transfer.originChain !== stellarChainKey ||
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
  const recipient = toEvmAddress(text(stored, "destination") as Hex);
  const deployment = config.deployments.networks[stellarChainKey];
  if (!deployment) return null;
  const adapter = deployment.adapters[RouteKind.AxelarIts];
  if (!adapter) return null;

  const stellarRpcUrl = config.indexer.stellar?.rpcUrl ?? stellarChain.defaultRpcUrl;
  const stellarPassphrase =
    config.indexer.stellar?.networkPassphrase ?? stellarChain.networkPassphrase;
  const defaultView = async (
    contract: string,
    method: string,
    args: ReturnType<typeof nativeToScVal>[] = [],
  ) => {
    const stellar = new rpc.Server(stellarRpcUrl, { timeout: 15_000 });
    const tx = new TransactionBuilder(new Account(deployment.admin, "0"), {
      fee: BASE_FEE,
      networkPassphrase: stellarPassphrase,
    })
      .addOperation(new Contract(contract).call(method, ...args))
      .setTimeout(60)
      .build();
    const result = await stellar.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(result) || !result.result)
      throw new Error("Source lane cannot be verified.");
    return scValToNative(result.result.retval) as unknown;
  };
  const view = options.sourceView ?? defaultView;

  const id = await view(adapter, "token_id_for", [new Address(token).toScVal()]);
  if (!(id instanceof Uint8Array) || id.length !== 32)
    throw new Error("Source token id is invalid.");
  const tokenId = toHex(id);

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
    throw new Error("Destination RPC chain mismatch.");
  const receipt = await client.getTransactionReceipt(execution.txHash, options.signal);
  if (
    receipt.transactionHash.toLowerCase() !== execution.txHash.toLowerCase() ||
    receipt.status !== "success"
  )
    return null;
  const head = await client.getBlockNumber(options.signal);
  if (
    head < receipt.blockNumber ||
    head - receipt.blockNumber + 1n < BigInt(destination.confirmations)
  )
    return null;
  const rawDestinationToken = await client.readContract(
    {
      address: its as Hex,
      abi: ITS_ABI,
      functionName: "registeredTokenAddress",
      args: [tokenId],
    },
    options.signal,
  );
  if (
    typeof rawDestinationToken !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(rawDestinationToken) ||
    /^0x0{40}$/.test(rawDestinationToken)
  )
    return null;
  const destinationToken = rawDestinationToken as Hex;
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
      railMessageId: execution.commandId,
      recipient: recipient.toLowerCase(),
      token: destinationToken.toLowerCase(),
      amount,
      delivered: true,
      claimId: null,
    },
  };
}
