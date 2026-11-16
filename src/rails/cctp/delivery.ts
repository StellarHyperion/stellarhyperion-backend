import {
  CHAINS,
  RAIL_CONTRACTS,
  RouteKind,
  assetOn,
  isChainKey,
  isEvmChain,
  isStellarDeployment,
  toEvmAddress,
  type EvmChain,
} from "@hyperion/protocol";
import { createPublicClient, http, type Hex } from "viem";
import type { AppConfig } from "../../config/config.js";
import type { Transactional } from "../../db/pool.js";
import { bigintOf, text, textOrNull } from "../../db/rows.js";
import type { CctpCandidateReport, PendingTransfer, RailReport } from "../types.js";
import type { VerifiedDelivery } from "../axelar/delivery.js";
import type { DeliveryLog } from "../axelar/events.js";
import {
  matchingCctpPayment,
  reconcileCctpCandidates,
  type CctpCandidateReconciliation,
  type ExpectedCctpTransfer,
} from "./events.js";

const STELLAR_CCTP_MESSENGER = "CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP";

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
}

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

async function loadExpectedCctpTransfer(
  config: AppConfig,
  db: Transactional,
  transfer: PendingTransfer,
): Promise<{
  readonly expected: ExpectedCctpTransfer;
  readonly destination: EvmChain;
  readonly tokenAddress: Hex;
} | null> {
  if (
    transfer.route !== RouteKind.Cctp ||
    transfer.originChain !== "stellar-testnet" ||
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
    "SELECT token, net_amount, destination, rail_ref FROM outbound_transfer WHERE id = $1",
    [String(transfer.transferId)],
  );
  const stored = rows[0];
  if (!stored || text(stored, "token") !== sourceToken.sacId) return null;

  return {
    expected: {
      sourceToken: sourceToken.sacId,
      sourceAdapter: adapter,
      sourceMessenger: STELLAR_CCTP_MESSENGER,
      destinationDomain: destination.cctpDomain,
      destinationMessenger: contracts.tokenMessengerV2,
      transmitter: contracts.messageTransmitterV2,
      token: token.address,
      recipient: toEvmAddress(text(stored, "destination") as Hex),
      sourceAmount: bigintOf(stored, "net_amount"),
      railRef: textOrNull(stored, "rail_ref"),
    },
    destination,
    tokenAddress: token.address,
  };
}

function candidatesFromReport(report: RailReport): readonly CctpCandidateReport[] {
  return report.candidates && report.candidates.length > 0 ? report.candidates : [report];
}

/**
 * Reconciles a multi-candidate Iris report against a transfer's stored outbound burn intent so
 * unrelated burns never overwrite attestation status and ambiguous matches remain pending.
 */
export async function reconcileCctpTransferReport(
  config: AppConfig,
  db: Transactional,
  transfer: PendingTransfer,
  report: RailReport,
): Promise<{
  readonly report: RailReport;
  readonly reconciliation: CctpCandidateReconciliation;
} | null> {
  const context = await loadExpectedCctpTransfer(config, db, transfer);
  if (!context) return null;

  const candidates = candidatesFromReport(report);
  const reconciliation = reconcileCctpCandidates(candidates, context.expected);
  if (reconciliation.kind === "matched") {
    return {
      reconciliation,
      report: {
        ...reconciliation.candidate,
        candidates,
      },
    };
  }
  if (reconciliation.kind === "ambiguous") {
    return {
      reconciliation,
      report: {
        status: "pending",
        railStatus: `ambiguous_candidates(${String(reconciliation.nonces.length)})`,
        reference: null,
        attestedAt: null,
        candidates,
      },
    };
  }
  return {
    reconciliation,
    report: {
      status: "pending",
      railStatus: "unmatched_candidates",
      reference: null,
      attestedAt: null,
      candidates,
    },
  };
}

export async function verifyCctpDelivery(
  config: AppConfig,
  db: Transactional,
  transfer: PendingTransfer,
  report: RailReport,
  options?: VerifyCctpDeliveryOptions,
): Promise<VerifiedDelivery | null> {
  const context = await loadExpectedCctpTransfer(config, db, transfer);
  if (!context) return null;

  const reconciliation = reconcileCctpCandidates(candidatesFromReport(report), context.expected);
  if (reconciliation.kind !== "matched") {
    return null;
  }

  const forwardTxHash = reconciliation.candidate.forwardTxHash;
  if (!forwardTxHash || !/^0x[0-9a-fA-F]{64}$/.test(forwardTxHash)) {
    return null;
  }

  const client = options?.evmClient ?? createDefaultEvmClient(context.destination.defaultRpcUrl);
  if ((await client.getChainId()) !== context.destination.chainId) {
    throw new Error("CCTP destination RPC chain mismatch.");
  }
  const receipt = await client.getTransactionReceipt({ hash: forwardTxHash });
  if (receipt.status !== "success") return null;
  const head = await client.getBlockNumber();
  if (head - receipt.blockNumber + 1n < BigInt(context.destination.confirmations)) return null;

  const payment = matchingCctpPayment(receipt.logs, reconciliation.raw, context.expected);
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
      railMessageId: reconciliation.verified.message.nonce,
      recipient: context.expected.recipient.toLowerCase(),
      token: context.tokenAddress.toLowerCase(),
      amount: reconciliation.verified.amount,
      delivered: true,
      claimId: null,
    },
  };
}
