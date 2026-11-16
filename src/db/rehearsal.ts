/**
 * Schema-safe backup and restore rehearsal tool.
 *
 * Exports a consistent read-only snapshot of indexed PostgreSQL state, restores it into an
 * isolated rehearsal database after checking column/precision parity, and verifies row counts,
 * arbitrary-precision monetary digests, and cursor/provenance join invariants.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { writeCursor } from "../chains/stellar/store.js";
import {
  settleAction,
  settleClaim,
  writeAction,
  writeAttestation,
  writeClaim,
  writeHealthSample,
  writeInbound,
  writeOutbound,
} from "../chains/writers.js";
import { Database, type Queryable, type Transactional } from "./pool.js";
import { boolean, integer, integerOrNull, json, one, text, textOrNull } from "./rows.js";

export const REHEARSAL_TABLES = [
  "indexer_cursor",
  "outbound_transfer",
  "inbound_delivery",
  "pending_claim",
  "rail_attestation",
  "admin_action",
  "route_health",
] as const;

export type RehearsalTableName = (typeof REHEARSAL_TABLES)[number];

export class RehearsalSafetyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RehearsalSafetyError";
    this.code = code;
  }
}

export class RehearsalValidationError extends Error {
  readonly mismatches: readonly string[];

  constructor(message: string, mismatches: readonly string[]) {
    super(message);
    this.name = "RehearsalValidationError";
    this.mismatches = mismatches;
  }
}

export interface SchemaColumnDescriptor {
  readonly tableName: RehearsalTableName;
  readonly columnName: string;
  readonly dataType: string;
  readonly numericPrecision: number | null;
  readonly numericScale: number | null;
  readonly isNullable: boolean;
}

export interface SnapshotCounts {
  readonly indexer_cursor: number;
  readonly outbound_transfer: number;
  readonly inbound_delivery: number;
  readonly pending_claim: number;
  readonly rail_attestation: number;
  readonly admin_action: number;
  readonly route_health: number;
}

export interface MonetaryDigests {
  readonly outboundGrossTotal: string;
  readonly outboundFeeTotal: string;
  readonly outboundNetTotal: string;
  readonly inboundAmountTotal: string;
  readonly inboundDeliveredTotal: string;
  readonly inboundParkedTotal: string;
  readonly pendingClaimAmountTotal: string;
  readonly pendingClaimSettledTotal: string;
  readonly pendingClaimUnsettledTotal: string;
  readonly routeHealthFlowTotal: string;
}

export interface ProvenanceJoinSummary {
  readonly pairedInboundToOutbound: number;
  readonly pairedParkedInboundToClaim: number;
  readonly orphanedParkedInbound: number;
  readonly boundAttestationsToOutbound: number;
  readonly unprovenDeliveredAttestations: number;
  readonly cursorWatermarkViolations: number;
}

export interface SnapshotManifest {
  readonly counts: SnapshotCounts;
  readonly monetaryDigests: MonetaryDigests;
  readonly joins: ProvenanceJoinSummary;
  readonly tableDigests: Readonly<Record<RehearsalTableName, string>>;
  readonly datasetDigest: string;
}

export interface CursorSnapshotRow {
  readonly chain_key: string;
  readonly family: string;
  readonly contract: string;
  readonly last_processed: string;
  readonly last_processed_at: string | null;
  readonly last_processed_hash: string | null;
  readonly updated_at: string;
}

export interface OutboundSnapshotRow {
  readonly id: string;
  readonly origin_chain: string;
  readonly route: number;
  readonly nonce: string;
  readonly sender: string;
  readonly token: string;
  readonly gross_amount: string;
  readonly fee: string;
  readonly net_amount: string;
  readonly destination_chain: string;
  readonly destination: string;
  readonly rail_ref: string | null;
  readonly origin_block: string;
  readonly origin_tx: string;
  readonly origin_log_index: number | null;
  readonly observed_at: string;
}

export interface InboundSnapshotRow {
  readonly id: string;
  readonly destination_chain: string;
  readonly route: number;
  readonly source_chain: string;
  readonly source_nonce: string;
  readonly rail_message_id: string | null;
  readonly recipient: string;
  readonly token: string;
  readonly amount: string;
  readonly delivered: boolean;
  readonly claim_id: string | null;
  readonly destination_block: string;
  readonly destination_tx: string;
  readonly destination_log_index: number | null;
  readonly observed_at: string;
}

export interface ClaimSnapshotRow {
  readonly chain: string;
  readonly claim_id: string;
  readonly recipient: string;
  readonly token: string;
  readonly amount: string;
  readonly route: number;
  readonly source_chain: string;
  readonly source_nonce: string;
  readonly created_at: string;
  readonly settled: boolean;
  readonly settled_at: string | null;
  readonly settled_by: string | null;
  readonly settled_tx: string | null;
  readonly observed_at: string;
}

export interface AttestationSnapshotRow {
  readonly transfer_id: string;
  readonly route: number;
  readonly status: string;
  readonly rail_status: string | null;
  readonly rail_reference: string | null;
  readonly attested_at: string | null;
  readonly last_checked_at: string | null;
  readonly check_failures: number;
  readonly last_error: string | null;
  readonly updated_at: string;
}

export interface ActionSnapshotRow {
  readonly chain: string;
  readonly action_id: string;
  readonly kind: number;
  readonly state: string;
  readonly payload: unknown;
  readonly eta: string | null;
  readonly expires_at: string | null;
  readonly queued_at: string;
  readonly settled_at: string | null;
  readonly actor: string | null;
  readonly observed_at: string;
}

export interface RouteHealthSnapshotRow {
  readonly id: string;
  readonly sampled_at: string;
  readonly origin_chain: string;
  readonly destination_chain: string;
  readonly route: number;
  readonly token: string;
  readonly available: boolean;
  readonly blocker: number;
  readonly flow_available: string | null;
  readonly median_seconds: number | null;
}

export interface IndexedDatasetSnapshot {
  readonly formatVersion: "hyperion.rehearsal.v1";
  readonly exportedAt: string;
  readonly schema: readonly SchemaColumnDescriptor[];
  readonly manifest: SnapshotManifest;
  readonly tables: {
    readonly indexer_cursor: readonly CursorSnapshotRow[];
    readonly outbound_transfer: readonly OutboundSnapshotRow[];
    readonly inbound_delivery: readonly InboundSnapshotRow[];
    readonly pending_claim: readonly ClaimSnapshotRow[];
    readonly rail_attestation: readonly AttestationSnapshotRow[];
    readonly admin_action: readonly ActionSnapshotRow[];
    readonly route_health: readonly RouteHealthSnapshotRow[];
  };
}

export interface TargetSafetyOptions {
  readonly targetConnectionString: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly allowNonTestTarget?: boolean;
  readonly confirmTargetDatabase?: string;
}

export interface VerificationReport {
  readonly ok: boolean;
  readonly mismatches: readonly string[];
  readonly actualManifest: SnapshotManifest;
}

const URL_SECRET_RE = /\b((?:postgres(?:ql)?|redis(?:s)?|https?):\/\/)([^/\s@]+@)/gi;
const QUERY_PARAM_SECRET_RE = /([?&](?:password|secret|token|api[_-]?key|sslpassword)=)([^&\s]+)/gi;
const SAFE_REHEARSAL_DB_RE = /(?:^|_|-)(?:test|rehearsal|sandbox)(?:$|_|-)/i;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function redactDatabaseUrl(rawUrl: string): string {
  return rawUrl
    .replace(URL_SECRET_RE, "$1[REDACTED]@")
    .replace(QUERY_PARAM_SECRET_RE, "$1[REDACTED]");
}

export function parseTargetDatabaseIdentity(connectionString: string): {
  readonly host: string;
  readonly databaseName: string;
  readonly redactedUrl: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new RehearsalSafetyError(
      "invalid_target_url",
      "target connection string is not a valid postgres URL",
    );
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new RehearsalSafetyError(
      "invalid_target_protocol",
      `unsupported database protocol ${parsed.protocol}`,
    );
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, "")).trim();
  if (databaseName.length === 0) {
    throw new RehearsalSafetyError(
      "missing_target_database",
      `target URL ${redactDatabaseUrl(connectionString)} does not name a database`,
    );
  }

  const hostParam = parsed.searchParams.get("host") ?? "";
  const host = parsed.hostname.length > 0 ? parsed.hostname.toLowerCase() : hostParam;

  return {
    host,
    databaseName,
    redactedUrl: redactDatabaseUrl(connectionString),
  };
}

export function assertRestoreTargetSafe(options: TargetSafetyOptions): {
  readonly host: string;
  readonly databaseName: string;
  readonly redactedUrl: string;
} {
  const identity = parseTargetDatabaseIdentity(options.targetConnectionString);
  const env = options.env ?? process.env;
  const explicitOverride =
    options.allowNonTestTarget === true &&
    env.HYPERION_ALLOW_NON_TEST_RESTORE === "true" &&
    options.confirmTargetDatabase === identity.databaseName;

  if (explicitOverride) {
    return identity;
  }

  if (env.NODE_ENV === "production" || env.HYPERION_NETWORK === "mainnet") {
    throw new RehearsalSafetyError(
      "production_environment_blocked",
      "restore rehearsal refuses to run while NODE_ENV=production or HYPERION_NETWORK=mainnet without explicit override",
    );
  }

  const isUnixSocket = identity.host.startsWith("/");
  if (!isUnixSocket && !LOCAL_HOSTS.has(identity.host)) {
    throw new RehearsalSafetyError(
      "non_local_target_blocked",
      `restore rehearsal refuses non-local host '${identity.host}' (${identity.redactedUrl}) without HYPERION_ALLOW_NON_TEST_RESTORE=true, allowNonTestTarget, and matching confirmTargetDatabase`,
    );
  }

  if (!SAFE_REHEARSAL_DB_RE.test(identity.databaseName)) {
    throw new RehearsalSafetyError(
      "non_rehearsal_database_blocked",
      `restore rehearsal refuses database '${identity.databaseName}' (${identity.redactedUrl}); use a dedicated *_test or *_rehearsal database or set explicit override`,
    );
  }

  return identity;
}

export async function readSchemaSignature(
  db: Queryable,
): Promise<readonly SchemaColumnDescriptor[]> {
  const { rows } = await db.query(
    `SELECT table_name,
            column_name,
            data_type,
            numeric_precision,
            numeric_scale,
            is_nullable
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ANY($1::text[])
      ORDER BY table_name ASC, ordinal_position ASC`,
    [REHEARSAL_TABLES],
  );

  return rows.map((row) => ({
    tableName: text(row, "table_name") as RehearsalTableName,
    columnName: text(row, "column_name"),
    dataType: text(row, "data_type"),
    numericPrecision: integerOrNull(row, "numeric_precision"),
    numericScale: integerOrNull(row, "numeric_scale"),
    isNullable: text(row, "is_nullable") === "YES",
  }));
}

export function assertSchemaCompatible(
  sourceSchema: readonly SchemaColumnDescriptor[],
  targetSchema: readonly SchemaColumnDescriptor[],
): void {
  const presentTables = new Set(targetSchema.map((col) => col.tableName));
  const missingTables = REHEARSAL_TABLES.filter((table) => !presentTables.has(table));
  if (missingTables.length > 0) {
    throw new RehearsalValidationError(
      `target database is missing required tables: ${missingTables.join(", ")}`,
      missingTables.map((table) => `missing_table:${table}`),
    );
  }

  const targetByKey = new Map<string, SchemaColumnDescriptor>();
  for (const col of targetSchema) {
    targetByKey.set(`${col.tableName}.${col.columnName}`, col);
  }

  const mismatches: string[] = [];
  for (const expected of sourceSchema) {
    const key = `${expected.tableName}.${expected.columnName}`;
    const actual = targetByKey.get(key);
    if (actual === undefined) {
      mismatches.push(`missing_column:${key}`);
      continue;
    }
    if (
      actual.dataType !== expected.dataType ||
      actual.numericPrecision !== expected.numericPrecision ||
      actual.numericScale !== expected.numericScale ||
      actual.isNullable !== expected.isNullable
    ) {
      mismatches.push(
        `column_drift:${key}:expected(${expected.dataType},${String(expected.numericPrecision)},${String(expected.numericScale)},nullable=${String(expected.isNullable)})!=actual(${actual.dataType},${String(actual.numericPrecision)},${String(actual.numericScale)},nullable=${String(actual.isNullable)})`,
      );
    }
  }

  if (mismatches.length > 0) {
    throw new RehearsalValidationError(
      `target database schema is incompatible with snapshot (${String(mismatches.length)} mismatch(es))`,
      mismatches,
    );
  }
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function runReadOnlySnapshot<T>(
  db: Queryable | Transactional,
  work: (reader: Queryable) => Promise<T>,
): Promise<T> {
  if ("transaction" in db && typeof db.transaction === "function") {
    return db.transaction(async (tx) => {
      await tx.query("SET TRANSACTION READ ONLY");
      return work(tx);
    });
  }
  return work(db);
}

async function computeMonetaryAndJoinSummary(reader: Queryable): Promise<{
  readonly monetaryDigests: MonetaryDigests;
  readonly joins: ProvenanceJoinSummary;
}> {
  const outboundAgg = one(
    (
      await reader.query(
        `SELECT COALESCE(SUM(gross_amount), 0)::text AS gross_total,
                COALESCE(SUM(fee), 0)::text AS fee_total,
                COALESCE(SUM(net_amount), 0)::text AS net_total
           FROM outbound_transfer`,
      )
    ).rows,
    "outbound monetary digest",
  );

  const inboundAgg = one(
    (
      await reader.query(
        `SELECT COALESCE(SUM(amount), 0)::text AS amount_total,
                COALESCE(SUM(amount) FILTER (WHERE delivered), 0)::text AS delivered_total,
                COALESCE(SUM(amount) FILTER (WHERE NOT delivered), 0)::text AS parked_total
           FROM inbound_delivery`,
      )
    ).rows,
    "inbound monetary digest",
  );

  const claimAgg = one(
    (
      await reader.query(
        `SELECT COALESCE(SUM(amount), 0)::text AS amount_total,
                COALESCE(SUM(amount) FILTER (WHERE settled), 0)::text AS settled_total,
                COALESCE(SUM(amount) FILTER (WHERE NOT settled), 0)::text AS unsettled_total
           FROM pending_claim`,
      )
    ).rows,
    "pending_claim monetary digest",
  );

  const healthAgg = one(
    (
      await reader.query(
        `SELECT COALESCE(SUM(flow_available), 0)::text AS flow_total
           FROM route_health`,
      )
    ).rows,
    "route_health monetary digest",
  );

  const joinRow = one(
    (
      await reader.query(
        `SELECT
           (SELECT COUNT(*)::int
              FROM inbound_delivery i
              JOIN outbound_transfer o
                ON o.origin_chain = i.source_chain
               AND o.nonce = i.source_nonce
               AND o.route = i.route
               AND o.destination_chain = i.destination_chain) AS paired_inbound_outbound,
           (SELECT COUNT(*)::int
              FROM inbound_delivery i
              JOIN pending_claim c
                ON c.chain = i.destination_chain
               AND c.claim_id = i.claim_id
               AND c.source_chain = i.source_chain
               AND c.source_nonce = i.source_nonce
               AND c.route = i.route
             WHERE NOT i.delivered) AS paired_parked_claim,
           (SELECT COUNT(*)::int
              FROM inbound_delivery i
              LEFT JOIN pending_claim c
                ON c.chain = i.destination_chain
               AND c.claim_id = i.claim_id
             WHERE NOT i.delivered
               AND c.claim_id IS NULL) AS orphaned_parked_inbound,
           (SELECT COUNT(*)::int
              FROM rail_attestation ra
              JOIN outbound_transfer o ON o.id = ra.transfer_id) AS bound_attestations,
           (SELECT COUNT(*)::int
              FROM rail_attestation ra
              JOIN outbound_transfer o ON o.id = ra.transfer_id
              LEFT JOIN inbound_delivery i
                ON i.destination_chain = o.destination_chain
               AND i.route = o.route
               AND i.source_chain = o.origin_chain
               AND i.source_nonce = o.nonce
             WHERE ra.status = 'delivered'
               AND i.id IS NULL) AS unproven_delivered_attestations,
           (SELECT COUNT(*)::int
              FROM outbound_transfer o
              JOIN indexer_cursor ic ON ic.chain_key = o.origin_chain
             WHERE o.origin_block > ic.last_processed) AS cursor_watermark_violations`,
      )
    ).rows,
    "provenance join summary",
  );

  return {
    monetaryDigests: {
      outboundGrossTotal: text(outboundAgg, "gross_total"),
      outboundFeeTotal: text(outboundAgg, "fee_total"),
      outboundNetTotal: text(outboundAgg, "net_total"),
      inboundAmountTotal: text(inboundAgg, "amount_total"),
      inboundDeliveredTotal: text(inboundAgg, "delivered_total"),
      inboundParkedTotal: text(inboundAgg, "parked_total"),
      pendingClaimAmountTotal: text(claimAgg, "amount_total"),
      pendingClaimSettledTotal: text(claimAgg, "settled_total"),
      pendingClaimUnsettledTotal: text(claimAgg, "unsettled_total"),
      routeHealthFlowTotal: text(healthAgg, "flow_total"),
    },
    joins: {
      pairedInboundToOutbound: integer(joinRow, "paired_inbound_outbound"),
      pairedParkedInboundToClaim: integer(joinRow, "paired_parked_claim"),
      orphanedParkedInbound: integer(joinRow, "orphaned_parked_inbound"),
      boundAttestationsToOutbound: integer(joinRow, "bound_attestations"),
      unprovenDeliveredAttestations: integer(joinRow, "unproven_delivered_attestations"),
      cursorWatermarkViolations: integer(joinRow, "cursor_watermark_violations"),
    },
  };
}

export async function exportIndexedSnapshot(
  db: Queryable | Transactional,
  options: { readonly now?: () => Date } = {},
): Promise<IndexedDatasetSnapshot> {
  const exportedAt = (options.now ? options.now() : new Date()).toISOString();

  return runReadOnlySnapshot(db, async (reader) => {
    const schema = await readSchemaSignature(reader);
    assertSchemaCompatible(schema, schema);

    const cursorRes = await reader.query(
      `SELECT chain_key,
              family,
              contract,
              last_processed::text AS last_processed,
              to_char(last_processed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_processed_at,
              last_processed_hash,
              to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
         FROM indexer_cursor
        ORDER BY chain_key ASC`,
    );

    const outboundRes = await reader.query(
      `SELECT id::text AS id,
              origin_chain,
              route,
              nonce::text AS nonce,
              sender,
              token,
              gross_amount::text AS gross_amount,
              fee::text AS fee,
              net_amount::text AS net_amount,
              destination_chain,
              destination,
              rail_ref,
              origin_block::text AS origin_block,
              origin_tx,
              origin_log_index,
              to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at
         FROM outbound_transfer
        ORDER BY id ASC`,
    );

    const inboundRes = await reader.query(
      `SELECT id::text AS id,
              destination_chain,
              route,
              source_chain,
              source_nonce::text AS source_nonce,
              rail_message_id,
              recipient,
              token,
              amount::text AS amount,
              delivered,
              claim_id::text AS claim_id,
              destination_block::text AS destination_block,
              destination_tx,
              destination_log_index,
              to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at
         FROM inbound_delivery
        ORDER BY id ASC`,
    );

    const claimRes = await reader.query(
      `SELECT chain,
              claim_id::text AS claim_id,
              recipient,
              token,
              amount::text AS amount,
              route,
              source_chain,
              source_nonce::text AS source_nonce,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
              settled,
              to_char(settled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS settled_at,
              settled_by,
              settled_tx,
              to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at
         FROM pending_claim
        ORDER BY chain ASC, claim_id ASC`,
    );

    const attestationRes = await reader.query(
      `SELECT transfer_id::text AS transfer_id,
              route,
              status,
              rail_status,
              rail_reference,
              to_char(attested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS attested_at,
              to_char(last_checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_checked_at,
              check_failures,
              last_error,
              to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
         FROM rail_attestation
        ORDER BY transfer_id ASC`,
    );

    const actionRes = await reader.query(
      `SELECT chain,
              action_id::text AS action_id,
              kind,
              state,
              payload,
              to_char(eta AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS eta,
              to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at,
              to_char(queued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS queued_at,
              to_char(settled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS settled_at,
              actor,
              to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at
         FROM admin_action
        ORDER BY chain ASC, action_id ASC`,
    );

    const healthRes = await reader.query(
      `SELECT id::text AS id,
              to_char(sampled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sampled_at,
              origin_chain,
              destination_chain,
              route,
              token,
              available,
              blocker,
              flow_available::text AS flow_available,
              median_seconds
         FROM route_health
        ORDER BY id ASC`,
    );

    const tables: IndexedDatasetSnapshot["tables"] = {
      indexer_cursor: cursorRes.rows.map((row) => ({
        chain_key: text(row, "chain_key"),
        family: text(row, "family"),
        contract: text(row, "contract"),
        last_processed: text(row, "last_processed"),
        last_processed_at: textOrNull(row, "last_processed_at"),
        last_processed_hash: textOrNull(row, "last_processed_hash"),
        updated_at: text(row, "updated_at"),
      })),
      outbound_transfer: outboundRes.rows.map((row) => ({
        id: text(row, "id"),
        origin_chain: text(row, "origin_chain"),
        route: integer(row, "route"),
        nonce: text(row, "nonce"),
        sender: text(row, "sender"),
        token: text(row, "token"),
        gross_amount: text(row, "gross_amount"),
        fee: text(row, "fee"),
        net_amount: text(row, "net_amount"),
        destination_chain: text(row, "destination_chain"),
        destination: text(row, "destination"),
        rail_ref: textOrNull(row, "rail_ref"),
        origin_block: text(row, "origin_block"),
        origin_tx: text(row, "origin_tx"),
        origin_log_index: integerOrNull(row, "origin_log_index"),
        observed_at: text(row, "observed_at"),
      })),
      inbound_delivery: inboundRes.rows.map((row) => ({
        id: text(row, "id"),
        destination_chain: text(row, "destination_chain"),
        route: integer(row, "route"),
        source_chain: text(row, "source_chain"),
        source_nonce: text(row, "source_nonce"),
        rail_message_id: textOrNull(row, "rail_message_id"),
        recipient: text(row, "recipient"),
        token: text(row, "token"),
        amount: text(row, "amount"),
        delivered: boolean(row, "delivered"),
        claim_id: textOrNull(row, "claim_id"),
        destination_block: text(row, "destination_block"),
        destination_tx: text(row, "destination_tx"),
        destination_log_index: integerOrNull(row, "destination_log_index"),
        observed_at: text(row, "observed_at"),
      })),
      pending_claim: claimRes.rows.map((row) => ({
        chain: text(row, "chain"),
        claim_id: text(row, "claim_id"),
        recipient: text(row, "recipient"),
        token: text(row, "token"),
        amount: text(row, "amount"),
        route: integer(row, "route"),
        source_chain: text(row, "source_chain"),
        source_nonce: text(row, "source_nonce"),
        created_at: text(row, "created_at"),
        settled: boolean(row, "settled"),
        settled_at: textOrNull(row, "settled_at"),
        settled_by: textOrNull(row, "settled_by"),
        settled_tx: textOrNull(row, "settled_tx"),
        observed_at: text(row, "observed_at"),
      })),
      rail_attestation: attestationRes.rows.map((row) => ({
        transfer_id: text(row, "transfer_id"),
        route: integer(row, "route"),
        status: text(row, "status"),
        rail_status: textOrNull(row, "rail_status"),
        rail_reference: textOrNull(row, "rail_reference"),
        attested_at: textOrNull(row, "attested_at"),
        last_checked_at: textOrNull(row, "last_checked_at"),
        check_failures: integer(row, "check_failures"),
        last_error: textOrNull(row, "last_error"),
        updated_at: text(row, "updated_at"),
      })),
      admin_action: actionRes.rows.map((row) => ({
        chain: text(row, "chain"),
        action_id: text(row, "action_id"),
        kind: integer(row, "kind"),
        state: text(row, "state"),
        payload: json(row, "payload"),
        eta: textOrNull(row, "eta"),
        expires_at: textOrNull(row, "expires_at"),
        queued_at: text(row, "queued_at"),
        settled_at: textOrNull(row, "settled_at"),
        actor: textOrNull(row, "actor"),
        observed_at: text(row, "observed_at"),
      })),
      route_health: healthRes.rows.map((row) => ({
        id: text(row, "id"),
        sampled_at: text(row, "sampled_at"),
        origin_chain: text(row, "origin_chain"),
        destination_chain: text(row, "destination_chain"),
        route: integer(row, "route"),
        token: text(row, "token"),
        available: boolean(row, "available"),
        blocker: integer(row, "blocker"),
        flow_available: textOrNull(row, "flow_available"),
        median_seconds: integerOrNull(row, "median_seconds"),
      })),
    };

    const { monetaryDigests, joins } = await computeMonetaryAndJoinSummary(reader);

    const tableDigests: Record<RehearsalTableName, string> = {
      indexer_cursor: sha256Json(tables.indexer_cursor),
      outbound_transfer: sha256Json(tables.outbound_transfer),
      inbound_delivery: sha256Json(tables.inbound_delivery),
      pending_claim: sha256Json(tables.pending_claim),
      rail_attestation: sha256Json(tables.rail_attestation),
      admin_action: sha256Json(tables.admin_action),
      route_health: sha256Json(tables.route_health),
    };

    const counts: SnapshotCounts = {
      indexer_cursor: tables.indexer_cursor.length,
      outbound_transfer: tables.outbound_transfer.length,
      inbound_delivery: tables.inbound_delivery.length,
      pending_claim: tables.pending_claim.length,
      rail_attestation: tables.rail_attestation.length,
      admin_action: tables.admin_action.length,
      route_health: tables.route_health.length,
    };

    const datasetDigest = sha256Json({
      counts,
      monetaryDigests,
      joins,
      tableDigests,
    });

    return {
      formatVersion: "hyperion.rehearsal.v1",
      exportedAt,
      schema,
      manifest: {
        counts,
        monetaryDigests,
        joins,
        tableDigests,
        datasetDigest,
      },
      tables,
    };
  });
}

async function resetSerialSequence(
  tx: Queryable,
  tableName: "outbound_transfer" | "inbound_delivery" | "route_health",
): Promise<void> {
  await tx.query(
    `SELECT CASE
       WHEN MAX(id) IS NULL THEN setval(pg_get_serial_sequence($1, 'id'), 1, false)
       ELSE setval(pg_get_serial_sequence($1, 'id'), MAX(id), true)
     END
       FROM ${tableName}`,
    [tableName],
  );
}

export async function verifyRestoredSnapshot(
  targetDb: Queryable | Transactional,
  expectedManifest: SnapshotManifest,
): Promise<VerificationReport> {
  const reExported = await exportIndexedSnapshot(targetDb);
  const actual = reExported.manifest;
  const mismatches: string[] = [];

  for (const table of REHEARSAL_TABLES) {
    if (actual.counts[table] !== expectedManifest.counts[table]) {
      mismatches.push(
        `count_mismatch:${table}:expected=${String(expectedManifest.counts[table])},actual=${String(actual.counts[table])}`,
      );
    }
    if (actual.tableDigests[table] !== expectedManifest.tableDigests[table]) {
      mismatches.push(
        `table_digest_mismatch:${table}:expected=${expectedManifest.tableDigests[table]},actual=${actual.tableDigests[table]}`,
      );
    }
  }

  for (const key of Object.keys(expectedManifest.monetaryDigests) as (keyof MonetaryDigests)[]) {
    if (actual.monetaryDigests[key] !== expectedManifest.monetaryDigests[key]) {
      mismatches.push(
        `monetary_digest_mismatch:${key}:expected=${expectedManifest.monetaryDigests[key]},actual=${actual.monetaryDigests[key]}`,
      );
    }
  }

  for (const key of Object.keys(expectedManifest.joins) as (keyof ProvenanceJoinSummary)[]) {
    if (actual.joins[key] !== expectedManifest.joins[key]) {
      mismatches.push(
        `join_parity_mismatch:${key}:expected=${String(expectedManifest.joins[key])},actual=${String(actual.joins[key])}`,
      );
    }
  }

  if (actual.joins.orphanedParkedInbound > 0) {
    mismatches.push(
      `invariant_violation:orphaned_parked_inbound=${String(actual.joins.orphanedParkedInbound)}`,
    );
  }
  if (actual.joins.unprovenDeliveredAttestations > 0) {
    mismatches.push(
      `invariant_violation:unproven_delivered_attestations=${String(actual.joins.unprovenDeliveredAttestations)}`,
    );
  }
  if (actual.joins.cursorWatermarkViolations > 0) {
    mismatches.push(
      `invariant_violation:cursor_watermark_violations=${String(actual.joins.cursorWatermarkViolations)}`,
    );
  }

  return {
    ok: mismatches.length === 0,
    mismatches,
    actualManifest: actual,
  };
}

export async function restoreIndexedSnapshot(
  targetDb: Transactional,
  snapshot: IndexedDatasetSnapshot,
  safetyOptions: TargetSafetyOptions & { readonly skipLiveDbNameCheck?: boolean },
): Promise<VerificationReport> {
  const identity = assertRestoreTargetSafe(safetyOptions);

  if (safetyOptions.skipLiveDbNameCheck !== true) {
    const dbRow = one(
      (await targetDb.query("SELECT current_database() AS current_db")).rows,
      "current_database",
    );
    const liveDbName = text(dbRow, "current_db");
    if (liveDbName !== identity.databaseName) {
      throw new RehearsalSafetyError(
        "target_database_mismatch",
        `connected database '${liveDbName}' does not match configured target '${identity.databaseName}'`,
      );
    }
  }

  const targetSchema = await readSchemaSignature(targetDb);
  assertSchemaCompatible(snapshot.schema, targetSchema);

  await targetDb.transaction(async (tx) => {
    await tx.query(
      `TRUNCATE TABLE
         rail_attestation,
         route_health,
         admin_action,
         pending_claim,
         inbound_delivery,
         outbound_transfer,
         indexer_cursor
       RESTART IDENTITY CASCADE`,
    );

    for (const row of snapshot.tables.indexer_cursor) {
      await tx.query(
        `INSERT INTO indexer_cursor
           (chain_key, family, contract, last_processed, last_processed_at, last_processed_hash, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          row.chain_key,
          row.family,
          row.contract,
          row.last_processed,
          row.last_processed_at,
          row.last_processed_hash,
          row.updated_at,
        ],
      );
    }

    for (const row of snapshot.tables.outbound_transfer) {
      await tx.query(
        `INSERT INTO outbound_transfer
           (id, origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
            destination_chain, destination, rail_ref, origin_block, origin_tx, origin_log_index,
            observed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          row.id,
          row.origin_chain,
          row.route,
          row.nonce,
          row.sender,
          row.token,
          row.gross_amount,
          row.fee,
          row.net_amount,
          row.destination_chain,
          row.destination,
          row.rail_ref,
          row.origin_block,
          row.origin_tx,
          row.origin_log_index,
          row.observed_at,
        ],
      );
    }

    for (const row of snapshot.tables.inbound_delivery) {
      await tx.query(
        `INSERT INTO inbound_delivery
           (id, destination_chain, route, source_chain, source_nonce, rail_message_id, recipient,
            token, amount, delivered, claim_id, destination_block, destination_tx,
            destination_log_index, observed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          row.id,
          row.destination_chain,
          row.route,
          row.source_chain,
          row.source_nonce,
          row.rail_message_id,
          row.recipient,
          row.token,
          row.amount,
          row.delivered,
          row.claim_id,
          row.destination_block,
          row.destination_tx,
          row.destination_log_index,
          row.observed_at,
        ],
      );
    }

    for (const row of snapshot.tables.pending_claim) {
      await tx.query(
        `INSERT INTO pending_claim
           (chain, claim_id, recipient, token, amount, route, source_chain, source_nonce,
            created_at, settled, settled_at, settled_by, settled_tx, observed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          row.chain,
          row.claim_id,
          row.recipient,
          row.token,
          row.amount,
          row.route,
          row.source_chain,
          row.source_nonce,
          row.created_at,
          row.settled,
          row.settled_at,
          row.settled_by,
          row.settled_tx,
          row.observed_at,
        ],
      );
    }

    for (const row of snapshot.tables.rail_attestation) {
      await tx.query(
        `INSERT INTO rail_attestation
           (transfer_id, route, status, rail_status, rail_reference, attested_at, last_checked_at,
            check_failures, last_error, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          row.transfer_id,
          row.route,
          row.status,
          row.rail_status,
          row.rail_reference,
          row.attested_at,
          row.last_checked_at,
          row.check_failures,
          row.last_error,
          row.updated_at,
        ],
      );
    }

    for (const row of snapshot.tables.admin_action) {
      await tx.query(
        `INSERT INTO admin_action
           (chain, action_id, kind, state, payload, eta, expires_at, queued_at, settled_at, actor,
            observed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          row.chain,
          row.action_id,
          row.kind,
          row.state,
          JSON.stringify(row.payload),
          row.eta,
          row.expires_at,
          row.queued_at,
          row.settled_at,
          row.actor,
          row.observed_at,
        ],
      );
    }

    for (const row of snapshot.tables.route_health) {
      await tx.query(
        `INSERT INTO route_health
           (id, sampled_at, origin_chain, destination_chain, route, token, available, blocker,
            flow_available, median_seconds)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          row.id,
          row.sampled_at,
          row.origin_chain,
          row.destination_chain,
          row.route,
          row.token,
          row.available,
          row.blocker,
          row.flow_available,
          row.median_seconds,
        ],
      );
    }

    await resetSerialSequence(tx, "outbound_transfer");
    await resetSerialSequence(tx, "inbound_delivery");
    await resetSerialSequence(tx, "route_health");
  });

  const verification = await verifyRestoredSnapshot(targetDb, snapshot.manifest);
  if (!verification.ok) {
    throw new RehearsalValidationError(
      `restored dataset failed parity verification (${String(verification.mismatches.length)} mismatch(es))`,
      verification.mismatches,
    );
  }
  return verification;
}

/**
 * Seeds a representative cross-chain dataset exercising full-width identifiers, u64-max nonces,
 * uint256 amounts, canonical inbound deliveries, parked/settled claims, and active deployment shapes.
 */
