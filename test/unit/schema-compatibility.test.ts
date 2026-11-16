import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

import { createApiHandler } from "../../api/index.js";
import { loadConfig } from "../../src/config/config.js";
import type { Database, QueryResultRows } from "../../src/db/pool.js";
import { SchemaCompatibilityError, verifySchemaCompatibility } from "../../src/db/schema-check.js";
import { completeEnv } from "../helpers.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const MIGRATIONS_DIR = join(REPO_ROOT, "migrations");

const MIGRATIONS = [
  "1790900000000_initial-schema",
  "1791000000000_cursor-block-hash",
  "1791100000000_cursor-autovacuum-tuning",
] as const;

function wrapPg(pg: PGlite): Database {
  return {
    query: async (sql: string, params: readonly unknown[] = []): Promise<QueryResultRows> => {
      const res = await pg.query(sql, [...params]);
      const int8Columns = res.fields
        .filter((field) => field.dataTypeID === 20)
        .map((field) => field.name);
      const rows = res.rows.map((raw) => {
        const copy = { ...(raw as Record<string, unknown>) };
        for (const col of int8Columns) {
          const val = copy[col];
          if (typeof val === "number" || typeof val === "bigint") {
            copy[col] = String(val);
          }
        }
        return copy;
      });
      return { rows, rowCount: res.affectedRows ?? res.rows.length };
    },
    ping: async () => {
      await pg.query("SELECT 1");
    },
    close: () => Promise.resolve(),
  } as unknown as Database;
}

