/**
 * An EVM node that can be made to reorganise on command.
 *
 * That is the whole reason this exists rather than the tests pointing at anvil. The EVM watcher's
 * interesting behaviour is what it does when the chain changes its mind about a block it already
 * indexed, and a real reorg is not something a test can arrange: anvil will happily mine, but it
 * will not rewrite history underneath a running watcher on request. So the fake implements the
 * part that matters, `blocks` returning a different hash for a block number it returned before,
 * and the watcher is tested against the event it was written for.
 *
 * Everything else is modelled from the real client's contract: logs are returned for an inclusive
 * block range and never filtered by topic, `blocks` omits a block the node no longer has rather
 * than failing, and `blockNumber` is the unconfirmed head so the watcher has to subtract
 * confirmations itself.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { encodeEventTopics, encodeAbiParameters, type AbiEvent, type Hex } from "viem";
import { hyperionRouterAbi } from "@hyperion/protocol/abi";

import type { BlockStamp, EvmClient, LogQuery, RawEvmLog } from "../src/chains/evm/client.js";
import { FIXTURES_DIR } from "./helpers.js";

interface CapturedFixture {
  readonly router: Hex;
  readonly chainId: number;
  readonly startBlock: number;
  readonly head: string;
  readonly logs: readonly {
    readonly address: Hex;
    readonly blockNumber: string;
    readonly transactionHash: Hex;
    readonly logIndex: number;
    readonly data: Hex;
    readonly topics: readonly Hex[];
    readonly removed: boolean;
  }[];
  readonly blocks: Readonly<Record<string, { readonly hash: Hex; readonly timestamp: string }>>;
}

const captured = JSON.parse(
  readFileSync(join(FIXTURES_DIR, "evm-router-history.json"), "utf8"),
) as CapturedFixture;

/** The router the anvil end to end script deploys, and the chain it ends up on. */
export const ANVIL_ROUTER = captured.router;
export const ANVIL_START_BLOCK = BigInt(captured.startBlock);
export const ANVIL_CHAIN_ID = captured.chainId;
export const ANVIL_HEAD = BigInt(captured.head);

/** Every log the real deployment emitted, in the shape the client hands over. */
export const ANVIL_HISTORY: readonly RawEvmLog[] = captured.logs.map((log) => ({
  address: log.address,
  blockNumber: BigInt(log.blockNumber),
  transactionHash: log.transactionHash,
  logIndex: log.logIndex,
  data: log.data,
  topics: [...log.topics] as [] | [Hex, ...Hex[]],
  removed: log.removed,
}));

/** Real timestamps and hashes for the blocks that carried those logs. */
const CAPTURED_BLOCKS = new Map<bigint, BlockStamp>(
  Object.entries(captured.blocks).map(([number, stamp]) => [
    BigInt(number),
    { hash: stamp.hash, timestamp: BigInt(stamp.timestamp) },
  ]),
);

const GENESIS_TIME = 1_790_000_000n;

export interface FakeEvmClientOptions {
  readonly logs?: readonly RawEvmLog[];
  readonly head?: bigint;
  /** What the node claims to be, for the guard that refuses the wrong chain. */
  readonly chainId?: number;
  /** Blocks the node no longer has, which is how a vanished block is expressed. */
  readonly missing?: readonly bigint[];
}

export class FakeEvmClient implements EvmClient {
  readonly logQueries: LogQuery[] = [];
  readonly blockQueries: bigint[][] = [];
  /** Counted, because the watcher is supposed to ask this once per process and not once per pass. */
  chainIdCalls = 0;

  private log: RawEvmLog[];
  private head: bigint;
  private readonly missing = new Set<bigint>();
  /** Bumped for a block range that has been rewritten, which changes every hash at or above it. */
  private reorgFrom: bigint | null = null;
  private epoch = 0;
  private readonly chain: number;

  constructor(options: FakeEvmClientOptions = {}) {
    this.chain = options.chainId ?? captured.chainId;
    this.log = [...(options.logs ?? ANVIL_HISTORY)];
    this.head =
      options.head ??
      this.log.reduce((max, entry) => (entry.blockNumber > max ? entry.blockNumber : max), 0n) + 1n;
    for (const block of options.missing ?? []) this.missing.add(block);
  }

  get latest(): bigint {
    return this.head;
  }

  advanceHeadTo(block: bigint): void {
    this.head = block;
  }

  /**
   * Rewrite history from `block` onwards.
   *
   * Every hash at or above it changes, which is exactly what the watcher's cursor check is looking
   * for. Optionally swaps in the logs the new history carries, so a test can show a corrected row
   * overwriting an orphaned one rather than only that the reorg was noticed.
   */
  reorg(block: bigint, replacement?: readonly RawEvmLog[]): void {
    this.reorgFrom = block;
    this.epoch += 1;
    if (replacement !== undefined) {
      this.log = [...this.log.filter((entry) => entry.blockNumber < block), ...replacement];
    }
  }

