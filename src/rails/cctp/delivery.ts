import { StrKey } from "@stellar/stellar-sdk";
import {
  CHAINS,
  RAIL_CONTRACTS,
  RouteKind,
  assetOn,
  isChainKey,
  isEvmChain,
  isStellarDeployment,
  toEvmAddress,
  toHex,
} from "@hyperion/protocol";
import { createPublicClient, http, type Hex } from "viem";
import type { AppConfig } from "../../config/config.js";
import type { Queryable, Transactional } from "../../db/pool.js";
import { bigintOf, text, textOrNull } from "../../db/rows.js";
import type { PendingTransfer, RailReport } from "../types.js";
import type { VerifiedDelivery } from "../axelar/delivery.js";
import type { DeliveryLog } from "../axelar/events.js";
import {
  CCTP_CONTRACT_IDENTITY_ABI,
  EIP1967_IMPLEMENTATION_SLOT,
  ZEPPELINOS_IMPLEMENTATION_SLOT,
  codeHashOf,
  evaluateCctpContractIdentity,
  matchingCctpPayment,
  parseSlotAddress,
  verifiedCctpMessage,
  type CctpBaselineCodeIdentity,
  type CctpContractIdentityDiagnostic,
  type CctpContractObservation,
  type CctpContractRole,
  type CctpExpectedCodeIdentity,
  type CctpWiringSnapshot,
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

export type CctpIdentityFunctionName =
  | "localDomain"
  | "version"
  | "localMessageTransmitter"
  | "localMinter"
  | "remoteTokenMessengers"
  | "localTokenMessenger"
  | "getLocalToken"
  | "decimals";

export interface CctpEvmClient {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getTransactionReceipt(args: { hash: Hex }): Promise<CctpReceipt>;
  getBlock(args: { blockNumber: bigint }): Promise<CctpBlock>;
  getCode(args: { address: Hex; blockNumber: bigint }): Promise<Hex | undefined>;
  getStorageAt(args: { address: Hex; slot: Hex; blockNumber: bigint }): Promise<Hex | undefined>;
  readContract(args: {
    address: Hex;
    functionName: CctpIdentityFunctionName;
    args?: readonly unknown[];
    blockNumber: bigint;
  }): Promise<unknown>;
}

export interface VerifyCctpDeliveryOptions {
  readonly evmClient?: CctpEvmClient;
  readonly expectedIdentities?: Partial<Record<CctpContractRole, CctpExpectedCodeIdentity>>;
}

export interface CctpDeliveryVerificationOutcome {
  readonly delivery: VerifiedDelivery | null;
  readonly diagnostic: CctpContractIdentityDiagnostic | null;
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
    getCode: ({ address, blockNumber }) => client.getCode({ address, blockNumber }),
    getStorageAt: ({ address, slot, blockNumber }) =>
      client.getStorageAt({ address, slot, blockNumber }),
    readContract: ({ address, functionName, args, blockNumber }) =>
      client.readContract({
        address,
        abi: CCTP_CONTRACT_IDENTITY_ABI,
        functionName,
        ...(args !== undefined ? { args: args as never } : {}),
        blockNumber,
      }),
  };
}

async function observeContractAtBlock(
  client: CctpEvmClient,
  role: CctpContractRole,
  address: Hex,
  blockNumber: bigint,
): Promise<CctpContractObservation> {
  const code = await client.getCode({ address, blockNumber });
  const codeHash = codeHashOf(code);

  const eip1967Slot = await client.getStorageAt({
    address,
    slot: EIP1967_IMPLEMENTATION_SLOT,
    blockNumber,
  });
  let implementationAddress = parseSlotAddress(eip1967Slot);
  if (implementationAddress === null) {
    const zosSlot = await client.getStorageAt({
      address,
      slot: ZEPPELINOS_IMPLEMENTATION_SLOT,
      blockNumber,
    });
    implementationAddress = parseSlotAddress(zosSlot);
  }

  let implementationCodeHash: Hex | null = null;
  if (implementationAddress !== null) {
    const implCode = await client.getCode({ address: implementationAddress, blockNumber });
    implementationCodeHash = codeHashOf(implCode);
  }

  return {
    role,
    address,
    codeHash,
    implementationAddress,
    implementationCodeHash,
  };
}

