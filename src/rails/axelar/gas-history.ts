/**
 * Axelar gas-payment, top-up, and refund history ingestion.
 *
 * Indexes public gas-service events linked to source transfers in a dedicated table
 * (`axelar_gas_event`) so gas activity is never confused with destination delivery and can never
 * advance `rail_attestation` or `inbound_delivery` on its own.
 */
import { RAIL_CONTRACTS, isChainKey } from "@hyperion/protocol";

import type { RawStellarEvent } from "../../chains/stellar/events.js";
import {
  scAddress,
  scBigInt,
  scBytes,
  scMap,
  scOptionalField,
  scString,
  scSymbol,
  scTag,
} from "../../chains/stellar/scval.js";
import type { Queryable, Transactional } from "../../db/pool.js";
import {
  bigintOf,
  bigintOrNull,
  boolean,
  integer,
  maybeOne,
  text,
  textOrNull,
  timestamp,
  type Row,
} from "../../db/rows.js";
import { decodeAxelarGasServiceLog, type AxelarGasEventKind, type DeliveryLog } from "./events.js";

export interface AxelarGasActivityInput {
  readonly chain: string;
  readonly gasService: string;
  readonly txHash: string;
  readonly blockNumber: bigint;
  readonly logIndex: number;
  readonly eventKind: AxelarGasEventKind;
  readonly isNative: boolean;
  readonly gasToken: string | null;
  readonly amount: bigint;
  readonly sender?: string | null | undefined;
  readonly refundAddress: string | null;
  readonly sourceTxRef?: string | null | undefined;
  readonly sourceLogIndexRef?: bigint | null | undefined;
  readonly messageId?: string | null | undefined;
  readonly payloadHash?: string | null | undefined;
  readonly observedAt?: Date | undefined;
}

export type GasLinkResolutionStatus = "linked" | "unresolved";

export interface AxelarGasHistoryRecord {
  readonly id: bigint;
  readonly chain: string;
  readonly gasService: string;
  readonly txHash: string;
  readonly blockNumber: bigint;
  readonly logIndex: number;
  readonly eventKind: AxelarGasEventKind;
  readonly isNative: boolean;
  readonly gasToken: string | null;
  readonly amount: bigint;
  readonly sender: string | null;
  readonly refundAddress: string | null;
  readonly sourceTxRef: string | null;
  readonly sourceLogIndexRef: bigint | null;
  readonly messageId: string | null;
  readonly payloadHash: string | null;
  readonly transferId: bigint | null;
  readonly resolutionStatus: GasLinkResolutionStatus;
  readonly unresolvedReason: string | null;
  readonly observedAt: Date;
}

export interface IngestGasEventsSummary {
  readonly processed: number;
  readonly linked: number;
  readonly unresolved: number;
}

interface LinkDecision {
  readonly transferId: bigint | null;
  readonly resolutionStatus: GasLinkResolutionStatus;
  readonly unresolvedReason: string | null;
}

const SUPPORTED_TX_HASH_PATTERN = /^(?:0x)?[0-9a-fA-F]{64}$/;
const SUPPORTED_MESSAGE_ID_PATTERN = /^((?:0x)?[0-9a-fA-F]{64})-(\d+)$/;

function normalizeHexTx(hash: string): string {
  return hash.trim().toLowerCase().replace(/^0x/, "");
}

function scrubBoundedIdentifier(value: string | null | undefined, maxLen = 160): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const scrubbed = trimmed
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+:[^/\s@]+)@/gi, "$1[REDACTED]@")
    .replace(/([?&](?:api[_-]?key|token|secret|password|auth|key)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, "$1 [REDACTED]")
    .replace(/\bS[A-Z2-7]{55}\b/g, "[REDACTED_SECRET]");
  return scrubbed.slice(0, maxLen);
}

async function lookupSingleTransferByOriginTx(
  db: Queryable,
  chain: string,
  txRef: string,
): Promise<LinkDecision> {
  const bareHex = normalizeHexTx(txRef);
  const { rows } = await db.query(
    `SELECT id
       FROM outbound_transfer
      WHERE origin_chain = $1
        AND REPLACE(LOWER(origin_tx), '0x', '') = $2
      ORDER BY id ASC
      LIMIT 2`,
    [chain, bareHex],
  );
  if (rows.length === 0) {
    return {
      transferId: null,
      resolutionStatus: "unresolved",
      unresolvedReason: "source_transfer_not_indexed",
    };
  }
  if (rows.length > 1) {
    return {
      transferId: null,
      resolutionStatus: "unresolved",
      unresolvedReason: "ambiguous_source_transaction",
    };
  }
  const match = rows[0];
  if (match === undefined) {
    return {
      transferId: null,
      resolutionStatus: "unresolved",
      unresolvedReason: "source_transfer_not_indexed",
    };
  }
  return {
    transferId: bigintOf(match, "id"),
    resolutionStatus: "linked",
    unresolvedReason: null,
  };
}

