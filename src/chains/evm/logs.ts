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

import type { BlockStamp, EvmTransactionReceipt, RawEvmLog } from "./client.js";

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

export class ReceiptConsistencyError extends Error {
  readonly txHash: string | null;
  readonly blockNumber: bigint | null;
  readonly logIndex: number | null;

  constructor(
    reason: string,
    context: {
      readonly txHash?: string | null;
      readonly blockNumber?: bigint | null;
      readonly logIndex?: number | null;
    } = {},
  ) {
    super(`EVM receipt consistency check failed: ${reason}`);
    this.name = "ReceiptConsistencyError";
    this.txHash = context.txHash ?? null;
    this.blockNumber = context.blockNumber ?? null;
    this.logIndex = context.logIndex ?? null;
  }
}

export interface ReceiptConsistencyInput {
  readonly router: Hex;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly logs: readonly RawEvmLog[];
  readonly blocks: ReadonlyMap<bigint, BlockStamp>;
  readonly receipts: ReadonlyMap<string, EvmTransactionReceipt>;
}

/**
 * Verify that every accepted router log in `[fromBlock, toBlock]` is backed by a successful
 * canonical transaction receipt whose block number, block hash, transaction hash, contract address,
 * log index, topics, data, and router log count agree across `getLogs`, `getBlock`, and
 * `getTransactionReceipt`.
 */
