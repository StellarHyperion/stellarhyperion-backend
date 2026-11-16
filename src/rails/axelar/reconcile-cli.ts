/**
 * Read-only CLI entrypoint for ITS source-to-payout reconciliation.
 *
 * Usage:
 *   npm run rail:reconcile-its -- --transfer-id <id> [--expected-destination-token <0x...>]
 *   npm run rail:reconcile-its -- --origin-chain <chain> --nonce <u64> [--expected-destination-token <0x...>]
 *   npm run rail:reconcile-its -- --origin-tx <hash> [--expected-destination-token <0x...>]
 */
import { loadConfig } from "../../config/config.js";
import { ConfigError } from "../../config/env.js";
import { Database } from "../../db/pool.js";
import { executeItsReconcileCommand, wrapReadOnlyQueryable } from "./reconcile.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(
        `${JSON.stringify({ error: "config_error", message: error.message })}\n`,
      );
      process.exit(78);
    }
    throw error;
  }

  const db = Database.open(config.databaseUrl, {
    applicationName: "hyperion-its-reconcile-readonly",
    maxConnections: 2,
  });

  try {
    const result = await executeItsReconcileCommand(argv, {
      db: wrapReadOnlyQueryable(db),
      config,
    });
    const stream = result.exitCode === 0 ? process.stdout : process.stderr;
    stream.write(`${JSON.stringify(result.output)}\n`);
    process.exitCode = result.exitCode;
  } finally {
    await db.close();
  }
}

await main();
