import type { AppConfig } from "../config/config.js";
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
    freshnessSlo: config.freshnessSlo,
  });
}

/** Values that identify the deployment and therefore cannot be changed by a reload. */
export function deploymentIdentity(config: AppConfig): string {
  return JSON.stringify(
    {
      network: config.network,
      deploymentsFile: config.deploymentsFile,
      deployments: config.deployments,
      indexer: config.indexer,
    },
    (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
  );
}

export class WorkerPolicyStore {
  private current: WorkerPolicy;
  private readonly identity: string;

  constructor(config: AppConfig) {
    this.current = workerPolicy(config);
    this.identity = deploymentIdentity(config);
  }

  snapshot(): WorkerPolicy {
    return this.current;
  }

  /** Validate first, then publish in one assignment; readers see either whole policy. */
  replace(config: AppConfig): WorkerPolicy {
    if (deploymentIdentity(config) !== this.identity)
      throw new Error(
        "worker policy reload cannot change deployment identity; restart is required",
      );
    const next = workerPolicy(config, this.current.version + 1);
    this.current = next;
    return next;
  }
}
