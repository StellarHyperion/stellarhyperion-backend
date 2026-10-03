/**
 * Reading the JSON form of an ScVal.
 *
 * Soroban RPC will hand back events either as base64 XDR or, with `xdrFormat: "json"`, as a tagged
 * JSON tree. This reads the second form. The first would mean carrying an XDR codec and a stellar
 * SDK dependency into the hot path of the indexer to recover values the RPC is willing to decode
 * itself.
 *
 * The encoding has three details that will produce a plausible wrong answer if they are guessed,
 * and all three were read off the live testnet rather than inferred:
 *
 * `u32` arrives as a JSON number. `u64` and `i128` arrive as JSON strings, because neither fits a
 * double. Anything that reads a `u64` with `Number()` silently rounds a large nonce.
 *
 * A struct is a `map` whose entries are `{ key, val }` pairs, with the keys sorted by name and any
 * field holding void omitted entirely. So a missing key is not malformed input; it is a field that
 * was empty. Code that treats absence as an error will reject perfectly good events.
 *
 * An enum with a payload is a `vec` whose first element is the variant symbol. An enum with
 * explicit discriminants and `#[repr(u32)]`, which is what `RouteKind` and `AddressKind` are, is
 * a bare `u32` instead. Those two shapes look nothing alike and the difference is invisible in the
 * Rust.
 */

/** A tagged ScVal as the RPC writes it. Deliberately loose: the shape is somebody else's output. */
export type ScValJson = Record<string, unknown>;

export class ScValError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`${path}: ${reason}`);
    this.name = "ScValError";
  }
}

function fail(path: string, reason: string): never {
  throw new ScValError(path, reason);
}

function tagOf(value: unknown, path: string): [string, unknown] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, `expected a tagged ScVal object, found ${typeof value}`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const first = entries[0];
  if (entries.length !== 1 || first === undefined) {
    fail(path, `expected exactly one tag, found ${String(entries.length)}`);
  }
  return first;
}

/** The tag name, for a caller that needs to branch on the shape before reading it. */
export function scTag(value: unknown, path = "$"): string {
  return tagOf(value, path)[0];
}

export function scSymbol(value: unknown, path = "$"): string {
  const [tag, inner] = tagOf(value, path);
  if (tag !== "symbol") fail(path, `expected a symbol, found ${tag}`);
  if (typeof inner !== "string") fail(path, "symbol is not a string");
  return inner;
}

export function scString(value: unknown, path = "$"): string {
  const [tag, inner] = tagOf(value, path);
  // A Soroban `String` and a `Symbol` are different types and both arrive as text. Accepting
  // either here means a field that changes from one to the other does not break the indexer, and
  // nothing in this schema distinguishes them downstream.
  if (tag !== "string" && tag !== "symbol") fail(path, `expected a string, found ${tag}`);
  if (typeof inner !== "string") fail(path, "string is not a string");
  return inner;
}

/** An address, which the RPC renders as a strkey rather than as bytes. */
export function scAddress(value: unknown, path = "$"): string {
  const [tag, inner] = tagOf(value, path);
  if (tag !== "address") fail(path, `expected an address, found ${tag}`);
  if (typeof inner !== "string") fail(path, "address is not a string");
  return inner;
}

export function scBool(value: unknown, path = "$"): boolean {
  const [tag, inner] = tagOf(value, path);
  if (tag !== "bool") fail(path, `expected a bool, found ${tag}`);
  if (typeof inner !== "boolean") fail(path, "bool is not a boolean");
  return inner;
}

/** A `u32`, which arrives as a JSON number because it fits one exactly. */
export function scU32(value: unknown, path = "$"): number {
  const [tag, inner] = tagOf(value, path);
  if (tag !== "u32") fail(path, `expected a u32, found ${tag}`);
  if (typeof inner === "number" && Number.isInteger(inner) && inner >= 0) return inner;
  // Tolerated because a JSON encoder that decides to quote every integer is a thing that happens.
  if (typeof inner === "string" && /^\d+$/.test(inner)) return Number(inner);
  fail(path, `u32 is not a whole number, found ${JSON.stringify(inner)}`);
}

/**
 * A `u64` or an `i128`, as a bigint.
 *
 * Both arrive as strings and both must stay exact. A ledger sequence fits a double and a nonce
 * near the top of its range does not, and an amount in stroops certainly does not, so there is no
 * version of this that returns a number.
 */
