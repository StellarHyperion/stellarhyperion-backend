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
import { KeeperOutcomeTracker } from "./outcomes.js";
import { startKeeperQueue, type KeeperHandle } from "./queue.js";
import { reconcilePendingStellarSubmissions, type StellarKeeperRpcClient } from "./stellar.js";

export class KeeperWorker implements ReadinessSource {
  readonly name = "keeper";
  private handle: KeeperHandle | null = null;
  private starting = false;
  private failedError: string | null = null;
  private readonly outcomes: KeeperOutcomeTracker;

  constructor(
    private readonly config: AppConfig,
    private readonly db: Transactional,
    private readonly logger: Logger,
    outcomes?: KeeperOutcomeTracker,
  ) {
    this.outcomes = outcomes ?? new KeeperOutcomeTracker(db);
  }

  get outcomeTracker(): KeeperOutcomeTracker {
    return this.outcomes;
  }

  async reconcileOnStartup(rpcClient?: StellarKeeperRpcClient): Promise<void> {
    try {
      const summary = await reconcilePendingStellarSubmissions(
        this.config,
        this.outcomes,
        rpcClient,
      );
      if (summary.confirmed > 0 || summary.failed > 0 || summary.remainingPending > 0) {
        this.logger.info(
          summary,
          "reconciled persisted keeper transaction submissions from previous run",
        );
      }
    } catch (err: unknown) {
      this.logger.warn({ err }, "failed to reconcile pending keeper submissions on startup");
    }
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
        detail: `redis connection failure: ${this.failedError}`,
      };
    }
    if (this.outcomes.pendingCount > 0) {
      return {
        name: this.name,
        state: "degraded",
        detail: `${String(this.outcomes.pendingCount)} submitted keeper transaction(s) remain pending confirmation`,
      };
    }
    if (this.handle === null) {
      return {
        name: this.name,
        state: "degraded",
        detail: this.starting ? "connecting to Redis" : "not started yet",
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

    void this.reconcileOnStartup()
      .then(() =>
        startKeeperQueue(
          { db: this.db, config: this.config, logger: this.logger, outcomes: this.outcomes },
          this.config.redisUrl,
        ),
      )
      .then((handle) => {
        this.handle = handle;
        this.starting = false;
        this.logger.info("keeper BullMQ worker and queue ready");
      })
      .catch((err: unknown) => {
        this.starting = false;
        this.failedError = err instanceof Error ? err.message : String(err);
        this.logger.error({ err }, "failed to start keeper queue");
      });
  }

  async stop(): Promise<void> {
    if (this.handle !== null) {
      await this.handle.close();
      this.handle = null;
    }
  }
}
