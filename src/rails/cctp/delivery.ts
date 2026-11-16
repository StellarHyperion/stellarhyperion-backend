import {
  CHAINS,
  RAIL_CONTRACTS,
  RouteKind,
  assetOn,
  isChainKey,
  isEvmChain,
  isStellarDeployment,
  toEvmAddress,
} from "@hyperion/protocol";
import { createPublicClient, http, type Hex } from "viem";
import type { AppConfig } from "../../config/config.js";
import type { Queryable, Transactional } from "../../db/pool.js";
import { bigintOf, bigintOrNull, integer, text, textOrNull } from "../../db/rows.js";
import type { CctpFullIdentitySummary, PendingTransfer, RailReport } from "../types.js";
import type { VerifiedDelivery } from "../axelar/delivery.js";
import type { DeliveryLog } from "../axelar/events.js";
import {
  deriveCctpMessageIdentity,
  matchingCctpPayment,
  verifiedCctpMessage,
  type ExpectedCctpTransfer,
} from "./events.js";
import { deduplicateReportsByFullIdentity } from "./iris.js";

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

export interface StoredCctpProviderMessage {
  readonly id: bigint;
  readonly originTx: string;
  readonly sourceDomain: number;
  readonly destinationDomain: number;
  readonly fullNonce: string;
  readonly messageDigest: string;
  readonly bodyDigest: string;
  readonly displayedNonce: string;
  readonly providerEventNonce: string | null;
  readonly forwardTxHash: string | null;
  readonly status: string;
  readonly transferId: bigint | null;
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

export async function recordCctpProviderMessage(
  db: Queryable,
  entry: {
    readonly originTx: string;
    readonly identity: CctpFullIdentitySummary;
    readonly providerEventNonce: string | null;
    readonly forwardTxHash: string | null;
    readonly status: string;
    readonly transferId: bigint | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO cctp_provider_message
       (origin_tx, source_domain, destination_domain, full_nonce, message_digest, body_digest,
        displayed_nonce, provider_event_nonce, forward_tx_hash, status, transfer_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
     ON CONFLICT (source_domain, destination_domain, full_nonce, message_digest) DO UPDATE
       SET provider_event_nonce = COALESCE(EXCLUDED.provider_event_nonce, cctp_provider_message.provider_event_nonce),
           forward_tx_hash = COALESCE(EXCLUDED.forward_tx_hash, cctp_provider_message.forward_tx_hash),
           status = CASE
             WHEN cctp_provider_message.status = 'delivered' THEN 'delivered'
             WHEN EXCLUDED.status = 'delivered' THEN 'delivered'
             WHEN cctp_provider_message.status = 'attested' OR EXCLUDED.status = 'attested' THEN 'attested'
             ELSE EXCLUDED.status
           END,
           transfer_id = COALESCE(cctp_provider_message.transfer_id, EXCLUDED.transfer_id),
           updated_at = now()`,
    [
      entry.originTx,
      entry.identity.sourceDomain,
      entry.identity.destinationDomain,
      entry.identity.fullNonce.toLowerCase(),
      entry.identity.messageDigest.toLowerCase(),
      entry.identity.bodyDigest.toLowerCase(),
      entry.identity.displayedNonce,
      entry.providerEventNonce,
      entry.forwardTxHash ? entry.forwardTxHash.toLowerCase() : null,
      entry.status,
      entry.transferId === null ? null : entry.transferId.toString(),
    ],
  );
}

export async function listCctpProviderMessagesByOriginTx(
  db: Queryable,
  originTx: string,
): Promise<readonly StoredCctpProviderMessage[]> {
  const { rows } = await db.query(
    `SELECT id, origin_tx, source_domain, destination_domain, full_nonce, message_digest,
            body_digest, displayed_nonce, provider_event_nonce, forward_tx_hash, status,
            transfer_id
       FROM cctp_provider_message
      WHERE origin_tx = $1
      ORDER BY id ASC`,
    [originTx],
  );

  return rows.map((row) => ({
    id: bigintOf(row, "id"),
    originTx: text(row, "origin_tx"),
    sourceDomain: integer(row, "source_domain"),
    destinationDomain: integer(row, "destination_domain"),
    fullNonce: text(row, "full_nonce"),
    messageDigest: text(row, "message_digest"),
    bodyDigest: text(row, "body_digest"),
    displayedNonce: bigintOf(row, "displayed_nonce").toString(),
    providerEventNonce: textOrNull(row, "provider_event_nonce"),
    forwardTxHash: textOrNull(row, "forward_tx_hash"),
    status: text(row, "status"),
    transferId: bigintOrNull(row, "transfer_id"),
  }));
}

export async function verifyCctpDelivery(
  config: AppConfig,
  db: Transactional,
  transfer: PendingTransfer,
  report: RailReport,
  options?: VerifyCctpDeliveryOptions,
): Promise<VerifiedDelivery | null> {
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
    "SELECT token, net_amount, destination FROM outbound_transfer WHERE id = $1",
    [String(transfer.transferId)],
  );
  const stored = rows[0];
  if (!stored || text(stored, "token") !== sourceToken.sacId) return null;

  const expected: ExpectedCctpTransfer = {
    sourceToken: sourceToken.sacId,
    sourceAdapter: adapter,
    sourceMessenger: STELLAR_CCTP_MESSENGER,
    destinationDomain: destination.cctpDomain,
    destinationMessenger: contracts.tokenMessengerV2,
    transmitter: contracts.messageTransmitterV2,
    token: token.address,
    recipient: toEvmAddress(text(stored, "destination") as Hex),
    sourceAmount: bigintOf(stored, "net_amount"),
  };

  const candidates = deduplicateReportsByFullIdentity(
    report.candidates && report.candidates.length > 0 ? report.candidates : [report],
  );

  const matchedCandidates: {
    readonly candidate: RailReport;
    readonly raw: Hex;
    readonly verified: NonNullable<ReturnType<typeof verifiedCctpMessage>>;
  }[] = [];

  for (const candidate of candidates) {
    const rawStr = candidate.messageBytes ?? candidate.message ?? null;
    if (typeof rawStr !== "string" || !/^0x[0-9a-fA-F]+$/.test(rawStr)) continue;
    const raw = rawStr as Hex;
    const identity = candidate.messageIdentity ?? deriveCctpMessageIdentity(raw);
    const verified = verifiedCctpMessage(raw, expected);

    if (identity) {
      await db
        .transaction((tx) =>
          recordCctpProviderMessage(tx, {
            originTx: transfer.originTx,
            identity,
            providerEventNonce: candidate.reference,
            forwardTxHash: candidate.forwardTxHash ?? null,
            status: candidate.status,
            // Only bind transfer_id when ALL burn bindings match!
            transferId: verified ? transfer.transferId : null,
          }),
        )
        .catch(() => undefined);
    }

    if (verified) {
      matchedCandidates.push({ candidate, raw, verified });
    }
  }

  if (matchedCandidates.length !== 1) {
    return null;
  }
  const matched = matchedCandidates[0];
  if (!matched?.candidate.forwardTxHash) {
    return null;
  }
  const forwardTxHash = matched.candidate.forwardTxHash;

  // Guard against conflicting digest on the same full_nonce in stored provider history
  const { rows: digestConflicts } = await db
    .query(
      `SELECT message_digest
         FROM cctp_provider_message
        WHERE source_domain = $1
          AND destination_domain = $2
          AND full_nonce = $3`,
      [
        matched.verified.identity.sourceDomain,
        matched.verified.identity.destinationDomain,
        matched.verified.identity.fullNonce,
      ],
    )
    .catch(() => ({ rows: [] as readonly Record<string, unknown>[] }));
  if (
    digestConflicts.some(
      (r) => text(r, "message_digest") !== matched.verified.identity.messageDigest.toLowerCase(),
    )
  ) {
    return null;
  }

  const client = options?.evmClient ?? createDefaultEvmClient(destination.defaultRpcUrl);
  if ((await client.getChainId()) !== destination.chainId) {
    throw new Error("CCTP destination RPC chain mismatch.");
  }
  const receipt = await client.getTransactionReceipt({ hash: forwardTxHash });
  if (receipt.status !== "success") return null;
  const head = await client.getBlockNumber();
  if (head - receipt.blockNumber + 1n < BigInt(destination.confirmations)) return null;
  const payment = matchingCctpPayment(receipt.logs, matched.raw, expected);
  if (!payment) return null;
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) return null;

  await db
    .transaction((tx) =>
      recordCctpProviderMessage(tx, {
        originTx: transfer.originTx,
        identity: matched.verified.identity,
        providerEventNonce: matched.candidate.reference,
        forwardTxHash: receipt.transactionHash,
        status: "delivered",
        transferId: transfer.transferId,
      }),
    )
    .catch(() => undefined);

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
      railMessageId: matched.verified.identity.fullNonce,
      recipient: expected.recipient.toLowerCase(),
      token: token.address.toLowerCase(),
      amount: matched.verified.amount,
      delivered: true,
      claimId: null,
    },
  };
}
