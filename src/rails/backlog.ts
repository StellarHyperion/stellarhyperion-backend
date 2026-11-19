/**
 * Read-only inspection of rail backlog age, retry schedules, and missing proof stages.
 */
import { createHash } from "node:crypto";

import type { Transactional } from "../db/pool.js";
import { bigintOf, integer, text, textOrNull, timestamp, timestampOrNull } from "../db/rows.js";
import type {
  AttestationStatus,
  BacklogCandidate,
  BacklogDelayBreakdown,
  BacklogInspectionReport,
  BacklogRetryState,
  MissingProofStage,
  RailRetryClass,
} from "./types.js";

const STAGES: readonly MissingProofStage[] = [
  "provider_discovery",
  "destination_receipt_verification",
  "attestation_reconciliation",
];
const RETRY_CLASSES: readonly RailRetryClass[] = [
  "transient",
  "rate_limited",
  "permanent",
  "exhausted",
];
const RETRY_STATES: readonly BacklogRetryState[] = [
  "never_checked",
  "cooling_down",
  "not_due",
  "overdue",
  "held",
];
const STATUSES: readonly AttestationStatus[] = [
  "pending",
  "attested",
  "delivered",
  "failed",
  "expired",
];
const DEFAULT_ROUTES = [0, 1] as const;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_CURSOR_LENGTH = 512;
const MAX_BIGINT = 9_223_372_036_854_775_807n;

export class BacklogValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BacklogValidationError";
  }
}

export interface InspectRailBacklogOptions {
  readonly routes?: readonly number[];
  readonly destinationChain?: string;
  readonly stage?: MissingProofStage;
  readonly retryClass?: RailRetryClass;
  readonly overdueOnly?: boolean;
  readonly recheckAfterMs?: number;
  readonly maxCheckFailures?: number;
  readonly limit?: number;
  readonly sort?: "asc" | "desc";
  readonly cursor?: string;
  readonly now?: () => Date;
}

interface BacklogCursor {
  readonly sort: "asc" | "desc";
  readonly filters: string;
  readonly asOf: string;
  readonly observedAt: string;
  readonly id: string;
}

