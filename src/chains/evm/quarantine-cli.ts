import { loadConfig } from "../../config/config.js";
import { Database } from "../../db/pool.js";
import { checkSchemaCompatibility } from "../../db/schema.js";
import { createLogger } from "../../logging/logger.js";
import { viemClient } from "./client.js";
import { EvmWatcher } from "./watcher.js";

async function main(): Promise<void> {
  const [command, chain, rawLimit = "100", ...extra] = process.argv.slice(2);
  if (command === "--help") {
    process.stdout.write("Usage: evm:quarantine -- replay <configured-chain> [limit 1..100]\n");
    return;
  }
  const limit = Number(rawLimit);
  if (
    command !== "replay" ||
    !chain ||
    extra.length ||
    !/^\d{1,3}$/.test(rawLimit) ||
    limit < 1 ||
    limit > 100
  )
    throw new Error("Use --help for the bounded local quarantine replay command.");
  const config = loadConfig();
  const network = config.indexer.evm.find((entry) => entry.chain === chain);
  if (!network || config.databaseRole === "read-only")
    throw new Error("Replay requires a configured EVM router and writer credentials.");
  const logger = createLogger(config);
  const db = Database.open(config.databaseUrl, {
    applicationName: "hyperion-evm-quarantine-replay",
  });
  const controller = new AbortController();
  const cancel = () => {
    controller.abort();
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    await checkSchemaCompatibility(db);
    const watcher = new EvmWatcher({
      chainKey: network.chain,
      chainId: network.chainId,
      router: network.routerAddress,
      startBlock: network.startBlock,
      confirmations: network.confirmations,
      reorgDepth: network.reorgDepth,
      finalityMode: network.finalityMode,
      allowFinalityFallback: network.allowFinalityFallback,
      logRange: network.logRange,
      client: viemClient(network.rpcUrls, { logger }),
      db,
      logger,
    });
    process.stdout.write(
      `${JSON.stringify(await watcher.replayQuarantined(controller.signal, limit))}\n`,
    );
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    await db.close();
  }
}
await main();
