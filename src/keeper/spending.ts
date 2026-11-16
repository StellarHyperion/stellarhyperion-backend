import type { Logger } from "pino";
import type { KeeperSpendingCapConfig } from "../config/config.js";

const SECRET_SEED_PATTERN = /\bS[A-Z2-7]{55}\b/g;
const URL_CREDENTIAL_PATTERN = /([a-z][a-z0-9+.-]*:\/\/[^:/@\s]+:)([^@\s]+)(@)/gi;

export function sanitizeSpendDiagnostic(text: string): string {
  return text
    .replace(SECRET_SEED_PATTERN, "[REDACTED_STELLAR_SECRET]")
    .replace(URL_CREDENTIAL_PATTERN, "$1[REDACTED]$3");
}

export type SpendingWindowKind = "utc-day" | "ledger-window";

export type SpendingCapAuditAction =
  "cap_paused" | "manual_reset" | "cap_override" | "window_rollover";

export interface SignerSpendingSnapshot {
  readonly signerPublicKey: string;
  readonly windowKind: SpendingWindowKind;
  readonly windowId: string;
  readonly confirmedStroops: string;
  readonly failedStroops: string;
  readonly reservedStroops: string;
  readonly totalCommittedStroops: string;
  readonly baseCapStroops: string;
  readonly overrideCapStroops: string | null;
  readonly effectiveCapStroops: string;
  readonly remainingStroops: string;
  readonly confirmedCount: number;
  readonly failedCount: number;
  readonly paused: boolean;
  readonly pauseReason: string | null;
}

export interface SpendingCapAuditEntry {
  readonly sequence: number;
  readonly timestamp: string;
  readonly action: SpendingCapAuditAction;
  readonly signerPublicKey: string;
  readonly windowKind: SpendingWindowKind;
  readonly windowId: string;
  readonly actor: string;
  readonly reason: string;
  readonly previousConfirmedStroops: string;
  readonly previousFailedStroops: string;
  readonly previousEffectiveCapStroops: string;
  readonly nextEffectiveCapStroops: string;
  readonly pausedAfter: boolean;
}

export class KeeperSpendingCapExceededError extends Error {
  readonly signerPublicKey: string;
  readonly windowId: string;
  readonly requestedFeeStroops: bigint;
  readonly committedStroops: bigint;
  readonly effectiveCapStroops: bigint;

  constructor(input: {
    readonly signerPublicKey: string;
    readonly windowId: string;
    readonly requestedFeeStroops: bigint;
    readonly committedStroops: bigint;
    readonly effectiveCapStroops: bigint;
    readonly reason: string;
  }) {
    super(sanitizeSpendDiagnostic(input.reason));
    this.name = "KeeperSpendingCapExceededError";
    this.signerPublicKey = input.signerPublicKey;
    this.windowId = input.windowId;
    this.requestedFeeStroops = input.requestedFeeStroops;
    this.committedStroops = input.committedStroops;
    this.effectiveCapStroops = input.effectiveCapStroops;
  }
}

interface MutableSignerWindowState {
  signerPublicKey: string;
  windowKind: SpendingWindowKind;
  windowId: string;
  confirmedStroops: bigint;
  failedStroops: bigint;
  reservedStroops: bigint;
  baseCapStroops: bigint;
  overrideCapStroops: bigint | null;
  confirmedCount: number;
  failedCount: number;
  paused: boolean;
  pauseReason: string | null;
}

export interface ReserveSpendInput {
  readonly signerPublicKey: string;
  readonly feeStroops: bigint;
  readonly operation: string;
  readonly now?: Date;
  readonly ledger?: number;
  readonly logger?: Logger;
}

export interface SpendReservationTicket {
  readonly signerPublicKey: string;
  readonly windowId: string;
  reservedFeeStroops: bigint;
  settled: boolean;
}

export interface ResetSpendingCapInput {
  readonly signerPublicKey: string;
  readonly actor: string;
  readonly reason: string;
  readonly now?: Date;
  readonly ledger?: number;
  readonly logger?: Logger;
}

export interface OverrideSpendingCapInput {
  readonly signerPublicKey: string;
  readonly actor: string;
  readonly reason: string;
  readonly newCapStroops?: bigint;
  readonly additionalStroops?: bigint;
  readonly now?: Date;
  readonly ledger?: number;
  readonly logger?: Logger;
}