async function resolveGasTransferLink(
  db: Queryable,
  input: {
    readonly chain: string;
    readonly sourceTxRef: string | null;
    readonly messageId: string | null;
  },
): Promise<LinkDecision> {
  // 1. Try explicit messageId link first when supplied.
  if (input.messageId !== null) {
    const msgTrimmed = input.messageId.trim();
    const byRailRef = await db.query(
      `SELECT t.id
         FROM outbound_transfer t
         LEFT JOIN rail_attestation a ON a.transfer_id = t.id
        WHERE t.origin_chain = $1
          AND (LOWER(t.rail_ref) = LOWER($2) OR LOWER(a.rail_reference) = LOWER($2))
        ORDER BY t.id ASC
        LIMIT 2`,
      [input.chain, msgTrimmed],
    );
    if (byRailRef.rows.length === 1 && byRailRef.rows[0] !== undefined) {
      return {
        transferId: bigintOf(byRailRef.rows[0], "id"),
        resolutionStatus: "linked",
        unresolvedReason: null,
      };
    }
    if (byRailRef.rows.length > 1) {
      return {
        transferId: null,
        resolutionStatus: "unresolved",
        unresolvedReason: "ambiguous_message_reference",
      };
    }

    const msgMatch = SUPPORTED_MESSAGE_ID_PATTERN.exec(msgTrimmed);
    if (!msgMatch) {
      // Fall back to sourceTxRef only if sourceTxRef itself is a supported hash; otherwise retain
      // this unsupported message link as unresolved evidence.
      if (input.sourceTxRef === null || !SUPPORTED_TX_HASH_PATTERN.test(input.sourceTxRef.trim())) {
        return {
          transferId: null,
          resolutionStatus: "unresolved",
          unresolvedReason: "unsupported_message_id_format",
        };
      }
    } else if (msgMatch[1] !== undefined) {
      return lookupSingleTransferByOriginTx(db, input.chain, msgMatch[1]);
    }
  }

  // 2. Try sourceTxRef link when supplied.
  if (input.sourceTxRef !== null) {
    const txTrimmed = input.sourceTxRef.trim();
    if (!SUPPORTED_TX_HASH_PATTERN.test(txTrimmed)) {
      return {
        transferId: null,
        resolutionStatus: "unresolved",
        unresolvedReason: "unsupported_link_format",
      };
    }
    return lookupSingleTransferByOriginTx(db, input.chain, txTrimmed);
  }

  return {
    transferId: null,
    resolutionStatus: "unresolved",
    unresolvedReason: "missing_source_reference",
  };
}

/**
 * Extracts public `IAxelarGasService` logs from an EVM transaction receipt into normalized inputs.
 */
export function gasEventsFromEvmLogs(params: {
  readonly chain: string;
  readonly txHash: string;
  readonly blockNumber: bigint;
  readonly observedAt: Date;
  readonly logs: readonly DeliveryLog[];
  readonly gasServiceAddress?: string | undefined;
}): readonly AxelarGasActivityInput[] {
  const configuredGasService =
    params.gasServiceAddress ??
    (isChainKey(params.chain) ? RAIL_CONTRACTS[params.chain]?.axelar?.gasService : undefined);
  if (!configuredGasService) {
    return [];
  }

  const out: AxelarGasActivityInput[] = [];
  for (const log of params.logs) {
    const decoded = decodeAxelarGasServiceLog(log, configuredGasService, params.txHash);
    if (decoded === null) continue;
    out.push({
      chain: params.chain,
      gasService: configuredGasService,
      txHash: params.txHash,
      blockNumber: params.blockNumber,
      logIndex: decoded.logIndex,
      eventKind: decoded.eventKind,
      isNative: decoded.isNative,
      gasToken: decoded.gasToken,
      amount: decoded.amount,
      sender: decoded.sender,
      refundAddress: decoded.refundAddress,
      sourceTxRef: decoded.sourceTxRef,
      sourceLogIndexRef: decoded.sourceLogIndexRef,
      messageId: decoded.messageId,
      payloadHash: decoded.payloadHash,
      observedAt: params.observedAt,
    });
  }
  return out;
}

