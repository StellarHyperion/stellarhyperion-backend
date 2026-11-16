/**
 * Worker implementation for the keeper, integrating with the runner lifecycle.
 *
 * Exposes start, stop and readiness so `main.ts` and `runner.ts` treat the keeper identically
 * to chain watchers and rail pollers.
 */
import { Keypair } from "@stellar/stellar-sdk";
import type { Logger } from "pino";

import type { AppConfig } from "../config/config.js";
import type { Transactional } from "../db/pool.js";
import type { ReadinessReport, ReadinessSource } from "../runtime/readiness.js";
import { PostgresSignerLeaseStore } from "./leases.js";
import { startKeeperQueue, type KeeperHandle } from "./queue.js";
import type { SignerLeaseStorePort } from "./types.js";

export class KeeperWorker implements ReadinessSource {
  readonly name = "keeper";
  private handle: KeeperHandle | null = null;
  private starting = false;
  private failedError: string | null = null;
  private activeLeaseStore: SignerLeaseStorePort | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly db: Transactional,
    private readonly logger: Logger,
    private readonly leaseStore?: SignerLeaseStorePort,
  ) {}

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
      detail: `active on BullMQ with 2 scheduled Stellar upkeep jobs (instance ${this.config.keeper.instanceId})`,
    };
  }

  start(): void {
    if (!this.config.keeper.enabled || this.handle !== null || this.starting) return;
    this.starting = true;
    const store = this.leaseStore ?? new PostgresSignerLeaseStore(this.db);
    this.activeLeaseStore = store;

    startKeeperQueue(
      {
        db: this.db,
        config: this.config,
        logger: this.logger,
        leaseStore: store,
        holderId: this.config.keeper.instanceId,
        leaseTtlMs: this.config.keeper.leaseTtlMs,
      },
      this.config.redisUrl,
    )
      .then((handle) => {
        this.handle = handle;
        this.starting = false;
        this.logger.info(
          { instanceId: this.config.keeper.instanceId },
          "keeper BullMQ worker and queue ready",
        );
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
    if (this.activeLeaseStore !== null && this.config.keeper.stellarSecret !== null) {
      try {
        const signerPublicKey = Keypair.fromSecret(this.config.keeper.stellarSecret).publicKey();
        await this.activeLeaseStore.release(signerPublicKey, this.config.keeper.instanceId);
      } catch (err) {
        this.logger.warn({ err }, "failed to release keeper signer lease during shutdown");
      }
    }
  }
}