export function computeSpendingWindow(
  policy: KeeperSpendingCapConfig,
  options: { readonly now?: Date; readonly ledger?: number } = {},
): { readonly kind: SpendingWindowKind; readonly id: string } {
  if (policy.windowLedgers !== null) {
    const ledger = options.ledger ?? 0;
    const bucket = Math.floor(Math.max(0, ledger) / policy.windowLedgers);
    return {
      kind: "ledger-window",
      id: `ledger:${String(policy.windowLedgers)}:${String(bucket)}`,
    };
  }
  const day = (options.now ?? new Date()).toISOString().slice(0, 10);
  return {
    kind: "utc-day",
    id: `utc:${day}`,
  };
}

export class KeeperSpendingTracker {
  private readonly states = new Map<string, MutableSignerWindowState>();
  private readonly auditEntries: SpendingCapAuditEntry[] = [];
  private readonly maxAuditEntries: number;
  private auditSeq = 0;

  constructor(
    private readonly policy: KeeperSpendingCapConfig,
    options: { readonly maxAuditEntries?: number } = {},
  ) {
    this.maxAuditEntries = options.maxAuditEntries ?? 500;
  }

  private effectiveCapOf(state: MutableSignerWindowState): bigint {
    return state.overrideCapStroops ?? state.baseCapStroops;
  }

  private totalCommittedOf(state: MutableSignerWindowState): bigint {
    return state.confirmedStroops + state.failedStroops + state.reservedStroops;
  }

  private toSnapshot(state: MutableSignerWindowState): SignerSpendingSnapshot {
    const effective = this.effectiveCapOf(state);
    const committed = this.totalCommittedOf(state);
    const remaining = effective > committed ? effective - committed : 0n;
    return {
      signerPublicKey: state.signerPublicKey,
      windowKind: state.windowKind,
      windowId: state.windowId,
      confirmedStroops: String(state.confirmedStroops),
      failedStroops: String(state.failedStroops),
      reservedStroops: String(state.reservedStroops),
      totalCommittedStroops: String(committed),
      baseCapStroops: String(state.baseCapStroops),
      overrideCapStroops:
        state.overrideCapStroops !== null ? String(state.overrideCapStroops) : null,
      effectiveCapStroops: String(effective),
      remainingStroops: String(remaining),
      confirmedCount: state.confirmedCount,
      failedCount: state.failedCount,
      paused: state.paused,
      pauseReason: state.pauseReason,
    };
  }

  private appendAudit(
    entry: Omit<SpendingCapAuditEntry, "sequence">,
    logger?: Logger,
  ): SpendingCapAuditEntry {
    this.auditSeq += 1;
    const record: SpendingCapAuditEntry = Object.freeze({
      sequence: this.auditSeq,
      ...entry,
      actor: sanitizeSpendDiagnostic(entry.actor),
      reason: sanitizeSpendDiagnostic(entry.reason),
    });
    this.auditEntries.push(record);
    while (this.auditEntries.length > this.maxAuditEntries) {
      this.auditEntries.shift();
    }
    logger?.info({ spendingAudit: record }, `keeper spending cap ${record.action}`);
    return record;
  }

  private ensureSignerState(
    signerPublicKey: string,
    options: { readonly now?: Date; readonly ledger?: number; readonly logger?: Logger } = {},
  ): MutableSignerWindowState {
    const existing = this.states.get(signerPublicKey);
    if (existing && this.policy.windowLedgers !== null && options.ledger === undefined) {
      return existing;
    }
    const windowSpec = computeSpendingWindow(this.policy, options);
    if (!existing) {
      const created: MutableSignerWindowState = {
        signerPublicKey,
        windowKind: windowSpec.kind,
        windowId: windowSpec.id,
        confirmedStroops: 0n,
        failedStroops: 0n,
        reservedStroops: 0n,
        baseCapStroops: this.policy.dailyCapStroops,
        overrideCapStroops: null,
        confirmedCount: 0,
        failedCount: 0,
        paused: false,
        pauseReason: null,
      };
      this.states.set(signerPublicKey, created);
      return created;
    }

    if (existing.windowId !== windowSpec.id) {
      const prevCap = this.effectiveCapOf(existing);
      const prevConfirmed = existing.confirmedStroops;
      const prevFailed = existing.failedStroops;
      const prevWindowId = existing.windowId;

      existing.windowKind = windowSpec.kind;
      existing.windowId = windowSpec.id;
      existing.confirmedStroops = 0n;
      existing.failedStroops = 0n;
      existing.reservedStroops = 0n;
      existing.baseCapStroops = this.policy.dailyCapStroops;
      existing.overrideCapStroops = null;
      existing.confirmedCount = 0;
      existing.failedCount = 0;
      existing.paused = false;
      existing.pauseReason = null;

      this.appendAudit(
        {
          timestamp: (options.now ?? new Date()).toISOString(),
          action: "window_rollover",
          signerPublicKey,
          windowKind: windowSpec.kind,
          windowId: windowSpec.id,
          actor: "system",
          reason: `rolled over from ${prevWindowId} to ${windowSpec.id}`,
          previousConfirmedStroops: String(prevConfirmed),
          previousFailedStroops: String(prevFailed),
          previousEffectiveCapStroops: String(prevCap),
          nextEffectiveCapStroops: String(existing.baseCapStroops),
          pausedAfter: false,
        },
        options.logger,
      );
    }

    return existing;
  }

