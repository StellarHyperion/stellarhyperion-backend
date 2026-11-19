import { loadConfig } from "../../config/config.js";
import { Database } from "../../db/pool.js";
import { createLogger } from "../../logging/logger.js";
import { EvmBackfillManager } from "./backfill.js";

async function main(): Promise<void> {
  const [command, owner, first, from, to] = process.argv.slice(2);
  if (command === "--help") {
    process.stdout.write(
      "Usage: evm:backfill -- start <owner> <chain> <from> <to> | resume <owner> <job-id> | cancel <owner> <job-id>\n",
    );
    return;
  }
  if (!owner || !first || !["start", "resume", "cancel"].includes(command ?? ""))
    throw new Error("Use --help for the local operator command format.");
  const config = loadConfig();
  const db = Database.open(config.databaseUrl, { applicationName: "hyperion-evm-backfill" });
  const manager = new EvmBackfillManager(config.indexer.evm, db, createLogger(config));
  const controller = new AbortController();
  const cancelWaiting = () => {
    controller.abort();
  };
  process.on("SIGINT", cancelWaiting);
  process.on("SIGTERM", cancelWaiting);
  try {
    let result;
    if (command === "start") {
      if (!from || !to || !/^\d{1,20}$/.test(from) || !/^\d{1,20}$/.test(to))
        throw new Error("Block bounds must be decimal integers of at most 20 digits.");
      const job = await manager.start(owner, first, BigInt(from), BigInt(to));
      process.stdout.write(`${JSON.stringify(job)}\n`);
      result = await manager.run(job.id, job.owner, controller.signal);
    } else if (command === "resume")
      result = await manager.resume(first, owner.trim(), controller.signal);
    else result = await manager.cancel(first, owner.trim());
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    process.off("SIGINT", cancelWaiting);
    process.off("SIGTERM", cancelWaiting);
    await db.close();
  }
}
await main();