const CLASSIFIED = `
  WITH candidates AS (
    SELECT t.id,
           t.route,
           t.origin_chain,
           t.destination_chain,
           t.nonce::text AS nonce_text,
           t.gross_amount::text AS gross_amount_text,
           t.fee::text AS fee_text,
           t.net_amount::text AS net_amount_text,
           t.origin_block::text AS origin_block_text,
           t.origin_tx,
           t.observed_at,
           to_char(t.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at_cursor,
           a.status AS attestation_status,
           a.rail_status,
           a.rail_reference,
           a.attested_at,
           a.last_checked_at,
           a.updated_at AS attestation_updated_at,
           COALESCE(a.check_failures, 0) AS check_failures,
           COALESCE(a.retry_attempts, 0) AS retry_attempts,
           a.retry_class,
           a.next_attempt_at,
           a.last_error,
           CASE
             WHEN EXISTS (
               SELECT 1 FROM inbound_delivery d
                WHERE d.destination_chain = t.destination_chain
                  AND d.route = t.route
                  AND d.source_chain = t.origin_chain
                  AND d.source_nonce = t.nonce
      AND (d.source_transfer_id = t.id OR (d.source_transfer_id IS NULL AND NOT EXISTS (
        SELECT 1 FROM outbound_transfer other
         WHERE other.origin_chain = t.origin_chain AND other.nonce = t.nonce
           AND other.id <> t.id
      )))
             ) OR EXISTS (
               SELECT 1 FROM pending_claim c
                WHERE c.chain = t.destination_chain
                  AND c.route = t.route
                  AND c.source_chain = t.origin_chain
                  AND c.source_nonce = t.nonce
      AND (c.source_transfer_id = t.id OR (c.source_transfer_id IS NULL AND NOT EXISTS (
        SELECT 1 FROM outbound_transfer other
         WHERE other.origin_chain = t.origin_chain AND other.nonce = t.nonce
           AND other.id <> t.id
      )))
             ) THEN 'attestation_reconciliation'
             WHEN a.status = 'attested' OR a.attested_at IS NOT NULL
               THEN 'destination_receipt_verification'
             ELSE 'provider_discovery'
           END AS missing_proof_stage,
           CASE
             WHEN a.retry_class IN ('permanent', 'exhausted')
               OR COALESCE(a.check_failures, 0) >= $3::int THEN 'held'
             WHEN a.next_attempt_at > $4::timestamptz THEN 'cooling_down'
             WHEN a.next_attempt_at IS NOT NULL THEN 'overdue'
             WHEN a.last_checked_at IS NULL THEN 'never_checked'
             WHEN a.last_checked_at + ($5::double precision * INTERVAL '1 millisecond') <= $4::timestamptz
               THEN 'overdue'
             ELSE 'not_due'
           END AS retry_state,
           (
             COALESCE(a.retry_class, '') NOT IN ('permanent', 'exhausted')
             AND COALESCE(a.check_failures, 0) < $3::int
             AND (
               (a.next_attempt_at IS NOT NULL AND a.next_attempt_at <= $4::timestamptz)
               OR (
                 a.next_attempt_at IS NULL
                 AND (a.last_checked_at IS NULL OR
                   a.last_checked_at + ($5::double precision * INTERVAL '1 millisecond') <= $4::timestamptz)
               )
             )
           ) AS overdue
      FROM outbound_transfer t
      LEFT JOIN rail_attestation a ON a.transfer_id = t.id
     WHERE t.route = ANY($1::smallint[])
       AND t.observed_at <= $4::timestamptz
       AND (a.transfer_id IS NULL OR a.status IN ('pending', 'attested'))
       AND ($2::text IS NULL OR t.destination_chain = $2::text)
  ),
  filtered AS (
    SELECT *
      FROM candidates
     WHERE ($6::text IS NULL OR missing_proof_stage = $6::text)
       AND ($7::text IS NULL OR retry_class = $7::text)
       AND (NOT $8::boolean OR overdue)
  )
`;