  snapshot(
    signerPublicKey: string,
    options: { readonly now?: Date; readonly ledger?: number } = {},
  ): SignerSpendingSnapshot {
    return this.toSnapshot(this.ensureSignerState(signerPublicKey, options));
  }

  allSnapshots(): readonly SignerSpendingSnapshot[] {
    return [...this.states.values()].map((state) => this.toSnapshot(state));
  }

  auditTrail(signerPublicKey?: string): readonly SpendingCapAuditEntry[] {
    if (signerPublicKey === undefined) {
      return [...this.auditEntries];
    }
    return this.auditEntries.filter((entry) => entry.signerPublicKey === signerPublicKey);
  }

  isPaused(
    signerPublicKey: string,
    options: { readonly now?: Date; readonly ledger?: number } = {},
  ): boolean {
    return this.ensureSignerState(signerPublicKey, options).paused;
  }

  reserveFee(input: ReserveSpendInput): SpendReservationTicket {
    if (input.feeStroops <= 0n) {
      throw new Error("Keeper fee reservation must be a positive stroop integer.");
    }
    const state = this.ensureSignerState(input.signerPublicKey, {
      ...(input.now !== undefined ? { now: input.now } : {}),
      ...(input.ledger !== undefined ? { ledger: input.ledger } : {}),
      ...(input.logger !== undefined ? { logger: input.logger } : {}),
    });

    const effectiveCap = this.effectiveCapOf(state);
    const committed = this.totalCommittedOf(state);

    if (input.feeStroops > this.policy.maxSingleTxFeeStroops) {
      const reason = `operation ${input.operation} fee ${String(input.feeStroops)} stroops exceeds per-transaction cap ${String(this.policy.maxSingleTxFeeStroops)} stroops`;
      throw new KeeperSpendingCapExceededError({
        signerPublicKey: input.signerPublicKey,
        windowId: state.windowId,
        requestedFeeStroops: input.feeStroops,
        committedStroops: committed,
        effectiveCapStroops: effectiveCap,
        reason,
      });
    }

    if (state.paused || committed + input.feeStroops > effectiveCap) {
      const reason =
        state.pauseReason ??
        `signer ${input.signerPublicKey} spending cap reached in ${state.windowId}: committed ${String(committed)} + ${String(input.feeStroops)} > ${String(effectiveCap)} stroops`;
      if (!state.paused) {
        state.paused = true;
        state.pauseReason = reason;
        this.appendAudit(
          {
            timestamp: (input.now ?? new Date()).toISOString(),
            action: "cap_paused",
            signerPublicKey: input.signerPublicKey,
            windowKind: state.windowKind,
            windowId: state.windowId,
            actor: "system",
            reason,
            previousConfirmedStroops: String(state.confirmedStroops),
            previousFailedStroops: String(state.failedStroops),
            previousEffectiveCapStroops: String(effectiveCap),
            nextEffectiveCapStroops: String(effectiveCap),
            pausedAfter: true,
          },
          input.logger,
        );
      }
      throw new KeeperSpendingCapExceededError({
        signerPublicKey: input.signerPublicKey,
        windowId: state.windowId,
        requestedFeeStroops: input.feeStroops,
        committedStroops: committed,
        effectiveCapStroops: effectiveCap,
        reason,
      });
    }

    state.reservedStroops += input.feeStroops;
    return {
      signerPublicKey: input.signerPublicKey,
      windowId: state.windowId,
      reservedFeeStroops: input.feeStroops,
      settled: false,
    };
  }

