import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/config.js";
import { checkDatabasePolicy } from "../../src/db/policy.js";
import { completeEnv } from "../helpers.js";
const env = {
  NODE_ENV: "production",
  VERCEL_ENV: "preview",
  HYPERION_DATABASE_ENV: "preview",
  INDEXER_ENABLED: "false",
  RAILS_ENABLED: "false",
  KEEPER_ENABLED: "false",
  HYPERION_DATABASE_ROLE: "read-only",
};
const config = loadConfig({ env: completeEnv(env) });
const allowed = {
  rolsuper: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolbypassrls: false,
  can_write: false,
  can_escalate: false,
  can_create: false,
  can_read: true,
};
function database(environment: string, role = allowed) {
  return {
    query: (sql: string) =>
      Promise.resolve({
        rows: [sql.includes("hyperion_database_identity") ? { environment } : role],
        rowCount: 1,
      }),
  };
}
describe("environment and database role admission", () => {
  it("cannot relabel a production database as preview", async () => {
    await expect(checkDatabasePolicy(database("production"), config)).rejects.toThrow(
      "provisioned database identity",
    );
  });
  it.each([
    "rolsuper",
    "rolcreatedb",
    "rolcreaterole",
    "rolbypassrls",
    "can_write",
    "can_escalate",
    "can_create",
  ] as const)("rejects a read API credential with %s", async (field) => {
    await expect(
      checkDatabasePolicy(database("preview", { ...allowed, [field]: true }), config),
    ).rejects.toThrow("dedicated nonprivileged role");
  });
  it("requires SELECT grants for public API tables", async () => {
    await expect(
      checkDatabasePolicy(database("preview", { ...allowed, can_read: false }), config),
    ).rejects.toThrow("required SELECT grants");
  });
  it("admits an explicitly provisioned preview and ordinary read-only identity", async () => {
    await expect(checkDatabasePolicy(database("preview"), config)).resolves.toBeUndefined();
  });
  it("requires write identity for a rails-only replica", () => {
    const writing = loadConfig({
      env: completeEnv({ ...env, RAILS_ENABLED: "true", HYPERION_DATABASE_ROLE: "read-write" }),
    });
    expect(writing.databaseRole).toBe("read-write");
    expect(() => loadConfig({ env: completeEnv({ ...env, RAILS_ENABLED: "true" }) })).toThrow(
      "rail or keeper writes",
    );
  });
});
