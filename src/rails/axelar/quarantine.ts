/**
 * Axelar provider schema drift quarantine and idempotent parser replay.
 *
 * Preserves bounded, credential-scrubbed unsupported response shapes linked to their outbound
 * transfer and provider reference instead of silently dropping them or treating unknown status
 * fields as delivered.
 */
import { createHash } from "node:crypto";

import { writeAttestation, writeInbound } from "../../chains/writers.js";
import type { Queryable, Transactional } from "../../db/pool.js";
import {
  bigintOf,
  boolean,
  integer,
  json,
  maybeOne,
  text,
  textOrNull,
  timestamp,
  timestampOrNull,
  type Row,
} from "../../db/rows.js";
import type { AttestationStatus, PendingTransfer, RailLookup, RailReport } from "../types.js";
import type { VerifiedDelivery } from "./delivery.js";

export const MAX_QUARANTINE_PAYLOAD_BYTES = 4096;
export const MAX_QUARANTINE_RECORDS_PER_TRANSFER = 16;
const MAX_STRING_LENGTH = 256;
const MAX_OBJECT_KEYS = 32;
const MAX_ARRAY_ITEMS = 16;
const MAX_DEPTH = 6;

const SENSITIVE_KEY_PATTERN =
  /^(?:authorization|cookie|set-cookie|api[_-]?key|secret|password|private[_-]?key|token|access[_-]?token|bearer)$/i;

export type AxelarSchemaDriftKind =
  "unknown_status" | "invalid_status_type" | "unsupported_execution_shape" | "unsupported_envelope";

export interface QuarantinedAxelarEntryInput {
  readonly transfer: PendingTransfer;
  readonly providerReference: string | null;
  readonly driftKind: AxelarSchemaDriftKind;
  readonly observedStatus: string | null;
  readonly rawPayload: unknown;
  readonly observedAt?: Date | undefined;
}

export interface QuarantinedAxelarRecord {
  readonly id: bigint;
  readonly transferId: bigint;
  readonly route: number;
  readonly originChain: string;
  readonly nonce: bigint;
  readonly originTx: string;
  readonly providerReference: string | null;
  readonly driftKind: AxelarSchemaDriftKind;
  readonly observedStatus: string | null;
  readonly payloadFingerprint: string;
  readonly boundedPayload: unknown;
  readonly payloadTruncated: boolean;
  readonly quarantineStatus: "quarantined" | "replayed";
  readonly replayedParser: string | null;
  readonly replayedAt: Date | null;
  readonly occurrences: number;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
}

export interface AxelarSchemaParser {
  readonly id: string;
  canParse(payload: unknown): boolean;
  parse(payload: unknown, transfer: PendingTransfer): RailLookup;
}

export class AxelarSchemaParserRegistry {
  private readonly parsers = new Map<string, AxelarSchemaParser>();

  register(parser: AxelarSchemaParser): void {
    const trimmed = parser.id.trim();
    if (trimmed.length === 0) {
      throw new Error("AxelarSchemaParser id must be non-empty");
    }
    this.parsers.set(trimmed, parser);
  }

  findParser(payload: unknown): AxelarSchemaParser | null {
    for (const parser of this.parsers.values()) {
      if (parser.canParse(payload)) {
        return parser;
      }
    }
    return null;
  }

  listParserIds(): readonly string[] {
    return [...this.parsers.keys()];
  }
}

export interface ReplayQuarantineOptions {
  readonly now?: (() => Date) | undefined;
  readonly includeReplayed?: boolean | undefined;
  readonly verifyDelivery?:
    | ((transfer: PendingTransfer, report: RailReport) => Promise<VerifiedDelivery | null>)
    | undefined;
}

export interface ReplayQuarantineResult {
  readonly scanned: number;
  readonly replayed: number;
  readonly skippedUnsupported: number;
  readonly skippedTruncated: number;
}

/**
 * Scrubs credentials and bounds nested payload shapes so arbitrary upstream JSON cannot leak
 * secrets or exhaust database storage.
 */
