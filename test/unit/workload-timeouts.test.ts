import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeOutbound } from "../../src/chains/writers.js";
import { loadConfig } from "../../src/config/config.js";
import {
  DEFAULT_WORKLOAD_TIMEOUTS,
  Database,
  DatabaseTimeoutError,
  normalizeWorkloadError,
  sanitizeDatabaseErrorMessage,
} from "../../src/db/pool.js";
import type { PoolBackendLike, PoolClientLike } from "../../src/db/pool.js";
import { buildServer } from "../../src/http/server.js";
import pino from "pino";
import { completeEnv } from "../helpers.js";

const STELLAR_SENDER = "GC4FD5G3CZJ57VPYTVNWU4FRDLLV37EYDGT3OVZA35WKHBWDI6PKTYTN";
const STELLAR_USDC = "CD5IB466XCQIUDYWV22PUMJTF6EE3KPXBDGLLBSKAPNE6QPXVUZLXJGA";
const BASE_DEST_WORD = `0x000000000000000000000000${"44".repeat(20)}`;

class PglitePoolBackend implements PoolBackendLike {
  readonly statements: string[] = [];
  injectedFailure: ((sql: string) => Error | null) | null = null;

  constructor(private readonly pg: PGlite) {}

  async query(
    text: string,
    values: unknown[] = [],
  ): Promise<{ rows: unknown[]; rowCount: number | null }> {
    this.statements.push(text.trim());
    if (this.injectedFailure) {
      const err = this.injectedFailure(text);
      if (err) throw err;
    }
    const res = await this.pg.query(text, values);
    return {
      rows: res.rows,
      rowCount: res.affectedRows ?? res.rows.length,
    };
  }

  connect(): Promise<PoolClientLike> {
    const client: PoolClientLike = {
      query: async (text: string, values: unknown[] = []) => {
        if (text.includes("SET LOCAL") && text.includes(";")) {
          this.statements.push(text.trim());
          await this.pg.exec(text);
          return { rows: [], rowCount: 0 };
        }
        return this.query(text, values);
      },
      release: () => undefined,
    };
    return Promise.resolve(client);
  }

  end(): Promise<void> {
    return Promise.resolve();
  }
}

async function applyMigrations(pg: PGlite): Promise<void> {
  for (const name of [
    "1790900000000_initial-schema.sql",
    "1791000000000_cursor-block-hash.sql",
    "1791100000000_cursor-autovacuum-tuning.sql",
  ]) {
    const fullSql = readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8");
    const upSql = fullSql.split("-- Down Migration")[0] ?? fullSql;
    await pg.exec(upSql);
  }
}

