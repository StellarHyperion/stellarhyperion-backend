import { describe, expect, it } from "vitest";
import { StellarWatcher } from "../../src/chains/stellar/watcher.js";
import {
  FakeRpc,
  LIVE_ROUTER,
  RecordingDb,
  capturingLogger,
  syntheticEvent,
} from "../stellar-fakes.js";

const CHAIN = "stellar-testnet";
const START_LEDGER = 4_965_951;

describe("deterministic indexer crash rehearsal", () => {
  it.each(["before-source-write", "after-source-write", "before-commit"] as const)(
    "replays safely after a %s crash",
    async (crashAt) => {
      const db = new RecordingDb();
      const rpc = new FakeRpc({
        events: [
          syntheticEvent({
            ledger: START_LEDGER,
            topicJson: [{ symbol: "hyperion" }, { symbol: "queued" }],
            valueJson: {
              map: [
                {
                  key: { symbol: "action" },
                  val: { vec: [{ symbol: "EnableRoute" }, { u32: 1 }] },
                },
                { key: { symbol: "eta" }, val: { u64: "1790860267" } },
                { key: { symbol: "expires_at" }, val: { u64: "1791465067" } },
                { key: { symbol: "id" }, val: { u64: "7" } },
              ],
            },
          }),
        ],
        latestLedger: START_LEDGER + 1,
      });
      const first = () => {
        const { logger } = capturingLogger();
        return new StellarWatcher({
          chainKey: CHAIN,
          router: LIVE_ROUTER,
          startLedger: START_LEDGER,
          pageSize: 200,
          rpc,
          db,
          logger,
        });
      };

      db.crashAt = crashAt;
      await expect(first().tick(AbortSignal.timeout(5_000))).rejects.toThrow("injected crash");
      expect(db.rollbacks).toHaveLength(1);
      // The crashed process no longer renews its lease. Advance the fake clock
      // past the lease expiry before the replacement worker takes over.
      if (db.leaseRow !== null) db.leaseRow.lease_until = new Date(0);

      await first().tick(AbortSignal.timeout(5_000));
      expect(db.sourceEvents).toBe(1);
      expect(db.cursorRow).not.toBeNull();
      expect(db.commits).toHaveLength(1);
    },
  );
});
