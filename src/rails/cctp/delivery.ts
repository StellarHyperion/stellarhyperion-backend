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
  type ExpectedCctpTransfer,
} from "./events.js";
import type { CctpVerificationFailure } from "../types.js";

export async function inspectCctpDelivery(
  config: AppConfig,
  db: Queryable,
  transfer: PendingTransfer,
  report: RailReport,
): Promise<{
  readonly delivery: VerifiedDelivery | null;
  readonly failure: CctpVerificationFailure | null;
}> {
  const noFailure = (delivery: VerifiedDelivery | null = null) => ({ delivery, failure: null });
  const failed = (failure: CctpVerificationFailure) => ({ delivery: null, failure });
  if (transfer.route !== RouteKind.Cctp || transfer.originChain !== "stellar-testnet")
    return noFailure();
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
  return noFailure({
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
  });
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
