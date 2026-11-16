/**
 * Read-only rail backlog age, missing proof stage, and retry inspection.
 *
 * Separates transfers waiting on external provider discovery (`provider_discovery`) from transfers
 * whose provider already attested or supplied a candidate hash while canonical destination receipt
 * verification is still pending (`destination_receipt_verification`). All queries execute inside a
 * `READ ONLY` transaction when transactional access is provided, ensuring operator inspection never
 * mutates transfer or attestation lifecycle state.
 */
import { createHash } from "node:crypto";

import type { Queryable, Transactional } from "../db/pool.js";
import { integer, text, textOrNull, timestamp, timestampOrNull } from "../db/rows.js";
import type {
  AttestationStatus,
  BacklogCandidate,
  BacklogInspectionReport,
  BacklogRetryClass,
  BacklogSummary,
  MissingProofStage,
} from "./types.js";

const VALID_STAGES: readonly MissingProofStage[] = [
  "provider_discovery",
  "destination_receipt_verification",
  "attestation_reconciliation",
];

const VALID_RETRY_CLASSES: readonly BacklogRetryClass[] = [
  "never_checked",
  "cooling_down",
  "overdue",
  "retry_overdue",
  "exhausted",
];

const VALID_ATTESTATION_STATUSES: readonly AttestationStatus[] = [
  "pending",
  "attested",
  "delivered",
  "failed",
  "expired",
];

const DEFAULT_ROUTES: readonly number[] = [0, 1];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_CURSOR_LENGTH = 512;
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;

export class BacklogValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BacklogValidationError";
    this.code = code;
  }
}

export interface InspectRailBacklogOptions {
  readonly routes?: readonly number[] | undefined;
  readonly destinationChain?: string | undefined;
  readonly stage?: MissingProofStage | undefined;
  readonly retryClass?: BacklogRetryClass | undefined;
  readonly overdueOnly?: boolean | undefined;
  readonly recheckAfterMs?: number | undefined;
  readonly maxCheckFailures?: number | undefined;
  readonly limit?: number | undefined;
  readonly sort?: "asc" | "desc" | undefined;
  readonly cursor?: string | undefined;
  readonly now?: (() => Date) | undefined;
}

interface EncodedBacklogCursorV1 {
  readonly v: 1;
  readonly s: "asc" | "desc";
  readonly f: string;
  readonly ts: string;
  readonly id: string;
}

interface DecodedBacklogCursor {
  readonly observedAtCursor: string;
  readonly lastId: bigint;
}

export function sanitizeRailDiagnostic(detail: string): string {
  return detail
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, "$1[REDACTED]@")
    .replace(
      /([?&](?:api[_-]?key|apikey|token|secret|password|auth|access_token)=)[^&\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bS[A-Z2-7]{55}\b/g, "[REDACTED_STELLAR_SECRET]");
}

function isTransactional(db: Queryable | Transactional): db is Transactional {
  return "transaction" in db && typeof db.transaction === "function";
}

async function runReadOnly<T>(
  db: Queryable | Transactional,
  work: (reader: Queryable) => Promise<T>,
): Promise<T> {
  if (!isTransactional(db)) {
    return work(db);
  }
  return db.transaction(async (tx) => {
    await tx.query("SET TRANSACTION READ ONLY");
    return work(tx);
  });
}