export async function inspectRailBacklog(
  db: Transactional,
  options: InspectRailBacklogOptions = {},
): Promise<BacklogInspectionReport> {
  const requestedNow = options.now?.() ?? new Date();
  if (Number.isNaN(requestedNow.getTime())) {
    throw new BacklogValidationError("invalid_time", "now must return a valid date");
  }
  const routes = [...new Set(options.routes ?? DEFAULT_ROUTES)].sort((a, b) => a - b);
  if (
    routes.length === 0 ||
    routes.some((route) => !Number.isInteger(route) || route < 0 || route > 3)
  ) {
    throw new BacklogValidationError("invalid_routes", "routes must contain integers from 0 to 3");
  }
  if (options.stage !== undefined && !STAGES.includes(options.stage)) {
    throw new BacklogValidationError("invalid_stage", "unsupported missing proof stage");
  }
  if (options.retryClass !== undefined && !RETRY_CLASSES.includes(options.retryClass)) {
    throw new BacklogValidationError("invalid_retry_class", "unsupported retry class");
  }
  const recheckAfterMs = options.recheckAfterMs ?? 10_000;
  if (!Number.isSafeInteger(recheckAfterMs) || recheckAfterMs < 0) {
    throw new BacklogValidationError(
      "invalid_recheck_window",
      "recheckAfterMs must be non-negative",
    );
  }
  const maxCheckFailures = options.maxCheckFailures ?? 10;
  if (
    !Number.isSafeInteger(maxCheckFailures) ||
    maxCheckFailures < 1 ||
    maxCheckFailures > 2_147_483_647
  ) {
    throw new BacklogValidationError("invalid_max_failures", "maxCheckFailures must be positive");
  }
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new BacklogValidationError(
      "invalid_limit",
      `limit must be from 1 to ${String(MAX_LIMIT)}`,
    );
  }
  const sort = options.sort ?? "asc";
  if (!["asc", "desc"].includes(sort)) {
    throw new BacklogValidationError("invalid_sort", "sort must be 'asc' or 'desc'");
  }

  const destinationValue = options.destinationChain?.trim();
  const destinationChain = destinationValue === "" ? null : (destinationValue ?? null);
  const stage = options.stage ?? null;
  const retryClass = options.retryClass ?? null;
  const overdueOnly = options.overdueOnly === true;
  const filterDigest = digestFilters({
    routes,
    destinationChain,
    stage,
    retryClass,
    overdueOnly,
    recheckAfterMs,
    maxCheckFailures,
  });
  const cursor =
    options.cursor === undefined ? null : decodeCursor(options.cursor, sort, filterDigest);
  const now = cursor === null ? requestedNow : new Date(cursor.asOf);
  const params: readonly unknown[] = [
    routes,
    destinationChain,
    maxCheckFailures,
    now.toISOString(),
    recheckAfterMs,
    stage,
    retryClass,
    overdueOnly,
  ];

  return db.transaction(async (tx) => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const totalsResult = await tx.query(
      `${CLASSIFIED}
         SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE overdue) AS overdue_count,
                COUNT(*) FILTER (WHERE retry_state = 'held') AS held_count,
                MAX(
                  GREATEST(
                    0,
                    FLOOR(EXTRACT(EPOCH FROM ($4::timestamptz - observed_at)) * 1000)
                  )
                ) AS oldest_age_ms,
                MAX(
                  GREATEST(
                    0,
                    FLOOR(EXTRACT(EPOCH FROM (
                      CASE
                        WHEN missing_proof_stage = 'provider_discovery' THEN $4::timestamptz
                        ELSE COALESCE(attested_at, attestation_updated_at, observed_at)
                      END - observed_at
                    )) * 1000)
                  )
                ) AS provider_delay_ms,
                MAX(
                  GREATEST(
                    0,
                    FLOOR(EXTRACT(EPOCH FROM
                      ($4::timestamptz - COALESCE(attested_at, attestation_updated_at, observed_at))) * 1000)
                  )
                ) FILTER (WHERE missing_proof_stage = 'destination_receipt_verification')
                  AS receipt_delay_ms
           FROM filtered`,
      params,
    );
    const groupsResult = await tx.query(
      `${CLASSIFIED}
         SELECT destination_chain, route, missing_proof_stage, retry_class, retry_state, COUNT(*) AS count
           FROM filtered
          GROUP BY destination_chain, route, missing_proof_stage, retry_class, retry_state`,
      params,
    );

    const totals = totalsResult.rows[0];
    if (totals === undefined) throw new Error("rail backlog summary returned no row");
    const summary: BacklogInspectionReport["summary"] = {
      totalMatching: safeCount(totals, "total"),
      overdueCount: safeCount(totals, "overdue_count"),
      heldCount: safeCount(totals, "held_count"),
      oldestAgeMs: numericOrNull(totals.oldest_age_ms),
      maxProviderDiscoveryDelayMs: numericOrNull(totals.provider_delay_ms),
      maxReceiptVerificationDelayMs: numericOrNull(totals.receipt_delay_ms),
      byDestination: {},
      byRoute: {},
      byStage: {
        provider_discovery: 0,
        destination_receipt_verification: 0,
        attestation_reconciliation: 0,
      },
      byRetryClass: {},
      byRetryState: {
        never_checked: 0,
        cooling_down: 0,
        not_due: 0,
        overdue: 0,
        held: 0,
      },
    };
    const byDestination: Record<string, number> = {};
    const byRoute: Record<string, number> = {};
    const byStage = { ...summary.byStage };
    const byRetryClass: Record<string, number> = {};
    const byRetryState = { ...summary.byRetryState };
    for (const row of groupsResult.rows) {
      const count = safeCount(row, "count");
      const destination = text(row, "destination_chain");
      const route = String(integer(row, "route"));
      const proofStage = stageValue(text(row, "missing_proof_stage"));
      const retryState = retryStateValue(text(row, "retry_state"));
      const storedRetryClass = textOrNull(row, "retry_class") ?? "none";
      byDestination[destination] = (byDestination[destination] ?? 0) + count;
      byRoute[route] = (byRoute[route] ?? 0) + count;
      byStage[proofStage] += count;
      byRetryClass[storedRetryClass] = (byRetryClass[storedRetryClass] ?? 0) + count;
      byRetryState[retryState] += count;
    }

    const pageParams: unknown[] = [...params];
    let cursorClause = "";
    if (cursor !== null) {
      pageParams.push(cursor.observedAt, cursor.id);
      const timestampParameter = `$${pageParams.length - 1}`;
      const idParameter = `$${pageParams.length}`;
      const operator = sort === "asc" ? ">" : "<";
      cursorClause =
        `WHERE (observed_at, id) ${operator} ` +
        `(${timestampParameter}::timestamptz, ${idParameter}::bigint)`;
    }
    pageParams.push(limit + 1);
    const limitParameter = `$${pageParams.length}`;
    const order = sort === "asc" ? "ASC" : "DESC";
    const pageResult = await tx.query(
      `${CLASSIFIED}
       SELECT id::text AS id_text, route, origin_chain, destination_chain, nonce_text,
              gross_amount_text, fee_text, net_amount_text, origin_block_text, origin_tx,
              observed_at, observed_at_cursor, attestation_status, rail_status, rail_reference,
              attested_at, last_checked_at, attestation_updated_at, check_failures, retry_attempts, retry_class,
              next_attempt_at, retry_state, last_error, missing_proof_stage, overdue
         FROM filtered
         ${cursorClause}
        ORDER BY observed_at ${order}, id ${order}
        LIMIT ${limitParameter}`,
      pageParams,
    );

    const hasMore = pageResult.rows.length > limit;
    const visibleRows = hasMore ? pageResult.rows.slice(0, limit) : pageResult.rows;
    const candidates = visibleRows.map((row) => mapCandidate(row, now.getTime(), recheckAfterMs));
    const lastRow = visibleRows.at(-1);
    const nextCursor =
      hasMore && lastRow !== undefined
        ? encodeCursor(
            sort,
            filterDigest,
            now.toISOString(),
            text(lastRow, "observed_at_cursor"),
            text(lastRow, "id_text"),
          )
        : null;

    return {
      generatedAt: now.toISOString(),
      readOnly: true,
      parameters: {
        routes,
        destinationChain,
        stage,
        retryClass,
        overdueOnly,
        recheckAfterMs,
        maxCheckFailures,
      },
      summary: {
        ...summary,
        byDestination,
        byRoute,
        byStage,
        byRetryClass,
        byRetryState,
      },
      pageInfo: { limit, sort, hasMore, nextCursor },
      candidates,
    };
  });
}

