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
import { KeeperBudgetTracker } from "./budgets.js";
import { startKeeperQueue, type KeeperHandle } from "./queue.js";
import type { BudgetTrackerPort } from "./types.js";

export class KeeperWorker implements ReadinessSource {
  readonly name = "keeper";
  private handle: KeeperHandle | null = null;
  private starting = false;
  private failedError: string | null = null;
  readonly budgetTracker: BudgetTrackerPort;

  constructor(
    private readonly config: AppConfig,
    private readonly db: Transactional,
    private readonly logger: Logger,
    budgetTracker?: BudgetTrackerPort,
  ) {
    this.budgetTracker = budgetTracker ?? new KeeperBudgetTracker(config.keeper.budgets);
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
    const budget = this.budgetTracker.snapshot();
    if (budget.exhausted) {
      return {
        name: this.name,
        state: "degraded",
        detail: `operational fee budget exhausted for current interval (submitted=${budget.submittedStroops}, confirmed=${budget.confirmedStroops}, cap=${budget.maxIntervalFeeStroops} stroops)`,
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
      detail: `active on BullMQ with 2 scheduled Stellar upkeep jobs (submitted=${budget.submittedStroops}, confirmed=${budget.confirmedStroops} stroops)`,
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
        budgetTracker: this.budgetTracker,
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
