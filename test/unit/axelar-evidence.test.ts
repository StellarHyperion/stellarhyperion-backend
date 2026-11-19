import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/config.js";
import type { Database, Transactional } from "../../src/db/pool.js";
import { buildServer } from "../../src/http/server.js";
import { revalidateItsDeliveryProofs } from "../../src/rails/axelar/delivery.js";
import { AxelarGmpClient, bounded } from "../../src/rails/axelar/gmp.js";
import type { PendingTransfer } from "../../src/rails/types.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const config = loadConfig({ env: completeEnv() });
const transfer: PendingTransfer = {
  transferId: 1n,
  route: 1,
  originChain: "stellar-testnet",
  destinationChain: "sepolia",
  nonce: 1n,
  originTx: `0x${"ab".repeat(32)}`,
  status: null,
  checkFailures: 0,
  retryAttempts: 0,
  delivered: false,
};
const hash = `0x${"cd".repeat(32)}` as const;

function proofDb(stale = false) {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const query = async (sql: string, params: readonly unknown[] = []) => {
    await Promise.resolve();
    calls.push({ sql, params });
    if (sql.startsWith("SELECT id, transfer_id"))
      return {
        rowCount: 1,
        rows: [
          {
            id: "2",
            transfer_id: "1",
            destination_chain: "sepolia",
            execution_tx_hash: transfer.originTx,
            receipt_block: "10",
            receipt_block_hash: hash,
          },
        ],
      };
    return {
      rowCount: sql.includes("UPDATE axelar_delivery_evidence") && stale ? 0 : 1,
      rows: [{ id: "1" }],
    };
  };
  return {
    calls,
    db: {
      query,
      transaction: (fn: (tx: { query: typeof query }) => unknown) => Promise.resolve(fn({ query })),
    } as unknown as Transactional,
  };
}

describe("Axelar stored proof and schema fault boundaries", () => {
  it("requeues an orphan only after locking its source and matching the exact stored receipt", async () => {
    const { db, calls } = proofDb();
    const count = await revalidateItsDeliveryProofs(config, db, 5, {
      clientForChain: () => ({
        getChainId: () => Promise.resolve(11155111),
        getBlock: () => Promise.resolve({ hash: `0x${"ef".repeat(32)}` }),
        getTransactionReceipt: async () => {
          await Promise.resolve();
          throw new Error("orphan must not read receipt");
        },
      }),
    });
    expect(count).toBe(1);
    expect(calls.some(({ sql }) => sql.includes("FOR UPDATE SKIP LOCKED"))).toBe(true);
    expect(
      calls.find(({ sql }) => sql.includes("UPDATE axelar_delivery_evidence"))?.params,
    ).toEqual(["2", "1", transfer.originTx, "10", hash, "orphaned"]);
    expect(calls.some(({ sql }) => sql.includes("next_attempt_at = now()"))).toBe(true);
  });
  it("does not delete a replacement proof when the remote observation became stale", async () => {
    const { db, calls } = proofDb(true);
    expect(
      await revalidateItsDeliveryProofs(config, db, 5, {
        clientForChain: () => ({
          getChainId: () => Promise.resolve(11155111),
          getBlock: () => Promise.resolve({ hash: `0x${"ef".repeat(32)}` }),
          getTransactionReceipt: async () => {
            await Promise.resolve();
            throw new Error("not called");
          },
        }),
      }),
    ).toBe(0);
    expect(calls.some(({ sql }) => sql.includes("DELETE FROM inbound_delivery"))).toBe(false);
    expect(calls.some(({ sql }) => sql.includes("UPDATE rail_attestation"))).toBe(false);
  });
  it.each([
    null,
    7,
    [],
    { status: "new_status", call: { transactionHash: transfer.originTx } },
    { status: "called", call: { transactionHash: transfer.originTx }, executed: "invalid" },
  ])("retains unsupported row %j without claiming delivery", async (row) => {
    const client = new AxelarGmpClient("https://provider.invalid", {
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ data: [row] }), {
            headers: { "content-type": "application/json" },
          }),
        ),
    });
    const result = await client.look(transfer);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.report.status).toBe("pending");
      expect(result.report.quarantine).toBeDefined();
    }
  });
  it("redacts nested credentials, basic auth and free-form secrets while bounding diagnostics", () => {
    const payload = bounded({
      signer: "never-print",
      message: "Authorization: Basic Zm9vOmJhcg== secret=never-print",
      many: "x".repeat(20000),
      nested: {
        mnemonic: "never-print",
        url: "https://user:never-print@host/path?api_key=never-print",
      },
    });
    expect(JSON.stringify(payload)).not.toContain("never-print");
    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(16384);
  });
  it("rejects invalid evidence identifiers before querying PostgreSQL", async () => {
    let queries = 0;
    const { logger } = capturingLogger();
    const app = buildServer({
      config,
      logger,
      readiness: [],
      db: {
        query: async () => {
          await Promise.resolve();
          queries++;
          return { rows: [], rowCount: 0 };
        },
      } as unknown as Database,
    });
    try {
      for (const id of ["abc", "0", "9223372036854775808"])
        expect((await app.inject(`/v1/transfers/${id}/evidence`)).statusCode).toBe(400);
      expect(queries).toBe(0);
    } finally {
      await app.close();
    }
  });
});
