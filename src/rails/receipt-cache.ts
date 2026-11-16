import type { Hex } from "viem";

import type { DeliveryLog } from "./axelar/events.js";

const DEFAULT_MAX_ENTRIES = 128;

export interface CandidateReceiptRpcClient {
  getChainId(): Promise<number>;
  getTransactionReceipt(args: { hash: Hex }): Promise<{
    readonly status: "success" | "reverted";
    readonly blockNumber: bigint;
    readonly blockHash: Hex;
    readonly transactionHash: Hex;
    readonly logs: readonly DeliveryLog[];
  }>;
  getBlockNumber(): Promise<bigint>;
  getBlock(args: { blockNumber: bigint }): Promise<{
    readonly hash: Hex | null;
    readonly timestamp: bigint;
  }>;
}

export interface CachedCandidateReceipt {
  readonly cacheKey: string;
  readonly chainKey: string;
  readonly chainId: number;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly blockTimestampSeconds: bigint;
  readonly transactionHash: Hex;
  readonly logs: readonly DeliveryLog[];
}

export interface ReceiptCacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly invalidations: number;
  readonly size: number;
  readonly maxEntries: number;
}

export interface CandidateReceiptCacheOptions {
  readonly maxEntries?: number;
}

export interface GetConfirmedReceiptArgs {
  readonly chainKey: string;
  readonly expectedChainId: number;
  readonly confirmations: number;
  readonly txHash: Hex;
  readonly expectedBlockHash?: Hex;
  readonly client: CandidateReceiptRpcClient;
}

export function formatCandidateReceiptCacheKey(args: {
  readonly chainKey: string;
  readonly chainId: number;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly txHash: Hex;
}): string {
  return [
    args.chainKey,
    String(args.chainId),
    args.blockNumber.toString(),
    args.blockHash.toLowerCase(),
    args.txHash.toLowerCase(),
  ].join(":");
}

function freezeLogs(logs: readonly DeliveryLog[]): readonly DeliveryLog[] {
  const cloned = logs.map((log) => {
    const frozenTopics = Object.freeze([...log.topics]) as [] | [Hex, ...Hex[]];
    return Object.freeze({
      address: log.address,
      topics: frozenTopics,
      data: log.data,
      logIndex: log.logIndex,
    });
  });
  return Object.freeze(cloned);
}

/**
 * Bounded pass-scoped cache of confirmed destination transaction receipts.
 *
 * Cache keys bind chain identity (`chainKey` + `chainId`), canonical block identity
 * (`blockNumber` + `blockHash`), and transaction hash. Any observed reorg or inconsistent RPC
 * evidence purges affected entries immediately, and callers still execute full per-transfer
 * message/command and token-payment matching against the immutable logs.
 */
export class CandidateReceiptCache {
  private readonly maxEntries: number;
  private readonly entries = new Map<string, CachedCandidateReceipt>();
  private readonly txIndex = new Map<string, string>();
  private readonly canonicalBlockHashes = new Map<string, Hex>();
  private readonly verifiedChainIds = new Map<string, number>();

  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private invalidations = 0;

