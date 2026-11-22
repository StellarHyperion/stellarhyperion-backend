/**
 * Worker implementation for the keeper, integrating with the runner lifecycle.
 *
 * Exposes start, stop and readiness so `main.ts` and `runner.ts` treat the keeper identically
 * to chain watchers and rail pollers.
 */
import type { Logger } from "pino";
import { randomUUID } from "node:crypto";

import type { AppConfig } from "../config/config.js";
import type { Transactional } from "../db/pool.js";
import type { ReadinessReport, ReadinessSource } from "../runtime/readiness.js";
import { startKeeperQueue, type KeeperHandle } from "./queue.js";
import { activateKeeperSigner } from "./signers.js";

export class KeeperWorker implements ReadinessSource {
  readonly name = "keeper";
  private handle: KeeperHandle | null = null;
  private starting = false;
  private failedError: string | null = null;
  private readonly signerLeaseOwnerId: string;

  constructor(
    private readonly config: AppConfig,
    private readonly db: Transactional,
    private readonly logger: Logger,
  ) {
    this.signerLeaseOwnerId = `${this.config.indexerLeaseOwnerId}:${randomUUID()}`;
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
        detail: `keeper startup blocked: ${this.failedError}`,
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

    Promise.resolve()
      .then(async () => {
        if (this.config.keeper.stellarSecrets.length > 0) {
          const signer = await activateKeeperSigner(this.db, this.config);
          this.logger.info(
            { signer: signer.publicKey, balance: signer.balance },
            "funded keeper signer ownership ready",
          );
        }
        return startKeeperQueue(
          {
            db: this.db,
            config: this.config,
            logger: this.logger,
            signerLeaseOwnerId: this.signerLeaseOwnerId,
          },
          this.config.redisUrl,
        );
      })
      .then((handle) => {
        this.handle = handle;
        this.starting = false;
        this.logger.info("keeper BullMQ worker and queue ready");
      })
      .catch(() => {
        this.starting = false;
        this.failedError =
          "signer ownership, balance, network or queue readiness could not be verified";
        this.logger.error(
          "failed to start keeper queue; details omitted to protect configured credentials",
        );
      });
  }

  async stop(): Promise<void> {
    if (this.handle !== null) {
      await this.handle.close();
      this.handle = null;
    }
  }
}
