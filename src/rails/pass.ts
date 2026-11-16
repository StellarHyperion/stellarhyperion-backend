/**
 * One pass over the transfers waiting on one rail.
 *
 * Shaped exactly like a chain watcher's pass, and joining the same `PolledWorker` list, because
 * the lifecycle problems are identical: one at a time, catch up without sleeping, back off on
 * failure, report readiness from cached state. What differs is what a failure means, and there are
 * two kinds of backoff here rather than one.
 *
 * Per-provider circuit breakers pause repeated failing discovery lookups with bounded half-open
 * probes while leaving independent proof verification (`inbound_delivery` short-circuiting and
 * previously discovered candidate execution proof checks) available.
 */
import type { AppConfig } from "../config/config.js";
import { verifyItsDelivery, type VerifiedDelivery } from "./axelar/delivery.js";
import { verifyCctpDelivery } from "./cctp/delivery.js";
import type { Logger } from "pino";

import type { Queryable, Transactional } from "../db/pool.js";
import type { ReadinessReport } from "../runtime/readiness.js";
import { writeInbound, writeAttestation } from "../chains/writers.js";
import {
  RailCircuitBreaker,
  type RailCircuitBreakerOptions,
  type RailCircuitSnapshot,
} from "./circuit-breaker.js";
import {
  deliveredPendingForRail,
  outstandingForRail,
  pendingForRail,
  pendingTransfersByIds,
} from "./queue.js";
import {
  RailError,
  isTerminal,
  type PendingTransfer,
  type RailClient,
  type RailReport,
} from "./types.js";