async function createPgmigrationsTable(pg: PGlite): Promise<void> {
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS public.pgmigrations (
      id serial PRIMARY KEY,
      name varchar(255) NOT NULL,
      run_on timestamp NOT NULL DEFAULT now()
    );
  `);
}

async function applyMigration(pg: PGlite, migrationName: string): Promise<void> {
  const fullSql = readFileSync(join(MIGRATIONS_DIR, `${migrationName}.sql`), "utf8");
  const upSql = fullSql.split("-- Down Migration")[0] ?? fullSql;
  await pg.exec(upSql);
  await pg.query("INSERT INTO public.pgmigrations (name) VALUES ($1)", [migrationName]);
}

describe("startup schema compatibility checks", () => {
  it("does not run migrations automatically in Dockerfile entrypoint", () => {
    const dockerfile = readFileSync(join(REPO_ROOT, "Dockerfile"), "utf8");
    expect(dockerfile).not.toContain("migrate:up");
    expect(dockerfile).toContain('CMD ["node", "dist/main.js"]');
  });

  it("rejects an uninitialized database without creating tables or running migrations", async () => {
    const pg = new PGlite();
    try {
      const db = wrapPg(pg);
      const config = loadConfig({ env: completeEnv({ KEEPER_ENABLED: "false" }) });

      await expect(verifySchemaCompatibility(db, config.schema)).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof SchemaCompatibilityError &&
          err.code === "migrations_table_missing" &&
          err.publicMessage.includes("npm run migrate:up"),
      );

      const tables = await db.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
      );
      expect(tables.rows).toHaveLength(0);
    } finally {
      await pg.close();
    }
  });

  it("rejects pending and out-of-order migrations with actionable error details", async () => {
    const pg = new PGlite();
    try {
      const db = wrapPg(pg);
      const config = loadConfig({ env: completeEnv({ KEEPER_ENABLED: "false" }) });

      await createPgmigrationsTable(pg);
      await applyMigration(pg, MIGRATIONS[0]);

      await expect(verifySchemaCompatibility(db, config.schema)).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof SchemaCompatibilityError &&
          err.code === "pending_migrations" &&
          err.details.missingMigrations.includes("1791000000000_cursor-block-hash") &&
          err.details.missingMigrations.includes("1791100000000_cursor-autovacuum-tuning"),
      );

      // Apply remaining two in reverse order to trigger order mismatch.
      await applyMigration(pg, MIGRATIONS[2]);
      await applyMigration(pg, MIGRATIONS[1]);

      await expect(verifySchemaCompatibility(db, config.schema)).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof SchemaCompatibilityError && err.code === "migration_order_mismatch",
      );
    } finally {
      await pg.close();
    }
  });

  it("passes on compatible migrations, supports additive ahead opt-in, and catches schema drift", async () => {
    const pg = new PGlite();
    try {
      const db = wrapPg(pg);
      await createPgmigrationsTable(pg);
      for (const name of MIGRATIONS) {
        await applyMigration(pg, name);
      }

      const strictConfig = loadConfig({ env: completeEnv({ KEEPER_ENABLED: "false" }) });
      const ok = await verifySchemaCompatibility(db, strictConfig.schema);
      expect(ok.compatible).toBe(true);
      expect(ok.appliedMigrations).toEqual([...MIGRATIONS]);

      // Ahead additive migration rejected under strict default, accepted with SCHEMA_ALLOW_AHEAD=true.
      await pg.exec("ALTER TABLE public.route_health ADD COLUMN sample_note text;");
      await pg.query("INSERT INTO public.pgmigrations (name) VALUES ($1)", [
        "1791200000000_additive-route-note",
      ]);

      await expect(verifySchemaCompatibility(db, strictConfig.schema)).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof SchemaCompatibilityError &&
          err.code === "ahead_migrations" &&
          err.details.aheadMigrations.includes("1791200000000_additive-route-note"),
      );

      const aheadConfig = loadConfig({
        env: completeEnv({ KEEPER_ENABLED: "false", SCHEMA_ALLOW_AHEAD: "true" }),
      });
      const aheadResult = await verifySchemaCompatibility(db, aheadConfig.schema);
      expect(aheadResult.compatible).toBe(true);
      expect(aheadResult.aheadMigrations).toEqual(["1791200000000_additive-route-note"]);

      // Narrowing NUMERIC(78,0) amount precision or dropping a required column fails even with SCHEMA_ALLOW_AHEAD=true.
      await pg.exec(
        "ALTER TABLE public.outbound_transfer ALTER COLUMN net_amount TYPE numeric(38, 0);",
      );
      await expect(verifySchemaCompatibility(db, aheadConfig.schema)).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof SchemaCompatibilityError &&
          err.code === "schema_drift" &&
          err.details.schemaIssues.some((issue) =>
            issue.includes("public.outbound_transfer.net_amount"),
          ),
      );
    } finally {
      await pg.close();
    }
  }, 20_000);

  it("blocks unsafe API reads on incompatible schema without exposing credentials and serves once migrated", async () => {
    const pg = new PGlite();
    const handler = createApiHandler({
      loadOptions: {
        env: completeEnv({
          NODE_ENV: "test",
          DATABASE_URL: "postgres://hyperion:not-a-real-password@127.0.0.1:5433/hyperion",
          INDEXER_ENABLED: "false",
          RAILS_ENABLED: "false",
          KEEPER_ENABLED: "false",
        }),
      },
      openDb: () => wrapPg(pg),
    });
    const httpServer = createServer((req, res) => {
      void handler(req, res);
    });
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });

    try {
      const address = httpServer.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected TCP address");
      }
      const baseUrl = `http://127.0.0.1:${String(address.port)}`;

      // Before migrations: API blocks unsafe reads with 503 and zero credentials.
      const blocked = await fetch(`${baseUrl}/v1/transfers`);
      expect(blocked.status).toBe(503);
      const blockedBody = (await blocked.json()) as {
        error: string;
        code: string;
        message: string;
      };
      expect(blockedBody.error).toBe("schema_incompatible");
      expect(blockedBody.code).toBe("migrations_table_missing");
      expect(blockedBody.message).toContain("npm run migrate:up");
      expect(JSON.stringify(blockedBody)).not.toContain("not-a-real-password");
      expect(JSON.stringify(blockedBody)).not.toContain("127.0.0.1:5433");

      // Apply all repository migrations and verify normal serving resumes.
      await createPgmigrationsTable(pg);
      for (const name of MIGRATIONS) {
        await applyMigration(pg, name);
      }

      const healthy = await fetch(`${baseUrl}/health`);
      expect(healthy.status).toBe(200);
      const transfers = await fetch(`${baseUrl}/v1/transfers`);
      expect(transfers.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => {
        httpServer.close(() => {
          resolve();
        });
      });
      await pg.close();
    }
  }, 20_000);

  it("redacts connection strings and passwords if a database probe error contains them", async () => {
    const config = loadConfig({ env: completeEnv({ KEEPER_ENABLED: "false" }) });
    const failingDb = {
      query: () =>
        Promise.reject(
          new Error(
            "connection failed for postgres://hyperion:not-a-real-password@db.internal:5432/hyperion (password=not-a-real-password)",
          ),
        ),
    };

    try {
      await verifySchemaCompatibility(failingDb, config.schema);
      throw new Error("Expected SchemaCompatibilityError");
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaCompatibilityError);
      const message = (error as SchemaCompatibilityError).publicMessage;
      expect(message).not.toContain("not-a-real-password");
      expect(message).not.toContain("db.internal:5432");
      expect(message).toContain("[redacted-connection-url]");
    }
  });
});
