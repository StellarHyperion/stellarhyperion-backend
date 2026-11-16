/**
 * Keyset pagination cursors for public transfer and claim history endpoints.
 *
 * Cursors are opaque base64url-encoded JSON tokens bound to the active endpoint kind, sort
 * direction, and canonical SHA-256 filter digest so changing filters or sort order midway through
 * a walk fails fast with a bounded validation error before touching PostgreSQL.
 */
import { createHash } from "node:crypto";

export type SortDirection = "asc" | "desc";
export type PaginationMode = "offset" | "keyset";

export interface PageInfo {
  readonly mode: PaginationMode;
  readonly sort: SortDirection;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

export type CursorErrorCode =
  | "invalid_cursor"
  | "conflicting_pagination"
  | "invalid_sort"
  | "cursor_filter_mismatch"
  | "cursor_sort_mismatch";

export class KeysetValidationError extends Error {
  readonly statusCode = 400;
  readonly code: CursorErrorCode;

  constructor(code: CursorErrorCode, message: string) {
    super(message);
    this.name = "KeysetValidationError";
    this.code = code;
  }
}

export interface TransferFilterInput {
  readonly originChain?: string | undefined;
  readonly destinationChain?: string | undefined;
  readonly route?: number | null | undefined;
  readonly sender?: string | undefined;
  readonly recipient?: string | undefined;
  readonly search?: string | undefined;
}

export interface ClaimFilterInput {
  readonly chain?: string | undefined;
  readonly recipient?: string | undefined;
  readonly settled?: boolean | null | undefined;
}

interface EncodedTransferCursorV1 {
  readonly v: 1;
  readonly k: "transfers";
  readonly s: SortDirection;
  readonly f: string;
  readonly id: string;
}

interface EncodedClaimCursorV1 {
  readonly v: 1;
  readonly k: "claims";
  readonly s: SortDirection;
  readonly f: string;
  readonly c: string;
  readonly id: string;
}

export interface DecodedTransferCursor {
  readonly lastId: bigint;
  readonly sort: SortDirection;
  readonly filterHash: string;
}

export interface DecodedClaimCursor {
  readonly lastChain: string;
  readonly lastClaimId: bigint;
  readonly sort: SortDirection;
  readonly filterHash: string;
}

const MAX_CURSOR_LENGTH = 512;
const MAX_CHAIN_LENGTH = 64;
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
const MAX_U64 = 18_446_744_073_709_551_615n;

export function parseSortDirection(rawSort?: string): SortDirection {
  if (rawSort === undefined || rawSort === "") {
    return "desc";
  }
  if (rawSort === "asc" || rawSort === "desc") {
    return rawSort;
  }
  throw new KeysetValidationError("invalid_sort", "sort must be 'asc' or 'desc'");
}

export function assertPaginationCompatibility(cursor?: string, offset?: string): void {
  if (cursor !== undefined && offset !== undefined) {
    throw new KeysetValidationError(
      "conflicting_pagination",
      "cursor cannot be combined with offset pagination",
    );
  }
}

function nonEmptyOrNull(value?: string): string | null {
  return value !== undefined && value.length > 0 ? value : null;
}

export function computeTransferFilterHash(filters: TransferFilterInput): string {
  const canonical = JSON.stringify({
    originChain: nonEmptyOrNull(filters.originChain),
    destinationChain: nonEmptyOrNull(filters.destinationChain),
    route: filters.route ?? null,
    sender: nonEmptyOrNull(filters.sender),
    recipient: nonEmptyOrNull(filters.recipient),
    search: filters.search?.trim() ? filters.search.trim() : null,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

export function computeClaimFilterHash(filters: ClaimFilterInput): string {
  const canonical = JSON.stringify({
    chain: nonEmptyOrNull(filters.chain),
    recipient: nonEmptyOrNull(filters.recipient),
    settled: filters.settled ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

export function encodeTransferCursor(input: {
  readonly lastId: string;
  readonly sort: SortDirection;
  readonly filterHash: string;
}): string {
  const payload: EncodedTransferCursorV1 = {
    v: 1,
    k: "transfers",
    s: input.sort,
    f: input.filterHash,
    id: input.lastId,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function encodeClaimCursor(input: {
  readonly lastChain: string;
  readonly lastClaimId: string;
  readonly sort: SortDirection;
  readonly filterHash: string;
}): string {
  const payload: EncodedClaimCursorV1 = {
    v: 1,
    k: "claims",
    s: input.sort,
    f: input.filterHash,
    c: input.lastChain,
    id: input.lastClaimId,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeRawCursorJson(rawCursor: string): Record<string, unknown> {
  if (
    rawCursor.length === 0 ||
    rawCursor.length > MAX_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(rawCursor)
  ) {
    throw new KeysetValidationError(
      "invalid_cursor",
      "cursor is malformed or exceeds maximum length",
    );
  }

  let parsed: unknown;
  try {
    const decodedText = Buffer.from(rawCursor, "base64url").toString("utf8");
    parsed = JSON.parse(decodedText);
  } catch {
    throw new KeysetValidationError("invalid_cursor", "cursor could not be decoded");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new KeysetValidationError("invalid_cursor", "cursor payload is invalid");
  }

  return parsed as Record<string, unknown>;
}

export function decodeTransferCursor(
  rawCursor: string,
  expectedSort: SortDirection,
  expectedFilterHash: string,
): DecodedTransferCursor {
  const record = decodeRawCursorJson(rawCursor);

  if (record.v !== 1 || record.k !== "transfers") {
    throw new KeysetValidationError(
      "invalid_cursor",
      "cursor version or target resource is invalid",
    );
  }

  const cursorSort = record.s;
  if (cursorSort !== "asc" && cursorSort !== "desc") {
    throw new KeysetValidationError("invalid_cursor", "cursor sort direction is invalid");
  }

  const cursorFilterHash = record.f;
  if (typeof cursorFilterHash !== "string" || !/^[0-9a-f]{32}$/.test(cursorFilterHash)) {
    throw new KeysetValidationError("invalid_cursor", "cursor filter digest is invalid");
  }

  const rawId = record.id;
  if (typeof rawId !== "string" || !/^[0-9]{1,19}$/.test(rawId)) {
    throw new KeysetValidationError("invalid_cursor", "cursor position identifier is invalid");
  }

  const lastId = BigInt(rawId);
  if (lastId < 1n || lastId > MAX_POSTGRES_BIGINT) {
    throw new KeysetValidationError("invalid_cursor", "cursor position identifier is out of range");
  }

  if (cursorSort !== expectedSort) {
    throw new KeysetValidationError(
      "cursor_sort_mismatch",
      "cursor sort direction does not match the requested sort parameter",
    );
  }

  if (cursorFilterHash !== expectedFilterHash) {
    throw new KeysetValidationError(
      "cursor_filter_mismatch",
      "cursor does not match the active query filters",
    );
  }

  return {
    lastId,
    sort: cursorSort,
    filterHash: cursorFilterHash,
  };
}

export function decodeClaimCursor(
  rawCursor: string,
  expectedSort: SortDirection,
  expectedFilterHash: string,
): DecodedClaimCursor {
  const record = decodeRawCursorJson(rawCursor);

  if (record.v !== 1 || record.k !== "claims") {
    throw new KeysetValidationError(
      "invalid_cursor",
      "cursor version or target resource is invalid",
    );
  }

  const cursorSort = record.s;
  if (cursorSort !== "asc" && cursorSort !== "desc") {
    throw new KeysetValidationError("invalid_cursor", "cursor sort direction is invalid");
  }

  const cursorFilterHash = record.f;
  if (typeof cursorFilterHash !== "string" || !/^[0-9a-f]{32}$/.test(cursorFilterHash)) {
    throw new KeysetValidationError("invalid_cursor", "cursor filter digest is invalid");
  }

  const lastChain = record.c;
  if (
    typeof lastChain !== "string" ||
    lastChain.length === 0 ||
    lastChain.length > MAX_CHAIN_LENGTH ||
    !/^[a-z0-9-]+$/i.test(lastChain)
  ) {
    throw new KeysetValidationError("invalid_cursor", "cursor chain position is invalid");
  }

  const rawId = record.id;
  if (typeof rawId !== "string" || !/^[0-9]{1,20}$/.test(rawId)) {
    throw new KeysetValidationError("invalid_cursor", "cursor claim identifier is invalid");
  }

  const lastClaimId = BigInt(rawId);
  if (lastClaimId > MAX_U64) {
    throw new KeysetValidationError("invalid_cursor", "cursor claim identifier is out of range");
  }

  if (cursorSort !== expectedSort) {
    throw new KeysetValidationError(
      "cursor_sort_mismatch",
      "cursor sort direction does not match the requested sort parameter",
    );
  }

  if (cursorFilterHash !== expectedFilterHash) {
    throw new KeysetValidationError(
      "cursor_filter_mismatch",
      "cursor does not match the active query filters",
    );
  }

  return {
    lastChain,
    lastClaimId,
    sort: cursorSort,
    filterHash: cursorFilterHash,
  };
}
