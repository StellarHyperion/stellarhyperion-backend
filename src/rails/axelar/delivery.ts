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
  toEvmAddress,
  toHex,
  type Hex,
} from "@hyperion/protocol";
import { createPublicClient, decodeEventLog, http, stringToHex } from "viem";
import type { AppConfig } from "../../config/config.js";
import type { Transactional } from "../../db/pool.js";
import { bigintOf, text } from "../../db/rows.js";
import type { InboundRow, Position } from "../../chains/writers.js";
import type { PendingTransfer, RailReport } from "../types.js";

import {
  ERC20_METADATA_ABI,
  ITS_ABI,
  ITS_TOKEN_MANAGER_ABI,
  matchingPayment,
  type DeliveryLog,
} from "./events.js";
import {
  compareItsTokenMapping,
  evaluateAndRecordItsTokenMapping,
  loadBaselineTokenMapping,
  type ExpectedItsTokenMapping,
  type ItsTokenMappingOperatorDiagnostic,
  type ObservedItsDestinationTokenState,
} from "./token-mapping.js";

export {
  compareItsTokenMapping,
  evaluateAndRecordItsTokenMapping,
  listArchivedTokenMappingAssumptions,
  loadBaselineTokenMapping,
  type EvaluateItsTokenMappingInput,
  type ExpectedItsTokenMapping,
  type ItsTokenMappingAuditRecord,
  type ItsTokenMappingEvaluation,
  type ItsTokenMappingDriftReason,
  type ItsTokenMappingOperatorDiagnostic,
  type ObservedItsDestinationTokenState,
} from "./token-mapping.js";

export interface VerifiedDelivery {
  readonly at: Position;
  readonly row: InboundRow;
}

export interface ItsSourceLaneSnapshot {
  readonly tokenId: Hex;
  readonly sourceChainName: string;
}

export interface ItsDestinationChainProbe {
  getChainId(): Promise<number>;
  getTransactionReceipt(hash: Hex): Promise<{
    readonly status: "success" | "reverted";
    readonly blockNumber: bigint;
    readonly blockHash: Hex;
    readonly transactionHash: Hex;
    readonly logs: readonly DeliveryLog[];
  }>;
  getBlockNumber(): Promise<bigint>;
  getBlock(blockNumber: bigint): Promise<{
    readonly hash: Hex | null;
    readonly timestamp: bigint;
  }>;
  readTokenMappingState(
    its: Hex,
    tokenId: Hex,
    blockNumber: bigint,
  ): Promise<Omit<ObservedItsDestinationTokenState, "tokenId">>;
}

export interface VerifyItsDeliveryOptions {
  readonly readSourceLane?:
    | ((input: {
        readonly rpcUrl: string;
        readonly networkPassphrase: string;
        readonly admin: string;
        readonly adapter: string;
        readonly sourceToken: string;
      }) => Promise<ItsSourceLaneSnapshot>)
    | undefined;
  readonly createDestinationProbe?: ((rpcUrl: string) => ItsDestinationChainProbe) | undefined;
  readonly expectedTokenMapping?: Partial<Omit<ExpectedItsTokenMapping, "tokenId">> | undefined;
  readonly onTokenMappingDrift?:
    ((diagnostic: ItsTokenMappingOperatorDiagnostic) => void) | undefined;
}

async function defaultReadSourceLane(input: {
  readonly rpcUrl: string;
  readonly networkPassphrase: string;
  readonly admin: string;
  readonly adapter: string;
  readonly sourceToken: string;
}): Promise<ItsSourceLaneSnapshot> {
  const stellar = new rpc.Server(input.rpcUrl, { timeout: 15_000 });
  const view = async (
    contract: string,
    method: string,
    args: ReturnType<typeof nativeToScVal>[] = [],
  ) => {
    const tx = new TransactionBuilder(new Account(input.admin, "0"), {
      fee: BASE_FEE,
      networkPassphrase: input.networkPassphrase,
    })
      .addOperation(new Contract(contract).call(method, ...args))
      .setTimeout(60)
      .build();
    const result = await stellar.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(result) || !result.result)
      throw new Error("Source lane cannot be verified.");
    return scValToNative(result.result.retval) as unknown;
  };
  const id = await view(input.adapter, "token_id_for", [new Address(input.sourceToken).toScVal()]);
  if (!(id instanceof Uint8Array) || id.length !== 32)
    throw new Error("Source token id is invalid.");
  const tokenId = toHex(id);
  const adapterConfig = (await view(input.adapter, "get_config")) as { its?: string };
  if (!adapterConfig.its) throw new Error("Source adapter ITS contract is missing.");
  const sourceName = await view(adapterConfig.its, "chain_name");
  if (typeof sourceName !== "string") throw new Error("Source ITS chain_name is invalid.");
  return { tokenId, sourceChainName: sourceName };
}

