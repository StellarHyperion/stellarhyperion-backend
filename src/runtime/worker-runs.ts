import { AsyncLocalStorage } from "node:async_hooks";
import type { Queryable } from "../db/pool.js";
import { integer, text, textOrNull, timestamp, timestampOrNull } from "../db/rows.js";

export type WorkerRunState = "running" | "caught_up" | "failed" | "stopped";
export interface WorkerRunIdentity {
  readonly runId: string;
  readonly executionId: string;
  readonly workerName: string;
  readonly workerKind: "chain" | "rail" | "keeper" | "other";
  readonly chainKey: string | null;
}

const context = new AsyncLocalStorage<WorkerRunIdentity>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function currentWorkerRun(): WorkerRunIdentity | undefined {
  return context.getStore();
}

export function withWorkerRun<T>(identity: WorkerRunIdentity, work: () => Promise<T>): Promise<T> {
  if (!UUID.test(identity.runId) || !UUID.test(identity.executionId))
    throw new RangeError("worker correlation requires generated UUID identities");
  return context.run(identity, work);
}

/** Write before work begins; a crash leaves an explicit partial run instead of a prior success. */
export async function recordWorkerRun(
  db: Queryable,
  identity: WorkerRunIdentity,
  state: WorkerRunState,
  successfulTick = false,
): Promise<void> {
  if (
    !UUID.test(identity.runId) ||
    !UUID.test(identity.executionId) ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(identity.workerName) ||
    (identity.chainKey !== null && !/^[A-Za-z0-9_.:-]{1,128}$/.test(identity.chainKey))
  )
    throw new RangeError("invalid worker run identity");
  const result = await db.query(
    `INSERT INTO indexer_worker_run
       (run_id, execution_id, worker_name, worker_kind, chain_key, state, successful_ticks,
        failed_ticks, last_caught_up_at, stopped_at)
     VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,
       CASE WHEN $6='caught_up' THEN now() ELSE NULL END,
       CASE WHEN $6='stopped' THEN now() ELSE NULL END)
     ON CONFLICT (run_id) DO UPDATE SET state=EXCLUDED.state,
       successful_ticks=indexer_worker_run.successful_ticks + EXCLUDED.successful_ticks,
       failed_ticks=indexer_worker_run.failed_ticks + EXCLUDED.failed_ticks,
       last_caught_up_at=COALESCE(EXCLUDED.last_caught_up_at,indexer_worker_run.last_caught_up_at),
       stopped_at=EXCLUDED.stopped_at, updated_at=now()
     WHERE (indexer_worker_run.execution_id,indexer_worker_run.worker_name,
            indexer_worker_run.worker_kind,indexer_worker_run.chain_key)
       IS NOT DISTINCT FROM (EXCLUDED.execution_id,EXCLUDED.worker_name,EXCLUDED.worker_kind,EXCLUDED.chain_key)
     RETURNING run_id`,
    [
      identity.runId,
      identity.executionId,
      identity.workerName,
      identity.workerKind,
      identity.chainKey,
      state,
      successfulTick ? 1 : 0,
      state === "failed" ? 1 : 0,
    ],
  );
  if (result.rowCount !== 1) throw new Error("worker run identity could not be persisted");
}

/** Historical jobs remain separate after restart; public projections contain no raw metadata. */
export async function readWorkerRuns(db: Queryable) {
  const { rows } = await db.query(
    `/* worker_run_history */ SELECT r.run_id::text,r.execution_id::text,r.worker_name,r.worker_kind,r.chain_key,
      r.state,r.started_at,r.updated_at,r.last_caught_up_at,r.stopped_at,
      r.successful_ticks::text,r.failed_ticks::text,
      (SELECT count(*)::integer FROM stellar_scan_journal j WHERE j.run_id=r.run_id) AS stellar_scans,
      (SELECT count(*)::integer FROM evm_scan_provenance e WHERE e.run_id=r.run_id) AS evm_scans,
      (SELECT count(*)::integer FROM rail_attestation_history h WHERE h.run_id=r.run_id) AS verification_transitions
     FROM indexer_worker_run r ORDER BY r.updated_at DESC,r.run_id LIMIT 100`,
  );
  return rows.map((row) => {
    const state = text(row, "state");
    return {
      runId: text(row, "run_id"),
      executionId: text(row, "execution_id"),
      workerName: text(row, "worker_name"),
      workerKind: text(row, "worker_kind"),
      chainKey: textOrNull(row, "chain_key"),
      state,
      partial: state !== "caught_up",
      startedAt: timestamp(row, "started_at").toISOString(),
      updatedAt: timestamp(row, "updated_at").toISOString(),
      lastCaughtUpAt: timestampOrNull(row, "last_caught_up_at")?.toISOString() ?? null,
      stoppedAt: timestampOrNull(row, "stopped_at")?.toISOString() ?? null,
      successfulTicks: text(row, "successful_ticks"),
      failedTicks: text(row, "failed_ticks"),
      stellarScans: integer(row, "stellar_scans"),
      evmScans: integer(row, "evm_scans"),
      verificationTransitions: integer(row, "verification_transitions"),
    };
  });
}
