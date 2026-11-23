import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import type { Logger } from "pino";
import { loadConfig, type AppConfig } from "../config/config.js";
import type { FreshnessSloConfig } from "./freshness.js";

/** Configuration that may change while a process is running. Deployment identity is excluded. */
export interface WorkerPolicy {
  readonly version: number;
  readonly rails: {
    readonly pollIntervalMs: number;
    readonly batchSize: number;
    readonly recheckAfterMs: number;
    readonly maxCheckFailures: number;
  };
  readonly keeper: { readonly pollIntervalMs: number; readonly concurrency: number };
  readonly freshnessSlo: FreshnessSloConfig;
}

export function workerPolicy(config: AppConfig, version = 1): WorkerPolicy {
  const integer = (value: number, min: number, max = Number.MAX_SAFE_INTEGER): void => {
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new Error("worker policy contains an invalid limit");
  };
  integer(version, 1);
  integer(config.rails.pollIntervalMs, 1_000, 2_147_483_647);
  integer(config.rails.batchSize, 1, 200);
  integer(config.rails.recheckAfterMs, 0);
  integer(config.rails.maxCheckFailures, 1);
  integer(config.keeper.concurrency, 1, 10);
  const targets = [config.freshnessSlo.defaults, ...Object.values(config.freshnessSlo.lanes)];
  for (const target of targets) {
    if (target.maxSourceScanLagMs !== undefined) integer(target.maxSourceScanLagMs, 1_000);
    if (target.maxProofBacklogCount !== undefined) integer(target.maxProofBacklogCount, 0);
    if (target.maxProofBacklogAgeMs !== undefined) integer(target.maxProofBacklogAgeMs, 1_000);
  }
  return Object.freeze({
    version,
    rails: Object.freeze({
      pollIntervalMs: config.rails.pollIntervalMs,
      batchSize: config.rails.batchSize,
      recheckAfterMs: config.rails.recheckAfterMs,
      maxCheckFailures: config.rails.maxCheckFailures,
    }),
    keeper: Object.freeze({
      pollIntervalMs: config.keeper.pollIntervalMs,
      concurrency: config.keeper.concurrency,
    }),
    freshnessSlo: Object.freeze({
      defaults: Object.freeze({ ...config.freshnessSlo.defaults }),
      lanes: Object.freeze(
        Object.fromEntries(
          Object.entries(config.freshnessSlo.lanes).map(([lane, target]) => [
            lane,
            Object.freeze({ ...target }),
          ]),
        ),
      ),
    }),
  });
}

