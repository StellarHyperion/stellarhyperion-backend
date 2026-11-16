import { spawn } from "node:child_process";

import { RouteKind } from "@hyperion/protocol";
import type { Logger } from "pino";

import type { AppConfig } from "../config/config.js";
import type { Queryable } from "../db/pool.js";
import { bigintOf, integer, text, timestampOrNull } from "../db/rows.js";
import { outstandingForRail, pendingForRail } from "../rails/queue.js";

export interface CatchUpBudgetConfig {
  readonly totalBudgetMs: number;
  readonly migrationBudgetMs: number;
  readonly sourceScanBudgetMs: number;
  readonly proofPollBudgetMs: number;
  readonly drainMarginMs: number;
  readonly runMigrationsInProcess: boolean;
}

export type CatchUpStageName = "migrations" | "source_scans" | "proof_polling" | "graceful_drain";

export type CatchUpStageStatus =
  "completed" | "budget_exhausted" | "skipped" | "failed" | "interrupted";

export type CatchUpStopReason =
  | "caught_up"
  | "stage_budget_exhausted"
  | "run_budget_exhausted"
  | "migration_timeout"
  | "migration_failed"
  | "signal_interrupted";

export interface StageExecutionReport {
  readonly stage: CatchUpStageName;
  readonly budgetMs: number;
  readonly elapsedMs: number;
  readonly status: CatchUpStageStatus;
  readonly completedPasses: number;
  readonly detail: string;
}

export interface StoredCursorSummary {
  readonly chainKey: string;
  readonly lastProcessed: string;
  readonly updatedAt: string | null;
}

export interface EligibleRailRouteSummary {
  readonly route: number;
  readonly routeName: string;
  readonly eligibleNow: number;
  readonly totalOutstanding: number;
}

export interface RemainingEligibleWorkReport {
  readonly incompleteSourceChains: readonly string[];
  readonly storedCursors: readonly StoredCursorSummary[];
  readonly eligibleRailTransfersByRoute: readonly EligibleRailRouteSummary[];
  readonly unsettledClaims: number;
}

export interface DrainSafetyReport {
  readonly reservedMarginMs: number;
  readonly remainingBeforeTotalDeadlineMs: number;
  readonly drainElapsedMs: number;
  readonly drainCompletedWithinMargin: boolean;
}

export interface CatchUpRunReport {
  readonly network: AppConfig["network"];
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly elapsedMs: number;
  readonly totalBudgetMs: number;
  readonly stopReason: CatchUpStopReason;
  readonly stoppedStages: readonly CatchUpStageName[];
  readonly stages: {
    readonly migrations: StageExecutionReport;
    readonly source_scans: StageExecutionReport;
    readonly proof_polling: StageExecutionReport;
    readonly graceful_drain: StageExecutionReport;
  };
  readonly drainSafety: DrainSafetyReport;
  readonly remainingEligibleWork: RemainingEligibleWorkReport;
}

export interface CatchUpPassHandle {
  readonly name: string;
  tick(signal: AbortSignal): Promise<boolean>;
}

export interface RunBoundedCatchUpOptions {
  readonly budget: CatchUpBudgetConfig;
  readonly config: AppConfig;
  readonly db: Queryable & { ping?: (() => Promise<void>) | undefined };
  readonly logger: Logger;
  readonly sourcePasses: readonly CatchUpPassHandle[];
  readonly proofPasses: readonly CatchUpPassHandle[];
  readonly runMigrations?: ((signal: AbortSignal) => Promise<void>) | undefined;
  readonly drain: (signal: AbortSignal) => Promise<void>;
  readonly externalSignal?: AbortSignal | undefined;
  readonly clock?: (() => number) | undefined;
}

const URL_CREDENTIALS_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@"']+@/gi;

function sanitizeDetail(raw: string, secrets: readonly (string | null | undefined)[]): string {
  let clean = raw.replace(URL_CREDENTIALS_RE, "$1[REDACTED]@");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.trim().length > 0) {
      clean = clean.replaceAll(secret, "[REDACTED]");
    }
  }
  return clean;
}

type TimedOutcome<T> =
  | { readonly kind: "resolved"; readonly value: T }
  | { readonly kind: "timed_out" }
  | { readonly kind: "interrupted" }
  | { readonly kind: "failed"; readonly error: unknown };