export async function seedRepresentativeDataset(db: Transactional): Promise<void> {
  const stellarRouter = "CDVDU67TASWDY7ECUQWGPIIAYVLFYTGULAQVLMUEYRIBILVHKJHBCPSI";
  const stellarToken = "CD5IB466XCQIUDYWV22PUMJTF6EE3KPXBDGLLBSKAPNE6QPXVUZLXJGA";
  const stellarSender = "GC4FD5G3CZJ57VPYTVNWU4FRDLLV37EYDGT3OVZA35WKHBWDI6PKTYTN";
  const stellarRecipient = "GD4IEL76RCF2CULJZAKDTEZOQIIUTH3JDKY52W7SR6GBI42PZFIZGWIB";
  const stellarSettler = "GCK4I7AM6GVA5XORMZ6SZHJUNNSDYBBXWNYUQHHQLAMGAMZUNG3PJWI6";

  const u64Max = 18_446_744_073_709_551_615n;
  const largeGross = 100_000_000_000_000_000_000_000_000_000n;
  const largeFee = 300_000_000_000_000_000_000_000_000n;
  const largeNet = largeGross - largeFee;

  await db.transaction(async (tx) => {
    // 1. Outbound Stellar -> Base Sepolia via CCTP (delivered on destination)
    await writeOutbound(
      tx,
      {
        chainKey: "stellar-testnet",
        block: 4_990_100n,
        txHash: "a1".repeat(32),
        logIndex: null,
        observedAt: new Date("2026-10-28T12:00:00.123Z"),
      },
      {
        route: 0,
        nonce: 1n,
        sender: stellarSender,
        token: stellarToken,
        grossAmount: 10_000_000n,
        fee: 30_000n,
        netAmount: 9_970_000n,
        destinationChain: "base-sepolia",
        destination: `0x${"00".repeat(12)}${"ab".repeat(20)}`,
        railRef: null,
      },
    );
    // Exercise sub-millisecond PostgreSQL timestamptz fidelity across export and restore.
    await tx.query(
      `UPDATE outbound_transfer
          SET observed_at = '2026-10-28T12:00:00.123456Z'::timestamptz
        WHERE origin_chain = 'stellar-testnet' AND nonce = 1`,
    );

    // 2. Outbound Stellar -> Sepolia via Axelar ITS at u64_max nonce and large uint256 amount (parked claim)
    await writeOutbound(
      tx,
      {
        chainKey: "stellar-testnet",
        block: 4_990_200n,
        txHash: "b2".repeat(32),
        logIndex: null,
        observedAt: new Date("2026-10-28T12:05:00.654321Z"),
      },
      {
        route: 1,
        nonce: u64Max,
        sender: stellarSender,
        token: stellarToken,
        grossAmount: largeGross,
        fee: largeFee,
        netAmount: largeNet,
        destinationChain: "sepolia",
        destination: `0x${"00".repeat(12)}${"cd".repeat(20)}`,
        railRef: `0x${"ef".repeat(32)}`,
      },
    );

    // Canonical destination delivery for hop 1
    await writeInbound(
      tx,
      {
        chainKey: "base-sepolia",
        block: 18_500_010n,
        txHash: `0x${"c3".repeat(32)}`,
        logIndex: 4,
        observedAt: new Date("2026-10-28T12:02:15.000000Z"),
      },
      {
        route: 0,
        sourceChain: "stellar-testnet",
        sourceNonce: 1n,
        railMessageId: `0x${"99".repeat(32)}`,
        recipient: `0x${"ab".repeat(20)}`,
        token: `0x${"12".repeat(20)}`,
        amount: 997_000n,
        delivered: true,
        claimId: null,
      },
    );

    // Parked destination claim + inbound record for hop 2, plus a second settled Stellar claim
    await writeClaim(
      tx,
      {
        chainKey: "sepolia",
        block: 7_200_100n,
        txHash: `0x${"d4".repeat(32)}`,
        logIndex: 0,
        observedAt: new Date("2026-10-28T12:08:00.000000Z"),
      },
      {
        claimId: 77n,
        recipient: `0x${"cd".repeat(20)}`,
        token: `0x${"34".repeat(20)}`,
        amount: largeNet,
        route: 1,
        sourceChain: "stellar-testnet",
        sourceNonce: u64Max,
        createdAt: new Date("2026-10-28T12:08:00.000000Z"),
      },
    );

    await writeInbound(
      tx,
      {
        chainKey: "sepolia",
        block: 7_200_100n,
        txHash: `0x${"d4".repeat(32)}`,
        logIndex: 1,
        observedAt: new Date("2026-10-28T12:08:00.000000Z"),
      },
      {
        route: 1,
        sourceChain: "stellar-testnet",
        sourceNonce: u64Max,
        railMessageId: `0x${"88".repeat(32)}`,
        recipient: `0x${"cd".repeat(20)}`,
        token: `0x${"34".repeat(20)}`,
        amount: largeNet,
        delivered: false,
        claimId: 77n,
      },
    );

    await writeClaim(
      tx,
      {
        chainKey: "stellar-testnet",
        block: 4_990_150n,
        txHash: "e5".repeat(32),
        logIndex: null,
        observedAt: new Date("2026-10-28T12:03:00.000000Z"),
      },
      {
        claimId: 12n,
        recipient: stellarRecipient,
        token: stellarToken,
        amount: 5_000_000n,
        route: 0,
        sourceChain: "base-sepolia",
        sourceNonce: 9n,
        createdAt: new Date("2026-10-28T12:03:00.000000Z"),
      },
    );

    await settleClaim(
      tx,
      {
        chainKey: "stellar-testnet",
        block: 4_990_180n,
        txHash: "f6".repeat(32),
        logIndex: null,
        observedAt: new Date("2026-10-28T12:04:00.000000Z"),
      },
      12n,
      stellarSettler,
    );

    // Fetch outbound transfer ids so rail_attestation links cleanly.
    const outboundIds = await tx.query(
      "SELECT id, nonce::text AS nonce FROM outbound_transfer ORDER BY id ASC",
    );
    const firstOutbound = outboundIds.rows[0];
    const secondOutbound = outboundIds.rows[1];
    if (!firstOutbound || !secondOutbound) {
      throw new Error("expected two seeded outbound_transfer rows");
    }
    const idForNonce1 = BigInt(text(firstOutbound, "id"));
    const idForU64 = BigInt(text(secondOutbound, "id"));

    // Hop 1 has canonical inbound_delivery so status = 'delivered' is backed by destination proof.
    await writeAttestation(tx, {
      transferId: idForNonce1,
      route: 0,
      status: "delivered",
      railStatus: "complete",
      railReference: `0x${"99".repeat(32)}`,
      attestedAt: new Date("2026-10-28T12:01:00.000000Z"),
      checkedAt: new Date("2026-10-28T12:02:20.000000Z"),
      checkFailures: 0,
      lastError: null,
    });

    // Hop 2 is attested and parked on destination.
    await writeAttestation(tx, {
      transferId: idForU64,
      route: 1,
      status: "attested",
      railStatus: "destination_gateway_approved",
      railReference: `0x${"88".repeat(32)}`,
      attestedAt: new Date("2026-10-28T12:06:00.000000Z"),
      checkedAt: new Date("2026-10-28T12:08:05.000000Z"),
      checkFailures: 0,
      lastError: null,
    });

    await writeAction(
      tx,
      {
        chainKey: "stellar-testnet",
        block: 4_990_050n,
        txHash: "1a".repeat(32),
        logIndex: null,
        observedAt: new Date("2026-10-28T11:55:00.000000Z"),
      },
      {
        actionId: 1n,
        kind: 0,
        payload: { variant: "SetRouteEnabled", route: 0, enabled: true },
        eta: new Date("2026-10-28T11:56:00.000000Z"),
        expiresAt: new Date("2026-10-29T11:56:00.000000Z"),
      },
    );

    await settleAction(
      tx,
      {
        chainKey: "stellar-testnet",
        block: 4_990_090n,
        txHash: "2b".repeat(32),
        logIndex: null,
        observedAt: new Date("2026-10-28T11:57:00.000000Z"),
      },
      1n,
      "executed",
      null,
    );

    await writeHealthSample(
      tx,
      {
        chainKey: "stellar-testnet",
        block: 4_990_200n,
        txHash: "3c".repeat(32),
        logIndex: null,
        observedAt: new Date("2026-10-28T12:05:00.000000Z"),
      },
      {
        originChain: "stellar-testnet",
        destinationChain: "base-sepolia",
        route: 0,
        token: stellarToken,
        available: true,
        blocker: 0,
        flowAvailable: 500_000_000_000n,
      },
    );

    // Active deployment indexes only the Stellar router; no EVM router cursor is fabricated.
    await writeCursor(tx, {
      chainKey: "stellar-testnet",
      family: "stellar",
      contract: stellarRouter,
      position: 4_990_250n,
      observedAt: new Date("2026-10-28T12:10:00.000000Z"),
      hash: null,
    });
  });
}

