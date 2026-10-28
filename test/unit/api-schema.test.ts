import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/pool.js";
import { buildServer } from "../../src/http/server.js";
import { loadConfig } from "../../src/config/config.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

// Execute the repository SQL in a real embedded PostgreSQL engine, without query-string mocks.
const pg = new PGlite();
const db = {
  query: async (sql: string, params: readonly unknown[] = []) => {
    const result = await pg.query(sql, [...params]);
    const int8 = result.fields
      .filter((field) => field.dataTypeID === 20)
      .map((field) => field.name);
    const rows = result.rows.map((raw) => {
      const row = { ...(raw as Record<string, unknown>) };
      for (const column of int8) {
        const value = row[column];
        if (typeof value === "number" || typeof value === "bigint") row[column] = String(value);
      }
      return row;
    });
    return { rows, rowCount: result.affectedRows ?? result.rows.length };
  },
  ping: async () => {
    await pg.query("SELECT 1");
  },
};
const { logger } = capturingLogger();
const config = loadConfig({ env: completeEnv({ KEEPER_ENABLED: "false" }) });
const app = buildServer({
  config,
  logger,
  db: db as unknown as Database,
  readiness: [],
  redis: { ping: () => Promise.resolve("PONG") },
});
beforeAll(async () => {
  for (const name of [
    "1790900000000_initial-schema.sql",
    "1791000000000_cursor-block-hash.sql",
    "1791100000000_cursor-autovacuum-tuning.sql",
  ]) {
    const sql = readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8").split(
      "-- Down Migration",
    )[0]!;
    await pg.exec(sql);
  }
  await pg.exec(`
    INSERT INTO outbound_transfer (origin_chain,route,nonce,sender,token,gross_amount,fee,net_amount,destination_chain,destination,origin_block,origin_tx)
    VALUES ('stellar-testnet',1,42,'Gsender','USDC',10000000,30000,9970000,'sepolia','0x0000000000000000000000006ef8032ffe4943f27388172549f6700f18bb8b38',123,'source-hash');
    INSERT INTO pending_claim (chain,claim_id,recipient,token,amount,route,source_chain,source_nonce,created_at)
    VALUES ('stellar-testnet',7,'Grecipient','USDC',9970000,1,'sepolia',20,now());
    INSERT INTO route_health (origin_chain,destination_chain,route,token,available,flow_available)
    VALUES ('stellar-testnet','sepolia',1,'USDC',true,90000000);
    INSERT INTO indexer_cursor (chain_key,family,contract,last_processed,last_processed_hash)
    VALUES ('stellar-testnet','stellar','Crouter',123,NULL);
  `);
  await app.ready();
}, 30_000);
afterAll(async () => {
  await app.close();
  await pg.close();
});
describe("HTTP queries against the migrated PostgreSQL schema", () => {
  it("reads composite-key claims without inventing an id column", async () => {
    const response = await app.inject("/v1/claims/stellar-testnet/7");
    expect(response.statusCode).toBe(200);
    expect(response.json().id).toBe("stellar-testnet:7");
    expect(response.json().amount).toBe("9970000");
    const list = await app.inject("/v1/claims?chain=stellar-testnet");
    expect(list.statusCode).toBe(200);
    expect(list.json().claims).toHaveLength(1);
  });
  it("reads sampled route health using the migration's timestamp", async () => {
    const response = await app.inject("/v1/routes/health");
    expect(response.statusCode).toBe(200);
    expect(response.json().routes[0].flowAvailable).toBe("90000000");
    expect(response.json().routes[0].observedAt).toMatch(/^\d{4}-/);
  });
  it("reads actual cursor position/hash column names in metrics", async () => {
    const response = await app.inject("/v1/metrics");
    expect(response.statusCode).toBe(200);
    expect(response.json().cursors[0].block).toBe("123");
    expect(response.json().cursors[0].hash).toBeNull();
  });

  it("renders EVM recipient words as actual addresses for wallet and explorer links", async () => {
    const response = await app.inject("/v1/transfers/by-tx/source-hash");
    expect(response.statusCode).toBe(200);
    expect(response.json().destination.recipient).toBe(
      "0x6ef8032ffe4943f27388172549f6700f18bb8b38",
    );
  });
  it("searches real transfer rows with parameterized SQL", async () => {
    const found = await app.inject("/v1/transfers?search=source-hash");
    expect(found.statusCode).toBe(200);
    expect(found.json().transfers).toHaveLength(1);
    const missing = await app.inject("/v1/transfers?search=no-such-transfer");
    expect(missing.statusCode).toBe(200);
    expect(missing.json().transfers).toHaveLength(0);
    const quoted = await app.inject("/v1/transfers?search=%27%20OR%201%3D1%20--");
    expect(quoted.statusCode).toBe(200);
    expect(quoted.json().transfers).toHaveLength(0);
  });
});
