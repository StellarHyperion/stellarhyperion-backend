/** Opaque, filter-scoped cursors for stable descending id walks. */

export interface CursorScope {
  readonly originChain?: string;
  readonly destinationChain?: string;
  readonly route?: string;
  readonly sender?: string;
  readonly recipient?: string;
  readonly search?: string;
}

interface CursorPayload {
  readonly version: 1;
  readonly order: "id-desc";
  readonly id: string;
  readonly scope: CursorScope;
}

export class CursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorError";
  }
}

export function encodeCursor(id: string, scope: CursorScope): string {
  const payload: CursorPayload = { version: 1, order: "id-desc", id, scope };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor(value: string, expected: CursorScope): string {
  if (value.length === 0 || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new CursorError("cursor is not valid");
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new CursorError("cursor is not valid");
  }
  if (!isPayload(payload) || JSON.stringify(payload.scope) !== JSON.stringify(expected)) {
    throw new CursorError("cursor does not match the requested sort order or filters");
  }
  return payload.id;
}

function isPayload(value: unknown): value is CursorPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CursorPayload>;
  return (
    candidate.version === 1 &&
    candidate.order === "id-desc" &&
    typeof candidate.id === "string" &&
    /^[1-9]\d{0,18}$/.test(candidate.id) &&
    BigInt(candidate.id) <= 9_223_372_036_854_775_807n &&
    candidate.scope !== undefined
  );
}
