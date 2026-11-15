import type { nativeToScVal } from "@stellar/stellar-sdk";
import {
  Account,
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
  assetOn,
  isChainKey,
  isEvmChain,
  isStellarChain,
  isStellarDeployment,
  toEvmAddress,
} from "@hyperion/protocol";
import { createPublicClient, http, type Hex } from "viem";
import { admitReverseCctpLane, type AppConfig, type ReverseCctpLane } from "../../config/config.js";
import type { Transactional } from "../../db/pool.js";
import { bigintOf, text, textOrNull } from "../../db/rows.js";
import type { RawStellarEvent } from "../../chains/stellar/events.js";
import type { Position } from "../../chains/writers.js";
import type { PendingTransfer, RailReport } from "../types.js";
import type { VerifiedDelivery } from "../axelar/delivery.js";
import type { DeliveryLog } from "../axelar/events.js";
import {
  matchingCctpPayment,
  matchingReverseCctpDelivery,
  matchesSourceCctpBurnLogs,
  verifiedCctpMessage,
  type ExpectedCctpTransfer,
} from "./events.js";

export interface SourceCctpBurnState {
  readonly chainId: number;
  readonly receiptStatus: "success" | "reverted";
  readonly logs: readonly DeliveryLog[];
}

export interface StellarCctpExecutionState {
  readonly status: "SUCCESS" | "FAILED" | "NOT_FOUND";
  readonly ledger: number;
  readonly latestLedger: number;
  readonly events: readonly RawStellarEvent[];
  readonly inboundCapability: {
    readonly router: string | null;
    readonly tokenMessenger: string | null;
    readonly messageTransmitter: string | null;
    readonly inboundEnabled: boolean;
  };
}

export interface CctpVerificationClients {
  readonly readSourceBurnReceipt?: (
    lane: ReverseCctpLane,
    originTxHash: Hex,
  ) => Promise<SourceCctpBurnState>;
  readonly readStellarCctpExecution?: (
    lane: ReverseCctpLane,
    stellarTxHash: string,
  ) => Promise<StellarCctpExecutionState>;
}

export async function verifyCctpDelivery(
  config: AppConfig,
  db: Transactional,
  transfer: PendingTransfer,
  report: RailReport,
  clients?: CctpVerificationClients,
): Promise<VerifiedDelivery | null> {
  if (
    transfer.route !== RouteKind.Cctp ||
    !report.forwardTxHash ||
    !report.messageBytes ||
    !/^0x[0-9a-fA-F]+$/.test(report.messageBytes) ||
    !isChainKey(transfer.originChain) ||
    !isChainKey(transfer.destinationChain)
  ) {
    return null;
  }

  const origin = CHAINS[transfer.originChain];
  const destination = CHAINS[transfer.destinationChain];
  if (isEvmChain(origin) && isStellarChain(destination)) {
    return verifyReverseCctpDelivery(config, db, transfer, report, clients);
  }

  return verifyStellarToEvmCctpDelivery(config, db, transfer, report);
}