export interface RehearsalRunSummary {
  readonly exportedAt: string;
  readonly targetRedactedUrl: string;
  readonly targetDatabase: string;
  readonly datasetDigest: string;
  readonly counts: SnapshotCounts;
  readonly monetaryDigests: MonetaryDigests;
  readonly joins: ProvenanceJoinSummary;
}

export async function runBackupRestoreRehearsal(options: {
  readonly sourceDb: Queryable | Transactional;
  readonly targetDb: Transactional;
  readonly targetConnectionString: string;
  readonly seedRepresentative?: boolean;
  readonly exportFilePath?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly allowNonTestTarget?: boolean;
  readonly confirmTargetDatabase?: string;
  readonly skipLiveDbNameCheck?: boolean;
}): Promise<RehearsalRunSummary> {
  const identity = assertRestoreTargetSafe({
    targetConnectionString: options.targetConnectionString,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.allowNonTestTarget === undefined
      ? {}
      : { allowNonTestTarget: options.allowNonTestTarget }),
    ...(options.confirmTargetDatabase === undefined
      ? {}
      : { confirmTargetDatabase: options.confirmTargetDatabase }),
  });

  if (options.seedRepresentative === true) {
    if (!("transaction" in options.sourceDb)) {
      throw new Error("seedRepresentative requires a Transactional source database handle");
    }
    await seedRepresentativeDataset(options.sourceDb);
  }

  const snapshot = await exportIndexedSnapshot(options.sourceDb);

  if (options.exportFilePath !== undefined) {
    const resolvedPath = resolve(options.exportFilePath);
    mkdirSync(dirname(resolvedPath), { recursive: true });
    writeFileSync(resolvedPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }

  const verification = await restoreIndexedSnapshot(options.targetDb, snapshot, {
    targetConnectionString: options.targetConnectionString,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.allowNonTestTarget === undefined
      ? {}
      : { allowNonTestTarget: options.allowNonTestTarget }),
    ...(options.confirmTargetDatabase === undefined
      ? {}
      : { confirmTargetDatabase: options.confirmTargetDatabase }),
    ...(options.skipLiveDbNameCheck === undefined
      ? {}
      : { skipLiveDbNameCheck: options.skipLiveDbNameCheck }),
  });

  return {
    exportedAt: snapshot.exportedAt,
    targetRedactedUrl: identity.redactedUrl,
    targetDatabase: identity.databaseName,
    datasetDigest: verification.actualManifest.datasetDigest,
    counts: verification.actualManifest.counts,
    monetaryDigests: verification.actualManifest.monetaryDigests,
    joins: verification.actualManifest.joins,
  };
}

