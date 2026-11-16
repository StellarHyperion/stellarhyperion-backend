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
import type { Queryable, Transactional } from "../../db/pool.js";
import { bigintOf, text } from "../../db/rows.js";
import {
  writeItsVerificationDiagnostic,
  type InboundRow,
  type ItsVerificationDiagnosticRow,
  type Position,
} from "../../chains/writers.js";
import type { PendingTransfer, RailReport } from "../types.js";

import {
  ITS_ABI,
  boundDiagnosticIdentifier,
  evaluateItsDeliveryLogs,
  type DeliveryLog,
  type ItsDiagnosticCategory,
} from "./events.js";

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

export interface ItsDiagnosticEvmClient {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getTransactionReceipt(args: { hash: Hex }): Promise<ItsReceipt | null>;
  getBlock(args: { blockNumber: bigint }): Promise<ItsBlock | null>;
  readRegisteredToken(its: Hex, tokenId: Hex, blockNumber: bigint): Promise<Hex>;
}

export type StellarContractView = (
  contract: string,
  method: string,
  args?: ReturnType<typeof nativeToScVal>[],
) => Promise<unknown>;

export interface VerifyItsDeliveryOptions {
  readonly stellarView?: StellarContractView;
  readonly evmClient?: ItsDiagnosticEvmClient;
  readonly persistDiagnostics?: boolean;
  readonly now?: () => Date;
}

export interface VerifiedDelivery {
  readonly at: Position;
  readonly row: InboundRow;
}

export type ItsVerificationOutcome =
  | { readonly kind: "not_applicable" }
  | { readonly kind: "verified"; readonly delivery: VerifiedDelivery }
  | { readonly kind: "diagnostic"; readonly diagnostic: ItsVerificationDiagnosticRow };

function createDefaultEvmClient(rpcUrl: string): ItsDiagnosticEvmClient {
  const client = createPublicClient({
    transport: http(rpcUrl, { timeout: 15_000, retryCount: 0 }),
  });
  return {
    getChainId: () => client.getChainId(),
    getBlockNumber: () => client.getBlockNumber(),
    getTransactionReceipt: async ({ hash }) => {
      try {
        const receipt = await client.getTransactionReceipt({ hash });
        return {
          status: receipt.status,
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
          transactionHash: receipt.transactionHash,
          logs: receipt.logs,
        };
      } catch (error) {
        if (error instanceof Error && /not be found|not found/i.test(error.message)) {
          return null;
        }
        throw error;
      }
    },
    getBlock: async ({ blockNumber }) => {
      try {
        const block = await client.getBlock({ blockNumber });
        return { hash: block.hash, timestamp: block.timestamp };
      } catch (error) {
        if (error instanceof Error && /not be found|not found/i.test(error.message)) {
          return null;
        }
        throw error;
      }
    },
    readRegisteredToken: (its, tokenId, blockNumber) =>
      client.readContract({
        address: its,
        abi: ITS_ABI,
        functionName: "registeredTokenAddress",
        args: [tokenId],
        blockNumber,
      }),
  };
}

function buildDiagnostic(
  transfer: PendingTransfer,
  disposition: "unavailable" | "mismatch",
  category: ItsDiagnosticCategory,
  fields: {
    readonly candidateTx?: string | null;
    readonly candidateCommandId?: string | null;
    readonly candidateBlock?: bigint | null;
    readonly expectedValue?: string | null;
    readonly observedValue?: string | null;
    readonly observedAt: Date;
  },
): ItsVerificationDiagnosticRow {
  return {
    transferId: transfer.transferId,
    destinationChain: transfer.destinationChain,
    route: transfer.route,
    sourceChain: transfer.originChain,
    sourceNonce: transfer.nonce,
    disposition,
    category,
    candidateTx: boundDiagnosticIdentifier(fields.candidateTx),
    candidateCommandId: boundDiagnosticIdentifier(fields.candidateCommandId),
    candidateBlock: fields.candidateBlock ?? null,
    expectedValue: boundDiagnosticIdentifier(fields.expectedValue),
    observedValue: boundDiagnosticIdentifier(fields.observedValue),
    observedAt: fields.observedAt,
  };
}

