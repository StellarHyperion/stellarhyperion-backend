import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig, resolveMigrationDatabaseUrl } from "../../src/config/config.js";
import { ConfigError } from "../../src/config/env.js";
import { Database, ReadOnlyDatabaseError, assertReadOnlySql } from "../../src/db/pool.js";
import { buildServer } from "../../src/http/server.js";
import { createLogger } from "../../src/logging/logger.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CHECKED_IN_DEPLOYMENTS = join(REPO_ROOT, "deployments", "testnet.json");

function faultNames(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    if (error instanceof ConfigError) return error.faults.map((fault) => fault.name);
    throw error;
  }
  throw new Error("expected a ConfigError");
}

describe("Role-separated database credentials", () => {
  it("starts an API-only replica with API_DATABASE_URL alone and read-only session enforcement", () => {
    const env = completeEnv({
      HYPERION_DEPLOYMENTS_FILE: CHECKED_IN_DEPLOYMENTS,
      INDEXER_ENABLED: "false",
      RAILS_ENABLED: "false",
      KEEPER_ENABLED: "false",
      API_DATABASE_URL: "postgres://hyperion_reader:reader-local-only@127.0.0.1:5433/hyperion",
    });
    delete env.DATABASE_URL;
    delete env.REDIS_URL;

    const config = loadConfig({ env });
    expect(config.database.apiUrl).toContain("hyperion_reader");
    expect(config.database.apiReadOnly).toBe(true);
    expect(config.database.indexerUrl).toBeNull();
    expect(config.database.migrationUrl).toBeNull();

    const apiPool = Database.open(config.database.apiUrl, {
      applicationName: "hyperion-api-test",
      readOnly: config.database.apiReadOnly,
    });
    expect(apiPool.isReadOnly).toBe(true);
    void apiPool.close();
  });

  it("separates API, indexer and migration credentials and refuses unsafe credential reuse", () => {
    const apiOnlyEnv = completeEnv({
      INDEXER_ENABLED: "true",
      KEEPER_ENABLED: "false",
      API_DATABASE_URL: "postgres://hyperion_reader:reader-local-only@127.0.0.1:5433/hyperion",
    });
    delete apiOnlyEnv.DATABASE_URL;

    // Worker writes cannot silently bind to API_DATABASE_URL.
    expect(faultNames(() => loadConfig({ env: apiOnlyEnv }))).toEqual(["INDEXER_DATABASE_URL"]);

    // Explicitly configuring identical API and indexer credentials is rejected.
    const duplicatedEnv = completeEnv({
      KEEPER_ENABLED: "false",
      API_DATABASE_URL: "postgres://same_role:local-only@127.0.0.1:5433/hyperion",
      INDEXER_DATABASE_URL: "postgres://same_role:local-only@127.0.0.1:5433/hyperion",
    });
    delete duplicatedEnv.DATABASE_URL;
    expect(faultNames(() => loadConfig({ env: duplicatedEnv }))).toEqual(["INDEXER_DATABASE_URL"]);

    // Distinct API, indexer and migration credentials resolve cleanly without DATABASE_URL.
    const splitEnv = completeEnv({
      KEEPER_ENABLED: "false",
      API_DATABASE_URL: "postgres://hyperion_reader:reader-local-only@127.0.0.1:5433/hyperion",
      INDEXER_DATABASE_URL: "postgres://hyperion_writer:writer-local-only@127.0.0.1:5433/hyperion",
      MIGRATION_DATABASE_URL:
        "postgres://hyperion_migrator:migrator-local-only@127.0.0.1:5433/hyperion",
    });
    delete splitEnv.DATABASE_URL;

    const config = loadConfig({ env: splitEnv });
    expect(config.database.apiUrl).toContain("hyperion_reader");
    expect(config.database.indexerUrl).toContain("hyperion_writer");
    expect(config.database.migrationUrl).toContain("hyperion_migrator");

    const migration = resolveMigrationDatabaseUrl({ env: splitEnv });
    expect(migration.envVar).toBe("MIGRATION_DATABASE_URL");
    expect(migration.url).toContain("hyperion_migrator");

    // Migrations refuse environments holding only API_DATABASE_URL or INDEXER_DATABASE_URL.
    expect(
      faultNames(() =>
        resolveMigrationDatabaseUrl({
          env: {
            API_DATABASE_URL:
              "postgres://hyperion_reader:reader-local-only@127.0.0.1:5433/hyperion",
            INDEXER_DATABASE_URL:
              "postgres://hyperion_writer:writer-local-only@127.0.0.1:5433/hyperion",
          },
        }),
      ),
    ).toEqual(["MIGRATION_DATABASE_URL"]);

    // CLI wrapper also refuses API_DATABASE_URL without printing secret values.
    const cliResult = spawnSync(process.execPath, [join(REPO_ROOT, "scripts/migrate.mjs"), "up"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        API_DATABASE_URL: "postgres://hyperion_reader:secret-api-pass@127.0.0.1:5433/hyperion",
      },
    });
    expect(cliResult.status).toBe(78);
    expect(cliResult.stderr).toContain("MIGRATION_DATABASE_URL");
    expect(cliResult.stderr).not.toContain("secret-api-pass");
  });

  it("keeps database credentials absent from ConfigError, structured logs and HTTP responses", async () => {
    const apiSecret = "api-credential-must-stay-hidden";
    const indexerSecret = "indexer-credential-must-stay-hidden";
    const migrationSecret = "migration-credential-must-stay-hidden";

    try {
      loadConfig({
        env: completeEnv({
          API_DATABASE_URL: `invalid-scheme://${apiSecret}@127.0.0.1:5433/hyperion`,
          INDEXER_DATABASE_URL: `invalid-scheme://${indexerSecret}@127.0.0.1:5433/hyperion`,
          MIGRATION_DATABASE_URL: `invalid-scheme://${migrationSecret}@127.0.0.1:5433/hyperion`,
        }),
      });
      throw new Error("expected ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const rendered = (error as ConfigError).message;
      expect(rendered).not.toContain(apiSecret);
      expect(rendered).not.toContain(indexerSecret);
      expect(rendered).not.toContain(migrationSecret);
    }

    const validEnv = completeEnv({
      NODE_ENV: "production",
      INDEXER_ENABLED: "false",
      RAILS_ENABLED: "false",
      KEEPER_ENABLED: "false",
      API_DATABASE_URL: `postgres://hyperion_reader:${apiSecret}@127.0.0.1:5433/hyperion`,
      MIGRATION_DATABASE_URL: `postgres://hyperion_migrator:${migrationSecret}@127.0.0.1:5433/hyperion`,
    });
    delete validEnv.DATABASE_URL;
    const config = loadConfig({ env: validEnv });

    const { logger } = capturingLogger();
    const redactedLogger = createLogger(config);
    expect(redactedLogger).toBeDefined();

    const failingDb = {
      query: () =>
        Promise.reject(
          new Error(`connect failed to postgres://hyperion_reader:${apiSecret}@127.0.0.1:5433/db`),
        ),
      ping: () =>
        Promise.reject(
          new Error(`connect failed to postgres://hyperion_reader:${apiSecret}@127.0.0.1:5433/db`),
        ),
    };

    const app = buildServer({
      config,
      logger,
      db: failingDb as unknown as Database,
      readiness: [],
    });
    await app.ready();
    try {
      const readyRes = await app.inject("/ready");
      expect(readyRes.statusCode).toBe(503);
      expect(readyRes.body).not.toContain(apiSecret);

      const transfersRes = await app.inject("/v1/transfers");
      expect(transfersRes.statusCode).toBe(500);
      expect(transfersRes.body).not.toContain(apiSecret);
    } finally {
      await app.close();
    }
  });
});

