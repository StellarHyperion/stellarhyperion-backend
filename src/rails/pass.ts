/**
 * One pass over the transfers waiting on one rail, persisting normalized retry classifications and
 * durable `next_attempt_at` schedules so restarts preserve backoff without retry storms.
 */
import type { AppConfig } from "../config/config.js";
import { verifyItsDelivery } from "./axelar/delivery.js";
import { verifyCctpDelivery } from "./cctp/delivery.js";
import type { Logger } from "pino";

import type { Queryable, Transactional } from "../db/pool.js";
import type { ReadinessReport } from "../runtime/readiness.js";
import { writeInbound } from "../chains/writers.js";
import { outstandingForRail, pendingForRail } from "./queue.js";
import {
  computeFailureSchedule,
  computeHealthySchedule,
  resolveRetryPolicy,
  writeScheduledAttestation,
} from "./retry-schedule.js";
import {
  RailError,
  isTerminal,
  type AttestationStatus,
  type PendingTransfer,
  type RailClient,
  type RailRetryClass,
  type RetrySchedulePolicy,
} from "./types.js";

const BACKLOG_MULTIPLE_BEFORE_DEGRADED = 3;

export interface RailPassOptions {
  readonly route: number;
  readonly client: RailClient;
  readonly db: Transactional;
  readonly logger: Logger;
  readonly batchSize: number;
  /** Don't re-check a transfer sooner than this, so one stuck row cannot starve the queue. */
  readonly recheckAfterMs: number;
  readonly maxCheckFailures: number;
  readonly now?: () => Date;
  readonly config?: AppConfig;
  readonly retryPolicy?: RetrySchedulePolicy | undefined;
}

export interface RailProgress {
  readonly checked: number;
  readonly settled: number;
  readonly failures: number;
  readonly outstanding: number;
  readonly at: Date;
}

export class RailPass {
  private lastProgress: RailProgress | null = null;
  private cooldownUntil: Date | null = null;

  constructor(private readonly options: RailPassOptions) {}

  get name(): string {
    return `rail:${this.options.client.rail}`;
  }

  get progress(): RailProgress | null {
    return this.lastProgress;
  }

  readiness(): ReadinessReport {
    const progress = this.lastProgress;
    const cooldown = this.cooldownUntil;
    if (cooldown !== null && cooldown > this.now()) {
      return {
        name: this.name,
        state: "degraded",
        detail: `rate limited by the rail until ${cooldown.toISOString()}, so no transfer status is moving`,
      };
    }
    if (progress === null) {
      return {
        name: this.name,
        state: "degraded",
        detail: "has not completed a pass yet, so no transfer's rail status is known",
      };
    }
    const ceiling = this.options.batchSize * BACKLOG_MULTIPLE_BEFORE_DEGRADED;
    if (progress.outstanding > ceiling) {
      return {
        name: this.name,
        state: "degraded",
        detail: `${String(progress.outstanding)} transfers are waiting on this rail, which is more than ${String(BACKLOG_MULTIPLE_BEFORE_DEGRADED)} passes' worth`,
      };
    }
    return {
      name: this.name,
      state: "ready",
      detail:
        progress.outstanding === 0
          ? "nothing waiting on this rail"
          : `${String(progress.outstanding)} transfers in flight`,
    };
  }

  /** One pass. Returns true when it filled a batch, which means there is more behind it. */
  async tick(signal: AbortSignal): Promise<boolean> {
    const { db, logger, batchSize, client } = this.options;

    const cooldown = this.cooldownUntil;
    if (cooldown !== null && cooldown > this.now()) return false;
    this.cooldownUntil = null;

    const passTime = this.now();
    const queue = await pendingForRail(db, {
      route: this.options.route,
      limit: batchSize,
      notCheckedSince: new Date(passTime.getTime() - this.options.recheckAfterMs),
      maxCheckFailures: this.options.maxCheckFailures,
      now: passTime,
    });

    let checked = 0;
    let settled = 0;
    let failures = 0;

    for (let index = 0; index < queue.length; index += 1) {
      const transfer = queue[index];
      if (transfer === undefined) continue;
      if (signal.aborted) break;
      try {
        if (await this.handle(transfer, signal)) settled += 1;
        checked += 1;
      } catch (error) {
        if (error instanceof RailError && error.kind === "rateLimited") {
          const policy = resolveRetryPolicy(this.options.retryPolicy);
          const waitMs = error.retryAfterMs ?? policy.defaultRateLimitMs;
          const now = this.now();
          this.cooldownUntil = new Date(now.getTime() + waitMs);
          // Persist durable rate_limited schedule on the transfer and any remaining queued batch
          // items that are not already delivered so a process restart respects the rate-limit window!
          for (const queuedItem of queue.slice(index)) {
            if (queuedItem.delivered) continue;
            const schedule = computeFailureSchedule(
              error,
              queuedItem.checkFailures,
              this.options.maxCheckFailures,
              now,
              this.options.retryPolicy,
            );
            await this.write(queuedItem, {
              status: queuedItem.status ?? "pending",
              railStatus: null,
              reference: null,
              attestedAt: null,
              checkedAt: now,
              failures: queuedItem.checkFailures,
              error: error.message,
              retryClass: schedule.retryClass,
              nextAttemptAt: schedule.nextAttemptAt,
            });
          }
          logger.warn(
            { rail: client.rail, until: this.cooldownUntil.toISOString() },
            "the rail rate limited us, holding off rather than retrying",
          );
          break;
        }
        failures += 1;
        await this.recordFailure(transfer, error);
      }
    }

    const outstanding = await outstandingForRail(db, this.options.route);
    this.lastProgress = { checked, settled, failures, outstanding, at: this.now() };

    if (checked > 0 || failures > 0) {
      logger.info(
        { rail: client.rail, checked, settled, failures, outstanding },
        "rail statuses refreshed",
      );
    }

    return queue.length >= batchSize;
  }

