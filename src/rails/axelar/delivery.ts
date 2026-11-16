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
import { createPublicClient, http, stringToHex, type Hex } from "viem";
import type { AppConfig } from "../../config/config.js";
import type { Transactional } from "../../db/pool.js";
import { bigintOf, text } from "../../db/rows.js";
import type { InboundRow, ItsProvenanceRow, Position } from "../../chains/writers.js";
import type { PendingTransfer, RailReport } from "../types.js";

import { ITS_ABI, TOKEN_MANAGER_ABI, matchItsDelivery, type DeliveryLog } from "./events.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface ItsReceipt {
  readonly status: "success" | "reverted";
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly transactionHash: Hex;
  readonly logs: readonly DeliveryLog[];
}

export interface ItsBlock {
  readonly hash: Hex | null;
  readonly timestamp: bigint;
}

export interface ItsEvmClient {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getTransactionReceipt(args: { hash: Hex }): Promise<ItsReceipt>;
  getBlock(args: { blockNumber: bigint }): Promise<ItsBlock>;
  readRegisteredToken(its: Hex, tokenId: Hex, blockNumber: bigint): Promise<Hex>;
  readDeployedTokenManager(its: Hex, tokenId: Hex, blockNumber: bigint): Promise<Hex>;
  readManagerTokenAddress(tokenManager: Hex, blockNumber: bigint): Promise<Hex>;
  readManagerImplementationType(tokenManager: Hex, blockNumber: bigint): Promise<bigint | null>;
}

export interface VerifyItsDeliveryOptions {
  readonly stellarView?: (
    contract: string,
    method: string,
    args?: ReturnType<typeof nativeToScVal>[],
  ) => Promise<unknown>;
  readonly evmClient?: ItsEvmClient;
  readonly now?: () => Date;
}

export interface VerifiedDelivery {
  readonly at: Position;
  readonly row: InboundRow;
  readonly itsProvenance?: ItsProvenanceRow | undefined;
}

function createDefaultEvmClient(rpcUrl: string): ItsEvmClient {
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
    readRegisteredToken: (its, tokenId, blockNumber) =>
      client.readContract({
        address: its,
        abi: ITS_ABI,
        functionName: "registeredTokenAddress",
        args: [tokenId],
        blockNumber,
      }),
    readDeployedTokenManager: (its, tokenId, blockNumber) =>
      client.readContract({
        address: its,
        abi: ITS_ABI,
        functionName: "deployedTokenManager",
        args: [tokenId],
        blockNumber,
      }),
    readManagerTokenAddress: (tokenManager, blockNumber) =>
      client.readContract({
        address: tokenManager,
        abi: TOKEN_MANAGER_ABI,
        functionName: "tokenAddress",
        blockNumber,
      }),
    readManagerImplementationType: async (tokenManager, blockNumber) => {
      try {
        return await client.readContract({
          address: tokenManager,
          abi: TOKEN_MANAGER_ABI,
          functionName: "implementationType",
          blockNumber,
        });
      } catch {
        return null;
      }
    },
  };
}

// The rail API supplies a candidate receipt. Only matching confirmed chain events establish delivery.
export async function verifyItsDelivery(
  config: AppConfig,
  db: Transactional,
  transfer: PendingTransfer,
  report: RailReport,
  options?: VerifyItsDeliveryOptions,
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
  const defaultView = async (
    contract: string,
    method: string,
    args: ReturnType<typeof nativeToScVal>[] = [],
  ) => {
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
  };
  const view = options?.stellarView ?? defaultView;
  const id = await view(adapter, "token_id_for", [new Address(token).toScVal()]);
  if (!(id instanceof Uint8Array) || id.length !== 32)
    throw new Error("Source token id is invalid.");
  const tokenId = toHex(id);
  const client = options?.evmClient ?? createDefaultEvmClient(destination.defaultRpcUrl);
  if ((await client.getChainId()) !== destination.chainId)
    throw new Error("Destination RPC chain mismatch.");
  const receipt = await client.getTransactionReceipt({ hash: execution.txHash });
  if (receipt.status !== "success") return null;
  const head = await client.getBlockNumber();
  if (head - receipt.blockNumber + 1n < BigInt(destination.confirmations)) return null;
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) return null;

  const itsAddress = its as Hex;
  const destinationToken = await client.readRegisteredToken(
    itsAddress,
    tokenId,
    receipt.blockNumber,
  );
  if (destinationToken.toLowerCase() === ZERO_ADDRESS) return null;

  const tokenManager = await client.readDeployedTokenManager(
    itsAddress,
    tokenId,
    receipt.blockNumber,
  );
  if (tokenManager.toLowerCase() === ZERO_ADDRESS) return null;

  const managerToken = await client.readManagerTokenAddress(tokenManager, receipt.blockNumber);
  if (managerToken.toLowerCase() !== destinationToken.toLowerCase()) return null;

  const rawImplType = await client.readManagerImplementationType(tokenManager, receipt.blockNumber);
  const tokenManagerType =
    rawImplType !== null && rawImplType >= 0n && rawImplType <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(rawImplType)
      : null;

  const adapterConfig = (await view(adapter, "get_config")) as { its?: string };
  if (!adapterConfig.its) return null;
  const sourceName = await view(adapterConfig.its, "chain_name");
  if (typeof sourceName !== "string") return null;
  const matched = matchItsDelivery(receipt.logs, {
    its,
    token: destinationToken,
    commandId: execution.commandId,
    tokenId,
    sourceChain: sourceName,
    sourceAddress: stringToHex(text(stored, "sender")),
    recipient,
    amount,
  });
  if (!matched) return null;

  const observedAt = new Date(Number(block.timestamp) * 1000);
  const verifiedAt = options?.now ? options.now() : new Date();
  const gmpMessageId = report.commandProvenance?.messageId ?? report.reference;
  const parentMessageId = report.commandProvenance?.parentMessageId ?? null;

  return {
    at: {
      chainKey: transfer.destinationChain,
      block: receipt.blockNumber,
      txHash: receipt.transactionHash,
      logIndex: matched.paymentLog.logIndex,
      observedAt,
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
    itsProvenance: {
      destinationChain: transfer.destinationChain,
      route: transfer.route,
      sourceChain: transfer.originChain,
      sourceNonce: transfer.nonce,
      commandId: matched.commandId.toLowerCase(),
      gmpMessageId,
      parentMessageId,
      axelarSourceChain: matched.sourceChain,
      sourceAddressHex: matched.sourceAddress.toLowerCase(),
      dataHash: matched.dataHash.toLowerCase(),
      executionTx: receipt.transactionHash.toLowerCase(),
      itsLogIndex: matched.receivedLog.logIndex,
      proofBlock: receipt.blockNumber,
      proofBlockHash: block.hash.toLowerCase(),
      interchainTokenService: its.toLowerCase(),
      tokenId: matched.tokenId.toLowerCase(),
      tokenManager: tokenManager.toLowerCase(),
      tokenManagerType,
      registeredToken: destinationToken.toLowerCase(),
      paymentFrom: matched.paymentFrom.toLowerCase(),
      paymentLogIndex: matched.paymentLog.logIndex,
      verifiedAt,
    },
  };
}
