/**
 * Expiring database-backed indexer leases.
 *
 * One row per chain/contract in `indexer_lease` records which replica owns the cursor and
 * until when. Acquiring a lease is compare-and-swap: a row is inserted only when no lease
 * exists or the existing lease has expired. A replica that loses its lease must stop indexing
 * so two processes never advance the same cursor.
 *
 * Leases expire on their own, so a crashed replica cannot block others forever. A healthy
 * replica renews before expiry and deletes its row during graceful shutdown.
 */

import type { Queryable } from "../db/pool.js";

export interface LeaseCursor {
  readonly chainKey: string;
  readonly contract: string;
}

export interface LeaseStore {
  acquire(cursors: readonly LeaseCursor[], ownerId: string, ttlMs: number): Promise<void>;
  renew(cursors: readonly LeaseCursor[], ownerId: string, ttlMs: number): Promise<void>;
  release(cursors: readonly LeaseCursor[], ownerId: string): Promise<void>;
  held(cursors: readonly LeaseCursor[], ownerId: string): Promise<boolean>;
}

export function createLeaseStore(db: Queryable): LeaseStore {
  return {
    async acquire(cursors, ownerId, ttlMs) {
      const leaseUntil = new Date(Date.now() + ttlMs).toISOString();
      for (const cursor of cursors) {
        const { rows } = await db.query(
          `INSERT INTO indexer_lease (chain_key, contract, owner_id, lease_until)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (chain_key, contract) DO UPDATE
           SET owner_id = $3, lease_until = $4, updated_at = now()
           WHERE indexer_lease.lease_until <= now()
           RETURNING owner_id`,
          [cursor.chainKey, cursor.contract, ownerId, leaseUntil],
        );
        if (rows.length === 0) {
          throw new Error(
            `indexer lease for ${cursor.chainKey}:${cursor.contract} is held by another replica`,
          );
        }
      }
    },

    async renew(cursors, ownerId, ttlMs) {
      const leaseUntil = new Date(Date.now() + ttlMs).toISOString();
      for (const cursor of cursors) {
        const { rows } = await db.query(
          `UPDATE indexer_lease
           SET lease_until = $3, updated_at = now()
           WHERE chain_key = $1 AND contract = $2 AND owner_id = $4
           RETURNING owner_id`,
          [cursor.chainKey, cursor.contract, leaseUntil, ownerId],
        );
        if (rows.length === 0) {
          throw new Error(
            `indexer lease for ${cursor.chainKey}:${cursor.contract} is no longer held by ${ownerId}`,
          );
        }
      }
    },

    async release(cursors, ownerId) {
      for (const cursor of cursors) {
        await db.query(
          `DELETE FROM indexer_lease
           WHERE chain_key = $1 AND contract = $2 AND owner_id = $3`,
          [cursor.chainKey, cursor.contract, ownerId],
        );
      }
    },

    async held(cursors, ownerId) {
      const now = new Date().toISOString();
      for (const cursor of cursors) {
        const { rows } = await db.query(
          `SELECT 1 FROM indexer_lease
           WHERE chain_key = $1 AND contract = $2 AND owner_id = $3 AND lease_until > $4`,
          [cursor.chainKey, cursor.contract, ownerId, now],
        );
        if (rows.length === 0) return false;
      }
      return true;
    },
  };
}
