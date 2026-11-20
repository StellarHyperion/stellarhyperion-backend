/**
 * EVM router logs, decoded into the rows the schema wants.
 *
 * Logs are fetched by address and never by topic, the same decision the Stellar side makes and for
 * the same reason: a topic filter only matches what it was told to match, so an event somebody adds
 * next month is dropped silently rather than reported. Here every log from the router is pulled and
 * dispatched on its decoded name, and a signature this build has never seen produces one warning
 * instead of a hole.
 *
 * Three asymmetries with the Soroban router shape the mapping, and all three are worth stating
 * because each one is a plausible place to get a column wrong:
 *
 *   - `BridgeIn` carries a `messageId`, which the Soroban event does not, even though the Soroban
 *     router guards replay on exactly that value. So `rail_message_id` is filled on this side and
 *     null on the other.
 *   - `BridgeIn` carries no `delivered` flag and no claim id. A parked delivery is instead two
 *     logs in one transaction: `ClaimParked` immediately followed by `BridgeIn`. The pairing is
 *     done here, because `inbound_delivery_claim` requires a row to claim either a delivery or a
 *     claim id and never both, and a `BridgeIn` read on its own would always look delivered.
 *   - `ClaimParked` carries no timestamp, where the Soroban event does. The contract sets
 *     `createdAt` to `block.timestamp`, so the block's own timestamp is the same number rather
 *     than an approximation of it.
 */
import { hyperionRouterAbi } from "@hyperion/protocol/abi";
import { decodeEventLog } from "viem";
import type { Hex } from "viem";
import type { EvmClient, LogQuery, RawEvmLog } from "./client.js";

const MIN_PROVIDER_LOG_RANGE = 1n;
const RANGE_LIMIT_ERROR =
  /(?:too many (?:results|logs)|(?:result|log) limit|limit exceeded|exceed(?:ed|s)? (?:the )?(?:maximum|max|provider|query|response)|maximum (?:block )?range|block range (?:is )?too (?:wide|large)|query returned more than|response size (?:limit|exceeded)|more than \d+ results)/i;

export class EvmLogRangeLimitError extends Error {
  constructor(
    readonly fromBlock: bigint,
    readonly toBlock: bigint,
    cause: unknown,
  ) {
    super(
      `EVM provider rejected the minimum log range ${fromBlock.toString()}-${toBlock.toString()}.`,
      { cause },
    );
    this.name = "EvmLogRangeLimitError";
  }
}

/** Split only provider result/range-limit failures; other RPC failures retain their original error. */
export async function fetchEvmLogsAdaptive(
  client: Pick<EvmClient, "logs">,
  query: LogQuery,
  signal?: AbortSignal,
): Promise<readonly RawEvmLog[]> {
  if (query.fromBlock > query.toBlock) throw new RangeError("EVM log range is reversed.");
  signal?.throwIfAborted();
  try {
    const logs = await client.logs(query, signal);
    return uniqueSortedLogs(logs);
  } catch (error) {
    if (!isProviderLogRangeLimitError(error)) throw error;
    if (query.fromBlock === query.toBlock)
      throw new EvmLogRangeLimitError(query.fromBlock, query.toBlock, error);
    const midpoint = query.fromBlock + (query.toBlock - query.fromBlock) / 2n;
    if (midpoint < query.fromBlock || midpoint >= query.toBlock)
      throw new EvmLogRangeLimitError(query.fromBlock, query.toBlock, error);
    const left = await fetchEvmLogsAdaptive(
      client,
      { ...query, toBlock: midpoint },
      signal,
    );
    const right = await fetchEvmLogsAdaptive(
      client,
      { ...query, fromBlock: midpoint + MIN_PROVIDER_LOG_RANGE },
      signal,
    );
    return uniqueSortedLogs([...left, ...right]);
  }
}

export function isProviderLogRangeLimitError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || (typeof current !== "object" && typeof current !== "function")) {
      if (typeof current === "string" && RANGE_LIMIT_ERROR.test(current)) return true;
      continue;
    }
    if (visited.has(current)) continue;
    visited.add(current);
    const record = current as Record<string, unknown>;
    for (const key of ["message", "shortMessage", "details", "body", "reason"]) {
      const value = record[key];
      if (typeof value === "string" && RANGE_LIMIT_ERROR.test(value)) return true;
      if (value !== undefined) pending.push(value);
    }
    if (record.cause !== undefined) pending.push(record.cause);
  }
  return false;
}

