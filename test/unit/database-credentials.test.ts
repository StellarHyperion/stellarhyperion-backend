import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  MIGRATION_CONNECTION_VAR,
  migrationEnvironment,
  resolveMigrationConnection,
} from "../../bin/migrate.mjs";
import { loadConfig } from "../../src/config/config.js";
import { ConfigError } from "../../src/config/env.js";
import { sanitizeDiagnosticsConfig } from "../../src/diagnostics/bundle.js";
import { createLogger } from "../../src/logging/logger.js";
import { completeEnv } from "../helpers.js";

const WRITER = "postgres://hyperion_writer:writer-secret-1@127.0.0.1:5433/hyperion";
const API = "postgres://hyperion_api:api-secret-2@127.0.0.1:5433/hyperion";
const MIGRATOR = "postgres://hyperion_owner:owner-secret-3@127.0.0.1:5433/hyperion";
const SECRETS = ["writer-secret-1", "api-secret-2", "owner-secret-3"];

const API_ONLY = {
  INDEXER_ENABLED: "false",
  RAILS_ENABLED: "false",
  KEEPER_ENABLED: "false",
};

function configError(run: () => unknown): ConfigError {
  try {
    run();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("expected a ConfigError and got none");
}

function expectNoSecrets(text: string): void {
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

describe("separate database credentials", () => {
  it("starts an API-only process with only the read-only API credential", () => {
    const env = completeEnv({ ...API_ONLY, API_DATABASE_URL: API });
    delete env.DATABASE_URL;
    const config = loadConfig({ env });
    expect(config.databaseRole).toBe("read-only");
    expect(config.apiDatabaseUrl).toBe(API);
    // The process never holds a writer credential it did not need.
    expect(config.databaseUrl).toBe(API);
  });

  it("ignores the writer credential in an API-only process when both are present", () => {
    const config = loadConfig({
      env: completeEnv({ ...API_ONLY, DATABASE_URL: WRITER, API_DATABASE_URL: API }),
    });
    expect(config.databaseUrl).toBe(API);
    expect(config.apiDatabaseUrl).toBe(API);
  });

  it("gives a writer process separate worker and API connections", () => {
    const config = loadConfig({
      env: completeEnv({ DATABASE_URL: WRITER, API_DATABASE_URL: API }),
    });
    expect(config.indexer.enabled).toBe(true);
    expect(config.databaseRole).toBe("read-write");
    expect(config.databaseUrl).toBe(WRITER);
    expect(config.apiDatabaseUrl).toBe(API);
  });

  it("keeps the shared legacy connection when no API credential is configured", () => {
    const config = loadConfig({ env: completeEnv({ DATABASE_URL: WRITER }) });
    expect(config.apiDatabaseUrl).toBe(config.databaseUrl);
  });

  it("refuses an API credential that is the writer credential while writers run", () => {
    const error = configError(() =>
      loadConfig({ env: completeEnv({ DATABASE_URL: WRITER, API_DATABASE_URL: WRITER }) }),
    );
    expect(error.faults.map((fault) => fault.name)).toEqual(["API_DATABASE_URL"]);
    expectNoSecrets(error.message);
  });

  it("still requires the writer credential when writers are enabled", () => {
    const env = completeEnv({ API_DATABASE_URL: API });
    delete env.DATABASE_URL;
    const error = configError(() => loadConfig({ env }));
    expect(error.faults.map((fault) => fault.name)).toContain("DATABASE_URL");
    expectNoSecrets(error.message);
  });

  it("never prints a malformed credential", () => {
    const error = configError(() =>
      loadConfig({
        env: completeEnv({ API_DATABASE_URL: "mysql://hyperion_api:api-secret-2@db/hyperion" }),
      }),
    );
    expect(error.faults.map((fault) => fault.name)).toEqual(["API_DATABASE_URL"]);
    expectNoSecrets(error.message);
  });

  it("redacts every credential from logs and diagnostics", () => {
    const config = loadConfig({
      env: completeEnv({ DATABASE_URL: WRITER, API_DATABASE_URL: API, LOG_LEVEL: "info" }),
    });
    let serialized = "";
    const destination = new Writable({
      write(chunk: Buffer, _encoding, done) {
        serialized += chunk.toString();
        done();
      },
    });
    const logger = createLogger(config, destination);
    logger.info({ config, apiDatabaseUrl: API, migrationDatabaseUrl: MIGRATOR }, "startup");
    expect(serialized).toContain("startup");
    expectNoSecrets(serialized);

    const diagnostics = JSON.stringify(sanitizeDiagnosticsConfig(config));
    expectNoSecrets(diagnostics);
    expect(sanitizeDiagnosticsConfig(config).separateApiDatabase).toBe(true);
  });
});

describe("migration credential", () => {
  it("prefers MIGRATION_DATABASE_URL and falls back to DATABASE_URL", () => {
    expect(
      resolveMigrationConnection({ MIGRATION_DATABASE_URL: MIGRATOR, DATABASE_URL: WRITER }),
    ).toEqual({ url: MIGRATOR, source: "MIGRATION_DATABASE_URL" });
    expect(
      resolveMigrationConnection({ DATABASE_URL: WRITER, MIGRATION_DATABASE_URL: " " }),
    ).toEqual({ url: WRITER, source: "DATABASE_URL" });
  });

  it("refuses to migrate without a credential or through the API credential", () => {
    expect(() => resolveMigrationConnection({ API_DATABASE_URL: API })).toThrow(
      /MIGRATION_DATABASE_URL/,
    );
    for (const env of [
      { MIGRATION_DATABASE_URL: API, API_DATABASE_URL: API },
      { DATABASE_URL: API, API_DATABASE_URL: API },
    ]) {
      let message = "";
      try {
        resolveMigrationConnection(env);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/API_DATABASE_URL/);
      expectNoSecrets(message);
    }
  });

  it("hands the credential to node-pg-migrate by private variable, not argv", () => {
    const env = migrationEnvironment({ PATH: "x" }, MIGRATOR);
    expect(env[MIGRATION_CONNECTION_VAR]).toBe(MIGRATOR);
    expect(env.PATH).toBe("x");
  });
});