function mapCandidate(
  row: Record<string, unknown>,
  nowMs: number,
  recheckAfterMs: number,
): BacklogCandidate {
  const observedAt = timestamp(row, "observed_at");
  const attestedAt = timestampOrNull(row, "attested_at");
  const lastCheckedAt = timestampOrNull(row, "last_checked_at");
  const updatedAt = timestampOrNull(row, "attestation_updated_at");
  const proofStage = stageValue(text(row, "missing_proof_stage"));
  const retryState = retryStateValue(text(row, "retry_state"));
  const overdue = row.overdue === true;
  const nextAttemptAt = timestampOrNull(row, "next_attempt_at");
  const dueAt =
    nextAttemptAt ??
    (lastCheckedAt === null ? observedAt : new Date(lastCheckedAt.getTime() + recheckAfterMs));
  const delays: BacklogDelayBreakdown = {
    totalAgeMs: Math.max(0, nowMs - observedAt.getTime()),
    providerDiscoveryDelayMs:
      proofStage === "provider_discovery"
        ? Math.max(0, nowMs - observedAt.getTime())
        : Math.max(0, (attestedAt ?? updatedAt ?? observedAt).getTime() - observedAt.getTime()),
    receiptVerificationDelayMs:
      proofStage === "destination_receipt_verification"
        ? Math.max(0, nowMs - (attestedAt ?? updatedAt ?? observedAt).getTime())
        : null,
    overdueByMs: overdue ? Math.max(0, nowMs - dueAt.getTime()) : 0,
  };
  const attestationStatusText = textOrNull(row, "attestation_status");
  const lastError = textOrNull(row, "last_error");

  return {
    transferId: text(row, "id_text"),
    route: integer(row, "route"),
    originChain: text(row, "origin_chain"),
    destinationChain: text(row, "destination_chain"),
    nonce: text(row, "nonce_text"),
    grossAmount: text(row, "gross_amount_text"),
    fee: text(row, "fee_text"),
    netAmount: text(row, "net_amount_text"),
    originBlock: text(row, "origin_block_text"),
    originTx: text(row, "origin_tx"),
    observedAt: observedAt.toISOString(),
    attestationStatus: attestationStatusText === null ? null : statusValue(attestationStatusText),
    railStatus: sanitizeRailDiagnostic(textOrNull(row, "rail_status")),
    railReference: sanitizeRailDiagnostic(textOrNull(row, "rail_reference")),
    attestedAt: attestedAt?.toISOString() ?? null,
    lastCheckedAt: lastCheckedAt?.toISOString() ?? null,
    checkFailures: integer(row, "check_failures"),
    retryAttempts: integer(row, "retry_attempts"),
    retryClass: retryClassValue(textOrNull(row, "retry_class")),
    retryState,
    lastError: lastError === null ? null : sanitizeRailDiagnostic(lastError),
    missingProofStage: proofStage,
    overdue,
    delays,
  };
}

