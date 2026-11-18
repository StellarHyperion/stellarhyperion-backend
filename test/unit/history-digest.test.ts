import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  computeHistoryDigest,
  recordHistoryDigest,
  verifyHistoryDigest,
  writeClaim,
  writeInbound,
  writeOutbound,
} from "../../src/chains/writers.js";
import type { Queryable } from "../../src/db/pool.js";

const pg = new PGlite();

const db: Queryable = {
  async query(sql: string, params: readonly unknown[] = []) {
    const result = await pg.query(sql, [...params]);
    const int8 = result.fields
      .filter((field) => field.dataTypeID === 20)
      .map((field) => field.name);
    const rows = result.rows.map((raw) => {
      const row = { ...(raw as Record<string, unknown>) };
      for (const column of int8) {
        const value = row[column];
        if (typeof value === "number" || typeof value === "bigint") {
          row[column] = String(value);
        }
      }
      return row;
    });
    return { rows, rowCount: result.affectedRows ?? result.rows.length };
  },
};

const U256_LARGE = "115792089237316195423570985008687907853269984665640564039457584007913129639900";

describe("indexed-history integrity digests (#63)", () => {
  beforeAll(async () => {
    for (const name of [
      "1790900000000_initial-schema.sql",
      "1791000000000_cursor-block-hash.sql",
      "1791600000000_indexed-history-digests.sql",
    ]) {
      const sql = readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8").split(
        "-- Down Migration",
      )[0]!;
      await pg.exec(sql);
    }
  }, 30_000);

  afterAll(async () => {
    await pg.close();
  });

  beforeEach(async () => {
    await pg.exec(
      "TRUNCATE indexed_history_digest, pending_claim, inbound_delivery, outbound_transfer RESTART IDENTITY CASCADE",
    );
  });

  it("computes a deterministic digest independent of insert order and observed_at", async () => {
    await writeOutbound(
      db,
      {
        chainKey: "stellar-testnet",
        block: 100n,
        txHash: "tx-100",
        logIndex: null,
        observedAt: new Date("2026-01-01T00:00:00Z"),
      },
      {
        route: 0,
        nonce: 2n,
        sender: "Gsender2",
        token: "USDC",
        grossAmount: BigInt(U256_LARGE),
        fee: 30n,
        netAmount: BigInt(U256_LARGE) - 30n,
        destinationChain: "sepolia",
        destination: "0x0000000000000000000000000000000000000002",
        railRef: null,
      },
    );
    await writeOutbound(
      db,
      {
        chainKey: "stellar-testnet",
        block: 99n,
        txHash: "tx-99",
        logIndex: null,
        observedAt: new Date("2026-01-01T00:00:05Z"),
      },
      {
        route: 1,
        nonce: 1n,
        sender: "Gsender1",
        token: "USDC",
        grossAmount: 1000n,
        fee: 10n,
        netAmount: 990n,
        destinationChain: "sepolia",
        destination: "0x0000000000000000000000000000000000000001",
        railRef: "axelar-ref-1",
      },
    );
    await writeInbound(
      db,
      {
        chainKey: "stellar-testnet",
        block: 101n,
        txHash: "tx-101",
        logIndex: null,
        observedAt: new Date("2026-01-01T00:00:10Z"),
      },
      {
        route: 0,
        sourceChain: "sepolia",
        sourceNonce: 5n,
        railMessageId: null,
        recipient: "Grecipient",
        token: "USDC",
        amount: 500n,
        delivered: false,
        claimId: 7n,
      },
    );
    await writeClaim(
      db,
      {
        chainKey: "stellar-testnet",
        block: 101n,
        txHash: "tx-101",
        logIndex: null,
        observedAt: new Date("2026-01-01T00:00:10Z"),
      },
      {
        claimId: 7n,
        recipient: "Grecipient",
        token: "USDC",
        amount: 500n,
        route: 0,
        sourceChain: "sepolia",
        sourceNonce: 5n,
        createdAt: new Date("2026-01-01T00:00:09Z"),
      },
    );

    const first = await computeHistoryDigest(db, {
      chainKey: "stellar-testnet",
      startBlock: 90n,
      endBlock: 110n,
    });
    expect(first.rowCount).toBe(4);
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.monetarySummary.outboundCount).toBe(2);
    expect(first.monetarySummary.inboundCount).toBe(1);
    expect(first.monetarySummary.claimCount).toBe(1);
    expect(first.monetarySummary.tokens.USDC?.outboundGross).toBe(
      (BigInt(U256_LARGE) + 1000n).toString(),
    );

    // Simulate a fresh restore/backfill in reverse insertion order with different observed_at
    await pg.exec(
      "TRUNCATE pending_claim, inbound_delivery, outbound_transfer RESTART IDENTITY CASCADE",
    );
    await writeOutbound(
      db,
      {
        chainKey: "stellar-testnet",
        block: 99n,
        txHash: "tx-99",
        logIndex: null,
        observedAt: new Date("2026-06-01T12:00:00Z"),
      },
      {
        route: 1,
        nonce: 1n,
        sender: "Gsender1",
        token: "USDC",
        grossAmount: 1000n,
        fee: 10n,
        netAmount: 990n,
        destinationChain: "sepolia",
        destination: "0x0000000000000000000000000000000000000001",
        railRef: "axelar-ref-1",
      },
    );
    await writeOutbound(
      db,
      {
        chainKey: "stellar-testnet",
        block: 100n,
        txHash: "tx-100",
        logIndex: null,
        observedAt: new Date("2026-06-01T12:00:00Z"),
      },
      {
        route: 0,
        nonce: 2n,
        sender: "Gsender2",
        token: "USDC",
        grossAmount: BigInt(U256_LARGE),
        fee: 30n,
        netAmount: BigInt(U256_LARGE) - 30n,
        destinationChain: "sepolia",
        destination: "0x0000000000000000000000000000000000000002",
        railRef: null,
      },
    );
    await writeInbound(
      db,
      {
        chainKey: "stellar-testnet",
        block: 101n,
        txHash: "tx-101",
        logIndex: null,
        observedAt: new Date("2026-06-01T12:00:00Z"),
      },
      {
        route: 0,
        sourceChain: "sepolia",
        sourceNonce: 5n,
        railMessageId: null,
        recipient: "Grecipient",
        token: "USDC",
        amount: 500n,
        delivered: false,
        claimId: 7n,
      },
    );
    await writeClaim(
      db,
      {
        chainKey: "stellar-testnet",
        block: 101n,
        txHash: "tx-101",
        logIndex: null,
        observedAt: new Date("2026-06-01T12:00:00Z"),
      },
      {
        claimId: 7n,
        recipient: "Grecipient",
        token: "USDC",
        amount: 500n,
        route: 0,
        sourceChain: "sepolia",
        sourceNonce: 5n,
        createdAt: new Date("2026-01-01T00:00:09Z"),
      },
    );

    const restored = await computeHistoryDigest(db, {
      chainKey: "stellar-testnet",
      startBlock: 90n,
      endBlock: 110n,
    });
    expect(restored.digest).toBe(first.digest);
    expect(restored.monetarySummary).toEqual(first.monetarySummary);
  });

  it("persists digests and detects monetary or event drift on verification", async () => {
    await writeOutbound(
      db,
      {
        chainKey: "sepolia",
        block: 500n,
        txHash: "0xabc",
        logIndex: 3,
        observedAt: new Date("2026-01-01T00:00:00Z"),
      },
      {
        route: 0,
        nonce: 1n,
        sender: "0x1111111111111111111111111111111111111111",
        token: "0x2222222222222222222222222222222222222222",
        grossAmount: 2000n,
        fee: 100n,
        netAmount: 1900n,
        destinationChain: "stellar-testnet",
        destination: "Gdest",
        railRef: null,
      },
    );

    const computed = await computeHistoryDigest(db, {
      chainKey: "sepolia",
      startBlock: 500n,
      endBlock: 500n,
      recordKind: "outbound_transfer",
    });
    const stored = await recordHistoryDigest(db, computed);
    expect(stored.digest).toBe(computed.digest);

    const ok = await verifyHistoryDigest(db, {
      chainKey: "sepolia",
      startBlock: 500n,
      endBlock: 500n,
      recordKind: "outbound_transfer",
    });
    expect(ok.matches).toBe(true);

    // Mutate a monetary column and verify drift is detected
    await db.query(
      "UPDATE outbound_transfer SET fee = 200, net_amount = 1800 WHERE origin_chain = 'sepolia' AND nonce = 1",
    );
    const drifted = await verifyHistoryDigest(db, {
      chainKey: "sepolia",
      startBlock: 500n,
      endBlock: 500n,
      recordKind: "outbound_transfer",
    });
    expect(drifted.matches).toBe(false);
    expect(drifted.actualDigest).not.toBe(drifted.expectedDigest);
  });

  it("rejects inverted block ranges", async () => {
    await expect(
      computeHistoryDigest(db, {
        chainKey: "sepolia",
        startBlock: 10n,
        endBlock: 5n,
      }),
    ).rejects.toThrow(RangeError);
  });
});
