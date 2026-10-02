/**
 * Reading a row out of pg without pretending to know what is in it.
 *
 * node-postgres hands back `any`. A generic on `query<T>()` does not check anything, it just
 * stops the compiler asking, which is worse than a cast because it looks like a type. So every
 * column is read through one of these, and every one of them throws with the column name when the
 * database disagrees with the code. That failure is a migration drift, and a migration drift that
 * surfaces as `undefined` three functions later costs an hour.
 *
 * `NUMERIC` comes back from pg as a string, which is exactly what is wanted: `NUMERIC(78,0)` holds
 * a `uint256` and a double does not. These readers turn it into a `bigint` and nothing in between.
 */

export class RowError extends Error {
  constructor(column: string, reason: string) {
    super(`column ${column} ${reason}`);
    this.name = "RowError";
  }
}

export type Row = Record<string, unknown>;

export function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== "string")
    throw new RowError(column, `is not a string, it is ${typeOf(value)}`);
  return value;
}

export function textOrNull(row: Row, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string")
    throw new RowError(column, `is not a string, it is ${typeOf(value)}`);
  return value;
}

export function integer(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === "number" && Number.isInteger(value)) return value;
  // pg returns int8 as a string to avoid losing precision, and will do the same for a count.
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  throw new RowError(column, `is not an integer, it is ${typeOf(value)}`);
}

export function integerOrNull(row: Row, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  return integer(row, column);
}

/**
 * A `NUMERIC(n,0)` as a `bigint`.
 *
 * Refuses a decimal point rather than truncating one. A numeric with a fractional part in an
 * amount column means a migration let a non integer in, and rounding it here would hide that.
 */
export function bigintOf(row: Row, column: string): bigint {
  const value = row[column];
  if (typeof value === "bigint") return value;
  if (typeof value === "string") {
    if (!/^-?\d+$/.test(value)) throw new RowError(column, `is not a whole number: ${value}`);
    return BigInt(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  throw new RowError(column, `is not a numeric, it is ${typeOf(value)}`);
}

export function bigintOrNull(row: Row, column: string): bigint | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  return bigintOf(row, column);
}

export function boolean(row: Row, column: string): boolean {
  const value = row[column];
  if (typeof value !== "boolean")
    throw new RowError(column, `is not a boolean, it is ${typeOf(value)}`);
  return value;
}

export function timestamp(row: Row, column: string): Date {
  const value = row[column];
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new RowError(column, `is not a timestamp: ${value}`);
    return parsed;
  }
  throw new RowError(column, `is not a timestamp, it is ${typeOf(value)}`);
}

export function timestampOrNull(row: Row, column: string): Date | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  return timestamp(row, column);
}

/** A `jsonb` column, which pg has already parsed. */
export function json(row: Row, column: string): unknown {
  return row[column] ?? null;
}

/** Exactly one row, or a message saying how many there were. */
export function one(rows: readonly Row[], what: string): Row {
  const first = rows[0];
  if (first === undefined) throw new RowError(what, "returned no rows where one was expected");
  if (rows.length > 1) {
    throw new RowError(what, `returned ${rows.length} rows where one was expected`);
  }
  return first;
}

/** Zero or one row. */
export function maybeOne(rows: readonly Row[], what: string): Row | null {
  if (rows.length === 0) return null;
  return one(rows, what);
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "absent";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}