/**
 * Decodes a public Soroban `axelar-gas-service` contract event (`gas_paid`, `gas_added`,
 * `gas_refunded`) while preserving exact Stellar strkeys (including muxed `M...` recipients) and
 * exact `i128` token amounts.
 */
export function decodeStellarAxelarGasEvent(
  raw: RawStellarEvent,
  options: {
    readonly chain: string;
    readonly expectedGasService?: string | undefined;
    readonly nativeSacId?: string | undefined;
  },
): AxelarGasActivityInput | null {
  const expectedContract =
    options.expectedGasService ??
    (isChainKey(options.chain) ? RAIL_CONTRACTS[options.chain]?.axelar?.gasService : undefined);
  if (!expectedContract || raw.contractId !== expectedContract) {
    return null;
  }
  if (raw.inSuccessfulContractCall === false || raw.topicJson.length === 0) {
    return null;
  }

  try {
    const headTopic = raw.topicJson[0];
    if (headTopic === undefined || scTag(headTopic) !== "symbol") {
      return null;
    }
    const tag = scSymbol(headTopic, "topic[0]");
    let eventKind: AxelarGasEventKind;
    if (tag === "gas_paid" || tag === "native_gas_paid") {
      eventKind = "gas_paid";
    } else if (tag === "gas_added" || tag === "native_gas_added") {
      eventKind = "gas_added";
    } else if (tag === "gas_refunded" || tag === "refunded") {
      eventKind = "refunded";
    } else {
      return null;
    }

    const idParts = raw.id.split("-");
    const eventIdxPart = idParts[1];
    const logIndex =
      eventIdxPart !== undefined && /^\d+$/.test(eventIdxPart) ? Number(eventIdxPart) : 0;

    const body = scMap(raw.valueJson, "value");
    const tokenEntry = scOptionalField(body, "token");
    let gasToken: string | null = null;
    let amount = 0n;

    if (tokenEntry !== undefined && scTag(tokenEntry) === "map") {
      const tokenMap = scMap(tokenEntry, "value.token");
      const addrVal = scOptionalField(tokenMap, "address");
      const amtVal = scOptionalField(tokenMap, "amount");
      if (addrVal !== undefined) gasToken = scAddress(addrVal, "value.token.address");
      if (amtVal !== undefined) amount = scBigInt(amtVal, "value.token.amount");
    } else {
      const amtVal = scOptionalField(body, "amount") ?? scOptionalField(body, "gas_fee_amount");
      if (amtVal !== undefined) amount = scBigInt(amtVal, "value.amount");
      const tokenAddrVal = scOptionalField(body, "gas_token");
      if (tokenAddrVal !== undefined && scTag(tokenAddrVal) === "address") {
        gasToken = scAddress(tokenAddrVal, "value.gas_token");
      }
    }

    if (amount < 0n) {
      return null;
    }

    const refundField =
      scOptionalField(body, "refund_address") ?? scOptionalField(body, "receiver");
    let refundAddress: string | null = null;
    if (refundField !== undefined) {
      const rTag = scTag(refundField);
      if (rTag === "address") {
        refundAddress = scAddress(refundField, "value.refund_address");
      } else if (rTag === "string" || rTag === "symbol") {
        refundAddress = scString(refundField, "value.refund_address");
      }
    }

    const senderField = scOptionalField(body, "sender") ?? scOptionalField(body, "spender");
    const sender =
      senderField !== undefined && scTag(senderField) === "address"
        ? scAddress(senderField, "value.sender")
        : null;

    const msgIdField = scOptionalField(body, "message_id");
    let messageId: string | null = null;
    if (
      msgIdField !== undefined &&
      (scTag(msgIdField) === "string" || scTag(msgIdField) === "symbol")
    ) {
      messageId = scString(msgIdField, "value.message_id");
    } else {
      // Check indexed topics for a message_id string on gas_added / gas_refunded.
      for (const topic of raw.topicJson.slice(1)) {
        const tTag = scTag(topic);
        if (tTag === "string") {
          const candidate = scString(topic);
          if (candidate.includes("-") || candidate.includes(":")) {
            messageId = candidate;
            break;
          }
        }
      }
    }

    const payloadHashField = scOptionalField(body, "payload_hash");
    const payloadHash =
      payloadHashField !== undefined && scTag(payloadHashField) === "bytes"
        ? scBytes(payloadHashField, "value.payload_hash")
        : null;

    const isNative =
      tag.startsWith("native_") ||
      gasToken === null ||
      (options.nativeSacId !== undefined && gasToken === options.nativeSacId);

    const sourceTxRef = eventKind === "gas_paid" && messageId === null ? raw.txHash : null;

    return {
      chain: options.chain,
      gasService: raw.contractId,
      txHash: raw.txHash,
      blockNumber: BigInt(raw.ledger),
      logIndex,
      eventKind,
      isNative,
      gasToken,
      amount,
      sender,
      refundAddress,
      sourceTxRef,
      sourceLogIndexRef: null,
      messageId,
      payloadHash,
      observedAt: new Date(raw.ledgerClosedAt),
    };
  } catch {
    return null;
  }
}

