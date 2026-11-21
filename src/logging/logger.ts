/**
 * Structured logging, with the fields that make a watcher debuggable and none that leak.
 *
 * Two deliberate choices:
 *
 * `redact` names the paths a connection string could reach rather than trusting every call site
 * to remember. A password in a log aggregator is not recoverable by editing the line that put it
 * there, and the line that puts it there is usually an error handler somebody wrote at speed.
 *
 * A bounded hook sanitizes nested objects and error text and renders bigints as decimal strings.
 * HTTP serializers keep request and response context without walking the server's internals.
 */
import { pino } from "pino";
import type { Bindings, ChildLoggerOptions, DestinationStream, Logger, LoggerOptions } from "pino";

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
  "stellarSecret",
  "params",
  "sqlParams",
  "apiKey",
  "authorization",
  "historicalRpcUrl",
  "rpcUrl",
  "rpcUrls",
  "failedRpc",
  "fallbackRpc",
  "*.stellarSecret",
  "config.keeper.stellarSecret",
  "stellarSecrets",
  "config.keeper.stellarSecrets",
  "*.databaseUrl",
  "*.redisUrl",
  "*.connectionString",
  "*.password",
  "*.params",
  "*.sqlParams",
  "*.apiKey",
  "*.authorization",
  "*.headers.authorization",
  "*.historicalRpcUrl",
  "*.rpcUrl",
  "*.rpcUrls",
  "err.connectionString",
  "config.databaseUrl",
  "config.redisUrl",
];

