import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database } from "../../src/db/pool.js";
import { API_READ_TABLES, checkDatabasePolicy } from "../../src/db/policy.js";
import { loadConfig } from "../../src/config/config.js";
import { completeEnv } from "../helpers.js";
const connection = process.env.TEST_DATABASE_URL;
(connection ? describe : describe.skip)(
  "actual PostgreSQL preview identity and minimum read role",
  () => {
    let admin: Database;
    let reader: Database;
    let adminOpened = false;
    let readerOpened = false;
    let roleCreated = false;
    let original: readonly Record<string, unknown>[] = [];
    const role = `hyperion_read293_${process.pid}`;
    const config = loadConfig({
      env: completeEnv({
        NODE_ENV: "production",
        VERCEL_ENV: "preview",
        HYPERION_DATABASE_ENV: "preview",
        HYPERION_DATABASE_ROLE: "read-only",
        INDEXER_ENABLED: "false",
        RAILS_ENABLED: "false",
        KEEPER_ENABLED: "false",
      }),
    });
    beforeAll(async () => {
      admin = Database.open(connection ?? "");
      adminOpened = true;
      original = (await admin.query("SELECT environment FROM hyperion_database_identity")).rows;
      await admin.query("DELETE FROM hyperion_database_identity");
      await admin.query("INSERT INTO hyperion_database_identity(environment) VALUES ('preview')");
      await admin.query(
        `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
      );
      roleCreated = true;
      await admin.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
      await admin.query(
        `GRANT SELECT ON ${API_READ_TABLES.map((table) => `public.${table}`).join(",")} TO "${role}"`,
      );
      const url = new URL(connection ?? "");
      url.username = role;
      url.password = "";
      reader = Database.open(url.toString(), { readOnly: true });
      readerOpened = true;
    });
    afterAll(async () => {
      if (readerOpened) await reader.close();
      if (adminOpened) {
        if (roleCreated) {
          await admin.query(`DROP OWNED BY "${role}"`);
          await admin.query(`DROP ROLE "${role}"`);
        }
        await admin.query("DELETE FROM hyperion_database_identity");
        for (const row of original)
          await admin.query("INSERT INTO hyperion_database_identity(environment) VALUES ($1)", [
            row.environment,
          ]);
        await admin.close();
      }
    });
    it("accepts real read grants and cannot write the provisioned environment marker", async () => {
      await expect(checkDatabasePolicy(reader, config)).resolves.toBeUndefined();
      await expect(
        reader.query("UPDATE hyperion_database_identity SET environment='production'"),
      ).rejects.toThrow();
    });
    it("rejects an escalation membership even when the login itself has no write grants", async () => {
      const writingRole = `${role}_writer`;
      await admin.query(`CREATE ROLE "${writingRole}" NOLOGIN`);
      try {
        await admin.query(`GRANT UPDATE ON public.hyperion_database_identity TO "${writingRole}"`);
        await admin.query(`GRANT "${writingRole}" TO "${role}" WITH INHERIT FALSE`);
        await expect(checkDatabasePolicy(reader, config)).rejects.toThrow("nonprivileged role");
      } finally {
        await admin.query(`REVOKE "${writingRole}" FROM "${role}"`);
        await admin.query(`DROP OWNED BY "${writingRole}"`);
        await admin.query(`DROP ROLE "${writingRole}"`);
      }
    });
    it("rejects the same connection when the real database identity says production", async () => {
      await admin.query("UPDATE hyperion_database_identity SET environment='production'");
      await expect(checkDatabasePolicy(reader, config)).rejects.toThrow("separate databases");
    });
  },
);
