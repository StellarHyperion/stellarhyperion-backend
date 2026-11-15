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
  convertDecimals,
  isChainKey,
  isEvmChain,
  isStellarChain,
  toEvmAddress,
  toHex,
  type Hex,
} from "@hyperion/protocol";
import { axelarItsAdapterAbi } from "@hyperion/protocol/abi";
import { createPublicClient, http, stringToHex } from "viem";
import { resolveReverseItsLane, type AppConfig, type ReverseItsLane } from "../../config/config.js";
import type { Transactional } from "../../db/pool.js";
import { bigintOf, text } from "../../db/rows.js";
import type { RawStellarEvent } from "../../chains/stellar/events.js";
import type { ClaimRow, InboundRow, Position } from "../../chains/writers.js";
import type { PendingTransfer, RailReport } from "../types.js";

import {
  EVM_ITS_TOKEN_MANAGER_ABI,
  ITS_ABI,
  canonicalStellarRecipient,
  isSupportedTokenManagerType,
  matchingPayment,
  matchingReverseItsDelivery,
} from "./events.js";

const ZERO_WORD = `0x${"0".repeat(64)}`;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

export interface VerifiedDelivery {
  readonly at: Position;
  readonly row: InboundRow;
  /** Present when the router parked the delivery as a fixed-recipient claim instead of paying out. */
  readonly claim?: ClaimRow;
}

export interface EvmItsSourceState {
  readonly chainId: number;
  readonly adapterTokenId: Hex;
  readonly registeredTokenAddress: Hex;
  readonly tokenManagerAddress: Hex;
  readonly tokenManagerType: number | bigint;
  readonly peer: {
    readonly axelarChain: string;
    readonly peerAddress: Hex;
    readonly configured: boolean;
    readonly enabled: boolean;
  };
}

export interface StellarItsExecutionState {
  readonly status: "SUCCESS" | "FAILED" | "NOT_FOUND";
  readonly ledger: number;
  readonly latestLedger: number;
  readonly events: readonly RawStellarEvent[];
  readonly adapterTokenId: Uint8Array | Hex | null;
  readonly registeredTokenAddress: string | null;
  readonly tokenManagerType: unknown;
  readonly configuredIts: string | null;
  readonly configuredPeer: {
    readonly axelarChain: string;
    readonly peerAddress: string;
    readonly enabled: boolean;
  } | null;
}

export interface ItsVerificationClients {
  readonly readEvmItsSource?: (lane: ReverseItsLane) => Promise<EvmItsSourceState>;
  readonly readStellarItsExecution?: (
    lane: ReverseItsLane,
    txHashHex: string,
    tokenId: Hex,
  ) => Promise<StellarItsExecutionState>;
}

// The rail API supplies a candidate receipt. Only matching confirmed chain events establish delivery.
export async function verifyItsDelivery(
  config: AppConfig,
  db: Transactional,
  transfer: PendingTransfer,
  report: RailReport,
  clients?: ItsVerificationClients,
): Promise<VerifiedDelivery | null> {
  if (!report.execution || transfer.route !== RouteKind.AxelarIts) return null;
  if (!isChainKey(transfer.originChain) || !isChainKey(transfer.destinationChain)) return null;

  const origin = CHAINS[transfer.originChain];
  const destination = CHAINS[transfer.destinationChain];
  if (isEvmChain(origin) && isStellarChain(destination)) {
    return verifyReverseItsDelivery(config, db, transfer, report, clients);
  }

  return verifyStellarToEvmItsDelivery(config, db, transfer, report);
}