  adjustReservedFee(
    ticket: SpendReservationTicket,
    actualPreparedFeeStroops: bigint,
    options: { readonly now?: Date; readonly logger?: Logger } = {},
  ): SpendReservationTicket {
    if (ticket.settled) {
      return ticket;
    }
    const state = this.states.get(ticket.signerPublicKey);
    if (state?.windowId !== ticket.windowId) {
      return ticket;
    }
    if (actualPreparedFeeStroops <= ticket.reservedFeeStroops) {
      const refund = ticket.reservedFeeStroops - actualPreparedFeeStroops;
      state.reservedStroops = state.reservedStroops > refund ? state.reservedStroops - refund : 0n;
      ticket.reservedFeeStroops = actualPreparedFeeStroops;
      return ticket;
    }

    const delta = actualPreparedFeeStroops - ticket.reservedFeeStroops;
    const effectiveCap = this.effectiveCapOf(state);
    const committedWithoutTicket =
      state.confirmedStroops +
      state.failedStroops +
      (state.reservedStroops - ticket.reservedFeeStroops);

    if (actualPreparedFeeStroops > this.policy.maxSingleTxFeeStroops) {
      state.reservedStroops -= ticket.reservedFeeStroops;
      ticket.settled = true;
      throw new KeeperSpendingCapExceededError({
        signerPublicKey: ticket.signerPublicKey,
        windowId: state.windowId,
        requestedFeeStroops: actualPreparedFeeStroops,
        committedStroops: committedWithoutTicket,
        effectiveCapStroops: effectiveCap,
        reason: `prepared fee ${String(actualPreparedFeeStroops)} stroops exceeds per-transaction cap ${String(this.policy.maxSingleTxFeeStroops)} stroops`,
      });
    }

    if (committedWithoutTicket + actualPreparedFeeStroops > effectiveCap) {
      state.reservedStroops -= ticket.reservedFeeStroops;
      ticket.settled = true;
      const reason = `signer ${ticket.signerPublicKey} spending cap reached in ${state.windowId}: committed ${String(committedWithoutTicket)} + ${String(actualPreparedFeeStroops)} > ${String(effectiveCap)} stroops`;
      if (!state.paused) {
        state.paused = true;
        state.pauseReason = reason;
        this.appendAudit(
          {
            timestamp: (options.now ?? new Date()).toISOString(),
            action: "cap_paused",
            signerPublicKey: ticket.signerPublicKey,
            windowKind: state.windowKind,
            windowId: state.windowId,
            actor: "system",
            reason,
            previousConfirmedStroops: String(state.confirmedStroops),
            previousFailedStroops: String(state.failedStroops),
            previousEffectiveCapStroops: String(effectiveCap),
            nextEffectiveCapStroops: String(effectiveCap),
            pausedAfter: true,
          },
          options.logger,
        );
      }
      throw new KeeperSpendingCapExceededError({
        signerPublicKey: ticket.signerPublicKey,
        windowId: state.windowId,
        requestedFeeStroops: actualPreparedFeeStroops,
        committedStroops: committedWithoutTicket,
        effectiveCapStroops: effectiveCap,
        reason,
      });
    }

    state.reservedStroops += delta;
    ticket.reservedFeeStroops = actualPreparedFeeStroops;
    return ticket;
  }

  commitConfirmed(
    ticket: SpendReservationTicket,
    actualFeeStroops?: bigint,
    options: { readonly now?: Date; readonly logger?: Logger } = {},
  ): void {
    if (ticket.settled) return;
    ticket.settled = true;
    const state = this.states.get(ticket.signerPublicKey);
    if (state?.windowId !== ticket.windowId) return;

    state.reservedStroops =
      state.reservedStroops >= ticket.reservedFeeStroops
        ? state.reservedStroops - ticket.reservedFeeStroops
        : 0n;
    const charged = actualFeeStroops ?? ticket.reservedFeeStroops;
    state.confirmedStroops += charged;
    state.confirmedCount += 1;
    this.pauseIfExhausted(state, options);
  }

  commitFailed(
    ticket: SpendReservationTicket,
    chargedFeeStroops?: bigint,
    options: { readonly now?: Date; readonly logger?: Logger } = {},
  ): void {
    if (ticket.settled) return;
    ticket.settled = true;
    const state = this.states.get(ticket.signerPublicKey);
    if (state?.windowId !== ticket.windowId) return;

    state.reservedStroops =
      state.reservedStroops >= ticket.reservedFeeStroops
        ? state.reservedStroops - ticket.reservedFeeStroops
        : 0n;
    const charged = chargedFeeStroops ?? ticket.reservedFeeStroops;
    state.failedStroops += charged;
    state.failedCount += 1;
    this.pauseIfExhausted(state, options);
  }

  releaseAbortedBeforeSign(ticket: SpendReservationTicket): void {
    if (ticket.settled) return;
    ticket.settled = true;
    const state = this.states.get(ticket.signerPublicKey);
    if (state?.windowId !== ticket.windowId) return;
    state.reservedStroops =
      state.reservedStroops >= ticket.reservedFeeStroops
        ? state.reservedStroops - ticket.reservedFeeStroops
        : 0n;
  }

