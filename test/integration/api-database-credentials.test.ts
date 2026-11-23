import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { closeApp, getApp, getDb } from "../../api/index.js";
import { loadConfig } from "../../src/config/config.js";
import { API_READ_TABLES, checkDatabasePolicy } from "../../src/db/policy.js";
import { Database } from "../../src/db/pool.js";
import { completeEnv, validateConcurrencyDatabase } from "../helpers.js";

const connection = process.env.TEST_DATABASE_URL;

(connection ? describe : describe.skip)("separate API credential on dedicated PostgreSQL", () => {
  let admin: Database;
  let opened = false;
  let roleCreated = false;
  let originalIdentity: readonly Record<string, unknown>[] = [];
  const role = `hyperion_api_reader_${process.pid}`;
  let readerUrl = "";

  beforeAll(async () => {
    validateConcurrencyDatabase(connection ?? "");
    admin = Database.open(connection ?? "");
    opened = true;
    originalIdentity = (await admin.query("SELECT environment FROM hyperion_database_identity"))
      .rows;
    await admin.query("DELETE FROM hyperion_database_identity");
    await admin.query("INSERT INTO hyperion_database_identity(environment) VALUES ('preview')");
    await admin.query(
      `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
    roleCreated = true;
    await admin.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await admin.query(
      `GRANT SELECT ON ${API_READ_TABLES.map((name) => `public.${name}`).join(",")} TO "${role}"`,
    );
    const reader = new URL(connection ?? "");
    reader.username = role;
    reader.password = "";
    readerUrl = reader.toString();
  });

  afterAll(async () => {
    try {
      await closeApp();
      if (opened) {
        if (roleCreated) {
          await admin.query(`DROP OWNED BY "${role}"`);
          await admin.query(`DROP ROLE "${role}"`);
        }
        await admin.query("DELETE FROM hyperion_database_identity");
        for (const row of originalIdentity)
          await admin.query("INSERT INTO hyperion_database_identity(environment) VALUES ($1)", [
            row.environment,
          ]);
      }
    } finally {
      vi.unstubAllEnvs();
      if (opened) await admin.close();
    }
  });

  const hosted = {
    REDIS_URL: "",
    NODE_ENV: "test",
    LOG_LEVEL: "fatal",
    VERCEL_ENV: "preview",
    HYPERION_DATABASE_ENV: "preview",
  };

  it("serves the hosted API with only the read-only API credential", async () => {
    const env = completeEnv({
      ...hosted,
      API_DATABASE_URL: readerUrl,
      INDEXER_ENABLED: "false",
      RAILS_ENABLED: "false",
      KEEPER_ENABLED: "false",
    });
    delete env.DATABASE_URL;
    vi.stubEnv("DATABASE_URL", undefined);
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);

    const app = await getApp();
    const ready = await app.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(200);
    const db = getDb();
    expect(db).not.toBeNull();
    const who = await db?.query("SELECT current_user AS name");
    expect(who?.rows[0]?.name).toBe(role);
    await expect(db?.query("DELETE FROM public.route_health")).rejects.toThrow();
    for (const secret of [connection ?? "", readerUrl]) expect(ready.body).not.toContain(secret);
    await closeApp();
  });

  it("admits the reader as a writer process's API pool and refuses the writer there", async () => {
    const config = loadConfig({
      env: completeEnv({
        ...hosted,
        DATABASE_URL: connection ?? "",
        API_DATABASE_URL: readerUrl,
        HYPERION_DATABASE_ROLE: "read-write",
        INDEXER_ENABLED: "true",
        KEEPER_ENABLED: "false",
      }),
    });
    expect(config.databaseUrl).toBe(connection);
    expect(config.apiDatabaseUrl).toBe(readerUrl);

    const apiDb = Database.open(config.apiDatabaseUrl, { readOnly: true });
    const misusedWriter = Database.open(config.databaseUrl, { readOnly: true });
    try {
      await expect(
        checkDatabasePolicy(apiDb, { ...config, databaseRole: "read-only" }),
      ).resolves.toBeUndefined();
      await expect(
        checkDatabasePolicy(misusedWriter, { ...config, databaseRole: "read-only" }),
      ).rejects.toThrow(/read-only requires a dedicated nonprivileged role/);
    } finally {
      await apiDb.close();
      await misusedWriter.close();
    }
  });
});