export function scBigInt(value: unknown, path = "$"): bigint {
  const [tag, inner] = tagOf(value, path);
  if (
    tag !== "u64" &&
    tag !== "i64" &&
    tag !== "u128" &&
    tag !== "i128" &&
    tag !== "u32" &&
    tag !== "i32"
  ) {
    fail(path, `expected an integer, found ${tag}`);
  }
  if (typeof inner === "string") {
    if (!/^-?\d+$/.test(inner)) fail(path, `integer is not a decimal string: ${inner}`);
    return BigInt(inner);
  }
  if (typeof inner === "number" && Number.isInteger(inner)) return BigInt(inner);
  // A 128 bit value split into halves, which some encoders produce for i128 and u128. The two `in`
  // checks narrow the type on their own, so there is nothing left to assert.
  if (typeof inner === "object" && inner !== null && "hi" in inner && "lo" in inner) {
    return (BigInt(String(inner.hi)) << 64n) | BigInt(String(inner.lo));
  }
  fail(path, `cannot read an integer from ${JSON.stringify(inner)}`);
}

/** Fixed width bytes, as lowercase hex with an 0x prefix. */
export function scBytes(value: unknown, path = "$"): string {
  const [tag, inner] = tagOf(value, path);
  if (tag !== "bytes") fail(path, `expected bytes, found ${tag}`);
  if (typeof inner !== "string") fail(path, "bytes is not a string");
  const hex = inner.startsWith("0x") ? inner.slice(2) : inner;
  if (!/^[0-9a-fA-F]*$/.test(hex)) fail(path, "bytes is not hex");
  return `0x${hex.toLowerCase()}`;
}

/**
 * A struct, as a record keyed by field name.
 *
 * Void fields are absent rather than null, so the returned record is genuinely partial and every
 * reader has to decide what an absent field means for it. `scField` and `scOptionalField` below
 * are the two answers to that.
 */
export function scMap(value: unknown, path = "$"): Record<string, unknown> {
  const [tag, inner] = tagOf(value, path);
  if (tag !== "map") fail(path, `expected a map, found ${tag}`);
  if (!Array.isArray(inner)) fail(path, "map is not an array of entries");

  const out: Record<string, unknown> = {};
  inner.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      fail(`${path}[${String(index)}]`, "map entry is not an object");
    }
    const { key, val } = entry as { key?: unknown; val?: unknown };
    if (key === undefined || val === undefined) {
      fail(`${path}[${String(index)}]`, "map entry needs both a key and a val");
    }
    out[scSymbol(key, `${path}[${String(index)}].key`)] = val;
  });
  return out;
}

export function scVec(value: unknown, path = "$"): unknown[] {
  const [tag, inner] = tagOf(value, path);
  if (tag !== "vec") fail(path, `expected a vec, found ${tag}`);
  if (!Array.isArray(inner)) fail(path, "vec is not an array");
  return inner;
}

/** A required field. Absent is an error, because the contract always writes this one. */
export function scField(map: Record<string, unknown>, name: string, path = "$"): unknown {
  const value = map[name];
  if (value === undefined) {
    fail(
      `${path}.${name}`,
      `is missing; the map holds ${Object.keys(map).join(", ") || "nothing"}`,
    );
  }
  return value;
}

/**
 * A field that may legitimately be absent, because its value was void.
 *
 * Returns `unknown`, which already includes undefined. Writing the union out was redundant and the
 * distinction a caller needs is a comparison against undefined, not a wider type.
 */
export function scOptionalField(map: Record<string, unknown>, name: string): unknown {
  return map[name];
}

export interface ScUnion {
  readonly variant: string;
  readonly payload: readonly unknown[];
}

/**
 * An enum with a payload: a vec whose head is the variant symbol.
 *
 * Not to be used for `RouteKind` or `AddressKind`. Those carry explicit discriminants and
 * `#[repr(u32)]`, which makes them a bare `u32` on the wire rather than a union, and reading one
 * through here fails with "expected a vec, found u32". That message is the only warning anybody
 * gets, so it is worth it being accurate.
 */
export function scUnion(value: unknown, path = "$"): ScUnion {
  const items = scVec(value, path);
  const head = items[0];
  if (head === undefined) fail(path, "union has no variant symbol");
  return { variant: scSymbol(head, `${path}[0]`), payload: items.slice(1) };
}