async function runWithCeiling<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ceilingMs: number,
  inFlightTracker: Promise<unknown>[],
  externalSignal?: AbortSignal,
): Promise<TimedOutcome<T>> {
  if (externalSignal?.aborted === true) {
    return { kind: "interrupted" };
  }
  if (ceilingMs <= 0) {
    return { kind: "timed_out" };
  }

  const stageController = new AbortController();
  const state = { timedOut: false, interrupted: false };

  const onExternalAbort = (): void => {
    state.interrupted = true;
    stageController.abort(new Error("external signal interrupted catch-up stage"));
  };
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      state.timedOut = true;
      stageController.abort(new Error("catch-up stage budget ceiling reached"));
      resolve("timeout");
    }, ceilingMs);
  });

  const taskPromise = work(stageController.signal);
  // Prevent unhandled rejections if a slow callback rejects after the deadline race moves on.
  const guardedTask = taskPromise.then(
    (value) => ({ tag: "ok" as const, value }),
    (error: unknown) => ({ tag: "err" as const, error }),
  );
  inFlightTracker.push(guardedTask);

  try {
    const raced = await Promise.race([guardedTask, timeoutPromise]);
    if (raced === "timeout" || state.timedOut) {
      return { kind: "timed_out" };
    }
    if (state.interrupted) {
      return { kind: "interrupted" };
    }
    if (raced.tag === "err") {
      return { kind: "failed", error: raced.error };
    }
    return { kind: "resolved", value: raced.value };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

export function createCliMigrationRunner(
  cwd: string = process.cwd(),
): (signal: AbortSignal) => Promise<void> {
  return (signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
      const child = spawn(npmCmd, ["run", "migrate:up"], {
        cwd,
        stdio: ["ignore", "ignore", "pipe"],
        signal,
      });
      const stderrChunks: Buffer[] = [];
      child.stderr.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });
      child.on("error", (err) => {
        reject(err);
      });
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        const detail = Buffer.concat(stderrChunks).toString("utf8").trim();
        reject(
          new Error(`migrate:up exited with code ${String(code)}${detail ? `: ${detail}` : ""}`),
        );
      });
    });
}

export async function queryRemainingEligibleWork(
  db: Queryable,
  config: AppConfig,
  incompleteSourceChains: readonly string[],
  now: Date,
): Promise<RemainingEligibleWorkReport> {
  const cursorRows = await db.query(
    `SELECT chain_key, last_processed, updated_at
       FROM indexer_cursor
      ORDER BY chain_key ASC`,
  );
  const storedCursors: StoredCursorSummary[] = cursorRows.rows.map((row) => {
    const updated = timestampOrNull(row, "updated_at");
    return {
      chainKey: text(row, "chain_key"),
      lastProcessed: bigintOf(row, "last_processed").toString(),
      updatedAt: updated ? updated.toISOString() : null,
    };
  });

  const routes: readonly { readonly route: RouteKind; readonly routeName: string }[] = [
    { route: RouteKind.Cctp, routeName: "cctp" },
    { route: RouteKind.AxelarIts, routeName: "axelar-its" },
  ];

  const eligibleRailTransfersByRoute: EligibleRailRouteSummary[] = [];
  const notCheckedSince = new Date(now.getTime() - config.rails.recheckAfterMs);
  for (const entry of routes) {
    const [eligibleBatch, totalOutstanding] = await Promise.all([
      pendingForRail(db, {
        route: entry.route,
        limit: 1_000,
        notCheckedSince,
        maxCheckFailures: config.rails.maxCheckFailures,
      }),
      outstandingForRail(db, entry.route),
    ]);
    eligibleRailTransfersByRoute.push({
      route: entry.route,
      routeName: entry.routeName,
      eligibleNow: eligibleBatch.length,
      totalOutstanding,
    });
  }

  const claimsResult = await db.query(
    "SELECT count(*)::int AS n FROM pending_claim WHERE NOT settled",
  );
  const unsettledClaims =
    claimsResult.rows[0] === undefined ? 0 : integer(claimsResult.rows[0], "n");

  return {
    incompleteSourceChains: [...incompleteSourceChains].sort(),
    storedCursors,
    eligibleRailTransfersByRoute,
    unsettledClaims,
  };
}

interface PassLoopResult {
  readonly status: CatchUpStageStatus;
  readonly completedPasses: number;
  readonly incompleteNames: readonly string[];
  readonly hitRunCutoff: boolean;
  readonly detail: string;
}