function uniqueSortedLogs(logs: readonly RawEvmLog[]): readonly RawEvmLog[] {
  const unique = new Map<string, RawEvmLog>();
  for (const log of logs) {
    const key = `${log.blockNumber}|${log.transactionHash.toLowerCase()}|${log.logIndex}`;
    if (!unique.has(key)) unique.set(key, log);
  }
  return [...unique.values()].sort(
    (a, b) =>
      (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0) ||
      a.logIndex - b.logIndex ||
      a.transactionHash.localeCompare(b.transactionHash),
  );
}

/** A 32 byte word of zeroes, which is how the router spells "no rail reference yet". */
const ZERO_WORD = `0x${"0".repeat(64)}` as const;

export interface DecodedLog {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

/** The parts of a log the decoder reads. Matches `RawEvmLog` without depending on it. */
export interface RouterLogInput {
  readonly data: Hex;
  readonly topics: [] | [Hex, ...Hex[]];
}

/** Null when the signature is not one this build knows, which the caller reports once. */
export function decodeRouterLog(log: RouterLogInput): DecodedLog | null {
  try {
    const decoded = decodeEventLog({
      abi: hyperionRouterAbi,
      data: log.data,
      topics: log.topics,
    });
    return {
      name: decoded.eventName,
      // Named arguments. Every event in this ABI names all of its inputs, which is what makes
      // viem hand back an object here rather than the positional array it uses for unnamed ones,
      // and it is why every mapper below reads by name.
      args: decoded.args,
    };
  } catch {
    return null;
  }
}

/** A bytes32 the router left empty, reported as absent rather than as a word of zeroes. */
export function wordOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.toLowerCase() === ZERO_WORD ? null : value.toLowerCase();
}

/** A uint64 unix second count as a `Date`, or null when the chain left it unset. */
export function secondsOrNull(value: unknown): Date | null {
  if (typeof value !== "bigint" && typeof value !== "number") return null;
  const seconds = Number(value);
  if (seconds <= 0) return null;
  return new Date(seconds * 1000);
}

export function requireBigint(args: Record<string, unknown>, name: string): bigint {
  const value = args[name];
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  throw new LogShapeError(name, `is not an integer, it is ${describe(value)}`);
}

export function requireNumber(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "bigint") return Number(value);
  throw new LogShapeError(name, `is not an integer, it is ${describe(value)}`);
}

export function requireAddress(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string") {
    throw new LogShapeError(name, `is not an address, it is ${describe(value)}`);
  }
  // Lowercased so one address has one spelling in the database. viem checksums what it decodes,
  // and a checksummed row next to a lowercased one is two rows to a query that compares them.
  return value.toLowerCase();
}

export function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string") {
    throw new LogShapeError(name, `is not a string, it is ${describe(value)}`);
  }
  return value;
}

export function requireBool(args: Record<string, unknown>, name: string): boolean {
  const value = args[name];
  if (typeof value !== "boolean") {
    throw new LogShapeError(name, `is not a boolean, it is ${describe(value)}`);
  }
  return value;
}

/** The `TokenConfig` tuple on `TokenRegistered`, which viem decodes as an object. */
export interface TokenConfig {
  readonly decimals: number;
  readonly flowLimit: bigint;
  readonly enabled: boolean;
}

export function requireTokenConfig(args: Record<string, unknown>): TokenConfig {
  const config = args.config;
  if (typeof config !== "object" || config === null) {
    throw new LogShapeError("config", `is not a tuple, it is ${describe(config)}`);
  }
  const fields = config as Record<string, unknown>;
  return {
    decimals: requireNumber(fields, "decimals"),
    flowLimit: requireBigint(fields, "flowLimit"),
    enabled: requireBool(fields, "enabled"),
  };
}

/**
 * A log this build recognises and cannot read.
 *
 * Loud rather than skipped, which is the same split the Soroban decoder makes. An unknown
 * signature is a contract newer than the indexer and a normal operational state; a known event
 * whose fields do not decode is a bug, and skipping it would lose a transfer.
 */
export class LogShapeError extends Error {
  constructor(field: string, reason: string) {
    super(`log field ${field} ${reason}`);
    this.name = "LogShapeError";
  }
}

/** The first topic, which is the event signature and the only thing to name an unknown log by. */
export function signatureOf(log: Pick<RouterLogInput, "topics">): Hex {
  return log.topics[0] ?? "0x";
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "absent";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}
