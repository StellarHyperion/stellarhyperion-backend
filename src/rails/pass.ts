/**
 * One pass over the transfers waiting on one rail.
 *
 * Shaped exactly like a chain watcher's pass, and joining the same `PolledWorker` list, because
 * the lifecycle problems are identical: one at a time, catch up without sleeping, back off on
 * failure, report readiness from cached state.
 *
 * Candidate processing across replicas is coordinated with database-backed `rail_work_lease` rows
 * and monotonic fencing tokens so two workers cannot commit conflicting verification decisions and
 * a stale worker that lost its lease cannot mark delivery.
 */
import { randomUUID } from "node:crypto";

import type { AppConfig } from "../config/config.js";
import { verifyItsDelivery, type VerifiedDelivery } from "./axelar/delivery.js";
import { verifyCctpDelivery } from "./cctp/delivery.js";
import type { Logger } from "pino";

import type { Queryable, Transactional } from "../db/pool.js";
import type { ReadinessReport } from "../runtime/readiness.js";
import { writeInbound, writeAttestation } from "../chains/writers.js";
import {
  DEFAULT_RAIL_LEASE_DURATION_MS,
  RailLeaseLostError,
  claimPendingForRail,
  commitWithRailLease,
  releaseRailLease,
  renewRailLease,
} from "./leases.js";
import { outstandingForRail } from "./queue.js";
import {
  RailError,
  isTerminal,
  type LeasedPendingTransfer,
  type PendingTransfer,
  type RailClient,
  type RailReport,
  type RailWorkLease,
} from "./types.js";

const BACKLOG_MULTIPLE_BEFORE_DEGRADED = 3;

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export type CandidateProofVerifier = (
  transfer: PendingTransfer,
  report: RailReport,
) => Promise<VerifiedDelivery | null>;

export interface RailPassOptions {
  readonly route: number;
  readonly client: RailClient;
  readonly db: Transactional;
  readonly logger: Logger;
  readonly batchSize: number;
  /** Don't re-check a transfer sooner than this, so one stuck row cannot starve the queue. */
  readonly recheckAfterMs: number;
  readonly maxCheckFailures: number;
  readonly now?: (() => Date) | undefined;
  readonly config?: AppConfig | undefined;
  readonly workerId?: string | undefined;
  readonly leaseDurationMs?: number | undefined;
  readonly verifyCandidateDelivery?: CandidateProofVerifier | undefined;
}

export interface RailProgress {
  readonly checked: number;
  readonly settled: number;
  readonly failures: number;
  readonly leaseLosses: number;
  readonly outstanding: number;
  readonly at: Date;
}

export class RailPass {
  private lastProgress: RailProgress | null = null;
  private cooldownUntil: Date | null = null;
  private readonly workerOwnerId: string;
  private readonly leaseDurationMs: number;

  constructor(private readonly options: RailPassOptions) {
    const providedOwner = options.workerId?.trim();
    this.workerOwnerId =
      providedOwner !== undefined && providedOwner.length > 0
        ? providedOwner
        : `rail-${options.client.rail}-${randomUUID()}`;
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_RAIL_LEASE_DURATION_MS;
  }

  get name(): string {
    return `rail:${this.options.client.rail}`;
  }

