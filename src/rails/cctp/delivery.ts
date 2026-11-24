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
import type { Hex } from "viem";
import type { Logger } from "pino";
import { isDestinationVerificationChain, type AppConfig } from "../../config/config.js";
import type { Queryable, Transactional } from "../../db/pool.js";
import { bigintOf, text, textOrNull } from "../../db/rows.js";
import type { PendingTransfer, RailCandidate, RailReport } from "../types.js";
import type { VerifiedDelivery } from "../axelar/delivery.js";
import type { CctpDeliveryEvidenceRow } from "../../chains/writers.js";
import {
  destinationVerificationViemClient,
  withDestinationVerification,
  type DestinationVerificationClientFactory,
} from "../../chains/evm/client.js";
import {
  cctpMessageIdentity,
  cctpContractFingerprint,
  EIP1967_IMPLEMENTATION_SLOT,
  USDC_IMPLEMENTATION_SLOT,
  proxyImplementationAddress,
  evaluateCctpContractIdentity,
  inspectCctpMessage,
  inspectCctpPayment,
  type CctpProofEvidence,
  type CctpContractRole,
  type CctpContractObservation,
  type ExpectedCctpTransfer,
} from "./events.js";
import type { CctpVerificationFailure } from "../types.js";
import type { BoundedCandidateReceiptCache } from "../candidate-receipt-cache.js";

/** Returned by inspectCctpDelivery on a successful delivery. */
export interface CctpDeliverySuccess {
  readonly delivery: VerifiedDelivery;
  readonly failure: null;
  /**
   * Sanitized canonical evidence for the delivery.
   *
   * Every field is a bounded public reference drawn from the destination chain. No
   * provider credential or internal adapter address appears in this structure.
   */
  readonly proofEvidence: CctpProofEvidence;
  readonly storedEvidence: CctpDeliveryEvidenceRow;
}

/** Returned by inspectCctpDelivery when delivery cannot be confirmed. */
export interface CctpDeliveryFailure {
  readonly delivery: null;
  readonly failure: CctpVerificationFailure | null;
  readonly proofEvidence: null;
}

export type CctpDeliveryResult = CctpDeliverySuccess | CctpDeliveryFailure;

export interface DeliveryVerificationOptions {
  readonly signal?: AbortSignal;
  readonly logger?: Logger;
  readonly clientForUrl?: DestinationVerificationClientFactory;
  readonly candidateReceiptCache?: BoundedCandidateReceiptCache;
}

export interface CctpRevalidationOptions {
  readonly signal?: AbortSignal;
  readonly logger?: Logger;
  readonly clientForUrl?: DestinationVerificationClientFactory;
}

/**
 * Sanitized proof-check status for a pending CCTP transfer.
 *
 * Shows exactly which proof ingredients are present or absent without exposing any provider
 * credential, raw API response, or internal adapter address. Public API responses and log
 * entries that include this type never carry raw credentials.
 *
 * A missing check does not mean the transfer failed — it means the information needed to
 * confirm delivery has not been collected yet. Provider attestation status alone is never
 * sufficient to establish delivery; both a destination receipt and a matching message identity
 * are required.
 */
export interface CctpProofCheckSummary {
  /**
   * Whether a candidate forwarding transaction hash arrived from the provider.
   *
   * `false` means the provider has not yet published a forwarding transaction for this
   * transfer. The transfer remains retryable until this check is satisfied.
   */
  readonly hasForwardTxHash: boolean;

  /**
   * Whether the provider supplied message bytes that parse into a valid CCTP message.
   *
   * `false` does not mean the message was rejected — it means no parseable bytes have
   * arrived yet. When `hasForwardTxHash` is also false the provider record is still
   * pending, which is the normal state for the first minute of a transfer's life.
   */
  readonly hasMessageBytes: boolean;

  /**
   * Whether the full 32-byte CCTP nonce and keccak256 digest were bound to the
   * provider record. When present, the message identity pins the provider record to
   * exactly one on-chain message so the receipt check is unambiguous.
   */
  readonly hasMessageIdentity: boolean;