  /** Returns true when the transfer reached a terminal state on this pass. */
  private async handle(transfer: PendingTransfer, signal: AbortSignal): Promise<boolean> {
    const at = this.now();

    if (transfer.delivered) {
      const schedule = computeHealthySchedule(
        "delivered",
        "delivered",
        at,
        this.options.recheckAfterMs,
      );
      await this.write(transfer, {
        status: "delivered",
        railStatus: null,
        reference: null,
        attestedAt: null,
        checkedAt: at,
        failures: 0,
        error: null,
        retryClass: schedule.retryClass,
        nextAttemptAt: schedule.nextAttemptAt,
      });
      return true;
    }

    const lookup = await this.options.client.look(transfer, signal);
    if (lookup.kind === "missing") {
      const status: AttestationStatus = transfer.status ?? "pending";
      const schedule = computeHealthySchedule(status, "missing", at, this.options.recheckAfterMs);
      await this.write(transfer, {
        status,
        railStatus: null,
        reference: null,
        attestedAt: null,
        checkedAt: at,
        failures: 0,
        error: null,
        retryClass: schedule.retryClass,
        nextAttemptAt: schedule.nextAttemptAt,
      });
      return false;
    }

    const { report } = lookup;
    if (this.options.config && (report.execution || report.forwardTxHash)) {
      const verified =
        (await verifyItsDelivery(this.options.config, this.options.db, transfer, report)) ??
        (await verifyCctpDelivery(this.options.config, this.options.db, transfer, report));
      if (verified) {
        const settledSchedule = computeHealthySchedule(
          "delivered",
          "delivered",
          at,
          this.options.recheckAfterMs,
        );
        await this.options.db.transaction(async (tx) => {
          await writeInbound(tx, verified.at, verified.row);
          await writeScheduledAttestation(tx, {
            transferId: transfer.transferId,
            route: transfer.route,
            status: "delivered",
            railStatus: report.railStatus,
            railReference: report.reference,
            attestedAt: report.attestedAt,
            checkedAt: at,
            checkFailures: 0,
            lastError: null,
            retryClass: settledSchedule.retryClass,
            nextAttemptAt: settledSchedule.nextAttemptAt,
          });
        });
        return true;
      }
    }

    const schedule = computeHealthySchedule(
      report.status,
      "found",
      at,
      this.options.recheckAfterMs,
    );
    await this.write(transfer, {
      status: report.status,
      railStatus: report.railStatus,
      reference: report.reference,
      attestedAt: report.attestedAt,
      checkedAt: at,
      failures: 0,
      error: null,
      retryClass: schedule.retryClass,
      nextAttemptAt: schedule.nextAttemptAt,
    });
    return isTerminal(report.status);
  }

  private async recordFailure(transfer: PendingTransfer, error: unknown): Promise<void> {
    const now = this.now();
    const failures = transfer.checkFailures + 1;
    const reason = error instanceof Error ? error.message : String(error);
    const permanent = error instanceof RailError && error.kind === "permanent";
    const schedule = computeFailureSchedule(
      error,
      failures,
      this.options.maxCheckFailures,
      now,
      this.options.retryPolicy,
    );

    if (permanent || failures >= this.options.maxCheckFailures) {
      this.options.logger.error(
        {
          rail: this.options.client.rail,
          transferId: transfer.transferId.toString(),
          failures,
          retryClass: schedule.retryClass,
          reason,
        },
        permanent
          ? "this transfer cannot be looked up on this rail at all; it will not be retried"
          : "giving up on this transfer after too many consecutive failures",
      );
    }

    await this.write(transfer, {
      status: transfer.status ?? "pending",
      railStatus: null,
      reference: null,
      attestedAt: null,
      checkedAt: now,
      failures,
      error: reason,
      retryClass: schedule.retryClass,
      nextAttemptAt: schedule.nextAttemptAt,
    });
  }

  private async write(
    transfer: PendingTransfer,
    fields: {
      readonly status: AttestationStatus;
      readonly railStatus: string | null;
      readonly reference: string | null;
      readonly attestedAt: Date | null;
      readonly checkedAt: Date;
      readonly failures: number;
      readonly error: string | null;
      readonly retryClass: RailRetryClass;
      readonly nextAttemptAt: Date | null;
    },
  ): Promise<void> {
    await this.options.db.transaction(async (tx: Queryable) => {
      await writeScheduledAttestation(tx, {
        transferId: transfer.transferId,
        route: transfer.route,
        status: fields.status,
        railStatus: fields.railStatus,
        railReference: fields.reference,
        attestedAt: fields.attestedAt,
        checkedAt: fields.checkedAt,
        checkFailures: fields.failures,
        lastError: fields.error,
        retryClass: fields.retryClass,
        nextAttemptAt: fields.nextAttemptAt,
      });
    });
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}
