/**
 * One pass over the transfers waiting on one rail, bounded independently by provider lookup
 * concurrency and per-destination RPC verification concurrency.
 *
 * Provider status calls (`client.look`) acquire the provider semaphore and release it as soon as
 * the status response returns, before any destination RPC receipt verification starts. Destination
 * receipt verification acquires the destination chain's own semaphore in `DestinationBudgetPool`,
 * so a slow or rate-limited destination RPC never holds provider lookup slots or starves transfers
 * headed to healthy destinations.
 */
import type { Logger } from "pino";

import type { AppConfig } from "../config/config.js";
import type { Queryable, Transactional } from "../db/pool.js";
import type { ReadinessReport } from "../runtime/readiness.js";
import { writeInbound, writeAttestation } from "../chains/writers.js";
import { verifyItsDelivery } from "./axelar/delivery.js";
import { verifyCctpDelivery } from "./cctp/delivery.js";
import {
  claimTransferForCheck,
  outstandingForRail,
  pendingForRail,
  releaseUncheckedClaim,
  type TransferCheckLease,
} from "./queue.js";
import {
  AsyncSemaphore,
  BudgetAbortedError,
  DestinationBudgetPool,
  RailError,
  TransferOwnershipGuard,
  isTerminal,
  type DeliveryVerifier,
  type PendingTransfer,
  type RailClient,
  type RailLookup,
  type RailReport,
  type SemaphoreStats,
  type VerifiedRailDelivery,
} from "./types.js";

/**
 * How many outstanding transfers still counts as keeping up.
 */
const BACKLOG_MULTIPLE_BEFORE_DEGRADED = 3;
const DEFAULT_PROVIDER_CONCURRENCY = 4;
const DEFAULT_DESTINATION_CONCURRENCY = 2;

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
  /** Maximum parallel calls to `client.look` during a pass. */
  readonly providerConcurrency?: number;
  /** Default maximum parallel destination RPC receipt checks per chain when `destinationPool` is omitted. */
  readonly destinationConcurrency?: number;
  /** Optional per-destination RPC concurrency overrides when `destinationPool` is omitted. */
  readonly destinationBudgets?: Readonly<Record<string, number>>;
  /** Optional per-destination cap on candidates pulled into a single batch. */
  readonly maxPerDestination?: number;
  /** Shared destination RPC budget pool across multiple rail pollers. */
  readonly destinationPool?: DestinationBudgetPool;
  /** Shared in-process ownership guard across multiple rail pollers. */
  readonly ownershipGuard?: TransferOwnershipGuard;
  /** Optional delivery verifier hook; defaults to canonical ITS + CCTP receipt verification. */
  readonly verifyDelivery?: DeliveryVerifier;
}

export interface RailProgress {
  readonly checked: number;
  readonly settled: number;
  readonly failures: number;
  readonly outstanding: number;
  readonly at: Date;
}

function isSignalAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export class RailPass {
  private lastProgress: RailProgress | null = null;
  private cooldownUntil: Date | null = null;
  private readonly providerSemaphore: AsyncSemaphore;
  private readonly destinationPool: DestinationBudgetPool;
  private readonly ownershipGuard: TransferOwnershipGuard;

  constructor(private readonly options: RailPassOptions) {
    const providerLimit =
      options.providerConcurrency ??
      options.config?.rails.providerConcurrency ??
      DEFAULT_PROVIDER_CONCURRENCY;
    const defaultDestLimit =
      options.destinationConcurrency ??
      options.config?.rails.destinationConcurrency ??
      DEFAULT_DESTINATION_CONCURRENCY;
    const destOverrides = options.destinationBudgets ?? options.config?.rails.destinationBudgets;

    this.providerSemaphore = new AsyncSemaphore(providerLimit);
    this.destinationPool =
      options.destinationPool ??
      new DestinationBudgetPool({
        defaultConcurrency: defaultDestLimit,
        overrides: destOverrides,
      });
    this.ownershipGuard = options.ownershipGuard ?? new TransferOwnershipGuard();
  }

  get name(): string {
    return `rail:${this.options.client.rail}`;
  }

  get progress(): RailProgress | null {
    return this.lastProgress;
  }

  get providerBudgetStats(): SemaphoreStats {
    return this.providerSemaphore.stats;
  }

  destinationBudgetStats(destinationChain: string): SemaphoreStats {
    return this.destinationPool.stats(destinationChain);
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

    const passStartedAt = this.now();
    const notCheckedSince = new Date(passStartedAt.getTime() - this.options.recheckAfterMs);

    const queue = await pendingForRail(db, {
      route: this.options.route,
      limit: batchSize,
      notCheckedSince,
      maxCheckFailures: this.options.maxCheckFailures,
      maxPerDestination: this.options.maxPerDestination,
    });

    const passState = {
      checked: 0,
      settled: 0,
      failures: 0,
      rateLimited: false,
    };

    const providerAbort = new AbortController();
    const forwardAbort = () => {
      providerAbort.abort();
    };
    if (signal.aborted) {
      providerAbort.abort();
    } else {
      signal.addEventListener("abort", forwardAbort, { once: true });
    }

    try {
      await Promise.all(
        queue.map(async (candidate) => {
          if (signal.aborted || providerAbort.signal.aborted) return;

          const releaseOwnership = this.ownershipGuard.tryAcquire(candidate);
          if (releaseOwnership === null) {
            return;
          }

          const attemptState: {
            lease: TransferCheckLease | null;
            transfer: PendingTransfer;
            providerLookupCompleted: boolean;
          } = {
            lease: null,
            transfer: candidate,
            providerLookupCompleted: false,
          };

          try {
            if (candidate.delivered) {
              await this.writeNonRegression(candidate, {
                status: "delivered",
                railStatus: null,
                reference: null,
                attestedAt: null,
                checkedAt: this.now(),
                failures: 0,
                error: null,
              });
              passState.checked += 1;
              passState.settled += 1;
              return;
            }

            const lookupOutcome = await this.providerSemaphore.run(async () => {
              if (signal.aborted || providerAbort.signal.aborted) {
                throw new BudgetAbortedError();
              }

              const claim = await claimTransferForCheck(db, candidate, {
                claimedAt: this.now(),
                notCheckedSince,
                maxCheckFailures: this.options.maxCheckFailures,
                allowImmediateRecheck: this.options.recheckAfterMs === 0,
              });

              if (claim.kind === "skipped") {
                return { kind: "skipped" as const };
              }
              if (claim.kind === "already_delivered") {
                return { kind: "already_delivered" as const };
              }

              attemptState.lease = claim.lease;
              attemptState.transfer = {
                ...candidate,
                status: claim.status,
                checkFailures: claim.checkFailures,
              };

              const lookup: RailLookup = await client.look(
                attemptState.transfer,
                providerAbort.signal,
              );
              attemptState.providerLookupCompleted = true;
              return { kind: "looked_up" as const, lookup };
            }, providerAbort.signal);

            if (lookupOutcome.kind === "skipped") {
              return;
            }

            if (lookupOutcome.kind === "already_delivered") {
              await this.writeNonRegression(candidate, {
                status: "delivered",
                railStatus: null,
                reference: null,
                attestedAt: null,
                checkedAt: this.now(),
                failures: 0,
                error: null,
              });
              passState.checked += 1;
              passState.settled += 1;
              return;
            }

            const reachedTerminal = await this.completeAfterLookup(
              attemptState.transfer,
              lookupOutcome.lookup,
              signal,
            );
            passState.checked += 1;
            if (reachedTerminal) {
              passState.settled += 1;
            }
          } catch (error) {
            if (error instanceof BudgetAbortedError) {
              if (!attemptState.providerLookupCompleted && attemptState.lease !== null) {
                await releaseUncheckedClaim(db, attemptState.lease);
              }
              return;
            }

            if (error instanceof RailError && error.kind === "rateLimited") {
              if (!attemptState.providerLookupCompleted && attemptState.lease !== null) {
                await releaseUncheckedClaim(db, attemptState.lease);
              }
              if (!passState.rateLimited) {
                passState.rateLimited = true;
                const waitMs = error.retryAfterMs ?? 60_000;
                this.cooldownUntil = new Date(this.now().getTime() + waitMs);
                providerAbort.abort();
                logger.warn(
                  { rail: client.rail, until: this.cooldownUntil.toISOString() },
                  "the rail rate limited us, holding off rather than retrying",
                );
              }
              return;
            }

            if (isSignalAborted(signal) && !attemptState.providerLookupCompleted) {
              if (attemptState.lease !== null) {
                await releaseUncheckedClaim(db, attemptState.lease);
              }
              return;
            }

            passState.failures += 1;
            await this.recordFailure(attemptState.transfer, error);
          } finally {
            releaseOwnership();
          }
        }),
      );
    } finally {
      signal.removeEventListener("abort", forwardAbort);
    }

    const outstanding = await outstandingForRail(db, this.options.route);
    this.lastProgress = {
      checked: passState.checked,
      settled: passState.settled,
      failures: passState.failures,
      outstanding,
      at: this.now(),
    };

    if (passState.checked > 0 || passState.failures > 0) {
      logger.info(
        {
          rail: client.rail,
          checked: passState.checked,
          settled: passState.settled,
          failures: passState.failures,
          outstanding,
        },
        "rail statuses refreshed",
      );
    }

    if (passState.rateLimited || signal.aborted) {
      return false;
    }

    return queue.length >= batchSize;
  }

  private async completeAfterLookup(
    transfer: PendingTransfer,
    lookup: RailLookup,
    signal: AbortSignal,
  ): Promise<boolean> {
    const at = this.now();

    if (lookup.kind === "missing") {
      await this.writeNonRegression(transfer, {
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
    const hasVerifier =
      this.options.verifyDelivery !== undefined || this.options.config !== undefined;
    const hasCandidateProof = report.execution !== undefined || report.forwardTxHash !== undefined;

    if (hasVerifier && hasCandidateProof) {
      const verified = await this.destinationPool.run(
        transfer.destinationChain,
        () => this.verifyCandidateReceipt(transfer, report, signal),
        signal,
      );
      if (verified !== null) {
        const checkedAt = this.now();
        await this.options.db.transaction(async (tx) => {
          await writeInbound(tx, verified.at, verified.row);
          await writeAttestation(tx, {
            transferId: transfer.transferId,
            route: transfer.route,
            status: "delivered",
            railStatus: report.railStatus,
            railReference: report.reference,
            attestedAt: report.attestedAt,
            checkedAt,
            checkFailures: 0,
            lastError: null,
          });
        });
        return true;
      }
    }

    await this.writeNonRegression(transfer, {
      status: report.status,
      railStatus: report.railStatus,
      reference: report.reference,
      attestedAt: report.attestedAt,
      checkedAt: this.now(),
      failures: 0,
      error: null,
    });
    return isTerminal(report.status);
  }

  private async verifyCandidateReceipt(
    transfer: PendingTransfer,
    report: RailReport,
    signal: AbortSignal,
  ): Promise<VerifiedRailDelivery | null> {
    if (this.options.verifyDelivery !== undefined) {
      return this.options.verifyDelivery(transfer, report, signal);
    }
    const config = this.options.config;
    if (config === undefined) {
      return null;
    }
    return (
      (await verifyItsDelivery(config, this.options.db, transfer, report)) ??
      (await verifyCctpDelivery(config, this.options.db, transfer, report))
    );
  }

  private async recordFailure(transfer: PendingTransfer, error: unknown): Promise<void> {
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

    await this.writeNonRegression(transfer, {
      status: transfer.status ?? "pending",
      railStatus: null,
      reference: null,
      attestedAt: null,
      checkedAt: this.now(),
      failures,
      error: reason,
    });
  }

  /**
   * Persist attestation state inside a transaction without regressing a transfer that has already
   * reached a terminal state or recorded a canonical `inbound_delivery` row concurrently.
   */
  private async writeNonRegression(
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
      const { rows } = await tx.query(
        `SELECT a.status AS existing_status,
                EXISTS (
                  SELECT 1 FROM inbound_delivery d
                   WHERE d.destination_chain = $2
                     AND d.route = $3
                     AND d.source_chain = $4
                     AND d.source_nonce = $5::numeric
                ) AS inbound_exists
           FROM (SELECT 1) AS anchor
           LEFT JOIN rail_attestation a ON a.transfer_id = $1::bigint`,
        [
          transfer.transferId.toString(),
          transfer.destinationChain,
          transfer.route,
          transfer.originChain,
          transfer.nonce.toString(),
        ],
      );

      const current = rows[0];
      const existingStatus =
        current !== undefined && typeof current.existing_status === "string"
          ? current.existing_status
          : null;
      const inboundExists = current?.inbound_exists === true;

      let effectiveStatus = fields.status;
      let effectiveFailures = fields.failures;
      let effectiveError = fields.error;

      if (inboundExists) {
        effectiveStatus = "delivered";
        effectiveFailures = 0;
        effectiveError = null;
      } else if (
        existingStatus === "delivered" ||
        existingStatus === "failed" ||
        existingStatus === "expired"
      ) {
        effectiveStatus = existingStatus;
      }

      await writeAttestation(tx, {
        transferId: transfer.transferId,
        route: transfer.route,
        status: effectiveStatus,
        railStatus: fields.railStatus,
        railReference: fields.reference,
        attestedAt: fields.attestedAt,
        checkedAt: fields.checkedAt,
        checkFailures: effectiveFailures,
        lastError: effectiveError,
      });
    });
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}
