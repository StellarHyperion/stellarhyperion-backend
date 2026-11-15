import {
  AddressKind,
  CHAINS,
  RouteKind,
  carriesPayload,
  encodeStellarAddress,
  isChainKey,
  isEvmChain,
  isEvmDeployment,
  isStellarChain,
  isStellarDeployment,
  parseStellarAddress,
  toEvmAddress,
} from "@hyperion/protocol";
import { createPublicClient, http, type Hex } from "viem";

import { admitAllbridgeLane, type AppConfig } from "../../config/config.js";
import type { Transactional } from "../../db/pool.js";
import { bigintOf, text, textOrNull } from "../../db/rows.js";
import type { VerifiedDelivery } from "../axelar/delivery.js";
import type { DeliveryLog } from "../axelar/events.js";
import type { PendingTransfer, RailReport } from "../types.js";
import {
  allbridgePayoutBounds,
  computeAllbridgeIntentHash,
  matchingAllbridgePayment,
  normalizeAllbridgeWord,
  verifyAllbridgeValidatorQuorum,
} from "./events.js";

export interface AllbridgeEvmReceipt {
  readonly status: "success" | "reverted";
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly transactionHash: Hex;
  readonly logs: readonly DeliveryLog[];
}

export interface AllbridgeEvmReceiptReader {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getTransactionReceipt(args: { readonly hash: Hex }): Promise<AllbridgeEvmReceipt>;
  getBlock(args: {
    readonly blockNumber: bigint;
  }): Promise<{ readonly hash: Hex; readonly timestamp: bigint }>;
}

export interface AllbridgeStellarPaymentEvent {
  readonly contractId: string;
  readonly kind: "message_received" | "token_transfer";
  readonly messageHash?: Hex;
  readonly sourceNonce?: bigint;
  readonly sourceChainSymbol?: string;
  readonly from?: string;
  readonly to?: string;
  readonly amount?: bigint;
}

export interface AllbridgeStellarTxConfirmation {
  readonly status: "SUCCESS" | "FAILED" | "NOT_FOUND";
  readonly ledger: number;
  readonly latestLedger: number;
  readonly ledgerCloseTime: number;
  readonly txHash: string;
  readonly events: readonly AllbridgeStellarPaymentEvent[];
}

export interface AllbridgeVerifyDeps {
  readonly evmClientFactory?: (rpcUrl: string) => AllbridgeEvmReceiptReader;
  readonly stellarTxReader?: (
    rpcUrl: string,
    txHash: string,
  ) => Promise<AllbridgeStellarTxConfirmation | null>;
}

function resolveEvmRecipient(rawDestination: string): Hex | null {
  if (/^0x[0-9a-fA-F]{40}$/.test(rawDestination)) {
    const lower = rawDestination.toLowerCase() as Hex;
    return /^0x0{40}$/.test(lower) ? null : lower;
  }
  if (/^0x[0-9a-fA-F]{64}$/.test(rawDestination)) {
    try {
      const addr = toEvmAddress(rawDestination as Hex).toLowerCase() as Hex;
      return /^0x0{40}$/.test(addr) ? null : addr;
    } catch {
      return null;
    }
  }
  return null;
}

function resolveStellarAllbridgeRecipient(rawDestination: string): string | null {
  try {
    const parsed = parseStellarAddress(rawDestination);
    if (!carriesPayload(RouteKind.Allbridge) && parsed.kind === AddressKind.MuxedAccount) {
      return null;
    }
    const canonical = encodeStellarAddress(parsed.kind, parsed.key, parsed.muxedId);
    return canonical === rawDestination ? canonical : null;
  } catch {
    return null;
  }
}

