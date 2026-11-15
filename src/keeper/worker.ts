/**
 * Worker implementation for the keeper, integrating with the runner lifecycle.
 *
 * Exposes start, stop and readiness so `main.ts` and `runner.ts` treat the keeper identically
 * to chain watchers and rail pollers.
 */
import type { Logger } from "pino";

import type { AppConfig } from "../config/config.js";
import type { Transactional } from "../db/pool.js";
import type { ReadinessReport, ReadinessSource } from "../runtime/readiness.js";
import { startKeeperQueue, type KeeperHandle } from "./queue.js";
import { KeeperRecoveryLedger, type KeeperRecoveryDecision } from "./recovery.js";
import { sanitizeKeeperText, type KeeperTxLookupClient } from "./stellar.js";

export class KeeperWorker implements ReadinessSource {
  readonly name = "keeper";
  private handle: KeeperHandle | null = null;
  private starting = false;
  private failedError: string | null = null;
  private readonly recoveryLedger: KeeperRecoveryLedger;

  constructor(
    private readonly config: AppConfig,
    private readonly db: Transactional,
    private readonly logger: Logger,
    recoveryLedger?: KeeperRecoveryLedger,
  ) {
    this.recoveryLedger =
      recoveryLedger ?? new KeeperRecoveryLedger(config.keeper.retention.maxCompletedJobs * 4);
  }

  getRecoveryLedger(): KeeperRecoveryLedger {
    return this.recoveryLedger;
  }

  async recoverFailedJob(
    jobId: string,
    options?: { readonly lookupClient?: KeeperTxLookupClient },
  ): Promise<KeeperRecoveryDecision> {
    if (this.handle === null) {
      throw new Error("Keeper queue is not active.");
    }
    return this.handle.recoverFailedJob(jobId, options);
  }

  readiness(): ReadinessReport {
    if (!this.config.keeper.enabled) {
      return {
        name: this.name,
        state: "ready",
        detail: "disabled by configuration, so no automated upkeep tasks run on this replica",
      };
    }
    if (this.failedError !== null) {
      return {
        name: this.name,
        state: "degraded",
        detail: `redis connection failure: ${sanitizeKeeperText(this.failedError)}`,
      };
    }
    if (this.handle === null) {
      return {
        name: this.name,
        state: "degraded",
        detail: this.starting ? "connecting to Redis" : "not started yet",
      };
    }
    const uncertainCount = this.recoveryLedger
      .allFailedJobEvidence()
      .filter((ev) => ev.uncertain && ev.pendingSubmissions.length > 0).length;
    if (uncertainCount > 0) {
      return {
        name: this.name,
        state: "degraded",
        detail: `${String(uncertainCount)} failed keeper job(s) awaiting uncertain transaction reconciliation`,
      };
    }
    return {
      name: this.name,
      state: "ready",
      detail: "active on BullMQ with 2 scheduled Stellar upkeep jobs",
    };
  }

  start(): void {
    if (!this.config.keeper.enabled || this.handle !== null || this.starting) return;
    this.starting = true;

    startKeeperQueue(
      {
        db: this.db,
        config: this.config,
        logger: this.logger,
        recoveryLedger: this.recoveryLedger,
      },
      this.config.redisUrl,
    )
      .then((handle) => {
        this.handle = handle;
        this.starting = false;
        this.logger.info("keeper BullMQ worker and queue ready");
      })
      .catch((err: unknown) => {
        this.starting = false;
        const raw = err instanceof Error ? err.message : String(err);
        this.failedError = sanitizeKeeperText(raw);
        this.logger.error({ reason: this.failedError }, "failed to start keeper queue");
      });
  }

  async stop(): Promise<void> {
    if (this.handle !== null) {
      await this.handle.close();
      this.handle = null;
    }
  }
}
