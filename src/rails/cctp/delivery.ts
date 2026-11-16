import {
  CHAINS,
  RAIL_CONTRACTS,
  RouteKind,
  assetOn,
  isChainKey,
  isEvmChain,
  isStellarDeployment,
  toEvmAddress,
  txUrl,
} from "@hyperion/protocol";
import { createPublicClient, http, type Hex } from "viem";
import type { AppConfig } from "../../config/config.js";
import type { Queryable, Transactional } from "../../db/pool.js";
import {
  bigintOf,
  bigintOrNull,
  boolean,
  integer,
  integerOrNull,
  text,
  textOrNull,
} from "../../db/rows.js";
import type { PendingTransfer, RailReport } from "../types.js";
import type { VerifiedDelivery } from "../axelar/delivery.js";
import type { DeliveryLog } from "../axelar/events.js";
import {
  matchCctpReceiptLogs,
  verifiedCctpMessage,
  type CctpCheckName,
  type CctpEvidenceCheck,
  type ExpectedCctpTransfer,
  type VerifiedCctpMessageDetail,
} from "./events.js";
import { domainFor, sanitizeBoundedPublicRef } from "./iris.js";

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

export interface CctpPublicDeliveryEvidence {
  readonly transferId: string;
  readonly route: number;
  readonly verified: boolean;
  readonly status: "delivered" | "pending" | "failed";
  readonly origin: {
    readonly chain: string;
    readonly nonce: string;
    readonly blockNumber: string;
    readonly txHash: string | null;
    readonly explorerUrl: string | null;
    readonly sourceToken: string | null;
    readonly burnedAmount: string;
  };
  readonly messageIdentity: {
    readonly nonce: string | null;
    readonly messageHash: string | null;
    readonly bodyHash: string | null;
    readonly sourceDomain: number | null;
    readonly destinationDomain: number | null;
    readonly finalityThresholdExecuted: number | null;
    readonly railReference: string | null;
  };
  readonly destination: {
    readonly chain: string;
    readonly recipient: string | null;
    readonly token: string | null;
    readonly forwardTxHash: string | null;
    readonly canonicalTxHash: string | null;
    readonly canonicalBlockNumber: string | null;
    readonly canonicalBlockHash: string | null;
    readonly explorerUrl: string | null;
    readonly messageLogIndex: number | null;
    readonly mintLogIndex: number | null;
    readonly mintedAmount: string | null;
    readonly feeExecuted: string | null;
  };
  readonly checks: readonly CctpEvidenceCheck[];
  readonly missingChecks: readonly CctpCheckName[];
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

export async function upsertCctpDeliveryEvidence(
  db: Queryable,
  entry: {
    readonly transferId: bigint;
    readonly verified: VerifiedCctpMessageDetail;
    readonly burnedAmount: bigint;
    readonly forwardTxHash: string | null;
    readonly canonicalTxHash: string | null;
    readonly canonicalBlockNumber: bigint | null;
    readonly canonicalBlockHash: string | null;
    readonly messageLogIndex: number | null;
    readonly mintLogIndex: number | null;
    readonly mintedAmount: bigint | null;
    readonly attestationPresent: boolean;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO cctp_delivery_evidence
       (transfer_id, message_nonce, message_hash, body_hash, source_domain, destination_domain,
        finality_threshold_executed, forward_tx_hash, canonical_tx_hash, canonical_block_number,
        canonical_block_hash, message_log_index, mint_log_index, burned_amount, minted_amount,
        fee_executed, attestation_present, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, now())
     ON CONFLICT (transfer_id) DO UPDATE
       SET message_nonce = COALESCE(EXCLUDED.message_nonce, cctp_delivery_evidence.message_nonce),
           message_hash = COALESCE(EXCLUDED.message_hash, cctp_delivery_evidence.message_hash),
           body_hash = COALESCE(EXCLUDED.body_hash, cctp_delivery_evidence.body_hash),
           source_domain = COALESCE(EXCLUDED.source_domain, cctp_delivery_evidence.source_domain),
           destination_domain = COALESCE(EXCLUDED.destination_domain, cctp_delivery_evidence.destination_domain),
           finality_threshold_executed = COALESCE(EXCLUDED.finality_threshold_executed, cctp_delivery_evidence.finality_threshold_executed),
           forward_tx_hash = COALESCE(EXCLUDED.forward_tx_hash, cctp_delivery_evidence.forward_tx_hash),
           canonical_tx_hash = COALESCE(EXCLUDED.canonical_tx_hash, cctp_delivery_evidence.canonical_tx_hash),
           canonical_block_number = COALESCE(EXCLUDED.canonical_block_number, cctp_delivery_evidence.canonical_block_number),
           canonical_block_hash = COALESCE(EXCLUDED.canonical_block_hash, cctp_delivery_evidence.canonical_block_hash),
           message_log_index = COALESCE(EXCLUDED.message_log_index, cctp_delivery_evidence.message_log_index),
           mint_log_index = COALESCE(EXCLUDED.mint_log_index, cctp_delivery_evidence.mint_log_index),
           burned_amount = COALESCE(EXCLUDED.burned_amount, cctp_delivery_evidence.burned_amount),
           minted_amount = COALESCE(EXCLUDED.minted_amount, cctp_delivery_evidence.minted_amount),
           fee_executed = COALESCE(EXCLUDED.fee_executed, cctp_delivery_evidence.fee_executed),
           attestation_present = cctp_delivery_evidence.attestation_present OR EXCLUDED.attestation_present,
           updated_at = now()`,
    [
      entry.transferId.toString(),
      sanitizeBoundedPublicRef(entry.verified.message.nonce),
      sanitizeBoundedPublicRef(entry.verified.messageHash),
      sanitizeBoundedPublicRef(entry.verified.bodyHash),
      entry.verified.message.sourceDomain,
      entry.verified.message.destinationDomain,
      entry.verified.message.finalityThresholdExecuted,
      sanitizeBoundedPublicRef(entry.forwardTxHash),
      sanitizeBoundedPublicRef(entry.canonicalTxHash),
      entry.canonicalBlockNumber === null ? null : entry.canonicalBlockNumber.toString(),
      sanitizeBoundedPublicRef(entry.canonicalBlockHash),
      entry.messageLogIndex,
      entry.mintLogIndex,
      entry.burnedAmount.toString(),
      entry.mintedAmount === null ? null : entry.mintedAmount.toString(),
      entry.verified.burn.feeExecuted.toString(),
      entry.attestationPresent,
    ],
  );
}

const EVIDENCE_SELECT = `
  SELECT t.id,
         t.origin_chain,
         t.route,
         t.nonce,
         t.token AS source_token,
         t.net_amount,
         t.destination_chain,
         t.destination,
         t.origin_block,
         t.origin_tx,
         a.status AS attestation_status,
         a.rail_reference,
         d.delivered AS inbound_delivered,
         d.rail_message_id,
         d.token AS received_token,
         d.amount AS received_amount,
         d.destination_block,
         d.destination_tx,
         d.destination_log_index,
         e.message_nonce,
         e.message_hash,
         e.body_hash,
         e.source_domain,
         e.destination_domain,
         e.finality_threshold_executed,
         e.forward_tx_hash,
         e.canonical_tx_hash,
         e.canonical_block_number,
         e.canonical_block_hash,
         e.message_log_index,
         e.mint_log_index,
         e.minted_amount,
         e.fee_executed,
         e.attestation_present
    FROM outbound_transfer t
    LEFT JOIN rail_attestation a ON a.transfer_id = t.id
    LEFT JOIN inbound_delivery d
      ON d.destination_chain = t.destination_chain
     AND d.route = t.route
     AND d.source_chain = t.origin_chain
     AND d.source_nonce = t.nonce
    LEFT JOIN cctp_delivery_evidence e ON e.transfer_id = t.id
`;

function safeDomainOrNull(chainKey: string): number | null {
  try {
    return domainFor(chainKey);
  } catch {
    return null;
  }
}

function formatEvidenceRow(row: Record<string, unknown>): CctpPublicDeliveryEvidence {
  const originChain = text(row, "origin_chain");
  const destinationChain = text(row, "destination_chain");
  const originTxHash = sanitizeBoundedPublicRef(textOrNull(row, "origin_tx"));
  const destinationWord = text(row, "destination");
  const formattedRecipient =
    isChainKey(destinationChain) &&
    isEvmChain(CHAINS[destinationChain]) &&
    /^0x[0-9a-fA-F]{64}$/.test(destinationWord)
      ? toEvmAddress(destinationWord as Hex).toLowerCase()
      : sanitizeBoundedPublicRef(destinationWord);

  const inboundDelivered = row.inbound_delivered === true;
  const attestationStatus = textOrNull(row, "attestation_status");
  const attestationPresent =
    (row.attestation_present === true ? boolean(row, "attestation_present") : false) ||
    attestationStatus === "attested" ||
    attestationStatus === "delivered" ||
    inboundDelivered;
  const terminalFailed = attestationStatus === "failed" || attestationStatus === "expired";

  const messageNonce = sanitizeBoundedPublicRef(
    textOrNull(row, "message_nonce") ?? textOrNull(row, "rail_message_id"),
  );
  const messageHash = sanitizeBoundedPublicRef(textOrNull(row, "message_hash"));
  const bodyHash = sanitizeBoundedPublicRef(textOrNull(row, "body_hash"));
  const railReference = sanitizeBoundedPublicRef(textOrNull(row, "rail_reference"));

  const canonicalTxHash = sanitizeBoundedPublicRef(
    textOrNull(row, "canonical_tx_hash") ??
      (inboundDelivered ? textOrNull(row, "destination_tx") : null),
  );
  const forwardTxHash = sanitizeBoundedPublicRef(
    textOrNull(row, "forward_tx_hash") ?? canonicalTxHash,
  );
  const canonicalBlock =
    bigintOrNull(row, "canonical_block_number") ??
    (inboundDelivered ? bigintOrNull(row, "destination_block") : null);
  const canonicalBlockHash = sanitizeBoundedPublicRef(textOrNull(row, "canonical_block_hash"));
  const messageLogIndex = integerOrNull(row, "message_log_index");
  const mintLogIndex =
    integerOrNull(row, "mint_log_index") ??
    (inboundDelivered ? integerOrNull(row, "destination_log_index") : null);
  const mintedAmount =
    bigintOrNull(row, "minted_amount") ??
    (inboundDelivered ? bigintOrNull(row, "received_amount") : null);
  const feeExecuted = bigintOrNull(row, "fee_executed");

  const expectedDestAsset = isChainKey(destinationChain) ? assetOn(destinationChain, "USDC") : null;
  const destinationToken = sanitizeBoundedPublicRef(
    textOrNull(row, "received_token") ??
      (expectedDestAsset?.family === "evm" ? expectedDestAsset.address : null),
  );

  const hasMessageIntegrity = messageNonce !== null && (messageHash !== null || inboundDelivered);
  const hasForwardCandidate = forwardTxHash !== null;
  const hasCanonicalReceipt = canonicalTxHash !== null && canonicalBlock !== null;
  const hasNativeUsdcMint = inboundDelivered && mintedAmount !== null && destinationToken !== null;

  const checks: readonly CctpEvidenceCheck[] = [
    {
      name: "source_burn_indexed",
      state: originTxHash !== null ? "passed" : "missing",
      detail:
        originTxHash !== null
          ? "Source burn event indexed on origin chain"
          : "Source burn transaction hash missing",
    },
    {
      name: "circle_attestation",
      state: attestationPresent ? "passed" : terminalFailed ? "failed" : "missing",
      detail: attestationPresent
        ? "Circle attestation observed for source transaction"
        : terminalFailed
          ? "Circle reported terminal failure or expiration"
          : "Awaiting finalized Circle attestation",
    },
    {
      name: "message_integrity",
      state: hasMessageIntegrity ? "passed" : "missing",
      detail: hasMessageIntegrity
        ? "Canonical CCTP v2 message bound to source burn intent"
        : "Canonical CCTP v2 message bytes not yet verified",
    },
    {
      name: "forward_tx_candidate",
      state: hasForwardCandidate ? "passed" : "missing",
      detail: hasForwardCandidate
        ? "Candidate destination forwarding transaction recorded"
        : "Awaiting destination forwarding transaction hash",
    },
    {
      name: "canonical_destination_receipt",
      state: hasCanonicalReceipt ? "passed" : "missing",
      detail: hasCanonicalReceipt
        ? "Destination transaction confirmed on canonical block"
        : "Awaiting confirmed canonical destination block receipt",
    },
    {
      name: "native_usdc_mint",
      state: hasNativeUsdcMint ? "passed" : "missing",
      detail: hasNativeUsdcMint
        ? "Exact native USDC mint event verified for recipient"
        : "Awaiting verified native USDC Transfer mint event",
    },
  ];

  const missingChecks = checks.filter((c) => c.state === "missing").map((c) => c.name);
  const verified = checks.every((c) => c.state === "passed") && inboundDelivered;

  const originExplorerUrl =
    isChainKey(originChain) && originTxHash !== null
      ? txUrl(CHAINS[originChain], originTxHash)
      : null;
  const destExplorerUrl =
    isChainKey(destinationChain) && canonicalTxHash !== null
      ? txUrl(CHAINS[destinationChain], canonicalTxHash)
      : null;

  return {
    transferId: bigintOf(row, "id").toString(),
    route: integer(row, "route"),
    verified,
    status: verified ? "delivered" : terminalFailed ? "failed" : "pending",
    origin: {
      chain: originChain,
      nonce: bigintOf(row, "nonce").toString(),
      blockNumber: bigintOf(row, "origin_block").toString(),
      txHash: originTxHash,
      explorerUrl: originExplorerUrl,
      sourceToken: sanitizeBoundedPublicRef(textOrNull(row, "source_token")),
      burnedAmount: bigintOf(row, "net_amount").toString(),
    },
    messageIdentity: {
      nonce: messageNonce,
      messageHash,
      bodyHash,
      sourceDomain: integerOrNull(row, "source_domain") ?? safeDomainOrNull(originChain),
      destinationDomain:
        integerOrNull(row, "destination_domain") ?? safeDomainOrNull(destinationChain),
      finalityThresholdExecuted: integerOrNull(row, "finality_threshold_executed"),
      railReference,
    },
    destination: {
      chain: destinationChain,
      recipient: formattedRecipient,
      token: destinationToken,
      forwardTxHash,
      canonicalTxHash,
      canonicalBlockNumber: canonicalBlock === null ? null : canonicalBlock.toString(),
      canonicalBlockHash,
      explorerUrl: destExplorerUrl,
      messageLogIndex,
      mintLogIndex,
      mintedAmount: mintedAmount === null ? null : mintedAmount.toString(),
      feeExecuted: feeExecuted === null ? null : feeExecuted.toString(),
    },
    checks,
    missingChecks,
  };
}

export async function getCctpDeliveryEvidenceById(
  db: Queryable,
  id: string,
): Promise<
  | { readonly kind: "not_found" }
  | { readonly kind: "wrong_route"; readonly route: number }
  | { readonly kind: "ok"; readonly evidence: CctpPublicDeliveryEvidence }
> {
  if (!/^\d{1,20}$/.test(id)) {
    return { kind: "not_found" };
  }
  const { rows } = await db.query(`${EVIDENCE_SELECT} WHERE t.id = $1 LIMIT 1`, [id]);
  const row = rows[0];
  if (!row) return { kind: "not_found" };
  const route = integer(row, "route");
  if (route !== RouteKind.Cctp) {
    return { kind: "wrong_route", route };
  }
  return { kind: "ok", evidence: formatEvidenceRow(row) };
}

export async function getCctpDeliveryEvidenceByOriginNonce(
  db: Queryable,
  originChain: string,
  nonce: string,
): Promise<
  | { readonly kind: "not_found" }
  | { readonly kind: "wrong_route"; readonly route: number }
  | { readonly kind: "ok"; readonly evidence: CctpPublicDeliveryEvidence }
> {
  if (!/^\d{1,20}$/.test(nonce)) {
    return { kind: "not_found" };
  }
  const { rows } = await db.query(
    `${EVIDENCE_SELECT} WHERE t.origin_chain = $1 AND t.nonce = $2 LIMIT 1`,
    [originChain, nonce],
  );
  const row = rows[0];
  if (!row) return { kind: "not_found" };
  const route = integer(row, "route");
  if (route !== RouteKind.Cctp) {
    return { kind: "wrong_route", route };
  }
  return { kind: "ok", evidence: formatEvidenceRow(row) };
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
    !report.messageBytes ||
    !/^0x[0-9a-fA-F]+$/.test(report.messageBytes) ||
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
  const sourceAmount = bigintOf(stored, "net_amount");
  const expected: ExpectedCctpTransfer = {
    sourceToken: sourceToken.sacId,
    sourceAdapter: adapter,
    sourceMessenger: STELLAR_CCTP_MESSENGER,
    destinationDomain: destination.cctpDomain,
    destinationMessenger: contracts.tokenMessengerV2,
    transmitter: contracts.messageTransmitterV2,
    token: token.address,
    recipient: toEvmAddress(text(stored, "destination") as Hex),
    sourceAmount,
  };
  const raw = report.messageBytes as Hex;
  const verifiedMsg = verifiedCctpMessage(raw, expected);
  if (!verifiedMsg) return null;

  const attestationPresent =
    report.status === "attested" ||
    Boolean(report.attestationSignature) ||
    Boolean(report.attestation);

  if (!report.forwardTxHash) {
    await db
      .transaction((tx) =>
        upsertCctpDeliveryEvidence(tx, {
          transferId: transfer.transferId,
          verified: verifiedMsg,
          burnedAmount: sourceAmount,
          forwardTxHash: null,
          canonicalTxHash: null,
          canonicalBlockNumber: null,
          canonicalBlockHash: null,
          messageLogIndex: null,
          mintLogIndex: null,
          mintedAmount: null,
          attestationPresent,
        }),
      )
      .catch(() => undefined);
    return null;
  }

  const client = options?.evmClient ?? createDefaultEvmClient(destination.defaultRpcUrl);
  if ((await client.getChainId()) !== destination.chainId) {
    throw new Error("CCTP destination RPC chain mismatch.");
  }
  const receipt = await client.getTransactionReceipt({ hash: report.forwardTxHash });
  if (receipt.status !== "success") return null;
  const head = await client.getBlockNumber();
  if (head - receipt.blockNumber + 1n < BigInt(destination.confirmations)) {
    await db
      .transaction((tx) =>
        upsertCctpDeliveryEvidence(tx, {
          transferId: transfer.transferId,
          verified: verifiedMsg,
          burnedAmount: sourceAmount,
          forwardTxHash: report.forwardTxHash ?? null,
          canonicalTxHash: null,
          canonicalBlockNumber: null,
          canonicalBlockHash: null,
          messageLogIndex: null,
          mintLogIndex: null,
          mintedAmount: null,
          attestationPresent,
        }),
      )
      .catch(() => undefined);
    return null;
  }
  const matched = matchCctpReceiptLogs(receipt.logs, raw, expected);
  if (!matched) return null;
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) return null;

  await db
    .transaction((tx) =>
      upsertCctpDeliveryEvidence(tx, {
        transferId: transfer.transferId,
        verified: matched.verified,
        burnedAmount: sourceAmount,
        forwardTxHash: report.forwardTxHash ?? receipt.transactionHash,
        canonicalTxHash: receipt.transactionHash,
        canonicalBlockNumber: receipt.blockNumber,
        canonicalBlockHash: receipt.blockHash,
        messageLogIndex: matched.messageLog.logIndex,
        mintLogIndex: matched.paymentLog.logIndex,
        mintedAmount: matched.verified.amount,
        attestationPresent: true,
      }),
    )
    .catch(() => undefined);

  return {
    at: {
      chainKey: transfer.destinationChain,
      block: receipt.blockNumber,
      txHash: receipt.transactionHash,
      logIndex: matched.paymentLog.logIndex,
      observedAt: new Date(Number(block.timestamp) * 1000),
    },
    row: {
      route: transfer.route,
      sourceChain: transfer.originChain,
      sourceNonce: transfer.nonce,
      railMessageId: matched.verified.message.nonce,
      recipient: expected.recipient.toLowerCase(),
      token: token.address.toLowerCase(),
      amount: matched.verified.amount,
      delivered: true,
      claimId: null,
    },
  };
}