export async function inspectItsDelivery(
  config: AppConfig,
  db: Transactional,
  transfer: PendingTransfer,
  report: RailReport,
  options?: VerifyItsDeliveryOptions,
): Promise<ItsVerificationOutcome> {
  const source = config.indexer.stellar;
  if (
    !source ||
    transfer.route !== RouteKind.AxelarIts ||
    transfer.originChain !== source.chain ||
    !isChainKey(transfer.destinationChain)
  ) {
    return { kind: "not_applicable" };
  }

  const now = options?.now ? options.now() : new Date();
  const execution = report.execution;
  if (!execution) {
    if (report.candidateIssue) {
      return {
        kind: "diagnostic",
        diagnostic: buildDiagnostic(transfer, "unavailable", "execution_candidate_missing", {
          candidateTx: report.candidateIssue.observedTxHash,
          candidateCommandId: report.candidateIssue.observedCommandId,
          expectedValue: "bytes32_tx_and_command",
          observedValue: report.candidateIssue.reason,
          observedAt: now,
        }),
      };
    }
    return { kind: "not_applicable" };
  }

  const destination = CHAINS[transfer.destinationChain];
  const its = RAIL_CONTRACTS[transfer.destinationChain]?.axelar?.interchainTokenService;
  if (!isEvmChain(destination) || !its?.startsWith("0x")) {
    return { kind: "not_applicable" };
  }

  const { rows } = await db.query(
    "SELECT sender, token, net_amount, destination FROM outbound_transfer WHERE id = $1",
    [String(transfer.transferId)],
  );
  const stored = rows[0];
  if (!stored) return { kind: "not_applicable" };

  const sender = text(stored, "sender");
  const token = text(stored, "token");
  const amount = bigintOf(stored, "net_amount");
  const recipient = toEvmAddress(text(stored, "destination") as `0x${string}`);

  const deployment = config.deployments.networks[source.chain];
  if (!deployment) return { kind: "not_applicable" };
  const adapter = deployment.adapters[RouteKind.AxelarIts];
  if (!adapter) return { kind: "not_applicable" };

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
    if (!rpc.Api.isSimulationSuccess(result) || !result.result) {
      throw new Error("Source lane cannot be verified.");
    }
    return scValToNative(result.result.retval) as unknown;
  };
  const view = options?.stellarView ?? defaultView;
  const id = await view(adapter, "token_id_for", [new Address(token).toScVal()]);
  if (!(id instanceof Uint8Array) || id.length !== 32) {
    throw new Error("Source token id is invalid.");
  }
  const tokenId = toHex(id);

  const client = options?.evmClient ?? createDefaultEvmClient(destination.defaultRpcUrl);
  if ((await client.getChainId()) !== destination.chainId) {
    throw new Error("Destination RPC chain mismatch.");
  }

  const receipt = await client.getTransactionReceipt({ hash: execution.txHash });
  if (receipt === null) {
    return {
      kind: "diagnostic",
      diagnostic: buildDiagnostic(transfer, "unavailable", "receipt_unavailable", {
        candidateTx: execution.txHash.toLowerCase(),
        candidateCommandId: execution.commandId.toLowerCase(),
        expectedValue: execution.txHash.toLowerCase(),
        observedValue: null,
        observedAt: now,
      }),
    };
  }

  if (receipt.status !== "success") {
    return {
      kind: "diagnostic",
      diagnostic: buildDiagnostic(transfer, "mismatch", "reverted_execution_receipt", {
        candidateTx: receipt.transactionHash.toLowerCase(),
        candidateCommandId: execution.commandId.toLowerCase(),
        candidateBlock: receipt.blockNumber,
        expectedValue: "success",
        observedValue: receipt.status,
        observedAt: now,
      }),
    };
  }

  const head = await client.getBlockNumber();
  const confirmationsObserved = head - receipt.blockNumber + 1n;
  if (confirmationsObserved < BigInt(destination.confirmations)) {
    return {
      kind: "diagnostic",
      diagnostic: buildDiagnostic(transfer, "unavailable", "insufficient_confirmations", {
        candidateTx: receipt.transactionHash.toLowerCase(),
        candidateCommandId: execution.commandId.toLowerCase(),
        candidateBlock: receipt.blockNumber,
        expectedValue: String(destination.confirmations),
        observedValue: confirmationsObserved.toString(),
        observedAt: now,
      }),
    };
  }

  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (block?.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) {
    return {
      kind: "diagnostic",
      diagnostic: buildDiagnostic(transfer, "unavailable", "non_canonical_receipt_block", {
        candidateTx: receipt.transactionHash.toLowerCase(),
        candidateCommandId: execution.commandId.toLowerCase(),
        candidateBlock: receipt.blockNumber,
        expectedValue: receipt.blockHash.toLowerCase(),
        observedValue: block?.hash?.toLowerCase() ?? null,
        observedAt: now,
      }),
    };
  }

  const destinationToken = await client.readRegisteredToken(
    its as Hex,
    tokenId,
    receipt.blockNumber,
  );
  if (destinationToken.toLowerCase() === ZERO_ADDRESS) {
    return {
      kind: "diagnostic",
      diagnostic: buildDiagnostic(transfer, "mismatch", "token_mismatch", {
        candidateTx: receipt.transactionHash.toLowerCase(),
        candidateCommandId: execution.commandId.toLowerCase(),
        candidateBlock: receipt.blockNumber,
        expectedValue: tokenId.toLowerCase(),
        observedValue: ZERO_ADDRESS,
        observedAt: now,
      }),
    };
  }

  const adapterConfig = (await view(adapter, "get_config")) as { its?: string };
  if (!adapterConfig.its) return { kind: "not_applicable" };
  const sourceName = await view(adapterConfig.its, "chain_name");
  if (typeof sourceName !== "string") return { kind: "not_applicable" };

  const logEvaluation = evaluateItsDeliveryLogs(receipt.logs, {
    its,
    token: destinationToken,
    commandId: execution.commandId,
    tokenId,
    sourceChain: sourceName,
    sourceAddress: stringToHex(sender),
    recipient,
    amount,
  });

  if (logEvaluation.kind === "mismatch") {
    return {
      kind: "diagnostic",
      diagnostic: buildDiagnostic(transfer, "mismatch", logEvaluation.category, {
        candidateTx: receipt.transactionHash.toLowerCase(),
        candidateCommandId: execution.commandId.toLowerCase(),
        candidateBlock: receipt.blockNumber,
        expectedValue: logEvaluation.expectedValue,
        observedValue: logEvaluation.observedValue,
        observedAt: now,
      }),
    };
  }

  return {
    kind: "verified",
    delivery: {
      at: {
        chainKey: transfer.destinationChain,
        block: receipt.blockNumber,
        txHash: receipt.transactionHash,
        logIndex: logEvaluation.paymentLog.logIndex,
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
  options?: VerifyItsDeliveryOptions,
): Promise<VerifiedDelivery | null> {
  const outcome = await inspectItsDelivery(config, db, transfer, report, options);
  if (outcome.kind === "verified") {
    return outcome.delivery;
  }
  if (outcome.kind === "diagnostic" && options?.persistDiagnostics !== false) {
    await db.transaction(async (tx: Queryable) => {
      await writeItsVerificationDiagnostic(tx, outcome.diagnostic);
    });
  }
  return null;
}
