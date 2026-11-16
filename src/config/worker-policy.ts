/**
 * Atomic, validated hot reload for nonsecret worker concurrency, scheduling and freshness limits.
 *
 * Two invariants govern runtime policy reloads:
 *
 * 1. Deployment trust boundaries never hot-reload. Router addresses, start heights, chain IDs,
 *    reorg wind-back depths, RPC/Iris/Axelar provider origins, enabled worker roles, bind sockets,
 *    database/Redis URLs and keeper signing keys are fixed for the lifetime of the process and
 *    require a controlled restart or migration.
 *
 * 2. Policy snapshots advance atomically at tick and job boundaries. An in-flight watcher pass or
 *    keeper job captures `current()` once when it begins and runs to completion under that exact
 *    `version`, picking up a reloaded snapshot only on subsequent passes. Invalid reloads leave
 *    the previous valid snapshot and version untouched.
 */
import type { Logger } from "pino";

import type { AppConfig, LoadOptions, WorkerPolicyValues } from "./config.js";
import { RELOADABLE_WORKER_POLICY_VARS, envSuffixFor, loadConfig } from "./config.js";
import { ConfigError, type ConfigFault } from "./env.js";

export type { WorkerPolicyValues };

export interface WorkerPolicySnapshot {
  readonly version: number;
  readonly appliedAt: Date;
  readonly values: WorkerPolicyValues;
}

export interface WorkerPolicyReloadResult {
  readonly changed: boolean;
  readonly snapshot: WorkerPolicySnapshot;
  readonly changedFields: readonly (keyof WorkerPolicyValues)[];
}

export type PolicyReloadErrorCode =
  "invalid_policy_values" | "trust_boundary_change_requires_restart";

export class PolicyReloadError extends Error {
  readonly code: PolicyReloadErrorCode;
  readonly activeVersion: number;
  readonly faults: readonly ConfigFault[];
  readonly changedTrustFields: readonly string[];

  constructor(options: {
    readonly code: PolicyReloadErrorCode;
    readonly activeVersion: number;
    readonly message: string;
    readonly faults?: readonly ConfigFault[];
    readonly changedTrustFields?: readonly string[];
  }) {
    super(options.message);
    this.name = "PolicyReloadError";
    this.code = options.code;
    this.activeVersion = options.activeVersion;
    this.faults = options.faults ?? [];
    this.changedTrustFields = options.changedTrustFields ?? [];
  }
}

export interface WorkerPolicyReader {
  current(): WorkerPolicySnapshot;
  subscribe(listener: (snapshot: WorkerPolicySnapshot) => void): () => void;
}

export interface WorkerPolicyStore extends WorkerPolicyReader {
  reload(options?: LoadOptions): WorkerPolicyReloadResult;
}

export interface WorkerPolicyStoreOptions {
  readonly initialOptions?: LoadOptions;
  readonly now?: () => Date;
}

interface DeploymentTrustBoundary {
  readonly nodeEnv: AppConfig["nodeEnv"];
  readonly logLevel: AppConfig["logLevel"];
  readonly httpHost: string;
  readonly httpPort: number;
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly keeperStellarSecret: string | null;
  readonly network: AppConfig["network"];
  readonly deploymentsFile: string;
  readonly workerPolicyFile: string | null;
  readonly deploymentsCanonical: string;
  readonly indexerEnabled: boolean;
  readonly railsEnabled: boolean;
  readonly keeperEnabled: boolean;
  readonly irisUrl: string;
  readonly axelarUrl: string;
  readonly stellar: {
    readonly chain: string;
    readonly rpcUrl: string;
    readonly networkPassphrase: string;
    readonly routerContractId: string;
    readonly startLedger: number;
  } | null;
  readonly evm: readonly {
    readonly chain: string;
    readonly envSuffix: string;
    readonly chainId: number;
    readonly rpcUrls: readonly string[];
    readonly routerAddress: string;
    readonly startBlock: string;
    readonly confirmations: number;
    readonly reorgDepth: number;
  }[];
}

