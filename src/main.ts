/**
 * The process. Reads the environment, opens what it needs, and wires shutdown to the signals.
 *
 * The config failure path deliberately does not go through pino. At the point configuration fails
 * there is no log level, no transport and nothing to attach fields to, and a readable multi line
 * message on stderr is worth more to whoever is staring at a crash loop than a single line of
 * JSON with the whole explanation escaped inside one field.
 */
import { buildIndexer } from "./chains/runner.js";
import { loadConfig } from "./config/config.js";
import { ConfigError } from "./config/env.js";
import { Database } from "./db/pool.js";
import { checkSchemaCompatibility } from "./db/schema.js";
import { createLeaseStore } from "./db/lease.js";
import { BudgetTracker } from "./runtime/budget.js";
import { buildServer } from "./http/server.js";
import { createApiRedis } from "./http/rate-limit-redis.js";
import { createLogger } from "./logging/logger.js";
import { fixedReadiness } from "./runtime/readiness.js";
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

const logger = createLogger(config);
  const shutdown = new Shutdown(logger, config.shutdownTimeoutMs);
  installSignalHandlers(shutdown, logger);

  const budget = new BudgetTracker(config.catchUpBudgetMs);
  budget.runBudget();
  const budgetTimer = setInterval(() => {
    try {
      budget.runBudget();
    } catch {
      void shutdown.run("catch-up budget expired").then(() => {
        logger.info({ reason: budget.stopReason() }, "catch-up run stopping");
        process.exitCode = 0;
      });
      clearInterval(budgetTimer);
    }
  }, 1000);
  budgetTimer.unref();

  const db = Database.open(config.databaseUrl, { applicationName: "hyperion-backend" });
  await checkSchemaCompatibility(db, config.schemaVersion);
  shutdown.add("postgres", () => db.close());

  const leaseStore = createLeaseStore(db);
  const cursors: { readonly chainKey: string; readonly contract: string }[] = [];
  if (config.indexer.stellar !== null) {
    cursors.push({ chainKey: config.indexer.stellar.chain, contract: config.indexer.stellar.routerContractId });
  }
  for (const chain of config.indexer.evm) {
    cursors.push({ chainKey: chain.chain, contract: chain.routerAddress });
  }
  if (cursors.length > 0) {
    await leaseStore.acquire(cursors, config.indexerLeaseOwnerId, config.indexerLeaseTtlMs);
    shutdown.add("indexer-lease", async () => {
      await leaseStore.release(cursors, config.indexerLeaseOwnerId).catch(() => undefined);
    });
    const leaseRenewal = setInterval(() => {
      void leaseStore
        .renew(cursors, config.indexerLeaseOwnerId, config.indexerLeaseTtlMs)
        .catch((error: unknown) => {
          logger.warn({ err: error }, "indexer lease renewal failed");
        });
    }, Math.floor(config.indexerLeaseTtlMs / 2));
    leaseRenewal.unref();
  }

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

  const leaseReadiness = cursors.length > 0
    ? [
        fixedReadiness(
          "indexer-lease",
          "ready",
          `lease held by ${config.indexerLeaseOwnerId} on ${cursors.length} cursor(s)`,
        ),
      ]
    : [];
  const indexerReadiness = [...indexer.readiness, ...leaseReadiness];

  const server = buildServer({
    config,
    logger,
    db,
    ...(redis ? { redis } : {}),
    readiness: indexerReadiness,
    startedAt,
  });
  // Registered before listen so a failed listen still closes what is already open.
  shutdown.add("http", () => server.close());

  await server.listen({ host: config.http.host, port: config.http.port });
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
      catchUpBudgetMs: config.catchUpBudgetMs,
    },
    "hyperion backend listening",
  );
}

await main();
