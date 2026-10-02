/**
 * Structured logging, with the fields that make a watcher debuggable and none that leak.
 *
 * Two deliberate choices:
 *
 * `redact` names the paths a connection string could reach rather than trusting every call site
 * to remember. A password in a log aggregator is not recoverable by editing the line that put it
 * there, and the line that puts it there is usually an error handler somebody wrote at speed.
 *
 * `serializers` turns a `bigint` into a decimal string. pino's JSON serialiser throws on a
 * bigint, and a block height, a ledger sequence and every amount in this process are bigints, so
 * without this the first log line about a real transfer takes the process down.
 */
import { pino, stdSerializers } from "pino";
import type { Logger } from "pino";

import type { AppConfig } from "../config/config.js";

export type { Logger };

/**
 * Paths that must never be printed.
 *
 * `databaseUrl` and `redisUrl` carry passwords. The rest are the names an error object from pg or
 * from a fetch tends to attach a URL to, which is the path a credential takes into a log without
 * anybody writing it there on purpose.
 */
const REDACTED_PATHS = [
  "databaseUrl",
  "redisUrl",
  "connectionString",
  "password",
  "*.databaseUrl",
  "*.redisUrl",
  "*.connectionString",
  "*.password",
  "err.connectionString",
  "config.databaseUrl",
  "config.redisUrl",
];

export function createLogger(config: AppConfig): Logger {
  return pino({
    level: config.logLevel,
    // The service name is on every line because the keeper and the API will run as separate
    // processes against the same aggregator before long.
    base: { service: "hyperion-backend", network: config.network },
    redact: { paths: REDACTED_PATHS, censor: "[redacted]" },
    serializers: {
      err: stdSerializers.err,
    },
    hooks: {
      // Applied to every object logged, at every level, including the ones pino builds itself on
      // an error path. A per call site conversion would be forgotten exactly once.
      logMethod(args, method) {
        if (args.length > 0 && typeof args[0] === "object" && args[0] !== null) {
          args[0] = stringifyBigints(args[0] as Record<string, unknown>);
        }
        method.apply(this, args);
      },
    },
    ...(config.nodeEnv === "development"
      ? {
          transport: {
            target: "pino-pretty",
            options: { translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
          },
        }
      : {}),
  });
}

/**
 * A shallow copy with bigints rendered as decimal strings.
 *
 * Shallow on purpose. A deep walk on every log line is a cost paid on the hot path for a nesting
 * depth this codebase does not use: everything logged here is a flat bag of heights, counts and
 * chain keys.
 */
function stringifyBigints(value: Record<string, unknown>): Record<string, unknown> {
  let copied: Record<string, unknown> | null = null;
  for (const key of Object.keys(value)) {
    const entry = value[key];
    if (typeof entry === "bigint") {
      copied ??= { ...value };
      copied[key] = entry.toString();
    }
  }
  return copied ?? value;
}

/** A logger for tests and for the config failure path, where there is no config yet. */
export function createBootLogger(level: string): Logger {
  return pino({ level, base: { service: "hyperion-backend" } });
}
