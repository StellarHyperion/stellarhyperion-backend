import { describe, expect, it } from "vitest";
import { parseReconcileArguments } from "../../src/rails/axelar/reconcile-cli.js";
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
                  destination: `0x${"44".repeat(20)}`,
                  provider_status: "executed",
                  rail_reference: "message-id",
                  last_checked_at: new Date("2026-11-19T12:00:00.000Z"),
                  destination_tx: "destination-tx",
                  rail_message_id: "message-id",
                  recipient: `0x${"44".repeat(20)}`,
                  destination_token: "0xtoken",
                  destination_amount: "900719925474099312345678",
                  delivered: true,
                  origin_router: "",
                  evidence_id: "5",
                  evidence_status: "canonical",
                  evidence_chain: "ethereum-sepolia",
                  execution_tx_hash: "destination-tx",
                  command_id: "message-id",
                  registered_token: "0xtoken",
                  payment_recipient: `0x${"44".repeat(20)}`,
                  payment_amount: "900719925474099312345678",
                  source_binding: {
                    chain: "stellar-testnet",
                    router: "",
                    nonce: "18446744073709551615",
                    transaction: "source-tx",
                    sender: "sender",
                    token: "token",
                    amount: "900719925474099312345678",
                    destinationChain: "ethereum-sepolia",
                    destination: `0x${"44".repeat(20)}`,
                  },
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

describe("bounded reconciliation arguments", () => {
  it("preserves full-width IDs and rejects malformed, repeated or excessive arguments", () => {
    expect(
      parseReconcileArguments([
        "--transfer-id",
        "9223372036854775807",
        "--limit",
        "500",
        "--format",
        "json",
      ]),
    ).toEqual({ transferId: 9223372036854775807n, limit: 500 });
    for (const args of [
      ["--transfer-id", "9223372036854775808"],
      ["--limit", "501"],
      ["--limit"],
      ["--unknown", "1"],
      ["--format", "text"],
      ["--limit", "1", "--limit", "2"],
    ])
      expect(() => parseReconcileArguments(args)).toThrow("Invalid reconciliation");
  });
});
