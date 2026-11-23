/**
 * The process. Reads the environment, opens what it needs, and wires shutdown to the signals.
 *
 * The config failure path deliberately does not go through pino. At the point configuration fails
 * there is no log level, no transport and nothing to attach fields to, and a readable multi line
 * message on stderr is worth more to whoever is staring at a crash loop than a single line of
 * JSON with the whole explanation escaped inside one field.
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildIndexer } from "./chains/runner.js";
import { admitNetworkEnvironment } from "./config/admission.js";
import {
  WorkerPolicyStore,
  loadWorkerPolicyConfig,
  reloadWorkerPolicy,
} from "./runtime/worker-policy.js";
import { ConfigError, NetworkAdmissionError } from "./config/env.js";
import { checkDatabasePolicy } from "./db/policy.js";
import { checkSchemaCompatibility } from "./db/schema.js";
import { runBudgetedCatchUp } from "./runtime/budget.js";
import { Database } from "./db/pool.js";
import { buildServer } from "./http/server.js";
import { createApiRedis } from "./http/rate-limit-redis.js";
import { createLogger } from "./logging/logger.js";
import { Shutdown, installSignalHandlers } from "./runtime/shutdown.js";

export interface ContinuousApplication {
  readonly server: FastifyInstance;
  readonly db: Database;
  readonly workerPolicy: WorkerPolicyStore;
  readonly stop: (reason?: string) => Promise<void>;
}

/** The continuous entrypoint, also available to lifecycle and parity harnesses. */
export async function startContinuousApplication(): Promise<ContinuousApplication> {
  const startedAt = new Date();
  const configuredPolicyFile = process.env.HYPERION_WORKER_POLICY_FILE?.trim();
  const workerPolicyFile = configuredPolicyFile === "" ? null : (configuredPolicyFile ?? null);

  const config = (() => {
    try {
      return loadWorkerPolicyConfig(workerPolicyFile);
    } catch (error) {
      if (error instanceof ConfigError) {
        process.stderr.write(`\n${error.message}\n\n`);
        process.exit(78); // EX_CONFIG, so a supervisor can tell this apart from a crash.
      }
      throw error;
    }
  })();

  try {
    await admitNetworkEnvironment(config);
  } catch (error) {
    if (error instanceof NetworkAdmissionError) {
      process.stderr.write(`\n${error.message}\n\n`);
      process.exit(78);
    }
    throw error;
  }

  const logger = createLogger(config);
  const workerPolicy = new WorkerPolicyStore(config);
  const reloadPolicy = (): void => {
    reloadWorkerPolicy(workerPolicy, () => loadWorkerPolicyConfig(workerPolicyFile), logger);
  };
  const shutdown = new Shutdown(logger, config.shutdownTimeoutMs);
  const removeSignalHandlers = installSignalHandlers(shutdown, logger);
  shutdown.add("signal-handlers", () => {
    removeSignalHandlers();
    return Promise.resolve();
  });

  process.on("SIGHUP", reloadPolicy);
  shutdown.add("worker-policy", () => {
    process.off("SIGHUP", reloadPolicy);
    return Promise.resolve();
  });

  const db = Database.open(config.databaseUrl, {
    applicationName: "hyperion-backend",
    readOnly: config.databaseRole === "read-only",
    logger,
    slowQueryThresholdMs: 1_000,
  });
  shutdown.add("postgres", () => db.close());
  // With API_DATABASE_URL, the public API reads through its own least-privilege pool and never
  // shares the writer credential. Without it, the API keeps sharing `db`, as before.
  const apiDb =
    config.apiDatabaseUrl === config.databaseUrl
      ? db
      : Database.open(config.apiDatabaseUrl, {
          applicationName: "hyperion-api",
          readOnly: true,
          logger,
          slowQueryThresholdMs: 1_000,
        });
  if (apiDb !== db) shutdown.add("postgres-api", () => apiDb.close());
  try {
    await checkSchemaCompatibility(db, config.schemaVersion);
    await checkDatabasePolicy(db, config);
    if (apiDb !== db) {
      await checkSchemaCompatibility(apiDb, config.schemaVersion);
      // The API role is verified as read-only against Postgres privileges, not the label.
      await checkDatabasePolicy(apiDb, { ...config, databaseRole: "read-only" });
    }
  } catch (error) {
    await shutdown.run("startup-failure");
    throw error;
  }

  const redis = config.redisUrl.length > 0 ? createApiRedis(config.redisUrl) : undefined;
  if (redis)
    shutdown.add("redis", async () => {
      await redis.quit();
    });

  // Registered between the pool and the server, because shutdown runs in reverse: the server
  // stops accepting requests, the watchers finish the page they are on, and only then does the
  // pool close under them.
  const indexer = buildIndexer({ config, logger, db, workerPolicy });
  shutdown.add("indexer", () => indexer.stop());

  const server = buildServer({
    get config() {
      return workerPolicy.configuration();
    },
    logger,
    db: apiDb,
    ...(redis ? { redis } : {}),
    readiness: indexer.readiness,
    startedAt,
  });
  // Registered before listen so a failed listen still closes what is already open.
  shutdown.add("http", () => server.close());

  const application: ContinuousApplication = {
    server,
    db,
    workerPolicy,
    stop: (reason = "application-stop") => shutdown.run(reason),
  };
  try {
    await server.listen({ host: config.http.host, port: config.http.port });
  } catch (error) {
    await application.stop("startup-failure");
    throw error;
  }
  // After listen, so the probes are answering before the first page is read. A watcher that
  // starts first makes its initial RPC calls while nothing can report on them.
  if (config.catchUpEnabled) {
    await runBudgetedCatchUp(indexer.workers, config.catchUpBudgetMs, async (reason) => {
      logger.info(
        { reason, executionId: indexer.executionId ?? null },
        "scheduled catch-up stages complete; committed progress retained",
      );
      await shutdown.run(reason);
    });
    return application;
  }
  indexer.start();
  logger.info(
    {
      host: config.http.host,
      port: config.http.port,
      network: config.network,
      executionId: indexer.executionId ?? null,
      deploymentsFile: config.deploymentsFile,
      configDigest: config.configDigest,
      watchingStellar: config.indexer.stellar?.chain ?? null,
      watchingEvm: config.indexer.evm.map((entry) => entry.chain),
      workers: indexer.workers.map((worker) => worker.name),
    },
    "hyperion backend listening",
  );
  return application;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startContinuousApplication();
}