describe("statement and lock timeouts per workload (#57)", () => {
  let pg: PGlite;
  let backend: PglitePoolBackend;
  let db: Database;

  beforeEach(async () => {
    pg = new PGlite();
    await applyMigrations(pg);
    backend = new PglitePoolBackend(pg);
    db = Database.fromBackend(backend);
  });

  afterEach(async () => {
    await db.close();
    await pg.close();
  });

  it("enforces short read-only lock and statement timeouts on public API queries without bleeding into ingestion or maintenance", async () => {
    // 1. Public API workload enforces tight lock_timeout (1s), statement_timeout (5s), and transaction_read_only = on
    const apiGucs = await db.transactionForWorkload("api", async (tx) => {
      const st = await tx.query("SHOW statement_timeout");
      const lt = await tx.query("SHOW lock_timeout");
      const idle = await tx.query("SHOW idle_in_transaction_session_timeout");
      const ro = await tx.query("SHOW transaction_read_only");
      return {
        statementTimeout: String(st.rows[0]?.statement_timeout),
        lockTimeout: String(lt.rows[0]?.lock_timeout),
        idleTimeout: String(idle.rows[0]?.idle_in_transaction_session_timeout),
        readOnly: String(ro.rows[0]?.transaction_read_only),
      };
    });

    expect(apiGucs).toEqual({
      statementTimeout: "5s",
      lockTimeout: "1s",
      idleTimeout: "5s",
      readOnly: "on",
    });

    // Public API workload cannot acquire write/exclusive table locks or mutate tables
    const apiDb = db.forWorkload("api");
    await expect(
      apiDb.query("LOCK TABLE outbound_transfer IN ACCESS EXCLUSIVE MODE"),
    ).rejects.toThrow();
    await expect(apiDb.query("DELETE FROM rail_attestation")).rejects.toThrow();

    // 2. Subsequent ingestion transaction on the same pooled connection retains full 30s statement_timeout
    //    and write access for atomic page + cursor commits (zero session bleed from `api`!).
    const ingestionDb = db.forWorkload("ingestion");
    const ingestionGucs = await ingestionDb.transaction(async (tx) => {
      const st = await tx.query("SHOW statement_timeout");
      const lt = await tx.query("SHOW lock_timeout");
      const ro = await tx.query("SHOW transaction_read_only");

      await writeOutbound(
        tx,
        {
          chainKey: "stellar-testnet",
          block: 700_001n,
          txHash: "ab".repeat(32),
          logIndex: null,
          observedAt: new Date("2026-10-25T10:00:00Z"),
        },
        {
          route: 0,
          nonce: 1n,
          sender: STELLAR_SENDER,
          token: STELLAR_USDC,
          grossAmount: 5_000_000n,
          fee: 50_000n,
          netAmount: 4_950_000n,
          destinationChain: "base-sepolia",
          destination: BASE_DEST_WORD,
          railRef: null,
        },
      );
      await tx.query(
        `INSERT INTO indexer_cursor (chain_key, family, contract, last_processed)
         VALUES ('stellar-testnet', 'stellar', $1, 700001)`,
        [STELLAR_USDC],
      );

      return {
        statementTimeout: String(st.rows[0]?.statement_timeout),
        lockTimeout: String(lt.rows[0]?.lock_timeout),
        readOnly: String(ro.rows[0]?.transaction_read_only),
      };
    });

    expect(ingestionGucs).toEqual({
      statementTimeout: "30s",
      lockTimeout: "5s",
      readOnly: "off",
    });

    // 3. Maintenance workload uses its own 60s statement / 2s lock timeout policy
    const maintenanceGucs = await db.transactionForWorkload("maintenance", async (tx) => {
      const st = await tx.query("SHOW statement_timeout");
      const lt = await tx.query("SHOW lock_timeout");
      return {
        statementTimeout: String(st.rows[0]?.statement_timeout),
        lockTimeout: String(lt.rows[0]?.lock_timeout),
      };
    });
    expect(maintenanceGucs).toEqual({
      statementTimeout: "1min",
      lockTimeout: "2s",
    });

    const deleted = await db.pruneCompletedAttestations(30);
    expect(deleted).toBe(0);
  });

  it("normalizes statement, lock, idle-in-tx, and connection timeouts while scrubbing credentials across DB and HTTP layers", async () => {
    const secretPw = ["pg", "secret", "pw", "445566"].join("_");
    const urlLeak = `postgresql://indexer:${secretPw}@db.hyperion.internal:5432/hyperion`;
    const kvLeak = `host=db.hyperion.internal user=indexer password='${secretPw}' PGPASSWORD=${secretPw}`;

    // SQLSTATE 55P03 -> lock_timeout
    const rawLockErr = Object.assign(
      new Error(`canceling statement due to lock timeout (${urlLeak})`),
      { code: "55P03" },
    );
    const normLock = normalizeWorkloadError(
      rawLockErr,
      "api",
      DEFAULT_WORKLOAD_TIMEOUTS.api,
      10_000,
    );
    expect(normLock).toBeInstanceOf(DatabaseTimeoutError);
    expect((normLock as DatabaseTimeoutError).kind).toBe("lock_timeout");
    expect((normLock as DatabaseTimeoutError).code).toBe("database_lock_timeout");
    expect((normLock as DatabaseTimeoutError).timeoutMs).toBe(1_000);
    expect(normLock.message).not.toContain(secretPw);
    expect(normLock.message).toContain("postgresql://indexer:[REDACTED]@db.hyperion.internal");

    // SQLSTATE 57014 -> statement_timeout
    const rawStmtErr = Object.assign(
      new Error(`canceling statement due to statement timeout; ${kvLeak}`),
      { code: "57014" },
    );
    const normStmt = normalizeWorkloadError(
      rawStmtErr,
      "ingestion",
      DEFAULT_WORKLOAD_TIMEOUTS.ingestion,
      10_000,
    );
    expect(normStmt).toBeInstanceOf(DatabaseTimeoutError);
    expect((normStmt as DatabaseTimeoutError).kind).toBe("statement_timeout");
    expect((normStmt as DatabaseTimeoutError).code).toBe("database_statement_timeout");
    expect((normStmt as DatabaseTimeoutError).timeoutMs).toBe(30_000);
    expect(normStmt.message).not.toContain(secretPw);

    // SQLSTATE 25P03 -> idle_in_transaction_timeout
    const rawIdleErr = Object.assign(
      new Error(`terminating connection due to idle-in-transaction timeout (${urlLeak})`),
      { code: "25P03" },
    );
    const normIdle = normalizeWorkloadError(
      rawIdleErr,
      "maintenance",
      DEFAULT_WORKLOAD_TIMEOUTS.maintenance,
      10_000,
    );
    expect(normIdle).toBeInstanceOf(DatabaseTimeoutError);
    expect((normIdle as DatabaseTimeoutError).kind).toBe("idle_in_transaction_timeout");
    expect(normIdle.message).not.toContain(secretPw);

    // Sanitizes direct strings too
    expect(sanitizeDatabaseErrorMessage(`${urlLeak} ${kvLeak}`)).not.toContain(secretPw);

    // End-to-end Fastify HTTP verification: simulated 55P03 lock timeout on `/v1/transfers`
    // returns normalized 503 JSON and logs zero credentials!
    const config = loadConfig({ env: completeEnv({ KEEPER_ENABLED: "false" }) });
    const rawLogLines: string[] = [];
    const logger = pino(
      { level: "trace" },
      {
        write(line: string) {
          rawLogLines.push(line);
        },
      },
    );
    const app = buildServer({
      config,
      logger,
      db,
      readiness: [],
    });

    try {
      backend.injectedFailure = (sql) => {
        if (sql.includes("FROM outbound_transfer")) {
          return Object.assign(new Error(`canceling statement due to lock timeout on ${urlLeak}`), {
            code: "55P03",
          });
        }
        return null;
      };

      const res = await app.inject({ method: "GET", url: "/v1/transfers" });
      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body).toMatchObject({
        error: "database_lock_timeout",
        retryable: true,
        message: "the database request timed out before completing",
      });
      expect(JSON.stringify(body)).not.toContain(secretPw);
      expect(rawLogLines.join("\n")).not.toContain(secretPw);
    } finally {
      backend.injectedFailure = null;
      await app.close();
    }
  });

  it("validates custom workload timeout overrides", () => {
    expect(() =>
      Database.fromBackend(backend, {
        workloadTimeouts: {
          api: {
            statementTimeoutMs: 1_000,
            lockTimeoutMs: 2_000,
          },
        },
      }),
    ).toThrow(/api\.lockTimeoutMs cannot exceed api\.statementTimeoutMs/);

    const customDb = Database.fromBackend(backend, {
      workloadTimeouts: {
        api: { statementTimeoutMs: 3_000, lockTimeoutMs: 500 },
        ingestion: { statementTimeoutMs: 45_000, lockTimeoutMs: 8_000 },
      },
    });
    expect(customDb.timeoutPolicyFor("api").lockTimeoutMs).toBe(500);
    expect(customDb.timeoutPolicyFor("ingestion").statementTimeoutMs).toBe(45_000);
  });
});
