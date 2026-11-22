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
import { stringToHex } from "viem";
import type { Logger } from "pino";
import { isDestinationVerificationChain, type AppConfig } from "../../config/config.js";
import type { Queryable, Transactional } from "../../db/pool.js";
import { bigintOf, text } from "../../db/rows.js";
import type { InboundRow, Position } from "../../chains/writers.js";
import type { PendingTransfer, RailReport } from "../types.js";

import {
  ITS_ABI,
  inspectPayment,
  inspectTokenMapping,
  type VerificationDiagnostic,
} from "./events.js";
import type { AxelarDeliveryEvidenceRow } from "../../chains/writers.js";
import type { BoundedCandidateReceiptCache } from "../candidate-receipt-cache.js";
import {
  DestinationVerificationRpcError,
  destinationVerificationViemClient,
  withDestinationVerification,
  type DestinationVerificationClientFactory,
} from "../../chains/evm/client.js";

export interface ItsVerificationOptions {
  readonly signal?: AbortSignal;
  readonly logger?: Logger;
  readonly clientForUrl?: DestinationVerificationClientFactory;
  readonly candidateReceiptCache?: BoundedCandidateReceiptCache;
}

export interface VerifiedDelivery {
  readonly at: Position;
  readonly row: InboundRow;
}

export interface VerifiedItsDelivery extends VerifiedDelivery {
  readonly evidence: AxelarDeliveryEvidenceRow;
}

export interface VerificationFailure {
  readonly state: "receipt_unavailable" | "payout_unverified";
  readonly diagnostics: readonly VerificationDiagnostic[];
}

export type ItsVerificationState = "receipt_unavailable" | "payout_unverified" | "verified";

export interface ItsVerificationResult {
  readonly state: ItsVerificationState;
  readonly delivery: VerifiedItsDelivery | null;
}

export interface AxelarCanonicalityClient {
  getChainId(): Promise<number>;
  getBlock(args: { readonly blockNumber: bigint }): Promise<{ readonly hash: `0x${string}` }>;
  getTransactionReceipt(args: { readonly hash: `0x${string}` }): Promise<{
    readonly status: "success" | "reverted";
    readonly blockNumber: bigint;
    readonly blockHash: `0x${string}`;
    readonly transactionHash: `0x${string}`;
  }>;
}

export interface RevalidationOptions {
  readonly signal?: AbortSignal;
  readonly clientForChain?: (chainKey: string) => AxelarCanonicalityClient;
  readonly clientForUrl?: DestinationVerificationClientFactory<AxelarCanonicalityClient>;
  readonly logger?: Logger;
}