async function verifyStellarToEvmCctpDelivery(
  config: AppConfig,
  db: Transactional,
  transfer: PendingTransfer,
  report: RailReport,
): Promise<VerifiedDelivery | null> {
  if (
    transfer.route !== RouteKind.Cctp ||
    transfer.originChain !== "stellar-testnet" ||
    !report.forwardTxHash ||
    !report.messageBytes ||
    !/^0x[0-9a-fA-F]+$/.test(report.messageBytes) ||
    !isChainKey(transfer.destinationChain)
  )
    return null;
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
  const client = createPublicClient({
    transport: http(destination.defaultRpcUrl, { timeout: 15000, retryCount: 0 }),
  });
  if ((await client.getChainId()) !== destination.chainId)
    throw new Error("CCTP destination RPC chain mismatch.");
  const receipt = await client.getTransactionReceipt({ hash: report.forwardTxHash });
  if (receipt.status !== "success") return null;
  const head = await client.getBlockNumber();
  if (head - receipt.blockNumber + 1n < BigInt(destination.confirmations)) return null;
  const payment = matchingCctpPayment(receipt.logs, raw, expected);
  if (!payment) return null;
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (block.hash !== receipt.blockHash) return null;
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

/**
 * Verify a reverse-direction (EVM -> Stellar) CCTP V2 delivery, binding the source burn receipt,
 * attested Circle message, Soroban MessageTransmitterV2 receive, Hyperion Soroban router
 * settlement, and either SAC recipient payout or parked fixed-recipient claim.
 */
export async function verifyReverseCctpDelivery(
  config: AppConfig,
  db: Transactional,
  transfer: PendingTransfer,
  report: RailReport,
  clients?: CctpVerificationClients,
): Promise<VerifiedDelivery | null> {
  if (
    transfer.route !== RouteKind.Cctp ||
    !report.forwardTxHash ||
    !report.messageBytes ||
    !/^0x[0-9a-fA-F]+$/.test(report.messageBytes)
  ) {
    return null;
  }

  const admission = admitReverseCctpLane(config, transfer.originChain, transfer.destinationChain);
  if (!admission.admitted) return null;
  const lane = admission.lane;

  const { rows } = await db.query(
    "SELECT token, net_amount, destination, rail_ref, origin_tx FROM outbound_transfer WHERE id = $1",
    [String(transfer.transferId)],
  );
  const stored = rows[0];
  if (!stored) return null;

  const storedToken = text(stored, "token");
  if (storedToken.toLowerCase() !== lane.originToken.toLowerCase()) return null;

  const sourceAmount = bigintOf(stored, "net_amount");
  const destinationRecipient = text(stored, "destination");
  const railRef = textOrNull(stored, "rail_ref");
  const originTx = normalizeEvmTxHash(text(stored, "origin_tx"));
  const stellarTxHash = normalizeStellarTxHash(report.forwardTxHash);
  if (originTx === null || stellarTxHash === null) return null;

  const rawMessage = report.messageBytes as Hex;

  const readSource = clients?.readSourceBurnReceipt ?? defaultReadSourceBurnReceipt;
  const sourceState = await readSource(lane, originTx);
  if (sourceState.chainId !== lane.originChainId) {
    throw new Error("CCTP origin RPC chain mismatch.");
  }
  if (sourceState.receiptStatus !== "success") return null;
  if (!matchesSourceCctpBurnLogs(sourceState.logs, rawMessage)) return null;

  const readStellar = clients?.readStellarCctpExecution ?? defaultReadStellarCctpExecution;
  const stellarState = await readStellar(lane, stellarTxHash);
  if (stellarState.status !== "SUCCESS" || stellarState.ledger <= 0) return null;
  if (stellarState.latestLedger < stellarState.ledger) return null;

  const capability = stellarState.inboundCapability;
  if (
    !capability.inboundEnabled ||
    capability.router !== lane.destinationRouter ||
    capability.tokenMessenger !== lane.destinationMessenger ||
    capability.messageTransmitter !== lane.destinationTransmitter
  ) {
    return null;
  }

  const txEvents = stellarState.events.filter(
    (item) =>
      normalizeStellarTxHash(item.txHash) === stellarTxHash && item.ledger === stellarState.ledger,
  );

  const matched = matchingReverseCctpDelivery(txEvents, rawMessage, {
    originChain: lane.originChain,
    sourceNonce: transfer.nonce,
    sourceDomain: lane.sourceDomain,
    sourceToken: lane.originToken,
    sourceAdapter: lane.originAdapter,
    sourceMessenger: lane.originMessenger,
    sourceAmount,
    expectedMessageNonce: railRef,
    destinationMessenger: lane.destinationMessenger,
    destinationTransmitter: lane.destinationTransmitter,
    destinationAdapter: lane.destinationAdapter,
    destinationRouter: lane.destinationRouter,
    destinationToken: lane.destinationTokenSacId,
    recipient: destinationRecipient,
  });
  if (matched === null) return null;

  const at: Position = {
    chainKey: lane.destinationChain,
    block: BigInt(matched.ledger),
    txHash: stellarTxHash,
    logIndex: null,
    observedAt: matched.closedAt,
  };

  if (matched.kind === "delivered") {
    return {
      at,
      row: {
        route: transfer.route,
        sourceChain: lane.originChain,
        sourceNonce: transfer.nonce,
        railMessageId: matched.messageNonce,
        recipient: matched.recipient,
        token: lane.destinationTokenSacId,
        amount: matched.stellarAmount,
        delivered: true,
        claimId: null,
      },
    };
  }

  return {
    at,
    row: {
      route: transfer.route,
      sourceChain: lane.originChain,
      sourceNonce: transfer.nonce,
      railMessageId: matched.messageNonce,
      recipient: matched.recipient,
      token: lane.destinationTokenSacId,
      amount: matched.stellarAmount,
      delivered: false,
      claimId: matched.claimId,
    },
    claim: {
      claimId: matched.claimId,
      recipient: matched.recipient,
      token: lane.destinationTokenSacId,
      amount: matched.stellarAmount,
      route: transfer.route,
      sourceChain: lane.originChain,
      sourceNonce: transfer.nonce,
      createdAt: matched.createdAt,
    },
  };
}

async function defaultReadSourceBurnReceipt(
  lane: ReverseCctpLane,
  originTxHash: Hex,
): Promise<SourceCctpBurnState> {
  const client = createPublicClient({
    transport: http(lane.originRpcUrl, { timeout: 15_000, retryCount: 0 }),
  });
  const chainId = await client.getChainId();
  const receipt = await client.getTransactionReceipt({ hash: originTxHash });
  return {
    chainId,
    receiptStatus: receipt.status === "success" ? "success" : "reverted",
    logs: receipt.logs,
  };
}

async function defaultReadStellarCctpExecution(
  lane: ReverseCctpLane,
  stellarTxHash: string,
): Promise<StellarCctpExecutionState> {
  const rpcCall = async (method: string, params: unknown): Promise<unknown> => {
    const response = await fetch(lane.destinationRpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`Soroban RPC ${method} returned HTTP ${String(response.status)}`);
    }
    const payload = (await response.json()) as {
      result?: unknown;
      error?: { message?: string };
    };
    if (payload.error !== undefined) {
      throw new Error(`Soroban RPC ${method}: ${payload.error.message ?? "failed"}`);
    }
    return payload.result;
  };

  const txResult = (await rpcCall("getTransaction", {
    hash: stellarTxHash,
    xdrFormat: "json",
  })) as {
    status?: unknown;
    ledger?: unknown;
    latestLedger?: unknown;
  };
  const statusRaw = typeof txResult.status === "string" ? txResult.status : "NOT_FOUND";
  const status =
    statusRaw === "SUCCESS" ? "SUCCESS" : statusRaw === "FAILED" ? "FAILED" : "NOT_FOUND";
  const ledger = typeof txResult.ledger === "number" ? txResult.ledger : 0;
  const latestLedger = typeof txResult.latestLedger === "number" ? txResult.latestLedger : 0;
  if (status !== "SUCCESS" || ledger <= 0) {
    return {
      status,
      ledger,
      latestLedger,
      events: [],
      inboundCapability: {
        router: null,
        tokenMessenger: null,
        messageTransmitter: null,
        inboundEnabled: false,
      },
    };
  }

  const eventsResult = (await rpcCall("getEvents", {
    startLedger: ledger,
    filters: [
      {
        type: "contract",
        contractIds: [
          lane.destinationTransmitter,
          lane.destinationMessenger,
          lane.destinationAdapter,
          lane.destinationRouter,
          lane.destinationTokenSacId,
        ],
      },
    ],
    pagination: { limit: 200 },
    xdrFormat: "json",
  })) as { events?: unknown; latestLedger?: unknown };
  const events = Array.isArray(eventsResult.events)
    ? (eventsResult.events as RawStellarEvent[])
    : [];

  const stellar = new rpc.Server(lane.destinationRpcUrl, { timeout: 15_000 });
  const view = async (
    contract: string,
    method: string,
    args: ReturnType<typeof nativeToScVal>[] = [],
  ): Promise<unknown> => {
    const tx = new TransactionBuilder(new Account(lane.destinationAdmin, "0"), {
      fee: BASE_FEE,
      networkPassphrase: lane.destinationNetworkPassphrase,
    })
      .addOperation(new Contract(contract).call(method, ...args))
      .setTimeout(60)
      .build();
    const sim = await stellar.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) return null;
    return scValToNative(sim.result.retval) as unknown;
  };

  const adapterCfg = (await view(lane.destinationAdapter, "get_config")) as {
    router?: unknown;
    token_messenger?: unknown;
    message_transmitter?: unknown;
    inbound_enabled?: unknown;
  } | null;

  return {
    status,
    ledger,
    latestLedger:
      typeof eventsResult.latestLedger === "number" ? eventsResult.latestLedger : latestLedger,
    events,
    inboundCapability: {
      router: typeof adapterCfg?.router === "string" ? adapterCfg.router : null,
      tokenMessenger:
        typeof adapterCfg?.token_messenger === "string" ? adapterCfg.token_messenger : null,
      messageTransmitter:
        typeof adapterCfg?.message_transmitter === "string" ? adapterCfg.message_transmitter : null,
      inboundEnabled: adapterCfg?.inbound_enabled !== false && adapterCfg !== null,
    },
  };
}

function normalizeStellarTxHash(value: string): string | null {
  const clean = value.startsWith("0x") ? value.slice(2) : value;
  return /^[0-9a-fA-F]{64}$/.test(clean) ? clean.toLowerCase() : null;
}

function normalizeEvmTxHash(value: string): Hex | null {
  const clean = value.startsWith("0x") ? value.slice(2) : value;
  const out: Hex = `0x${clean.toLowerCase()}`;
  return /^[0-9a-fA-F]{64}$/.test(clean) ? out : null;
}
