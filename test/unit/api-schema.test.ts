import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/pool.js";
import { buildServer } from "../../src/http/server.js";
import { loadConfig } from "../../src/config/config.js";
import { recordWorkerHeartbeat } from "../../src/runtime/readiness.js";
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
    "1791400000000_stellar-cursor-cas-leases-gaps.sql",
    "1791700000000_indexer-worker-heartbeat.sql",
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
  it("reports the actual native-USDC payout after Circle fees in destination precision", async () => {
    const source = config.deployments.networks["stellar-testnet"];
    if (source?.family !== "stellar" || !source.tokens.USDC)
      throw new Error("Missing test deployment.");
    await pg.query(
      `INSERT INTO outbound_transfer (origin_chain,route,nonce,sender,token,gross_amount,fee,net_amount,destination_chain,destination,origin_block,origin_tx)
      VALUES ('stellar-testnet',0,43,'Gsender',$1,10000000,30000,9970000,'sepolia','0x0000000000000000000000006ef8032ffe4943f27388172549f6700f18bb8b38',124,'cctp-source')`,
      [source.tokens.USDC.sacId],
    );
    await pg.query(`INSERT INTO inbound_delivery(destination_chain,route,source_chain,source_nonce,recipient,token,amount,delivered,destination_block,destination_tx)
      VALUES ('sepolia',0,'stellar-testnet',43,'0x6ef8032ffe4943f27388172549f6700f18bb8b38','0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',897000,true,400,'cctp-mint')`);
    const response = await app.inject("/v1/transfers/by-tx/cctp-source");
    expect(response.statusCode).toBe(200);
    expect(response.json().destination.amount).toBe("897000");
    expect(response.json().destination.decimals).toBe(6);
    expect(response.json().destination.symbol).toBe("USDC");
    expect(response.json().origin.netAmount).toBe("9970000");
  });

  it("negotiates API schema versions without altering monetary or token fields (#105)", async () => {
    const v1 = await app.inject("/v1/transfers/by-tx/cctp-source");
    expect(v1.statusCode).toBe(200);
    expect(v1.headers["x-api-schema-version"]).toBe("1.0");
    expect(v1.headers.vary).toContain("X-API-Schema-Version");
    expect(v1.json().schemaVersion).toBeUndefined();

    const v11Transfer = await app.inject({
      method: "GET",
      url: "/v1/transfers/by-tx/cctp-source",
      headers: { "x-api-schema-version": "1.1" },
    });
    expect(v11Transfer.statusCode).toBe(200);
    expect(v11Transfer.headers["x-api-schema-version"]).toBe("1.1");
    expect(v11Transfer.json().schemaVersion).toBe("1.1");
    expect(v11Transfer.json().metadata).toEqual({
      source: "indexed_postgres",
      schemaVersion: "1.1",
    });
    expect(v11Transfer.json().origin.grossAmount).toBe("10000000");
    expect(v11Transfer.json().destination.amount).toBe("897000");
    expect(v11Transfer.json().destination.symbol).toBe("USDC");

    const v11Claim = await app.inject({
      method: "GET",
      url: "/v1/claims/stellar-testnet/7",
      headers: { "x-api-schema-version": "1.1" },
    });
    expect(v11Claim.statusCode).toBe(200);
    expect(v11Claim.json().schemaVersion).toBe("1.1");
    expect(v11Claim.json().amount).toBe("9970000");

    const v11Routes = await app.inject({
      method: "GET",
      url: "/v1/routes/health",
      headers: { "x-api-schema-version": "1.1" },
    });
    expect(v11Routes.statusCode).toBe(200);
    expect(v11Routes.json().schemaVersion).toBe("1.1");
    expect(v11Routes.json().routes[0].flowAvailable).toBe("90000000");

    const unsupported = await app.inject({
      method: "GET",
      url: "/v1/transfers/by-tx/cctp-source",
      headers: { "x-api-schema-version": "9.9" },
    });
    expect(unsupported.statusCode).toBe(400);
    expect(unsupported.json().error).toBe("unsupported_schema_version");
    expect(unsupported.json().supportedVersions).toEqual(["1.0", "1.1"]);
  });

  it("reports persistent worker heartbeats and stale diagnostics across processes (#107)", async () => {
    const now = new Date();
    const staleAt = new Date(now.getTime() - 300_000);

    await recordWorkerHeartbeat(db, {
      workerName: "stellar-testnet",
      workerKind: "chain",
      chainKey: "stellar-testnet",
      state: "ready",
      detail: "caught up to ledger 123",
      completed: true,
      lastCursorBlock: 123n,
      consecutiveFailures: 0,
      lastError: null,
      at: now,
    });
    await recordWorkerHeartbeat(db, {
      workerName: "sepolia",
      workerKind: "chain",
      chainKey: "sepolia",
      state: "ready",
      detail: "rpc error from https://user:secret-pass@rpc.example.com",
      completed: false,
      consecutiveFailures: 2,
      lastError: "fetch failed for https://user:secret-pass@rpc.example.com",
      at: staleAt,
    });

    const metricsRes = await app.inject("/v1/metrics");
    expect(metricsRes.statusCode).toBe(200);
    const metricsBody = metricsRes.json();
    expect(metricsBody.freshness).toEqual({
      totalWorkers: 2,
      staleWorkers: 1,
      degradedWorkers: 1,
      downWorkers: 0,
    });
    const sepolia = metricsBody.workers.find((w: { name: string }) => w.name === "sepolia");
    expect(sepolia.stale).toBe(true);
    expect(sepolia.state).toBe("degraded");
    expect(sepolia.lastError).not.toContain("secret-pass");
    expect(sepolia.detail).not.toContain("secret-pass");

    const readyRes = await app.inject("/ready");
    expect(readyRes.statusCode).toBe(200);
    expect(readyRes.json().status).toBe("degraded");
    const sepoliaCheck = readyRes.json().checks.find((c: { name: string }) => c.name === "sepolia");
    expect(sepoliaCheck.state).toBe("degraded");
    expect(sepoliaCheck.detail).toContain("stale heartbeat");
  });

  it("enforces bounded rate-limit budgets with explicit proxy handling (#106)", async () => {
    const untrustedApp = buildServer({
      config,
      logger,
      db: db as unknown as Database,
      readiness: [],
      redis: { ping: () => Promise.resolve("PONG") },
      trustProxy: false,
      rateLimit: {
        enabled: true,
        max: 2,
        streamMax: 1,
        timeWindowMs: 60_000,
      },
    });
    await untrustedApp.ready();

    try {
      // Spoofed X-Forwarded-For must not bypass budget when trustProxy is false
      const r1 = await untrustedApp.inject({
        method: "GET",
        url: "/v1/routes/health",
        headers: { "x-forwarded-for": "1.1.1.1" },
      });
      expect(r1.statusCode).toBe(200);
      expect(r1.headers["x-ratelimit-limit"]).toBe("2");

      const r2 = await untrustedApp.inject({
        method: "GET",
        url: "/v1/routes/health",
        headers: { "x-forwarded-for": "2.2.2.2" },
      });
      expect(r2.statusCode).toBe(200);

      const r3 = await untrustedApp.inject({
        method: "GET",
        url: "/v1/routes/health",
        headers: { "x-forwarded-for": "3.3.3.3" },
      });
      expect(r3.statusCode).toBe(429);
      expect(r3.json().error).toBe("too_many_requests");

      // /health remains exempt for load balancers
      const health = await untrustedApp.inject("/health");
      expect(health.statusCode).toBe(200);

      // SSE /stream enforces its own bounded budget rather than bypassing
      const s1 = await untrustedApp.inject("/v1/transfers/999999/stream");
      expect(s1.statusCode).toBe(404);
      const s2 = await untrustedApp.inject("/v1/transfers/999999/stream");
      expect(s2.statusCode).toBe(429);
    } finally {
      await untrustedApp.close();
    }

    // With trustProxy: true, distinct forwarded client IPs get separate budgets
    const trustedApp = buildServer({
      config,
      logger,
      db: db as unknown as Database,
      readiness: [],
      redis: { ping: () => Promise.resolve("PONG") },
      trustProxy: true,
      rateLimit: {
        enabled: true,
        max: 1,
        timeWindowMs: 60_000,
      },
    });
    await trustedApp.ready();

    try {
      const a1 = await trustedApp.inject({
        method: "GET",
        url: "/v1/routes/health",
        headers: { "x-forwarded-for": "10.0.0.1" },
      });
      expect(a1.statusCode).toBe(200);

      const b1 = await trustedApp.inject({
        method: "GET",
        url: "/v1/routes/health",
        headers: { "x-forwarded-for": "10.0.0.2" },
      });
      expect(b1.statusCode).toBe(200);

      const a2 = await trustedApp.inject({
        method: "GET",
        url: "/v1/routes/health",
        headers: { "x-forwarded-for": "10.0.0.1" },
      });
      expect(a2.statusCode).toBe(429);
    } finally {
      await trustedApp.close();
    }
  });
});
