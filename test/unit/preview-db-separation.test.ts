import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { Keypair } from "@stellar/stellar-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createServerlessApp } from "../../api/index.js";
import { loadConfig } from "../../src/config/config.js";
import { ConfigError } from "../../src/config/env.js";
import type { Database, Queryable, QueryResultRows } from "../../src/db/pool.js";
import { ReadOnlyViolationError, assertReadOnlySql } from "../../src/db/pool.js";
import { completeEnv, TESTNET_DEPLOYMENTS } from "../helpers.js";

function faultNames(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    if (error instanceof ConfigError) return error.faults.map((fault) => fault.name);
    throw error;
  }
  throw new Error("expected a ConfigError and got none");
}

function migrationPath(name: string): string {
  return fileURLToPath(new URL(`../../migrations/${name}`, import.meta.url));
}

describe("preview versus production database separation", () => {
  const pg = new PGlite();

  function createReadOnlyPgliteAdapter(): Database {
    const query = async (sql: string, params?: readonly unknown[]): Promise<QueryResultRows> => {
      assertReadOnlySql(sql);
      const result = await pg.query(sql, [...(params ?? [])]);
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
    };

    const adapter = {
      isReadOnly: true,
      query,
      ping: async () => {
        await query("SELECT 1");
      },
      transaction: async <T>(work: (tx: Queryable) => Promise<T>): Promise<T> => {
        await pg.exec("BEGIN READ ONLY");
        try {
          const value = await work({ query });
          await pg.exec("COMMIT");
          return value;
        } catch (error) {
          await pg.exec("ROLLBACK").catch(() => undefined);
          throw error;
        }
      },
      pruneCompletedAttestations: () =>
        Promise.reject(
          new ReadOnlyViolationError("attestation pruning requires a readwrite database role"),
        ),
      close: () => Promise.resolve(),
    };

    return adapter as unknown as Database;
  }

  beforeAll(async () => {
    for (const name of [
      "1790900000000_initial-schema.sql",
      "1791000000000_cursor-block-hash.sql",
      "1791100000000_cursor-autovacuum-tuning.sql",
    ]) {
      const sql = readFileSync(migrationPath(name), "utf8").split("-- Down Migration")[0]!;
      await pg.exec(sql);
    }

    await pg.exec(`
      INSERT INTO outbound_transfer (
        origin_chain, route, nonce, sender, token,
        gross_amount, fee, net_amount, destination_chain, destination,
        origin_block, origin_tx
      ) VALUES (
        'stellar-testnet', 1, 108, 'Gsender', 'USDC',
        25000000, 75000, 24925000, 'sepolia',
        '0x0000000000000000000000006ef8032ffe4943f27388172549f6700f18bb8b38',
        5433900, 'preview-source-hash'
      );
    `);
  }, 30_000);

  afterAll(async () => {
    await pg.close();
  });

  it("refuses preview deployments that omit DATABASE_ENV=preview or inherit production write identity", () => {
    const prodWriteSecret = "prod-super-secret-pw-9988";
    const prodUrl = `postgres://hyperion_writer:${prodWriteSecret}@db.prod.internal:5432/hyperion_prod`;

    expect(
      faultNames(() =>
        loadConfig({
          env: completeEnv({
            VERCEL_ENV: "preview",
            INDEXER_ENABLED: "false",
            RAILS_ENABLED: "false",
            KEEPER_ENABLED: "false",
            DATABASE_ROLE: "readonly",
          }),
        }),
      ),
    ).toEqual(["DATABASE_ENV"]);

    expect(
      faultNames(() =>
        loadConfig({
          env: completeEnv({
            VERCEL_ENV: "preview",
            DATABASE_ENV: "production",
            INDEXER_ENABLED: "false",
            RAILS_ENABLED: "false",
            KEEPER_ENABLED: "false",
            DATABASE_ROLE: "readonly",
          }),
        }),
      ),
    ).toEqual(["DATABASE_ENV"]);

    // Same production database target must fail without leaking credentials.
    try {
      loadConfig({
        env: completeEnv({
          VERCEL_ENV: "preview",
          DATABASE_ENV: "preview",
          DATABASE_ROLE: "readonly",
          INDEXER_ENABLED: "false",
          RAILS_ENABLED: "false",
          KEEPER_ENABLED: "false",
          DATABASE_URL: `postgresql://preview_reader:${prodWriteSecret}@db.prod.internal:5432/hyperion_prod`,
          PRODUCTION_DATABASE_URL: prodUrl,
        }),
      });
      throw new Error("expected ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const msg = (error as ConfigError).message;
      expect(msg).toContain("DATABASE_URL");
      expect(msg).not.toContain(prodWriteSecret);
      expect(msg).not.toContain("db.prod.internal");
    }

    // Separate database name on the same cluster reusing the production write role identity must also fail.
    expect(
      faultNames(() =>
        loadConfig({
          env: completeEnv({
            DEPLOYMENT_ENV: "preview",
            DATABASE_ENV: "preview",
            DATABASE_ROLE: "readonly",
            INDEXER_ENABLED: "false",
            RAILS_ENABLED: "false",
            KEEPER_ENABLED: "false",
            DATABASE_URL: `postgres://hyperion_writer:${prodWriteSecret}@db.prod.internal:5432/hyperion_preview`,
            PRODUCTION_DATABASE_URL: prodUrl,
          }),
        }),
      ),
    ).toEqual(["DATABASE_URL"]);
  });

  it("refuses conflicting environment flags, preview signers, and write roles on API-only deployments", () => {
    expect(
      faultNames(() =>
        loadConfig({
          env: completeEnv({
            DEPLOYMENT_ENV: "production",
            VERCEL_ENV: "preview",
            DATABASE_ENV: "production",
          }),
        }),
      ),
    ).toEqual(["DEPLOYMENT_ENV"]);

    expect(
      faultNames(() =>
        loadConfig({
          env: completeEnv({
            VERCEL_ENV: "preview",
            DATABASE_ENV: "preview",
            INDEXER_ENABLED: "false",
            RAILS_ENABLED: "false",
            KEEPER_ENABLED: "false",
            DATABASE_ROLE: "readwrite",
          }),
        }),
      ),
    ).toEqual(["DATABASE_ROLE"]);

    const dynamicSecret = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(7)).secret();
    try {
      loadConfig({
        env: completeEnv({
          DEPLOYMENT_ENV: "preview",
          DATABASE_ENV: "preview",
          KEEPER_STELLAR_SECRET: dynamicSecret,
        }),
      });
      throw new Error("expected ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const msg = (error as ConfigError).message;
      expect(msg).toContain("KEEPER_STELLAR_SECRET");
      expect(msg).not.toContain(dynamicSecret);
    }
  });

  it("restricts API-only credentials to required reads while serving serverless preview queries", async () => {
    let capturedReadOnlyOption = false;
    const serverless = await createServerlessApp({
      env: {
        VERCEL_ENV: "preview",
        DATABASE_ENV: "preview",
        DATABASE_URL:
          "postgres://preview_reader:isolated-pw@preview-db.internal:5432/hyperion_pr_118",
        PRODUCTION_DATABASE_URL:
          "postgres://hyperion_writer:prod-pw@prod-db.internal:5432/hyperion_prod",
        HYPERION_DEPLOYMENTS_FILE: TESTNET_DEPLOYMENTS,
      },
      openDatabase: (_url, options) => {
        capturedReadOnlyOption = options.readOnly;
        return createReadOnlyPgliteAdapter();
      },
    });

    try {
      expect(capturedReadOnlyOption).toBe(true);

      const healthRes = await serverless.inject({ method: "GET", url: "/health" });
      expect(healthRes.statusCode).toBe(200);
      expect(healthRes.json()).toMatchObject({
        status: "ok",
        environment: "preview",
        databaseRole: "readonly",
      });
      expect(JSON.stringify(healthRes.json())).not.toContain("isolated-pw");
      expect(JSON.stringify(healthRes.json())).not.toContain("preview-db.internal");

      const transferRes = await serverless.inject({
        method: "GET",
        url: "/v1/transfers/stellar-testnet/108",
      });
      expect(transferRes.statusCode).toBe(200);
      expect(transferRes.json()).toMatchObject({
        origin: {
          chain: "stellar-testnet",
          nonce: "108",
          grossAmount: "25000000",
          fee: "75000",
          netAmount: "24925000",
        },
      });
    } finally {
      await serverless.close();
    }

    // Verify SQL policy blocks direct DML, DDL, locking reads, multi-statement batches, and write CTEs.
    expect(() => {
      assertReadOnlySql("SELECT id, net_amount FROM outbound_transfer WHERE nonce = $1");
    }).not.toThrow();
    expect(() => {
      assertReadOnlySql(
        "WITH recent AS (SELECT id FROM outbound_transfer LIMIT 5) SELECT * FROM recent",
      );
    }).not.toThrow();

    for (const forbidden of [
      "INSERT INTO outbound_transfer DEFAULT VALUES",
      "UPDATE indexer_cursor SET last_processed = 1",
      "DELETE FROM rail_attestation WHERE status = 'delivered'",
      "WITH d AS (DELETE FROM rail_attestation RETURNING *) SELECT * FROM d",
      "SELECT 1; DELETE FROM outbound_transfer",
      "SELECT * FROM pending_claim FOR UPDATE SKIP LOCKED",
      "SET default_transaction_read_only = off",
    ]) {
      expect(() => {
        assertReadOnlySql(forbidden);
      }).toThrow(ReadOnlyViolationError);
    }
  });

  it("preserves seamless local development and explicit test configuration", () => {
    const devConfig = loadConfig({ env: completeEnv() });
    expect(devConfig.deploymentEnv).toBe("local");
    expect(devConfig.database.databaseEnv).toBe("local");
    expect(devConfig.database.role).toBe("readwrite");
    expect(devConfig.database.readOnly).toBe(false);

    const testConfig = loadConfig({
      env: completeEnv({
        NODE_ENV: "test",
        DEPLOYMENT_ENV: "test",
        DATABASE_ENV: "test",
        PRODUCTION_DATABASE_URL:
          "postgres://hyperion_writer:prod-pw@prod-db.internal:5432/hyperion_prod",
      }),
    });
    expect(testConfig.deploymentEnv).toBe("test");
    expect(testConfig.database.databaseEnv).toBe("test");
    expect(testConfig.database.role).toBe("readwrite");

    const localApiOnly = loadConfig({
      env: completeEnv({
        NODE_ENV: "test",
        INDEXER_ENABLED: "false",
        RAILS_ENABLED: "false",
        KEEPER_ENABLED: "false",
      }),
    });
    expect(localApiOnly.deploymentEnv).toBe("test");
    expect(localApiOnly.database.apiOnly).toBe(true);
    expect(localApiOnly.database.role).toBe("readonly");
    expect(localApiOnly.database.readOnly).toBe(true);
  });
});