export function sanitizeAndBoundPayload(raw: unknown): {
  readonly bounded: unknown;
  readonly truncated: boolean;
  readonly fingerprint: string;
} {
  let structurallyTruncated = false;

  const sanitizeValue = (value: unknown, depth: number): unknown => {
    if (value === null || value === undefined) return null;
    if (typeof value === "boolean" || typeof value === "number") {
      return Number.isFinite(value) || typeof value === "boolean" ? value : String(value);
    }
    if (typeof value === "string") {
      const scrubbed = scrubStringCredentials(value);
      if (scrubbed.length > MAX_STRING_LENGTH) {
        structurallyTruncated = true;
        return `${scrubbed.slice(0, MAX_STRING_LENGTH)}...[truncated]`;
      }
      return scrubbed;
    }
    if (depth >= MAX_DEPTH) {
      structurallyTruncated = true;
      return "[max_depth_truncated]";
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_ITEMS) {
        structurallyTruncated = true;
      }
      return value.slice(0, MAX_ARRAY_ITEMS).map((entry) => sanitizeValue(entry, depth + 1));
    }
    if (typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length > MAX_OBJECT_KEYS) {
        structurallyTruncated = true;
      }
      const out: Record<string, unknown> = {};
      for (const [key, entryVal] of entries.slice(0, MAX_OBJECT_KEYS)) {
        const safeKey = key.slice(0, 64);
        if (SENSITIVE_KEY_PATTERN.test(safeKey)) {
          out[safeKey] = "[REDACTED]";
        } else {
          out[safeKey] = sanitizeValue(entryVal, depth + 1);
        }
      }
      return out;
    }
    return "[unsupported_type]";
  };

  const sanitized = sanitizeValue(raw, 0);
  const serialized = JSON.stringify(sanitized);
  const byteLength = Buffer.byteLength(serialized, "utf8");

  if (byteLength <= MAX_QUARANTINE_PAYLOAD_BYTES) {
    const fingerprint = createHash("sha256").update(serialized).digest("hex");
    return {
      bounded: sanitized,
      truncated: structurallyTruncated,
      fingerprint,
    };
  }

  const preview = serialized.slice(0, MAX_QUARANTINE_PAYLOAD_BYTES - 128);
  const fallbackEnvelope = {
    _quarantineTruncated: true,
    originalByteLength: byteLength,
    preview,
  };
  const fingerprint = createHash("sha256").update(serialized).digest("hex");
  return {
    bounded: fallbackEnvelope,
    truncated: true,
    fingerprint,
  };
}

function scrubStringCredentials(value: string): string {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+:[^/\s@]+)@/gi, "$1[REDACTED]@")
    .replace(/([?&](?:api[_-]?key|token|secret|password|auth|key)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, "$1 [REDACTED]")
    .replace(/\bS[A-Z2-7]{55}\b/g, "[REDACTED_SECRET]");
}

/**
 * Extracts a candidate provider reference from known and drifted Axelar message fields.
 */
export function extractProviderReference(candidate: unknown): string | null {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  const obj = candidate as Record<string, unknown>;
  for (const key of [
    "message_id",
    "messageId",
    "id",
    "reference",
    "gmp_id",
    "command_id",
    "commandId",
  ]) {
    const val = obj[key];
    if (typeof val === "string" && val.trim().length > 0) {
      return scrubStringCredentials(val.trim()).slice(0, 160);
    }
  }
  if (obj.call !== null && typeof obj.call === "object" && !Array.isArray(obj.call)) {
    const callObj = obj.call as Record<string, unknown>;
    for (const key of ["id", "messageId", "parentMessageID"]) {
      const val = callObj[key];
      if (typeof val === "string" && val.trim().length > 0) {
        return scrubStringCredentials(val.trim()).slice(0, 160);
      }
    }
  }
  return null;
}

/**
 * Persists or updates a quarantined schema drift record while enforcing a strict per-transfer cap.
 */
