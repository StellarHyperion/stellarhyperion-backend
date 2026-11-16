import {
  CHAINS,
  RouteKind,
  encodeStellarAddress,
  isChainKey,
  isEvmChain,
  isStellarChain,
  parseStellarAddress,
  toEvmAddress,
  type ChainKey,
} from "@hyperion/protocol";
import { createPublicClient, http, keccak256, type Hex } from "viem";

import { admitGmpLane, isNonLiveFixtureProvenance, type AppConfig } from "../../config/config.js";
import type { Transactional } from "../../db/pool.js";
import { bigintOf, text } from "../../db/rows.js";
import type { PendingTransfer, RailReport } from "../types.js";
import type { VerifiedDelivery } from "./delivery.js";
import type { DeliveryLog } from "./events.js";
import { decodeGmpPayoutPayload, matchingGmpPayment } from "./gmp-events.js";

export interface GmpEvmReceipt {
  readonly status: "success" | "reverted";
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly transactionHash: Hex;
  readonly logs: readonly (DeliveryLog & { readonly logIndex: number })[];
}

export interface GmpEvmReceiptReader {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getTransactionReceipt(args: { readonly hash: Hex }): Promise<GmpEvmReceipt>;
  getBlock(args: { readonly blockNumber: bigint }): Promise<{
    readonly hash: Hex | null;
    readonly timestamp: bigint;
  }>;
}

export interface GmpStellarApprovalEvent {
  readonly gatewayContract: string;
  readonly commandId: Hex;
  readonly sourceChain: string;
  readonly sourceAddress: string;
  readonly destinationContract: string;
  readonly payloadHash: Hex;
}

export interface GmpStellarExecutionEvent {
  readonly gatewayContract: string;
  readonly commandId: Hex;
}

export interface GmpStellarTokenTransferEvent {
  readonly tokenContract: string;
  readonly from: string;
  readonly to: string;
  readonly amount: bigint;
  readonly logIndex: number;
}

export interface GmpStellarTxConfirmation {
  readonly status: "SUCCESS" | "FAILED" | "NOT_FOUND";
  readonly ledger: number;
  readonly latestLedger: number;
  readonly txHash: string;
  readonly createdAtUnix: number;
  readonly approvals: readonly GmpStellarApprovalEvent[];
  readonly executions: readonly GmpStellarExecutionEvent[];
  readonly tokenTransfers: readonly GmpStellarTokenTransferEvent[];
  readonly parkedClaimIds?: readonly bigint[];
  readonly provenance?: string;
}

export interface GmpVerifyDeps {
  readonly evmClientFactory?: (chainKey: ChainKey, rpcUrl: string) => GmpEvmReceiptReader;
  readonly stellarTxReader?: (
    chainKey: ChainKey,
    rpcUrl: string,
    txHash: string,
  ) => Promise<GmpStellarTxConfirmation | null>;
}

const LOCAL_REHEARSAL_CHAIN_IDS = new Set([1337, 31337]);

function scaleTokenAmount(amount: bigint, fromDecimals: number, toDecimals: number): bigint | null {
  if (amount <= 0n) return null;
  if (fromDecimals === toDecimals) return amount;
  if (toDecimals > fromDecimals) {
    return amount * 10n ** BigInt(toDecimals - fromDecimals);
  }
  const factor = 10n ** BigInt(fromDecimals - toDecimals);
  if (amount % factor !== 0n) return null;
  return amount / factor;
}

function defaultEvmReader(_chainKey: ChainKey, rpcUrl: string): GmpEvmReceiptReader {
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
        logs: receipt.logs.map((entry) => ({
          address: entry.address,
          topics: entry.topics,
          data: entry.data,
          logIndex: entry.logIndex,
        })),
      };
    },
    getBlock: async ({ blockNumber }) => {
      const block = await client.getBlock({ blockNumber });
      return { hash: block.hash, timestamp: block.timestamp };
    },
  };
}