/** Values that identify the deployment and therefore cannot be changed by a reload. */
export function deploymentIdentity(config: AppConfig): string {
  // Everything except the explicit allowlist needs a controlled restart, including
  // credentials, destination RPCs, provider endpoints and keeper repeat schedules.
  const protectedConfig = {
    ...config,
    rails: {
      enabled: config.rails.enabled,
      irisUrl: config.rails.irisUrl,
      axelarUrl: config.rails.axelarUrl,
    },
    keeper: { ...config.keeper, concurrency: undefined },
    freshnessSlo: undefined,
    configDigest: undefined,
    configProvenance: undefined,
  };
  return createHash("sha256")
    .update(
      JSON.stringify(protectedConfig, (_key, value: unknown) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    )
    .digest("hex");
}

export class WorkerPolicyStore {
  private current: { readonly policy: WorkerPolicy; readonly config: AppConfig };
  private readonly identity: string;
  private readonly context = new AsyncLocalStorage<typeof this.current>();
  private readonly listeners = new Set<(policy: WorkerPolicy) => void>();

  constructor(config: AppConfig) {
    this.current = this.bundle(config, workerPolicy(config));
    this.identity = deploymentIdentity(config);
  }

  snapshot(): WorkerPolicy {
    return (this.context.getStore() ?? this.current).policy;
  }

  configuration(): AppConfig {
    return (this.context.getStore() ?? this.current).config;
  }

  /** Each pass/job keeps one immutable policy through every asynchronous continuation. */
  run<T>(work: () => T): T {
    return this.context.getStore() === undefined ? this.context.run(this.current, work) : work();
  }

  subscribe(listener: (policy: WorkerPolicy) => void): () => void {
    listener(this.current.policy);
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private bundle(config: AppConfig, policy: WorkerPolicy): typeof this.current {
    return {
      policy,
      config: Object.freeze({
        ...config,
        rails: Object.freeze({ ...config.rails, ...policy.rails }),
        keeper: Object.freeze({ ...config.keeper, ...policy.keeper }),
        freshnessSlo: policy.freshnessSlo,
      }),
    };
  }

  /** Validate first, then publish in one assignment; readers see either whole policy. */
  replace(config: AppConfig): WorkerPolicy {
    if (deploymentIdentity(config) !== this.identity)
      throw new Error(
        "worker policy reload cannot change deployment identity; restart is required",
      );
    const next = workerPolicy(config, this.current.policy.version + 1);
    const bundle = this.bundle(config, next);
    // Listeners only change local scheduling/concurrency synchronously. Validation
    // finishes first; publication and callbacks share one event-loop boundary.
    try {
      for (const listener of this.listeners) listener(next);
    } catch {
      for (const listener of this.listeners) {
        try {
          listener(this.current.policy);
        } catch {
          /* Keep the last admitted snapshot. */
        }
      }
      throw new Error("worker policy update could not be applied");
    }
    this.current = bundle;
    return next;
  }
}

export function reloadWorkerPolicy(
  store: WorkerPolicyStore,
  load: () => AppConfig,
  logger: Pick<Logger, "info" | "warn">,
): void {
  try {
    const next = store.replace(load());
    logger.info({ policyVersion: next.version }, "validated worker policy reloaded");
  } catch {
    logger.warn(
      { reason: "invalid_policy_or_restart_required" },
      "worker policy reload rejected; previous policy remains active",
    );
  }
}

/** Optional local policy file allows operators to reload without changing process credentials. */
export function loadWorkerPolicyConfig(
  file: string | null,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AppConfig {
  if (file === null) return loadConfig({ env: environment });
  const buffer = Buffer.alloc(16_385);
  let count = 0;
  let descriptor: number | undefined;
  let decoded: unknown;
  try {
    descriptor = openSync(file, "r");
    while (count < buffer.length) {
      const read = readSync(descriptor, buffer, count, buffer.length - count, null);
      if (read === 0) break;
      count += read;
    }
    if (count > 16_384) throw new Error("policy file exceeds its size limit");
    decoded = JSON.parse(buffer.subarray(0, count).toString("utf8"));
  } catch {
    throw new Error("worker policy file is unreadable, malformed or too large");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded))
    throw new Error("worker policy file must contain a settings object");
  const allowed = new Set([
    "RAIL_POLL_INTERVAL_MS",
    "RAIL_BATCH_SIZE",
    "RAIL_RECHECK_AFTER_MS",
    "RAIL_MAX_CHECK_FAILURES",
    "KEEPER_CONCURRENCY",
    "FRESHNESS_MAX_SCAN_LAG_MS",
    "FRESHNESS_MAX_PROOF_BACKLOG_COUNT",
    "FRESHNESS_MAX_PROOF_BACKLOG_AGE_MS",
    "FRESHNESS_LANE_TARGETS",
  ]);
  const overrides: Record<string, string> = {};
  for (const [name, value] of Object.entries(decoded)) {
    if (!allowed.has(name))
      throw new Error("worker policy file contains a restart-only or unknown setting");
    if (name === "FRESHNESS_LANE_TARGETS") {
      if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new Error("worker policy file contains invalid lane targets");
      for (const [lane, target] of Object.entries(value as Record<string, unknown>)) {
        if (
          !/^[A-Za-z0-9:_-]{1,128}$/.test(lane) ||
          target === null ||
          typeof target !== "object" ||
          Array.isArray(target)
        )
          throw new Error("worker policy file contains invalid lane targets");
        for (const [key, limit] of Object.entries(target)) {
          if (
            !["maxSourceScanLagMs", "maxProofBacklogCount", "maxProofBacklogAgeMs"].includes(key) ||
            typeof limit !== "number" ||
            !Number.isSafeInteger(limit)
          )
            throw new Error("worker policy file contains invalid lane targets");
        }
      }
      overrides[name] = JSON.stringify(value);
    } else {
      if (typeof value !== "number" || !Number.isSafeInteger(value))
        throw new Error("worker policy file limits must be integers");
      overrides[name] = String(value);
    }
  }
  return loadConfig({ env: { ...environment, ...overrides } });
}
