import { pathToFileURL } from "node:url";
import { loadConfig } from "../../config/config.js";
import { Database } from "../../db/pool.js";
import { reconcileItsTransfers } from "./reconcile.js";

function value(argv: readonly string[], option: string): string | undefined {
  const index = argv.indexOf(option);
  return index < 0 ? undefined : argv[index + 1];
}

export async function runReconcileCli(argv: readonly string[]): Promise<number> {
  if (argv.includes("--help")) {
    process.stdout.write(
      "Usage: npm run rails:reconcile -- [--transfer-id <id>] [--limit <1..500>] [--format json]\n",
    );
    return 0;
  }
  const id = value(argv, "--transfer-id");
  const limitText = value(argv, "--limit");
  const transferId = id === undefined ? undefined : BigInt(id);
  const limit = limitText === undefined ? undefined : Number(limitText);
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
    const report = await reconcileItsTransfers(db, {
      ...(transferId === undefined ? {} : { transferId }),
      ...(limit === undefined ? {} : { limit }),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } finally {
    await db.close();
  }
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url)
  process.exitCode = await runReconcileCli(process.argv.slice(2));