export interface RehearsalCliArgs {
  readonly sourceUrl: string | undefined;
  readonly targetUrl: string;
  readonly seedRepresentative: boolean;
  readonly exportFile: string | undefined;
  readonly importFile: string | undefined;
  readonly allowNonTestTarget: boolean;
  readonly confirmTargetDb: string | undefined;
  readonly json: boolean;
}

export function parseRehearsalCliArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): RehearsalCliArgs {
  let sourceUrl = env.REHEARSAL_SOURCE_DATABASE_URL;
  let targetUrl = env.REHEARSAL_TARGET_DATABASE_URL ?? env.TEST_DATABASE_URL ?? "";
  let seedRepresentative = false;
  let exportFile: string | undefined;
  let importFile: string | undefined;
  let allowNonTestTarget = false;
  let confirmTargetDb: string | undefined;
  let jsonOutput = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--source-url" && argv[i + 1] !== undefined) {
      sourceUrl = argv[++i];
    } else if (arg === "--target-url" && argv[i + 1] !== undefined) {
      targetUrl = argv[++i] ?? "";
    } else if (arg === "--seed-representative") {
      seedRepresentative = true;
    } else if (arg === "--export-file" && argv[i + 1] !== undefined) {
      exportFile = argv[++i];
    } else if (arg === "--import-file" && argv[i + 1] !== undefined) {
      importFile = argv[++i];
    } else if (arg === "--allow-non-test-target") {
      allowNonTestTarget = true;
    } else if (arg === "--confirm-target-db" && argv[i + 1] !== undefined) {
      confirmTargetDb = argv[++i];
    } else if (arg === "--json") {
      jsonOutput = true;
    } else {
      throw new Error(`unrecognized argument: ${String(arg)}`);
    }
  }

  if (targetUrl.trim().length === 0) {
    throw new RehearsalSafetyError(
      "missing_target_url",
      "target database URL is required via --target-url or REHEARSAL_TARGET_DATABASE_URL",
    );
  }

  return {
    sourceUrl,
    targetUrl,
    seedRepresentative,
    exportFile,
    importFile,
    allowNonTestTarget,
    confirmTargetDb,
    json: jsonOutput,
  };
}

