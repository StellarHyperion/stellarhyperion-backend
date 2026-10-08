/**
 * The three JSON-RPC calls the EVM watcher makes, behind an interface it can be handed a fake of.
 *
 * viem does the encoding and the transport, and this wrapper exists for two reasons that are not
 * taste. The first is the seam: the watcher's correctness is about cursors, reorgs and
 * transactions, and testing that against a real node means a real reorg, which is not something a
 * test can arrange. The second is `blocks`: the watcher needs timestamps that `getLogs` does not
 * return, and batching those lookups in one place keeps the per-pass call count at one per block
 * that actually has logs rather than one per block in the range.
 */
import type { Logger } from "pino";
import { createPublicClient, fallback, http, shouldThrow } from "viem";
import type { Hex } from "viem";

export interface RawEvmLog {
  readonly address: Hex;
  readonly blockNumber: bigint;
  readonly transactionHash: Hex;
  readonly logIndex: number;
  readonly data: Hex;
  /**
   * Event topics, in the tuple shape viem decodes.
   *
   * Not `readonly Hex[]`: `decodeEventLog` distinguishes an anonymous event with no topics from a
   * normal one whose first topic is the signature, and the tuple is how that distinction is
   * carried. Widening it here would mean casting it back at the one place it is used.
   */
  readonly topics: [] | [Hex, ...Hex[]];
  /** Set by the node when the log is from a block that is no longer canonical. */
  readonly removed: boolean;
}

export interface BlockStamp {
  readonly hash: Hex;
  readonly timestamp: bigint;
}

export interface LogQuery {
  readonly address: Hex;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
}

export interface EvmClient {
  /**
   * What chain the node on the other end believes it is.
   *
   * Read once per process rather than per pass. The Stellar watcher already refuses a deployment
   * record whose network passphrase disagrees with the registry, and this is the same guard for
   * the other family: a testnet config pointed at a mainnet endpoint indexes real transfers into
   * a database that says testnet, and every number downstream is then confidently wrong.
   */
  chainId(signal?: AbortSignal): Promise<number>;
  blockNumber(signal?: AbortSignal): Promise<bigint>;
  /**
   * Logs from one address over an inclusive block range.
   *
   * By address and never by topic. A topic filter only matches what it was told to match, so an
   * event added to the router next month is dropped silently rather than reported, and silently is
   * the problem. The whole range is also block aligned, which is what lets the claim pairing in
   * `store.ts` assume a transaction is never split across two passes.
   */
  logs(query: LogQuery, signal?: AbortSignal): Promise<readonly RawEvmLog[]>;
  /** Hash and timestamp for each block asked for. A block missing from the map is gone. */
  blocks(numbers: readonly bigint[], signal?: AbortSignal): Promise<Map<bigint, BlockStamp>>;
}

export interface ViemClientOptions {
  readonly timeoutMs?: number;
  readonly logger?: Logger;
  readonly onFailover?: (event: {
    readonly failedUrl: string;
    readonly fallbackUrl: string;
    readonly error: unknown;
  }) => void;
  readonly fetchFn?: typeof globalThis.fetch;
}

export function viemClient(
  rpcUrls: string | readonly string[],
  options: ViemClientOptions = {},
): EvmClient {
  const urls = typeof rpcUrls === "string" ? [rpcUrls] : [...rpcUrls];
  if (urls.length === 0) {
    throw new Error("at least one RPC URL is required");
  }

  const timeout = options.timeoutMs ?? 20_000;

  const transport =
    urls.length === 1
      ? http(urls[0], {
          fetchFn: options.fetchFn,
          timeout,
          // One retry inside viem. The poller's own backoff is the policy that matters, and retrying
          // hard down here would hide a failing endpoint from it.
          retryCount: 1,
        })
      : fallback(
          urls.map((url) =>
            http(url, {
              fetchFn: options.fetchFn,
              timeout,
              retryCount: 0,
            }),
          ),
          {
            retryCount: 0,
            shouldThrow(err) {
              if (shouldThrow(err)) {
                return true;
              }
              const failedUrl = "url" in err && typeof err.url === "string" ? err.url : "";
              const failedIndex = urls.findIndex(
                (u) =>
                  (failedUrl.length > 0 && u.startsWith(failedUrl)) ||
                  (failedUrl.length > 0 && failedUrl.startsWith(u)),
              );
              const fallbackUrl =
                (failedIndex >= 0 ? urls[failedIndex + 1] : undefined) ??
                urls.find((u) => u !== failedUrl) ??
                "";
              options.logger?.warn(
                { failedRpc: failedUrl, fallbackRpc: fallbackUrl, err },
                "RPC endpoint failed, failing over to secondary RPC endpoint",
              );
              options.onFailover?.({ failedUrl, fallbackUrl, error: err });
              return false;
            },
          },
        );

  const client = createPublicClient({
    transport,
  });

  return {
    chainId: () => client.getChainId(),

    blockNumber: () => client.getBlockNumber({ cacheTime: 0 }),

    logs: async (query) => {
      const logs = await client.getLogs({
        address: query.address,
        fromBlock: query.fromBlock,
        toBlock: query.toBlock,
      });
      // No fallbacks for blockNumber, transactionHash or logIndex: viem types them as present
      // for a bounded historical range and nullable only for a pending-block filter, which this
      // never issues. A `?? 0n` here would be a default that cannot happen, hiding the one case
      // where it would matter.
      return logs.map((log) => ({
        address: log.address,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
        data: log.data,
        topics: log.topics,
        removed: log.removed,
      }));
    },

    blocks: async (numbers) => {
      const found = new Map<bigint, BlockStamp>();
      // In parallel. A backfill range can touch a few dozen blocks and serialising the lookups
      // would make the timestamps, not the logs, the slow part of a pass.
      const results = await Promise.all(
        numbers.map(async (blockNumber) => {
          try {
            const block = await client.getBlock({ blockNumber, includeTransactions: false });
            return { blockNumber, block };
          } catch {
            // A block the node no longer has is reported as absent rather than as a failure. The
            // watcher reads absence as a reorg, which is what it is.
            return { blockNumber, block: null };
          }
        }),
      );
      for (const { blockNumber, block } of results) {
        // Absent means the node no longer has that block, which the watcher reads as a reorg.
        if (block === null) continue;
        found.set(blockNumber, { hash: block.hash, timestamp: block.timestamp });
      }
      return found;
    },
  };
}
