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
import {
  KeeperSpendingTracker,
  sanitizeSpendDiagnostic,
  type OverrideSpendingCapInput,
  type ResetSpendingCapInput,
  type SignerSpendingSnapshot,
  type SpendingCapAuditEntry,
} from "./spending.js";
import { resolveKeeperSignerPublicKey } from "./stellar.js";

export class KeeperWorker implements ReadinessSource {
  readonly name = "keeper";
  private handle: KeeperHandle | null = null;
  private starting = false;
  private failedError: string | null = null;
  private readonly spendingTracker: KeeperSpendingTracker;

  constructor(
    private readonly config: AppConfig,
    private readonly db: Transactional,
    private readonly logger: Logger,
    spendingTracker?: KeeperSpendingTracker,
  ) {
    this.spendingTracker = spendingTracker ?? new KeeperSpendingTracker(config.keeper.spendingCap);
  }

  spendingDiagnostics(): readonly SignerSpendingSnapshot[] {
    return this.spendingTracker.allSnapshots();
  }

  spendingAuditTrail(signerPublicKey?: string): readonly SpendingCapAuditEntry[] {
    return this.spendingTracker.auditTrail(signerPublicKey);
  }

  resetSpendingCap(input: Omit<ResetSpendingCapInput, "logger">): SpendingCapAuditEntry {
    return this.spendingTracker.resetSignerCap({ ...input, logger: this.logger });
  }

  overrideSpendingCap(input: Omit<OverrideSpendingCapInput, "logger">): SpendingCapAuditEntry {
    return this.spendingTracker.overrideSignerCap({ ...input, logger: this.logger });
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
        detail: `redis connection failure: ${sanitizeSpendDiagnostic(this.failedError)}`,
      };
    }
    const signerPublicKey = resolveKeeperSignerPublicKey(this.config);
    if (signerPublicKey !== null && this.spendingTracker.isPaused(signerPublicKey)) {
      const snap = this.spendingTracker.snapshot(signerPublicKey);
      return {
        name: this.name,
        state: "degraded",
        detail: sanitizeSpendDiagnostic(
          snap.pauseReason ??
            `signer ${signerPublicKey} paused by operational spending cap in ${snap.windowId}`,
        ),
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

    startKeeperQueue(
      {
        db: this.db,
        config: this.config,
        logger: this.logger,
        spendingTracker: this.spendingTracker,
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
        this.failedError = sanitizeSpendDiagnostic(raw);
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