/** Strip URL userinfo credentials from error messages before logging or persisting diagnostics. */
export function sanitizeDiagnosticText(input: string): string {
  return input
    .replace(/\b(?:https?|postgres(?:ql)?|rediss?):\/\/[^\s"'<>]+/gi, "[redacted URL]")
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [redacted]")
    .replace(
      /\b((?:authorization|password|secret|api[_-]?key|token)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[redacted]",
    )
    .slice(0, 2048);
}

const SAFE_OPERATION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Check if an identifier is a safe operation or run identity. */
export function isSafeOperationIdentifier(input: unknown): input is string {
  return typeof input === "string" && SAFE_OPERATION_ID.test(input);
}

/** Sanitize an operation or run identifier, returning null if unsafe. */
export function sanitizeOperationIdentifier(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const sanitized = sanitizeDiagnosticText(input).trim();
  return SAFE_OPERATION_ID.test(sanitized) ? sanitized : null;
}

export function createLogger(config: AppConfig, destination?: DestinationStream): Logger {
  return protectLoggerBindings(
    pino(
      {
        level: config.logLevel,
        // The service name is on every line because the keeper and the API will run as separate
        // processes against the same aggregator before long.
        base: { service: "hyperion-backend", network: config.network },
        redact: { paths: REDACTED_PATHS, censor: "[redacted]" },
        serializers: SANITIZED_LOG_SERIALIZERS,
        formatters: { bindings: sanitizeLogBindings },
        hooks: SANITIZED_LOG_HOOKS,
        ...(config.nodeEnv === "development" && destination === undefined
          ? {
              transport: {
                target: "pino-pretty",
                options: { translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
              },
            }
          : {}),
      },
      destination,
    ),
  );
}

const SECRET_LOG_KEYS = new Set(
  REDACTED_PATHS.map((path) => (path.split(".").at(-1) ?? path).replace(/[_-]/g, "").toLowerCase()),
);
for (const key of ["token", "secret", "secrets", "cookie", "setcookie"]) SECRET_LOG_KEYS.add(key);
const MAX_LOG_DEPTH = 8;
const MAX_LOG_ENTRIES = 256;

function sensitiveLogKey(key: string): boolean {
  const normalized = key.replace(/[_-]/g, "").toLowerCase();
  return (
    SECRET_LOG_KEYS.has(normalized) ||
    /(?:secret|secrets|password|authorization|apikey|privatekey|mnemonic|seedphrase|accesstoken|refreshtoken)$/.test(
      normalized,
    )
  );
}

/** Keep public URLs usable while removing URL credentials and secret-bearing query strings. */
function sanitizeLogText(input: string): string {
  return input
    .replace(/\b(?:https?|postgres(?:ql)?|rediss?):\/\/[^\s"'<>]+/gi, (url) => {
      try {
        const parsed = new URL(url);
        return parsed.username ||
          parsed.password ||
          [...parsed.searchParams.keys()].some(sensitiveLogKey)
          ? "[redacted URL]"
          : url;
      } catch {
        return "[redacted URL]";
      }
    })
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [redacted]")
    .replace(
      /\b((?:authorization|password|secret|api[_-]?key|token)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[redacted]",
    )
    .slice(0, 2048);
}

interface LogSanitizationState {
  remaining: number;
  readonly seen: WeakSet<object>;
}

/** Bound work and output, avoid getters/toJSON, and never mutate contributor/provider objects. */
function sanitizeLogValue(value: unknown, state: LogSanitizationState, depth = 0): unknown {
  if (state.remaining-- <= 0 || depth > MAX_LOG_DEPTH) return "[redacted: log limit]";
  if (typeof value === "string") return sanitizeLogText(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return "[redacted: unsupported]";
  if (value === null || typeof value !== "object") return value;
  if (state.seen.has(value)) return "[redacted: circular]";
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      const output: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (state.remaining <= 0) {
          output.push("[redacted: log limit]");
          break;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        output.push(
          descriptor && "value" in descriptor
            ? sanitizeLogValue(descriptor.value, state, depth + 1)
            : "[redacted: accessor]",
        );
      }
      return output;
    }
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    if (value instanceof Error) {
      output.type = value.constructor.name;
      output.message = sanitizeLogText(value.message);
      output.stack = typeof value.stack === "string" ? sanitizeLogText(value.stack) : undefined;
      const cause = Object.getOwnPropertyDescriptor(value, "cause");
      if (cause && "value" in cause && cause.value instanceof Error) {
        const sanitizedCause = sanitizeLogValue(cause.value, state, depth + 1);
        if (sanitizedCause && typeof sanitizedCause === "object") {
          const fields = sanitizedCause as Record<string, unknown>;
          if (typeof fields.message === "string")
            output.message = sanitizeLogText(`${String(output.message)}: ${fields.message}`);
          if (typeof fields.stack === "string")
            output.stack = sanitizeLogText(
              `${typeof output.stack === "string" ? output.stack : ""}\ncaused by: ${fields.stack}`,
            );
        }
      }
      if (value instanceof AggregateError)
        output.aggregateErrors = sanitizeLogValue(value.errors, state, depth + 1);
    }
    for (const key in value) {
      if (!Object.hasOwn(value, key) || (key === "cause" && value instanceof Error)) continue;
      if (state.remaining <= 0) {
        output.logTruncated = true;
        break;
      }
      if (sensitiveLogKey(key)) {
        output[key] = "[redacted]";
        state.remaining -= 1;
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      output[key] =
        descriptor && "value" in descriptor
          ? depth === 0 && (key === "req" || key === "res")
            ? descriptor.value
            : sanitizeLogValue(descriptor.value, state, depth + 1)
          : "[redacted: accessor]";
    }
    return output;
  } finally {
    state.seen.delete(value);
  }
}

const SANITIZED_LOG_HOOKS: NonNullable<LoggerOptions["hooks"]> = {
  logMethod(args, method) {
    const state: LogSanitizationState = { remaining: MAX_LOG_ENTRIES, seen: new WeakSet() };
    const sanitized = args.map((value) =>
      typeof value === "string" ? sanitizeLogText(value) : sanitizeLogValue(value, state),
    );
    if (args[0] instanceof Error) sanitized[0] = { err: sanitized[0] };
    method.apply(this, sanitized as Parameters<typeof method>);
  },
};

function sanitizeSerializedLog(value: unknown): unknown {
  return sanitizeLogValue(value, { remaining: MAX_LOG_ENTRIES, seen: new WeakSet() }, 1);
}

function sanitizeLogBindings(value: Record<string, unknown>): Record<string, unknown> {
  const bindings = { ...(sanitizeSerializedLog(value) as Record<string, unknown>) };
  // Pino calls this method directly while writing child bindings.
  Object.defineProperty(bindings, "hasOwnProperty", {
    value: Object.prototype.hasOwnProperty.bind(bindings),
    enumerable: false,
  });
  return bindings;
}

/** Pino deliberately resets the bindings formatter for child loggers. Sanitize before it does. */
interface LoggerBindingMethods {
  readonly child: (...args: never[]) => unknown;
  readonly setBindings: (...args: never[]) => unknown;
}

function protectLoggerBindings<CustomLevels extends string>(
  logger: Logger<CustomLevels>,
  methods?: LoggerBindingMethods,
): Logger<CustomLevels> {
  // Preserve the receiver explicitly with Reflect.apply; descendants reuse the native methods.
  const native = methods ?? {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    child: logger.child,
    // eslint-disable-next-line @typescript-eslint/unbound-method
    setBindings: logger.setBindings,
  };
  logger.child = function <ChildLevels extends string = never>(
    this: Logger<CustomLevels>,
    bindings: Bindings,
    options?: ChildLoggerOptions<ChildLevels>,
  ): Logger<CustomLevels | ChildLevels> {
    const child = Reflect.apply(native.child, this, [
      sanitizeLogBindings(bindings),
      options,
    ]) as Logger<CustomLevels | ChildLevels>;
    return protectLoggerBindings(child, native);
  };
  logger.setBindings = function (this: Logger<CustomLevels>, bindings: Bindings) {
    Reflect.apply(native.setBindings, this, [sanitizeLogBindings(bindings)]);
  };
  return logger;
}

const SANITIZED_LOG_SERIALIZERS: NonNullable<LoggerOptions["serializers"]> = {
  err: (value: unknown) => value,
  req: (
    value: {
      method?: unknown;
      url?: unknown;
      headers?: Record<string, unknown>;
      host?: unknown;
      ip?: unknown;
      socket?: { remotePort?: unknown };
    } | null,
  ) =>
    sanitizeSerializedLog({
      method: value?.method,
      url: value?.url,
      version: value?.headers?.["accept-version"],
      host: value?.host,
      remoteAddress: value?.ip,
      remotePort: value?.socket?.remotePort,
    }),
  res: (value: { statusCode?: unknown } | null) =>
    sanitizeSerializedLog({ statusCode: value?.statusCode }),
};

/** A logger for tests and for the config failure path, where there is no config yet. */
export function createBootLogger(level: string, destination?: DestinationStream): Logger {
  return protectLoggerBindings(
    pino(
      {
        level,
        base: { service: "hyperion-backend" },
        serializers: SANITIZED_LOG_SERIALIZERS,
        formatters: { bindings: sanitizeLogBindings },
        hooks: SANITIZED_LOG_HOOKS,
      },
      destination,
    ),
  );
}