  /**
   * Which proof checks are still missing, in discovery order.
   *
   * An empty array means all required proof ingredients are present (the transfer is either
   * delivered or in the final receipt-verification step). An operator reading this field
   * does not need to decode any internal failure code.
   */
  readonly missingChecks: readonly CctpVerificationFailure[];

  /**
   * Canonical destination-chain evidence when delivery has been fully verified.
   *
   * `null` for any transfer that is still pending or whose proof checks are incomplete.
   * When non-null every field is a bounded public reference — no credential appears here.
   */
  readonly evidence: CctpProofEvidence | null;
}

/**
 * Describe the proof-check state of a pending CCTP transfer without mutating any row.
 *
 * Returns a sanitized summary whose public fields contain only bounded references. The
 * summary is intended for operator dashboards and API responses; it must not be used to
 * conclude that a transfer has been delivered — `inspectCctpDelivery` with a live EVM
 * receipt is the only path to a delivery conclusion.
 */
export function describeCctpProofChecks(
  report: RailReport,
  existingFailure: CctpVerificationFailure | null,
): CctpProofCheckSummary {
  const hasForwardTxHash = Boolean(report.forwardTxHash);
  const hasMessageBytes = Boolean(
    report.messageBytes &&
    report.messageBytes.length <= 8192 &&
    /^0x(?:[0-9a-fA-F]{2})+$/.test(report.messageBytes),
  );
  const hasMessageIdentity = Boolean(
    hasMessageBytes && report.messageNonce && report.messageDigest,
  );

  const missingChecks: CctpVerificationFailure[] = [];
  if (!hasForwardTxHash) missingChecks.push("forward_tx_missing");
  if (!hasMessageBytes) missingChecks.push("message_missing");
  // Surface the last known durable failure unless it is one already in missingChecks.
  if (
    existingFailure !== null &&
    !missingChecks.includes(existingFailure) &&
    existingFailure !== "forward_tx_missing" &&
    existingFailure !== "message_missing"
  ) {
    missingChecks.push(existingFailure);
  }

  return {
    hasForwardTxHash,
    hasMessageBytes,
    hasMessageIdentity,
    missingChecks,
    evidence: null, // A pending summary never carries evidence; that comes from inspectCctpDelivery.
  };
}

