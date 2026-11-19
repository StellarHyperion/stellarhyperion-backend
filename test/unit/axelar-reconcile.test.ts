import { describe, expect, it } from "vitest";
import { reconcileItsTransfers } from "../../src/rails/axelar/reconcile.js";
import type { QueryResultRows, Transactional } from "../../src/db/pool.js";

describe("ITS reconciliation", () => {
  it("uses a read-only snapshot and preserves integer source and payout amounts", async () => {
    const queries: string[] = [];
    const db: Transactional = {
      query: () => Promise.resolve({ rows: [], rowCount: 0 }),
      transaction: <T>(work: (tx: Transactional) => Promise<T>) =>
        work({
          query: (sql): Promise<QueryResultRows> => {
            queries.push(sql);
            if (sql.startsWith("SET TRANSACTION"))
              return Promise.resolve({ rows: [], rowCount: 0 });
            return Promise.resolve({
              rowCount: 1,
              rows: [
                {
                  id: "7",
                  origin_chain: "stellar-testnet",
                  nonce: "18446744073709551615",
                  origin_tx: "source-tx",
                  sender: "sender",
                  token: "token",
                  net_amount: "900719925474099312345678",
                  destination_chain: "ethereum-sepolia",
                  destination: "0xrecipient",
                  provider_status: "executed",
                  rail_reference: "message-id",
                  last_checked_at: new Date("2026-11-19T12:00:00.000Z"),
                  destination_tx: "destination-tx",
                  rail_message_id: "message-id",
                  recipient: "0xrecipient",
                  destination_token: "0xtoken",
                  destination_amount: "900719925474099312345678",
                  delivered: true,
                },
              ],
            });
          },
        } as Transactional),
    };

    const report = await reconcileItsTransfers(db);

    expect(queries[0]).toContain("READ ONLY");
    expect(report.rows[0]).toMatchObject({
      transferId: "7",
      state: "reconciled",
      source: { nonce: "18446744073709551615", amount: "900719925474099312345678" },
      destination: { amount: "900719925474099312345678", delivered: true },
    });
  });
});