function computeBacklogFilterHash(input: {
  readonly routes: readonly number[];
  readonly destinationChain: string | null;
  readonly stage: MissingProofStage | null;
  readonly retryClass: BacklogRetryClass | null;
  readonly overdueOnly: boolean;
}): string {
  const canonical = JSON.stringify({
    routes: [...input.routes].sort((a, b) => a - b),
    destinationChain: input.destinationChain,
    stage: input.stage,
    retryClass: input.retryClass,
    overdueOnly: input.overdueOnly,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

function encodeBacklogCursor(input: {
  readonly sort: "asc" | "desc";
  readonly filterHash: string;
  readonly observedAtCursor: string;
  readonly lastId: string;
}): string {
  const payload: EncodedBacklogCursorV1 = {
    v: 1,
    s: input.sort,
    f: input.filterHash,
    ts: input.observedAtCursor,
    id: input.lastId,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeBacklogCursor(
  rawCursor: string,
  expectedSort: "asc" | "desc",
  expectedFilterHash: string,
): DecodedBacklogCursor {
  if (
    rawCursor.length === 0 ||
    rawCursor.length > MAX_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(rawCursor)
  ) {
    throw new BacklogValidationError(
      "invalid_cursor",
      "backlog cursor is malformed or exceeds maximum length",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(rawCursor, "base64url").toString("utf8"));
  } catch {
    throw new BacklogValidationError("invalid_cursor", "backlog cursor could not be decoded");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BacklogValidationError("invalid_cursor", "backlog cursor payload is invalid");
  }

  const record = parsed as Record<string, unknown>;
  if (record.v !== 1) {
    throw new BacklogValidationError("invalid_cursor", "backlog cursor version is unsupported");
  }
  if (record.s !== "asc" && record.s !== "desc") {
    throw new BacklogValidationError("invalid_cursor", "backlog cursor sort is invalid");
  }
  if (typeof record.f !== "string" || !/^[0-9a-f]{32}$/.test(record.f)) {
    throw new BacklogValidationError("invalid_cursor", "backlog cursor filter digest is invalid");
  }
  if (
    typeof record.ts !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(record.ts)
  ) {
    throw new BacklogValidationError("invalid_cursor", "backlog cursor timestamp is invalid");
  }
  if (typeof record.id !== "string" || !/^[0-9]{1,19}$/.test(record.id)) {
    throw new BacklogValidationError("invalid_cursor", "backlog cursor id is invalid");
  }

  const lastId = BigInt(record.id);
  if (lastId < 1n || lastId > MAX_POSTGRES_BIGINT) {
    throw new BacklogValidationError("invalid_cursor", "backlog cursor id is out of range");
  }

  if (record.s !== expectedSort) {
    throw new BacklogValidationError(
      "cursor_sort_mismatch",
      "backlog cursor sort direction does not match requested sort",
    );
  }
  if (record.f !== expectedFilterHash) {
    throw new BacklogValidationError(
      "cursor_filter_mismatch",
      "backlog cursor does not match active backlog filters",
    );
  }

  return {
    observedAtCursor: record.ts,
    lastId,
  };
}

function parseAttestationStatus(value: string | null): AttestationStatus | null {
  if (value === null) return null;
  if (!VALID_ATTESTATION_STATUSES.includes(value as AttestationStatus)) {
    throw new Error(`unexpected rail_attestation.status: ${value}`);
  }
  return value as AttestationStatus;
}

function parseStage(value: string): MissingProofStage {
  if (!VALID_STAGES.includes(value as MissingProofStage)) {
    throw new Error(`unexpected missing_proof_stage: ${value}`);
  }
  return value as MissingProofStage;
}

function parseRetryClass(value: string): BacklogRetryClass {
  if (!VALID_RETRY_CLASSES.includes(value as BacklogRetryClass)) {
    throw new Error(`unexpected retry_class: ${value}`);
  }
  return value as BacklogRetryClass;
}

const CLASSIFIED_BACKLOG_CTE = `
  WITH classified AS (
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
           a.last_error,
           CASE
             WHEN EXISTS (
               SELECT 1 FROM inbound_delivery d
                WHERE d.destination_chain = t.destination_chain
                  AND d.route = t.route
                  AND d.source_chain = t.origin_chain
                  AND d.source_nonce = t.nonce
             ) OR EXISTS (
               SELECT 1 FROM pending_claim c
                WHERE c.chain = t.destination_chain
                  AND c.route = t.route
                  AND c.source_chain = t.origin_chain
                  AND c.source_nonce = t.nonce
             ) THEN 'attestation_reconciliation'
             WHEN a.status = 'attested' THEN 'destination_receipt_verification'
             ELSE 'provider_discovery'
           END AS missing_proof_stage,
           CASE
             WHEN COALESCE(a.check_failures, 0) >= $3::int THEN 'exhausted'
             WHEN a.last_checked_at IS NULL THEN 'never_checked'
             WHEN a.last_checked_at >= $4::timestamptz THEN 'cooling_down'
             WHEN COALESCE(a.check_failures, 0) > 0 THEN 'retry_overdue'
             ELSE 'overdue'
           END AS retry_class,
           CASE
             WHEN COALESCE(a.check_failures, 0) >= $3::int THEN true
             WHEN a.last_checked_at IS NULL THEN t.observed_at <= $4::timestamptz
             ELSE a.last_checked_at < $4::timestamptz
           END AS is_overdue
      FROM outbound_transfer t
      LEFT JOIN rail_attestation a ON a.transfer_id = t.id
     WHERE t.route = ANY($1::smallint[])
       AND (a.transfer_id IS NULL OR a.status IN ('pending', 'attested'))
       AND ($2::text IS NULL OR t.destination_chain = $2::text)
  ),
  filtered AS (
    SELECT *
      FROM classified
     WHERE ($5::text IS NULL OR missing_proof_stage = $5::text)
       AND ($6::text IS NULL OR retry_class = $6::text)
       AND (NOT $7::boolean OR is_overdue = true)
  )
`;

function computeCandidateDelays(input: {
  readonly nowMs: number;
  readonly recheckAfterMs: number;
  readonly observedAt: Date;
  readonly attestedAt: Date | null;
  readonly attestationUpdatedAt: Date | null;
  readonly lastCheckedAt: Date | null;
  readonly missingProofStage: MissingProofStage;
  readonly isOverdue: boolean;
}): {
  readonly totalAgeMs: number;
  readonly providerDiscoveryDelayMs: number | null;
  readonly receiptVerificationDelayMs: number | null;
  readonly overdueByMs: number;
} {
  const totalAgeMs = Math.max(0, input.nowMs - input.observedAt.getTime());

  let providerDiscoveryDelayMs: number | null = null;
  if (input.missingProofStage === "provider_discovery") {
    providerDiscoveryDelayMs = totalAgeMs;
  } else if (input.attestedAt !== null) {
    providerDiscoveryDelayMs = Math.max(0, input.attestedAt.getTime() - input.observedAt.getTime());
  }

  let receiptVerificationDelayMs: number | null = null;
  if (input.missingProofStage === "destination_receipt_verification") {
    const verificationAnchor = input.attestedAt ?? input.attestationUpdatedAt ?? input.observedAt;
    receiptVerificationDelayMs = Math.max(0, input.nowMs - verificationAnchor.getTime());
  }

  let overdueByMs = 0;
  if (input.isOverdue) {
    if (input.lastCheckedAt !== null) {
      overdueByMs = Math.max(
        0,
        input.nowMs - (input.lastCheckedAt.getTime() + input.recheckAfterMs),
      );
    } else {
      overdueByMs = Math.max(0, totalAgeMs - input.recheckAfterMs);
    }
  }

  return {
    totalAgeMs,
    providerDiscoveryDelayMs,
    receiptVerificationDelayMs,
    overdueByMs,
  };
}

export async function inspectRailBacklog(
  db: Queryable | Transactional,
  options: InspectRailBacklogOptions = {},
): Promise<BacklogInspectionReport> {
  const now = options.now ? options.now() : new Date();
  const nowMs = now.getTime();

  const rawRoutes = options.routes ?? DEFAULT_ROUTES;
  if (rawRoutes.length === 0) {
    throw new BacklogValidationError("invalid_routes", "at least one rail route must be specified");
  }
  const routes = [...new Set(rawRoutes)].sort((a, b) => a - b);
  for (const route of routes) {
    if (!Number.isInteger(route) || route < 0 || route > 3) {
      throw new BacklogValidationError(
        "invalid_routes",
        `route must be an integer between 0 and 3, got ${String(route)}`,
      );
    }
  }

  const destinationChain =
    options.destinationChain !== undefined && options.destinationChain.trim().length > 0
      ? options.destinationChain.trim()
      : null;

  const stage = options.stage ?? null;
  if (stage !== null && !VALID_STAGES.includes(stage)) {
    throw new BacklogValidationError("invalid_stage", "unsupported missing proof stage filter");
  }

  const retryClass = options.retryClass ?? null;
  if (retryClass !== null && !VALID_RETRY_CLASSES.includes(retryClass)) {
    throw new BacklogValidationError("invalid_retry_class", "unsupported retry class filter");
  }

  const overdueOnly = options.overdueOnly === true;
  const recheckAfterMs = options.recheckAfterMs ?? 10_000;
  if (!Number.isInteger(recheckAfterMs) || recheckAfterMs < 0) {
    throw new BacklogValidationError(
      "invalid_recheck_window",
      "recheckAfterMs must be a non-negative integer",
    );
  }

  const maxCheckFailures = options.maxCheckFailures ?? 10;
  if (!Number.isInteger(maxCheckFailures) || maxCheckFailures < 1) {
    throw new BacklogValidationError(
      "invalid_max_failures",
      "maxCheckFailures must be a positive integer",
    );
  }

  const rawLimit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_LIMIT) {
    throw new BacklogValidationError(
      "invalid_limit",
      `limit must be an integer between 1 and ${String(MAX_LIMIT)}`,
    );
  }

  const rawSort: string = options.sort ?? "asc";
  if (rawSort !== "asc" && rawSort !== "desc") {
    throw new BacklogValidationError("invalid_sort", "sort must be 'asc' or 'desc'");
  }
  const sort = rawSort;

  const filterHash = computeBacklogFilterHash({
    routes,
    destinationChain,
    stage,
    retryClass,
    overdueOnly,
  });

  const decodedCursor =
    options.cursor !== undefined ? decodeBacklogCursor(options.cursor, sort, filterHash) : null;

  const notCheckedSince = new Date(nowMs - recheckAfterMs);
  const baseParams: readonly unknown[] = [
    routes,
    destinationChain,
    maxCheckFailures,
    notCheckedSince.toISOString(),
    stage,
    retryClass,
    overdueOnly,
  ];

  return runReadOnly(db, async (reader) => {
    const summaryRowsResult = await reader.query(
      `${CLASSIFIED_BACKLOG_CTE}
       SELECT destination_chain,
              route,
              missing_proof_stage,
              retry_class,
              is_overdue,
              observed_at,
              attested_at,
              attestation_updated_at
         FROM filtered`,
      baseParams,
    );

    const byDestination: Record<string, number> = {};
    const byRoute: Record<string, number> = {};
    const byStage: Record<MissingProofStage, number> = {
      provider_discovery: 0,
      destination_receipt_verification: 0,
      attestation_reconciliation: 0,
    };
    const byRetryClass: Record<BacklogRetryClass, number> = {
      never_checked: 0,
      cooling_down: 0,
      overdue: 0,
      retry_overdue: 0,
      exhausted: 0,
    };

    let overdueCount = 0;
    let exhaustedCount = 0;
    let oldestAgeMs: number | null = null;
    let maxProviderDiscoveryDelayMs: number | null = null;
    let maxReceiptVerificationDelayMs: number | null = null;

    for (const row of summaryRowsResult.rows) {
      const dest = text(row, "destination_chain");
      const routeNum = String(integer(row, "route"));
      const rowStage = parseStage(text(row, "missing_proof_stage"));
      const rowRetry = parseRetryClass(text(row, "retry_class"));
      const isOverdue = row.is_overdue === true;
      const observedAt = timestamp(row, "observed_at");
      const attestedAt = timestampOrNull(row, "attested_at");
      const attestationUpdatedAt = timestampOrNull(row, "attestation_updated_at");

      byDestination[dest] = (byDestination[dest] ?? 0) + 1;
      byRoute[routeNum] = (byRoute[routeNum] ?? 0) + 1;
      byStage[rowStage] += 1;
      byRetryClass[rowRetry] += 1;
      if (isOverdue) overdueCount += 1;
      if (rowRetry === "exhausted") exhaustedCount += 1;

      const delays = computeCandidateDelays({
        nowMs,
        recheckAfterMs,
        observedAt,
        attestedAt,
        attestationUpdatedAt,
        lastCheckedAt: null,
        missingProofStage: rowStage,
        isOverdue,
      });

      oldestAgeMs =
        oldestAgeMs === null ? delays.totalAgeMs : Math.max(oldestAgeMs, delays.totalAgeMs);
      if (delays.providerDiscoveryDelayMs !== null) {
        maxProviderDiscoveryDelayMs =
          maxProviderDiscoveryDelayMs === null
            ? delays.providerDiscoveryDelayMs
            : Math.max(maxProviderDiscoveryDelayMs, delays.providerDiscoveryDelayMs);
      }
      if (delays.receiptVerificationDelayMs !== null) {
        maxReceiptVerificationDelayMs =
          maxReceiptVerificationDelayMs === null
            ? delays.receiptVerificationDelayMs
            : Math.max(maxReceiptVerificationDelayMs, delays.receiptVerificationDelayMs);
      }
    }

    const summary: BacklogSummary = {
      totalMatching: summaryRowsResult.rows.length,
      overdueCount,
      exhaustedCount,
      oldestAgeMs,
      maxProviderDiscoveryDelayMs,
      maxReceiptVerificationDelayMs,
      byDestination,
      byRoute,
      byStage,
      byRetryClass,
    };

    const pageParams = [...baseParams];
    let cursorClause = "";
    if (decodedCursor !== null) {
      pageParams.push(decodedCursor.observedAtCursor);
      const tsParam = `$${String(pageParams.length)}`;
      pageParams.push(decodedCursor.lastId.toString());
      const idParam = `$${String(pageParams.length)}`;
      cursorClause =
        sort === "asc"
          ? `WHERE (observed_at > ${tsParam}::timestamptz OR (observed_at = ${tsParam}::timestamptz AND id > ${idParam}::bigint))`
          : `WHERE (observed_at < ${tsParam}::timestamptz OR (observed_at = ${tsParam}::timestamptz AND id < ${idParam}::bigint))`;
    }

    pageParams.push(rawLimit + 1);
    const limitParam = `$${String(pageParams.length)}`;
    const orderClause =
      sort === "asc" ? "ORDER BY observed_at ASC, id ASC" : "ORDER BY observed_at DESC, id DESC";

    const pageResult = await reader.query(
      `${CLASSIFIED_BACKLOG_CTE}
       SELECT id::text AS id_text,
              route,
              origin_chain,
              destination_chain,
              nonce_text,
              gross_amount_text,
              fee_text,
              net_amount_text,
              origin_block_text,
              origin_tx,
              observed_at,
              observed_at_cursor,
              attestation_status,
              rail_status,
              rail_reference,
              attested_at,
              last_checked_at,
              attestation_updated_at,
              check_failures,
              last_error,
              missing_proof_stage,
              retry_class,
              is_overdue
         FROM filtered
         ${cursorClause}
         ${orderClause}
         LIMIT ${limitParam}`,
      pageParams,
    );

    const hasMore = pageResult.rows.length > rawLimit;
    const visibleRows = hasMore ? pageResult.rows.slice(0, rawLimit) : pageResult.rows;

    const candidates: BacklogCandidate[] = visibleRows.map((row) => {
      const idText = text(row, "id_text");
      const observedAt = timestamp(row, "observed_at");
      const attestedAt = timestampOrNull(row, "attested_at");
      const lastCheckedAt = timestampOrNull(row, "last_checked_at");
      const attestationUpdatedAt = timestampOrNull(row, "attestation_updated_at");
      const rowStage = parseStage(text(row, "missing_proof_stage"));
      const rowRetry = parseRetryClass(text(row, "retry_class"));
      const isOverdue = row.is_overdue === true;
      const rawError = textOrNull(row, "last_error");

      return {
        transferId: idText,
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
        attestationStatus: parseAttestationStatus(textOrNull(row, "attestation_status")),
        railStatus: textOrNull(row, "rail_status"),
        railReference: textOrNull(row, "rail_reference"),
        attestedAt: attestedAt ? attestedAt.toISOString() : null,
        lastCheckedAt: lastCheckedAt ? lastCheckedAt.toISOString() : null,
        checkFailures: integer(row, "check_failures"),
        lastError: rawError !== null ? sanitizeRailDiagnostic(rawError) : null,
        missingProofStage: rowStage,
        retryClass: rowRetry,
        overdue: isOverdue,
        delays: computeCandidateDelays({
          nowMs,
          recheckAfterMs,
          observedAt,
          attestedAt,
          attestationUpdatedAt,
          lastCheckedAt,
          missingProofStage: rowStage,
          isOverdue,
        }),
      };
    });

    const lastVisibleRow = visibleRows.at(-1);
    const nextCursor =
      hasMore && lastVisibleRow !== undefined
        ? encodeBacklogCursor({
            sort,
            filterHash,
            observedAtCursor: text(lastVisibleRow, "observed_at_cursor"),
            lastId: text(lastVisibleRow, "id_text"),
          })
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
      summary,
      pageInfo: {
        limit: rawLimit,
        sort,
        hasMore,
        nextCursor,
      },
      candidates,
    };
  });
}

export function formatBacklogReportText(report: BacklogInspectionReport): string {
  const lines: string[] = [
    `Rail Backlog Report (${report.generatedAt}) [read-only]`,
    `Total matching: ${String(report.summary.totalMatching)} | Overdue: ${String(report.summary.overdueCount)} | Exhausted: ${String(report.summary.exhaustedCount)}`,
    `Stages: provider_discovery=${String(report.summary.byStage.provider_discovery)}, destination_receipt_verification=${String(report.summary.byStage.destination_receipt_verification)}, attestation_reconciliation=${String(report.summary.byStage.attestation_reconciliation)}`,
    `Retry classes: never_checked=${String(report.summary.byRetryClass.never_checked)}, cooling_down=${String(report.summary.byRetryClass.cooling_down)}, overdue=${String(report.summary.byRetryClass.overdue)}, retry_overdue=${String(report.summary.byRetryClass.retry_overdue)}, exhausted=${String(report.summary.byRetryClass.exhausted)}`,
    `Max delays (ms): oldest=${String(report.summary.oldestAgeMs ?? 0)}, provider_discovery=${String(report.summary.maxProviderDiscoveryDelayMs ?? 0)}, receipt_verification=${String(report.summary.maxReceiptVerificationDelayMs ?? 0)}`,
  ];

  const destPairs = Object.entries(report.summary.byDestination)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([chain, count]) => `${chain}:${String(count)}`);
  lines.push(`Destinations: ${destPairs.length > 0 ? destPairs.join(", ") : "none"}`);
  lines.push("");

  if (report.candidates.length === 0) {
    lines.push("No backlog candidates matched the requested filters.");
  } else {
    lines.push(
      "ID | Route | Origin -> Destination | Nonce | Stage | RetryClass | AgeMs | DiscoveryMs | ReceiptMs | Failures",
    );
    for (const item of report.candidates) {
      lines.push(
        [
          item.transferId,
          String(item.route),
          `${item.originChain}->${item.destinationChain}`,
          item.nonce,
          item.missingProofStage,
          item.retryClass,
          String(item.delays.totalAgeMs),
          String(item.delays.providerDiscoveryDelayMs ?? "-"),
          String(item.delays.receiptVerificationDelayMs ?? "-"),
          String(item.checkFailures),
        ].join(" | "),
      );
    }
  }

  if (report.pageInfo.nextCursor !== null) {
    lines.push("");
    lines.push(`Next cursor: ${report.pageInfo.nextCursor}`);
  }

  return `${lines.join("\n")}\n`;
}