  constructor(options: CandidateReceiptCacheOptions = {}) {
    const requested = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isInteger(requested) || requested < 1) {
      throw new Error(
        `CandidateReceiptCache maxEntries must be a positive integer, got ${String(requested)}`,
      );
    }
    this.maxEntries = requested;
  }

  get stats(): ReceiptCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      invalidations: this.invalidations,
      size: this.entries.size,
      maxEntries: this.maxEntries,
    };
  }

  hasKey(cacheKey: string): boolean {
    return this.entries.has(cacheKey);
  }

  keys(): readonly string[] {
    return [...this.entries.keys()];
  }

  /**
   * Record a canonical block hash observation for `(chainKey, chainId, blockNumber)`.
   * If a previously cached block at that height had a different hash, all cached entries on that
   * chain from `blockNumber` upward are invalidated.
   */
  observeCanonicalBlock(
    chainKey: string,
    chainId: number,
    blockNumber: bigint,
    canonicalBlockHash: Hex,
  ): number {
    const slotKey = `${chainKey}:${String(chainId)}:${blockNumber.toString()}`;
    const normalized = canonicalBlockHash.toLowerCase() as Hex;
    const prior = this.canonicalBlockHashes.get(slotKey);
    if (prior !== undefined && prior !== normalized) {
      const removed = this.invalidateFromBlock(chainKey, chainId, blockNumber);
      this.canonicalBlockHashes.set(slotKey, normalized);
      return removed;
    }
    this.canonicalBlockHashes.set(slotKey, normalized);
    return 0;
  }

  /**
   * Purge all cached receipts on `(chainKey, chainId)` at or above `fromBlockNumber` (for reorgs).
   */
  invalidateFromBlock(chainKey: string, chainId: number, fromBlockNumber: bigint): number {
    let removed = 0;
    for (const [key, entry] of this.entries.entries()) {
      if (
        entry.chainKey === chainKey &&
        entry.chainId === chainId &&
        entry.blockNumber >= fromBlockNumber
      ) {
        this.deleteEntry(key, entry);
        removed += 1;
      }
    }
    for (const slotKey of [...this.canonicalBlockHashes.keys()]) {
      const prefix = `${chainKey}:${String(chainId)}:`;
      if (slotKey.startsWith(prefix)) {
        const heightText = slotKey.slice(prefix.length);
        if (/^\d+$/.test(heightText) && BigInt(heightText) >= fromBlockNumber) {
          this.canonicalBlockHashes.delete(slotKey);
        }
      }
    }
    this.invalidations += removed;
    return removed;
  }

  /**
   * Purge a specific transaction's cached receipt when inconsistent evidence is detected.
   */
  invalidateTransaction(chainKey: string, chainId: number, txHash: Hex): boolean {
    const ptrKey = this.pointerKey(chainKey, chainId, txHash);
    const canonicalKey = this.txIndex.get(ptrKey);
    if (canonicalKey === undefined) return false;
    const existing = this.entries.get(canonicalKey);
    this.txIndex.delete(ptrKey);
    if (existing !== undefined) {
      this.entries.delete(canonicalKey);
      this.invalidations += 1;
      return true;
    }
    return false;
  }

  async getConfirmedReceipt(args: GetConfirmedReceiptArgs): Promise<CachedCandidateReceipt | null> {
    const normalizedTxHash = args.txHash.toLowerCase() as Hex;
    const ptrKey = this.pointerKey(args.chainKey, args.expectedChainId, normalizedTxHash);
    const existingCanonicalKey = this.txIndex.get(ptrKey);

    if (existingCanonicalKey !== undefined) {
      const cached = this.entries.get(existingCanonicalKey);
      if (cached !== undefined) {
        const expectedBlock =
          args.expectedBlockHash === undefined
            ? undefined
            : (args.expectedBlockHash.toLowerCase() as Hex);
        const recordedCanonical = this.canonicalBlockHashes.get(
          `${args.chainKey}:${String(args.expectedChainId)}:${cached.blockNumber.toString()}`,
        );

        const inconsistent =
          cached.chainKey !== args.chainKey ||
          cached.chainId !== args.expectedChainId ||
          cached.transactionHash.toLowerCase() !== normalizedTxHash ||
          (expectedBlock !== undefined && cached.blockHash.toLowerCase() !== expectedBlock) ||
          (recordedCanonical !== undefined && cached.blockHash.toLowerCase() !== recordedCanonical);

        if (inconsistent) {
          this.invalidateFromBlock(args.chainKey, args.expectedChainId, cached.blockNumber);
        } else {
          // Refresh LRU position on hit.
          this.entries.delete(existingCanonicalKey);
          this.entries.set(existingCanonicalKey, cached);
          this.hits += 1;
          return cached;
        }
      } else {
        this.txIndex.delete(ptrKey);
      }
    }

    this.misses += 1;

    let observedChainId = this.verifiedChainIds.get(args.chainKey);
    if (observedChainId === undefined) {
      observedChainId = await args.client.getChainId();
      if (observedChainId !== args.expectedChainId) {
        throw new Error(
          `Destination RPC chain mismatch for ${args.chainKey}: expected ${String(args.expectedChainId)}, got ${String(observedChainId)}`,
        );
      }
      this.verifiedChainIds.set(args.chainKey, observedChainId);
    }

    const receipt = await args.client.getTransactionReceipt({ hash: args.txHash });
    if (receipt.transactionHash.toLowerCase() !== normalizedTxHash) {
      this.invalidateTransaction(args.chainKey, args.expectedChainId, normalizedTxHash);
      return null;
    }
    if (receipt.status !== "success") {
      this.invalidateTransaction(args.chainKey, args.expectedChainId, normalizedTxHash);
      return null;
    }

    const head = await args.client.getBlockNumber();
    if (head < receipt.blockNumber) {
      this.invalidateFromBlock(args.chainKey, args.expectedChainId, head + 1n);
      return null;
    }
    if (head - receipt.blockNumber + 1n < BigInt(args.confirmations)) {
      return null;
    }

    const block = await args.client.getBlock({ blockNumber: receipt.blockNumber });
    const observedBlockHash = block.hash?.toLowerCase();
    if (
      observedBlockHash === undefined ||
      observedBlockHash !== receipt.blockHash.toLowerCase() ||
      (args.expectedBlockHash !== undefined &&
        observedBlockHash !== args.expectedBlockHash.toLowerCase())
    ) {
      const invalidated = this.invalidateFromBlock(
        args.chainKey,
        args.expectedChainId,
        receipt.blockNumber,
      );
      if (invalidated === 0) {
        this.invalidations += 1;
      }
      return null;
    }

    const normalizedBlockHash = observedBlockHash as Hex;
    this.observeCanonicalBlock(
      args.chainKey,
      args.expectedChainId,
      receipt.blockNumber,
      normalizedBlockHash,
    );

    const cacheKey = formatCandidateReceiptCacheKey({
      chainKey: args.chainKey,
      chainId: args.expectedChainId,
      blockNumber: receipt.blockNumber,
      blockHash: normalizedBlockHash,
      txHash: normalizedTxHash,
    });

    const immutableEntry: CachedCandidateReceipt = Object.freeze({
      cacheKey,
      chainKey: args.chainKey,
      chainId: args.expectedChainId,
      blockNumber: receipt.blockNumber,
      blockHash: normalizedBlockHash,
      blockTimestampSeconds: block.timestamp,
      transactionHash: receipt.transactionHash,
      logs: freezeLogs(receipt.logs),
    });

    this.insertBounded(ptrKey, cacheKey, immutableEntry);
    return immutableEntry;
  }

  private insertBounded(ptrKey: string, cacheKey: string, entry: CachedCandidateReceipt): void {
    if (this.entries.has(cacheKey)) {
      this.entries.delete(cacheKey);
    }
    while (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      const oldestEntry = this.entries.get(oldestKey);
      if (oldestEntry !== undefined) {
        this.deleteEntry(oldestKey, oldestEntry);
        this.evictions += 1;
      } else {
        this.entries.delete(oldestKey);
      }
    }
    this.entries.set(cacheKey, entry);
    this.txIndex.set(ptrKey, cacheKey);
  }

  private deleteEntry(key: string, entry: CachedCandidateReceipt): void {
    this.entries.delete(key);
    const ptrKey = this.pointerKey(entry.chainKey, entry.chainId, entry.transactionHash);
    if (this.txIndex.get(ptrKey) === key) {
      this.txIndex.delete(ptrKey);
    }
  }

  private pointerKey(chainKey: string, chainId: number, txHash: string): string {
    return `${chainKey}:${String(chainId)}:${txHash.toLowerCase()}`;
  }
}
