/**
 * Bounded runtime budget for scheduled catch-up runs.
 *
 * A hosted catch-up job (for example the testnet indexer workflow) has a fixed wall-clock
 * budget before the platform sends SIGTERM. This tracker divides that budget among the stages
 * of one run so a slow stage cannot consume the entire shutdown safety margin, committed
 * progress survives budget expiration, and the run reports why it stopped and what remains
 * eligible.
 *
 * Stages run in order: migrations, source scans, proof polling, graceful drain. Each stage
 * receives a fraction of the remaining budget. When a stage's slice expires the run moves to
 * the next stage; work already committed to the database is not rolled back.
 */

export type BudgetStage = "migrations" | "source-scans" | "proof-polling" | "graceful-drain";

/** Fraction of the remaining budget each stage may consume. */
const STAGE_FRACTION: Readonly<Record<BudgetStage, number>> = {
  "migrations": 0.10,
  "source-scans": 0.60,
  "proof-polling": 0.20,
  "graceful-drain": 0.10,
};

export interface BudgetSnapshot {
  readonly stage: BudgetStage;
  readonly stageStartedAt: number;
  readonly stageBudgetMs: number;
  readonly stageElapsedMs: number;
  readonly stageRemainingMs: number;
  readonly totalBudgetMs: number;
  readonly totalElapsedMs: number;
  readonly totalRemainingMs: number;
  readonly expired: boolean;
}

/** Thrown by `stageBudget` when the current stage's slice is exhausted. */
export class StageBudgetExpiredError extends Error {
  constructor(readonly stage: BudgetStage) {
    super(`catch-up budget expired for stage ${stage}`);
    this.name = "StageBudgetExpiredError";
  }
}

/** Thrown by `runBudget` when the total budget is exhausted. */
export class TotalBudgetExpiredError extends Error {
  constructor() {
    super("catch-up total budget expired");
    this.name = "TotalBudgetExpiredError";
  }
}

export class BudgetTracker {
  private readonly totalBudgetMs: number;
  private readonly startedAt: number;
  private stage: BudgetStage = "migrations";
  private stageStartedAt: number = Date.now();

  constructor(totalBudgetMs: number) {
    this.totalBudgetMs = totalBudgetMs;
    this.startedAt = Date.now();
  }

  /** Advance to the next stage. Returns false when there are no more stages. */
  advanceStage(): boolean {
    const order: BudgetStage[] = [
      "migrations",
      "source-scans",
      "proof-polling",
      "graceful-drain",
    ];
    const index = order.indexOf(this.stage);
    if (index < 0 || index === order.length - 1) return false;
    this.stage = order[index + 1];
    this.stageStartedAt = Date.now();
    return true;
  }

  /** The current stage. */
  get currentStage(): BudgetStage {
    return this.stage;
  }

  /**
   * Assert the current stage still has budget. Call at the start of each unit of work within a
   * stage. Throws `StageBudgetExpiredError` when the stage slice is exhausted, which moves the
   * run to the next stage without rolling back anything already committed.
   */
  stageBudget(): void {
    const now = Date.now();
    const snapshot = this.snapshot(now);
    if (snapshot.stageRemainingMs <= 0) {
      throw new StageBudgetExpiredError(this.stage);
    }
  }

  /**
   * Assert the total budget is not yet exhausted. Call before starting any new stage of work.
   * Throws `TotalBudgetExpiredError` when the run's wall-clock budget is gone.
   */
  runBudget(): void {
    const now = Date.now();
    const snapshot = this.snapshot(now);
    if (snapshot.totalRemainingMs <= 0) {
      throw new TotalBudgetExpiredError();
    }
  }

  /** A snapshot of remaining budget for reporting and logging. */
  snapshot(now: number = Date.now()): BudgetSnapshot {
    const stageBudgetMs = Math.floor(
      this.totalBudgetMs * STAGE_FRACTION[this.stage],
    );
    const stageElapsedMs = now - this.stageStartedAt;
    const stageRemainingMs = Math.max(0, stageBudgetMs - stageElapsedMs);
    const totalElapsedMs = now - this.startedAt;
    const totalRemainingMs = Math.max(0, this.totalBudgetMs - totalElapsedMs);
    return {
      stage: this.stage,
      stageStartedAt: this.stageStartedAt,
      stageBudgetMs,
      stageElapsedMs,
      stageRemainingMs,
      totalBudgetMs: this.totalBudgetMs,
      totalElapsedMs,
      totalRemainingMs,
      expired: totalRemainingMs <= 0,
    };
  }

  /** A human readable reason the run stopped, and what remains eligible. */
  stopReason(now: number = Date.now()): string {
    const snapshot = this.snapshot(now);
    if (snapshot.expired) {
      return `stopped after ${Math.round(snapshot.totalElapsedMs / 1000)}s: total catch-up budget exhausted; ${snapshot.stage} was in progress and its slice is spent`;
    }
    return `stopped after ${Math.round(snapshot.totalElapsedMs / 1000)}s: ${this.stage} budget exhausted; remaining stages eligible on the next run`;
  }
}
