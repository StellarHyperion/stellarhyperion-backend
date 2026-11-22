/**
 * A small, per-pass cache for immutable candidate receipt reads.
 *
 * The receipt is only shared after its block identity is known. Cache hits re-read that block
 * before returning the receipt, so a reorg or an endpoint that changes its answer cannot make a
 * stale receipt look canonical. Callers still inspect the receipt for their own transfer.
 */
export interface CandidateReceiptCacheRequest<T> {
  readonly chain: string;
  readonly txHash: string;
  readonly read: () => Promise<T>;
  readonly readBlock: (args: { readonly blockNumber: bigint }) => Promise<{
    readonly hash: string;
  }>;
  readonly identity: (receipt: T) => {
    readonly blockNumber: bigint;
    readonly blockHash: string;
  };
}

interface Entry<T> {
  readonly key: string;
  readonly txKey: string;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly value: T;
}

const DEFAULT_MAX_ENTRIES = 128;

export class BoundedCandidateReceiptCache {
  private readonly entries = new Map<string, Entry<unknown>>();
  private readonly byTransaction = new Map<string, string>();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(private readonly maxEntries = DEFAULT_MAX_ENTRIES) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1)
      throw new Error("candidate receipt cache size must be a positive safe integer");
  }

  get size(): number {
    return this.entries.size;
  }

  async get<T>(request: CandidateReceiptCacheRequest<T>): Promise<T> {
    const txKey = `${request.chain}:${request.txHash.toLowerCase()}`;
    const cachedKey = this.byTransaction.get(txKey);
    const cached = cachedKey === undefined ? undefined : this.entries.get(cachedKey);
    if (cached !== undefined) {
      try {
        const block = await request.readBlock({ blockNumber: cached.blockNumber });
        if (block.hash.toLowerCase() === cached.blockHash) return cached.value as T;
      } catch (error) {
        this.remove(cached);
        throw error;
      }
      this.remove(cached);
    }

    const pending = this.inFlight.get(txKey);
    if (pending !== undefined) return (await pending) as T;

    const read = (async (): Promise<T> => {
      const value = await request.read();
      const { blockNumber, blockHash } = request.identity(value);
      const key = `${request.chain}:${blockNumber.toString()}:${blockHash.toLowerCase()}:${txKey}`;
      const entry: Entry<T> = {
        key,
        txKey,
        blockNumber,
        blockHash: blockHash.toLowerCase(),
        value,
      };
      this.entries.delete(key);
      this.entries.set(key, entry);
      this.byTransaction.set(txKey, key);
      while (this.entries.size > this.maxEntries) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) break;
        const evicted = this.entries.get(oldest);
        if (evicted !== undefined) this.remove(evicted);
      }
      return value;
    })();
    this.inFlight.set(txKey, read);
    try {
      return await read;
    } finally {
      if (this.inFlight.get(txKey) === read) this.inFlight.delete(txKey);
    }
  }

  private remove(entry: Entry<unknown>): void {
    this.entries.delete(entry.key);
    if (this.byTransaction.get(entry.txKey) === entry.key) this.byTransaction.delete(entry.txKey);
  }
}
