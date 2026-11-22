import type { VerifiedDelivery } from "./axelar/delivery.js";
import { RouteKind } from "@hyperion/protocol";
import type { AxelarDeliveryEvidenceRow } from "../chains/writers.js";
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
 * hammered once per transfer per tick. Transient provider attempts have a separate durable
 * counter; only permanent and evidence failures consume `maxCheckFailures`.
 *
 * A rate limit is its own case again. Circle blocks every request for five minutes after one, so
 * the pass records a cooldown and returns without asking anything until it passes. Doubling from a
 * second would spend those five minutes refreshing the block.
 */
import { randomUUID } from "node:crypto";

import type { AppConfig } from "../config/config.js";
import { abortable, combinedSignal } from "./cancellation.js";
import { revalidateItsDeliveryProofs, verifyItsDelivery } from "./axelar/delivery.js";
import { ingestAxelarGasEvidence } from "./axelar/gas.js";
import type { VerificationDiagnostic } from "./axelar/events.js";
import { inspectCctpDelivery } from "./cctp/delivery.js";
import type { Logger } from "pino";

import type { Queryable, Transactional } from "../db/pool.js";
import type { ReadinessReport } from "../runtime/readiness.js";
import { ProviderCircuitBreaker, safeCircuitKey, type ProviderCircuitSnapshot } from "./circuit.js";
import {
  writeInbound,
  writeAttestation,
  writeAxelarDeliveryEvidence,
  linkAxelarDeliveryEvidence,
  writeAxelarQuarantine,
} from "../chains/writers.js";
import {
  claimPendingForRail,
  inspectRailBacklog,
  outstandingForRail,
  releaseRailWorkLease,
  releaseRailWorkLeases,
  renewRailWorkLease,
  type InspectRailBacklogOptions,
} from "./queue.js";
import {
  RailLeaseLostError,
  RailError,
  isTerminal,
  type BacklogInspectionReport,
  type PendingTransfer,
  type RailClient,
  type RailLookup,
  type RailRetryClass,
  type RailWorkLease,
  type CctpVerificationFailure,
  type RailCancellationOptions,
} from "./types.js";

/**
 * How many outstanding transfers still counts as keeping up.
 *
 * The batch is the limit on one tick, so a backlog larger than a batch means the rail is more than
 * one tick behind. A couple of batches is a busy minute; ten is something worth looking at, and
 * the number itself goes in the readiness detail either way.
 */
const BACKLOG_MULTIPLE_BEFORE_DEGRADED = 3;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;
const RAIL_WORK_LEASE_MS = 60_000;

type TransferOutcome =
  | { readonly kind: "processed"; readonly settled: boolean }
  | { readonly kind: "failed"; readonly rateLimitedError: RailError | null };

export interface RailPassOptions extends RailCancellationOptions {
  readonly route: number;
  readonly client: RailClient;
  readonly db: Transactional;
  readonly logger: Logger;
  readonly batchSize: number;
  /** Maximum number of transfers for one destination in a pass. */
  readonly maxPerDestination?: number;
  /** Don't re-check a transfer sooner than this, so one stuck row cannot starve the queue. */
  readonly recheckAfterMs: number;
  readonly maxCheckFailures: number;
  readonly now?: () => Date;
  readonly config?: AppConfig;
  readonly circuits?: ProviderCircuitBreaker;
  readonly circuitFailureThreshold?: number;
  readonly circuitCooldownMs?: number;
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
  private readonly circuits: ProviderCircuitBreaker;
  private readonly ownerId = randomUUID();

  constructor(private readonly options: RailPassOptions) {
    this.circuits =
      options.circuits ??
      new ProviderCircuitBreaker({
        ...(options.circuitFailureThreshold === undefined
          ? {}
          : { failureThreshold: options.circuitFailureThreshold }),
        ...(options.circuitCooldownMs === undefined
          ? {}
          : { cooldownMs: options.circuitCooldownMs }),
        now: () => this.now(),
      });
  }

  get name(): string {
    return `rail:${this.options.client.rail}`;
  }

  get rail(): string {
    return this.options.client.rail;
  }

  get route(): number {
    return this.options.route;
  }

  get progress(): RailProgress | null {
    return this.lastProgress;
  }

  circuitState(): readonly ProviderCircuitSnapshot[] {
    return this.circuits.snapshot();
  }

