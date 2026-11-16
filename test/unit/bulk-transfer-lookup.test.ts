import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { writeOutbound } from "../../src/chains/writers.js";
import { loadConfig } from "../../src/config/config.js";
import type { Database, Queryable } from "../../src/db/pool.js";
import type { BulkTransferLookupResponse } from "../../src/http/bulk-lookup.js";
import { buildServer } from "../../src/http/server.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ACTIVE_TESTNET_DEPLOYMENTS = join(REPO_ROOT, "deployments", "testnet.json");

describe("Bounded bulk transfer lookup", () => {
  const { logger } = capturingLogger();
  const pg = new PGlite();

  let artificialDelayMs = 0;
  const recordedStatements: string[] = [];

  const db = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      recordedStatements.push(sql.trim());
      if (artificialDelayMs > 0) {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, artificialDelayMs);
          t.unref();
        });
      }
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
    transaction: async <T>(work: (tx: Queryable) => Promise<T>): Promise<T> => {
      await pg.exec("BEGIN");
      try {
        const out = await work({
          query: (sql, params) => db.query(sql, params),
        });
        await pg.exec("COMMIT");
        return out;
      } catch (error) {
        await pg.exec("ROLLBACK").catch(() => undefined);
        throw error;
      }
    },
    ping: async () => {
      await pg.query("SELECT 1");
    },
  };

  beforeAll(async () => {
    for (const name of [
      "1790900000000_initial-schema.sql",
      "1791000000000_cursor-block-hash.sql",
      "1791100000000_cursor-autovacuum-tuning.sql",
    ]) {
      const migrationPath = join(REPO_ROOT, "migrations", name);
      const sql = readFileSync(migrationPath, "utf8").split("-- Down Migration")[0] ?? "";
      await pg.exec(sql);
    }

    await writeOutbound(
      db,
      {
        chainKey: "stellar-testnet",
        block: 5434000n,
        txHash: "stellar-origin-tx-77",
        logIndex: null,
        observedAt: new Date("2026-11-05T10:00:00Z"),
      },
      {
        route: 0,
        nonce: 77n,
        sender: "GDXRQQETEZHGRJTE3U7DYGIWGGYGMM6EAS5NWGPGN2WXFXZYZ6QZIANA",
        token: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        grossAmount: 10000000n,
        fee: 30000n,
        netAmount: 9970000n,
        destinationChain: "sepolia",
        destination: "0x0000000000000000000000006ef8032ffe4943f27388172549f6700f18bb8b38",
        railRef: null,
      },
    );

    await pg.exec(`
      INSERT INTO indexer_cursor (chain_key, family, contract, last_processed, last_processed_hash)
      VALUES ('stellar-testnet', 'stellar', 'CCXPCT3YFLVANSF3AQMYCCZVGCMLTURAYQ6O6DYGQJMTKVYQL6NTOC2V', 5434100, NULL);
    `);
  }, 30_000);

  afterAll(async () => {
    await pg.close();
  });

  it("distinguishes found, missing, and unindexed EVM deployment items individually on active testnet config", async () => {
    const activeConfig = loadConfig({
      env: completeEnv({
        KEEPER_ENABLED: "false",
        HYPERION_DEPLOYMENTS_FILE: ACTIVE_TESTNET_DEPLOYMENTS,
      }),
    });

    const app = buildServer({
      config: activeConfig,
      logger,
      db: db as unknown as Database,
      readiness: [],
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/transfers/lookup",
      payload: {
        items: [
          { kind: "origin_nonce", originChain: "stellar-testnet", nonce: "77" },
          { kind: "origin_nonce", originChain: "stellar-testnet", nonce: "78" },
          { kind: "origin_nonce", originChain: "sepolia", nonce: "77" },
          { kind: "tx_hash", chain: "stellar-testnet", txHash: "stellar-origin-tx-77" },
          { kind: "tx_hash", chain: "sepolia", txHash: "0xunknown" },
          { kind: "id", id: "1" },
          { kind: "id", id: "9999" },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<BulkTransferLookupResponse>();
    expect(body.summary).toEqual({
      requested: 7,
      found: 3,
      missing: 2,
      unavailable: 2,
    });

    expect(body.items[0]).toMatchObject({
      index: 0,
      status: "found",
      transfer: {
        origin: {
          chain: "stellar-testnet",
          nonce: "77",
          grossAmount: "10000000",
          netAmount: "9970000",
        },
      },
    });
    expect(body.items[1]).toEqual({
      index: 1,
      key: { kind: "origin_nonce", originChain: "stellar-testnet", nonce: "78" },
      status: "missing",
    });
    // Active deployment has no Hyperion EVM router, so Sepolia nonce 77 neither collides with Stellar nor claims missing.
    expect(body.items[2]).toMatchObject({
      index: 2,
      key: { kind: "origin_nonce", originChain: "sepolia", nonce: "77" },
      status: "unavailable",
      reason: "unindexed_deployment",
    });
    expect(body.items[3]?.status).toBe("found");
    expect(body.items[4]).toMatchObject({
      index: 4,
      status: "unavailable",
      reason: "unindexed_deployment",
    });
    expect(body.items[5]?.status).toBe("found");
    expect(body.items[6]?.status).toBe("missing");

    // Verify read-only statement timeout was set inside the transaction.
    expect(recordedStatements).toContain("SET LOCAL transaction_read_only = on");
    expect(
      recordedStatements.some((stmt) => stmt.startsWith("SET LOCAL statement_timeout =")),
    ).toBe(true);

    await app.close();
  });

  it("prevents cross-chain nonce collisions when multiple deployments share the same nonce", async () => {
    const dualConfig = loadConfig({ env: completeEnv({ KEEPER_ENABLED: "false" }) });

    await writeOutbound(
      db,
      {
        chainKey: "sepolia",
        block: 9500000n,
        txHash: "0xsepolia77",
        logIndex: 2,
        observedAt: new Date("2026-11-05T10:05:00Z"),
      },
      {
        route: 0,
        nonce: 77n,
        sender: "0x6ef8032ffe4943f27388172549f6700f18bb8b38",
        token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
        grossAmount: 4200000n,
        fee: 12600n,
        netAmount: 4187400n,
        destinationChain: "stellar-testnet",
        destination: "GDXRQQETEZHGRJTE3U7DYGIWGGYGMM6EAS5NWGPGN2WXFXZYZ6QZIANA",
        railRef: null,
      },
    );

    await pg.exec(`
      INSERT INTO indexer_cursor (chain_key, family, contract, last_processed, last_processed_hash)
      VALUES ('sepolia', 'evm', '0x0165878A594ca255338adfa4d48449f69242Eb8F', 9500100, '0xhash');
    `);

    const app = buildServer({
      config: dualConfig,
      logger,
      db: db as unknown as Database,
      readiness: [
        {
          readiness: () => ({
            name: "chain:sepolia",
            state: "down" as const,
            detail: "rpc offline",
          }),
        },
      ],
    });

    // Bare nonce without originChain is rejected before SQL execution.
    const bareNonceRes = await app.inject({
      method: "POST",
      url: "/v1/transfers/lookup",
      payload: { items: [{ nonce: "77" }] },
    });
    expect(bareNonceRes.statusCode).toBe(400);

    // Distinct deployments with identical nonce 77 return their own chain-specific records,
    // while unfound nonces distinguish healthy Stellar ("missing") from down Sepolia ("unavailable").
    const mixedRes = await app.inject({
      method: "POST",
      url: "/v1/transfers/lookup",
      payload: {
        items: [
          { originChain: "stellar-testnet", nonce: "77" },
          { originChain: "sepolia", nonce: "77" },
          { originChain: "stellar-testnet", nonce: "888" },
          { originChain: "sepolia", nonce: "888" },
        ],
      },
    });

    expect(mixedRes.statusCode).toBe(200);
    const body = mixedRes.json<BulkTransferLookupResponse>();
    expect(body.items[0]).toMatchObject({
      status: "found",
      transfer: { origin: { chain: "stellar-testnet", nonce: "77", grossAmount: "10000000" } },
    });
    expect(body.items[1]).toMatchObject({
      status: "found",
      transfer: { origin: { chain: "sepolia", nonce: "77", grossAmount: "4200000" } },
    });
    expect(body.items[2]?.status).toBe("missing");
    expect(body.items[3]).toMatchObject({
      status: "unavailable",
      reason: "indexer_unavailable",
    });

    await app.close();
  });

  it("enforces batch size bounds and execution time budgets", async () => {
    const config = loadConfig({ env: completeEnv({ KEEPER_ENABLED: "false" }) });
    const app = buildServer({
      config,
      logger,
      db: db as unknown as Database,
      readiness: [],
      bulkLookupMaxItems: 5,
      bulkLookupTimeoutMs: 30,
    });

    const emptyRes = await app.inject({
      method: "POST",
      url: "/v1/transfers/lookup",
      payload: { items: [] },
    });
    expect(emptyRes.statusCode).toBe(400);

    const oversizedRes = await app.inject({
      method: "POST",
      url: "/v1/transfers/lookup",
      payload: {
        items: Array.from({ length: 6 }, (_, idx) => ({
          originChain: "stellar-testnet",
          nonce: String(idx + 1),
        })),
      },
    });
    expect(oversizedRes.statusCode).toBe(400);

    artificialDelayMs = 200;
    const timeoutRes = await app.inject({
      method: "POST",
      url: "/v1/transfers/lookup",
      payload: {
        items: [{ originChain: "stellar-testnet", nonce: "77" }],
      },
    });
    artificialDelayMs = 0;

    expect(timeoutRes.statusCode).toBe(504);
    expect(timeoutRes.headers["retry-after"]).toBe("1");
    expect(timeoutRes.json<{ error: string }>().error).toBe("request_timeout");

    await app.close();
  });
});
