import { describe, expect, it, vi } from "vitest";
import { BoundedCandidateReceiptCache } from "../../src/rails/candidate-receipt-cache.js";

describe("BoundedCandidateReceiptCache", () => {
  it("shares canonical reads, invalidates on block changes, and evicts oldest entries", async () => {
    const cache = new BoundedCandidateReceiptCache(1);
    let blockHash = "0xaaa";
    const read = vi.fn(() => Promise.resolve({ blockNumber: 7n, blockHash, value: "receipt" }));
    const readBlock = vi.fn(() => Promise.resolve({ hash: blockHash }));
    const request = () =>
      cache.get({
        chain: "chain-a",
        txHash: "0xTx",
        read,
        readBlock,
        identity: (receipt) => receipt,
      });

    await request();
    await request();
    expect(read).toHaveBeenCalledTimes(1);
    expect(readBlock).toHaveBeenCalledTimes(1);

    blockHash = "0xbbb";
    await request();
    expect(read).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(1);
  });
});
