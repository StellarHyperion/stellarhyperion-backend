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
import type { Hex, PublicClient } from "viem";

export type DestinationVerificationViemClient = PublicClient;

export interface DestinationRpcClient {
  getChainId(): Promise<number>;
}

export type DestinationVerificationClientFactory<
  TClient extends DestinationRpcClient = DestinationVerificationViemClient,
> = (url: string, signal?: AbortSignal) => TClient;

export interface DestinationVerificationOptions {
  readonly signal?: AbortSignal;
  readonly logger?: Logger;
  readonly chain: string;
  readonly clientForUrl?: DestinationVerificationClientFactory;
}

const DESTINATION_RPC_ATTEMPT_TIMEOUT_MS = 45_000;

export class DestinationVerificationRpcError extends Error {
  constructor(readonly reason: "chain_mismatch" | "rpc_failure" | "inconsistent_evidence") {
    super(
      reason === "chain_mismatch"
        ? "Destination verification RPC endpoints reported the wrong chain."
        : reason === "inconsistent_evidence"
          ? "Destination verification RPC endpoints returned inconsistent evidence."
          : "Destination verification RPC endpoints are unavailable.",
    );
    this.name = "DestinationVerificationRpcError";
  }
}

/** Create a bounded, cancellable HTTP RPC client for one destination endpoint. */
export function destinationVerificationViemClient(
  url: string,
  signal?: AbortSignal,
): DestinationVerificationViemClient {
  const fetchFn: typeof globalThis.fetch | undefined =
    signal === undefined
      ? undefined
      : (input, init) => {
          const combinedSignal =
            init?.signal === undefined || init.signal === null
              ? signal
              : AbortSignal.any([signal, init.signal]);
          return globalThis.fetch(input, { ...init, signal: combinedSignal });
        };
  return createPublicClient({
    transport: http(url, {
      timeout: 15_000,
      retryCount: 0,
      fetchFn,
    }),
  });
}

/**
 * Keep an entire evidence check on one endpoint. If any request fails, restart the check against
 * the next endpoint rather than combining a receipt from one RPC with a block or payment from
 * another.
 */
export async function withDestinationVerification<TClient extends DestinationRpcClient, TResult>(
  urls: readonly string[],
  expectedChainId: number,
  clientForUrl: DestinationVerificationClientFactory<TClient>,
  verify: (client: TClient) => Promise<TResult>,
  options: DestinationVerificationOptions,
): Promise<TResult> {
  let failure: DestinationVerificationRpcError["reason"] = "rpc_failure";
  let result: { readonly value: TResult } | undefined;
  const baselineReads: {
    readonly method: string;
    readonly args: unknown;
    readonly result: unknown;
  }[] = [];
  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index];
    if (url === undefined) continue;
    options.signal?.throwIfAborted();
    const attemptSignal = AbortSignal.timeout(DESTINATION_RPC_ATTEMPT_TIMEOUT_MS);
    const signal =
      options.signal === undefined
        ? attemptSignal
        : AbortSignal.any([options.signal, attemptSignal]);
    try {
      const client = clientForUrl(url, signal);
      if ((await client.getChainId()) !== expectedChainId) {
        failure = "chain_mismatch";
        throw new Error("Destination RPC chain mismatch.");
      }
      signal.throwIfAborted();
      let readIndex = 0;
      const trackedClient = new Proxy(client, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver) as unknown;
          if (
            typeof value !== "function" ||
            !["getTransactionReceipt", "getBlock", "readContract"].includes(String(property))
          )
            return value;
          return (...args: readonly unknown[]): Promise<unknown> =>
            Promise.resolve(Reflect.apply(value, target, [...args]) as unknown).then(
              (observed: unknown): unknown => {
                const read = {
                  method: String(property),
                  args: canonicalEvidence(args),
                  result: canonicalEvidence(observed),
                };
                const previous = baselineReads[readIndex];
                if (
                  previous !== undefined &&
                  (previous.method !== read.method ||
                    JSON.stringify(previous.args) !== JSON.stringify(read.args) ||
                    JSON.stringify(previous.result) !== JSON.stringify(read.result))
                )
                  throw new DestinationVerificationRpcError("inconsistent_evidence");
                if (previous === undefined) baselineReads.push(read);
                readIndex += 1;
                return observed;
              },
            );
        },
      });
      const observedResult = await verify(trackedClient);
      signal.throwIfAborted();
      if (
        result !== undefined &&
        JSON.stringify(canonicalEvidence(result.value)) !==
          JSON.stringify(canonicalEvidence(observedResult))
      )
        throw new DestinationVerificationRpcError("inconsistent_evidence");
      result ??= { value: observedResult };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (
        error instanceof DestinationVerificationRpcError &&
        error.reason === "inconsistent_evidence"
      )
        throw error;
      failure =
        error instanceof Error && error.message === "Destination RPC chain mismatch."
          ? "chain_mismatch"
          : "rpc_failure";
      const nextUrl = urls[index + 1];
      if (nextUrl !== undefined) {
        options.logger?.warn(
          {
            chain: options.chain,
            failedEndpoint: safeRpcEndpointIdentity(url),
            nextEndpoint: safeRpcEndpointIdentity(nextUrl),
            failure,
          },
          "Destination verification RPC failed; retrying the complete proof on the next endpoint",
        );
      } else {
        options.logger?.error(
          {
            chain: options.chain,
            failedEndpoint: safeRpcEndpointIdentity(url),
            failure,
          },
          "Destination verification RPC endpoints exhausted",
        );
      }
    }
  }
  if (result !== undefined) return result.value;
  throw new DestinationVerificationRpcError(failure);
}

function canonicalEvidence(value: unknown): unknown {
  if (typeof value === "bigint") return { bigint: value.toString() };
  if (Array.isArray(value)) return value.map(canonicalEvidence);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalEvidence(entry)]),
  );
}

/** Endpoint identity omits URL credentials, path segments, query parameters, and fragments. */
export function safeRpcEndpointIdentity(url: string): string {
  const parsed = new URL(url);
  return parsed.origin;
}

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
  /** Explicit finalized-block evidence; absent support is never an implicit depth fallback. */
  finalizedBlock?(signal?: AbortSignal): Promise<{ readonly number: bigint; readonly hash: Hex }>;
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
    readonly failedEndpoint: string;
    readonly fallbackEndpoint: string;
  }) => void;
  readonly fetchFn?: typeof globalThis.fetch;
}

function safeEndpointLabel(url: string): string {
  if (url.length === 0) return "unknown";
  try {
    return safeRpcEndpointIdentity(url);
  } catch {
    return "configured RPC endpoint";
  }
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
              const failedEndpoint = safeEndpointLabel(failedUrl);
              const fallbackEndpoint = safeEndpointLabel(fallbackUrl);
              options.logger?.warn(
                { failedEndpoint, fallbackEndpoint },
                "RPC endpoint failed, failing over to secondary RPC endpoint",
              );
              options.onFailover?.({ failedEndpoint, fallbackEndpoint });
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

    finalizedBlock: async () => {
      const block = await client.getBlock({ blockTag: "finalized", includeTransactions: false });
      return { number: block.number, hash: block.hash };
    },

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