export function verifyRangeReceiptConsistency(input: ReceiptConsistencyInput): void {
  const expectedRouter = input.router.toLowerCase();
  const nonRemovedByTx = new Map<string, RawEvmLog[]>();

  for (const log of input.logs) {
    if (log.removed) continue;

    if (log.address.toLowerCase() !== expectedRouter) {
      throw new ReceiptConsistencyError(
        `log address ${log.address} does not match watched router ${input.router}`,
        { txHash: log.transactionHash, blockNumber: log.blockNumber, logIndex: log.logIndex },
      );
    }

    if (log.blockNumber < input.fromBlock || log.blockNumber > input.toBlock) {
      throw new ReceiptConsistencyError(
        `log block ${log.blockNumber.toString()} is outside requested range ${input.fromBlock.toString()}..${input.toBlock.toString()}`,
        { txHash: log.transactionHash, blockNumber: log.blockNumber, logIndex: log.logIndex },
      );
    }

    const blockStamp = input.blocks.get(log.blockNumber);
    if (blockStamp === undefined) {
      throw new ReceiptConsistencyError(
        `block header for block ${log.blockNumber.toString()} is missing`,
        { txHash: log.transactionHash, blockNumber: log.blockNumber, logIndex: log.logIndex },
      );
    }

    const canonicalBlockHash = blockStamp.hash.toLowerCase();
    if (log.blockHash !== undefined && log.blockHash.toLowerCase() !== canonicalBlockHash) {
      throw new ReceiptConsistencyError(
        `log block hash ${log.blockHash} disagrees with canonical block header ${blockStamp.hash}`,
        { txHash: log.transactionHash, blockNumber: log.blockNumber, logIndex: log.logIndex },
      );
    }

    const txKey = log.transactionHash.toLowerCase();
    const receipt = input.receipts.get(txKey);
    if (receipt === undefined) {
      throw new ReceiptConsistencyError(`missing transaction receipt for ${log.transactionHash}`, {
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
      });
    }

    if (receipt.transactionHash.toLowerCase() !== txKey) {
      throw new ReceiptConsistencyError(
        `receipt transaction hash ${receipt.transactionHash} disagrees with log transaction hash ${log.transactionHash}`,
        { txHash: log.transactionHash, blockNumber: log.blockNumber, logIndex: log.logIndex },
      );
    }

    if (receipt.blockNumber !== log.blockNumber) {
      throw new ReceiptConsistencyError(
        `receipt block number ${receipt.blockNumber.toString()} disagrees with log block ${log.blockNumber.toString()}`,
        { txHash: log.transactionHash, blockNumber: log.blockNumber, logIndex: log.logIndex },
      );
    }

    if (receipt.blockHash.toLowerCase() !== canonicalBlockHash) {
      throw new ReceiptConsistencyError(
        `receipt block hash ${receipt.blockHash} disagrees with canonical block header ${blockStamp.hash}`,
        { txHash: log.transactionHash, blockNumber: log.blockNumber, logIndex: log.logIndex },
      );
    }

    if (receipt.status !== "success") {
      throw new ReceiptConsistencyError(
        `transaction ${log.transactionHash} has non-successful receipt status "${receipt.status}"`,
        { txHash: log.transactionHash, blockNumber: log.blockNumber, logIndex: log.logIndex },
      );
    }

    const matchingReceiptLogs = receipt.logs.filter((entry) => entry.logIndex === log.logIndex);
    if (matchingReceiptLogs.length !== 1) {
      throw new ReceiptConsistencyError(
        `expected exactly one receipt log at logIndex ${String(log.logIndex)} in ${log.transactionHash}, found ${String(matchingReceiptLogs.length)}`,
        { txHash: log.transactionHash, blockNumber: log.blockNumber, logIndex: log.logIndex },
      );
    }

    const receiptLog = matchingReceiptLogs[0];
    if (receiptLog === undefined) {
      throw new ReceiptConsistencyError(`missing receipt log at logIndex ${String(log.logIndex)}`, {
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
      });
    }

    if (receiptLog.removed) {
      throw new ReceiptConsistencyError(
        `receipt log at logIndex ${String(log.logIndex)} in ${log.transactionHash} is marked removed`,
        { txHash: log.transactionHash, blockNumber: log.blockNumber, logIndex: log.logIndex },
      );
    }

    if (receiptLog.address.toLowerCase() !== expectedRouter) {
      throw new ReceiptConsistencyError(
        `receipt log address ${receiptLog.address} disagrees with watched router ${input.router}`,
        { txHash: log.transactionHash, blockNumber: log.blockNumber, logIndex: log.logIndex },
      );
    }

    if (receiptLog.transactionHash.toLowerCase() !== txKey) {
      throw new ReceiptConsistencyError(
        `receipt log transaction hash ${receiptLog.transactionHash} disagrees with ${log.transactionHash}`,
        { txHash: log.transactionHash, blockNumber: log.blockNumber, logIndex: log.logIndex },
      );
    }

    if (receiptLog.blockNumber !== log.blockNumber) {
      throw new ReceiptConsistencyError(
        `receipt log block number ${receiptLog.blockNumber.toString()} disagrees with ${log.blockNumber.toString()}`,
        { txHash: log.transactionHash, blockNumber: log.blockNumber, logIndex: log.logIndex },
      );
    }

    if (receiptLog.blockHash.toLowerCase() !== canonicalBlockHash) {
      throw new ReceiptConsistencyError(
        `receipt log block hash ${receiptLog.blockHash} disagrees with canonical block header ${blockStamp.hash}`,
        { txHash: log.transactionHash, blockNumber: log.blockNumber, logIndex: log.logIndex },
      );
    }

    if (receiptLog.data.toLowerCase() !== log.data.toLowerCase()) {
      throw new ReceiptConsistencyError(
        `receipt log data at logIndex ${String(log.logIndex)} disagrees with getLogs payload`,
        { txHash: log.transactionHash, blockNumber: log.blockNumber, logIndex: log.logIndex },
      );
    }

    if (!topicsEqual(receiptLog.topics, log.topics)) {
      throw new ReceiptConsistencyError(
        `receipt log topics at logIndex ${String(log.logIndex)} disagree with getLogs payload`,
        { txHash: log.transactionHash, blockNumber: log.blockNumber, logIndex: log.logIndex },
      );
    }

    const list = nonRemovedByTx.get(txKey) ?? [];
    list.push(log);
    nonRemovedByTx.set(txKey, list);
  }

  // Ensure getLogs did not omit a sibling router log from any accepted transaction receipt (such as
  // a `ClaimParked` emitted immediately before `BridgeIn` in the same transaction).
  for (const [txKey, txLogs] of nonRemovedByTx.entries()) {
    const receipt = input.receipts.get(txKey);
    if (receipt === undefined) continue;
    const receiptRouterLogs = receipt.logs.filter(
      (entry) => !entry.removed && entry.address.toLowerCase() === expectedRouter,
    );
    const seenIndices = new Set(txLogs.map((entry) => entry.logIndex));
    for (const receiptEntry of receiptRouterLogs) {
      if (!seenIndices.has(receiptEntry.logIndex)) {
        throw new ReceiptConsistencyError(
          `getLogs omitted canonical router log at logIndex ${String(receiptEntry.logIndex)} present in receipt ${receipt.transactionHash}`,
          {
            txHash: receipt.transactionHash,
            blockNumber: receipt.blockNumber,
            logIndex: receiptEntry.logIndex,
          },
        );
      }
    }
  }
}

function topicsEqual(left: readonly Hex[], right: readonly Hex[]): boolean {
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