async function readContractWiringAtBlock(
  client: CctpEvmClient,
  addresses: {
    readonly messenger: Hex;
    readonly transmitter: Hex;
    readonly minter: Hex;
    readonly usdc: Hex;
  },
  sourceTokenSacId: string,
  blockNumber: bigint,
): Promise<CctpWiringSnapshot> {
  const readErrors: Partial<Record<CctpContractRole, string>> = {};
  const sourceTokenBytes32 = toHex(StrKey.decodeContract(sourceTokenSacId));

  let transmitterLocalDomain: number | null = null;
  let transmitterVersion: number | null = null;
  try {
    const domainVal = await client.readContract({
      address: addresses.transmitter,
      functionName: "localDomain",
      blockNumber,
    });
    const versionVal = await client.readContract({
      address: addresses.transmitter,
      functionName: "version",
      blockNumber,
    });
    transmitterLocalDomain = Number(domainVal);
    transmitterVersion = Number(versionVal);
  } catch (err) {
    readErrors.message_transmitter_v2 = err instanceof Error ? err.message : String(err);
  }

  let messengerLocalTransmitter: string | null = null;
  let messengerLocalMinter: string | null = null;
  let messengerRemotePeer: string | null = null;
  try {
    const localTransmitter = await client.readContract({
      address: addresses.messenger,
      functionName: "localMessageTransmitter",
      blockNumber,
    });
    const localMinter = await client.readContract({
      address: addresses.messenger,
      functionName: "localMinter",
      blockNumber,
    });
    const remotePeer = await client.readContract({
      address: addresses.messenger,
      functionName: "remoteTokenMessengers",
      args: [27],
      blockNumber,
    });
    messengerLocalTransmitter = String(localTransmitter);
    messengerLocalMinter = String(localMinter);
    messengerRemotePeer = String(remotePeer);
  } catch (err) {
    readErrors.token_messenger_v2 = err instanceof Error ? err.message : String(err);
  }

  let minterLocalMessenger: string | null = null;
  let minterLocalToken: string | null = null;
  try {
    const localMessenger = await client.readContract({
      address: addresses.minter,
      functionName: "localTokenMessenger",
      blockNumber,
    });
    const localToken = await client.readContract({
      address: addresses.minter,
      functionName: "getLocalToken",
      args: [27, sourceTokenBytes32],
      blockNumber,
    });
    minterLocalMessenger = String(localMessenger);
    minterLocalToken = String(localToken);
  } catch (err) {
    readErrors.token_minter_v2 = err instanceof Error ? err.message : String(err);
  }

  let usdcDecimals: number | null = null;
  try {
    const decVal = await client.readContract({
      address: addresses.usdc,
      functionName: "decimals",
      blockNumber,
    });
    usdcDecimals = Number(decVal);
  } catch (err) {
    readErrors.usdc = err instanceof Error ? err.message : String(err);
  }

  return {
    transmitterLocalDomain,
    transmitterVersion,
    messengerLocalTransmitter,
    messengerLocalMinter,
    messengerRemotePeer,
    minterLocalMessenger,
    minterLocalToken,
    usdcDecimals,
    readErrors,
  };
}

async function loadBaselinesForChain(
  db: Queryable,
  chainKey: string,
): Promise<Partial<Record<CctpContractRole, CctpBaselineCodeIdentity>>> {
  try {
    const { rows } = await db.query(
      `SELECT role, contract_address, code_hash, implementation_address, implementation_code_hash
         FROM cctp_contract_baseline
        WHERE chain_key = $1`,
      [chainKey],
    );
    const out: Partial<Record<CctpContractRole, CctpBaselineCodeIdentity>> = {};
    for (const row of rows) {
      const role = text(row, "role") as CctpContractRole;
      out[role] = {
        address: text(row, "contract_address"),
        codeHash: text(row, "code_hash"),
        implementationAddress: textOrNull(row, "implementation_address"),
        implementationCodeHash: textOrNull(row, "implementation_code_hash"),
      };
    }
    return out;
  } catch {
    return {};
  }
}

