import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function readDotEnv(filePath) {
  if (!existsSync(filePath)) return {};
  const entries = {};
  const content = readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries[key] = value;
  }
  return entries;
}

const envPath = resolve(process.cwd(), ".env");
const mergedEnv = { ...readDotEnv(envPath), ...process.env };

const migrationUrl = (mergedEnv.MIGRATION_DATABASE_URL ?? "").trim();
const sharedUrl = (mergedEnv.DATABASE_URL ?? "").trim();
const apiUrl = (mergedEnv.API_DATABASE_URL ?? "").trim();
const indexerUrl = (mergedEnv.INDEXER_DATABASE_URL ?? "").trim();

if (migrationUrl.length > 0 && apiUrl.length > 0 && migrationUrl === apiUrl) {
  process.stderr.write(
    "Hyperion migrations refused: MIGRATION_DATABASE_URL must not reuse the read-only API_DATABASE_URL credential.\n",
  );
  process.exit(78);
}

let urlVar = null;
if (migrationUrl.length > 0) {
  urlVar = "MIGRATION_DATABASE_URL";
} else if (sharedUrl.length > 0) {
  urlVar = "DATABASE_URL";
} else {
  const hint =
    apiUrl.length > 0 || indexerUrl.length > 0
      ? "schema migrations require MIGRATION_DATABASE_URL (or DATABASE_URL) and cannot use API_DATABASE_URL or INDEXER_DATABASE_URL."
      : "supply MIGRATION_DATABASE_URL or DATABASE_URL before running migrations.";
  process.stderr.write(`Hyperion migrations refused: ${hint}\n`);
  process.exit(78);
}

const binPath = resolve(process.cwd(), "node_modules/node-pg-migrate/bin/node-pg-migrate.js");
const args = [
  binPath,
  "--database-url-var",
  urlVar,
  "--migrations-dir",
  "migrations",
  "--migrations-table",
  "pgmigrations",
  ...(existsSync(envPath) ? ["--envPath", ".env"] : []),
  ...process.argv.slice(2),
];

const result = spawnSync(process.execPath, args, {
  stdio: "inherit",
  env: mergedEnv,
});

process.exit(result.status ?? 1);