export async function revalidateItsDeliveryProofs(
  config: AppConfig,
  db: Transactional,
  limit: number,
  options: RevalidationOptions = {},
): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new Error("Axelar revalidation batch must be between 1 and 1000.");
  const { rows } = await db.query(
    `SELECT id, transfer_id, destination_chain, execution_tx_hash, receipt_block, receipt_block_hash
       FROM axelar_delivery_evidence WHERE status = 'canonical'
      ORDER BY last_revalidated_at NULLS FIRST, receipt_block, id LIMIT $1`,
    [limit],
  );
  const clients = new Map<string, AxelarCanonicalityClient>();
  let orphaned = 0;
  for (const row of rows) {
    options.signal?.throwIfAborted();
    const chain = text(row, "destination_chain");
    if (
      !isChainKey(chain) ||
      !isDestinationVerificationChain(chain) ||
      !isEvmChain(CHAINS[chain]) ||
      CHAINS[chain].network !== config.network
    )
      throw new Error("Axelar proof names an unsupported destination chain.");
    const chainConfig = CHAINS[chain];
    const urls = config.destinationVerification.evmRpcUrls[chain];
    const blockNumber = bigintOf(row, "receipt_block");
    const blockHash = text(row, "receipt_block_hash");
    const txHash = text(row, "execution_tx_hash") as `0x${string}`;
    const canonical = await withDestinationVerification(
      urls,
      chainConfig.chainId,
      (url, signal) => {
        const key = `${chain}:${url}`;
        let client = clients.get(key);
        if (!client) {
          client =
            options.clientForUrl?.(url, signal) ??
            options.clientForChain?.(chain) ??
            canonicalityClient(url, signal);
          clients.set(key, client);
        }
        return client;
      },
      async (client) => {
        const block = await client.getBlock({ blockNumber });
        const blockCanonical = block.hash.toLowerCase() === blockHash.toLowerCase();
        if (!blockCanonical) return false;
        const receipt = await client.getTransactionReceipt({ hash: txHash });
        return (
          receipt.status === "success" &&
          receipt.blockNumber === blockNumber &&
          receipt.blockHash.toLowerCase() === blockHash.toLowerCase() &&
          receipt.transactionHash.toLowerCase() === txHash.toLowerCase()
        );
      },
      {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.logger === undefined ? {} : { logger: options.logger }),
        chain,
      },
    );
    options.signal?.throwIfAborted();
    const changed = await db.transaction(async (tx) => {
      // Serialize with the rail pass and re-check the exact proof after remote reads. A newer
      // replacement or same-id re-mined receipt must never be invalidated by a stale result.
      const locked = await tx.query(
        "SELECT id FROM outbound_transfer WHERE id = $1 FOR UPDATE SKIP LOCKED",
        [String(row.transfer_id)],
      );
      if (locked.rowCount !== 1) return false;
      const result = await tx.query(
        `UPDATE axelar_delivery_evidence SET status = $6, last_revalidated_at = now()
          WHERE id = $1 AND transfer_id = $2 AND status = 'canonical'
            AND execution_tx_hash = $3 AND receipt_block = $4 AND receipt_block_hash = $5
          RETURNING id`,
        [
          String(row.id),
          String(row.transfer_id),
          txHash,
          blockNumber.toString(),
          blockHash,
          canonical ? "canonical" : "orphaned",
        ],
      );
      if (canonical || result.rowCount !== 1) return false;
      await tx.query("DELETE FROM inbound_delivery WHERE axelar_evidence_id = $1", [
        String(row.id),
      ]);
      await tx.query(
        "SELECT set_config('hyperion.rail_reconcile_transfer',$1,true), set_config('hyperion.rail_reconcile_reason','destination_proof_reorg',true)",
        [String(row.transfer_id)],
      );
      await tx.query(
        `UPDATE rail_attestation SET status = 'attested', updated_at = now(),
            next_attempt_at = now(), retry_class = NULL
          WHERE transfer_id = $1 AND status = 'delivered'
            AND NOT EXISTS (SELECT 1 FROM inbound_delivery d JOIN outbound_transfer t
              ON (t.origin_chain, t.nonce) = (d.source_chain, d.source_nonce)
              WHERE t.id = $1 AND d.delivered = true)`,
        [String(row.transfer_id)],
      );
      return true;
    });
    if (changed) orphaned += 1;
  }
  return orphaned;
}

function canonicalityClient(url: string, signal?: AbortSignal): AxelarCanonicalityClient {
  return destinationVerificationViemClient(url, signal);
}

