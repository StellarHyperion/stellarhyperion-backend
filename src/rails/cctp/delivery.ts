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
import type { Queryable } from "../../db/pool.js";
import { bigintOf, text, textOrNull } from "../../db/rows.js";
import type { PendingTransfer, RailReport } from "../types.js";
import type { VerifiedDelivery } from "../axelar/delivery.js";
import {
  cctpMessageIdentity,
  inspectCctpMessage,
  inspectCctpPayment,
  type CctpProofEvidence,
  type ExpectedCctpTransfer,
} from "./events.js";
import type { CctpVerificationFailure } from "../types.js";

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
}

/** Returned by inspectCctpDelivery when delivery cannot be confirmed. */
export interface CctpDeliveryFailure {
  readonly delivery: null;
  readonly failure: CctpVerificationFailure | null;
  readonly proofEvidence: null;
}

export type CctpDeliveryResult = CctpDeliverySuccess | CctpDeliveryFailure;

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
  if (transfer.route !== RouteKind.Cctp || transfer.originChain !== "stellar-testnet")
    return noResult();
  if (!report.forwardTxHash) return failed("forward_tx_missing");
  if (!report.messageBytes) return failed("message_missing");
  if (report.messageBytes.length > 8192 || !/^0x(?:[0-9a-fA-F]{2})+$/.test(report.messageBytes))
    return failed("invalid_message");
  if (!isChainKey(transfer.destinationChain)) return failed("configuration_unavailable");
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
  const raw = report.messageBytes as Hex;
  const identity = cctpMessageIdentity(raw);
  if (
    !identity ||
    (report.messageNonce != null && report.messageNonce.toLowerCase() !== identity.nonce) ||
    (report.messageDigest != null && report.messageDigest.toLowerCase() !== identity.digest)
  )
    return failed("invalid_message");
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
  const message = inspectCctpMessage(raw, expected);
  if (message.failure !== null) return failed(message.failure);
  // One message mints once. An exact repeat for this transfer is replayable and upserts the same
  // row; the same full nonce already credited to a different transfer is never re-associated.
  const { rows: prior } = await db.query(
    `SELECT source_transfer_id FROM inbound_delivery
      WHERE destination_chain = $1 AND route = $2 AND lower(rail_message_id) = $3`,
    [transfer.destinationChain, transfer.route, identity.nonce],
  );
  if (prior.some((row) => textOrNull(row, "source_transfer_id") !== String(transfer.transferId)))
    return failed("message_already_delivered");
  const client = createPublicClient({
    transport: http(destination.defaultRpcUrl, { timeout: 15000, retryCount: 0 }),
  });
  if ((await client.getChainId()) !== destination.chainId)
    throw new Error("CCTP destination RPC chain mismatch.");
  const receipt = await client.getTransactionReceipt({ hash: report.forwardTxHash });
  if (receipt.status !== "success") return failed("receipt_reverted");
  const head = await client.getBlockNumber();
  if (head - receipt.blockNumber + 1n < BigInt(destination.confirmations))
    return failed("confirmations_pending");
  const paymentResult = inspectCctpPayment(receipt.logs, raw, expected);
  if (!paymentResult.payment) return failed(paymentResult.failure);
  const payment = paymentResult.payment;
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (block.hash !== receipt.blockHash) return failed("non_canonical_receipt");

  // Canonical evidence: bounded public references only. No credential, adapter address, or
  // raw provider value appears here. The mint amount is an integer string to avoid float
  // imprecision on amounts that do not fit in a 53-bit mantissa.
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

  const deliveryResult: CctpDeliverySuccess = {
    failure: null,
    proofEvidence,
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
      },
    },
  };
  return deliveryResult;
}

/** Proof-only callers retain the established nullable verifier contract. */
export async function verifyCctpDelivery(
  config: AppConfig,
  db: Queryable,
  transfer: PendingTransfer,
  report: RailReport,
): Promise<VerifiedDelivery | null> {
  return (await inspectCctpDelivery(config, db, transfer, report)).delivery;
}