async function verifyStellarToEvmItsDelivery(
  config: AppConfig,
  db: Transactional,
  transfer: PendingTransfer,
  report: RailReport,
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
  const stellar = new rpc.Server(source.rpcUrl, { timeout: 15_000 });
  const view = async (
    contract: string,
    method: string,
    args: ReturnType<typeof nativeToScVal>[] = [],
  ) => {
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
  const id = await view(adapter, "token_id_for", [new Address(token).toScVal()]);
  if (!(id instanceof Uint8Array) || id.length !== 32)
    throw new Error("Source token id is invalid.");
  const tokenId = toHex(id);
  const client = createPublicClient({
    transport: http(destination.defaultRpcUrl, { timeout: 15_000, retryCount: 0 }),
  });
  if ((await client.getChainId()) !== destination.chainId)
    throw new Error("Destination RPC chain mismatch.");
  const receipt = await client.getTransactionReceipt({ hash: execution.txHash });
  if (receipt.status !== "success") return null;
  const head = await client.getBlockNumber();
  if (head - receipt.blockNumber + 1n < BigInt(destination.confirmations)) return null;
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
      railMessageId: execution.commandId,
      recipient: recipient.toLowerCase(),
      token: destinationToken.toLowerCase(),
      amount,
      delivered: true,
      claimId: null,
    },
  };
}

/**
 * Verify a reverse-direction (EVM -> Stellar) ITS transfer against EVM source token-manager state,
 * Soroban ITS callback arguments, Hyperion Soroban router settlement, and final SAC recipient
 * payout (or parked claim).
 */
export async function verifyReverseItsDelivery(
  config: AppConfig,
  db: Transactional,
  transfer: PendingTransfer,
  report: RailReport,
  clients?: ItsVerificationClients,
): Promise<VerifiedDelivery | null> {
  const execution = report.execution;
  if (!execution || transfer.route !== RouteKind.AxelarIts) return null;

  const { rows } = await db.query(
    "SELECT sender, token, net_amount, destination FROM outbound_transfer WHERE id = $1",
    [String(transfer.transferId)],
  );
  const stored = rows[0];
  if (!stored) return null;

  const sourceToken = text(stored, "token");
  const sourceNetAmount = bigintOf(stored, "net_amount");
  const rawRecipient = text(stored, "destination");

  const recipient = canonicalStellarRecipient(rawRecipient);
  if (recipient === null) return null;

  const lane = resolveReverseItsLane(
    config,
    transfer.originChain,
    transfer.destinationChain,
    sourceToken,
  );
  if (lane === null) return null;

  const { converted: expectedStellarAmount, dust } = convertDecimals(
    sourceNetAmount,
    lane.originDecimals,
    lane.destinationDecimals,
  );
  if (dust !== 0n || expectedStellarAmount <= 0n) return null;

  const stellarTxHash = normalizeStellarTxHash(execution.txHash);
  if (stellarTxHash === null) return null;

  const readEvmSource = clients?.readEvmItsSource ?? defaultReadEvmItsSource;
  const evmSource = await readEvmSource(lane);
  if (evmSource.chainId !== lane.originChainId) {
    throw new Error("Origin RPC chain mismatch.");
  }

  const tokenId = normalizeWord32(evmSource.adapterTokenId);
  if (tokenId === null || tokenId === ZERO_WORD) return null;
  if (evmSource.registeredTokenAddress.toLowerCase() !== lane.originToken.toLowerCase()) {
    return null;
  }
  if (
    evmSource.tokenManagerAddress.toLowerCase() === ZERO_ADDRESS ||
    !isSupportedTokenManagerType(evmSource.tokenManagerType)
  ) {
    return null;
  }
  if (
    !evmSource.peer.configured ||
    !evmSource.peer.enabled ||
    evmSource.peer.axelarChain !== lane.destinationAxelarName ||
    !matchesStellarPeerBytes(evmSource.peer.peerAddress, lane.destinationAdapter)
  ) {
    return null;
  }

  const readStellar = clients?.readStellarItsExecution ?? defaultReadStellarItsExecution;
  const stellarState = await readStellar(lane, stellarTxHash, tokenId);
  if (stellarState.status !== "SUCCESS" || stellarState.ledger <= 0) return null;
  if (
    stellarState.latestLedger - stellarState.ledger + 1 <
    Math.max(lane.destinationConfirmations, 1)
  ) {
    return null;
  }

  const destAdapterTokenId =
    stellarState.adapterTokenId instanceof Uint8Array
      ? stellarState.adapterTokenId.length === 32
        ? toHex(stellarState.adapterTokenId)
        : null
      : stellarState.adapterTokenId !== null
        ? normalizeWord32(stellarState.adapterTokenId)
        : null;
  if (destAdapterTokenId === null || destAdapterTokenId !== tokenId) return null;
  if (stellarState.configuredIts !== lane.destinationIts) return null;
  if (stellarState.registeredTokenAddress !== lane.destinationTokenSacId) return null;
  if (!isSupportedTokenManagerType(stellarState.tokenManagerType)) return null;
  if (
    stellarState.configuredPeer === null ||
    !stellarState.configuredPeer.enabled ||
    stellarState.configuredPeer.axelarChain !== lane.originAxelarName ||
    !matchesEvmAdapterString(stellarState.configuredPeer.peerAddress, lane.originAdapter)
  ) {
    return null;
  }

  const txEvents = stellarState.events.filter(
    (item) =>
      normalizeStellarTxHash(item.txHash) === stellarTxHash && item.ledger === stellarState.ledger,
  );

  const matched = matchingReverseItsDelivery(txEvents, {
    originChain: lane.originChain,
    sourceAxelarChain: lane.originAxelarName,
    sourceAdapter: lane.originAdapter,
    sourceNonce: transfer.nonce,
    commandId: execution.commandId.toLowerCase() as Hex,
    tokenId,
    its: lane.destinationIts,
    destinationAdapter: lane.destinationAdapter,
    router: lane.destinationRouter,
    token: lane.destinationTokenSacId,
    recipient: recipient.strkey,
    amount: expectedStellarAmount,
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
        railMessageId: execution.commandId.toLowerCase(),
        recipient: matched.recipient,
        token: lane.destinationTokenSacId,
        amount: expectedStellarAmount,
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
      railMessageId: execution.commandId.toLowerCase(),
      recipient: matched.recipient,
      token: lane.destinationTokenSacId,
      amount: expectedStellarAmount,
      delivered: false,
      claimId: matched.claimId,
    },
    claim: {
      claimId: matched.claimId,
      recipient: matched.recipient,
      token: lane.destinationTokenSacId,
      amount: expectedStellarAmount,
      route: transfer.route,
      sourceChain: lane.originChain,
      sourceNonce: transfer.nonce,
      createdAt: matched.createdAt,
    },
  };
}

