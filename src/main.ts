/**
 * The process. Reads the environment, opens what it needs, and wires shutdown to the signals.
 *
 * The config failure path deliberately does not go through pino. At the point configuration fails
 * there is no log level, no transport and nothing to attach fields to, and a readable multi line
 * message on stderr is worth more to whoever is staring at a crash loop than a single line of
 * JSON with the whole explanation escaped inside one field.
 */
import { loadConfig } from "./config/config.js";
import { ConfigError } from "./config/env.js";
import { Database } from "./db/pool.js";
import { buildServer } from "./http/server.js";
import { createLogger } from "./logging/logger.js";
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

  const server = buildServer({
    config,
    logger,
    db,
    readiness: [],
    startedAt,
  });
  // Registered before listen so a failed listen still closes what is already open.
  shutdown.add("http", () => server.close());

  await server.listen({ host: config.http.host, port: config.http.port });
  logger.info(
    {
      host: config.http.host,
      port: config.http.port,
      network: config.network,
      deploymentsFile: config.deploymentsFile,
      watchingStellar: config.indexer.stellar?.chain ?? null,
      watchingEvm: config.indexer.evm.map((entry) => entry.chain),
    },
    "hyperion backend listening",
  );
}

await main();