// The rail API supplies a candidate receipt. Only matching confirmed chain events establish delivery.
export async function verifyItsDelivery(
  config: AppConfig,
  db: Queryable,
  transfer: PendingTransfer,
  report: RailReport,
  options: ItsVerificationOptions = {},
): Promise<VerifiedItsDelivery | VerificationFailure | null> {
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
  if (
    !isDestinationVerificationChain(transfer.destinationChain) ||
    !isEvmChain(destination) ||
    !its?.startsWith("0x")
  )
    return null;
  const { rows } = await db.query(
    "SELECT origin_chain,origin_router,nonce,origin_tx,sender,token,net_amount,destination_chain,destination FROM outbound_transfer WHERE id = $1",
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
  const sourceToken = (
    Object.values(deployment.tokens) as readonly {
      readonly sacId?: string;
      readonly code?: string;
      readonly decimals: number;
    }[]
  ).find((candidate) => candidate.sacId === token);
  if (!sourceToken?.code) return null;
  const sourceSymbol = sourceToken.code;
  const adapterConfig = (await view(adapter, "get_config")) as { its?: string };
  if (!adapterConfig.its) return null;
  const sourceName = await view(adapterConfig.its, "chain_name");
  if (typeof sourceName !== "string") return null;
  try {
    return await withDestinationVerification(
      config.destinationVerification.evmRpcUrls[transfer.destinationChain],
      destination.chainId,
      options.clientForUrl ?? destinationVerificationViemClient,
      async (client) => {
        const receipt = options.candidateReceiptCache
          ? await options.candidateReceiptCache.get({
              chain: transfer.destinationChain,
              txHash: execution.txHash,
              read: () => client.getTransactionReceipt({ hash: execution.txHash }),
              readBlock: ({ blockNumber }) => client.getBlock({ blockNumber }),
              identity: (candidate) => ({
                blockNumber: candidate.blockNumber,
                blockHash: candidate.blockHash,
              }),
            })
          : await client.getTransactionReceipt({ hash: execution.txHash });
        if (receipt.status !== "success")
          return {
            state: "payout_unverified",
            diagnostics: [
              {
                category: "payment_evidence",
                expected: "successful destination receipt",
                observed: "reverted",
              },
            ],
          };
        const head = await client.getBlockNumber();
        if (head - receipt.blockNumber + 1n < BigInt(destination.confirmations))
          return { state: "receipt_unavailable", diagnostics: [] };
        const block = await client.getBlock({
          blockNumber: receipt.blockNumber,
          includeTransactions: false,
        });
        if (block.hash !== receipt.blockHash)
          return {
            state: "payout_unverified",
            diagnostics: [
              { category: "payment_evidence", expected: block.hash, observed: receipt.blockHash },
            ],
          };
        const destinationToken = await client.readContract({
          address: its as `0x${string}`,
          abi: ITS_ABI,
          functionName: "registeredTokenAddress",
          args: [tokenId],
          blockNumber: receipt.blockNumber,
        });
        const tokenManager = await client.readContract({
          address: its as `0x${string}`,
          abi: ITS_ABI,
          functionName: "tokenManagerAddress",
          args: [tokenId],
          blockNumber: receipt.blockNumber,
        });
        if (/^0x0{40}$/i.test(tokenManager)) return null;
        const [destinationSymbol, destinationDecimals] = await Promise.all([
          client.readContract({
            address: destinationToken,
            abi: ITS_ABI,
            functionName: "symbol",
            blockNumber: receipt.blockNumber,
          }),
          client.readContract({
            address: destinationToken,
            abi: ITS_ABI,
            functionName: "decimals",
            blockNumber: receipt.blockNumber,
          }),
        ]);
        const mappingDiagnostics = inspectTokenMapping(
          { symbol: sourceSymbol, decimals: sourceToken.decimals },
          { symbol: destinationSymbol, decimals: destinationDecimals },
        );
        if (mappingDiagnostics.length > 0)
          return { state: "payout_unverified", diagnostics: mappingDiagnostics };
        const inspection = inspectPayment(receipt.logs, {
          its,
          token: destinationToken,
          tokenManager,
          commandId: execution.commandId,
          tokenId,
          sourceChain: sourceName,
          sourceAddress: stringToHex(text(stored, "sender")),
          recipient,
          amount,
        });
        if (!inspection.payment)
          return { state: "payout_unverified", diagnostics: inspection.diagnostics };
        return {
          at: {
            chainKey: transfer.destinationChain,
            block: receipt.blockNumber,
            txHash: receipt.transactionHash,
            logIndex: inspection.payment.logIndex,
            observedAt: new Date(Number(block.timestamp) * 1000),
          },
          row: {
            sourceTransferId: transfer.transferId,
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
          evidence: {
            sourceBinding: {
              chain: text(stored, "origin_chain"),
              router: text(stored, "origin_router"),
              nonce: bigintOf(stored, "nonce").toString(),
              transaction: text(stored, "origin_tx"),
              sender: text(stored, "sender"),
              token,
              amount: amount.toString(),
              destinationChain: text(stored, "destination_chain"),
              destination: text(stored, "destination"),
            },
            transferId: transfer.transferId,
            destinationChain: transfer.destinationChain,
            commandId: execution.commandId,
            executionTxHash: receipt.transactionHash,
            receiptBlock: receipt.blockNumber,
            receiptBlockHash: receipt.blockHash,
            itsAddress: its,
            tokenId,
            registeredToken: destinationToken,
            tokenManager,
            tokenManagerBlock: receipt.blockNumber,
            tokenManagerBlockHash: block.hash,
            paymentLogIndex: inspection.payment.logIndex,
            paymentRecipient: recipient,
            paymentAmount: amount,
          },
        };
      },
      {
        ...options,
        chain: transfer.destinationChain,
      },
    );
  } catch (error) {
    if (error instanceof DestinationVerificationRpcError)
      return { state: "receipt_unavailable", diagnostics: [] };
    throw error;
  }
}
