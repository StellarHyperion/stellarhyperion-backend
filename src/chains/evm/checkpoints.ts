import type { Queryable } from "../../db/pool.js";

/** Range-end anchors are bounded independently of append-only scan provenance. */
export const MAX_EVM_BLOCK_CHECKPOINTS = 256;
export const MAX_EVM_CHECKPOINT_CLEANUP = 256;

interface Deployment {
  readonly chainKey: string;
  readonly contract: string;
  readonly deploymentRevision: number;
}

export async function readEvmBlockCheckpointHash(
  db: Queryable,
  deployment: Deployment,
  block: bigint,
): Promise<string | null> {
  const { rows } = await db.query(
    `SELECT block_hash FROM evm_block_checkpoint
      WHERE chain_key = $1 AND contract = $2 AND deployment_revision = $3 AND block_number = $4`,
    [
      deployment.chainKey,
      deployment.contract.toLowerCase(),
      deployment.deploymentRevision,
      block.toString(),
    ],
  );
  const hash = rows[0]?.block_hash;
  if (hash === undefined) return null;
  if (typeof hash !== "string") throw new Error("Invalid retained EVM checkpoint hash.");
  return hash;
}

/** Caller holds the watcher lease and commits this with the cursor and scan provenance. */
export async function recordEvmBlockCheckpoint(
  db: Queryable,
  entry: Deployment & {
    readonly block: bigint;
    readonly hash: string;
    /** Only a verified reorg may discard previously canonical anchors. */
    readonly rewindFrom?: bigint;
  },
): Promise<void> {
  const deployment = [entry.chainKey, entry.contract.toLowerCase(), entry.deploymentRevision];
  if (entry.rewindFrom !== undefined) {
    await db.query(
      `DELETE FROM evm_block_checkpoint
        WHERE chain_key = $1 AND contract = $2 AND deployment_revision = $3 AND block_number >= $4`,
      [...deployment, entry.rewindFrom.toString()],
    );
  }
  const hash = entry.hash.toLowerCase();
  const { rows } = await db.query(
    `INSERT INTO evm_block_checkpoint
       (chain_key, contract, deployment_revision, block_number, block_hash)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (chain_key, contract, deployment_revision, block_number) DO UPDATE
       SET block_hash = EXCLUDED.block_hash
       WHERE evm_block_checkpoint.block_hash = EXCLUDED.block_hash
     RETURNING block_hash`,
    [...deployment, entry.block.toString(), hash],
  );
  if (rows[0]?.block_hash !== hash) {
    throw new Error("EVM checkpoint conflicts with retained canonical history.");
  }
  await db.query(
    `DELETE FROM evm_block_checkpoint
      WHERE chain_key = $1 AND contract = $2 AND deployment_revision = $3
        AND block_number IN (
          SELECT block_number FROM evm_block_checkpoint
           WHERE chain_key = $1 AND contract = $2 AND deployment_revision = $3
           ORDER BY block_number DESC OFFSET $4 LIMIT $5
        )`,
    [...deployment, MAX_EVM_BLOCK_CHECKPOINTS, MAX_EVM_CHECKPOINT_CLEANUP],
  );
}