/**
 * Replayably ingests public Axelar gas-service events into `axelar_gas_event`.
 *
 * Never mutates `outbound_transfer`, `rail_attestation`, `inbound_delivery`, or `pending_claim`.
 */
export async function ingestAxelarGasEvents(
  db: Transactional,
  events: readonly AxelarGasActivityInput[],
): Promise<IngestGasEventsSummary> {
  if (events.length === 0) {
    return { processed: 0, linked: 0, unresolved: 0 };
  }

  let linked = 0;
  let unresolved = 0;

  await db.transaction(async (tx) => {
    for (const ev of events) {
      if (ev.amount < 0n) {
        throw new Error("Axelar gas event amount must be non-negative");
      }
      if (!Number.isInteger(ev.logIndex) || ev.logIndex < 0) {
        throw new Error("Axelar gas event logIndex must be a non-negative integer");
      }

      const sourceTxRef = scrubBoundedIdentifier(ev.sourceTxRef, 160);
      const messageId = scrubBoundedIdentifier(ev.messageId, 160);
      const decision = await resolveGasTransferLink(tx, {
        chain: ev.chain,
        sourceTxRef,
        messageId,
      });

      if (decision.resolutionStatus === "linked") {
        linked += 1;
      } else {
        unresolved += 1;
      }

      // Preserve refundAddress and sender case/strkey verbatim while scrubbing accidental secrets.
      const exactRefundAddress = scrubBoundedIdentifier(ev.refundAddress, 160);
      const exactSender = scrubBoundedIdentifier(ev.sender, 160);
      const exactGasToken = scrubBoundedIdentifier(ev.gasToken, 160);
      const payloadHash = scrubBoundedIdentifier(ev.payloadHash, 160);
      const observedAt = ev.observedAt ?? new Date();

      await tx.query(
        `INSERT INTO axelar_gas_event
           (chain, gas_service, tx_hash, block_number, log_index, event_kind,
            is_native, gas_token, amount, sender, refund_address,
            source_tx_ref, source_log_index_ref, message_id, payload_hash,
            transfer_id, resolution_status, unresolved_reason, observed_at)
         VALUES
           ($1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10, $11,
            $12, $13, $14, $15,
            $16, $17, $18, $19)
         ON CONFLICT (chain, tx_hash, log_index) DO UPDATE
           SET event_kind = EXCLUDED.event_kind,
               is_native = EXCLUDED.is_native,
               gas_token = EXCLUDED.gas_token,
               amount = EXCLUDED.amount,
               sender = EXCLUDED.sender,
               refund_address = EXCLUDED.refund_address,
               source_tx_ref = EXCLUDED.source_tx_ref,
               source_log_index_ref = EXCLUDED.source_log_index_ref,
               message_id = EXCLUDED.message_id,
               payload_hash = EXCLUDED.payload_hash,
               transfer_id = COALESCE(axelar_gas_event.transfer_id, EXCLUDED.transfer_id),
               resolution_status = CASE
                 WHEN axelar_gas_event.transfer_id IS NOT NULL OR EXCLUDED.transfer_id IS NOT NULL
                   THEN 'linked'
                 ELSE 'unresolved'
               END,
               unresolved_reason = CASE
                 WHEN axelar_gas_event.transfer_id IS NOT NULL OR EXCLUDED.transfer_id IS NOT NULL
                   THEN NULL
                 ELSE EXCLUDED.unresolved_reason
               END`,
        [
          scrubBoundedIdentifier(ev.chain, 64) ?? ev.chain,
          scrubBoundedIdentifier(ev.gasService, 160) ?? ev.gasService,
          scrubBoundedIdentifier(ev.txHash, 160) ?? ev.txHash,
          ev.blockNumber.toString(),
          ev.logIndex,
          ev.eventKind,
          ev.isNative,
          exactGasToken,
          ev.amount.toString(),
          exactSender,
          exactRefundAddress,
          sourceTxRef,
          ev.sourceLogIndexRef !== undefined && ev.sourceLogIndexRef !== null
            ? ev.sourceLogIndexRef.toString()
            : null,
          messageId,
          payloadHash,
          decision.transferId !== null ? decision.transferId.toString() : null,
          decision.resolutionStatus,
          decision.unresolvedReason,
          observedAt,
        ],
      );
    }
  });

  return {
    processed: events.length,
    linked,
    unresolved,
  };
}