function defaultEvmReader(rpcUrl: string): AllbridgeEvmReceiptReader {
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

export async function verifyAllbridgeDelivery(
  config: AppConfig,
  db: Transactional,
  transfer: PendingTransfer,
  report: RailReport,
  deps: AllbridgeVerifyDeps = {},
): Promise<VerifiedDelivery | null> {
  const intent = report.allbridge;
  if (
    transfer.route !== RouteKind.Allbridge ||
    intent === undefined ||
    !intent.trustDisclosure.quorumSatisfied ||
    intent.destinationTxHash === undefined ||
    !isChainKey(transfer.originChain) ||
    !isChainKey(transfer.destinationChain)
  ) {
    return null;
  }

  const admission = admitAllbridgeLane(config, transfer.originChain, transfer.destinationChain);
  if (!admission.enabled) return null;
  const { lane } = admission;

  const destinationPool = lane.destination.pools[lane.symbol];
  if (destinationPool === undefined) return null;

  const { rows } = await db.query(
    "SELECT sender, token, net_amount, destination, rail_ref FROM outbound_transfer WHERE id = $1",
    [String(transfer.transferId)],
  );
  const stored = rows[0];
  if (!stored) return null;

  const storedToken = text(stored, "token");
  const storedNetAmount = bigintOf(stored, "net_amount");
  const storedDestination = text(stored, "destination");
  const storedRailRef = textOrNull(stored, "rail_ref");

  if (
    storedToken.toLowerCase() !== lane.originToken.toLowerCase() ||
    storedNetAmount <= 0n ||
    storedNetAmount !== intent.sourceAmount ||
    transfer.nonce !== intent.sourceNonce ||
    intent.sourceChainSymbol !== lane.origin.chainSymbol ||
    intent.destinationChainSymbol !== lane.destination.chainSymbol
  ) {
    return null;
  }

  const destinationChain = CHAINS[lane.destinationChain];
  const destinationDeployment = config.deployments.networks[lane.destinationChain];
  if (destinationDeployment === undefined) return null;

  let canonicalRecipient: string | null = null;
  if (isEvmChain(destinationChain)) {
    canonicalRecipient = resolveEvmRecipient(storedDestination);
  } else if (isStellarChain(destinationChain)) {
    canonicalRecipient = resolveStellarAllbridgeRecipient(storedDestination);
  }
  if (canonicalRecipient === null) return null;

  try {
    if (
      normalizeAllbridgeWord(intent.recipient).toLowerCase() !==
      normalizeAllbridgeWord(canonicalRecipient).toLowerCase()
    ) {
      return null;
    }
  } catch {
    return null;
  }

  const expectedMessageHash = computeAllbridgeIntentHash({
    sourceChainSymbol: lane.origin.chainSymbol,
    destinationChainSymbol: lane.destination.chainSymbol,
    sourceNonce: transfer.nonce,
    recipient: canonicalRecipient,
    sourceAmount: storedNetAmount,
    destinationPool,
  });
  if (intent.messageHash.toLowerCase() !== expectedMessageHash.toLowerCase()) {
    return null;
  }
  if (storedRailRef !== null && storedRailRef.toLowerCase() !== expectedMessageHash.toLowerCase()) {
    return null;
  }

  const verifiedQuorum = await verifyAllbridgeValidatorQuorum(
    expectedMessageHash,
    intent.signatures,
    lane.destination.validatorTrust,
  );
  if (!verifiedQuorum.quorumSatisfied) {
    return null;
  }

  const bounds = allbridgePayoutBounds(
    storedNetAmount,
    lane.originDecimals,
    lane.destinationDecimals,
    lane.destination.maxSlippageBps,
  );

  if (isEvmChain(destinationChain) && isEvmDeployment(destinationDeployment)) {
    const rpcUrl =
      config.indexer.evm.find((entry) => entry.chain === lane.destinationChain)?.rpcUrl ??
      destinationChain.defaultRpcUrl;
    const client = (deps.evmClientFactory ?? defaultEvmReader)(rpcUrl);
    if ((await client.getChainId()) !== destinationChain.chainId) {
      throw new Error("Allbridge destination RPC chain mismatch.");
    }
    const receipt = await client.getTransactionReceipt({ hash: intent.destinationTxHash });
    if (receipt.status !== "success") return null;
    const head = await client.getBlockNumber();
    if (head - receipt.blockNumber + 1n < BigInt(destinationChain.confirmations)) return null;

    const matched = matchingAllbridgePayment(receipt.logs, {
      messenger: lane.destination.messenger,
      destinationPool,
      destinationBridge: lane.destination.bridge,
      destinationAdapter: lane.destinationAdapter,
      destinationRouter: destinationDeployment.router,
      token: lane.destinationToken,
      messageHash: expectedMessageHash,
      sourceNonce: transfer.nonce,
      sourceChainSymbol: lane.origin.chainSymbol,
      recipient: canonicalRecipient,
      minAmount: bounds.minAmount,
      maxAmount: bounds.maxAmount,
    });
    if (matched === null) return null;

    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    if (block.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) return null;

    return {
      at: {
        chainKey: lane.destinationChain,
        block: receipt.blockNumber,
        txHash: receipt.transactionHash,
        logIndex: matched.log.logIndex,
        observedAt: new Date(Number(block.timestamp) * 1_000),
      },
      row: {
        route: RouteKind.Allbridge,
        sourceChain: transfer.originChain,
        sourceNonce: transfer.nonce,
        railMessageId: expectedMessageHash,
        recipient: canonicalRecipient.toLowerCase(),
        token: lane.destinationToken.toLowerCase(),
        amount: matched.paidAmount,
        delivered: true,
        claimId: null,
      },
    };
  }

  if (
    isStellarChain(destinationChain) &&
    isStellarDeployment(destinationDeployment) &&
    deps.stellarTxReader !== undefined
  ) {
    const rpcUrl =
      config.indexer.stellar?.chain === lane.destinationChain
        ? config.indexer.stellar.rpcUrl
        : destinationChain.defaultRpcUrl;
    const txHashPlain = intent.destinationTxHash.replace(/^0x/i, "").toLowerCase();
    const confirmed = await deps.stellarTxReader(rpcUrl, txHashPlain);
    if (
      confirmed?.status !== "SUCCESS" ||
      confirmed.ledger <= 0 ||
      confirmed.latestLedger < confirmed.ledger
    ) {
      return null;
    }

    const allowedPayers = new Set([
      destinationPool,
      lane.destination.bridge,
      destinationDeployment.router,
      lane.destinationAdapter,
    ]);
    let messageOk = false;
    let paidAmount: bigint | null = null;
    for (const ev of confirmed.events) {
      if (
        ev.kind === "message_received" &&
        ev.contractId === lane.destination.messenger &&
        ev.messageHash?.toLowerCase() === expectedMessageHash.toLowerCase() &&
        ev.sourceNonce === transfer.nonce &&
        ev.sourceChainSymbol === lane.origin.chainSymbol
      ) {
        messageOk = true;
      }
      if (
        ev.kind === "token_transfer" &&
        ev.contractId === lane.destinationToken &&
        ev.from !== undefined &&
        allowedPayers.has(ev.from) &&
        ev.to === canonicalRecipient &&
        ev.to !== lane.destinationAdapter &&
        ev.amount !== undefined &&
        ev.amount > 0n &&
        ev.amount >= bounds.minAmount &&
        ev.amount <= bounds.maxAmount
      ) {
        paidAmount = ev.amount;
      }
    }
    if (!messageOk || paidAmount === null) return null;

    return {
      at: {
        chainKey: lane.destinationChain,
        block: BigInt(confirmed.ledger),
        txHash: txHashPlain,
        logIndex: null,
        observedAt: new Date(confirmed.ledgerCloseTime * 1_000),
      },
      row: {
        route: RouteKind.Allbridge,
        sourceChain: transfer.originChain,
        sourceNonce: transfer.nonce,
        railMessageId: expectedMessageHash,
        recipient: canonicalRecipient,
        token: lane.destinationToken,
        amount: paidAmount,
        delivered: true,
        claimId: null,
      },
    };
  }

  return null;
}