const BACKLOG_MULTIPLE_BEFORE_DEGRADED = 3;
const MAX_STORED_CANDIDATES = 1_024;

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
  readonly circuitBreaker?:
    RailCircuitBreaker | Omit<RailCircuitBreakerOptions, "provider"> | undefined;
  readonly verifyCandidateDelivery?: CandidateProofVerifier | undefined;
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
  private readonly circuit: RailCircuitBreaker;
  private readonly storedCandidates = new Map<bigint, RailReport>();

  constructor(private readonly options: RailPassOptions) {
    if (options.circuitBreaker instanceof RailCircuitBreaker) {
      this.circuit = options.circuitBreaker;
    } else {
      this.circuit = new RailCircuitBreaker({
        provider: options.client.rail,
        ...options.circuitBreaker,
      });
    }
  }

  get name(): string {
    return `rail:${this.options.client.rail}`;
  }

  get route(): number {
    return this.options.route;
  }

  get progress(): RailProgress | null {
    return this.lastProgress;
  }

  circuitSnapshot(): RailCircuitSnapshot {
    return this.circuit.snapshot(this.now());
  }

  readiness(): ReadinessReport {
    const snap = this.circuit.snapshot(this.now());
    if (snap.state === "open") {
      const untilText = snap.openUntil === null ? "unknown" : snap.openUntil.toISOString();
      return {
        name: this.name,
        state: "degraded",
        detail: `provider discovery circuit is open until ${untilText} (${snap.lastError ?? "repeated provider failures"}); independent destination proof verification remains active and circuit state never implies delivery`,
      };
    }
    if (snap.state === "half_open") {
      return {
        name: this.name,
        state: "degraded",
        detail: `provider discovery circuit is half_open with ${String(snap.halfOpenProbesRemaining)} bounded probe(s) remaining; independent destination proof verification remains active and circuit state never implies delivery`,
      };
    }

    const progress = this.lastProgress;
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

  /** One pass. Returns true when it filled a batch while discovery remained available. */
  async tick(signal: AbortSignal): Promise<boolean> {
    const { db, logger, batchSize, client } = this.options;

    let checked = 0;
    let settled = 0;
    let failures = 0;
    const processedIds = new Set<bigint>();

    // 1. Independent proof path A: settle transfers that already have an inbound_delivery hop row,
    // regardless of whether the discovery provider circuit is open, half-open, or closed.
    const alreadyDelivered = await deliveredPendingForRail(db, this.options.route, batchSize);
    for (const transfer of alreadyDelivered) {
      if (isAborted(signal)) break;
      await this.settleFromInbound(transfer);
      processedIds.add(transfer.transferId);
      checked += 1;
      settled += 1;
    }

    // 2. Independent proof path B: re-verify previously discovered candidate execution/forwarding
    // reports against destination chain RPCs without calling the discovery provider.
    if (!isAborted(signal) && this.storedCandidates.size > 0) {
      const candidateIds = [...this.storedCandidates.keys()]
        .filter((id) => !processedIds.has(id))
        .slice(0, batchSize);
      const pendingCandidates = await pendingTransfersByIds(db, this.options.route, candidateIds);
      const activeIds = new Set(pendingCandidates.map((t) => t.transferId));
      for (const id of candidateIds) {
        if (!activeIds.has(id)) {
          this.storedCandidates.delete(id);
        }
      }
      for (const transfer of pendingCandidates) {
        if (isAborted(signal)) break;
        if (transfer.delivered) {
          await this.settleFromInbound(transfer);
          processedIds.add(transfer.transferId);
          checked += 1;
          settled += 1;
          continue;
        }
        const storedReport = this.storedCandidates.get(transfer.transferId);
        if (storedReport !== undefined) {
          const verified = await this.verifyDeliverySafe(transfer, storedReport);
          if (verified !== null) {
            await this.commitVerifiedDelivery(transfer, storedReport, verified);
            processedIds.add(transfer.transferId);
            checked += 1;
            settled += 1;
          }
        }
      }
    }

    // 3. Discovery lookups are gated by this rail's isolated circuit breaker.
    const initialCircuit = this.circuit.snapshot(this.now());
    if (initialCircuit.state === "open") {
      const outstanding = await outstandingForRail(db, this.options.route);
      this.lastProgress = { checked, settled, failures, outstanding, at: this.now() };
      return false;
    }

    const queue = await pendingForRail(db, {
      route: this.options.route,
      limit: batchSize,
      notCheckedSince: new Date(this.now().getTime() - this.options.recheckAfterMs),
      maxCheckFailures: this.options.maxCheckFailures,
    });

    for (const transfer of queue) {
      if (isAborted(signal)) break;
      if (processedIds.has(transfer.transferId)) continue;

      if (transfer.delivered) {
        await this.settleFromInbound(transfer);
        checked += 1;
        settled += 1;
        continue;
      }

      const permit = this.circuit.tryAcquireDiscoveryPermit(this.now());
      if (!permit.allowed) {
        // Bounded half-open probe limit reached or circuit tripped open mid-pass; continue scanning
        // remaining batch entries only for independent inbound_delivery settlements.
        continue;
      }

      try {
        if (await this.handleDiscovery(transfer, signal)) settled += 1;
        checked += 1;
      } catch (error) {
        failures += 1;
        await this.handleLookupError(transfer, error, permit.mode);
      }
    }

    const outstanding = await outstandingForRail(db, this.options.route);
    this.lastProgress = { checked, settled, failures, outstanding, at: this.now() };

    if (checked > 0 || failures > 0) {
      logger.info(
        {
          rail: client.rail,
          checked,
          settled,
          failures,
          outstanding,
          circuitState: this.circuit.snapshot(this.now()).state,
        },
        "rail statuses refreshed",
      );
    }

    const endCircuit = this.circuit.snapshot(this.now());
    return endCircuit.state === "closed" && queue.length >= batchSize;
  }

  private async settleFromInbound(transfer: PendingTransfer): Promise<void> {
    this.storedCandidates.delete(transfer.transferId);
    await this.write(transfer, {
      status: "delivered",
      railStatus: transfer.railStatus ?? null,
      reference: transfer.railReference ?? null,
      attestedAt: transfer.attestedAt ?? null,
      checkedAt: this.now(),
      failures: 0,
      error: null,
    });
  }

  private async handleDiscovery(transfer: PendingTransfer, signal: AbortSignal): Promise<boolean> {
    const at = this.now();
    const lookup = await this.options.client.look(transfer, signal);
    this.circuit.recordSuccess(this.now());

    if (lookup.kind === "missing") {
      // Preserve any previously stored status/reference/attestedAt so probe recovery against a
      // lagging provider replica never erases stored evidence.
      await this.write(transfer, {
        status: transfer.status ?? "pending",
        railStatus: transfer.railStatus ?? null,
        reference: transfer.railReference ?? null,
        attestedAt: transfer.attestedAt ?? null,
        checkedAt: at,
        failures: 0,
        error: null,
      });
      return false;
    }

    const { report } = lookup;
    if (report.execution !== undefined || report.forwardTxHash !== undefined) {
      this.rememberCandidate(transfer.transferId, report);
      const verified = await this.verifyDeliverySafe(transfer, report);
      if (verified !== null) {
        await this.commitVerifiedDelivery(transfer, report, verified);
        return true;
      }
    }

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

  private rememberCandidate(transferId: bigint, report: RailReport): void {
    if (this.storedCandidates.has(transferId)) {
      this.storedCandidates.delete(transferId);
    } else if (this.storedCandidates.size >= MAX_STORED_CANDIDATES) {
      const oldest = this.storedCandidates.keys().next().value;
      if (oldest !== undefined) {
        this.storedCandidates.delete(oldest);
      }
    }
    this.storedCandidates.set(transferId, report);
  }

  private async verifyDeliverySafe(
    transfer: PendingTransfer,
    report: RailReport,
  ): Promise<VerifiedDelivery | null> {
    try {
      if (this.options.verifyCandidateDelivery !== undefined) {
        return await this.options.verifyCandidateDelivery(transfer, report);
      }
      if (this.options.config === undefined) return null;
      return (
        (await verifyItsDelivery(this.options.config, this.options.db, transfer, report)) ??
        (await verifyCctpDelivery(this.options.config, this.options.db, transfer, report))
      );
    } catch (error) {
      // Destination RPC errors are independent of the rail discovery provider and must not trip the
      // discovery circuit breaker or block other destinations.
      const reason = error instanceof Error ? error.message : String(error);
      this.options.logger.warn(
        {
          rail: this.options.client.rail,
          transferId: transfer.transferId.toString(),
          destinationChain: transfer.destinationChain,
          reason,
        },
        "destination proof verification encountered an error; keeping candidate for retry",
      );
      return null;
    }
  }

  private async commitVerifiedDelivery(
    transfer: PendingTransfer,
    report: RailReport,
    verified: VerifiedDelivery,
  ): Promise<void> {
    const checkedAt = this.now();
    this.storedCandidates.delete(transfer.transferId);
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
  }

  private async handleLookupError(
    transfer: PendingTransfer,
    error: unknown,
    mode: "normal" | "probe",
  ): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    const permanent = error instanceof RailError && error.kind === "permanent";

    if (permanent) {
      // A malformed or unsupported domain on one transfer is not a provider outage; do not trip
      // the provider circuit breaker.
      await this.recordPerTransferFailure(transfer, reason, true);
      return;
    }

    const retryAfterMs = error instanceof RailError ? error.retryAfterMs : null;
    const snap = this.circuit.recordProviderFailure(this.now(), reason, retryAfterMs);

    if (snap.state === "open") {
      this.options.logger.warn(
        {
          rail: this.options.client.rail,
          openUntil: snap.openUntil?.toISOString() ?? null,
          consecutiveFailures: snap.consecutiveFailures,
          probeMode: mode,
        },
        "provider discovery circuit opened; pausing discovery lookups while keeping independent proof verification active",
      );
    }

    // Do not increment per-transfer check_failures on half-open probe failures or once the provider
    // circuit has opened, and never overwrite stored evidence fields.
    if (mode === "probe" || snap.state === "open") {
      if (transfer.status !== null) {
        await this.write(transfer, {
          status: transfer.status,
          railStatus: transfer.railStatus ?? null,
          reference: transfer.railReference ?? null,
          attestedAt: transfer.attestedAt ?? null,
          checkedAt: this.now(),
          failures: transfer.checkFailures,
          error: snap.lastError,
        });
      }
      return;
    }

    await this.recordPerTransferFailure(transfer, snap.lastError ?? reason, false);
  }

  private async recordPerTransferFailure(
    transfer: PendingTransfer,
    reason: string,
    permanent: boolean,
  ): Promise<void> {
    const failures = transfer.checkFailures + 1;

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

    await this.write(transfer, {
      status: transfer.status ?? "pending",
      railStatus: transfer.railStatus ?? null,
      reference: transfer.railReference ?? null,
      attestedAt: transfer.attestedAt ?? null,
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
