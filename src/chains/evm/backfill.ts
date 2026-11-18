import type { Logger } from "pino";

import type { Transactional } from "../../db/pool.js";
import type { EvmWatchConfig } from "../../config/config.js";
import { EvmWatcher } from "./watcher.js";
import { viemClient } from "./client.js";

export type BackfillState = "queued" | "running" | "cancelled" | "completed" | "failed";

export interface BackfillProgress {
  readonly id: string;
  readonly owner: string;
  readonly chain: string;
  readonly from: string;
  readonly to: string;
  readonly next: string;
  readonly written: number;
  readonly ignored: number;
  readonly state: BackfillState;
  readonly error: string | null;
}

interface Job {
  progress: BackfillProgress;
  readonly controller: AbortController;
  readonly watcher: EvmWatcher;
  readonly pageSize: number;
}

export const MAX_BACKFILL_BLOCKS = 100_000n;

export class EvmBackfillManager {
  private readonly jobs = new Map<string, Job>();
  private sequence = 0;

  constructor(
    private readonly configs: readonly EvmWatchConfig[],
    private readonly db: Transactional,
    private readonly logger: Logger,
  ) {}

  start(owner: string, chain: string, from: bigint, to: bigint): BackfillProgress {
    const config = this.configs.find((entry) => entry.chain === chain);
    if (config === undefined) throw new Error(`unknown EVM chain ${chain}`);
    if (owner.trim() === "") throw new Error("owner is required");
    if (from < 0n || to < from || to - from + 1n > MAX_BACKFILL_BLOCKS) {
      throw new Error(
        `backfill must contain between 1 and ${MAX_BACKFILL_BLOCKS.toString()} blocks`,
      );
    }
    const id = `${chain}-${String(++this.sequence)}`;
    const controller = new AbortController();
    const watcher = new EvmWatcher({
      chainKey: config.chain,
      router: config.routerAddress,
      chainId: config.chainId,
      startBlock: config.startBlock,
      confirmations: config.confirmations,
      reorgDepth: config.reorgDepth,
      logRange: config.logRange,
      client: viemClient(config.rpcUrls, { logger: this.logger }),
      db: this.db,
      logger: this.logger,
    });
    const job: Job = {
      controller,
      watcher,
      pageSize: config.logRange,
      progress: {
        id,
        owner,
        chain,
        from: from.toString(),
        to: to.toString(),
        next: from.toString(),
        written: 0,
        ignored: 0,
        state: "queued",
        error: null,
      },
    };
    this.jobs.set(id, job);
    void this.run(job, from, to);
    return job.progress;
  }

  list(owner?: string): readonly BackfillProgress[] {
    return [...this.jobs.values()]
      .map((job) => job.progress)
      .filter((progress) => owner === undefined || progress.owner === owner);
  }

  get(id: string): BackfillProgress | null {
    return this.jobs.get(id)?.progress ?? null;
  }

  cancel(id: string, owner: string): BackfillProgress {
    const job = this.jobs.get(id);
    if (job === undefined) throw new Error("backfill not found");
    if (job.progress.owner !== owner) throw new Error("backfill belongs to another owner");
    if (job.progress.state === "queued" || job.progress.state === "running") {
      job.controller.abort();
      this.replace(job, { state: "cancelled" });
    }
    return job.progress;
  }

  private async run(job: Job, from: bigint, to: bigint): Promise<void> {
    this.replace(job, { state: "running" });
    let next = from;
    try {
      while (next <= to) {
        const page = BigInt(job.pageSize);
        const end = next + page - 1n < to ? next + page - 1n : to;
        const result = await job.watcher.backfillRange(next, end, job.controller.signal);
        next = end + 1n;
        this.replace(job, {
          next: next.toString(),
          written: job.progress.written + result.written,
          ignored: job.progress.ignored + result.ignored,
        });
      }
      this.replace(job, { state: "completed" });
    } catch (error) {
      if (job.controller.signal.aborted) {
        this.replace(job, { state: "cancelled" });
      } else {
        this.replace(job, { state: "failed", error: messageOf(error) });
      }
    }
  }

  private replace(job: Job, patch: Partial<BackfillProgress>): void {
    job.progress = { ...job.progress, ...patch };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