async function defaultReadEvmItsSource(lane: ReverseItsLane): Promise<EvmItsSourceState> {
  const client = createPublicClient({
    transport: http(lane.originRpcUrl, { timeout: 15_000, retryCount: 0 }),
  });
  const chainId = await client.getChainId();
  const adapterTokenId = await client.readContract({
    address: lane.originAdapter,
    abi: axelarItsAdapterAbi,
    functionName: "tokenIdOf",
    args: [lane.originToken],
  });
  const registeredTokenAddress = await client.readContract({
    address: lane.originIts,
    abi: ITS_ABI,
    functionName: "registeredTokenAddress",
    args: [adapterTokenId],
  });
  const tokenManagerAddress = await client.readContract({
    address: lane.originIts,
    abi: ITS_ABI,
    functionName: "deployedTokenManager",
    args: [adapterTokenId],
  });
  let tokenManagerType = 999n;
  if (tokenManagerAddress.toLowerCase() !== ZERO_ADDRESS) {
    tokenManagerType = await client.readContract({
      address: tokenManagerAddress,
      abi: EVM_ITS_TOKEN_MANAGER_ABI,
      functionName: "implementationType",
    });
  }
  const peer = await client.readContract({
    address: lane.originAdapter,
    abi: axelarItsAdapterAbi,
    functionName: "peerOf",
    args: [lane.destinationChain],
  });
  return {
    chainId,
    adapterTokenId,
    registeredTokenAddress,
    tokenManagerAddress,
    tokenManagerType,
    peer: {
      axelarChain: peer.axelarChain,
      peerAddress: peer.peer,
      configured: peer.configured,
      enabled: peer.enabled,
    },
  };
}