/**
 * Re-evaluates previously unresolved gas events that were waiting on an unindexed source transfer,
 * leaving genuinely unsupported or ambiguous links intact as `unresolved` evidence.
 */
export async function relinkUnresolvedAxelarGasEvents(db: Transactional): Promise<number> {
  const { rows } = await db.query(
    `SELECT *
       FROM axelar_gas_event
      WHERE resolution_status = 'unresolved'
      ORDER BY id ASC`,
  );

  let relinked = 0;
  for (const row of rows) {
    const record = mapGasHistoryRow(row);
    const decision = await resolveGasTransferLink(db, {
      chain: record.chain,
      sourceTxRef: record.sourceTxRef,
      messageId: record.messageId,
    });
    if (decision.resolutionStatus === "linked" && decision.transferId !== null) {
      await db.transaction(async (tx) => {
        await tx.query(
          `UPDATE axelar_gas_event
              SET transfer_id = $2,
                  resolution_status = 'linked',
                  unresolved_reason = NULL
            WHERE id = $1`,
          [record.id.toString(), decision.transferId?.toString() ?? null],
        );
      });
      relinked += 1;
    }
  }
  return relinked;
}

export async function listTransferGasEvents(
  db: Queryable,
  transferId: bigint,
): Promise<readonly AxelarGasHistoryRecord[]> {
  const { rows } = await db.query(
    `SELECT *
       FROM axelar_gas_event
      WHERE transfer_id = $1
      ORDER BY block_number ASC, log_index ASC, id ASC`,
    [transferId.toString()],
  );
  return rows.map((row) => mapGasHistoryRow(row));
}

export async function listUnresolvedAxelarGasEvents(
  db: Queryable,
  chain?: string,
): Promise<readonly AxelarGasHistoryRecord[]> {
  const params: unknown[] = [];
  let chainFilter = "";
  if (chain !== undefined) {
    params.push(chain);
    chainFilter = "AND chain = $1";
  }
  const { rows } = await db.query(
    `SELECT *
       FROM axelar_gas_event
      WHERE resolution_status = 'unresolved' ${chainFilter}
      ORDER BY id ASC`,
    params,
  );
  return rows.map((row) => mapGasHistoryRow(row));
}

export async function getAxelarGasEventById(
  db: Queryable,
  id: bigint,
): Promise<AxelarGasHistoryRecord | null> {
  const { rows } = await db.query("SELECT * FROM axelar_gas_event WHERE id = $1", [id.toString()]);
  const row = maybeOne(rows, "getAxelarGasEventById");
  return row === null ? null : mapGasHistoryRow(row);
}

function mapGasHistoryRow(row: Row): AxelarGasHistoryRecord {
  const rawKind = text(row, "event_kind");
  if (rawKind !== "gas_paid" && rawKind !== "gas_added" && rawKind !== "refunded") {
    throw new Error(`unexpected axelar_gas_event.event_kind: ${rawKind}`);
  }
  const rawResolution = text(row, "resolution_status");
  if (rawResolution !== "linked" && rawResolution !== "unresolved") {
    throw new Error(`unexpected axelar_gas_event.resolution_status: ${rawResolution}`);
  }

  return {
    id: bigintOf(row, "id"),
    chain: text(row, "chain"),
    gasService: text(row, "gas_service"),
    txHash: text(row, "tx_hash"),
    blockNumber: bigintOf(row, "block_number"),
    logIndex: integer(row, "log_index"),
    eventKind: rawKind,
    isNative: boolean(row, "is_native"),
    gasToken: textOrNull(row, "gas_token"),
    amount: bigintOf(row, "amount"),
    sender: textOrNull(row, "sender"),
    refundAddress: textOrNull(row, "refund_address"),
    sourceTxRef: textOrNull(row, "source_tx_ref"),
    sourceLogIndexRef: bigintOrNull(row, "source_log_index_ref"),
    messageId: textOrNull(row, "message_id"),
    payloadHash: textOrNull(row, "payload_hash"),
    transferId: bigintOrNull(row, "transfer_id"),
    resolutionStatus: rawResolution,
    unresolvedReason: textOrNull(row, "unresolved_reason"),
    observedAt: timestamp(row, "observed_at"),
  };
}
