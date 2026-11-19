export type BudgetStage = "migrations" | "source-scans" | "proof-polling" | "graceful-drain";
const ORDER: BudgetStage[] = ["migrations", "source-scans", "proof-polling", "graceful-drain"];
const FRACTION: Record<BudgetStage, number> = {
  migrations: 0.1,
  "source-scans": 0.6,
  "proof-polling": 0.2,
  "graceful-drain": 0.1,
};
export class BudgetTracker {
  private readonly startedAt: number;
  private stage: BudgetStage = "migrations";
  private stageStartedAt: number;
  constructor(
    private readonly totalBudgetMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(totalBudgetMs) || totalBudgetMs < 1 || totalBudgetMs > 3600000)
      throw new RangeError("Invalid catch-up budget");
    this.startedAt = now();
    this.stageStartedAt = this.startedAt;
  }
  get currentStage() {
    return this.stage;
  }
  advanceStage(): boolean {
    const index = ORDER.indexOf(this.stage);
    if (index === ORDER.length - 1) return false;
    const next = ORDER[index + 1];
    if (next === undefined) return false;
    this.stage = next;
    this.stageStartedAt = this.now();
    return true;
  }
  snapshot(now = this.now()) {
    const totalElapsedMs = Math.max(0, now - this.startedAt);
    const totalRemainingMs = Math.max(0, this.totalBudgetMs - totalElapsedMs);
    const stageBudgetMs = Math.floor(this.totalBudgetMs * FRACTION[this.stage]);
    const stageElapsedMs = Math.max(0, now - this.stageStartedAt);
    const reserve = this.stage === "graceful-drain" ? 0 : Math.ceil(this.totalBudgetMs * 0.1);
    const stageRemainingMs = Math.min(
      Math.max(0, stageBudgetMs - stageElapsedMs),
      Math.max(0, totalRemainingMs - reserve),
    );
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
  stageBudget() {
    if (this.snapshot().stageRemainingMs <= 0)
      throw new Error(`catch-up stage ${this.stage} exhausted`);
  }
  runBudget() {
    if (this.snapshot().expired) throw new Error("catch-up total budget exhausted");
  }
  stopReason() {
    return `scheduled ${this.stage} completed or exhausted; committed progress is retained; pending source scans/proofs remain eligible next run`;
  }
}
interface BudgetWorker {
  readonly name: string;
  start(): void;
  stop(): Promise<void>;
}
export async function runBudgetedCatchUp(
  workers: readonly BudgetWorker[],
  totalBudgetMs: number,
  drain: (reason: string) => Promise<void>,
): Promise<void> {
  const budget = new BudgetTracker(totalBudgetMs);
  const sources = workers.filter(
    (worker) => !worker.name.startsWith("rail:") && !worker.name.startsWith("keeper"),
  );
  const proofs = workers.filter((worker) => worker.name.startsWith("rail:"));
  const bounded = async (work: Promise<void>, ms: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        work,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, ms));
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  try {
    for (const group of [sources, proofs]) {
      budget.advanceStage();
      if (!group.length || budget.snapshot().stageRemainingMs <= 0) continue;
      for (const worker of group) worker.start();
      await new Promise<void>((resolve) => setTimeout(resolve, budget.snapshot().stageRemainingMs));
      // Poller.stop aborts remote reads; fenced writer transactions roll back on ownership loss.
      await bounded(
        Promise.all(group.map((worker) => worker.stop())).then(() => undefined),
        Math.max(0, budget.snapshot().totalRemainingMs - Math.ceil(totalBudgetMs * 0.1)),
      );
    }
  } finally {
    budget.advanceStage();
    await bounded(drain(budget.stopReason()), budget.snapshot().totalRemainingMs);
  }
}