export async function recordQuarantinedAxelarSchema(
  db: Queryable,
  input: QuarantinedAxelarEntryInput,
): Promise<QuarantinedAxelarRecord | null> {
  const { bounded, truncated, fingerprint } = sanitizeAndBoundPayload(input.rawPayload);
  const now = input.observedAt ?? new Date();
  const observedStatus =
    input.observedStatus !== null
      ? scrubStringCredentials(input.observedStatus).slice(0, 128)
      : null;

  // Upsert if the exact fingerprint already exists for this transfer.
  const existing = await db.query(
    `UPDATE axelar_schema_quarantine
        SET occurrences = occurrences + 1,
            last_seen_at = $3,
            provider_reference = COALESCE(axelar_schema_quarantine.provider_reference, $4)
      WHERE transfer_id = $1 AND payload_fingerprint = $2
      RETURNING *`,
    [input.transfer.transferId.toString(), fingerprint, now, input.providerReference],
  );
  const updatedRow = maybeOne(existing.rows, "recordQuarantinedAxelarSchema.update");
  if (updatedRow !== null) {
    return mapQuarantineRow(updatedRow);
  }

  // Enforce bounded distinct quarantine records per transfer.
  const countRes = await db.query(
    "SELECT COUNT(*)::int AS cnt FROM axelar_schema_quarantine WHERE transfer_id = $1",
    [input.transfer.transferId.toString()],
  );
  const currentCount = countRes.rows[0] ? integer(countRes.rows[0], "cnt") : 0;
  if (currentCount >= MAX_QUARANTINE_RECORDS_PER_TRANSFER) {
    return null;
  }

  const inserted = await db.query(
    `INSERT INTO axelar_schema_quarantine
       (transfer_id, route, origin_chain, nonce, origin_tx, provider_reference,
        drift_kind, observed_status, payload_fingerprint, bounded_payload,
        payload_truncated, quarantine_status, occurrences, first_seen_at, last_seen_at)
     VALUES
       ($1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10::jsonb,
        $11, 'quarantined', 1, $12, $12)
     ON CONFLICT (transfer_id, payload_fingerprint) DO UPDATE
       SET occurrences = axelar_schema_quarantine.occurrences + 1,
           last_seen_at = EXCLUDED.last_seen_at,
           provider_reference = COALESCE(
             axelar_schema_quarantine.provider_reference,
             EXCLUDED.provider_reference
           )
     RETURNING *`,
    [
      input.transfer.transferId.toString(),
      input.transfer.route,
      input.transfer.originChain,
      input.transfer.nonce.toString(),
      input.transfer.originTx,
      input.providerReference,
      input.driftKind,
      observedStatus,
      fingerprint,
      JSON.stringify(bounded),
      truncated,
      now,
    ],
  );
  const row = maybeOne(inserted.rows, "recordQuarantinedAxelarSchema.insert");
  return row === null ? null : mapQuarantineRow(row);
}