async function executePassStage(
  stageName: "source_scans" | "proof_polling",
  passes: readonly CatchUpPassHandle[],
  stageBudgetMs: number,
  workCutoffMs: number,
  clock: () => number,
  inFlightTracker: Promise<unknown>[],
  secrets: readonly (string | null | undefined)[],
  externalSignal?: AbortSignal,
): Promise<{ readonly report: StageExecutionReport; readonly loop: PassLoopResult }> {
  const stageStartedAt = clock();

  if (passes.length === 0) {
    return {
      report: {
        stage: stageName,
        budgetMs: stageBudgetMs,
        elapsedMs: 0,
        status: "completed",
        completedPasses: 0,
        detail: "no passes configured for this stage",
      },
      loop: {
        status: "completed",
        completedPasses: 0,
        incompleteNames: [],
        hitRunCutoff: false,
        detail: "no passes configured for this stage",
      },
    };
  }

  const stageDeadlineMs = stageStartedAt + stageBudgetMs;
  const activePasses = new Map<string, CatchUpPassHandle>(passes.map((p) => [p.name, p]));
  let completedPasses = 0;
  let status: CatchUpStageStatus = "completed";
  let hitRunCutoff = false;
  let failureNote: string | null = null;

  outer: while (activePasses.size > 0) {
    for (const [name, pass] of [...activePasses.entries()]) {
      if (externalSignal?.aborted === true) {
        status = "interrupted";
        break outer;
      }

      const nowMs = clock();
      const remainingStageMs = stageDeadlineMs - nowMs;
      const remainingWorkMs = workCutoffMs - nowMs;

      if (remainingWorkMs <= 0) {
        status = "budget_exhausted";
        hitRunCutoff = true;
        break outer;
      }
      if (remainingStageMs <= 0) {
        status = "budget_exhausted";
        break outer;
      }

      const passCeilingMs = Math.min(remainingStageMs, remainingWorkMs);
      const outcome = await runWithCeiling(
        (signal) => pass.tick(signal),
        passCeilingMs,
        inFlightTracker,
        externalSignal,
      );

      if (outcome.kind === "interrupted") {
        status = "interrupted";
        break outer;
      }
      if (outcome.kind === "timed_out") {
        status = "budget_exhausted";
        if (clock() >= workCutoffMs) {
          hitRunCutoff = true;
        }
        break outer;
      }
      if (outcome.kind === "failed") {
        const msg = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
        failureNote = `${name}: ${sanitizeDetail(msg, secrets)}`;
        // Stop retrying this pass in this catch-up window, while preserving its eligibility report.
        status = "failed";
        break outer;
      }

      completedPasses += 1;
      if (!outcome.value) {
        // False means this pass reached head / exhausted its eligible batch.
        activePasses.delete(name);
      }
    }
  }

  const elapsedMs = Math.max(0, clock() - stageStartedAt);
  const incompleteNames = [...activePasses.keys()].sort();
  const detail =
    failureNote !== null
      ? `pass error after ${String(completedPasses)} committed passes (${failureNote})`
      : status === "completed"
        ? `caught up across ${String(passes.length)} workers in ${String(completedPasses)} passes`
        : status === "interrupted"
          ? `interrupted by signal after ${String(completedPasses)} committed passes; remaining: ${incompleteNames.join(", ")}`
          : `stage ceiling reached after ${String(completedPasses)} committed passes; remaining: ${incompleteNames.join(", ")}`;

  return {
    report: {
      stage: stageName,
      budgetMs: stageBudgetMs,
      elapsedMs,
      status,
      completedPasses,
      detail,
    },
    loop: {
      status,
      completedPasses,
      incompleteNames,
      hitRunCutoff,
      detail,
    },
  };
}