export function sanitizeRailDiagnostic(value: string | null): string | null {
  if (value === null) return null;
  return value
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, "[REDACTED_URL]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      /\b(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*[^,\s;]+/gi,
      "$1=[REDACTED]",
    )
    .replace(
      /([?&](?:api[_-]?key|apikey|token|secret|password|auth|access_token)=)[^&\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\bS[A-Z2-7]{55}\b/g, "[REDACTED_STELLAR_SECRET]");
}

function digestFilters(input: {
  readonly routes: readonly number[];
  readonly destinationChain: string | null;
  readonly stage: MissingProofStage | null;
  readonly retryClass: RailRetryClass | null;
  readonly overdueOnly: boolean;
  readonly recheckAfterMs: number;
  readonly maxCheckFailures: number;
}): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 32);
}

function encodeCursor(
  sort: "asc" | "desc",
  filters: string,
  asOf: string,
  observedAt: string,
  id: string,
): string {
  const value: BacklogCursor = { sort, filters, asOf, observedAt, id };
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(raw: string, sort: "asc" | "desc", filters: string): BacklogCursor {
  if (!raw || raw.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw new BacklogValidationError("invalid_cursor", "cursor is malformed or too long");
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new BacklogValidationError("invalid_cursor", "cursor could not be decoded");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BacklogValidationError("invalid_cursor", "cursor payload is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    record.sort !== sort ||
    record.filters !== filters ||
    typeof record.asOf !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.asOf) ||
    Number.isNaN(Date.parse(record.asOf)) ||
    typeof record.observedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(record.observedAt) ||
    typeof record.id !== "string" ||
    !/^[1-9]\d{0,18}$/.test(record.id)
  ) {
    throw new BacklogValidationError("invalid_cursor", "cursor does not match the query");
  }
  const id = BigInt(record.id);
  if (id > MAX_BIGINT || Number.isNaN(Date.parse(record.observedAt))) {
    throw new BacklogValidationError("invalid_cursor", "cursor is out of range");
  }
  return {
    sort,
    filters,
    asOf: record.asOf,
    observedAt: record.observedAt,
    id: id.toString(),
  };
}

function stageValue(value: string): MissingProofStage {
  if (!STAGES.includes(value as MissingProofStage)) throw new Error(`unknown proof stage ${value}`);
  return value as MissingProofStage;
}

function retryStateValue(value: string): BacklogRetryState {
  if (!RETRY_STATES.includes(value as BacklogRetryState)) {
    throw new Error(`unknown backlog retry state ${value}`);
  }
  return value as BacklogRetryState;
}

function retryClassValue(value: string | null): RailRetryClass | null {
  if (value === null) return null;
  if (!RETRY_CLASSES.includes(value as RailRetryClass)) {
    throw new Error(`unknown rail retry class ${value}`);
  }
  return value as RailRetryClass;
}

function statusValue(value: string): AttestationStatus {
  if (!STATUSES.includes(value as AttestationStatus)) {
    throw new Error(`unknown rail attestation status ${value}`);
  }
  return value as AttestationStatus;
}

function safeCount(row: Record<string, unknown>, column: string): number {
  const count = bigintOf(row, column);
  if (count < 0n || count > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`rail backlog ${column} exceeds the safe integer range`);
  }
  return Number(count);
}

function numericOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error("rail backlog summary contains an invalid duration");
  }
  return number;
}

export function formatBacklogReportText(report: BacklogInspectionReport): string {
  const lines = [
    `Rail backlog report (${report.generatedAt}) [read-only]`,
    `Matching: ${report.summary.totalMatching}; overdue: ${report.summary.overdueCount}; held: ${report.summary.heldCount}`,
    `Missing proof: provider_discovery=${report.summary.byStage.provider_discovery}, destination_receipt_verification=${report.summary.byStage.destination_receipt_verification}, attestation_reconciliation=${report.summary.byStage.attestation_reconciliation}`,
    `Retry classes: ${
      Object.entries(report.summary.byRetryClass)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([retryClass, count]) => `${retryClass}=${String(count)}`)
        .join(", ") || "none"
    }`,
    `Maximum delays (ms): provider discovery=${report.summary.maxProviderDiscoveryDelayMs ?? "-"}, destination receipt verification=${report.summary.maxReceiptVerificationDelayMs ?? "-"}`,
    `Destinations: ${
      Object.entries(report.summary.byDestination)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([chain, count]) => `${chain}=${String(count)}`)
        .join(", ") || "none"
    }`,
    "",
    "ID | Route | Destination | Nonce | Net amount | Proof stage | Retry class/state | Age ms | Discovery ms | Receipt ms",
  ];
  for (const candidate of report.candidates) {
    lines.push(
      [
        candidate.transferId,
        String(candidate.route),
        candidate.destinationChain,
        candidate.nonce,
        candidate.netAmount,
        candidate.missingProofStage,
        `${candidate.retryClass ?? "none"}/${candidate.retryState}`,
        String(candidate.delays.totalAgeMs),
        candidate.delays.providerDiscoveryDelayMs?.toString() ?? "-",
        candidate.delays.receiptVerificationDelayMs?.toString() ?? "-",
      ].join(" | "),
    );
  }
  if (report.candidates.length === 0) lines.push("No matching backlog candidates.");
  if (report.pageInfo.nextCursor !== null) {
    lines.push("", `Next cursor: ${report.pageInfo.nextCursor}`);
  }
  return `${lines.join("\n")}\n`;
}
