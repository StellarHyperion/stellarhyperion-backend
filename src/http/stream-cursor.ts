import { text } from "../db/rows.js";
import type { Queryable } from "../db/pool.js";

export const STREAM_REPLAY_LIMIT = 100;
export const STREAM_CURSOR_TTL_MS = 15 * 60_000;
const MAX_ID = 9_223_372_036_854_775_807n;
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^(0|[1-9]\d{0,18})$/.test(value) && BigInt(value) <= MAX_ID;

export class StreamCursorError extends Error {
  readonly statusCode = 409;
  readonly code = "cursor_expired";
  constructor() {
    super("Reconnect without Last-Event-ID to resync current transfer state.");
  }
}

export function encodeStreamCursor(
  transferId: string,
  historyId: string,
  now = Date.now(),
): string {
  return Buffer.from(JSON.stringify({ v: 1, transferId, historyId, at: now })).toString(
    "base64url",
  );
}

export function decodeStreamCursor(cursor: string, transferId: string, now = Date.now()): string {
  if (cursor.length === 0 || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor))
    throw new StreamCursorError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new StreamCursorError();
  }
  if (typeof parsed !== "object" || parsed === null) throw new StreamCursorError();
  const value = parsed as Record<string, unknown>;
  if (
    value.v !== 1 ||
    value.transferId !== transferId ||
    !validId(value.historyId) ||
    typeof value.at !== "number" ||
    !Number.isSafeInteger(value.at) ||
    value.at > now ||
    now - value.at > STREAM_CURSOR_TTL_MS
  )
    throw new StreamCursorError();
  return value.historyId;
}

export async function readStreamTransitions(db: Queryable, transferId: string, afterId: string) {
  const result = await db.query(
    `SELECT id::text,old_status,new_status,reason,rail_status,evidence_reference,observed_at
    FROM rail_attestation_history WHERE transfer_id=$1 AND id>$2::bigint ORDER BY id LIMIT $3`,
    [transferId, afterId, STREAM_REPLAY_LIMIT + 1],
  );
  if (result.rows.length > STREAM_REPLAY_LIMIT) throw new StreamCursorError();
  return result.rows;
}

export async function latestStreamTransition(db: Queryable, transferId: string): Promise<string> {
  const result = await db.query(
    "SELECT id::text FROM rail_attestation_history WHERE transfer_id=$1 ORDER BY id DESC LIMIT 1",
    [transferId],
  );
  const row = result.rows[0];
  return row === undefined ? "0" : text(row, "id");
}