async function persistContractDiagnostic(
  db: Transactional,
  transferId: bigint,
  diagnostic: CctpContractIdentityDiagnostic,
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      if (diagnostic.verdict === "verified") {
        const roles: readonly CctpContractRole[] = [
          "token_messenger_v2",
          "message_transmitter_v2",
          "token_minter_v2",
          "usdc",
        ];
        for (const role of roles) {
          const obs = diagnostic.observations[role];
          if (obs.codeHash === null) continue;
          await tx.query(
            `INSERT INTO cctp_contract_baseline
               (chain_key, role, contract_address, code_hash, implementation_address,
                implementation_code_hash, first_seen_block, first_seen_block_hash)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (chain_key, role) DO NOTHING`,
            [
              diagnostic.destinationChain,
              role,
              obs.address.toLowerCase(),
              obs.codeHash.toLowerCase(),
              obs.implementationAddress?.toLowerCase() ?? null,
              obs.implementationCodeHash?.toLowerCase() ?? null,
              diagnostic.blockNumber.toString(),
              diagnostic.blockHash.toLowerCase(),
            ],
          );
        }
      }

      await tx.query(
        `INSERT INTO cctp_contract_diagnostic
           (transfer_id, destination_chain, chain_id, block_number, block_hash, tx_hash, verdict,
            issues, observations)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
         ON CONFLICT (transfer_id, destination_chain, block_number, block_hash) DO UPDATE
           SET tx_hash = EXCLUDED.tx_hash,
               verdict = EXCLUDED.verdict,
               issues = EXCLUDED.issues,
               observations = EXCLUDED.observations,
               observed_at = now()`,
        [
          transferId.toString(),
          diagnostic.destinationChain,
          diagnostic.chainId,
          diagnostic.blockNumber.toString(),
          diagnostic.blockHash.toLowerCase(),
          diagnostic.txHash.toLowerCase(),
          diagnostic.verdict,
          JSON.stringify(diagnostic.issues),
          JSON.stringify(diagnostic.observations),
        ],
      );
    });
  } catch {
    /* Diagnostic persistence is best-effort when running against lightweight read-only mocks. */
  }
}

export async function diagnoseCctpDestinationContracts(input: {
  readonly client: CctpEvmClient;
  readonly db: Transactional;
  readonly transferId: bigint;
  readonly destinationChain: string;
  readonly chainId: number;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly txHash: Hex;
  readonly expected: ExpectedCctpTransfer & { readonly minter: string };
  readonly expectedIdentities?:
    Partial<Record<CctpContractRole, CctpExpectedCodeIdentity>> | undefined;
}): Promise<CctpContractIdentityDiagnostic> {
  const messengerAddr = input.expected.destinationMessenger as Hex;
  const transmitterAddr = input.expected.transmitter as Hex;
  const minterAddr = input.expected.minter as Hex;
  const usdcAddr = input.expected.token as Hex;

  const [messengerObs, transmitterObs, minterObs, usdcObs, wiring, baselines] = await Promise.all([
    observeContractAtBlock(input.client, "token_messenger_v2", messengerAddr, input.blockNumber),
    observeContractAtBlock(
      input.client,
      "message_transmitter_v2",
      transmitterAddr,
      input.blockNumber,
    ),
    observeContractAtBlock(input.client, "token_minter_v2", minterAddr, input.blockNumber),
    observeContractAtBlock(input.client, "usdc", usdcAddr, input.blockNumber),
    readContractWiringAtBlock(
      input.client,
      {
        messenger: messengerAddr,
        transmitter: transmitterAddr,
        minter: minterAddr,
        usdc: usdcAddr,
      },
      input.expected.sourceToken,
      input.blockNumber,
    ),
    loadBaselinesForChain(input.db, input.destinationChain),
  ]);

  const diagnostic = evaluateCctpContractIdentity({
    destinationChain: input.destinationChain,
    chainId: input.chainId,
    blockNumber: input.blockNumber,
    blockHash: input.blockHash,
    txHash: input.txHash,
    expected: input.expected,
    observations: {
      token_messenger_v2: messengerObs,
      message_transmitter_v2: transmitterObs,
      token_minter_v2: minterObs,
      usdc: usdcObs,
    },
    wiring,
    pinned: input.expectedIdentities,
    baselines,
  });

  await persistContractDiagnostic(input.db, input.transferId, diagnostic);
  return diagnostic;
}

