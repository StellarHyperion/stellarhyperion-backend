/**
 * Worker implementation for the keeper, integrating with the runner lifecycle.
 *
 * Exposes start, stop, dry-run previewing, and readiness so `main.ts` and `runner.ts`
 * treat the keeper identically to chain watchers and rail pollers.
 */
import type { Logger } from "pino";

import type { AppConfig } from "../config/config.js";
import type { Transactional } from "../db/pool.js";
import type { ReadinessReport, ReadinessSource } from "../runtime/readiness.js";
import { processClaimSettlement } from "./jobs/claims.js";
import { processTtlBump } from "./jobs/ttl.js";
import { startKeeperQueue, type KeeperHandle } from "./queue.js";
import { sanitizePublicPreviewText, type KeeperSimulationClient } from "./stellar.js";
import type {
  ClaimSettlementPayload,
  KeeperJobName,
  KeeperJobResult,
  TtlBumpPayload,
} from "./types.js";

export class KeeperWorker implements ReadinessSource {
  readonly name = "keeper";
  private handle: KeeperHandle | null = null;
  private starting = false;
  private failedError: string | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly db: Transactional,
    private readonly logger: Logger,
    private readonly simulationClient?: KeeperSimulationClient,
  ) {}

  async previewJob(
    jobName: KeeperJobName,
    payload: Omit<TtlBumpPayload & ClaimSettlementPayload, "dryRun"> = {},
  ): Promise<KeeperJobResult> {
    const ctx = {
      db: this.db,
      config: this.config,
      logger: this.logger,
      ...(this.simulationClient !== undefined ? { simulationClient: this.simulationClient } : {}),
    };
    if (jobName === "ttl-bump") {
      const result = await processTtlBump(ctx, { ...payload, dryRun: true });
      return { kind: "ttl-bump", result };
    }
    const result = await processClaimSettlement(ctx, { ...payload, dryRun: true });
    return { kind: "claim-settlement", result };
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
        detail: `redis connection failure: ${sanitizePublicPreviewText(this.failedError)}`,
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
      detail:
        this.config.keeper.stellarSecret === null
          ? "active on BullMQ in unsigned dry-run mode"
          : "active on BullMQ with 2 scheduled Stellar upkeep jobs",
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
        ...(this.simulationClient !== undefined ? { simulationClient: this.simulationClient } : {}),
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
        this.failedError = sanitizePublicPreviewText(raw);
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
