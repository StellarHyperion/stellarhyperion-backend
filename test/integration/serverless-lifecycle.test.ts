import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeApp, getApp, getDb } from "../../api/index.js";
import { API_READ_TABLES } from "../../src/db/policy.js";
import { Database } from "../../src/db/pool.js";
import { completeEnv, validateConcurrencyDatabase } from "../helpers.js";

const connection = process.env.TEST_DATABASE_URL;

(connection ? describe : describe.skip)("serverless lifecycle on dedicated PostgreSQL", () => {
  let admin: Database;
  let opened = false;
  let roleCreated = false;
  let originalIdentity: readonly Record<string, unknown>[] = [];
  const role = `hyperion_serverless314_${process.pid}`;

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
    const env = completeEnv({
      DATABASE_URL: reader.toString(),
      REDIS_URL: "",
      NODE_ENV: "test",
      LOG_LEVEL: "fatal",
      VERCEL_ENV: "preview",
      HYPERION_DATABASE_ENV: "preview",
      HYPERION_DATABASE_ROLE: "read-only",
      INDEXER_ENABLED: "false",
      RAILS_ENABLED: "false",
      KEEPER_ENABLED: "false",
    });
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
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

  async function sessions(): Promise<number> {
    const result = await admin.query(
      "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE usename=$1",
      [role],
    );
    return Number(result.rows[0]?.count);
  }

  it("bounds concurrent pool use and releases all connections across repeated environment restarts", async () => {
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const apps = await Promise.all(Array.from({ length: 16 }, () => getApp()));
      const app = apps[0];
      if (app === undefined) throw new Error("missing fixture application");
      expect(new Set(apps).size).toBe(1);
      const db = getDb();
      if (db === null) throw new Error("missing fixture database");
      await Promise.all(Array.from({ length: 12 }, () => db.query("SELECT pg_sleep(0.01)")));
      expect(await sessions()).toBeLessThanOrEqual(2);
      expect(db.poolSnapshot().totalConnections).toBeLessThanOrEqual(2);
      await expect(
        db.query("UPDATE hyperion_database_identity SET environment='production'"),
      ).rejects.toThrow();
      const listeners = app.server.listenerCount("request");
      expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
      await Promise.all(Array.from({ length: 16 }, () => getApp()));
      expect(app.server.listenerCount("request")).toBe(listeners);
      await Promise.all([closeApp(), closeApp()]);
      expect(await sessions()).toBe(0);
      expect(getDb()).toBeNull();
    }
  });

  it("replaces a terminated idle PostgreSQL connection without poisoning the warm app", async () => {
    const app = await getApp();
    const db = getDb();
    if (db === null) throw new Error("missing fixture database");
    const pid = (await db.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
    expect(typeof pid).toBe("number");
    await admin.query("SELECT pg_terminate_backend($1)", [pid]);
    await vi.waitFor(() => {
      expect(db.poolSnapshot().totalConnections).toBe(0);
    });
    expect(await getApp()).toBe(app);
    const nextPid = (await db.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
    expect(nextPid).not.toBe(pid);
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    await closeApp();
    expect(await sessions()).toBe(0);
  });
});