export async function inspectCctpDelivery(
  config: AppConfig,
  db: Queryable,
  transfer: PendingTransfer,
  report: RailReport,
  options: DeliveryVerificationOptions = {},
): Promise<CctpDeliveryResult> {
  const noResult = (): CctpDeliveryResult => ({
    delivery: null,
    failure: null,
    proofEvidence: null,
  });
  const failed = (failure: CctpVerificationFailure): CctpDeliveryResult => ({
    delivery: null,
    failure,
    proofEvidence: null,
  });
  if (transfer.route !== RouteKind.Cctp) return noResult();
  if (transfer.originChain !== "stellar-testnet")
    return failed("inbound_contract_capability_missing");
  if (!isChainKey(transfer.destinationChain)) return failed("configuration_unavailable");
  if (!isDestinationVerificationChain(transfer.destinationChain))
    return failed("configuration_unavailable");
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
    return failed("configuration_unavailable");
  // Every burn binding the queue knows must hold on the stored source row, not only its id.
  const { rows } = await db.query(
    `SELECT origin_chain, nonce, origin_tx, destination_chain, token, net_amount, destination
       FROM outbound_transfer WHERE id = $1 AND route = $2`,
    [String(transfer.transferId), transfer.route],
  );
  const stored = rows[0];
  if (
    !stored ||
    text(stored, "origin_chain") !== transfer.originChain ||
    bigintOf(stored, "nonce") !== transfer.nonce ||
    text(stored, "origin_tx") !== transfer.originTx ||
    text(stored, "destination_chain") !== transfer.destinationChain
  )
    return failed("source_transfer_missing");
  if (text(stored, "token") !== sourceToken.sacId) return failed("token_mismatch");
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
  const candidates: readonly RailCandidate[] =
    report.candidates && report.candidates.length > 0 ? report.candidates : [report];
  const matches: {
    candidate: RailCandidate;
    raw: Hex;
    identity: NonNullable<ReturnType<typeof cctpMessageIdentity>>;
    message: Extract<ReturnType<typeof inspectCctpMessage>, { failure: null }>;
  }[] = [];
  let firstFailure: CctpVerificationFailure | null = null;
  for (const candidate of candidates) {
    if (!candidate.forwardTxHash) {
      firstFailure ??= "forward_tx_missing";
      continue;
    }
    if (!candidate.messageBytes) {
      firstFailure ??= "message_missing";
      continue;
    }
    if (
      candidate.messageBytes.length > 8192 ||
      !/^0x(?:[0-9a-fA-F]{2})+$/.test(candidate.messageBytes)
    ) {
      firstFailure ??= "invalid_message";
      continue;
    }
    const raw = candidate.messageBytes as Hex;
    const identity = cctpMessageIdentity(raw);
    if (
      !identity ||
      (candidate.messageNonce != null && candidate.messageNonce.toLowerCase() !== identity.nonce) ||
      (candidate.messageDigest != null && candidate.messageDigest.toLowerCase() !== identity.digest)
    ) {
      firstFailure ??= "invalid_message";
      continue;
    }
    const message = inspectCctpMessage(raw, expected);
    if (message.failure !== null) {
      firstFailure ??= message.failure;
      continue;
    }
    matches.push({ candidate, raw, identity, message });
  }
  // A source transaction can legitimately contain unrelated messages, but never enough evidence
  // to choose between two complete matches. Keeping that ambiguity unverified prevents a burn
  // from being associated with the wrong transfer on replay.
  if (matches.length === 0) return failed(firstFailure ?? "invalid_message");
  if (matches.length > 1) return failed("invalid_message");
  const match = matches[0];
  if (match === undefined) return failed(firstFailure ?? "invalid_message");
  const { candidate, raw, identity, message } = match;
  const forwardTxHash = candidate.forwardTxHash;
  if (!forwardTxHash) return failed("forward_tx_missing");
  // One message mints once. An exact repeat for this transfer is replayable and upserts the same
  // row; the same full nonce already credited to a different transfer is never re-associated.
  const { rows: prior } = await db.query(
    `SELECT source_transfer_id FROM inbound_delivery
      WHERE destination_chain = $1 AND route = $2 AND lower(rail_message_id) = $3`,
    [transfer.destinationChain, transfer.route, identity.nonce],
  );
  if (prior.some((row) => textOrNull(row, "source_transfer_id") !== String(transfer.transferId)))
    return failed("message_already_delivered");
  return withDestinationVerification(
    config.destinationVerification.evmRpcUrls[transfer.destinationChain],
    destination.chainId,
    options.clientForUrl ?? destinationVerificationViemClient,
    async (client) => {
      const receipt = options.candidateReceiptCache
        ? await options.candidateReceiptCache.get({
            chain: transfer.destinationChain,
            txHash: forwardTxHash,
            read: () => client.getTransactionReceipt({ hash: forwardTxHash }),
            readBlock: ({ blockNumber }) =>
              client.getBlock({ blockNumber, includeTransactions: false }),
            identity: (candidate) => ({
              blockNumber: candidate.blockNumber,
              blockHash: candidate.blockHash,
            }),
          })
        : await client.getTransactionReceipt({ hash: forwardTxHash });
      if (receipt.status !== "success") return failed("receipt_reverted");
      const head = await client.getBlockNumber();
      if (head - receipt.blockNumber + 1n < BigInt(destination.confirmations))
        return failed("confirmations_pending");
      const paymentResult = inspectCctpPayment(receipt.logs, raw, expected);
      if (!paymentResult.payment) return failed(paymentResult.failure);
      const payment = paymentResult.payment;
      const block = await client.getBlock({
        blockNumber: receipt.blockNumber,
        includeTransactions: false,
      });
      if (block.hash !== receipt.blockHash) return failed("non_canonical_receipt");

      const observations: CctpContractObservation[] = [];
      // Keep tracked evidence reads deterministic across independent RPC endpoints.
      for (const [role, address] of [
        ["token_messenger_v2", contracts.tokenMessengerV2],
        ["message_transmitter_v2", contracts.messageTransmitterV2],
        ["usdc", token.address],
      ] as const) {
        const code = await client.getCode({ address, blockNumber: receipt.blockNumber });
        const implementations: { slot: Hex; address: Hex; code: Hex | undefined }[] = [];
        const slots =
          role === "usdc"
            ? [EIP1967_IMPLEMENTATION_SLOT, USDC_IMPLEMENTATION_SLOT]
            : [EIP1967_IMPLEMENTATION_SLOT];
        for (const slot of slots) {
          const implementation = proxyImplementationAddress(
            await client.getStorageAt({ address, slot, blockNumber: receipt.blockNumber }),
          );
          if (implementation !== null)
            implementations.push({
              slot,
              address: implementation,
              code: await client.getCode({
                address: implementation,
                blockNumber: receipt.blockNumber,
              }),
            });
        }
        observations.push({
          role,
          address,
          codeHash: cctpContractFingerprint(code, implementations),
        });
      }
      const codeBlock = await client.getBlock({
        blockNumber: receipt.blockNumber,
        includeTransactions: false,
      });
      if (codeBlock.hash !== receipt.blockHash) return failed("non_canonical_receipt");
      // Invalid/empty code never seeds a baseline. A competing first-use insert may win; always
      // reread the durable winner before deciding whether these observations are admissible.
      if (
        observations.every(
          (observation) => observation.codeHash !== cctpContractFingerprint(undefined, []),
        )
      ) {
        for (const observation of observations) {
          await db.query(
            `INSERT INTO cctp_contract_baseline
               (chain_key, role, contract_address, code_hash, first_seen_block, first_seen_block_hash)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (chain_key, role) DO NOTHING`,
            [
              transfer.destinationChain,
              observation.role,
              observation.address.toLowerCase(),
              observation.codeHash.toLowerCase(),
              receipt.blockNumber.toString(),
              receipt.blockHash.toLowerCase(),
            ],
          );
        }
      }
      const { rows: baselineRows } = await db.query(
        `SELECT role, contract_address, code_hash
           FROM cctp_contract_baseline WHERE chain_key = $1`,
        [transfer.destinationChain],
      );
      const baselines = new Map(
        baselineRows.map((row) => [
          text(row, "role") as CctpContractRole,
          { address: text(row, "contract_address"), codeHash: text(row, "code_hash") },
        ]),
      );
      const diagnostic = evaluateCctpContractIdentity({
        destinationChain: transfer.destinationChain,
        chainId: destination.chainId,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        txHash: receipt.transactionHash,
        observations,
        baselines,
      });
      await db.query(
        `INSERT INTO cctp_contract_diagnostic
           (transfer_id, destination_chain, chain_id, block_number, block_hash, tx_hash,
            verdict, issues, observations)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
         ON CONFLICT (transfer_id, destination_chain, block_number, block_hash)
         DO UPDATE SET verdict = EXCLUDED.verdict, issues = EXCLUDED.issues,
                       observations = EXCLUDED.observations, tx_hash = EXCLUDED.tx_hash`,
        [
          String(transfer.transferId),
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
      if (diagnostic.verdict !== "verified") return failed("configuration_unavailable");

      const proofEvidence: CctpProofEvidence = {
        txHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber.toString(),
        blockHash: receipt.blockHash,
        mintLogIndex: payment.logIndex,
        messageNonce: identity.nonce,
        messageDigest: identity.digest,
        mintAmount: message.amount.toString(),
        destinationChain: transfer.destinationChain,
      };
      const sourceBinding = {
        originChain: transfer.originChain,
        nonce: bigintOf(stored, "nonce").toString(),
        originTx: text(stored, "origin_tx"),
        destinationChain: transfer.destinationChain,
        token: text(stored, "token"),
        amount: bigintOf(stored, "net_amount").toString(),
        destination: text(stored, "destination"),
      };
      const storedEvidence: CctpDeliveryEvidenceRow = {
        transferId: transfer.transferId,
        destinationChain: transfer.destinationChain,
        txHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        mintLogIndex: payment.logIndex,
        messageNonce: identity.nonce,
        messageDigest: identity.digest,
        messageBytes: raw,
        token: token.address.toLowerCase(),
        recipient: expected.recipient.toLowerCase(),
        amount: message.amount,
        sourceBinding,
      };

      return {
        failure: null,
        proofEvidence,
        storedEvidence,
        delivery: {
          at: {
            chainKey: transfer.destinationChain,
            block: receipt.blockNumber,
            txHash: receipt.transactionHash,
            logIndex: payment.logIndex,
            observedAt: new Date(Number(block.timestamp) * 1000),
          },
          row: {
            sourceTransferId: transfer.transferId,
            route: transfer.route,
            sourceChain: transfer.originChain,
            sourceNonce: transfer.nonce,
            railMessageId: identity.nonce,
            recipient: expected.recipient.toLowerCase(),
            token: token.address.toLowerCase(),
            amount: message.amount,
            delivered: true,
            claimId: null,
            cctpFeeReconciliation: message.feeReconciliation,
          },
        },
      };
    },
    { ...options, chain: transfer.destinationChain },
  );
}

/** Proof-only callers retain the established nullable verifier contract. */
export async function verifyCctpDelivery(
  config: AppConfig,
  db: Queryable,
  transfer: PendingTransfer,
  report: RailReport,
  options: DeliveryVerificationOptions = {},
): Promise<VerifiedDelivery | null> {
  return (await inspectCctpDelivery(config, db, transfer, report, options)).delivery;
}

/**
 * Revalidate previously confirmed CCTP destination proofs without consulting Iris or submitting
 * any transactions. A proof is reopened only when its saved receipt/payment no longer verifies.
 */
export async function revalidateCctpDeliveryProofs(
  config: AppConfig,
  db: Transactional,
  limit: number,
  options: CctpRevalidationOptions = {},
): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new Error("CCTP revalidation batch must be between 1 and 1000.");

  const { rows } = await db.query(
    `SELECT id, transfer_id, destination_chain, tx_hash, block_number, block_hash,
            mint_log_index, message_nonce, message_digest, message_bytes, token, recipient,
            amount::text, source_binding
       FROM cctp_delivery_evidence WHERE status = 'canonical'
      ORDER BY last_revalidated_at NULLS FIRST, block_number, id LIMIT $1`,
    [limit],
  );
  let orphaned = 0;
  for (const row of rows) {
    options.signal?.throwIfAborted();
    const transferId = bigintOf(row, "transfer_id");
    const id = bigintOf(row, "id");
    const source = (
      await db.query(
        `SELECT id, route, origin_chain, nonce, origin_tx, destination_chain, token,
                net_amount, destination
           FROM outbound_transfer WHERE id = $1 AND route = $2`,
        [transferId.toString(), RouteKind.Cctp],
      )
    ).rows[0];
    if (source === undefined) {
      if (await markCctpProofOrphaned(db, id, transferId)) orphaned += 1;
      continue;
    }

    const sourceBinding = parseCctpSourceBinding(row.source_binding);
    const sourceMatches =
      sourceBinding !== null &&
      sourceBinding.originChain === text(source, "origin_chain") &&
      sourceBinding.nonce === bigintOf(source, "nonce").toString() &&
      sourceBinding.originTx === text(source, "origin_tx") &&
      sourceBinding.destinationChain === text(source, "destination_chain") &&
      sourceBinding.token === text(source, "token") &&
      sourceBinding.amount === bigintOf(source, "net_amount").toString() &&
      sourceBinding.destination === text(source, "destination");
    if (!sourceMatches) {
      if (await markCctpProofOrphaned(db, id, transferId)) orphaned += 1;
      continue;
    }

    const transfer: PendingTransfer = {
      transferId,
      route: RouteKind.Cctp,
      originChain: text(source, "origin_chain"),
      destinationChain: text(source, "destination_chain"),
      nonce: bigintOf(source, "nonce"),
      originTx: text(source, "origin_tx"),
      status: "attested",
      checkFailures: 0,
      retryAttempts: 0,
      delivered: false,
    };
    const report: RailReport = {
      status: "attested",
      railStatus: "proof_revalidation",
      reference: text(row, "message_nonce"),
      attestedAt: null,
      forwardTxHash: text(row, "tx_hash") as `0x${string}`,
      messageBytes: text(row, "message_bytes"),
      messageNonce: text(row, "message_nonce"),
      messageDigest: text(row, "message_digest"),
    };
    const result = await inspectCctpDelivery(config, db, transfer, report, options);
    const proofStillMatches =
      result.delivery !== null &&
      "storedEvidence" in result &&
      result.storedEvidence.txHash.toLowerCase() === text(row, "tx_hash").toLowerCase() &&
      result.storedEvidence.blockNumber === bigintOf(row, "block_number") &&
      result.storedEvidence.blockHash.toLowerCase() === text(row, "block_hash").toLowerCase() &&
      result.storedEvidence.mintLogIndex === Number(row.mint_log_index) &&
      result.storedEvidence.messageNonce.toLowerCase() ===
        text(row, "message_nonce").toLowerCase() &&
      result.storedEvidence.messageDigest.toLowerCase() ===
        text(row, "message_digest").toLowerCase() &&
      result.storedEvidence.token.toLowerCase() === text(row, "token").toLowerCase() &&
      result.storedEvidence.recipient.toLowerCase() === text(row, "recipient").toLowerCase() &&
      result.storedEvidence.amount === bigintOf(row, "amount");
    if (proofStillMatches) {
      await db.query(
        `UPDATE cctp_delivery_evidence SET last_revalidated_at = now()
          WHERE id = $1 AND status = 'canonical'`,
        [id.toString()],
      );
      continue;
    }
    const orphanFailures: readonly CctpVerificationFailure[] = [
      "non_canonical_receipt",
      "receipt_reverted",
      "receipt_missing",
      "receipt_mismatch",
      "mint_missing",
      "amount_mismatch",
      "token_mismatch",
      "recipient_mismatch",
      "invalid_message",
    ];
    if (result.failure !== null && !orphanFailures.includes(result.failure)) {
      await db.query(
        `UPDATE cctp_delivery_evidence SET last_revalidated_at = now()
          WHERE id = $1 AND status = 'canonical'`,
        [id.toString()],
      );
      continue;
    }
    if (await markCctpProofOrphaned(db, id, transferId)) {
      orphaned += 1;
      options.logger?.warn(
        { transferId: transferId.toString(), destinationChain: transfer.destinationChain },
        "CCTP destination proof is no longer canonical; delivery was reopened",
      );
    }
  }
  return orphaned;
}

function parseCctpSourceBinding(value: unknown): CctpDeliveryEvidenceRow["sourceBinding"] | null {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const binding = value as Record<string, unknown>;
  const fields = [
    "originChain",
    "nonce",
    "originTx",
    "destinationChain",
    "token",
    "amount",
    "destination",
  ] as const;
  if (fields.some((field) => typeof binding[field] !== "string")) return null;
  return {
    originChain: binding.originChain as string,
    nonce: binding.nonce as string,
    originTx: binding.originTx as string,
    destinationChain: binding.destinationChain as string,
    token: binding.token as string,
    amount: binding.amount as string,
    destination: binding.destination as string,
  };
}

async function markCctpProofOrphaned(
  db: Transactional,
  evidenceId: bigint,
  transferId: bigint,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const locked = await tx.query(
      "SELECT id FROM outbound_transfer WHERE id = $1 FOR UPDATE SKIP LOCKED",
      [transferId.toString()],
    );
    if (locked.rowCount !== 1) return false;
    const updated = await tx.query(
      `UPDATE cctp_delivery_evidence SET status = 'orphaned', last_revalidated_at = now()
        WHERE id = $1 AND transfer_id = $2 AND status = 'canonical'
        RETURNING id`,
      [evidenceId.toString(), transferId.toString()],
    );
    if (updated.rowCount !== 1) return false;
    await tx.query("DELETE FROM inbound_delivery WHERE cctp_evidence_id = $1", [
      evidenceId.toString(),
    ]);
    await tx.query(
      "SELECT set_config('hyperion.rail_reconcile_transfer',$1,true), set_config('hyperion.rail_reconcile_reason','destination_proof_reorg',true)",
      [transferId.toString()],
    );
    await tx.query(
      `UPDATE rail_attestation SET status = 'attested', updated_at = now(),
          next_attempt_at = now(), retry_class = NULL
        WHERE transfer_id = $1 AND status = 'delivered'
          AND NOT EXISTS (SELECT 1 FROM inbound_delivery d
            WHERE d.source_transfer_id = $1 AND d.delivered = true)`,
      [transferId.toString()],
    );
    return true;
  });
}