  get workerId(): string {
    return this.workerOwnerId;
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

  /** One pass. Returns true when it claimed a full batch, which means there is more behind it. */
  async tick(signal: AbortSignal): Promise<boolean> {
    const { db, logger, batchSize, client } = this.options;

    const cooldown = this.cooldownUntil;
    if (cooldown !== null && cooldown > this.now()) return false;
    this.cooldownUntil = null;

    const claimTime = this.now();
    const queue = await claimPendingForRail(db, {
      route: this.options.route,
      limit: batchSize,
      notCheckedSince: new Date(claimTime.getTime() - this.options.recheckAfterMs),
      maxCheckFailures: this.options.maxCheckFailures,
      owner: this.workerOwnerId,
      now: claimTime,
      leaseDurationMs: this.leaseDurationMs,
    });

    let checked = 0;
    let settled = 0;
    let failures = 0;
    let leaseLosses = 0;

    for (let index = 0; index < queue.length; index += 1) {
      const transfer = queue[index];
      if (transfer === undefined) continue;

      if (isAborted(signal)) {
        await this.releaseRemaining(queue.slice(index));
        break;
      }

      let activeLease = transfer.lease;
      try {
        const outcome = await this.handle(transfer, signal, (updated) => {
          activeLease = updated;
        });
        if (outcome) settled += 1;
        checked += 1;
      } catch (error) {
        if (error instanceof RailLeaseLostError) {
          leaseLosses += 1;
          logger.warn(
            {
              rail: client.rail,
              workerId: this.workerOwnerId,
              transferId: transfer.transferId.toString(),
              reason: error.reason,
            },
            "worker lost transfer lease before commit; skipping stale write",
          );
          continue;
        }
        if (error instanceof RailError && error.kind === "rateLimited") {
          const waitMs = error.retryAfterMs ?? 60_000;
          this.cooldownUntil = new Date(this.now().getTime() + waitMs);
          logger.warn(
            { rail: client.rail, until: this.cooldownUntil.toISOString() },
            "the rail rate limited us, holding off rather than retrying",
          );
          await this.releaseRemaining([
            { ...transfer, lease: activeLease },
            ...queue.slice(index + 1),
          ]);
          break;
        }
        try {
          failures += 1;
          await this.recordFailure(transfer, activeLease, error);
        } catch (commitError) {
          if (commitError instanceof RailLeaseLostError) {
            failures -= 1;
            leaseLosses += 1;
            logger.warn(
              {
                rail: client.rail,
                workerId: this.workerOwnerId,
                transferId: transfer.transferId.toString(),
                reason: commitError.reason,
              },
              "worker lost transfer lease while recording failure; skipping stale write",
            );
          } else {
            throw commitError;
          }
        }
      }
    }

    const outstanding = await outstandingForRail(db, this.options.route);
    this.lastProgress = { checked, settled, failures, leaseLosses, outstanding, at: this.now() };

    if (checked > 0 || failures > 0 || leaseLosses > 0) {
      logger.info(
        { rail: client.rail, checked, settled, failures, leaseLosses, outstanding },
        "rail statuses refreshed",
      );
    }

    return queue.length >= batchSize;
  }

  private async releaseRemaining(remaining: readonly LeasedPendingTransfer[]): Promise<void> {
    const releaseAt = this.now();
    for (const item of remaining) {
      await releaseRailLease(this.options.db, item.lease, releaseAt);
    }
  }

  /** Returns true when the transfer reached a terminal state on this pass. */
  private async handle(
    transfer: LeasedPendingTransfer,
    signal: AbortSignal,
    onLeaseRenewed: (lease: RailWorkLease) => void,
  ): Promise<boolean> {
    if (transfer.delivered) {
      const checkedAt = this.now();
      await this.writeFenced(transfer, transfer.lease, {
        status: "delivered",
        railStatus: null,
        reference: null,
        attestedAt: null,
        checkedAt,
        failures: 0,
        error: null,
      });
      return true;
    }

    const lookup = await this.options.client.look(transfer, signal);
    if (lookup.kind === "missing") {
      const checkedAt = this.now();
      await this.writeFenced(transfer, transfer.lease, {
        status: transfer.status ?? "pending",
        railStatus: null,
        reference: null,
        attestedAt: null,
        checkedAt,
        failures: 0,
        error: null,
      });
      return false;
    }

    const { report } = lookup;
    let activeLease = transfer.lease;

    const shouldVerify =
      (this.options.verifyCandidateDelivery !== undefined || this.options.config !== undefined) &&
      (report.execution !== undefined || report.forwardTxHash !== undefined);

    if (shouldVerify) {
      // Renew and validate lease ownership before running destination proof verification so an
      // already-expired worker stops early.
      activeLease = await renewRailLease(
        this.options.db,
        activeLease,
        this.now(),
        this.leaseDurationMs,
      );
      onLeaseRenewed(activeLease);

      const verified =
        this.options.verifyCandidateDelivery !== undefined
          ? await this.options.verifyCandidateDelivery(transfer, report)
          : this.options.config !== undefined
            ? ((await verifyItsDelivery(this.options.config, this.options.db, transfer, report)) ??
              (await verifyCctpDelivery(this.options.config, this.options.db, transfer, report)))
            : null;

      if (verified !== null) {
        // Atomic fenced commit: both inbound_delivery and delivered rail_attestation succeed only
        // if this worker STILL owns an unexpired lease with the exact fencing token at commit time.
        const commitAt = this.now();
        await commitWithRailLease(this.options.db, activeLease, commitAt, async (tx) => {
          await writeInbound(tx, verified.at, verified.row);
          await writeAttestation(tx, {
            transferId: transfer.transferId,
            route: transfer.route,
            status: "delivered",
            railStatus: report.railStatus,
            railReference: report.reference,
            attestedAt: report.attestedAt,
            checkedAt: commitAt,
            checkFailures: 0,
            lastError: null,
          });
        });
        return true;
      }
    }

    const checkedAt = this.now();
    await this.writeFenced(transfer, activeLease, {
      status: report.status,
      railStatus: report.railStatus,
      reference: report.reference,
      attestedAt: report.attestedAt,
      checkedAt,
      failures: 0,
      error: null,
    });
    return isTerminal(report.status);
  }

  private async recordFailure(
    transfer: PendingTransfer,
    lease: RailWorkLease,
    error: unknown,
  ): Promise<void> {
    const failures = transfer.checkFailures + 1;
    const reason = error instanceof Error ? error.message : String(error);
    const permanent = error instanceof RailError && error.kind === "permanent";

    if (permanent || failures >= this.options.maxCheckFailures) {
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

    const checkedAt = this.now();
    await this.writeFenced(transfer, lease, {
      status: transfer.status ?? "pending",
      railStatus: null,
      reference: null,
      attestedAt: null,
      checkedAt,
      failures,
      error: reason,
    });
  }

  private async writeFenced(
    transfer: PendingTransfer,
    lease: RailWorkLease,
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
    await commitWithRailLease(this.options.db, lease, fields.checkedAt, async (tx: Queryable) => {
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
