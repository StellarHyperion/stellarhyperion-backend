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
} from "@hyperion/protocol";
import { createPublicClient, http, stringToHex } from "viem";
import type { AppConfig } from "../../config/config.js";
import type { Transactional } from "../../db/pool.js";
import { bigintOf, text } from "../../db/rows.js";
import type { InboundRow, Position } from "../../chains/writers.js";
import type { PendingTransfer, RailReport } from "../types.js";

import { ITS_ABI, diagnoseItsReceiptLogs, type DeliveryLog } from "./events.js";

const ZERO_EVM_ADDRESS = `0x${"0".repeat(40)}`;

export interface VerifiedDelivery {
  readonly at: Position;
  readonly row: InboundRow;
}

export type ReceiptUnavailableReason =
  | "source_rpc_unavailable"
  | "destination_rpc_unavailable"
  | "receipt_not_found"
  | "insufficient_confirmations"
  | "non_canonical_block";

export type PayoutUnverifiedReason =
  | "missing_execution_coordinates"
  | "unsupported_lane"
  | "source_lane_unverifiable"
  | "destination_chain_mismatch"
  | "invalid_destination_token"
  | "receipt_reverted"
  | "missing_its_command_event"
  | "mismatched_its_command_fields"
  | "missing_erc20_transfer_event";

export type ItsDeliveryOutcome =
  | { readonly kind: "not_applicable" }
  | { readonly kind: "verified"; readonly delivery: VerifiedDelivery }
  | {
      readonly kind: "receipt_unavailable";
      readonly reason: ReceiptUnavailableReason;
      readonly detail: string;
    }
  | {
      readonly kind: "payout_unverified";
      readonly reason: PayoutUnverifiedReason;
      readonly detail: string;
    };

export interface ItsSourceLaneInfo {
  readonly tokenId: `0x${string}`;
  readonly sourceChainName: string;
}

export interface ItsEvmChainProbe {
  getChainId(): Promise<number>;
  getTransactionReceipt(hash: `0x${string}`): Promise<{
    readonly status: "success" | "reverted";
    readonly blockNumber: bigint;
    readonly blockHash: `0x${string}`;
    readonly transactionHash: `0x${string}`;
    readonly logs: readonly DeliveryLog[];
  }>;
  getBlockNumber(): Promise<bigint>;
  registeredTokenAddress(its: `0x${string}`, tokenId: `0x${string}`): Promise<`0x${string}`>;
  getBlock(blockNumber: bigint): Promise<{
    readonly hash: `0x${string}` | null;
    readonly timestamp: bigint;
  }>;
}

export interface ItsDeliveryDeps {
  readonly readSourceLane?:
    | ((input: {
        readonly rpcUrl: string;
        readonly networkPassphrase: string;
        readonly admin: string;
        readonly adapter: string;
        readonly sourceToken: string;
      }) => Promise<ItsSourceLaneInfo>)
    | undefined;
  readonly createEvmProbe?: ((rpcUrl: string) => ItsEvmChainProbe) | undefined;
}

export class ItsSourceLaneVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ItsSourceLaneVerificationError";
  }
}

function sanitizeErrorDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+:[^/\s@]+)@/gi, "$1[REDACTED]@")
    .replace(/([?&](?:api[_-]?key|token|secret|password|auth|key)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, "$1 [REDACTED]")
    .slice(0, 240);
}

function isReceiptNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TransactionReceiptNotFoundError") return true;
  return /transaction receipt.*not be found|receipt.*not found|could not be found/i.test(
    error.message,
  );
}

async function defaultReadSourceLane(input: {
  readonly rpcUrl: string;
  readonly networkPassphrase: string;
  readonly admin: string;
  readonly adapter: string;
  readonly sourceToken: string;
}): Promise<ItsSourceLaneInfo> {
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
    if (!rpc.Api.isSimulationSuccess(result) || !result.result) {
      throw new ItsSourceLaneVerificationError("Source lane cannot be verified.");
    }
    return scValToNative(result.result.retval) as unknown;
  };

  const id = await view(input.adapter, "token_id_for", [new Address(input.sourceToken).toScVal()]);
  if (!(id instanceof Uint8Array) || id.length !== 32) {
    throw new ItsSourceLaneVerificationError("Source token id is invalid.");
  }
  const tokenId = toHex(id);
  const adapterConfig = (await view(input.adapter, "get_config")) as { its?: string };
  if (!adapterConfig.its) {
    throw new ItsSourceLaneVerificationError("Source adapter ITS contract is missing.");
  }
  const sourceName = await view(adapterConfig.its, "chain_name");
  if (typeof sourceName !== "string" || sourceName.length === 0) {
    throw new ItsSourceLaneVerificationError("Source ITS chain_name is invalid.");
  }

  return { tokenId, sourceChainName: sourceName };
}