  /** Make a block vanish entirely, which is the other way a node reports a reorg. */
  forget(block: bigint): void {
    this.missing.add(block);
  }

  chainId(): Promise<number> {
    this.chainIdCalls += 1;
    return Promise.resolve(this.chain);
  }

  blockNumber(): Promise<bigint> {
    return Promise.resolve(this.head);
  }

  logs(query: LogQuery): Promise<readonly RawEvmLog[]> {
    this.logQueries.push(query);
    return Promise.resolve(
      this.log
        .filter(
          (entry) =>
            entry.address.toLowerCase() === query.address.toLowerCase() &&
            entry.blockNumber >= query.fromBlock &&
            entry.blockNumber <= query.toBlock,
        )
        // Ascending by block then log index, which is the order a node returns them in and the
        // order the claim pairing depends on.
        .sort((a, b) =>
          a.blockNumber === b.blockNumber
            ? a.logIndex - b.logIndex
            : Number(a.blockNumber - b.blockNumber),
        ),
    );
  }

  blocks(numbers: readonly bigint[]): Promise<Map<bigint, BlockStamp>> {
    this.blockQueries.push([...numbers]);
    const found = new Map<bigint, BlockStamp>();
    for (const number of numbers) {
      if (this.missing.has(number) || number > this.head) continue;
      found.set(number, this.stampFor(number));
    }
    return Promise.resolve(found);
  }

  /** What the node would say about a block right now, after any reorg already applied. */
  stampFor(number: bigint): BlockStamp {
    const rewritten = this.reorgFrom !== null && number >= this.reorgFrom;
    const original = CAPTURED_BLOCKS.get(number);
    if (original !== undefined && !rewritten) return original;
    const suffix = `${number.toString(16)}${rewritten ? `e${String(this.epoch)}` : ""}`;
    return {
      hash: `0x${suffix.padStart(64, "0")}`,
      timestamp: original?.timestamp ?? GENESIS_TIME + number,
    };
  }
}

/** A log with just enough shape to be decoded, for cases the capture cannot express. */
export function evmLog(
  overrides: Partial<RawEvmLog> & { readonly blockNumber: bigint },
): RawEvmLog {
  return {
    address: ANVIL_ROUTER,
    transactionHash: `0x${overrides.blockNumber.toString(16).padStart(64, "0")}`,
    logIndex: 0,
    data: "0x",
    topics: [],
    removed: false,
    ...overrides,
  };
}

/**
 * A genuinely ABI-encoded router log, for the events the anvil run never produced.
 *
 * The capture covers a deployment and one outgoing transfer, which is what that script does. It
 * has no arrival and no parked claim, and those are the two the EVM mapping is most likely to get
 * wrong: `BridgeIn` carries no delivered flag, so a parked delivery is only distinguishable by the
 * `ClaimParked` emitted immediately before it in the same transaction.
 *
 * Encoded with viem against the real ABI rather than hand-written hex, so the decoder under test
 * is decoding the same bytes a node would hand it. A fixture typed by hand would encode whatever
 * this file guessed about indexing and tuple packing, and agree with itself forever.
 */
export function encodedLog(
  name: string,
  args: Record<string, unknown>,
  position: { readonly blockNumber: bigint; readonly logIndex: number; readonly txHash?: Hex },
): RawEvmLog {
  // The ABI is `as const`, so its entries are a union of literal types and a type predicate
  // widening them to `AbiEvent` is not assignable. Looked up by name at runtime instead, which is
  // what a test helper taking a string name is doing anyway.
  const found = hyperionRouterAbi.find((entry) => entry.type === "event" && entry.name === name);
  if (found === undefined) throw new Error(`no event named ${name} in the router ABI`);
  const event = found as AbiEvent;

  const [signature, ...rest] = encodeEventTopics({ abi: [event], eventName: name, args });
  // A null topic is how viem encodes an indexed argument that was not supplied: a wildcard, which
  // is meaningful in a filter and wrong in a log. Refused here rather than written as a zero word,
  // because a silently wildcarded recipient is exactly the kind of fixture that passes forever.
  const topics: [Hex, ...Hex[]] = [
    signature,
    ...rest.map((topic, index) => {
      if (typeof topic !== "string") {
        throw new Error(
          `indexed argument ${String(index + 1)} of ${name} was not supplied, so it encoded as a wildcard`,
        );
      }
      return topic;
    }),
  ];
  // Everything not indexed, in ABI order, which is what the data section holds.
  const unindexed = event.inputs.filter((input) => input.indexed !== true);
  const data =
    unindexed.length === 0
      ? "0x"
      : encodeAbiParameters(
          unindexed,
          unindexed.map((input) => args[input.name ?? ""]),
        );

  return {
    address: ANVIL_ROUTER,
    blockNumber: position.blockNumber,
    transactionHash: position.txHash ?? `0x${position.blockNumber.toString(16).padStart(64, "0")}`,
    logIndex: position.logIndex,
    data,
    topics,
    removed: false,
  };
}