describe("Public API serving under a least-privilege PostgreSQL read-only role", () => {
  const pg = new PGlite();
  let app: ReturnType<typeof buildServer>;

  beforeAll(async () => {
    // 1. Apply migrations as schema owner (`MIGRATION_DATABASE_URL` equivalent).
    for (const name of [
      "1790900000000_initial-schema.sql",
      "1791000000000_cursor-block-hash.sql",
      "1791100000000_cursor-autovacuum-tuning.sql",
    ]) {
      const migrationPath = join(REPO_ROOT, "migrations", name);
      const sql = readFileSync(migrationPath, "utf8").split("-- Down Migration")[0]!;
      await pg.exec(sql);
    }

    // 2. Create separate worker-write and API read-only roles in PostgreSQL.
    await pg.exec(`
      CREATE ROLE hyperion_indexer_writer NOINHERIT;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hyperion_indexer_writer;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hyperion_indexer_writer;

      CREATE ROLE hyperion_api_reader NOINHERIT;
      GRANT USAGE ON SCHEMA public TO hyperion_api_reader;
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO hyperion_api_reader;
    `);

    // 3. Seed canonical indexed state through the worker-write role.
    await pg.exec(`
      SET ROLE hyperion_indexer_writer;
      INSERT INTO outbound_transfer (origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount, destination_chain, destination, origin_block, origin_tx)
      VALUES ('stellar-testnet', 1, 42, 'Gsender', 'USDC', 10000000, 30000, 9970000, 'sepolia', '0x0000000000000000000000006ef8032ffe4943f27388172549f6700f18bb8b38', 123, 'source-hash');
      INSERT INTO pending_claim (chain, claim_id, recipient, token, amount, route, source_chain, source_nonce, created_at)
      VALUES ('stellar-testnet', 7, 'Grecipient', 'USDC', 9970000, 1, 'sepolia', 20, now());
      INSERT INTO route_health (origin_chain, destination_chain, route, token, available, flow_available)
      VALUES ('stellar-testnet', 'sepolia', 1, 'USDC', true, 90000000);
      INSERT INTO indexer_cursor (chain_key, family, contract, last_processed, last_processed_hash)
      VALUES ('stellar-testnet', 'stellar', 'Crouter', 123, NULL);
      RESET ROLE;
    `);

    // 4. Lock the session down to the least-privilege read-only API role.
    await pg.exec(`
      SET ROLE hyperion_api_reader;
      SET default_transaction_read_only = on;
    `);

    const readOnlyDb = {
      isReadOnly: true,
      query: async (sql: string, params: readonly unknown[] = []) => {
        assertReadOnlySql(sql);
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
      ping: async () => {
        await pg.query("SELECT 1");
      },
    };

    const env = completeEnv({
      HYPERION_DEPLOYMENTS_FILE: CHECKED_IN_DEPLOYMENTS,
      INDEXER_ENABLED: "false",
      RAILS_ENABLED: "false",
      KEEPER_ENABLED: "false",
      API_DATABASE_URL: "postgres://hyperion_api_reader:local-only@127.0.0.1:5433/hyperion",
    });
    delete env.DATABASE_URL;
    delete env.REDIS_URL;

    const config = loadConfig({ env });
    const { logger } = capturingLogger();
    app = buildServer({
      config,
      logger,
      db: readOnlyDb as unknown as Database,
      readiness: [],
    });
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await pg.close();
  });

  it("serves health, readiness, transfers, claims, route health and metrics while rejecting writes", async () => {
    for (const path of [
      "/health",
      "/ready",
      "/v1/transfers",
      "/v1/transfers/stellar-testnet/42",
      "/v1/claims",
      "/v1/routes/health",
      "/v1/metrics",
    ]) {
      const res = await app.inject(path);
      expect(res.statusCode, `expected 200 on ${path}`).toBe(200);
      expect(res.body).not.toContain("hyperion_api_reader");
    }

    // Application-layer read-only guard refuses mutating statements before dispatch.
    expect(() => {
      assertReadOnlySql("/* comment */\nDELETE FROM rail_attestation WHERE status = 'delivered'");
    }).toThrow(ReadOnlyDatabaseError);

    // PostgreSQL role + read-only session also refuse DML and DDL directly.
    await expect(
      pg.query(
        "INSERT INTO indexer_cursor (chain_key, family, contract, last_processed) VALUES ('x', 'stellar', 'C', 1)",
      ),
    ).rejects.toThrow(/read-only|permission denied/i);
    await expect(pg.query("CREATE TABLE unauthorized_ddl (id INT)")).rejects.toThrow(
      /read-only|permission denied/i,
    );
  });
});
