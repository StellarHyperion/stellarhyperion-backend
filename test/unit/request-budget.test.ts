import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/config.js";
import { Database, QueryBudgetExceededError, type ReadQueryOptions } from "../../src/db/pool.js";
import { buildServer } from "../../src/http/server.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ACTIVE_TESTNET_DEPLOYMENTS = join(REPO_ROOT, "deployments", "testnet.json");

interface ControlledPoolHarness {
  readonly db: Database;
  readonly clientStatements: string[];
  readonly cancelledPids: number[];
  readonly releaseArgs: unknown[];
  setSlowSelectDelayMs: (ms: number) => void;
  waitForQueryStart: () => Promise<void>;
}

function createControlledPool(backendPid = 4242): ControlledPoolHarness {
  const clientStatements: string[] = [];
  const cancelledPids: number[] = [];
  const releaseArgs: unknown[] = [];

  let slowDelayMs = 0;
  let activeCancelReject: ((err: Error) => void) | null = null;
  let inAbortedTx = false;
  let inTx = false;
  let notifyQueryStart: (() => void) | null = null;

  const client = {
    processID: backendPid,
    query: async (sql: string) => {
      clientStatements.push(sql);

      if (sql === "BEGIN READ ONLY" || sql === "BEGIN") {
        if (inAbortedTx) {
          throw new Error("previous transaction was not rolled back");
        }
        inTx = true;
        return { rows: [], rowCount: 0 };
      }

      if (sql === "COMMIT") {
        if (inAbortedTx) {
          throw new Error("cannot commit aborted transaction");
        }
        inTx = false;
        return { rows: [], rowCount: 0 };
      }

      if (sql === "ROLLBACK") {
        inTx = false;
        inAbortedTx = false;
        return { rows: [], rowCount: 0 };
      }

      if (inAbortedTx) {
        const err = new Error(
          "current transaction is aborted, commands ignored until end of transaction block",
        ) as Error & { code: string };
        err.code = "25P02";
        throw err;
      }

      if (sql.startsWith("SET LOCAL statement_timeout")) {
        if (!inTx) {
          throw new Error("SET LOCAL issued outside transaction");
        }
        return { rows: [], rowCount: 0 };
      }

      const matchTimeout =
        clientStatements
          .slice()
          .reverse()
          .find((stmt) => stmt.startsWith("SET LOCAL statement_timeout")) ?? "";
      const timeoutMatch = /'([0-9]+)ms'/.exec(matchTimeout);
      const localTimeoutMs = timeoutMatch?.[1] !== undefined ? Number(timeoutMatch[1]) : 5_000;

      if (slowDelayMs > 0) {
        notifyQueryStart?.();
        await new Promise<void>((resolve, reject) => {
          const doneTimer = setTimeout(() => {
            activeCancelReject = null;
            resolve();
          }, slowDelayMs);
          doneTimer.unref();

          const stmtTimer = setTimeout(() => {
            clearTimeout(doneTimer);
            activeCancelReject = null;
            inAbortedTx = true;
            const pgErr = new Error("canceling statement due to statement timeout") as Error & {
              code: string;
            };
            pgErr.code = "57014";
            reject(pgErr);
          }, localTimeoutMs);
          stmtTimer.unref();

          activeCancelReject = (cancelErr: Error) => {
            clearTimeout(doneTimer);
            clearTimeout(stmtTimer);
            activeCancelReject = null;
            inAbortedTx = true;
            reject(cancelErr);
          };
        });
      }

      return { rows: [], rowCount: 0 };
    },
    release: (err?: unknown) => {
      releaseArgs.push(err);
    },
  };

  const fakePool = {
    connect: () => Promise.resolve(client),
    query: (sql: string, params?: unknown[]) => {
      if (sql.includes("pg_cancel_backend")) {
        const pid = Number(params?.[0]);
        cancelledPids.push(pid);
        if (activeCancelReject !== null) {
          const cancelErr = new Error("canceling statement due to user request") as Error & {
            code: string;
          };
          cancelErr.code = "57014";
          activeCancelReject(cancelErr);
        }
        return Promise.resolve({ rows: [{ pg_cancel_backend: true }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    end: () => Promise.resolve(),
  };

  return {
    db: Database.fromPool(fakePool as unknown as Pool),
    clientStatements,
    cancelledPids,
    releaseArgs,
    setSlowSelectDelayMs: (ms: number) => {
      slowDelayMs = ms;
    },
    waitForQueryStart: () =>
      new Promise<void>((resolve) => {
        notifyQueryStart = resolve;
      }),
  };
}

const pg = new PGlite();
let simulateSlowPgliteMs = 0;

const pgliteDb = {
  query: async (sql: string, params: readonly unknown[] = []) => {
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
  readQuery: async (
    sql: string,
    params: readonly unknown[] = [],
    options: ReadQueryOptions = {},
  ) => {
    const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? 5_000));
    await pg.exec("BEGIN READ ONLY");
    try {
      await pg.exec(`SET LOCAL statement_timeout = '${String(timeoutMs)}ms'`);
      if (simulateSlowPgliteMs > 0) {
        if (simulateSlowPgliteMs > timeoutMs) {
          await pg.exec("ROLLBACK");
          throw new QueryBudgetExceededError();
        }
      }
      const res = await pgliteDb.query(sql, params);
      await pg.exec("COMMIT");
      return res;
    } catch (error) {
      await pg.exec("ROLLBACK").catch(() => undefined);
      throw error;
    }
  },
  ping: async () => {
    await pg.query("SELECT 1");
  },
};

const { logger } = capturingLogger();
const config = loadConfig({
  env: completeEnv({
    KEEPER_ENABLED: "false",
    HYPERION_DEPLOYMENTS_FILE: ACTIVE_TESTNET_DEPLOYMENTS,
    HTTP_READ_TIMEOUT_MS: "2000",
  }),
});

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

  await pg.exec(`
    INSERT INTO outbound_transfer (
      origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
      destination_chain, destination, origin_block, origin_tx
    ) VALUES (
      'stellar-testnet',
      0,
      42,
      'GDXRQQETEZHGRJTE3U7DYGIWGGYGMM6EAS5NWGPGN2WXFXZYZ6QZIANA',
      'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      10000000,
      30000,
      9970000,
      'sepolia',
      '0x0000000000000000000000006ef8032ffe4943f27388172549f6700f18bb8b38',
      5433900,
      'd2d112fdef5b381534eb10e92806bd0025f307ffb0b2da0d0d3194d3f7892ca2'
    );

    INSERT INTO pending_claim (
      chain, claim_id, recipient, token, amount, route, source_chain, source_nonce, created_at
    ) VALUES (
      'stellar-testnet',
      7,
      'GDXRQQETEZHGRJTE3U7DYGIWGGYGMM6EAS5NWGPGN2WXFXZYZ6QZIANA',
      'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      9970000,
      0,
      'sepolia',
      20,
      now()
    );

    INSERT INTO route_health (
      origin_chain, destination_chain, route, token, available, blocker, flow_available
    ) VALUES (
      'stellar-testnet',
      'sepolia',
      0,
      'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      true,
      0,
      90000000
    );
  `);
}, 30_000);

afterAll(async () => {
  await pg.close();
});

describe("Request budgets and query cancellation on public reads", () => {
  it("cancels in-flight PostgreSQL queries via pg_cancel_backend when a client disconnects and leaves the connection usable", async () => {
    const harness = createControlledPool(7788);
    harness.setSlowSelectDelayMs(5_000);

    const server = buildServer({
      config,
      logger,
      db: harness.db,
      readiness: [],
      readBudgetMs: 2_000,
    });
    await server.listen({ host: "127.0.0.1", port: 0 });
    const address = server.server.address() as { port: number };

    const abortController = new AbortController();
    const queryStarted = harness.waitForQueryStart();

    const fetchPromise = fetch(`http://127.0.0.1:${String(address.port)}/v1/transfers`, {
      signal: abortController.signal,
    }).catch(() => null);

    await queryStarted;
    abortController.abort();
    await fetchPromise;
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(harness.cancelledPids).toEqual([7788]);
    expect(harness.clientStatements).toContain("ROLLBACK");
    expect(harness.releaseArgs).toEqual([undefined]);

    // Subsequent fast read on the exact same pooled connection succeeds cleanly.
    harness.setSlowSelectDelayMs(0);
    const followUp = await server.inject({ method: "GET", url: "/v1/transfers" });
    expect(followUp.statusCode).toBe(200);
    expect(followUp.json<{ transfers: unknown[] }>().transfers).toEqual([]);

    await server.close();
  });

  it("rolls back timed-out statements and leaves database transactions usable", async () => {
    const harness = createControlledPool(9900);
    harness.setSlowSelectDelayMs(1_000);

    const server = buildServer({
      config,
      logger,
      db: harness.db,
      readiness: [],
      readBudgetMs: 40,
    });

    const timedOut = await server.inject({ method: "GET", url: "/v1/transfers/1" });
    expect(timedOut.statusCode).toBe(504);
    expect(timedOut.headers["retry-after"]).toBe("1");
    expect(timedOut.json<{ error: string }>().error).toBe("request_timeout");
    expect(harness.clientStatements).toContain("ROLLBACK");
    expect(harness.releaseArgs).toEqual([undefined]);

    // Pooled connection is clean and ready for subsequent reads.
    harness.setSlowSelectDelayMs(0);
    const detailAfterTimeout = await server.inject({ method: "GET", url: "/v1/transfers/1" });
    expect(detailAfterTimeout.statusCode).toBe(404);

    await server.close();
  });

  it("applies request budgets consistently across all list and detail endpoints on real PGlite schema", async () => {
    const server = buildServer({
      config,
      logger,
      db: pgliteDb as unknown as Database,
      readiness: [],
      readBudgetMs: 2_000,
    });
    await server.ready();

    const endpoints = [
      "/v1/transfers",
      "/v1/transfers/stellar-testnet/42",
      "/v1/transfers/by-tx/d2d112fdef5b381534eb10e92806bd0025f307ffb0b2da0d0d3194d3f7892ca2",
      "/v1/transfers/1",
      "/api/v1/transfers/1",
      "/v1/claims",
      "/v1/claims/stellar-testnet/7",
      "/v1/routes/health",
    ];

    // Exceeding client-narrowed budget triggers 504 consistently on every list & detail endpoint.
    simulateSlowPgliteMs = 200;
    for (const url of endpoints) {
      const res = await server.inject({
        method: "GET",
        url,
        headers: { "x-request-timeout-ms": "25" },
      });
      expect(res.statusCode, `expected 504 timeout on ${url}`).toBe(504);
      expect(res.headers["x-request-budget-ms"]).toBe("25");
      expect(res.json<{ error: string }>().error).toBe("request_timeout");
    }

    // After all rolled-back timeouts, real PostgreSQL reads still succeed with exact integer amounts.
    simulateSlowPgliteMs = 0;
    const okDetail = await server.inject({
      method: "GET",
      url: "/v1/transfers/stellar-testnet/42",
      headers: { "x-request-timeout-ms": "99999" },
    });
    expect(okDetail.statusCode).toBe(200);
    // Clamped to server ceiling (2000ms), never widened by client header.
    expect(okDetail.headers["x-request-budget-ms"]).toBe("2000");
    expect(okDetail.json<{ origin: { netAmount: string } }>().origin.netAmount).toBe("9970000");

    // Malformed timeout header fails with 400.
    const badHeader = await server.inject({
      method: "GET",
      url: "/v1/claims",
      headers: { "x-request-timeout-ms": "0" },
    });
    expect(badHeader.statusCode).toBe(400);

    await server.close();
  });
});