export async function runRehearsalCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  io: { readonly write: (line: string) => void } = {
    write: (line) => {
      process.stdout.write(`${line}\n`);
    },
  },
): Promise<RehearsalRunSummary> {
  const parsed = parseRehearsalCliArgs(argv, env);
  const identity = assertRestoreTargetSafe({
    targetConnectionString: parsed.targetUrl,
    env,
    allowNonTestTarget: parsed.allowNonTestTarget,
    ...(parsed.confirmTargetDb === undefined
      ? {}
      : { confirmTargetDatabase: parsed.confirmTargetDb }),
  });

  const targetDb = Database.open(parsed.targetUrl, {
    applicationName: "hyperion-backup-rehearsal-target",
  });

  try {
    if (parsed.importFile !== undefined) {
      const rawJson = readFileSync(resolve(parsed.importFile), "utf8");
      const snapshot = JSON.parse(rawJson) as IndexedDatasetSnapshot;
      const verification = await restoreIndexedSnapshot(targetDb, snapshot, {
        targetConnectionString: parsed.targetUrl,
        env,
        allowNonTestTarget: parsed.allowNonTestTarget,
        ...(parsed.confirmTargetDb === undefined
          ? {}
          : { confirmTargetDatabase: parsed.confirmTargetDb }),
      });
      const summary: RehearsalRunSummary = {
        exportedAt: snapshot.exportedAt,
        targetRedactedUrl: identity.redactedUrl,
        targetDatabase: identity.databaseName,
        datasetDigest: verification.actualManifest.datasetDigest,
        counts: verification.actualManifest.counts,
        monetaryDigests: verification.actualManifest.monetaryDigests,
        joins: verification.actualManifest.joins,
      };
      io.write(
        parsed.json
          ? JSON.stringify(summary, null, 2)
          : `Rehearsal restore verified on ${summary.targetDatabase} (digest=${summary.datasetDigest})`,
      );
      return summary;
    }

    const effectiveSourceUrl = parsed.sourceUrl ?? parsed.targetUrl;
    if (parsed.seedRepresentative && effectiveSourceUrl === parsed.targetUrl) {
      assertRestoreTargetSafe({
        targetConnectionString: effectiveSourceUrl,
        env,
        allowNonTestTarget: parsed.allowNonTestTarget,
        ...(parsed.confirmTargetDb === undefined
          ? {}
          : { confirmTargetDatabase: parsed.confirmTargetDb }),
      });
    }

    const sourceDb =
      effectiveSourceUrl === parsed.targetUrl
        ? targetDb
        : Database.open(effectiveSourceUrl, {
            applicationName: "hyperion-backup-rehearsal-source",
          });

    try {
      const summary = await runBackupRestoreRehearsal({
        sourceDb,
        targetDb,
        targetConnectionString: parsed.targetUrl,
        seedRepresentative: parsed.seedRepresentative,
        ...(parsed.exportFile === undefined ? {} : { exportFilePath: parsed.exportFile }),
        env,
        allowNonTestTarget: parsed.allowNonTestTarget,
        ...(parsed.confirmTargetDb === undefined
          ? {}
          : { confirmTargetDatabase: parsed.confirmTargetDb }),
      });
      io.write(
        parsed.json
          ? JSON.stringify(summary, null, 2)
          : `Rehearsal export+restore verified on ${summary.targetDatabase} (digest=${summary.datasetDigest})`,
      );
      return summary;
    } finally {
      if (sourceDb !== targetDb) {
        await sourceDb.close();
      }
    }
  } finally {
    await targetDb.close();
  }
}

const isDirectExecution =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  runRehearsalCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? redactDatabaseUrl(error.message) : "rehearsal failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