async function defaultReadStellarItsExecution(
  lane: ReverseItsLane,
  stellarTxHash: string,
  tokenId: Hex,
): Promise<StellarItsExecutionState> {
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
      adapterTokenId: null,
      registeredTokenAddress: null,
      tokenManagerType: null,
      configuredIts: null,
      configuredPeer: null,
    };
  }

  const eventsResult = (await rpcCall("getEvents", {
    startLedger: ledger,
    filters: [
      {
        type: "contract",
        contractIds: [
          lane.destinationIts,
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

  const tokenIdBytes = Uint8Array.from(
    (tokenId.slice(2).match(/.{2}/g) ?? []).map((byte) => Number.parseInt(byte, 16)),
  );
  const { nativeToScVal: toScVal } = await import("@stellar/stellar-sdk");
  const adapterTokenIdRaw = await view(lane.destinationAdapter, "token_id_for", [
    new Address(lane.destinationTokenSacId).toScVal(),
  ]);
  const adapterConfig = (await view(lane.destinationAdapter, "get_config")) as {
    its?: unknown;
  } | null;
  const registeredTokenRaw = await view(lane.destinationIts, "registered_token_address", [
    toScVal(tokenIdBytes, { type: "bytes" }),
  ]);
  const tokenManagerType = await view(lane.destinationIts, "token_manager_type", [
    toScVal(tokenIdBytes, { type: "bytes" }),
  ]);
  const peerRaw = (await view(lane.destinationAdapter, "peer_for", [
    toScVal(lane.originChain, { type: "string" }),
  ])) as {
    axelar_chain?: unknown;
    peer?: unknown;
    enabled?: unknown;
  } | null;

  let peerAddress: string | null = null;
  if (typeof peerRaw?.peer === "string") {
    peerAddress = peerRaw.peer;
  } else if (peerRaw?.peer instanceof Uint8Array) {
    peerAddress = toHex(peerRaw.peer);
  }

  return {
    status,
    ledger,
    latestLedger:
      typeof eventsResult.latestLedger === "number" ? eventsResult.latestLedger : latestLedger,
    events,
    adapterTokenId: adapterTokenIdRaw instanceof Uint8Array ? adapterTokenIdRaw : null,
    registeredTokenAddress: typeof registeredTokenRaw === "string" ? registeredTokenRaw : null,
    tokenManagerType,
    configuredIts: typeof adapterConfig?.its === "string" ? adapterConfig.its : null,
    configuredPeer:
      peerRaw !== null &&
      typeof peerRaw.axelar_chain === "string" &&
      peerAddress !== null &&
      typeof peerRaw.enabled === "boolean"
        ? {
            axelarChain: peerRaw.axelar_chain,
            peerAddress,
            enabled: peerRaw.enabled,
          }
        : null,
  };
}

function normalizeStellarTxHash(value: string): string | null {
  const clean = value.startsWith("0x") ? value.slice(2) : value;
  return /^[0-9a-fA-F]{64}$/.test(clean) ? clean.toLowerCase() : null;
}

function normalizeWord32(value: string): Hex | null {
  const clean = value.startsWith("0x") ? value.slice(2) : value;
  const out: Hex = `0x${clean.toLowerCase()}`;
  return /^[0-9a-fA-F]{64}$/.test(clean) ? out : null;
}

function matchesStellarPeerBytes(peerHex: Hex, expectedAdapterStrkey: string): boolean {
  const expectedHex = stringToHex(expectedAdapterStrkey).toLowerCase();
  return peerHex.toLowerCase() === expectedHex;
}

function matchesEvmAdapterString(peerValue: string, expectedAdapter: Hex): boolean {
  const trimmed = peerValue.trim().toLowerCase();
  const normalized = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  if (normalized === expectedAdapter.toLowerCase()) return true;
  if (/^0x[0-9a-f]{2,}$/.test(normalized)) {
    const bytes = Uint8Array.from(
      (normalized.slice(2).match(/.{2}/g) ?? []).map((part) => Number.parseInt(part, 16)),
    );
    const decoded = new TextDecoder().decode(bytes).trim().toLowerCase();
    const decodedHex = decoded.startsWith("0x") ? decoded : `0x${decoded}`;
    return decodedHex === expectedAdapter.toLowerCase();
  }
  return false;
}
