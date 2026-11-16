/**
 * The process. Reads the environment, opens what it needs, and wires shutdown to the signals.
 *
 * The config failure path deliberately does not go through pino. At the point configuration fails
 * there is no log level, no transport and nothing to attach fields to, and a readable multi line
 * message on stderr is worth more to whoever is staring at a crash loop than a single line of
 * JSON with the whole explanation escaped inside one field.
 */
import { buildCatchUpPlan, buildIndexer } from "./chains/runner.js";
import { loadConfig } from "./config/config.js";
import { ConfigError } from "./config/env.js";
import { Database } from "./db/pool.js";
import { buildServer } from "./http/server.js";
import { createKeeperRedis } from "./keeper/queue.js";
import { createLogger } from "./logging/logger.js";
import { runBoundedCatchUp } from "./runtime/budget.js";
import { Shutdown, installSignalHandlers } from "./runtime/shutdown.js";

async function main(): Promise<void> {
  const startedAt = new Date();

  const config = (() => {
    try {
      return loadConfig();
    } catch (error) {
      if (error instanceof ConfigError) {
        process.stderr.write(`\n${error.message}\n\n`);
        process.exit(78); // EX_CONFIG, so a supervisor can tell this apart from a crash.
      }
      throw error;
    }
  })();

  const logger = createLogger(config);
  const shutdown = new Shutdown(logger, config.shutdownTimeoutMs);
  installSignalHandlers(shutdown, logger);

  const db = Database.open(config.databaseUrl, { applicationName: "hyperion-backend" });
  shutdown.add("postgres", () => db.close());

  const redis = config.keeper.enabled ? createKeeperRedis(config.redisUrl) : undefined;
  if (redis)
    shutdown.add("redis", async () => {
      await redis.quit();
    });

  // Registered between the pool and the server, because shutdown runs in reverse: the server
  // stops accepting requests, the watchers finish the page they are on, and only then does the
  // pool close under them.
  const indexer = buildIndexer({ config, logger, db });
  shutdown.add("indexer", () => indexer.stop());

  const server = buildServer({
    config,
    logger,
    db,
    ...(redis ? { redis } : {}),
    readiness: indexer.readiness,
    startedAt,
  });
  // Registered before listen so a failed listen still closes what is already open.
  shutdown.add("http", () => server.close());

  await server.listen({ host: config.http.host, port: config.http.port });

  if (config.catchUpBudget !== null) {
    const signalController = new AbortController();
    const onStopSignal = (): void => {
      signalController.abort(new Error("catch-up interrupted by process signal"));
    };
    process.once("SIGTERM", onStopSignal);
    process.once("SIGINT", onStopSignal);

    try {
      const workload = buildCatchUpPlan({ config, logger, db });
      const report = await runBoundedCatchUp({
        budget: config.catchUpBudget,
        config,
        db,
        logger,
        sourcePasses: workload.sourcePasses,
        proofPasses: workload.proofPasses,
        drain: () => shutdown.run("catchup-drain"),
        externalSignal: signalController.signal,
      });
      logger.info({ catchUpReport: report }, "scheduled catch-up run finished");
      process.exitCode =
        report.stopReason === "migration_failed" || report.stopReason === "migration_timeout"
          ? 1
          : 0;
    } finally {
      process.removeListener("SIGTERM", onStopSignal);
      process.removeListener("SIGINT", onStopSignal);
    }
    return;
  }

  // After listen, so the probes are answering before the first page is read. A watcher that
  // starts first makes its initial RPC calls while nothing can report on them.
  indexer.start();
  logger.info(
    {
      host: config.http.host,
      port: config.http.port,
      network: config.network,
      deploymentsFile: config.deploymentsFile,
      watchingStellar: config.indexer.stellar?.chain ?? null,
      watchingEvm: config.indexer.evm.map((entry) => entry.chain),
      workers: indexer.workers.map((worker) => worker.name),
    },
    "hyperion backend listening",
  );
}

await main();
