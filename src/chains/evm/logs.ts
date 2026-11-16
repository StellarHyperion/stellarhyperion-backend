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

import {
  UnresolvedLogRangeError,
  isProviderLogRangeLimitError,
  type EvmClient,
  type RawEvmLog,
} from "./client.js";

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

export interface AdaptiveLogFetchResult {
  readonly logs: readonly RawEvmLog[];
  readonly requests: number;
  readonly splits: number;
  readonly duplicatesRemoved: number;
}

export interface AdaptiveLogFetchInput {
  readonly chainKey: string;
  readonly address: Hex;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly minLogRange?: number;
  readonly client: Pick<EvmClient, "logs">;
  readonly signal?: AbortSignal;
  readonly onSplit?: (event: {
    readonly fromBlock: bigint;
    readonly toBlock: bigint;
    readonly leftTo: bigint;
    readonly rightFrom: bigint;
  }) => void;
}

/**
 * Fetch router logs over `[fromBlock, toBlock]`, bisecting rejected intervals on provider block-range
 * or result-size limits without skipping any sub-interval, then deduplicating boundary duplicates and
 * sorting deterministically by `(blockNumber, logIndex)`.
 */
export async function fetchLogsAdaptive(
  input: AdaptiveLogFetchInput,
): Promise<AdaptiveLogFetchResult> {
  const minLogRange = input.minLogRange ?? 1;
  if (!Number.isInteger(minLogRange) || minLogRange < 1) {
    throw new Error(
      `minLogRange must be a positive integer, received ${String(input.minLogRange)}`,
    );
  }
  if (input.fromBlock > input.toBlock) {
    return { logs: [], requests: 0, splits: 0, duplicatesRemoved: 0 };
  }

  const stack: { readonly from: bigint; readonly to: bigint }[] = [
    { from: input.fromBlock, to: input.toBlock },
  ];
  const completed: { readonly from: bigint; readonly to: bigint }[] = [];
  const collected: RawEvmLog[] = [];
  let requests = 0;
  let splits = 0;

  while (stack.length > 0) {
    input.signal?.throwIfAborted();
    const current = stack.pop();
    if (current === undefined) break;

    try {
      requests += 1;
      const chunk = await input.client.logs(
        { address: input.address, fromBlock: current.from, toBlock: current.to },
        input.signal,
      );
      completed.push(current);
      for (const entry of chunk) {
        if (entry.blockNumber >= current.from && entry.blockNumber <= current.to) {
          collected.push(entry);
        } else if (entry.blockNumber >= input.fromBlock && entry.blockNumber <= input.toBlock) {
          // Some providers echo boundary logs slightly outside a sub-window; retain within overall
          // scan bounds and let canonical deduplication collapse duplicates once.
          collected.push(entry);
        }
      }
    } catch (error) {
      if (!isProviderLogRangeLimitError(error)) {
        throw error;
      }
      const span = current.to - current.from + 1n;
      if (span <= BigInt(minLogRange)) {
        throw new UnresolvedLogRangeError({
          chainKey: input.chainKey,
          unresolvedFrom: current.from,
          unresolvedTo: current.to,
          requestedFrom: input.fromBlock,
          requestedTo: input.toBlock,
          minLogRange,
          cause: error,
        });
      }
      const mid = current.from + (current.to - current.from) / 2n;
      const rightFrom = mid + 1n;
      splits += 1;
      input.onSplit?.({
        fromBlock: current.from,
        toBlock: current.to,
        leftTo: mid,
        rightFrom,
      });
      // Push right interval first so LIFO pops the lower `[from, mid]` interval first.
      stack.push({ from: rightFrom, to: current.to });
      stack.push({ from: current.from, to: mid });
    }
  }

  assertContiguousCoverage(input.fromBlock, input.toBlock, completed);
  const { logs, duplicatesRemoved } = dedupeAndOrderRouterLogs(collected);
  return { logs, requests, splits, duplicatesRemoved };
}

function assertContiguousCoverage(
  fromBlock: bigint,
  toBlock: bigint,
  completed: readonly { readonly from: bigint; readonly to: bigint }[],
): void {
  let expected = fromBlock;
  for (const segment of completed) {
    if (segment.from !== expected) {
      throw new Error(
        `adaptive EVM log scan skipped interval ${expected.toString()}..${(segment.from - 1n).toString()}`,
      );
    }
    expected = segment.to + 1n;
  }
  if (expected !== toBlock + 1n) {
    throw new Error(
      `adaptive EVM log scan ended at ${(expected - 1n).toString()} instead of ${toBlock.toString()}`,
    );
  }
}

export function dedupeAndOrderRouterLogs(logs: readonly RawEvmLog[]): {
  readonly logs: readonly RawEvmLog[];
  readonly duplicatesRemoved: number;
} {
  const byIdentity = new Map<string, RawEvmLog>();
  let duplicatesRemoved = 0;

  for (const log of logs) {
    const key = `${log.blockNumber.toString()}|${log.transactionHash.toLowerCase()}|${String(log.logIndex)}`;
    const existing = byIdentity.get(key);
    if (existing === undefined) {
      byIdentity.set(key, log);
      continue;
    }
    if (
      existing.address.toLowerCase() !== log.address.toLowerCase() ||
      existing.data.toLowerCase() !== log.data.toLowerCase() ||
      !sameTopics(existing.topics, log.topics)
    ) {
      throw new Error(
        `conflicting duplicate EVM log payload for block ${log.blockNumber.toString()} tx ${log.transactionHash} logIndex ${String(log.logIndex)}`,
      );
    }
    // If one duplicate across a split boundary was marked removed, keep the removed marker conservative.
    if (log.removed && !existing.removed) {
      byIdentity.set(key, log);
    }
    duplicatesRemoved += 1;
  }

  const ordered = [...byIdentity.values()].sort((left, right) => {
    if (left.blockNumber !== right.blockNumber) {
      return left.blockNumber < right.blockNumber ? -1 : 1;
    }
    if (left.logIndex !== right.logIndex) {
      return left.logIndex - right.logIndex;
    }
    return left.transactionHash.toLowerCase().localeCompare(right.transactionHash.toLowerCase());
  });

  return { logs: ordered, duplicatesRemoved };
}

function sameTopics(left: readonly Hex[], right: readonly Hex[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i]?.toLowerCase() !== right[i]?.toLowerCase()) return false;
  }
  return true;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "absent";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}
