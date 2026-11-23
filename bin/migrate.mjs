#!/usr/bin/env node
/**
 * Run node-pg-migrate with the migration credential, kept apart from the API and worker ones.
 *
 * Migrations need DDL rights that neither the public API nor the indexer should hold, so they
 * read `MIGRATION_DATABASE_URL`. Installations that predate the split keep working through
 * `DATABASE_URL`. The read-only `API_DATABASE_URL` is never accepted here.
 *
 * The chosen value travels to node-pg-migrate in a private environment variable named with
 * `--database-url-var`, never on the command line, and is never printed: a refusal names the
 * variables involved, not their values.
 *
 * Plain ESM rather than TypeScript so it runs unchanged in the production image, which ships
 * `dist` and `migrations` but not `src`.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MIGRATION_CONNECTION_VAR = "HYPERION_MIGRATION_CONNECTION";

/** @param {Readonly<Record<string, string | undefined>>} env */
export function resolveMigrationConnection(env) {
  const read = (/** @type {string} */ name) => {
    const value = env[name]?.trim();
    return value === undefined || value.length === 0 ? undefined : value;
  };
  const migration = read("MIGRATION_DATABASE_URL");
  const primary = read("DATABASE_URL");
  const api = read("API_DATABASE_URL");
  const url = migration ?? primary;
  const source = migration === undefined ? "DATABASE_URL" : "MIGRATION_DATABASE_URL";
  if (url === undefined) {
    throw new Error("Set MIGRATION_DATABASE_URL (or DATABASE_URL) before running migrations.");
  }
  if (api !== undefined && url === api) {
    throw new Error(
      `${source} is the same credential as API_DATABASE_URL; migrations need their own role, never the read-only API one.`,
    );
  }
  return { url, source };
}

/**
 * The child environment: the chosen credential under the private name, plus everything else.
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {string} url
 */
export function migrationEnvironment(env, url) {
  return { ...env, [MIGRATION_CONNECTION_VAR]: url };
}

async function main() {
  let resolved;
  try {
    resolved = resolveMigrationConnection(process.env);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Migration setup failed."}\n`);
    process.exit(78); // EX_CONFIG, matching the server's configuration failures.
  }
  const cli = fileURLToPath(
    new URL("../node_modules/node-pg-migrate/bin/node-pg-migrate.js", import.meta.url),
  );
  const child = spawn(
    process.execPath,
    [cli, "--database-url-var", MIGRATION_CONNECTION_VAR, ...process.argv.slice(2)],
    { stdio: "inherit", env: migrationEnvironment(process.env, resolved.url) },
  );
  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal === null ? 1 : 128));
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