function defaultCreateDestinationProbe(rpcUrl: string): ItsDestinationChainProbe {
  const client = createPublicClient({
    transport: http(rpcUrl, { timeout: 15_000, retryCount: 0 }),
  });

  return {
    getChainId: () => client.getChainId(),
    getTransactionReceipt: async (hash) => {
      const receipt = await client.getTransactionReceipt({ hash });
      return {
        status: receipt.status === "success" ? "success" : "reverted",
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        transactionHash: receipt.transactionHash,
        logs: receipt.logs,
      };
    },
    getBlockNumber: () => client.getBlockNumber(),
    getBlock: async (blockNumber) => {
      const block = await client.getBlock({ blockNumber });
      return {
        hash: block.hash,
        timestamp: block.timestamp,
      };
    },
    readTokenMappingState: async (its, tokenId, blockNumber) => {
      const registeredTokenAddress = await client.readContract({
        address: its,
        abi: ITS_ABI,
        functionName: "registeredTokenAddress",
        args: [tokenId],
        blockNumber,
      });

      let tokenManager: Hex;
      try {
        tokenManager = await client.readContract({
          address: its,
          abi: ITS_ABI,
          functionName: "deployedTokenManager",
          args: [tokenId],
          blockNumber,
        });
      } catch {
        tokenManager = await client.readContract({
          address: its,
          abi: ITS_ABI,
          functionName: "tokenManagerAddress",
          args: [tokenId],
          blockNumber,
        });
      }

      const managerTokenAddress = await client.readContract({
        address: tokenManager,
        abi: ITS_TOKEN_MANAGER_ABI,
        functionName: "tokenAddress",
        blockNumber,
      });

      const decimals = await client.readContract({
        address: registeredTokenAddress,
        abi: ERC20_METADATA_ABI,
        functionName: "decimals",
        blockNumber,
      });

      let symbol: string | null = null;
      try {
        symbol = await client.readContract({
          address: registeredTokenAddress,
          abi: ERC20_METADATA_ABI,
          functionName: "symbol",
          blockNumber,
        });
      } catch {
        symbol = null;
      }

      return {
        tokenManager,
        registeredTokenAddress,
        managerTokenAddress,
        decimals,
        symbol,
      };
    },
  };
}

function findRegistrySymbol(
  config: AppConfig,
  originChain: string,
  sourceToken: string,
): string | null {
  if (!isChainKey(originChain)) return null;
  const deployment = config.deployments.networks[originChain];
  if (!deployment) return null;
  const entry = Object.entries(
    deployment.tokens as Record<string, { sacId?: string; address?: string }>,
  ).find(([, token]) => {
    const id = token.sacId ?? token.address;
    return id?.toLowerCase() === sourceToken.toLowerCase();
  });
  return entry?.[0] ?? null;
}

function extractObservedReceiptTokenId(
  logs: readonly DeliveryLog[],
  its: string,
  commandId: Hex,
  fallbackTokenId: Hex,
): Hex {
  for (const log of logs) {
    try {
      const event = decodeEventLog({ abi: ITS_ABI, topics: log.topics, data: log.data });
      if (
        event.eventName === "InterchainTransferReceived" &&
        log.address.toLowerCase() === its.toLowerCase() &&
        event.args.commandId.toLowerCase() === commandId.toLowerCase()
      ) {
        return event.args.tokenId;
      }
    } catch {
      // Unrelated logs are ignored.
    }
  }
  return fallbackTokenId;
}

