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
import { createPublicClient, http, stringToHex } from "viem";
import type { AppConfig } from "../../config/config.js";
import type { Transactional } from "../../db/pool.js";
import { bigintOf, text, textOrNull } from "../../db/rows.js";
import type { InboundRow, Position } from "../../chains/writers.js";
import type { PendingTransfer, RailExecutionCandidate, RailReport } from "../types.js";

import { ITS_ABI, matchItsCandidateInReceipt } from "./events.js";
export {
  matchItsCandidateInReceipt,
  matchingPayment,
  type CandidateReceiptMatch,
} from "./events.js";

export interface VerifiedDelivery {
  readonly at: Position;
  readonly row: InboundRow;
}

function resolveReportCandidates(
  report: RailReport,
  railRef: string | null,
): readonly RailExecutionCandidate[] | null {
  const rawList: readonly RailExecutionCandidate[] =
    report.executions ?? (report.execution ? [report.execution] : []);
  if (rawList.length === 0) {
    return [];
  }

  const txByCmd = new Map<string, string>();
  const deduped = new Map<string, RailExecutionCandidate>();
  for (const item of rawList) {
    const cmdKey = item.commandId.toLowerCase();
    const txKey = item.txHash.toLowerCase();
    const prevTx = txByCmd.get(cmdKey);
    if (prevTx !== undefined && prevTx !== txKey) {
      // Conflicting destination receipts reported for the same commandId remain unverified.
      return null;
    }
    txByCmd.set(cmdKey, txKey);
    const pairKey = `${cmdKey}:${txKey}`;
    if (!deduped.has(pairKey)) {
      deduped.set(pairKey, item);
    }
  }

  const all = [...deduped.values()].sort((a, b) =>
    a.commandId.toLowerCase().localeCompare(b.commandId.toLowerCase()),
  );

  if (railRef !== null && railRef.trim().length > 0) {
    const refNorm = railRef.trim().toLowerCase();
    const pinned = all.filter(
      (item) =>
        item.commandId.toLowerCase() === refNorm || item.reference?.toLowerCase() === refNorm,
    );
    if (pinned.length === 1) {
      return pinned;
    }
  }

  return all;
}

// The rail API supplies a candidate receipt. Only matching confirmed chain events establish delivery.
export async function verifyItsDelivery(
  config: AppConfig,
  db: Transactional,
  transfer: PendingTransfer,
  report: RailReport,
): Promise<VerifiedDelivery | null> {
  const source = config.indexer.stellar;
  if (
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
    "SELECT sender, token, net_amount, destination, rail_ref FROM outbound_transfer WHERE id = $1",
    [String(transfer.transferId)],
  );
  const stored = rows[0];
  if (!stored) return null;
  const candidates = resolveReportCandidates(report, textOrNull(stored, "rail_ref"));
  if (!candidates || candidates.length === 0) return null;

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

  const adapterConfig = (await view(adapter, "get_config")) as { its?: string };
  if (!adapterConfig.its) return null;
  const sourceName = await view(adapterConfig.its, "chain_name");
  if (typeof sourceName !== "string") return null;

  const destinationToken = await client.readContract({
    address: its as `0x${string}`,
    abi: ITS_ABI,
    functionName: "registeredTokenAddress",
    args: [tokenId],
  });

  const head = await client.getBlockNumber();
  const receiptCache = new Map<string, Awaited<ReturnType<typeof client.getTransactionReceipt>>>();
  const blockCache = new Map<bigint, Awaited<ReturnType<typeof client.getBlock>>>();

  const verifiedMatches: VerifiedDelivery[] = [];
  const senderHex = stringToHex(text(stored, "sender"));

  for (const execution of candidates) {
    const txKey = execution.txHash.toLowerCase();
    let receipt = receiptCache.get(txKey);
    if (!receipt) {
      receipt = await client.getTransactionReceipt({ hash: execution.txHash });
      receiptCache.set(txKey, receipt);
    }
    if (receipt.status !== "success") continue;
    if (head - receipt.blockNumber + 1n < BigInt(destination.confirmations)) continue;

    const match = matchItsCandidateInReceipt(receipt.logs, {
      its,
      token: destinationToken,
      commandId: execution.commandId,
      tokenId,
      sourceChain: sourceName,
      sourceAddress: senderHex,
      recipient,
      amount,
    });
    if (match.status === "conflicting" || match.status === "ambiguous") {
      return null;
    }
    if (match.status !== "matched") continue;

    let block = blockCache.get(receipt.blockNumber);
    if (!block) {
      block = await client.getBlock({ blockNumber: receipt.blockNumber });
      blockCache.set(receipt.blockNumber, block);
    }
    if (block.hash !== receipt.blockHash) continue;

    verifiedMatches.push({
      at: {
        chainKey: transfer.destinationChain,
        block: receipt.blockNumber,
        txHash: receipt.transactionHash,
        logIndex: match.paymentLog.logIndex,
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
    });
  }

  // Multiple distinct candidate commands matching the same transfer cannot be disambiguated safely.
  if (verifiedMatches.length !== 1) {
    return null;
  }
  return verifiedMatches[0] ?? null;
}