  private pauseIfExhausted(
    state: MutableSignerWindowState,
    options: { readonly now?: Date; readonly logger?: Logger },
  ): void {
    const effective = this.effectiveCapOf(state);
    const committed = this.totalCommittedOf(state);
    if (!state.paused && committed >= effective) {
      const reason = `signer ${state.signerPublicKey} exhausted operational spending cap (${String(committed)} / ${String(effective)} stroops) in ${state.windowId}`;
      state.paused = true;
      state.pauseReason = reason;
      this.appendAudit(
        {
          timestamp: (options.now ?? new Date()).toISOString(),
          action: "cap_paused",
          signerPublicKey: state.signerPublicKey,
          windowKind: state.windowKind,
          windowId: state.windowId,
          actor: "system",
          reason,
          previousConfirmedStroops: String(state.confirmedStroops),
          previousFailedStroops: String(state.failedStroops),
          previousEffectiveCapStroops: String(effective),
          nextEffectiveCapStroops: String(effective),
          pausedAfter: true,
        },
        options.logger,
      );
    }
  }

  resetSignerCap(input: ResetSpendingCapInput): SpendingCapAuditEntry {
    const actor = input.actor.trim();
    const reason = input.reason.trim();
    if (actor === "" || reason === "") {
      throw new Error("Spending cap reset requires non-empty actor and reason.");
    }
    const state = this.ensureSignerState(input.signerPublicKey, {
      ...(input.now !== undefined ? { now: input.now } : {}),
      ...(input.ledger !== undefined ? { ledger: input.ledger } : {}),
      ...(input.logger !== undefined ? { logger: input.logger } : {}),
    });
    const prevConfirmed = state.confirmedStroops;
    const prevFailed = state.failedStroops;
    const prevCap = this.effectiveCapOf(state);

    state.confirmedStroops = 0n;
    state.failedStroops = 0n;
    state.reservedStroops = 0n;
    state.confirmedCount = 0;
    state.failedCount = 0;
    state.overrideCapStroops = null;
    state.paused = false;
    state.pauseReason = null;

    return this.appendAudit(
      {
        timestamp: (input.now ?? new Date()).toISOString(),
        action: "manual_reset",
        signerPublicKey: input.signerPublicKey,
        windowKind: state.windowKind,
        windowId: state.windowId,
        actor,
        reason,
        previousConfirmedStroops: String(prevConfirmed),
        previousFailedStroops: String(prevFailed),
        previousEffectiveCapStroops: String(prevCap),
        nextEffectiveCapStroops: String(state.baseCapStroops),
        pausedAfter: false,
      },
      input.logger,
    );
  }

  overrideSignerCap(input: OverrideSpendingCapInput): SpendingCapAuditEntry {
    const actor = input.actor.trim();
    const reason = input.reason.trim();
    if (actor === "" || reason === "") {
      throw new Error("Spending cap override requires non-empty actor and reason.");
    }
    const state = this.ensureSignerState(input.signerPublicKey, {
      ...(input.now !== undefined ? { now: input.now } : {}),
      ...(input.ledger !== undefined ? { ledger: input.ledger } : {}),
      ...(input.logger !== undefined ? { logger: input.logger } : {}),
    });
    const prevCap = this.effectiveCapOf(state);
    let nextCap: bigint;
    if (input.newCapStroops !== undefined) {
      if (input.newCapStroops <= 0n) {
        throw new Error("Override newCapStroops must be positive.");
      }
      nextCap = input.newCapStroops;
    } else if (input.additionalStroops !== undefined && input.additionalStroops > 0n) {
      nextCap = prevCap + input.additionalStroops;
    } else {
      throw new Error(
        "Spending cap override requires positive newCapStroops or additionalStroops.",
      );
    }

    state.overrideCapStroops = nextCap;
    const committed = this.totalCommittedOf(state);
    if (committed < nextCap) {
      state.paused = false;
      state.pauseReason = null;
    } else {
      state.paused = true;
      state.pauseReason = `committed spending ${String(committed)} stroops still meets or exceeds override cap ${String(nextCap)} stroops`;
    }

    return this.appendAudit(
      {
        timestamp: (input.now ?? new Date()).toISOString(),
        action: "cap_override",
        signerPublicKey: input.signerPublicKey,
        windowKind: state.windowKind,
        windowId: state.windowId,
        actor,
        reason,
        previousConfirmedStroops: String(state.confirmedStroops),
        previousFailedStroops: String(state.failedStroops),
        previousEffectiveCapStroops: String(prevCap),
        nextEffectiveCapStroops: String(nextCap),
        pausedAfter: state.paused,
      },
      input.logger,
    );
  }
}