// The rail API supplies a candidate receipt. Only matching confirmed chain events establish delivery.
export async function verifyItsDelivery(
  config: AppConfig,
  db: Transactional,
  transfer: PendingTransfer,
  report: RailReport,
  options: VerifyItsDeliveryOptions = {},
): Promise<VerifiedDelivery | null> {
  const execution = report.execution;
  const source = config.indexer.stellar;
  if (
    !execution ||
    source?.chain !== transfer.originChain ||
    transfer.route !== RouteKind.AxelarIts ||
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

  const sourceLane = await (options.readSourceLane ?? defaultReadSourceLane)({
    rpcUrl: source.rpcUrl,
    networkPassphrase: source.networkPassphrase,
    admin: deployment.admin,
    adapter,
    sourceToken: token,
  });

  const probe = (options.createDestinationProbe ?? defaultCreateDestinationProbe)(
    destination.defaultRpcUrl,
  );
  if ((await probe.getChainId()) !== destination.chainId)
    throw new Error("Destination RPC chain mismatch.");
  const receipt = await probe.getTransactionReceipt(execution.txHash);
  if (receipt.status !== "success") return null;
  const head = await probe.getBlockNumber();
  if (head - receipt.blockNumber + 1n < BigInt(destination.confirmations)) return null;

  const block = await probe.getBlock(receipt.blockNumber);
  if (block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) return null;

  const observedTokenId = extractObservedReceiptTokenId(
    receipt.logs,
    its,
    execution.commandId,
    sourceLane.tokenId,
  );
  const managerState = await probe.readTokenMappingState(
    its as Hex,
    observedTokenId,
    receipt.blockNumber,
  );
  const observedState: ObservedItsDestinationTokenState = {
    tokenId: observedTokenId,
    ...managerState,
  };

  const registrySymbol =
    options.expectedTokenMapping?.registrySymbol ??
    findRegistrySymbol(config, transfer.originChain, token);

  const expectedMapping: ExpectedItsTokenMapping = {
    tokenId: sourceLane.tokenId,
    ...(options.expectedTokenMapping?.tokenManager !== undefined
      ? { tokenManager: options.expectedTokenMapping.tokenManager }
      : {}),
    ...(options.expectedTokenMapping?.destinationToken !== undefined
      ? { destinationToken: options.expectedTokenMapping.destinationToken }
      : {}),
    ...(options.expectedTokenMapping?.decimals !== undefined
      ? { decimals: options.expectedTokenMapping.decimals }
      : {}),
    registrySymbol,
  };

  // Pre-check against archived baseline and explicit expectations before accepting the payment log.
  const archivedBaseline = await loadBaselineTokenMapping(db, {
    originChain: transfer.originChain,
    sourceToken: token,
    destinationChain: transfer.destinationChain,
  });
  const preliminaryDrift = compareItsTokenMapping(
    {
      tokenId: (archivedBaseline?.observedTokenId ?? expectedMapping.tokenId) as Hex,
      ...(expectedMapping.tokenManager !== undefined
        ? { tokenManager: expectedMapping.tokenManager }
        : archivedBaseline !== null
          ? { tokenManager: archivedBaseline.observedTokenManager as Hex }
          : {}),
      ...(expectedMapping.destinationToken !== undefined
        ? { destinationToken: expectedMapping.destinationToken }
        : archivedBaseline !== null
          ? { destinationToken: archivedBaseline.observedDestinationToken as Hex }
          : {}),
      ...(expectedMapping.decimals !== undefined
        ? { decimals: expectedMapping.decimals }
        : archivedBaseline !== null
          ? { decimals: archivedBaseline.observedDecimals }
          : {}),
      registrySymbol,
    },
    observedState,
  );

  const observedAt = new Date(Number(block.timestamp) * 1000);
  if (preliminaryDrift.length > 0) {
    await evaluateAndRecordItsTokenMapping(db, {
      transferId: transfer.transferId,
      originChain: transfer.originChain,
      sourceToken: token,
      destinationChain: transfer.destinationChain,
      destinationBlock: receipt.blockNumber,
      destinationTx: receipt.transactionHash,
      expected: expectedMapping,
      observed: observedState,
      observedAt,
      onDiagnostic: options.onTokenMappingDrift,
    });
    return null;
  }

  const destinationToken = managerState.registeredTokenAddress;
  const payment = matchingPayment(receipt.logs, {
    its,
    token: destinationToken,
    commandId: execution.commandId,
    tokenId: sourceLane.tokenId,
    sourceChain: sourceLane.sourceChainName,
    sourceAddress: stringToHex(text(stored, "sender")),
    recipient,
    amount,
  });
  if (!payment) return null;

  const archived = await evaluateAndRecordItsTokenMapping(db, {
    transferId: transfer.transferId,
    originChain: transfer.originChain,
    sourceToken: token,
    destinationChain: transfer.destinationChain,
    destinationBlock: receipt.blockNumber,
    destinationTx: receipt.transactionHash,
    expected: expectedMapping,
    observed: observedState,
    observedAt,
    onDiagnostic: options.onTokenMappingDrift,
  });
  if (!archived.ok) return null;

  return {
    at: {
      chainKey: transfer.destinationChain,
      block: receipt.blockNumber,
      txHash: receipt.transactionHash,
      logIndex: payment.logIndex,
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
  };
}
