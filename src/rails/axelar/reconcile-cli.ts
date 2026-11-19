import { pathToFileURL } from "node:url";
import { loadConfig } from "../../config/config.js";
import { Database } from "../../db/pool.js";
import { checkSchemaCompatibility } from "../../db/schema.js";
import { checkDatabasePolicy } from "../../db/policy.js";
import { reconcileItsTransfers } from "./reconcile.js";

export function parseReconcileArguments(argv: readonly string[]): {
  transferId?: bigint;
  limit?: number;
} {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const option = argv[i],
      argument = argv[i + 1];
    if (
      !option ||
      !["--transfer-id", "--limit", "--format"].includes(option) ||
      argument === undefined ||
      values.has(option)
    )
      throw new Error("Invalid reconciliation arguments; use --help.");
    values.set(option, argument);
  }
  const id = values.get("--transfer-id"),
    limit = values.get("--limit"),
    format = values.get("--format");
  if (
    (id !== undefined && (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n)) ||
    (limit !== undefined &&
      (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 500)) ||
    (format !== undefined && format !== "json")
  )
    throw new Error("Invalid reconciliation bounds or format; use --help.");
  return {
    ...(id === undefined ? {} : { transferId: BigInt(id) }),
    ...(limit === undefined ? {} : { limit: Number(limit) }),
  };
}

export async function runReconcileCli(argv: readonly string[]): Promise<number> {
  if (argv.includes("--help")) {
    process.stdout.write(
      "Usage: npm run rails:reconcile -- [--transfer-id <id>] [--limit <1..500>] [--format json]\n",
    );
    return 0;
  }
  const options = parseReconcileArguments(argv);
  const config = loadConfig({
    env: {
      ...process.env,
      INDEXER_ENABLED: "false",
      RAILS_ENABLED: "false",
      KEEPER_ENABLED: "false",
    },
  });
  const db = Database.open(config.databaseUrl, {
    applicationName: "hyperion-axelar-reconcile",
    readOnly: true,
  });
  try {
    await checkSchemaCompatibility(db, config.schemaVersion);
    await checkDatabasePolicy(db, config);
    const report = await reconcileItsTransfers(db, options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } finally {
    await db.close();
  }
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url)
  try {
    process.exitCode = await runReconcileCli(process.argv.slice(2));
  } catch {
    process.stderr.write(
      "ITS reconciliation failed; verify request, database schema and reader configuration.\n",
    );
    process.exitCode = 1;
  }