function defaultCreateEvmProbe(rpcUrl: string): ItsEvmChainProbe {
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
    registeredTokenAddress: (its, tokenId) =>
      client.readContract({
        address: its,
        abi: ITS_ABI,
        functionName: "registeredTokenAddress",
        args: [tokenId],
      }),
    getBlock: async (blockNumber) => {
      const block = await client.getBlock({ blockNumber });
      return {
        hash: block.hash,
        timestamp: block.timestamp,
      };
    },
  };
}

/**
 * Evaluates a candidate Axelar ITS execution, distinguishing receipt unavailability from
 * unverified token payout and confirmed destination delivery.
 */
export async function verifyItsDeliveryOutcome(
  config: AppConfig,
  db: Transactional,
  transfer: PendingTransfer,
  report: RailReport,
  deps: ItsDeliveryDeps = {},
): Promise<ItsDeliveryOutcome> {
  if (transfer.route !== RouteKind.AxelarIts) {
    return { kind: "not_applicable" };
  }

  const execution = report.execution;
  if (!execution) {
    if (report.providerSignal === "candidate_executed") {
      return {
        kind: "payout_unverified",
        reason: "missing_execution_coordinates",
        detail: "provider reported executed without valid destination txHash and commandId",
      };
    }
    return { kind: "not_applicable" };
  }

  const source = config.indexer.stellar;
  if (source?.chain !== transfer.originChain || !isChainKey(transfer.destinationChain)) {
    return {
      kind: "payout_unverified",
      reason: "unsupported_lane",
      detail: "transfer lane is not a supported Stellar-to-EVM Axelar ITS route",
    };
  }

  const destination = CHAINS[transfer.destinationChain];
  const its = RAIL_CONTRACTS[transfer.destinationChain]?.axelar?.interchainTokenService;
  if (!isEvmChain(destination) || !its?.startsWith("0x")) {
    return {
      kind: "payout_unverified",
      reason: "unsupported_lane",
      detail: `destination chain ${transfer.destinationChain} has no EVM ITS contract`,
    };
  }

  const { rows } = await db.query(
    "SELECT sender, token, net_amount, destination FROM outbound_transfer WHERE id = $1",
    [String(transfer.transferId)],
  );
  const stored = rows[0];
  if (!stored) {
    return {
      kind: "payout_unverified",
      reason: "unsupported_lane",
      detail: "outbound_transfer row missing",
    };
  }

  const sourceToken = text(stored, "token");
  const amount = bigintOf(stored, "net_amount");
  let recipient: `0x${string}`;
  try {
    recipient = toEvmAddress(text(stored, "destination") as `0x${string}`);
  } catch (error) {
    return {
      kind: "payout_unverified",
      reason: "unsupported_lane",
      detail: sanitizeErrorDetail(error),
    };
  }

  const deployment = config.deployments.networks[source.chain];
  const adapter = deployment?.adapters[RouteKind.AxelarIts];
  if (!deployment || !adapter) {
    return {
      kind: "payout_unverified",
      reason: "unsupported_lane",
      detail: `missing Axelar ITS adapter deployment on ${source.chain}`,
    };
  }

  const readSourceLane = deps.readSourceLane ?? defaultReadSourceLane;
  let laneInfo: ItsSourceLaneInfo;
  try {
    laneInfo = await readSourceLane({
      rpcUrl: source.rpcUrl,
      networkPassphrase: source.networkPassphrase,
      admin: deployment.admin,
      adapter,
      sourceToken,
    });
  } catch (error) {
    if (error instanceof ItsSourceLaneVerificationError) {
      return {
        kind: "payout_unverified",
        reason: "source_lane_unverifiable",
        detail: sanitizeErrorDetail(error),
      };
    }
    return {
      kind: "receipt_unavailable",
      reason: "source_rpc_unavailable",
      detail: sanitizeErrorDetail(error),
    };
  }

  const evm = (deps.createEvmProbe ?? defaultCreateEvmProbe)(destination.defaultRpcUrl);

  let chainId: number;
  try {
    chainId = await evm.getChainId();
  } catch (error) {
    return {
      kind: "receipt_unavailable",
      reason: "destination_rpc_unavailable",
      detail: sanitizeErrorDetail(error),
    };
  }
  if (chainId !== destination.chainId) {
    return {
      kind: "payout_unverified",
      reason: "destination_chain_mismatch",
      detail: `destination RPC returned chainId ${String(chainId)}, expected ${String(destination.chainId)}`,
    };
  }

  let receipt: Awaited<ReturnType<ItsEvmChainProbe["getTransactionReceipt"]>>;
  try {
    receipt = await evm.getTransactionReceipt(execution.txHash);
  } catch (error) {
    if (isReceiptNotFoundError(error)) {
      return {
        kind: "receipt_unavailable",
        reason: "receipt_not_found",
        detail: `receipt ${execution.txHash} is not available on destination RPC yet`,
      };
    }
    return {
      kind: "receipt_unavailable",
      reason: "destination_rpc_unavailable",
      detail: sanitizeErrorDetail(error),
    };
  }

  if (receipt.status !== "success") {
    return {
      kind: "payout_unverified",
      reason: "receipt_reverted",
      detail: `destination transaction ${execution.txHash} reverted`,
    };
  }

  let head: bigint;
  try {
    head = await evm.getBlockNumber();
  } catch (error) {
    return {
      kind: "receipt_unavailable",
      reason: "destination_rpc_unavailable",
      detail: sanitizeErrorDetail(error),
    };
  }

  const confirmations = head - receipt.blockNumber + 1n;
  if (confirmations < BigInt(destination.confirmations)) {
    return {
      kind: "receipt_unavailable",
      reason: "insufficient_confirmations",
      detail: `receipt has ${confirmations.toString()} of ${String(destination.confirmations)} confirmations`,
    };
  }

  let destinationToken: `0x${string}`;
  try {
    destinationToken = await evm.registeredTokenAddress(its as `0x${string}`, laneInfo.tokenId);
  } catch (error) {
    return {
      kind: "receipt_unavailable",
      reason: "destination_rpc_unavailable",
      detail: sanitizeErrorDetail(error),
    };
  }

  if (
    !/^0x[0-9a-fA-F]{40}$/.test(destinationToken) ||
    destinationToken.toLowerCase() === ZERO_EVM_ADDRESS
  ) {
    return {
      kind: "payout_unverified",
      reason: "invalid_destination_token",
      detail: "ITS registeredTokenAddress returned an unregistered or invalid token contract",
    };
  }

  const logDiagnosis = diagnoseItsReceiptLogs(receipt.logs, {
    its,
    token: destinationToken,
    commandId: execution.commandId,
    tokenId: laneInfo.tokenId,
    sourceChain: laneInfo.sourceChainName,
    sourceAddress: stringToHex(text(stored, "sender")),
    recipient,
    amount,
  });

  if (logDiagnosis.kind !== "verified") {
    return {
      kind: "payout_unverified",
      reason: logDiagnosis.reason,
      detail: `candidate execution receipt failed token verification: ${logDiagnosis.reason}`,
    };
  }

  let block: Awaited<ReturnType<ItsEvmChainProbe["getBlock"]>>;
  try {
    block = await evm.getBlock(receipt.blockNumber);
  } catch (error) {
    return {
      kind: "receipt_unavailable",
      reason: "destination_rpc_unavailable",
      detail: sanitizeErrorDetail(error),
    };
  }

  if (block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) {
    return {
      kind: "receipt_unavailable",
      reason: "non_canonical_block",
      detail: "receipt blockHash does not match canonical block at height",
    };
  }

  return {
    kind: "verified",
    delivery: {
      at: {
        chainKey: transfer.destinationChain,
        block: receipt.blockNumber,
        txHash: receipt.transactionHash,
        logIndex: logDiagnosis.payment.logIndex,
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
    },
  };
}

// The rail API supplies a candidate receipt. Only matching confirmed chain events establish delivery.
export async function verifyItsDelivery(
  config: AppConfig,
  db: Transactional,
  transfer: PendingTransfer,
  report: RailReport,
  deps: ItsDeliveryDeps = {},
): Promise<VerifiedDelivery | null> {
  const outcome = await verifyItsDeliveryOutcome(config, db, transfer, report, deps);
  return outcome.kind === "verified" ? outcome.delivery : null;
}
