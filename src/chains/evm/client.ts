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
import type { ChainKey } from "@hyperion/protocol";
import type { Logger } from "pino";
import { createPublicClient, fallback, http, shouldThrow } from "viem";
import type { Abi, Hex } from "viem";

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

/**
 * Return only the scheme and host[:port] of an RPC URL so credentials, API-key paths, query
 * parameters, and fragments never reach logs or persisted error text.
 */
export function redactRpcEndpoint(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (
      parsed.host === "" ||
      (parsed.protocol !== "http:" &&
        parsed.protocol !== "https:" &&
        parsed.protocol !== "ws:" &&
        parsed.protocol !== "wss:")
    ) {
      return "[redacted-endpoint]";
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "[redacted-endpoint]";
  }
}

/**
 * Scrub full RPC URLs and authorization header fragments from transport error messages.
 */
export function sanitizeRpcErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, (match) => redactRpcEndpoint(match))
    .replace(/authorization\s*[:=]\s*[^\r\n,;]+/gi, "authorization: [redacted]")
    .replace(/bearer\s+[^\s"',;\r\n]+/gi, "Bearer [redacted]");
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
                {
                  failedRpc: redactRpcEndpoint(failedUrl),
                  fallbackRpc: redactRpcEndpoint(fallbackUrl),
                  reason: sanitizeRpcErrorMessage(err),
                },
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

export interface DestinationReceiptLog {
  readonly address: Hex;
  readonly topics: [] | [Hex, ...Hex[]];
  readonly data: Hex;
  readonly logIndex: number;
}

export interface DestinationReceipt {
  readonly transactionHash: Hex;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly status: "success" | "reverted";
  readonly logs: readonly DestinationReceiptLog[];
}

export interface DestinationBlock {
  readonly number: bigint;
  readonly hash: Hex;
  readonly timestamp: bigint;
}

export interface DestinationContractRead {
  readonly address: Hex;
  readonly abi: Abi;
  readonly functionName: string;
  readonly args?: readonly unknown[];
}

export interface DestinationFailoverEvent {
  readonly chain?: ChainKey;
  readonly failedEndpoint: string;
  readonly fallbackEndpoint: string;
  readonly reason: string;
}

export interface DestinationVerifierClient {
  getChainId(signal?: AbortSignal): Promise<number>;
  getTransactionReceipt(hash: Hex, signal?: AbortSignal): Promise<DestinationReceipt>;
  getBlockNumber(signal?: AbortSignal): Promise<bigint>;
  getBlock(blockNumber: bigint, signal?: AbortSignal): Promise<DestinationBlock>;
  readContract(request: DestinationContractRead, signal?: AbortSignal): Promise<unknown>;
}

export interface DestinationVerifierClientOptions {
  readonly chainKey?: ChainKey;
  readonly timeoutMs?: number;
  readonly retryCount?: number;
  readonly logger?: Logger;
  readonly fetchFn?: typeof globalThis.fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly onFailover?: (event: DestinationFailoverEvent) => void;
}

export interface DestinationClientFactoryInput {
  readonly chain: ChainKey;
  readonly chainId: number;
  readonly rpcUrls: readonly string[];
  readonly timeoutMs: number;
  readonly logger?: Logger;
}

export type DestinationClientFactory = (
  input: DestinationClientFactoryInput,
) => DestinationVerifierClient;

export class DestinationChainMismatchError extends Error {
  constructor(
    readonly expectedChainId: number,
    readonly actualChainId: number,
    readonly endpoint: string,
  ) {
    super(
      `Destination RPC chain mismatch at ${endpoint}: expected chain ${String(expectedChainId)}, got ${String(actualChainId)}.`,
    );
    this.name = "DestinationChainMismatchError";
  }
}

/**
 * Build a bounded-failover destination verification client for CCTP and ITS payouts.
 *
 * Every endpoint must prove `eth_chainId === expectedChainId` before any receipt, head, contract,
 * or block response from that endpoint is accepted, including after mid-pass failover.
 */
export function createDestinationVerifierClient(
  rpcUrls: string | readonly string[],
  expectedChainId: number,
  options: DestinationVerifierClientOptions = {},
): DestinationVerifierClient {
  const urls = typeof rpcUrls === "string" ? [rpcUrls] : [...rpcUrls];
  if (urls.length === 0) {
    throw new Error("at least one destination RPC URL is required");
  }

  const timeout = options.timeoutMs ?? 15_000;
  const retryCount = options.retryCount ?? 0;
  const baseFetch = options.fetchFn ?? globalThis.fetch;
  let currentSignal: AbortSignal | undefined;

  const signalAwareFetch: typeof globalThis.fetch = async (input, init) => {
    currentSignal?.throwIfAborted();
    const signals: AbortSignal[] = [];
    if (init?.signal) signals.push(init.signal);
    if (currentSignal) signals.push(currentSignal);
    const mergedSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    const mergedHeaders =
      options.headers === undefined
        ? init?.headers
        : {
            ...(init?.headers instanceof Headers
              ? Object.fromEntries(init.headers.entries())
              : Array.isArray(init?.headers)
                ? Object.fromEntries(init.headers)
                : init?.headers),
            ...options.headers,
          };
    return baseFetch(input, {
      ...init,
      ...(mergedSignal ? { signal: mergedSignal } : {}),
      ...(mergedHeaders ? { headers: mergedHeaders } : {}),
    });
  };

  const clients = urls.map((url) =>
    createPublicClient({
      transport: http(url, {
        fetchFn: signalAwareFetch,
        timeout,
        retryCount,
      }),
    }),
  );

  let activeIndex = 0;
  const verifiedEndpoints = new Set<number>();

  async function ensureChainVerified(index: number): Promise<void> {
    if (verifiedEndpoints.has(index)) return;
    const client = clients[index];
    const url = urls[index];
    if (!client || url === undefined) {
      throw new Error("destination RPC endpoint index out of bounds");
    }
    const actualChainId = await client.getChainId();
    if (actualChainId !== expectedChainId) {
      throw new DestinationChainMismatchError(
        expectedChainId,
        actualChainId,
        redactRpcEndpoint(url),
      );
    }
    verifiedEndpoints.add(index);
  }

  async function executeWithFailover<T>(
    signal: AbortSignal | undefined,
    run: (client: (typeof clients)[number]) => Promise<T>,
  ): Promise<T> {
    signal?.throwIfAborted();
    for (let idx = activeIndex; idx < clients.length; idx += 1) {
      const client = clients[idx];
      const url = urls[idx];
      if (!client || url === undefined) continue;
      const previousSignal = currentSignal;
      currentSignal = signal;
      try {
        signal?.throwIfAborted();
        await ensureChainVerified(idx);
        const result = await run(client);
        activeIndex = idx;
        return result;
      } catch (err) {
        if (signal?.aborted) {
          throw err;
        }
        if (
          !(err instanceof DestinationChainMismatchError) &&
          err instanceof Error &&
          shouldThrow(err)
        ) {
          throw new Error(sanitizeRpcErrorMessage(err));
        }
        const nextUrl = urls[idx + 1];
        const failedEndpoint = redactRpcEndpoint(url);
        const reason = sanitizeRpcErrorMessage(err);
        if (nextUrl !== undefined) {
          const fallbackEndpoint = redactRpcEndpoint(nextUrl);
          options.logger?.warn(
            {
              ...(options.chainKey ? { chain: options.chainKey } : {}),
              failedEndpoint,
              fallbackEndpoint,
              reason,
            },
            "destination RPC endpoint failed, failing over to secondary endpoint",
          );
          options.onFailover?.({
            ...(options.chainKey ? { chain: options.chainKey } : {}),
            failedEndpoint,
            fallbackEndpoint,
            reason,
          });
          activeIndex = idx + 1;
          continue;
        }
        if (err instanceof DestinationChainMismatchError) {
          throw err;
        }
        throw new Error(`Destination RPC verification failed at ${failedEndpoint}: ${reason}`);
      } finally {
        currentSignal = previousSignal;
      }
    }
    throw new Error("all destination RPC endpoints exhausted");
  }

  return {
    getChainId: (signal) => executeWithFailover(signal, () => Promise.resolve(expectedChainId)),

    getTransactionReceipt: (hash, signal) =>
      executeWithFailover(signal, async (client) => {
        const receipt = await client.getTransactionReceipt({ hash });
        return {
          transactionHash: receipt.transactionHash,
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
          status: receipt.status,
          logs: receipt.logs.map((log) => ({
            address: log.address,
            topics: log.topics,
            data: log.data,
            logIndex: log.logIndex,
          })),
        };
      }),

    getBlockNumber: (signal) =>
      executeWithFailover(signal, (client) => client.getBlockNumber({ cacheTime: 0 })),

    getBlock: (blockNumber, signal) =>
      executeWithFailover(signal, async (client) => {
        const block = await client.getBlock({ blockNumber, includeTransactions: false });
        return {
          number: block.number,
          hash: block.hash,
          timestamp: block.timestamp,
        };
      }),

    readContract: (request, signal) =>
      executeWithFailover(signal, (client) =>
        client.readContract({
          address: request.address,
          abi: request.abi,
          functionName: request.functionName,
          ...(request.args ? { args: request.args } : {}),
        }),
      ),
  };
}
