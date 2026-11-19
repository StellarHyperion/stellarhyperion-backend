import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database } from "../../src/db/pool.js";
import { quarantineEvmLog } from "../../src/chains/evm/store.js";

const connection = process.env.TEST_DATABASE_URL;
const suite = connection ? describe : describe.skip;
suite("EVM quarantine retention across replicas", () => {
  let db: Database;
  const chainKey = "quarantine-test";
  beforeAll(async () => {
    db = Database.open(connection ?? "");
    await db.query("DELETE FROM evm_log_quarantine WHERE chain_key = $1", [chainKey]);
  });
  afterAll(async () => {
    await db.query("DELETE FROM evm_log_quarantine WHERE chain_key = $1", [chainKey]);
    await db.close();
  });
  it("retains at most 1000 diagnostics after concurrent insertions", async () => {
    await db.query(
      `INSERT INTO evm_log_quarantine(chain_key, block_number, transaction_hash, log_index, event_name, reason)
      SELECT $1, i, 'hash-' || i, 0, 'BridgeIn', 'reversed' FROM generate_series(1, 1000) i`,
      [chainKey],
    );
    await Promise.all(
      [1001, 1002].map((block) =>
        db.transaction((tx) =>
          quarantineEvmLog(
            tx,
            {
              chainKey,
              block: BigInt(block),
              txHash: `hash-${block}`,
              logIndex: 0,
              eventName: "BridgeIn",
              reason: "reversed",
            },
            new Date(),
          ),
        ),
      ),
    );
    const { rows } = await db.query(
      "SELECT count(*)::integer AS count, min(block_number)::text AS first FROM evm_log_quarantine WHERE chain_key = $1",
      [chainKey],
    );
    expect(rows[0]).toEqual({ count: 1000, first: "3" });
  });
});
