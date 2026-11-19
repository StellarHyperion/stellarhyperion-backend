import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { Transactional } from "../../db/pool.js";
import { bigintOf, text, textOrNull } from "../../db/rows.js";
import type { EvmWatchConfig } from "../../config/config.js";
import { EvmWatcher } from "./watcher.js";
import { viemClient, type EvmClient } from "./client.js";

export type BackfillState = "queued" | "running" | "cancelled" | "completed" | "failed";
export interface BackfillProgress {
  readonly id: string;
  readonly owner: string;
  readonly chain: string;
  readonly from: string;
  readonly to: string;
  readonly next: string;
  readonly written: string;
  readonly ignored: string;
  readonly state: BackfillState;
  readonly error: string | null;
}
export const MAX_BACKFILL_BLOCKS = 100_000n;
function progress(row: Record<string, unknown> | undefined): BackfillProgress {
  if (!row) throw new Error("backfill not found or currently owned by another worker");
  const state = text(row, "state");
  if (!["queued", "running", "cancelled", "completed", "failed"].includes(state))
    throw new Error("invalid backfill state");
  return {
    id: text(row, "id"),
    owner: text(row, "owner"),
    chain: text(row, "chain_key"),
    from: text(row, "from_block"),
    to: text(row, "to_block"),
    next: text(row, "next_block"),
    written: text(row, "written"),
    ignored: text(row, "ignored"),
    state: state as BackfillState,
    error: textOrNull(row, "error"),
  };
}

/** Mutation methods are local operator commands. Public HTTP exposes only bounded reads. */
export class EvmBackfillManager {
  constructor(
    private readonly configs: readonly EvmWatchConfig[],
    private readonly db: Transactional,
    private readonly logger: Logger,
    private readonly clientFactory: (config: EvmWatchConfig) => EvmClient = (config) =>
      viemClient(config.rpcUrls, { logger }),
  ) {}

  async start(owner: string, chain: string, from: bigint, to: bigint): Promise<BackfillProgress> {
    const config = this.configs.find((entry) => entry.chain === chain);
    if (
      !config ||
      from < config.startBlock ||
      to < from ||
      to - from + 1n > MAX_BACKFILL_BLOCKS ||
      to > (1n << 64n) - 2n
    )
      throw new Error("backfill requires a configured deployment and a bounded historical range");
    if (!owner.trim() || owner.length > 200)
      throw new Error("owner must contain 1 to 200 characters");
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('evm-backfill-jobs', 0))");
      const { rows: active } = await tx.query(
        "SELECT count(*)::text AS count FROM evm_backfill_job WHERE state IN ('queued','running')",
      );
      if (bigintOf(active[0] ?? {}, "count") >= 100n)
        throw new Error("active backfill limit reached");
      const { rows } = await tx.query(
        `INSERT INTO evm_backfill_job(id, owner, chain_key, contract, from_block, to_block, next_block, state)
        VALUES ($1,$2,$3,$4,$5,$6,$5,'queued') RETURNING *`,
        [randomUUID(), owner.trim(), chain, config.routerAddress, from.toString(), to.toString()],
      );
      await tx.query(`DELETE FROM evm_backfill_job WHERE id IN (
        SELECT id FROM evm_backfill_job WHERE state IN ('completed','cancelled','failed')
        ORDER BY created_at DESC, id OFFSET 1000)`);
      return progress(rows[0]);
    });
  }
  async list(owner?: string): Promise<readonly BackfillProgress[]> {
    const { rows } = await this.db.query(
      "SELECT * FROM evm_backfill_job WHERE ($1::text IS NULL OR owner = $1) ORDER BY created_at DESC, id LIMIT 100",
      [owner ?? null],
    );
    return rows.map(progress);
  }
  async get(id: string): Promise<BackfillProgress | null> {
    const { rows } = await this.db.query("SELECT * FROM evm_backfill_job WHERE id = $1", [id]);
    return rows[0] ? progress(rows[0]) : null;
  }
  async cancel(id: string, owner: string): Promise<BackfillProgress> {
    const { rows } = await this.db.query(
      `UPDATE evm_backfill_job SET
      state = CASE WHEN state IN ('queued','running') THEN 'cancelled' ELSE state END,
      updated_at = now() WHERE id = $1 AND owner = $2 RETURNING *`,
      [id, owner],
    );
    return progress(rows[0]);
  }
  async resume(id: string, owner: string, signal: AbortSignal): Promise<BackfillProgress> {
    await this.db.query(
      "UPDATE evm_backfill_job SET state = 'queued', error = NULL WHERE id = $1 AND owner = $2 AND state IN ('failed','cancelled')",
      [id, owner],
    );
    return this.run(id, owner, signal);
  }
  async run(id: string, owner: string, signal: AbortSignal): Promise<BackfillProgress> {
    const cancelled = () => signal.aborted;
    const ownership = { claimed: false };
    try {
      while (!signal.aborted) {
        ownership.claimed = false;
        const result = await this.db.transaction(async (tx) => {
          const { rows } = await tx.query(
            "SELECT * FROM evm_backfill_job WHERE id = $1 AND owner = $2 FOR UPDATE SKIP LOCKED",
            [id, owner],
          );
          const row = rows[0];
          if (!row) throw new Error("backfill currently owned by another worker");
          const current = progress(row);
          ownership.claimed = true;
          if (current.state === "cancelled" || current.state === "completed") return current;
          const config = this.configs.find((entry) => entry.chain === current.chain);
          if (config?.routerAddress.toLowerCase() !== text(row, "contract").toLowerCase())
            throw new Error("backfill deployment changed; operator review required");
          const next = BigInt(current.next);
          const to = BigInt(current.to);
          const end =
            next + BigInt(config.logRange) - 1n < to ? next + BigInt(config.logRange) - 1n : to;
          const pageDb: Transactional = {
            query: (query, params) => tx.query(query, params),
            transaction: (work) => work(tx),
          };
          const watcher = new EvmWatcher({
            chainKey: config.chain,
            router: config.routerAddress,
            chainId: config.chainId,
            startBlock: config.startBlock,
            confirmations: config.confirmations,
            reorgDepth: config.reorgDepth,
            logRange: config.logRange,
            client: this.clientFactory(config),
            db: pageDb,
            logger: this.logger,
          });
          const applied = await watcher.backfillRange(next, end, signal);
          if (signal.aborted) throw new DOMException("cancelled", "AbortError");
          const { rows: updated } = await tx.query(
            `UPDATE evm_backfill_job SET next_block = $2,
            written = written + $3, ignored = ignored + $4, state = $5, error = NULL, updated_at = now()
            WHERE id = $1 RETURNING *`,
            [
              id,
              (end + 1n).toString(),
              applied.written,
              applied.ignored,
              end === to ? "completed" : "running",
            ],
          );
          return progress(updated[0]);
        });
        if (result.state === "cancelled" || result.state === "completed") return result;
      }
      return await this.cancel(id, owner);
    } catch (error) {
      if (!ownership.claimed) throw error;
      const { rows } = await this.db.query(
        `UPDATE evm_backfill_job SET state = $3, error = $4, updated_at = now()
        WHERE id = $1 AND owner = $2 AND state NOT IN ('completed','cancelled') RETURNING *`,
        [
          id,
          owner,
          cancelled() ? "cancelled" : "failed",
          signal.aborted
            ? null
            : "Historical range could not be verified. Review the deployment and provider before resuming.",
        ],
      );
      if (rows[0]) return progress(rows[0]);
      const current = await this.get(id);
      if (current?.owner !== owner) throw new Error("backfill unavailable");
      return current;
    }
  }
}
