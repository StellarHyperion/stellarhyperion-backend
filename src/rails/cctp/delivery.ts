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
import { createPublicClient, http, keccak256, type Hex } from "viem";
import type { AppConfig } from "../../config/config.js";
import type { Queryable, Transactional } from "../../db/pool.js";
import { bigintOf, bigintOrNull, integer, text, textOrNull } from "../../db/rows.js";
import type { PendingTransfer, RailReport } from "../types.js";
import type { VerifiedDelivery } from "../axelar/delivery.js";
import type { DeliveryLog } from "../axelar/events.js";
import {
  inspectCctpMessageVersion,
  matchesSourceBurnIntent,
  matchingCctpPayment,
  verifiedCctpMessage,
  verifyCctpReplacementEquivalence,
  type CctpAttestationTier,
  type CctpReplacementEquivalenceStatus,
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

export interface StoredCctpMessageVersion {
  readonly id: bigint;
  readonly transferId: bigint;
  readonly versionOrdinal: number;
  readonly fullNonce: string;
  readonly messageDigest: string;
  readonly bodyDigest: string;
  readonly providerReference: string | null;
  readonly providerStatus: string;
  readonly attestationTier: CctpAttestationTier;
  readonly expirationBlock: bigint | null;
  readonly maxFee: bigint | null;
  readonly feeExecuted: bigint | null;
  readonly rawMessageBytes: string;
  readonly attestationSignature: string | null;
  readonly forwardTxHash: string | null;
  readonly lifecycleState: "active" | "expired" | "superseded" | "rejected" | "settled";
  readonly replacesDigest: string | null;
  readonly supersededByDigest: string | null;
  readonly equivalenceStatus: CctpReplacementEquivalenceStatus;
  readonly equivalenceReason: string | null;
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

export async function listCctpMessageVersions(
  db: Queryable,
  transferId: bigint,
): Promise<readonly StoredCctpMessageVersion[]> {
  const { rows } = await db.query(
    `SELECT id, transfer_id, version_ordinal, full_nonce, message_digest, body_digest,
            provider_reference, provider_status, attestation_tier, expiration_block,
            max_fee, fee_executed, raw_message_bytes, attestation_signature, forward_tx_hash,
            lifecycle_state, replaces_digest, superseded_by_digest, equivalence_status,
            equivalence_reason
       FROM cctp_message_version
      WHERE transfer_id = $1
      ORDER BY version_ordinal ASC`,
    [transferId.toString()],
  );
  return rows.map((row) => ({
    id: bigintOf(row, "id"),
    transferId: bigintOf(row, "transfer_id"),
    versionOrdinal: integer(row, "version_ordinal"),
    fullNonce: text(row, "full_nonce"),
    messageDigest: text(row, "message_digest"),
    bodyDigest: text(row, "body_digest"),
    providerReference: textOrNull(row, "provider_reference"),
    providerStatus: text(row, "provider_status"),
    attestationTier: text(row, "attestation_tier") as CctpAttestationTier,
    expirationBlock: bigintOrNull(row, "expiration_block"),
    maxFee: bigintOrNull(row, "max_fee"),
    feeExecuted: bigintOrNull(row, "fee_executed"),
    rawMessageBytes: text(row, "raw_message_bytes"),
    attestationSignature: textOrNull(row, "attestation_signature"),
    forwardTxHash: textOrNull(row, "forward_tx_hash"),
    lifecycleState: text(row, "lifecycle_state") as StoredCctpMessageVersion["lifecycleState"],
    replacesDigest: textOrNull(row, "replaces_digest"),
    supersededByDigest: textOrNull(row, "superseded_by_digest"),
    equivalenceStatus: text(row, "equivalence_status") as CctpReplacementEquivalenceStatus,
    equivalenceReason: textOrNull(row, "equivalence_reason"),
  }));
}

interface CandidateIngestionOutcome {
  readonly accepted: {
    readonly candidate: RailReport;
    readonly raw: Hex;
    readonly messageDigest: Hex;
  } | null;
  readonly hasRejectedReplacement: boolean;
}

async function ingestCandidateVersions(
  tx: Queryable,
  transferId: bigint,
  candidates: readonly RailReport[],
  expected: ExpectedCctpTransfer,
): Promise<CandidateIngestionOutcome> {
  let existing = await listCctpMessageVersions(tx, transferId);
  let originalVersion = existing.find((v) => v.equivalenceStatus === "original") ?? null;
  let hasRejectedReplacement = existing.some((v) => v.lifecycleState === "rejected");
  let latestAccepted: CandidateIngestionOutcome["accepted"] = null;

  for (const candidate of candidates) {
    const rawStr = candidate.messageBytes ?? candidate.message ?? null;
    if (typeof rawStr !== "string" || !/^0x[0-9a-fA-F]+$/.test(rawStr)) continue;
    const raw = rawStr.toLowerCase() as Hex;
    const attSig = candidate.attestationSignature ?? candidate.attestation ?? null;
    const inspected = inspectCctpMessageVersion(raw, Boolean(attSig));

    const fallbackDigest = keccak256(raw);
    const messageDigest = inspected?.messageDigest ?? fallbackDigest;
    const bodyDigest = inspected?.bodyDigest ?? fallbackDigest;
    const fullNonce: Hex = inspected?.fullNonce ?? `0x${"0".repeat(64)}`;
    const tier: CctpAttestationTier = inspected?.tier ?? "unsupported";

    let equivalenceStatus: CctpReplacementEquivalenceStatus;
    let equivalenceReason: string | null = null;
    let lifecycleState: StoredCctpMessageVersion["lifecycleState"];
    let replacesDigest: string | null = null;

    if (!inspected) {
      equivalenceStatus = "unsupported_semantics";
      equivalenceReason = "malformed_message_bytes";
      lifecycleState = "rejected";
      hasRejectedReplacement = true;
    } else if (originalVersion === null) {
      const intent = matchesSourceBurnIntent(inspected, expected);
      if (!intent.ok) {
        equivalenceStatus = intent.status;
        equivalenceReason = intent.reason;
        lifecycleState = "rejected";
        hasRejectedReplacement = true;
      } else {
        equivalenceStatus = "original";
        lifecycleState = candidate.status === "expired" ? "expired" : "active";
      }
    } else if (originalVersion.messageDigest === messageDigest) {
      equivalenceStatus = "original";
      lifecycleState =
        originalVersion.lifecycleState === "settled"
          ? "settled"
          : originalVersion.lifecycleState === "superseded"
            ? "superseded"
            : candidate.status === "expired"
              ? "expired"
              : "active";
    } else {
      const eq = verifyCctpReplacementEquivalence(
        originalVersion.rawMessageBytes as Hex,
        raw,
        expected,
      );
      replacesDigest = originalVersion.messageDigest;
      equivalenceStatus = eq.status;
      equivalenceReason = eq.reason;
      if (!eq.ok) {
        lifecycleState = "rejected";
        hasRejectedReplacement = true;
      } else {
        lifecycleState = candidate.status === "expired" ? "expired" : "active";
      }
    }

    const nextOrdinal = existing.length + 1;
    await tx.query(
      `INSERT INTO cctp_message_version
         (transfer_id, version_ordinal, full_nonce, message_digest, body_digest,
          provider_reference, provider_status, attestation_tier, expiration_block,
          max_fee, fee_executed, raw_message_bytes, attestation_signature,
          forward_tx_hash, lifecycle_state, replaces_digest, equivalence_status,
          equivalence_reason, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, now())
       ON CONFLICT (transfer_id, message_digest) DO UPDATE
         SET provider_reference = COALESCE(EXCLUDED.provider_reference, cctp_message_version.provider_reference),
             provider_status = EXCLUDED.provider_status,
             attestation_signature = COALESCE(EXCLUDED.attestation_signature, cctp_message_version.attestation_signature),
             forward_tx_hash = COALESCE(EXCLUDED.forward_tx_hash, cctp_message_version.forward_tx_hash),
             lifecycle_state = CASE
               WHEN cctp_message_version.lifecycle_state IN ('settled', 'superseded', 'rejected')
                 THEN cctp_message_version.lifecycle_state
               WHEN cctp_message_version.lifecycle_state = 'expired' AND EXCLUDED.lifecycle_state = 'active'
                 THEN 'expired'
               ELSE EXCLUDED.lifecycle_state
             END,
             updated_at = now()`,
      [
        transferId.toString(),
        nextOrdinal,
        fullNonce,
        messageDigest,
        bodyDigest,
        candidate.reference,
        candidate.railStatus || candidate.status,
        tier,
        inspected ? inspected.burn.expirationBlock.toString() : null,
        inspected ? inspected.burn.maxFee.toString() : null,
        inspected ? inspected.burn.feeExecuted.toString() : null,
        raw,
        attSig,
        candidate.forwardTxHash ? candidate.forwardTxHash.toLowerCase() : null,
        lifecycleState,
        replacesDigest,
        equivalenceStatus,
        equivalenceReason,
      ],
    );

    if (equivalenceStatus === "equivalent_replacement" && replacesDigest !== null) {
      // Preserve expired status on expired originals while recording superseded_by_digest!
      await tx.query(
        `UPDATE cctp_message_version
            SET superseded_by_digest = $3,
                lifecycle_state = CASE
                  WHEN lifecycle_state = 'expired' THEN 'expired'
                  WHEN lifecycle_state = 'active' THEN 'superseded'
                  ELSE lifecycle_state
                END,
                updated_at = now()
          WHERE transfer_id = $1
            AND message_digest = $2`,
        [transferId.toString(), replacesDigest, messageDigest],
      );
    }

    existing = await listCctpMessageVersions(tx, transferId);
    originalVersion = existing.find((v) => v.equivalenceStatus === "original") ?? null;

    if (
      (equivalenceStatus === "original" || equivalenceStatus === "equivalent_replacement") &&
      lifecycleState !== "expired" &&
      lifecycleState !== "rejected"
    ) {
      latestAccepted = { candidate, raw, messageDigest };
    }
  }

  return { accepted: latestAccepted, hasRejectedReplacement };
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

  const candidates =
    report.versionCandidates && report.versionCandidates.length > 0
      ? report.versionCandidates
      : [report];

  let ingestion: CandidateIngestionOutcome | null = null;
  try {
    ingestion = await db.transaction((tx) =>
      ingestCandidateVersions(tx, transfer.transferId, candidates, expected),
    );
  } catch {
    ingestion = null;
  }

  // If any replacement had unsupported semantics or mutated intent, refuse automatic resolution!
  if (ingestion?.hasRejectedReplacement) {
    return null;
  }

  const activeRawStr = ingestion?.accepted?.raw ?? report.messageBytes ?? null;
  const forwardTxHash = ingestion?.accepted?.candidate.forwardTxHash ?? report.forwardTxHash;
  if (
    !forwardTxHash ||
    typeof activeRawStr !== "string" ||
    !/^0x[0-9a-fA-F]+$/.test(activeRawStr)
  ) {
    return null;
  }

  const raw = activeRawStr as Hex;
  const message = verifiedCctpMessage(raw, expected);
  if (!message) return null;

  const client = options?.evmClient ?? createDefaultEvmClient(destination.defaultRpcUrl);
  if ((await client.getChainId()) !== destination.chainId) {
    throw new Error("CCTP destination RPC chain mismatch.");
  }
  const receipt = await client.getTransactionReceipt({ hash: forwardTxHash });
  if (receipt.status !== "success") return null;
  const head = await client.getBlockNumber();
  if (head - receipt.blockNumber + 1n < BigInt(destination.confirmations)) return null;
  const payment = matchingCctpPayment(receipt.logs, raw, expected);
  if (!payment) return null;
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) return null;

  if (ingestion?.accepted) {
    await db
      .transaction((tx) =>
        tx.query(
          `UPDATE cctp_message_version
              SET lifecycle_state = 'settled',
                  forward_tx_hash = $3,
                  updated_at = now()
            WHERE transfer_id = $1
              AND message_digest = $2`,
          [
            transfer.transferId.toString(),
            ingestion.accepted?.messageDigest ?? "",
            receipt.transactionHash.toLowerCase(),
          ],
        ),
      )
      .catch(() => undefined);
  }

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