const POLICY_VALUE_KEYS: readonly (keyof WorkerPolicyValues)[] = [
  "stellarPollIntervalMs",
  "stellarPageSize",
  "stellarFreshWithinLedgers",
  "evmPollIntervalMs",
  "evmLogRange",
  "evmFreshWithinBlocks",
  "railPollIntervalMs",
  "railBatchSize",
  "railRecheckAfterMs",
  "railMaxCheckFailures",
  "railFreshBacklogMultiple",
  "keeperPollIntervalMs",
  "keeperConcurrency",
  "shutdownTimeoutMs",
];

export function createWorkerPolicyStore(
  initialConfig: AppConfig,
  storeOptions: WorkerPolicyStoreOptions = {},
): WorkerPolicyStore {
  const now = storeOptions.now ?? (() => new Date());
  const baseline = captureTrustBoundary(initialConfig);
  const initialEnv = storeOptions.initialOptions?.env;

  let snapshot: WorkerPolicySnapshot = Object.freeze({
    version: 1,
    appliedAt: now(),
    values: Object.freeze({ ...initialConfig.workerPolicy }),
  });

  const listeners = new Set<(next: WorkerPolicySnapshot) => void>();

  return {
    current(): WorkerPolicySnapshot {
      return snapshot;
    },

    subscribe(listener: (next: WorkerPolicySnapshot) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    reload(options: LoadOptions = {}): WorkerPolicyReloadResult {
      const mergedOptions: LoadOptions = {
        ...(options.env !== undefined
          ? { env: options.env }
          : storeOptions.initialOptions?.env !== undefined
            ? { env: storeOptions.initialOptions.env }
            : {}),
        ...(options.readFile !== undefined
          ? { readFile: options.readFile }
          : storeOptions.initialOptions?.readFile !== undefined
            ? { readFile: storeOptions.initialOptions.readFile }
            : {}),
        ...(options.cwd !== undefined
          ? { cwd: options.cwd }
          : storeOptions.initialOptions?.cwd !== undefined
            ? { cwd: storeOptions.initialOptions.cwd }
            : {}),
      };

      let candidate: AppConfig;
      try {
        candidate = loadConfig(mergedOptions);
      } catch (error) {
        if (error instanceof ConfigError) {
          const forbiddenOverlayFields = extractForbiddenOverlayFields(error.faults);
          if (forbiddenOverlayFields.length > 0) {
            throw new PolicyReloadError({
              code: "trust_boundary_change_requires_restart",
              activeVersion: snapshot.version,
              faults: error.faults,
              changedTrustFields: forbiddenOverlayFields,
              message:
                `worker policy reload rejected (active policy version ${String(snapshot.version)} preserved): ` +
                `trust-boundary or non-reloadable settings (${forbiddenOverlayFields.join(", ")}) require a controlled restart or migration`,
            });
          }
          throw new PolicyReloadError({
            code: "invalid_policy_values",
            activeVersion: snapshot.version,
            faults: error.faults,
            message:
              `worker policy reload rejected (active policy version ${String(snapshot.version)} preserved): ` +
              error.faults.map((fault) => `${fault.name}: ${fault.problem}`).join("; "),
          });
        }
        throw error;
      }

      const changedTrustFields = diffTrustBoundaries(
        baseline,
        captureTrustBoundary(candidate),
        initialEnv,
        options.env,
      );
      if (changedTrustFields.length > 0) {
        throw new PolicyReloadError({
          code: "trust_boundary_change_requires_restart",
          activeVersion: snapshot.version,
          changedTrustFields,
          message:
            `worker policy reload rejected (active policy version ${String(snapshot.version)} preserved): ` +
            `deployment, router, provider or credential changes (${changedTrustFields.join(", ")}) require a controlled restart or migration`,
        });
      }

      const changedFields = POLICY_VALUE_KEYS.filter(
        (key) => snapshot.values[key] !== candidate.workerPolicy[key],
      );
      if (changedFields.length === 0) {
        return {
          changed: false,
          snapshot,
          changedFields: [],
        };
      }

      const nextSnapshot: WorkerPolicySnapshot = Object.freeze({
        version: snapshot.version + 1,
        appliedAt: now(),
        values: Object.freeze({ ...candidate.workerPolicy }),
      });
      snapshot = nextSnapshot;

      for (const listener of listeners) {
        listener(nextSnapshot);
      }

      return {
        changed: true,
        snapshot: nextSnapshot,
        changedFields,
      };
    },
  };
}

/**
 * Wire `SIGHUP` to reload nonsecret worker policy without taking down the process on bad input.
 */
export function installPolicyReloadSignal(
  policyStore: WorkerPolicyStore,
  logger: Logger,
  getOptions: () => LoadOptions,
): () => void {
  const onHangup = (): void => {
    try {
      const result = policyStore.reload(getOptions());
      logger.info(
        {
          policyVersion: result.snapshot.version,
          changed: result.changed,
          changedFields: result.changedFields,
        },
        result.changed
          ? "worker policy reloaded for subsequent ticks and jobs"
          : "worker policy reload checked; no policy changes detected",
      );
    } catch (error) {
      if (error instanceof PolicyReloadError) {
        logger.warn(
          {
            code: error.code,
            activePolicyVersion: error.activeVersion,
            changedTrustFields: error.changedTrustFields,
            faultVariables: error.faults.map((fault) => fault.name),
            reason: error.message,
          },
          "worker policy reload rejected; previous policy remains active",
        );
        return;
      }
      logger.error({ err: error }, "unexpected failure during worker policy reload");
    }
  };

  process.on("SIGHUP", onHangup);
  return () => {
    process.removeListener("SIGHUP", onHangup);
  };
}

function captureTrustBoundary(config: AppConfig): DeploymentTrustBoundary {
  return {
    nodeEnv: config.nodeEnv,
    logLevel: config.logLevel,
    httpHost: config.http.host,
    httpPort: config.http.port,
    databaseUrl: config.databaseUrl,
    redisUrl: config.redisUrl,
    keeperStellarSecret: config.keeper.stellarSecret,
    network: config.network,
    deploymentsFile: config.deploymentsFile,
    workerPolicyFile: config.workerPolicyFile,
    deploymentsCanonical: canonicalJson(config.deployments),
    indexerEnabled: config.indexer.enabled,
    railsEnabled: config.rails.enabled,
    keeperEnabled: config.keeper.enabled,
    irisUrl: config.rails.irisUrl,
    axelarUrl: config.rails.axelarUrl,
    stellar:
      config.indexer.stellar === null
        ? null
        : {
            chain: config.indexer.stellar.chain,
            rpcUrl: config.indexer.stellar.rpcUrl,
            networkPassphrase: config.indexer.stellar.networkPassphrase,
            routerContractId: config.indexer.stellar.routerContractId,
            startLedger: config.indexer.stellar.startLedger,
          },
    evm: config.indexer.evm.map((entry) => ({
      chain: entry.chain,
      envSuffix: envSuffixFor(entry.chain),
      chainId: entry.chainId,
      rpcUrls: [...entry.rpcUrls],
      routerAddress: entry.routerAddress,
      startBlock: entry.startBlock.toString(),
      confirmations: entry.confirmations,
      reorgDepth: entry.reorgDepth,
    })),
  };
}

function diffTrustBoundaries(
  before: DeploymentTrustBoundary,
  after: DeploymentTrustBoundary,
  beforeEnv: Readonly<Record<string, string | undefined>> | undefined,
  afterEnv: Readonly<Record<string, string | undefined>> | undefined,
): string[] {
  const changed = new Set<string>();

  if (before.nodeEnv !== after.nodeEnv) changed.add("NODE_ENV");
  if (before.logLevel !== after.logLevel) changed.add("LOG_LEVEL");
  if (before.httpHost !== after.httpHost) changed.add("HTTP_HOST");
  if (before.httpPort !== after.httpPort) changed.add("HTTP_PORT");
  if (before.databaseUrl !== after.databaseUrl) changed.add("DATABASE_URL");
  if (before.redisUrl !== after.redisUrl) changed.add("REDIS_URL");
  if (before.keeperStellarSecret !== after.keeperStellarSecret) {
    changed.add("KEEPER_STELLAR_SECRET");
  }
  if (before.network !== after.network) changed.add("HYPERION_NETWORK");
  if (before.deploymentsFile !== after.deploymentsFile) {
    changed.add("HYPERION_DEPLOYMENTS_FILE");
  }
  if (before.workerPolicyFile !== after.workerPolicyFile) {
    changed.add("WORKER_POLICY_FILE");
  }
  if (before.deploymentsCanonical !== after.deploymentsCanonical) {
    changed.add("HYPERION_DEPLOYMENTS_FILE");
  }
  if (before.indexerEnabled !== after.indexerEnabled) changed.add("INDEXER_ENABLED");
  if (before.railsEnabled !== after.railsEnabled) changed.add("RAILS_ENABLED");
  if (before.keeperEnabled !== after.keeperEnabled) changed.add("KEEPER_ENABLED");
  if (before.irisUrl !== after.irisUrl) changed.add("IRIS_API_URL");
  if (before.axelarUrl !== after.axelarUrl) changed.add("AXELAR_API_URL");

  if (before.stellar === null || after.stellar === null) {
    if (before.stellar !== after.stellar) changed.add("HYPERION_DEPLOYMENTS_FILE");
  } else {
    if (before.stellar.rpcUrl !== after.stellar.rpcUrl) changed.add("STELLAR_RPC_URL");
    if (before.stellar.startLedger !== after.stellar.startLedger) {
      changed.add("STELLAR_START_LEDGER");
    }
    if (
      before.stellar.routerContractId !== after.stellar.routerContractId ||
      before.stellar.networkPassphrase !== after.stellar.networkPassphrase ||
      before.stellar.chain !== after.stellar.chain
    ) {
      changed.add("HYPERION_DEPLOYMENTS_FILE");
    }
  }

  if (before.evm.length !== after.evm.length) {
    changed.add("HYPERION_DEPLOYMENTS_FILE");
  } else {
    for (let i = 0; i < before.evm.length; i += 1) {
      const prev = before.evm[i];
      const next = after.evm[i];
      if (!prev || !next) continue;
      if (
        prev.chain !== next.chain ||
        prev.chainId !== next.chainId ||
        prev.routerAddress !== next.routerAddress ||
        prev.startBlock !== next.startBlock ||
        prev.confirmations !== next.confirmations
      ) {
        changed.add("HYPERION_DEPLOYMENTS_FILE");
      }
      if (!sameStringList(prev.rpcUrls, next.rpcUrls)) {
        changed.add(`EVM_RPC_URL_${prev.envSuffix}`);
      }
      if (prev.reorgDepth !== next.reorgDepth) {
        changed.add("EVM_REORG_DEPTH_BLOCKS");
      }
    }
  }

  // Catch provider or start-height overrides even for chains without a router in the active record.
  if (beforeEnv !== undefined && afterEnv !== undefined) {
    const keys = new Set([...Object.keys(beforeEnv), ...Object.keys(afterEnv)]);
    for (const key of keys) {
      if (RELOADABLE_WORKER_POLICY_VARS.has(key)) continue;
      const left = normalizeEnvValue(beforeEnv[key]);
      const right = normalizeEnvValue(afterEnv[key]);
      if (left !== right) {
        changed.add(key);
      }
    }
  }

  return [...changed].sort((a, b) => a.localeCompare(b));
}

function extractForbiddenOverlayFields(faults: readonly ConfigFault[]): string[] {
  const prefix = "names non-reloadable or trust-boundary settings (";
  for (const fault of faults) {
    if (fault.name === "WORKER_POLICY_FILE" && fault.problem.startsWith(prefix)) {
      const closing = fault.problem.indexOf(")", prefix.length);
      if (closing > prefix.length) {
        return fault.problem
          .slice(prefix.length, closing)
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item.length > 0);
      }
    }
  }
  return [];
}

function normalizeEnvValue(value: string | undefined): string {
  return value?.trim() ?? "";
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
}
