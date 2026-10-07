/**
 * One pass over the transfers waiting on one rail.
 *
 * Shaped exactly like a chain watcher's pass, and joining the same `PolledWorker` list, because
 * the lifecycle problems are identical: one at a time, catch up without sleeping, back off on
 * failure, report readiness from cached state. What differs is what a failure means, and there are
 * two kinds of backoff here rather than one.
 *
 * The poller's backoff is about the rail being unreachable. `check_failures` on the row is about
 * one transfer being unanswerable while the rail is otherwise fine, which happens when a transfer
 * was filed under the wrong rail or its chain has no domain. Those are different situations and
 * conflating them means either one bad transfer backs off the whole rail, or a dead rail is
 * hammered once per transfer per tick. So a per transfer failure is counted on the row and the
 * queue stops offering it after `maxCheckFailures`; only a rail level failure reaches the poller.
 *
 * A rate limit is its own case again. Circle blocks every request for five minutes after one, so
 * the pass records a cooldown and returns without asking anything until it passes. Doubling from a
 * second would spend those five minutes refreshing the block.
 */
import type { Logger } from "pino";

import type { Queryable, Transactional } from "../db/pool.js";
import type { ReadinessReport } from "../runtime/readiness.js";
import { writeAttestation } from "../chains/writers.js";
import { outstandingForRail, pendingForRail } from "./queue.js";
import { RailError, isTerminal, type PendingTransfer, type RailClient } from "./types.js";

/**
 * How many outstanding transfers still counts as keeping up.
 *
 * The batch is the limit on one tick, so a backlog larger than a batch means the rail is more than
 * one tick behind. A couple of batches is a busy minute; ten is something worth looking at, and
 * the number itself goes in the readiness detail either way.
 */
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

    const queue = await pendingForRail(db, {
      route: this.options.route,
      limit: batchSize,
      notCheckedSince: new Date(this.now().getTime() - this.options.recheckAfterMs),
      maxCheckFailures: this.options.maxCheckFailures,
    });

    let checked = 0;
    let settled = 0;
    let failures = 0;

    for (const transfer of queue) {
      if (signal.aborted) break;
      try {
        if (await this.handle(transfer)) settled += 1;
        checked += 1;
      } catch (error) {
        if (error instanceof RailError && error.kind === "rateLimited") {
          // The whole rail, not this transfer. Stop the pass and hold off.
          const waitMs = error.retryAfterMs ?? 60_000;
          this.cooldownUntil = new Date(this.now().getTime() + waitMs);
          logger.warn(
            { rail: client.rail, until: this.cooldownUntil.toISOString() },
            "the rail rate limited us, holding off rather than retrying",
          );
          break;
        }
        // Everything else is this transfer's problem, recorded on its own row so one unanswerable
        // transfer cannot back off the rest of the queue.
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

    // A full batch means the queue is longer than one pass, so come straight back.
    return queue.length >= batchSize;
  }

  /** Returns true when the transfer reached a terminal state on this pass. */
  private async handle(transfer: PendingTransfer): Promise<boolean> {
    const at = this.now();

    if (transfer.delivered) {
      // Our own inbound index already says the money arrived, which outranks anything the rail
      // would tell us. No request, and the transfer leaves the queue for good.
      await this.write(transfer, {
        status: "delivered",
        railStatus: null,
        reference: null,
        attestedAt: null,
        checkedAt: at,
        failures: 0,
        error: null,
      });
      return true;
    }

    const lookup = await this.options.client.look(transfer);
    if (lookup.kind === "missing") {
      // Normal. The rail has not indexed the burn yet, which is where every transfer starts.
      await this.write(transfer, {
        status: transfer.status ?? "pending",
        railStatus: null,
        reference: null,
        attestedAt: null,
        checkedAt: at,
        failures: 0,
        error: null,
      });
      return false;
    }

    const { report } = lookup;
    await this.write(transfer, {
      status: report.status,
      railStatus: report.railStatus,
      reference: report.reference,
      attestedAt: report.attestedAt,
      checkedAt: at,
      failures: 0,
      error: null,
    });
    return isTerminal(report.status);
  }

  private async recordFailure(transfer: PendingTransfer, error: unknown): Promise<void> {
    const failures = transfer.checkFailures + 1;
    const reason = error instanceof Error ? error.message : String(error);
    const permanent = error instanceof RailError && error.kind === "permanent";

    if (permanent || failures >= this.options.maxCheckFailures) {
      // Said out loud, because the queue is about to stop offering this transfer and a transfer
      // that quietly stops being chased is the thing somebody notices a week later.
      this.options.logger.error(
        {
          rail: this.options.client.rail,
          transferId: transfer.transferId.toString(),
          failures,
          reason,
        },
        permanent
          ? "this transfer cannot be looked up on this rail at all; it will not be retried"
          : "giving up on this transfer after too many consecutive failures",
      );
    }

    await this.write(transfer, {
      // Still pending, not failed. A transfer we cannot ask about is not a transfer that failed,
      // and writing `failed` here would claim the money did not move on the strength of our own
      // inability to get an answer.
      status: transfer.status ?? "pending",
      railStatus: null,
      reference: null,
      attestedAt: null,
      checkedAt: this.now(),
      failures,
      error: reason,
    });
  }

  private async write(
    transfer: PendingTransfer,
    fields: {
      readonly status: string;
      readonly railStatus: string | null;
      readonly reference: string | null;
      readonly attestedAt: Date | null;
      readonly checkedAt: Date;
      readonly failures: number;
      readonly error: string | null;
    },
  ): Promise<void> {
    await this.options.db.transaction(async (tx: Queryable) => {
      await writeAttestation(tx, {
        transferId: transfer.transferId,
        route: transfer.route,
        status: fields.status,
        railStatus: fields.railStatus,
        railReference: fields.reference,
        attestedAt: fields.attestedAt,
        checkedAt: fields.checkedAt,
        checkFailures: fields.failures,
        lastError: fields.error,
      });
    });
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}
