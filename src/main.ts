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
import { buildServer } from "./http/server.js";
import { createKeeperRedis } from "./keeper/queue.js";
import { createLogger } from "./logging/logger.js";
import { RolloutCoordinator } from "./runtime/rollout.js";
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

  const rollout = new RolloutCoordinator({
    db,
    instanceId: config.rollout.instanceId,
    leaseTtlMs: config.rollout.leaseTtlMs,
    drainGraceMs: config.rollout.drainGraceMs,
    logger,
  });

  const indexer = buildIndexer({ config, logger, db, rollout });

  const server = buildServer({
    config,
    logger,
    db,
    ...(redis ? { redis } : {}),
    rollout,
    readiness: indexer.readiness,
    startedAt,
  });
  // Shutdown executes in reverse registration order:
  // 1. rollout-drain marks /ready 503 while HTTP keeps answering probes, waits drainGraceMs,
  //    stops background watchers, fences off stale writes and releases rollout leases in Postgres.
  // 2. http closes the Fastify listener.
  // 3. redis and postgres close after all workers and HTTP handlers have drained.
  shutdown.add("http", () => server.close());
  shutdown.add("rollout-drain", async () => {
    await rollout.drainAndRelease("shutdown", () => indexer.stop());
  });

  await server.listen({ host: config.http.host, port: config.http.port });
  const admission = await rollout.admitSchema();
  if (!admission.admitted) {
    logger.error(
      { instanceId: rollout.instanceId, missingTables: admission.missingTables },
      admission.detail,
    );
    await shutdown.run("schema-admission-failed");
    process.exit(1);
  }

  // Start background watchers only after PostgreSQL schema admission succeeds; each watcher pass
  // acquires its distributed rollout lease before reading or advancing shared cursors.
  indexer.start();
  logger.info(
    {
      host: config.http.host,
      port: config.http.port,
      network: config.network,
      instanceId: rollout.instanceId,
      deploymentsFile: config.deploymentsFile,
      watchingStellar: config.indexer.stellar?.chain ?? null,
      watchingEvm: config.indexer.evm.map((entry) => entry.chain),
      workers: indexer.workers.map((worker) => worker.name),
    },
    "hyperion backend listening",
  );
}

await main();
