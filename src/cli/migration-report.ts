import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Database } from "../db/pool.js";
import { migrationRollbackReport } from "../db/migration-report.js";

const directory = resolve(process.cwd(), "migrations");

function downSql(source: string): string {
  return source.split(/^-- Down Migration\s*$/m)[1] ?? "";
}

async function main(): Promise<void> {
  const connection = process.env.DATABASE_URL?.trim();
  if (!connection) throw new Error("DATABASE_URL is not set.");
  const files = (await readdir(directory)).filter((name) => /^\d{13}_[a-z0-9-]+\.sql$/.test(name));
  const migrations = await Promise.all(
    files.sort().map(async (name) => ({
      name: name.slice(0, -4),
      downSql: downSql(await readFile(resolve(directory, name), "utf8")),
    })),
  );
  const db = Database.open(connection, {
    applicationName: "hyperion-migration-report",
    readOnly: true,
  });
  try {
    const preflight = await db.migrationPreflight({
      expectedMigrations: migrations.map((migration) => migration.name),
      ...(process.env.HYPERION_MIGRATION_BACKUP_ID === undefined
        ? {}
        : {
            backupBoundaryId: process.env.HYPERION_MIGRATION_BACKUP_ID,
          }),
    });
    const report = {
      preflight,
      rollback: migrationRollbackReport(migrations),
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!preflight.safe) process.exitCode = 1;
  } finally {
    await db.close();
  }
}

await main();
