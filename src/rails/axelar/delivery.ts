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
import { bigintOf, integer, integerOrNull, text } from "../../db/rows.js";
import {
  writeAttestation,
  writeInbound,
  writeItsPaymentProof,
  type InboundRow,
  type ItsPaymentProofRow,
  type Position,
} from "../../chains/writers.js";
import type { PendingTransfer, RailClient, RailReport } from "../types.js";

import { ITS_ABI, matchingPayment, type DeliveryLog } from "./events.js";

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

/**
 * Read-only EVM client surface used for ITS verification and reorg revalidation.
 * Deliberately excludes any signing or transaction broadcast methods.
 */
export interface ItsReadOnlyEvmClient {
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
  readonly evmClient?: ItsReadOnlyEvmClient;
  readonly now?: () => Date;
}

export interface RevalidateItsProofsOptions {
  readonly batchSize?: number;
  readonly gmpClient?: RailClient;
  readonly stellarView?: StellarContractView;
  readonly evmClient?: ItsReadOnlyEvmClient;
  readonly evmClientForChain?: (chainKey: string) => ItsReadOnlyEvmClient;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

export interface RevalidationSummary {
  readonly checked: number;
  readonly valid: number;
  readonly reconciled: number;
  readonly invalidated: number;
}

export interface VerifiedDelivery {
  readonly at: Position;
  readonly row: InboundRow;
  readonly itsPaymentProof?: ItsPaymentProofRow | undefined;
}

function createDefaultEvmClient(rpcUrl: string): ItsReadOnlyEvmClient {
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

function createDefaultStellarView(
  rpcUrl: string,
  networkPassphrase: string,
  admin: string,
): StellarContractView {
  const stellar = new rpc.Server(rpcUrl, { timeout: 15_000 });
  return async (contract, method, args = []) => {
    const tx = new TransactionBuilder(new Account(admin, "0"), {
      fee: BASE_FEE,
      networkPassphrase,
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
}

async function resolveSourceLane(
  config: AppConfig,
  token: string,
  stellarView?: StellarContractView,
): Promise<{ readonly tokenId: Hex; readonly sourceName: string } | null> {
  const source = config.indexer.stellar;
  if (!source) return null;
  const deployment = config.deployments.networks[source.chain];
  if (!deployment) return null;
  const adapter = deployment.adapters[RouteKind.AxelarIts];
  if (!adapter) return null;

  const view =
    stellarView ??
    createDefaultStellarView(source.rpcUrl, source.networkPassphrase, deployment.admin);
  const id = await view(adapter, "token_id_for", [new Address(token).toScVal()]);
  if (!(id instanceof Uint8Array) || id.length !== 32) {
    throw new Error("Source token id is invalid.");
  }
  const tokenId = toHex(id);
  const adapterConfig = (await view(adapter, "get_config")) as { its?: string };
  if (!adapterConfig.its) return null;
  const sourceName = await view(adapterConfig.its, "chain_name");
  if (typeof sourceName !== "string") return null;
  return { tokenId, sourceName };
}

// The rail API supplies candidate receipts. Only matching confirmed chain events establish delivery.
export async function verifyItsDelivery(
  config: AppConfig,
  db: Transactional,
  transfer: PendingTransfer,
  report: RailReport,
  options?: VerifyItsDeliveryOptions,
): Promise<VerifiedDelivery | null> {
  const candidates =
    report.executionCandidates && report.executionCandidates.length > 0
      ? report.executionCandidates
      : report.execution
        ? [report.execution]
        : [];
  const source = config.indexer.stellar;
  if (
    candidates.length === 0 ||
    !source ||
    transfer.route !== RouteKind.AxelarIts ||
    transfer.originChain !== source.chain ||
    !isChainKey(transfer.destinationChain)
  ) {
    return null;
  }

  const destination = CHAINS[transfer.destinationChain];
  const its = RAIL_CONTRACTS[transfer.destinationChain]?.axelar?.interchainTokenService;
  if (!isEvmChain(destination) || !its?.startsWith("0x")) return null;

  const { rows } = await db.query(
    "SELECT sender, token, net_amount, destination FROM outbound_transfer WHERE id = $1",
    [String(transfer.transferId)],
  );
  const stored = rows[0];
  if (!stored) return null;
  const sender = text(stored, "sender");
  const token = text(stored, "token");
  const amount = bigintOf(stored, "net_amount");
  const recipient = toEvmAddress(text(stored, "destination") as `0x${string}`);

  const lane = await resolveSourceLane(config, token, options?.stellarView);
  if (!lane) return null;

  const client = options?.evmClient ?? createDefaultEvmClient(destination.defaultRpcUrl);
  if ((await client.getChainId()) !== destination.chainId) {
    throw new Error("Destination RPC chain mismatch.");
  }
  const head = await client.getBlockNumber();
  const itsAddress = its as Hex;
  const verifiedAt = options?.now ? options.now() : new Date();

  for (const candidate of candidates) {
    const receipt = await client.getTransactionReceipt({ hash: candidate.txHash });
    if (receipt?.status !== "success") continue;
    if (head - receipt.blockNumber + 1n < BigInt(destination.confirmations)) continue;

    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    const canonicalHash = block?.hash;
    if (canonicalHash?.toLowerCase() !== receipt.blockHash.toLowerCase()) continue;

    const destinationToken = await client.readRegisteredToken(
      itsAddress,
      lane.tokenId,
      receipt.blockNumber,
    );
    if (destinationToken.toLowerCase() === ZERO_ADDRESS) continue;

    const payment = matchingPayment(receipt.logs, {
      its,
      token: destinationToken,
      commandId: candidate.commandId,
      tokenId: lane.tokenId,
      sourceChain: lane.sourceName,
      sourceAddress: stringToHex(sender),
      recipient,
      amount,
    });
    if (!payment) continue;

    const blockTimestamp = block?.timestamp ?? 0n;
    return {
      at: {
        chainKey: transfer.destinationChain,
        block: receipt.blockNumber,
        txHash: receipt.transactionHash,
        logIndex: payment.logIndex,
        observedAt: new Date(Number(blockTimestamp) * 1000),
      },
      row: {
        route: transfer.route,
        sourceChain: transfer.originChain,
        sourceNonce: transfer.nonce,
        railMessageId: candidate.commandId,
        recipient: recipient.toLowerCase(),
        token: destinationToken.toLowerCase(),
        amount,
        delivered: true,
        claimId: null,
      },
      itsPaymentProof: {
        transferId: transfer.transferId,
        destinationChain: transfer.destinationChain,
        route: transfer.route,
        sourceChain: transfer.originChain,
        sourceNonce: transfer.nonce,
        commandId: candidate.commandId.toLowerCase(),
        tokenId: lane.tokenId.toLowerCase(),
        token: destinationToken.toLowerCase(),
        recipient: recipient.toLowerCase(),
        amount,
        proofBlock: receipt.blockNumber,
        proofBlockHash: canonicalHash.toLowerCase(),
        proofTx: receipt.transactionHash.toLowerCase(),
        proofLogIndex: payment.logIndex,
        verifiedAt,
      },
    };
  }

  return null;
}

/**
 * Revalidates canonical stored ITS payment proofs against current canonical destination blocks.
 *
 * When a destination chain reorganization orphans a previously confirmed payout block:
 * - if a replacement proof (re-mined transaction or replacement GMP child execution) satisfies
 *   full source-intent and destination ERC-20 payment checks, the delivery and proof records are
 *   reconciled atomically to the new canonical block;
 * - otherwise, the orphaned inbound_delivery row is removed, the proof is marked orphaned, and
 *   rail_attestation returns to attested so the poller tracks future canonical execution.
 *
 * Never signs or submits any transaction on either chain.
 */
export async function revalidateItsDeliveryProofs(
  config: AppConfig,
  db: Transactional,
  options?: RevalidateItsProofsOptions,
): Promise<RevalidationSummary> {
  const source = config.indexer.stellar;
  if (!source) {
    return { checked: 0, valid: 0, reconciled: 0, invalidated: 0 };
  }

  const batchSize = options?.batchSize ?? 25;
  const { rows } = await db.query(
    `SELECT p.transfer_id,
            p.destination_chain,
            p.route,
            p.source_chain,
            p.source_nonce,
            p.command_id,
            p.token_id,
            p.token,
            p.recipient,
            p.amount,
            p.proof_block,
            p.proof_block_hash,
            p.proof_tx,
            p.proof_log_index,
            t.origin_tx,
            t.sender,
            t.token AS source_token,
            t.net_amount,
            t.destination
       FROM its_payment_proof p
       JOIN outbound_transfer t ON t.id = p.transfer_id
      WHERE p.proof_state = 'canonical'
      ORDER BY p.revalidated_at NULLS FIRST, p.transfer_id ASC
      LIMIT $1`,
    [batchSize],
  );

  let checked = 0;
  let valid = 0;
  let reconciled = 0;
  let invalidated = 0;

  for (const row of rows) {
    if (options?.signal?.aborted === true) break;

    const transferId = bigintOf(row, "transfer_id");
    const destinationChain = text(row, "destination_chain");
    const route = integer(row, "route");
    const sourceChain = text(row, "source_chain");
    const sourceNonce = bigintOf(row, "source_nonce");
    const commandId = text(row, "command_id") as Hex;
    const storedTokenId = text(row, "token_id") as Hex;
    const storedToken = text(row, "token");
    const storedRecipient = text(row, "recipient");
    const storedAmount = bigintOf(row, "amount");
    const proofBlock = bigintOf(row, "proof_block");
    const proofBlockHash = text(row, "proof_block_hash");
    const proofTx = text(row, "proof_tx") as Hex;
    const proofLogIndex = integerOrNull(row, "proof_log_index");
    const originTx = text(row, "origin_tx");
    const sender = text(row, "sender");
    const sourceToken = text(row, "source_token");
    const expectedNetAmount = bigintOf(row, "net_amount");
    const expectedRecipient = toEvmAddress(text(row, "destination") as `0x${string}`);

    if (!isChainKey(destinationChain)) continue;
    const destination = CHAINS[destinationChain];
    const its = RAIL_CONTRACTS[destinationChain]?.axelar?.interchainTokenService;
    if (!isEvmChain(destination) || !its?.startsWith("0x")) continue;

    const client =
      options?.evmClientForChain?.(destinationChain) ??
      options?.evmClient ??
      createDefaultEvmClient(destination.defaultRpcUrl);
    if ((await client.getChainId()) !== destination.chainId) {
      throw new Error("Destination RPC chain mismatch.");
    }

    const lane = await resolveSourceLane(config, sourceToken, options?.stellarView);
    if (!lane) continue;

    checked += 1;
    const now = options?.now ? options.now() : new Date();
    const head = await client.getBlockNumber();
    const canonicalBlock = await client.getBlock({ blockNumber: proofBlock });
    const receipt = await client.getTransactionReceipt({ hash: proofTx });

    let stillCanonical = false;
    if (
      canonicalBlock?.hash?.toLowerCase() === proofBlockHash.toLowerCase() &&
      receipt !== null &&
      receipt.status === "success" &&
      receipt.blockNumber === proofBlock &&
      receipt.blockHash.toLowerCase() === proofBlockHash.toLowerCase() &&
      head - proofBlock + 1n >= BigInt(destination.confirmations) &&
      storedTokenId.toLowerCase() === lane.tokenId.toLowerCase() &&
      storedAmount === expectedNetAmount &&
      storedRecipient.toLowerCase() === expectedRecipient.toLowerCase()
    ) {
      const registeredToken = await client.readRegisteredToken(
        its as Hex,
        lane.tokenId,
        proofBlock,
      );
      if (registeredToken.toLowerCase() === storedToken.toLowerCase()) {
        const payment = matchingPayment(receipt.logs, {
          its,
          token: registeredToken,
          commandId,
          tokenId: lane.tokenId,
          sourceChain: lane.sourceName,
          sourceAddress: stringToHex(sender),
          recipient: expectedRecipient,
          amount: expectedNetAmount,
        });
        stillCanonical = payment !== null && payment.logIndex === proofLogIndex;
      }
    }

    if (stillCanonical) {
      await db.transaction(async (tx: Queryable) => {
        await tx.query(
          `UPDATE its_payment_proof
              SET revalidated_at = $2,
                  revalidation_count = revalidation_count + 1
            WHERE transfer_id = $1`,
          [transferId.toString(), now],
        );
      });
      valid += 1;
      continue;
    }

    // Stored proof left the canonical chain. Attempt read-only reconciliation against original intent.
    const pendingTransfer: PendingTransfer = {
      transferId,
      route,
      originChain: sourceChain,
      destinationChain,
      nonce: sourceNonce,
      originTx,
      status: "attested",
      checkFailures: 0,
      delivered: false,
    };
    const verifyOpts: VerifyItsDeliveryOptions = {
      ...(options?.stellarView ? { stellarView: options.stellarView } : {}),
      evmClient: client,
      now: () => now,
    };

    // 1. Check whether the original transaction hash was re-mined into a new canonical block.
    let replacement = await verifyItsDelivery(
      config,
      db,
      pendingTransfer,
      {
        status: "attested",
        railStatus: "revalidating",
        reference: null,
        attestedAt: null,
        execution: { txHash: proofTx, commandId },
      },
      verifyOpts,
    );
    let replacementReport: RailReport | null = null;

    // 2. Otherwise consult read-only GMP candidate discovery for a replacement execution.
    if (!replacement && options?.gmpClient) {
      const lookup = await options.gmpClient.look(pendingTransfer, options.signal);
      if (lookup.kind === "found") {
        replacementReport = lookup.report;
        replacement = await verifyItsDelivery(
          config,
          db,
          pendingTransfer,
          lookup.report,
          verifyOpts,
        );
      }
    }

    if (replacement?.itsPaymentProof) {
      const nextProof = replacement.itsPaymentProof;
      await db.transaction(async (tx: Queryable) => {
        await writeInbound(tx, replacement.at, replacement.row);
        await writeItsPaymentProof(tx, nextProof);
        await tx.query(
          `UPDATE its_payment_proof
              SET revalidation_count = revalidation_count + 1,
                  revalidated_at = $2
            WHERE transfer_id = $1`,
          [transferId.toString(), now],
        );
        await writeAttestation(tx, {
          transferId,
          route,
          status: "delivered",
          railStatus: replacementReport?.railStatus ?? null,
          railReference: replacementReport?.reference ?? null,
          attestedAt: replacementReport?.attestedAt ?? null,
          checkedAt: now,
          checkFailures: 0,
          lastError: null,
        });
      });
      reconciled += 1;
      continue;
    }

    // No valid replacement proof exists: invalidate the orphaned payout so it cannot stay confirmed.
    await db.transaction(async (tx: Queryable) => {
      await tx.query(
        `DELETE FROM inbound_delivery
          WHERE destination_chain = $1
            AND route = $2
            AND source_chain = $3
            AND source_nonce = $4`,
        [destinationChain, route, sourceChain, sourceNonce.toString()],
      );
      await tx.query(
        `UPDATE its_payment_proof
            SET proof_state = 'orphaned',
                orphaned_block_hash = proof_block_hash,
                orphaned_tx = proof_tx,
                revalidation_count = revalidation_count + 1,
                revalidated_at = $2
          WHERE transfer_id = $1`,
        [transferId.toString(), now],
      );
      await writeAttestation(tx, {
        transferId,
        route,
        status: "attested",
        railStatus: replacementReport?.railStatus ?? null,
        railReference: replacementReport?.reference ?? null,
        attestedAt: replacementReport?.attestedAt ?? null,
        checkedAt: now,
        checkFailures: 0,
        lastError: "its_proof_orphaned_by_reorg",
      });
    });
    invalidated += 1;
  }

  return { checked, valid, reconciled, invalidated };
}