export async function verifyCctpDeliveryWithDiagnostics(
  config: AppConfig,
  db: Transactional,
  transfer: PendingTransfer,
  report: RailReport,
  options?: VerifyCctpDeliveryOptions,
): Promise<CctpDeliveryVerificationOutcome> {
  if (
    transfer.route !== RouteKind.Cctp ||
    transfer.originChain !== "stellar-testnet" ||
    !report.forwardTxHash ||
    !report.messageBytes ||
    !/^0x[0-9a-fA-F]+$/.test(report.messageBytes) ||
    !isChainKey(transfer.destinationChain)
  ) {
    return { delivery: null, diagnostic: null };
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
    return { delivery: null, diagnostic: null };
  }
  const { rows } = await db.query(
    "SELECT token, net_amount, destination FROM outbound_transfer WHERE id = $1",
    [String(transfer.transferId)],
  );
  const stored = rows[0];
  if (!stored || text(stored, "token") !== sourceToken.sacId) {
    return { delivery: null, diagnostic: null };
  }
  const expected: ExpectedCctpTransfer & { readonly minter: string } = {
    sourceToken: sourceToken.sacId,
    sourceAdapter: adapter,
    sourceMessenger: STELLAR_CCTP_MESSENGER,
    destinationDomain: destination.cctpDomain,
    destinationMessenger: contracts.tokenMessengerV2,
    transmitter: contracts.messageTransmitterV2,
    minter: contracts.tokenMinterV2,
    token: token.address,
    recipient: toEvmAddress(text(stored, "destination") as Hex),
    sourceAmount: bigintOf(stored, "net_amount"),
  };
  const raw = report.messageBytes as Hex;
  const message = verifiedCctpMessage(raw, expected);
  if (!message) {
    return { delivery: null, diagnostic: null };
  }
  const client = options?.evmClient ?? createDefaultEvmClient(destination.defaultRpcUrl);
  if ((await client.getChainId()) !== destination.chainId) {
    throw new Error("CCTP destination RPC chain mismatch.");
  }
  const receipt = await client.getTransactionReceipt({ hash: report.forwardTxHash });
  if (receipt.status !== "success") {
    return { delivery: null, diagnostic: null };
  }
  const head = await client.getBlockNumber();
  if (head - receipt.blockNumber + 1n < BigInt(destination.confirmations)) {
    return { delivery: null, diagnostic: null };
  }
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) {
    return { delivery: null, diagnostic: null };
  }

  const diagnostic = await diagnoseCctpDestinationContracts({
    client,
    db,
    transferId: transfer.transferId,
    destinationChain: transfer.destinationChain,
    chainId: destination.chainId,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    txHash: receipt.transactionHash,
    expected,
    expectedIdentities: options?.expectedIdentities,
  });
  if (diagnostic.verdict !== "verified") {
    return { delivery: null, diagnostic };
  }

  const payment = matchingCctpPayment(receipt.logs, raw, expected);
  if (!payment) {
    return { delivery: null, diagnostic };
  }

  return {
    diagnostic,
    delivery: {
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
  const outcome = await verifyCctpDeliveryWithDiagnostics(config, db, transfer, report, options);
  return outcome.delivery;
}