  /** Inspect this rail's backlog without polling providers or mutating pass state. */
  inspectBacklog(
    options: Omit<InspectRailBacklogOptions, "routes" | "recheckAfterMs" | "maxCheckFailures"> = {},
  ): Promise<BacklogInspectionReport> {
    return inspectRailBacklog(this.options.db, {
      ...options,
      routes: [this.options.route],
      recheckAfterMs: this.options.recheckAfterMs,
      maxCheckFailures: this.options.maxCheckFailures,
      now: options.now ?? (() => this.now()),
    });
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
    const paused = this.circuitState();
    if (paused.length > 0) {
      return {
        name: this.name,
        state: "degraded",
        detail: `provider discovery or destination proof verification is paused for ${paused.map((circuit) => circuit.key).join(", ")}; no delivery claim is made`,
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

  /** Release any remaining claims during graceful shutdown; crashes rely on lease expiration. */
  async release(): Promise<void> {
    await releaseRailWorkLeases(this.options.db, this.ownerId);
  }

  /** One pass. Returns true when it filled a batch, which means there is more behind it. */
  async tick(signal: AbortSignal): Promise<boolean> {
    const { db, logger, batchSize, client } = this.options;
    const effective = this.effectiveSignal(signal);
    effective.throwIfAborted();

    const cooldown = this.cooldownUntil;
    if (cooldown !== null && cooldown > this.now()) return false;
    this.cooldownUntil = null;

    if (this.options.config && client.rail === "axelar") {
      if (this.options.route === RouteKind.AxelarIts || this.options.route === RouteKind.AxelarGmp)
        await abortable(
          ingestAxelarGasEvidence(this.options.config, db, batchSize, { signal: effective }),
          effective,
        );
      if (this.options.route === RouteKind.AxelarIts)
        await abortable(
          revalidateItsDeliveryProofs(this.options.config, db, batchSize, { signal: effective }),
          effective,
        );
    }

    let checked = 0;
    let settled = 0;
    let failures = 0;
    let selected = 0;
    let stoppedForCooldown = false;
    const seen: bigint[] = [];
    const destinationCounts = new Map<string, number>();
    const excludedDestinations: string[] = [];
    const maxPerDestination = Math.max(
      1,
      this.options.maxPerDestination ?? Math.ceil(batchSize / 2),
    );

    // The short claim transaction commits the lease before provider I/O. A crashed worker's claim
    // becomes available again after its bounded expiry.
    while (
      selected < batchSize &&
      !effective.aborted &&
      !this.circuits.isPaused(this.discoveryCircuitKey)
    ) {
      const claimed = await db.transaction((tx) =>
        claimPendingForRail(
          tx,
          {
            route: this.options.route,
            limit: 1,
            now: this.now(),
            notCheckedSince: new Date(this.now().getTime() - this.options.recheckAfterMs),
            maxCheckFailures: this.options.maxCheckFailures,
            excludedTransferIds: seen,
            excludedDestinationChains: excludedDestinations,
            scheduleBucket: (selected % 2) as 0 | 1,
            signal: effective,
          },
          this.ownerId,
          RAIL_WORK_LEASE_MS,
        ),
      );
      if (claimed === null) break;
      const { transfer, lease } = claimed;
      selected += 1;
      seen.push(transfer.transferId);
      const destinationCount = (destinationCounts.get(transfer.destinationChain) ?? 0) + 1;
      destinationCounts.set(transfer.destinationChain, destinationCount);
      if (destinationCount >= maxPerDestination)
        excludedDestinations.push(transfer.destinationChain);

      try {
        const outcome = await this.processTransfer(transfer, lease, effective);
        if (outcome.kind === "processed") {
          checked += 1;
          if (outcome.settled) settled += 1;
        } else {
          failures += 1;
          if (outcome.rateLimitedError !== null) {
            this.cooldownUntil = this.failureRetryAt(
              this.now(),
              transfer.retryAttempts + 1,
              outcome.rateLimitedError,
            );
            logger.warn(
              { rail: client.rail, until: this.cooldownUntil.toISOString() },
              "the rail rate limited us, holding off rather than retrying",
            );
            stoppedForCooldown = true;
          }
        }
      } catch (error) {
        if (!(error instanceof RailLeaseLostError)) throw error;
        logger.warn(
          { rail: client.rail, transferId: transfer.transferId.toString() },
          "rail work lease expired before the verification decision could be committed",
        );
      } finally {
        await releaseRailWorkLease(db, lease);
      }
      if (stoppedForCooldown) break;
    }

    effective.throwIfAborted();
    const outstanding = await outstandingForRail(db, this.options.route);
    this.lastProgress = { checked, settled, failures, outstanding, at: this.now() };

    if (checked > 0 || failures > 0) {
      logger.info(
        { rail: client.rail, checked, settled, failures, outstanding },
        "rail statuses refreshed",
      );
    }

    // A full batch means the queue is longer than one pass, so come straight back.
    return selected >= batchSize && !stoppedForCooldown && !effective.aborted;
  }

  /** Re-evaluate one reopened transfer immediately, without changing its source identity. */
  async evaluateTransfer(
    transferId: bigint,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<boolean> {
    const effective = this.effectiveSignal(signal);
    if (effective.aborted) return false;
    const cooldown = this.cooldownUntil;
    if (cooldown !== null && cooldown > this.now()) return false;
    if (this.circuits.isPaused(this.discoveryCircuitKey)) return false;
    const claimed = await this.options.db.transaction((tx) =>
      claimPendingForRail(
        tx,
        {
          route: this.options.route,
          limit: 1,
          now: this.now(),
          notCheckedSince: this.now(),
          maxCheckFailures: this.options.maxCheckFailures,
          onlyTransferId: transferId,
          signal: effective,
        },
        this.ownerId,
        RAIL_WORK_LEASE_MS,
      ),
    );
    if (claimed === null) return false;
    try {
      const outcome = await this.processTransfer(claimed.transfer, claimed.lease, effective);
      if (outcome.kind === "failed" && outcome.rateLimitedError !== null) {
        this.cooldownUntil = this.failureRetryAt(
          this.now(),
          claimed.transfer.retryAttempts + 1,
          outcome.rateLimitedError,
        );
      }
      return outcome.kind === "processed" && outcome.settled;
    } catch (error) {
      if (this.effectiveSignal(signal).aborted || error instanceof RailLeaseLostError) return false;
      throw error;
    } finally {
      await releaseRailWorkLease(this.options.db, claimed.lease);
    }
  }

  private async processTransfer(
    transfer: PendingTransfer,
    lease: RailWorkLease,
    signal: AbortSignal,
  ): Promise<TransferOutcome> {
    return this.options.db.transaction(async (tx) => {
      try {
        return { kind: "processed", settled: await this.handle(transfer, tx, signal, lease) };
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof RailLeaseLostError) throw error;
        await this.recordFailure(transfer, error, tx, lease);
        return {
          kind: "failed",
          rateLimitedError:
            error instanceof RailError && error.kind === "rateLimited" ? error : null,
        };
      }
    });
  }

  /** Returns true when the transfer reached a terminal state on this pass. */
  private async handle(
    transfer: PendingTransfer,
    db: Queryable,
    signal: AbortSignal,
    lease: RailWorkLease,
  ): Promise<boolean> {
    const at = this.now();

    if (transfer.delivered) {
      // Our own inbound index already says the money arrived, which outranks anything the rail
      // would tell us. No request, and the transfer leaves the queue for good.
      await this.write(db, transfer, lease, {
        status: "delivered",
        railStatus: null,
        reference: null,
        attestedAt: null,
        checkedAt: at,
        failures: 0,
        retryAttempts: 0,
        error: null,
        nextAttemptAt: null,
        retryClass: null,
        verificationFailure: null,
      });
      return true;
    }

    if (!this.circuits.allow(this.discoveryCircuitKey)) return false;
    let lookup: RailLookup;
    try {
      lookup = await abortable(this.options.client.look(transfer, signal), signal);
    } catch (error) {
      signal.throwIfAborted();
      this.circuits.recordFailure(
        this.discoveryCircuitKey,
        circuitReason(error, this.options.client.rail),
      );
      throw error;
    }
    this.circuits.recordSuccess(this.discoveryCircuitKey);
    signal.throwIfAborted();
    if (lookup.kind === "missing") {
      // Normal. The rail has not indexed the burn yet, which is where every transfer starts.
      await this.write(db, transfer, lease, {
        status: transfer.status ?? "pending",
        railStatus: null,
        reference: null,
        attestedAt: null,
        checkedAt: at,
        failures: 0,
        retryAttempts: 0,
        error: null,
        nextAttemptAt: this.nextCheckAt(at),
        retryClass: null,
        verificationFailure: null,
      });
      return false;
    }

    const { report } = lookup;
    if (report.quarantine && this.options.client.rail === "axelar")
      await writeAxelarQuarantine(db, {
        transferId: transfer.transferId,
        sourceTxHash: transfer.originTx,
        providerReference: report.quarantine.providerReference,
        schema: report.quarantine.schema,
        payload: report.quarantine.payload,
      });
    let diagnostics: readonly VerificationDiagnostic[] = [];
    let itsVerificationState: "receipt_unavailable" | "payout_unverified" | "verified" | null =
      null;
    let verificationFailure: CctpVerificationFailure | null = null;
    if (this.options.config) {
      const verificationOptions = { signal, logger: this.options.logger };
      const verificationKey = this.verificationCircuitKey(transfer.destinationChain);
      if (this.circuits.allow(verificationKey)) {
        try {
          const its =
            report.execution || report.forwardTxHash
              ? await abortable(
                  verifyItsDelivery(this.options.config, db, transfer, report, verificationOptions),
                  signal,
                )
              : null;
          diagnostics = its !== null && "diagnostics" in its ? its.diagnostics : [];
          itsVerificationState =
            its === null ? null : "diagnostics" in its ? its.state : "verified";
          let verified: VerifiedDelivery | null =
            its !== null && !("diagnostics" in its) ? its : null;
          if (!verified) {
            const cctp = await abortable(
              inspectCctpDelivery(this.options.config, db, transfer, report, verificationOptions),
              signal,
            );
            verified = cctp.delivery;
            verificationFailure = cctp.failure;
          }
          this.circuits.recordSuccess(verificationKey);
          if (verified) {
            signal.throwIfAborted();
            if (transfer.route === RouteKind.AxelarIts && "evidence" in verified) {
              const evidence = verified.evidence as AxelarDeliveryEvidenceRow;
              const evidenceId = await writeAxelarDeliveryEvidence(db, evidence);
              await writeInbound(db, verified.at, verified.row);
              await linkAxelarDeliveryEvidence(db, evidence, evidenceId);
            } else await writeInbound(db, verified.at, verified.row);
            signal.throwIfAborted();
            await this.write(db, transfer, lease, {
              status: "delivered",
              railStatus: report.railStatus,
              reference: report.reference,
              attestedAt: report.attestedAt,
              checkedAt: at,
              failures: 0,
              retryAttempts: 0,
              error: null,
              nextAttemptAt: null,
              retryClass: null,
              diagnostics,
              itsVerificationState,
              verificationFailure: null,
            });
            return true;
          }
        } catch (error) {
          signal.throwIfAborted();
          this.circuits.recordFailure(
            verificationKey,
            circuitReason(error, this.options.client.rail),
          );
          throw error;
        }
      }
    }
    const candidateStatus =
      verificationFailure !== null ||
      itsVerificationState === "receipt_unavailable" ||
      itsVerificationState === "payout_unverified" ||
      report.status === "delivered"
        ? "pending"
        : report.status;
    // Provider discovery may temporarily regress; only explicit proof reconciliation may reopen
    // established attestation progress.
    const status =
      transfer.status === "attested" && candidateStatus === "pending"
        ? "attested"
        : candidateStatus;
    signal.throwIfAborted();
    await this.write(db, transfer, lease, {
      status,
      railStatus: report.railStatus,
      reference: report.reference,
      attestedAt: report.attestedAt,
      checkedAt: at,
      failures: 0,
      retryAttempts: 0,
      error: null,
      nextAttemptAt: isTerminal(status) ? null : this.nextCheckAt(at),
      retryClass: null,
      diagnostics,
      itsVerificationState,
      verificationFailure,
    });
    return isTerminal(status);
  }

  private async recordFailure(
    transfer: PendingTransfer,
    error: unknown,
    db: Queryable,
    lease: RailWorkLease,
  ): Promise<void> {
    const retryable = error instanceof RailError && error.kind !== "permanent";
    const failures = retryable ? transfer.checkFailures : transfer.checkFailures + 1;
    const attempts = Math.min(transfer.retryAttempts + 1, 30);
    const permanent = error instanceof RailError && error.kind === "permanent";
    const exhausted = !permanent && !retryable && failures >= this.options.maxCheckFailures;
    const retryClass: RailRetryClass = permanent
      ? "permanent"
      : exhausted
        ? "exhausted"
        : error instanceof RailError && error.kind === "rateLimited"
          ? "rate_limited"
          : "transient";
    const reason = safeFailureReason(error);

    if (permanent || exhausted) {
      // Said out loud, because the queue is about to stop offering this transfer and a transfer
      // that quietly stops being chased is the thing somebody notices a week later.
      this.options.logger.error(
        {
          rail: this.options.client.rail,
          transferId: transfer.transferId.toString(),
          failures,
          retryClass,
        },
        permanent
          ? "this transfer lookup is permanent and requires operator recovery after the cause is corrected"
          : "this transfer exhausted automatic retries and requires operator recovery",
      );
    }

    await this.write(db, transfer, lease, {
      // Still pending, not failed. A transfer we cannot ask about is not a transfer that failed,
      // and writing `failed` here would claim the money did not move on the strength of our own
      // inability to get an answer.
      status: transfer.status ?? "pending",
      railStatus: null,
      reference: null,
      attestedAt: null,
      checkedAt: this.now(),
      failures,
      retryAttempts: attempts,
      error: reason,
      nextAttemptAt:
        retryClass === "permanent" || retryClass === "exhausted"
          ? null
          : this.failureRetryAt(this.now(), attempts, error),
      retryClass,
      verificationFailure: null,
    });
  }

  private async write(
    db: Queryable,
    transfer: PendingTransfer,
    lease: RailWorkLease,
    fields: {
      readonly status: string;
      readonly railStatus: string | null;
      readonly reference: string | null;
      readonly attestedAt: Date | null;
      readonly checkedAt: Date;
      readonly failures: number;
      readonly retryAttempts: number;
      readonly error: string | null;
      readonly nextAttemptAt: Date | null;
      readonly retryClass: RailRetryClass | null;
      readonly diagnostics?: readonly VerificationDiagnostic[];
      readonly itsVerificationState?:
        "receipt_unavailable" | "payout_unverified" | "verified" | null;
      readonly verificationFailure: CctpVerificationFailure | null;
    },
  ): Promise<void> {
    await renewRailWorkLease(db, lease, RAIL_WORK_LEASE_MS);
    await writeAttestation(db, {
      transferId: transfer.transferId,
      route: transfer.route,
      status: fields.status,
      railStatus: fields.railStatus,
      railReference: fields.reference,
      attestedAt: fields.attestedAt,
      checkedAt: fields.checkedAt,
      checkFailures: fields.failures,
      retryAttempts: fields.retryAttempts,
      lastError: fields.error,
      nextAttemptAt: fields.nextAttemptAt,
      retryClass: fields.retryClass,
      diagnostics: fields.diagnostics ?? [],
      itsVerificationState: fields.itsVerificationState ?? null,
      verificationFailure: fields.verificationFailure,
    });
  }

  private get providerCircuitIdentity(): string {
    return safeCircuitKey(this.options.client.providerId ?? this.options.client.rail);
  }

  private get discoveryCircuitKey(): string {
    return `discovery:${this.providerCircuitIdentity}`;
  }

  private verificationCircuitKey(destinationChain: string): string {
    return `proof:${this.providerCircuitIdentity}:${safeCircuitKey(destinationChain)}`;
  }

  private nextCheckAt(at: Date): Date {
    return new Date(at.getTime() + this.options.recheckAfterMs);
  }

  private failureRetryAt(at: Date, failures: number, error: unknown): Date {
    const requestedDelay =
      error instanceof RailError && error.kind === "rateLimited"
        ? (error.retryAfterMs ?? 60_000)
        : this.options.recheckAfterMs * 2 ** Math.min(failures - 1, 30);
    const finiteDelay =
      Number.isFinite(requestedDelay) && requestedDelay >= 0 ? requestedDelay : 60_000;
    const delay =
      error instanceof RailError && error.kind === "rateLimited"
        ? Math.min(Math.max(1_000, finiteDelay), 8_640_000_000_000_000 - at.getTime())
        : Math.min(Math.max(1_000, finiteDelay), MAX_RETRY_DELAY_MS);
    return new Date(at.getTime() + delay);
  }

  private effectiveSignal(signal: AbortSignal): AbortSignal {
    return combinedSignal(signal, this.options.shutdownSignal);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function circuitReason(error: unknown, rail: string): string {
  if (error instanceof RailError) {
    return `${rail}: ${error.kind === "rateLimited" ? "rate_limited" : error.kind}`;
  }
  return `${rail}: transient`;
}

function safeFailureReason(error: unknown): string {
  if (error instanceof RailError) {
    return `${error.rail} ${error.kind === "rateLimited" ? "rate_limited" : error.kind} lookup failure`;
  }
  return "lookup or delivery evidence verification failed";
}