/**
 * Verify authenticated Axelar GMP destination delivery against confirmed chain events.
 *
 * Provider status (`executed` / `approved`) supplies only a candidate execution hash and commandId.
 * Live `delivered` evidence requires:
 * 1. An admitted live lane with deployed source adapter, Axelar gateways, and destination receiver.
 * 2. Non-local provenance on deployment config, candidate report, and RPC chain identity.
 * 3. Gateway approval + execution events binding source peer, receiver, commandId, and payloadHash.
 * 4. Confirmed payout transfer of the expected destination token and scaled amount to the recipient.
 */
export async function verifyGmpDelivery(
  config: AppConfig,
  db: Transactional,
  transfer: PendingTransfer,
  report: RailReport,
  deps: GmpVerifyDeps = {},
): Promise<VerifiedDelivery | null> {
  const execution = report.execution;
  if (execution === undefined || transfer.route !== RouteKind.AxelarGmp) {
    return null;
  }
  if (
    transfer.originChain === "local" ||
    transfer.destinationChain === "local" ||
    Boolean(config.rails.fixtureProvenance) ||
    isNonLiveFixtureProvenance(report.gmpCandidate?.provenance) ||
    !isChainKey(transfer.originChain) ||
    !isChainKey(transfer.destinationChain)
  ) {
    return null;
  }

  const { rows } = await db.query(
    "SELECT sender, token, net_amount, destination FROM outbound_transfer WHERE id = $1",
    [String(transfer.transferId)],
  );
  const stored = rows[0];
  if (!stored) return null;

  const storedToken = text(stored, "token");
  const storedNetAmount = bigintOf(stored, "net_amount");
  const rawDestination = text(stored, "destination");

  const symbol =
    (config.rails.gmpLanes ?? []).find(
      (entry) =>
        entry.originChain === transfer.originChain &&
        entry.destinationChain === transfer.destinationChain &&
        entry.originToken.toLowerCase() === storedToken.toLowerCase(),
    )?.symbol ?? "USDC";

  const admission = admitGmpLane(config, transfer.originChain, transfer.destinationChain, symbol);
  if (!admission.admitted) {
    return null;
  }
  const lane = admission.lane;
  if (storedToken.toLowerCase() !== lane.originToken.toLowerCase()) {
    return null;
  }

  const expectedAmount = scaleTokenAmount(
    storedNetAmount,
    lane.originDecimals,
    lane.destinationDecimals,
  );
  if (expectedAmount === null || expectedAmount <= 0n) {
    return null;
  }

  const candidate = report.gmpCandidate;
  if (!candidate?.payload) {
    return null;
  }
  if (candidate.sourceChain !== undefined && candidate.sourceChain !== lane.originAxelarChain) {
    return null;
  }
  if (
    candidate.sourceAddress !== undefined &&
    candidate.sourceAddress.toLowerCase() !== lane.originAdapter.toLowerCase()
  ) {
    return null;
  }
  if (
    candidate.destinationContractAddress !== undefined &&
    candidate.destinationContractAddress.toLowerCase() !== lane.destinationReceiver.toLowerCase()
  ) {
    return null;
  }

  const computedPayloadHash = keccak256(candidate.payload);
  if (
    candidate.payloadHash !== undefined &&
    candidate.payloadHash.toLowerCase() !== computedPayloadHash.toLowerCase()
  ) {
    return null;
  }

  const destinationChain = CHAINS[lane.destinationChain];

  if (isEvmChain(destinationChain)) {
    let recipient: Hex;
    try {
      recipient = toEvmAddress(rawDestination as Hex);
    } catch {
      return null;
    }
    if (/^0x0{40}$/i.test(recipient)) {
      return null;
    }

    const configuredEvm = config.indexer.evm.find((entry) => entry.chain === lane.destinationChain);
    const rpcUrl = configuredEvm?.rpcUrl ?? destinationChain.defaultRpcUrl;
    const client = (deps.evmClientFactory ?? defaultEvmReader)(lane.destinationChain, rpcUrl);

    const rpcChainId = await client.getChainId();
    if (LOCAL_REHEARSAL_CHAIN_IDS.has(rpcChainId)) {
      return null;
    }
    if (rpcChainId !== destinationChain.chainId) {
      throw new Error("Destination RPC chain mismatch.");
    }

    const receipt = await client.getTransactionReceipt({ hash: execution.txHash });
    if (receipt.status !== "success") {
      return null;
    }
    const head = await client.getBlockNumber();
    if (head - receipt.blockNumber + 1n < BigInt(destinationChain.confirmations)) {
      return null;
    }

    const payment = matchingGmpPayment(receipt.logs, {
      gateway: lane.destinationGateway,
      destinationReceiver: lane.destinationReceiver,
      destinationRouter: lane.destinationRouter,
      token: lane.destinationToken,
      commandId: execution.commandId,
      sourceAxelarChain: lane.originAxelarChain,
      sourceOriginChain: transfer.originChain,
      sourceAdapter: lane.originAdapter,
      sourceNonce: transfer.nonce,
      recipient,
      amount: expectedAmount,
      payload: candidate.payload,
    });
    if (payment === null) {
      return null;
    }

    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    if (block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) {
      return null;
    }

    return {
      at: {
        chainKey: lane.destinationChain,
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
        token: lane.destinationToken.toLowerCase(),
        amount: expectedAmount,
        delivered: true,
        claimId: null,
      },
    };
  }

  if (isStellarChain(destinationChain)) {
    if (!deps.stellarTxReader) {
      return null;
    }
    let recipient: string;
    try {
      const parsed = parseStellarAddress(rawDestination);
      recipient = encodeStellarAddress(parsed.kind, parsed.key, parsed.muxedId);
    } catch {
      return null;
    }

    const decoded = decodeGmpPayoutPayload(candidate.payload, "stellar");
    if (
      decoded?.recipient !== recipient ||
      decoded.sourceNonce !== transfer.nonce ||
      decoded.destinationToken !== lane.destinationToken ||
      decoded.destinationAmount !== expectedAmount
    ) {
      return null;
    }

    const rpcUrl =
      config.indexer.stellar?.chain === lane.destinationChain
        ? config.indexer.stellar.rpcUrl
        : destinationChain.defaultRpcUrl;
    const confirmed = await deps.stellarTxReader(lane.destinationChain, rpcUrl, execution.txHash);
    if (
      confirmed?.status !== "SUCCESS" ||
      isNonLiveFixtureProvenance(confirmed.provenance) ||
      confirmed.ledger <= 0 ||
      confirmed.latestLedger < confirmed.ledger ||
      (confirmed.parkedClaimIds?.length ?? 0) > 0
    ) {
      return null;
    }

    const commandLower = execution.commandId.toLowerCase();
    const expectedPayloadHashLower = computedPayloadHash.toLowerCase();
    const approved = confirmed.approvals.some(
      (entry) =>
        entry.gatewayContract === lane.destinationGateway &&
        entry.commandId.toLowerCase() === commandLower &&
        entry.sourceChain === lane.originAxelarChain &&
        entry.sourceAddress.toLowerCase() === lane.originAdapter.toLowerCase() &&
        entry.destinationContract === lane.destinationReceiver &&
        entry.payloadHash.toLowerCase() === expectedPayloadHashLower,
    );
    const executed = confirmed.executions.some(
      (entry) =>
        entry.gatewayContract === lane.destinationGateway &&
        entry.commandId.toLowerCase() === commandLower,
    );
    const payout = confirmed.tokenTransfers.find(
      (entry) =>
        entry.tokenContract === lane.destinationToken &&
        (entry.from === lane.destinationRouter || entry.from === lane.destinationReceiver) &&
        entry.to === recipient &&
        (recipient === lane.destinationReceiver || entry.to !== lane.destinationReceiver) &&
        entry.amount === expectedAmount,
    );
    if (!approved || !executed || payout === undefined) {
      return null;
    }

    return {
      at: {
        chainKey: lane.destinationChain,
        block: BigInt(confirmed.ledger),
        txHash: confirmed.txHash,
        logIndex: payout.logIndex,
        observedAt: new Date(confirmed.createdAtUnix * 1000),
      },
      row: {
        route: transfer.route,
        sourceChain: transfer.originChain,
        sourceNonce: transfer.nonce,
        railMessageId: execution.commandId,
        recipient,
        token: lane.destinationToken,
        amount: expectedAmount,
        delivered: true,
        claimId: null,
      },
    };
  }

  return null;
}