export async function listQuarantinedAxelarRecords(
  db: Queryable,
  filter?: {
    readonly transferId?: bigint | undefined;
    readonly quarantineStatus?: "quarantined" | "replayed" | undefined;
  },
): Promise<readonly QuarantinedAxelarRecord[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter?.transferId !== undefined) {
    params.push(filter.transferId.toString());
    conditions.push(`transfer_id = $${String(params.length)}`);
  }
  if (filter?.quarantineStatus !== undefined) {
    params.push(filter.quarantineStatus);
    conditions.push(`quarantine_status = $${String(params.length)}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await db.query(
    `SELECT * FROM axelar_schema_quarantine ${where} ORDER BY id ASC`,
    params,
  );
  return rows.map((row) => mapQuarantineRow(row));
}

/**
 * Replays quarantined records using a parser registry.
 *
 * Provider-only parser results can never advance a transfer directly to `delivered`: `delivered`
 * requires either an existing `inbound_delivery` row or a confirmed destination chain proof from
 * `options.verifyDelivery`.
 */
export async function replayQuarantinedAxelarRecords(
  db: Transactional,
  registry: AxelarSchemaParserRegistry,
  options: ReplayQuarantineOptions = {},
): Promise<ReplayQuarantineResult> {
  const now = options.now ?? (() => new Date());
  const statusClause =
    options.includeReplayed === true ? "" : "WHERE q.quarantine_status = 'quarantined'";

  const { rows } = await db.query(
    `SELECT q.*,
            t.destination_chain,
            a.status AS current_attestation_status,
            COALESCE(a.check_failures, 0) AS current_check_failures,
            EXISTS (
              SELECT 1 FROM inbound_delivery d
               WHERE d.destination_chain = t.destination_chain
                 AND d.route = t.route
                 AND d.source_chain = t.origin_chain
                 AND d.source_nonce = t.nonce
            ) AS inbound_exists
       FROM axelar_schema_quarantine q
       JOIN outbound_transfer t ON t.id = q.transfer_id
       LEFT JOIN rail_attestation a ON a.transfer_id = q.transfer_id
       ${statusClause}
      ORDER BY q.id ASC`,
  );

  let replayed = 0;
  let skippedUnsupported = 0;
  let skippedTruncated = 0;

  for (const row of rows) {
    const record = mapQuarantineRow(row);
    if (record.payloadTruncated) {
      skippedTruncated += 1;
      continue;
    }

    const parser = registry.findParser(record.boundedPayload);
    if (parser === null) {
      skippedUnsupported += 1;
      continue;
    }

    const currentStatusRaw = textOrNull(row, "current_attestation_status");
    const currentStatus = parseStatusOrNull(currentStatusRaw);
    const inboundExists = row.inbound_exists === true;

    const transfer: PendingTransfer = {
      transferId: record.transferId,
      route: record.route,
      originChain: record.originChain,
      destinationChain: text(row, "destination_chain"),
      nonce: record.nonce,
      originTx: record.originTx,
      status: currentStatus,
      checkFailures: integer(row, "current_check_failures"),
      delivered: inboundExists,
    };

    const parsedLookup = parser.parse(record.boundedPayload, transfer);
    const replayTime = now();

    if (parsedLookup.kind === "missing") {
      await db.transaction(async (tx) => {
        await tx.query(
          `UPDATE axelar_schema_quarantine
              SET quarantine_status = 'replayed',
                  replayed_parser = $2,
                  replayed_at = COALESCE(replayed_at, $3)
            WHERE id = $1`,
          [record.id.toString(), parser.id, replayTime],
        );
      });
      replayed += 1;
      continue;
    }

    const report = parsedLookup.report;
    // Never allow a provider parser to assert `delivered` without chain proof.
    let nextStatus: AttestationStatus = report.status === "delivered" ? "attested" : report.status;

    if (inboundExists || currentStatus === "delivered") {
      nextStatus = "delivered";
    } else if (report.execution !== undefined && options.verifyDelivery !== undefined) {
      const verified = await options.verifyDelivery(transfer, report);
      if (verified !== null) {
        await db.transaction(async (tx) => {
          await writeInbound(tx, verified.at, verified.row);
        });
        nextStatus = "delivered";
      }
    }

    await db.transaction(async (tx) => {
      await writeAttestation(tx, {
        transferId: record.transferId,
        route: record.route,
        status: nextStatus,
        railStatus: report.railStatus,
        railReference: report.reference ?? record.providerReference,
        attestedAt: report.attestedAt,
        checkedAt: replayTime,
        checkFailures: 0,
        lastError: null,
      });

      await tx.query(
        `UPDATE axelar_schema_quarantine
            SET quarantine_status = 'replayed',
                replayed_parser = $2,
                replayed_at = COALESCE(replayed_at, $3)
          WHERE id = $1`,
        [record.id.toString(), parser.id, replayTime],
      );
    });

    replayed += 1;
  }

  return {
    scanned: rows.length,
    replayed,
    skippedUnsupported,
    skippedTruncated,
  };
}

function parseStatusOrNull(value: string | null): AttestationStatus | null {
  if (
    value === "pending" ||
    value === "attested" ||
    value === "delivered" ||
    value === "failed" ||
    value === "expired"
  ) {
    return value;
  }
  return null;
}

function mapQuarantineRow(row: Row): QuarantinedAxelarRecord {
  const rawDrift = text(row, "drift_kind");
  if (
    rawDrift !== "unknown_status" &&
    rawDrift !== "invalid_status_type" &&
    rawDrift !== "unsupported_execution_shape" &&
    rawDrift !== "unsupported_envelope"
  ) {
    throw new Error(`unexpected axelar_schema_quarantine.drift_kind: ${rawDrift}`);
  }
  const rawQStatus = text(row, "quarantine_status");
  if (rawQStatus !== "quarantined" && rawQStatus !== "replayed") {
    throw new Error(`unexpected axelar_schema_quarantine.quarantine_status: ${rawQStatus}`);
  }

  return {
    id: bigintOf(row, "id"),
    transferId: bigintOf(row, "transfer_id"),
    route: integer(row, "route"),
    originChain: text(row, "origin_chain"),
    nonce: bigintOf(row, "nonce"),
    originTx: text(row, "origin_tx"),
    providerReference: textOrNull(row, "provider_reference"),
    driftKind: rawDrift,
    observedStatus: textOrNull(row, "observed_status"),
    payloadFingerprint: text(row, "payload_fingerprint"),
    boundedPayload: json(row, "bounded_payload"),
    payloadTruncated: boolean(row, "payload_truncated"),
    quarantineStatus: rawQStatus,
    replayedParser: textOrNull(row, "replayed_parser"),
    replayedAt: timestampOrNull(row, "replayed_at"),
    occurrences: integer(row, "occurrences"),
    firstSeenAt: timestamp(row, "first_seen_at"),
    lastSeenAt: timestamp(row, "last_seen_at"),
  };
}
