import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/pool.js";
import { buildServer } from "../../src/http/server.js";
import { loadConfig } from "../../src/config/config.js";
import { recordWorkerHeartbeat, readWorkerHeartbeats } from "../../src/runtime/readiness.js";
import { completeEnv } from "../helpers.js";
import {
  captureResponse,
  differentialReport,
  validateResponse,
  type ResponseShape,
} from "../tooling/api-contract.js";
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
const config = loadConfig({
  env: completeEnv({ KEEPER_ENABLED: "false", RAILS_ENABLED: "false" }),
});
const CURSOR_WALLET = config.deployments.networks["stellar-testnet"]!.treasury;
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
    "1791300000000_stellar-durable-scan-evidence.sql",
    "1791400000000_stellar-cursor-cas-leases-gaps.sql",
    "1791500000000_stellar-revisions-and-quarantine.sql",
    "1791600000000_durable-rail-retry-schedules.sql",
    "1791700000000_rail-requeue-audit.sql",
    "1791800000000_outbound-router-identity.sql",
    "1791900000000_evm-log-quarantine.sql",
    "1792000000000_evm-backfill-jobs.sql",
    "1792100000000_route-health-compaction-and-audits.sql",
    "1792200000000_evm-scan-provenance.sql",
    "1792300000000_indexed-history-digests.sql",
    "1792400000000_indexer-worker-heartbeat.sql",
    "1792500000000_axelar-delivery-evidence.sql",
    "1792600000000_keeper-checkpoints.sql",
    "1792800000000_cctp-verification-failure-reasons.sql",
    "1792900000000_rail-transition-history.sql",
    "1793000000000_evm-quarantine-raw-replay.sql",
    "1793100000000_keeper-submission-outcomes.sql",
    "1793200000000_axelar-source-proof-binding.sql",
    "1793300000000_attestation-diagnostics.sql",
    "1793400000000_cctp-message-identity.sql",
    "1793500000000_ingestion-rejections.sql",
    "1793600000000_source-event-provenance.sql",
    "1793700000000_worker-run-correlation.sql",
    "1793800000000_cctp-fee-reconciliation.sql",
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
  it("supports revalidation for detail claims and updates their revision after settlement", async () => {
    const detailUrl = "/v1/claims/stellar-testnet/7";
    const pending = await app.inject(detailUrl);
    expect(pending.statusCode).toBe(200);
    expect(pending.headers["cache-control"]).toBe("private, no-cache, max-age=0, must-revalidate");
    const etag = pending.headers.etag;
    expect(etag).toBeDefined();

    const unchanged = await app.inject({
      method: "GET",
      url: detailUrl,
      headers: { "if-none-match": `W/${etag}` },
    });
    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.payload).toBe("");
    expect(unchanged.headers.etag).toBe(etag);

    await pg.query(
      `UPDATE pending_claim
          SET settled = true, settled_at = now(), settled_by = 'Gsettler', settled_tx = 'settlement-tx'
        WHERE chain = 'stellar-testnet' AND claim_id = 7`,
    );
    const settled = await app.inject({
      method: "GET",
      url: detailUrl,
      headers: { "if-none-match": etag },
    });
    expect(settled.statusCode).toBe(200);
    expect(settled.headers.etag).not.toBe(etag);
    expect(settled.json().settled).toBe(true);
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
  it("returns an opaque cursor and rejects a cursor used with different filters", async () => {
    const first = await app.inject("/v1/transfers?limit=1&originChain=stellar-testnet");
    expect(first.statusCode).toBe(200);
    expect(first.json().nextCursor).toEqual(expect.any(String));
    const next = await app.inject(
      `/v1/transfers?limit=1&originChain=stellar-testnet&cursor=${encodeURIComponent(first.json().nextCursor)}`,
    );
    expect(next.statusCode).toBe(200);
    const mismatched = await app.inject(
      `/v1/transfers?originChain=sepolia&cursor=${encodeURIComponent(first.json().nextCursor)}`,
    );
    expect(mismatched.statusCode).toBe(400);
    expect(mismatched.json().error).toBe("invalid_cursor");
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
    expect(v11Transfer.headers.etag).not.toBe(v1.headers.etag);
    const versionTransition = await app.inject({
      method: "GET",
      url: "/v1/transfers/by-tx/cctp-source",
      headers: { "x-api-schema-version": "1.1", "if-none-match": v1.headers.etag },
    });
    expect(versionTransition.statusCode).toBe(200);
    const normalizeFixture = (payload: unknown): unknown =>
      JSON.parse(JSON.stringify(payload).replace(/\d{4}-\d{2}-\d{2}T[^" ]+Z/g, "<timestamp>"));
    expect(normalizeFixture(v1.json())).toMatchSnapshot("legacy transfer response");
    expect(normalizeFixture(v11Transfer.json())).toMatchSnapshot("1.1 transfer response");

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

  it("degrades missing heartbeats and rejects stale writes even with a healthy database", async () => {
    await pg.exec("TRUNCATE indexer_worker_heartbeat");
    const missing = await app.inject("/ready");
    expect(missing.json().checks).toContainEqual(
      expect.objectContaining({ name: "indexer-heartbeat", state: "degraded" }),
    );
    const at = new Date();
    const input = {
      workerName: "stellar-testnet",
      workerKind: "chain" as const,
      chainKey: "stellar-testnet",
      state: "ready" as const,
      detail: "current",
      completed: true,
      lastCursorBlock: 123n,
      consecutiveFailures: 0,
      lastError: null,
      at,
    };
    await recordWorkerHeartbeat(db, input);
    await recordWorkerHeartbeat(db, {
      ...input,
      lastCursorBlock: 1n,
      detail: "old",
      at: new Date(at.getTime() - 300_000),
    });
    const [stored] = await readWorkerHeartbeats(db);
    expect(stored?.lastCursorBlock).toBe("123");
    expect(stored?.detail).toBe("current");
    const partial = await app.inject("/ready");
    expect(partial.json().checks).toContainEqual(
      expect.objectContaining({
        name: "indexer-heartbeat",
        detail: expect.stringContaining("sepolia"),
      }),
    );
    await pg.exec("TRUNCATE indexer_worker_heartbeat");
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
    const localReady = buildServer({
      config,
      logger,
      db: db as unknown as Database,
      redis: { ping: () => Promise.resolve("PONG") },
      readiness: [
        { readiness: () => ({ name: "sepolia", state: "ready", detail: "cached local ready" }) },
      ],
    });
    try {
      const combined = await localReady.inject("/ready");
      expect(combined.json().checks).toContainEqual(
        expect.objectContaining({
          name: "sepolia",
          state: "degraded",
          detail: expect.stringContaining("stale heartbeat"),
        }),
      );
    } finally {
      await localReady.close();
    }
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
      expect(r3.headers["retry-after"]).toBeDefined();
      expect(r3.json().retryAfterMs).toBe(Number(r3.headers["retry-after"]) * 1000);

      // /health remains exempt for load balancers
      const health = await untrustedApp.inject("/health");
      expect(health.statusCode).toBe(200);
      expect((await untrustedApp.inject("/health?probe=1")).statusCode).toBe(200);
      expect((await untrustedApp.inject("/ready?probe=1")).statusCode).toBe(200);

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

  it("revalidates equivalent transfer detail routes and invalidates on proof changes", async () => {
    const initial = await app.inject("/v1/transfers/by-tx/source-hash");
    expect(initial.statusCode).toBe(200);
    expect(initial.json().destination.delivered).toBe(false);
    expect(initial.headers["cache-control"]).toBe("private, no-cache, max-age=0, must-revalidate");
    expect(initial.headers["access-control-allow-headers"]).toContain("If-None-Match");
    expect(initial.headers["access-control-expose-headers"]).toContain("ETag");
    const transferId = initial.json().id as string;
    const etag = initial.headers.etag;
    expect(etag).toBeDefined();

    for (const url of [
      "/v1/transfers/stellar-testnet/42",
      "/v1/transfers/by-tx/source-hash",
      `/v1/transfers/${transferId}`,
      `/api/v1/transfers/${transferId}`,
    ]) {
      const unchanged = await app.inject({
        method: "GET",
        url,
        headers: { "if-none-match": etag },
      });
      expect(unchanged.statusCode).toBe(304);
      expect(unchanged.payload).toBe("");
      expect(unchanged.headers.etag).toBe(etag);
    }

    await pg.query(
      `INSERT INTO rail_attestation (transfer_id, route, status, rail_status, rail_reference, attested_at)
       VALUES ($1, 1, 'attested', 'complete', 'provider-proof', now())`,
      [transferId],
    );
    const providerStatusOnly = await app.inject({
      method: "GET",
      url: `/v1/transfers/${transferId}`,
      headers: { "if-none-match": etag },
    });
    expect(providerStatusOnly.statusCode).toBe(200);
    expect(providerStatusOnly.headers.etag).not.toBe(etag);
    expect(providerStatusOnly.json().destination.delivered).toBe(false);
    expect(providerStatusOnly.headers["cache-control"]).toBe(
      "private, no-cache, max-age=0, must-revalidate",
    );

    await pg.query(
      `UPDATE outbound_transfer SET origin_log_index = 3
        WHERE origin_chain = 'stellar-testnet' AND nonce = 42`,
    );
    const updatedProof = await app.inject({
      method: "GET",
      url: `/v1/transfers/${transferId}`,
      headers: { "if-none-match": providerStatusOnly.headers.etag },
    });
    expect(updatedProof.statusCode).toBe(200);
    expect(updatedProof.headers.etag).not.toBe(providerStatusOnly.headers.etag);
    expect(updatedProof.json().destination.delivered).toBe(false);
  });
});

describe("public response differential runner", () => {
  const shapes = JSON.parse(
    readFileSync(new URL("../../docs/api-response-contracts.json", import.meta.url), "utf8"),
  ) as Record<string, ResponseShape>;
  it("checks real transfer and claim handlers against the published contract and classifies metadata additions", async () => {
    for (const [kind, url] of [
      ["transfer", "/v1/transfers/stellar-testnet/42"],
      ["claim", "/v1/claims/stellar-testnet/7"],
    ] as const) {
      const shape = shapes[kind]!;
      const previous = await captureResponse(app, url, "1.0", shape);
      const current = await captureResponse(app, url, "1.1", shape);
      const report = differentialReport(previous, current);
      expect(report.breaking).toEqual([]);
      expect(report.additive).toEqual(["$.schemaVersion", "$.metadata"]);
      expect(current.statusCode).toBe(200);
    }
  });
  it("detects removed nested fields, number coercion, full-width integer drift and token identity drift", () => {
    const previous = {
      version: "old",
      statusCode: 200,
      body: {
        origin: {
          amount: "18446744073709551615",
          nonce: "18446744073709551615",
          token: "USDC",
          decimals: 7,
          sender: "Gsender",
        },
      },
    };
    const current = {
      version: "new",
      statusCode: 200,
      body: {
        origin: {
          amount: Number("18446744073709551615"),
          nonce: "18446744073709551614",
          token: "USDT",
          decimals: 6,
        },
      },
    };
    const report = differentialReport(previous, current);
    expect(report.breaking).toContain("$.origin.sender");
    expect(report.wideIntegerChanges).toEqual(["$.origin.amount", "$.origin.nonce"]);
    expect(report.tokenRepresentationChanges).toEqual(["$.origin.token", "$.origin.decimals"]);
    expect(
      validateResponse(current.body, {
        fields: { origin: { fields: { amount: "integer-string" } } },
      }),
    ).toEqual(["$.origin.amount: expected integer-string"]);
    expect(differentialReport(previous, { ...previous, statusCode: 500 }).breaking).toEqual([
      "$statusCode",
    ]);
  });
  it("walks each transfer once while new rows arrive and retains offset compatibility", async () => {
    const insert = async (nonce: number) =>
      pg.query(
        `INSERT INTO outbound_transfer(origin_chain,route,nonce,sender,token,gross_amount,fee,net_amount,destination_chain,destination,origin_block,origin_tx)
       VALUES ('stellar-testnet',1,$1,$3,'USDC',100,0,100,'sepolia','recipient',123,$2) RETURNING id`,
        [nonce, `cursor-source-${String(nonce)}`, CURSOR_WALLET],
      );
    const ids: string[] = [];
    for (let nonce = 9201; nonce <= 9205; nonce += 1) {
      const result = await insert(nonce);
      ids.unshift(String((result.rows[0] as { id: unknown }).id));
    }
    const first = await app.inject(`/v1/transfers?sender=${CURSOR_WALLET}&limit=2`);
    expect(first.statusCode).toBe(200);
    const seen = first.json().transfers.map((row: { id: string }) => row.id) as string[];
    expect(seen).toEqual(ids.slice(0, 2));
    await insert(9206);
    let cursor = first.json().nextCursor as string | null;
    while (cursor !== null) {
      const next = await app.inject(
        `/v1/transfers?sender=${CURSOR_WALLET}&limit=2&cursor=${encodeURIComponent(cursor)}`,
      );
      expect(next.statusCode).toBe(200);
      expect(next.json().offset).toBeUndefined();
      seen.push(...next.json().transfers.map((row: { id: string }) => row.id));
      cursor = next.json().nextCursor as string | null;
    }
    expect(seen).toEqual(ids);
    const offset = await app.inject(`/v1/transfers?sender=${CURSOR_WALLET}&limit=2&offset=1`);
    expect(offset.statusCode).toBe(200);
    expect(offset.json().offset).toBe(1);
    expect(offset.json().transfers.map((row: { id: string }) => row.id)).toEqual(ids.slice(0, 2));
    const mixed = await app.inject(
      `/v1/transfers?sender=${CURSOR_WALLET}&offset=1&cursor=${encodeURIComponent(first.json().nextCursor)}`,
    );
    expect(mixed.statusCode).toBe(400);
    await pg.query("DELETE FROM outbound_transfer WHERE sender=$1", [CURSOR_WALLET]);
  });
});
