/**
 * Local operator CLI entrypoint for re-evaluating terminal (`failed` or `expired`) rail transfers.
 *
 * Usage:
 *   npm run rail:requeue -- --transfer-id <id> --reviewed-by <actor> --reason "<why>" [--evidence <ref>] [--evaluate-now]
 *   npm run rail:requeue -- --origin-chain <chain> --nonce <u64> --reviewed-by <actor> --reason "<why>" [--evidence <ref>] [--evaluate-now]
 */
import { buildRailPasses } from "../chains/runner.js";
import { loadConfig } from "../config/config.js";
import { ConfigError } from "../config/env.js";
import { Database } from "../db/pool.js";
import { createLogger } from "../logging/logger.js";
import { executeRequeueCommand } from "./requeue.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${JSON.stringify({ kind: "config_error", detail: error.message })}\n`);
      process.exit(78);
    }
    throw error;
  }

  const logger = createLogger(config);
  const db = Database.open(config.databaseUrl, { applicationName: "hyperion-rail-requeue" });
  const passes = buildRailPasses(config.rails, config.network, db, logger, config);

  try {
    const result = await executeRequeueCommand(argv, {
      db,
      evaluateTransfer: async (route, transferId) => {
        const pass = passes.find((candidate) => candidate.route === route);
        if (pass === undefined) return false;
        return pass.evaluateTransfer(transferId, new AbortController().signal);
      },
    });
    const stream = result.exitCode === 0 ? process.stdout : process.stderr;
    stream.write(`${JSON.stringify(result.output)}\n`);
    process.exitCode = result.exitCode;
  } finally {
    await db.close();
  }
}

await main();