export async function runBoundedCatchUp(
  options: RunBoundedCatchUpOptions,
): Promise<CatchUpRunReport> {
  const clock = options.clock ?? (() => Date.now());
  const { budget, config, db, logger } = options;
  const secrets = [config.databaseUrl, config.redisUrl, config.keeper.stellarSecret];
  const inFlightTracker: Promise<unknown>[] = [];

  const startedAtMs = clock();
  const totalDeadlineMs = startedAtMs + budget.totalBudgetMs;
  // Hard boundary guaranteeing earlier stages can never consume the reserved shutdown safety margin.
  const workCutoffMs = totalDeadlineMs - budget.drainMarginMs;

  const stoppedStages: CatchUpStageName[] = [];
  let hitRunCutoff = false;
  let interrupted = false;
  let migrationStop: "migration_timeout" | "migration_failed" | null = null;

  // Stage 1: Migrations / database admission check.
  const migStartMs = clock();
  const migCeilingMs = Math.min(budget.migrationBudgetMs, Math.max(0, workCutoffMs - migStartMs));
  const migrationTask =
    options.runMigrations ??
    (budget.runMigrationsInProcess
      ? createCliMigrationRunner()
      : async () => {
          if (db.ping) {
            await db.ping();
          } else {
            await db.query("SELECT 1");
          }
        });

  const migOutcome = await runWithCeiling(
    migrationTask,
    migCeilingMs,
    inFlightTracker,
    options.externalSignal,
  );
  const migElapsedMs = Math.max(0, clock() - migStartMs);

  let migrationsReport: StageExecutionReport;
  if (migOutcome.kind === "resolved") {
    migrationsReport = {
      stage: "migrations",
      budgetMs: budget.migrationBudgetMs,
      elapsedMs: migElapsedMs,
      status: "completed",
      completedPasses: 1,
      detail: budget.runMigrationsInProcess
        ? "applied pending migrations within stage budget"
        : "verified database connectivity within stage budget",
    };
  } else if (migOutcome.kind === "interrupted") {
    interrupted = true;
    stoppedStages.push("migrations");
    migrationsReport = {
      stage: "migrations",
      budgetMs: budget.migrationBudgetMs,
      elapsedMs: migElapsedMs,
      status: "interrupted",
      completedPasses: 0,
      detail: "interrupted by external signal during migration stage",
    };
  } else if (migOutcome.kind === "timed_out") {
    migrationStop = "migration_timeout";
    stoppedStages.push("migrations");
    migrationsReport = {
      stage: "migrations",
      budgetMs: budget.migrationBudgetMs,
      elapsedMs: migElapsedMs,
      status: "budget_exhausted",
      completedPasses: 0,
      detail: `migration stage exceeded ${String(budget.migrationBudgetMs)}ms ceiling; halted to preserve drain margin`,
    };
  } else {
    migrationStop = "migration_failed";
    stoppedStages.push("migrations");
    const msg =
      migOutcome.error instanceof Error ? migOutcome.error.message : String(migOutcome.error);
    migrationsReport = {
      stage: "migrations",
      budgetMs: budget.migrationBudgetMs,
      elapsedMs: migElapsedMs,
      status: "failed",
      completedPasses: 0,
      detail: `migration stage failed: ${sanitizeDetail(msg, secrets)}`,
    };
  }

  // Stage 2: Source chain scans (each completed pass commits its own PostgreSQL cursor transaction).
  let sourceReport: StageExecutionReport;
  let incompleteSourceChains: readonly string[] = options.sourcePasses.map((p) => p.name);

  if (migrationStop !== null || interrupted) {
    sourceReport = {
      stage: "source_scans",
      budgetMs: budget.sourceScanBudgetMs,
      elapsedMs: 0,
      status: "skipped",
      completedPasses: 0,
      detail: "skipped because migration stage did not complete",
    };
  } else {
    const sourceResult = await executePassStage(
      "source_scans",
      options.sourcePasses,
      budget.sourceScanBudgetMs,
      workCutoffMs,
      clock,
      inFlightTracker,
      secrets,
      options.externalSignal,
    );
    sourceReport = sourceResult.report;
    incompleteSourceChains = sourceResult.loop.incompleteNames;
    if (sourceResult.loop.hitRunCutoff) hitRunCutoff = true;
    if (sourceResult.report.status === "interrupted") interrupted = true;
    if (sourceResult.report.status !== "completed") {
      stoppedStages.push("source_scans");
    }
  }

  // Stage 3: Rail proof polling and destination receipt verification.
  let proofReport: StageExecutionReport;
  if (migrationStop !== null || interrupted || hitRunCutoff) {
    proofReport = {
      stage: "proof_polling",
      budgetMs: budget.proofPollBudgetMs,
      elapsedMs: 0,
      status: "skipped",
      completedPasses: 0,
      detail:
        migrationStop !== null
          ? "skipped because migration stage did not complete"
          : interrupted
            ? "skipped due to external shutdown signal"
            : "skipped because run work cutoff reached; preserving drain safety margin",
    };
    if (hitRunCutoff && options.proofPasses.length > 0) {
      stoppedStages.push("proof_polling");
    }
  } else {
    const proofResult = await executePassStage(
      "proof_polling",
      options.proofPasses,
      budget.proofPollBudgetMs,
      workCutoffMs,
      clock,
      inFlightTracker,
      secrets,
      options.externalSignal,
    );
    proofReport = proofResult.report;
    if (proofResult.loop.hitRunCutoff) hitRunCutoff = true;
    if (proofResult.report.status === "interrupted") interrupted = true;
    if (proofResult.report.status !== "completed") {
      stoppedStages.push("proof_polling");
    }
  }

  // Stage 4: Reserved graceful drain safety margin (snapshot remaining work, settle in-flight I/O, close pools).
  const drainStartMs = clock();
  const remainingBeforeTotalDeadlineMs = Math.max(0, totalDeadlineMs - drainStartMs);
  const drainDeadlineMs = drainStartMs + budget.drainMarginMs;

  // Give any aborted in-flight callback a brief fraction of the drain budget to settle cleanly before closing DB.
  const settleBudgetMs = Math.max(25, Math.floor(budget.drainMarginMs * 0.25));
  if (inFlightTracker.length > 0) {
    await Promise.race([
      Promise.allSettled(inFlightTracker),
      new Promise<void>((resolve) => setTimeout(resolve, settleBudgetMs)),
    ]);
  }

  let remainingEligibleWork: RemainingEligibleWorkReport = {
    incompleteSourceChains: [...incompleteSourceChains].sort(),
    storedCursors: [],
    eligibleRailTransfersByRoute: [],
    unsettledClaims: 0,
  };

  if (migrationStop === null) {
    try {
      remainingEligibleWork = await queryRemainingEligibleWork(
        db,
        config,
        incompleteSourceChains,
        new Date(clock()),
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(
        { reason: sanitizeDetail(msg, secrets) },
        "could not query remaining eligible catch-up work before drain",
      );
    }
  }

  const remainingDrainMs = Math.max(50, drainDeadlineMs - clock());
  const drainOutcome = await runWithCeiling(
    (signal) => options.drain(signal),
    remainingDrainMs,
    [],
  );
  const drainElapsedMs = Math.max(0, clock() - drainStartMs);
  const drainCompletedWithinMargin =
    drainOutcome.kind === "resolved" && drainElapsedMs <= budget.drainMarginMs + 50;

  const drainReport: StageExecutionReport =
    drainOutcome.kind === "resolved"
      ? {
          stage: "graceful_drain",
          budgetMs: budget.drainMarginMs,
          elapsedMs: drainElapsedMs,
          status: "completed",
          completedPasses: 1,
          detail: "closed HTTP listener and database connections cleanly within safety margin",
        }
      : {
          stage: "graceful_drain",
          budgetMs: budget.drainMarginMs,
          elapsedMs: drainElapsedMs,
          status: drainOutcome.kind === "timed_out" ? "budget_exhausted" : "failed",
          completedPasses: 0,
          detail: "graceful drain exceeded safety margin ceiling",
        };

  let stopReason: CatchUpStopReason;
  if (interrupted) {
    stopReason = "signal_interrupted";
  } else if (migrationStop !== null) {
    stopReason = migrationStop;
  } else if (hitRunCutoff) {
    stopReason = "run_budget_exhausted";
  } else if (stoppedStages.length > 0) {
    stopReason = "stage_budget_exhausted";
  } else {
    stopReason = "caught_up";
  }

  const finishedAtMs = clock();
  return {
    network: config.network,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    elapsedMs: Math.max(0, finishedAtMs - startedAtMs),
    totalBudgetMs: budget.totalBudgetMs,
    stopReason,
    stoppedStages,
    stages: {
      migrations: migrationsReport,
      source_scans: sourceReport,
      proof_polling: proofReport,
      graceful_drain: drainReport,
    },
    drainSafety: {
      reservedMarginMs: budget.drainMarginMs,
      remainingBeforeTotalDeadlineMs,
      drainElapsedMs,
      drainCompletedWithinMargin,
    },
    remainingEligibleWork,
  };
}
