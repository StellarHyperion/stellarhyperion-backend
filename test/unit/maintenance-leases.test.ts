import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Queryable, Transactional } from "../../src/db/pool.js";
import {
  acquireMaintenanceLease,
  MAINTENANCE_JOBS,
  releaseMaintenanceLease,
  runMaintenanceJob,
} from "../../src/chains/writers.js";

const pg = new PGlite();
const rowsAsStrings = (
  rows: Record<string, unknown>[],
  fields: { readonly name: string; readonly dataTypeID: number }[],
) =>
  rows.map((raw) => {
    const row = { ...raw };
    for (const field of fields)
      if (field.dataTypeID === 20 && row[field.name] !== null)
        row[field.name] = String(row[field.name]);
    return row;
  });

const db: Transactional = {
  async query(sql, params = []) {
    const result = await pg.query<Record<string, unknown>>(sql, [...params]);
    return {
      rows: rowsAsStrings(result.rows, result.fields),
      rowCount: result.affectedRows ?? result.rows.length,
    };
  },
  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    return pg.transaction(async (client) =>
      work({
        async query(sql, params = []) {
          const result = await client.query<Record<string, unknown>>(sql, [...params]);
          return {
            rows: rowsAsStrings(result.rows, result.fields),
            rowCount: result.affectedRows ?? result.rows.length,
          };
        },
      }),
    );
  },
};

beforeAll(async () => {
  for (const file of [
    "1790900000000_initial-schema.sql",
    "1793600000000_source-event-provenance.sql",
    "1794300000000_database-maintenance-leases.sql",
  ]) {
    const migration = readFileSync(new URL(`../../migrations/${file}`, import.meta.url), "utf8");
    await pg.exec(migration.split("-- Down Migration")[0]!);
  }
});

afterAll(async () => {
  await pg.close();
});

describe("database maintenance leases", () => {
  it("fences competing workers and resumes after committed batches without pruning active claims or provenance", async () => {
    const outboundIds: number[] = [];
    for (let nonce = 1; nonce <= 3; nonce++) {
      const { rows } = await db.query(
        `INSERT INTO outbound_transfer
           (origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
            destination_chain, destination, origin_block, origin_tx)
         VALUES ('maintenance-test', 0, $1, 'sender', 'token', 100, 0, 100,
                 'destination-test', 'recipient', $1, $2)
         RETURNING id`,
        [nonce, `tx-${nonce}`],
      );
      outboundIds.push(Number(rows[0]!.id));
      await db.query(
        `INSERT INTO rail_attestation (transfer_id, route, status, updated_at)
         VALUES ($1, 0, 'delivered', now() - INTERVAL '40 days')`,
        [rows[0]!.id],
      );
    }

    await db.query(
      `INSERT INTO inbound_delivery
         (destination_chain, route, source_chain, source_nonce, recipient, token, amount,
          delivered, claim_id, destination_block, destination_tx)
       VALUES ('destination-test', 0, 'maintenance-test', 1, 'recipient', 'token', 100,
               true, NULL, 1, 'destination-tx-1'),
              ('destination-test', 0, 'maintenance-test', 2, 'recipient', 'token', 100,
               false, 20, 2, 'destination-tx-2')`,
    );
    await db.query(
      `INSERT INTO pending_claim
         (chain, claim_id, recipient, token, amount, route, source_chain, source_nonce, created_at)
       VALUES ('destination-test', 20, 'recipient', 'token', 100, 0, 'maintenance-test', 2, now())`,
    );

    const { rows: provenance } = await db.query(
      `INSERT INTO source_event
         (chain_key, family, contract, block_number, tx_hash, event_position, event_kind, payload_digest)
       VALUES ('maintenance-test', 'evm', '0xrouter', 1, '0xsource', '1', 'BridgeOut', $1)
       RETURNING id`,
      ["a".repeat(64)],
    );
    await db.query(
      `INSERT INTO source_event_link (source_event_id, record_kind, record_key, role)
       VALUES ($1, 'outbound_transfer', $2, 'created')`,
      [provenance[0]!.id, String(outboundIds[0])],
    );

    const heldLease = await acquireMaintenanceLease(db, {
      jobName: MAINTENANCE_JOBS.railAttestationRetention,
      ownerId: "worker-one",
    });
    expect(heldLease).not.toBeNull();
    await expect(
      acquireMaintenanceLease(db, {
        jobName: MAINTENANCE_JOBS.railAttestationRetention,
        ownerId: "worker-two",
      }),
    ).resolves.toBeNull();
    await expect(
      releaseMaintenanceLease(db, {
        jobName: MAINTENANCE_JOBS.railAttestationRetention,
        ownerId: "worker-one",
        fenceToken: heldLease!.fenceToken,
      }),
    ).resolves.toBe(true);

    const failCheckpoint: Transactional = {
      async query(sql, params = []) {
        return db.query(sql, params);
      },
      async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
        return db.transaction((tx) =>
          work({
            async query(sql, params = []) {
              if (sql.includes("SET resume_cursor = $4"))
                throw new Error("simulated interruption before batch commit");
              return tx.query(sql, params);
            },
          }),
        );
      },
    };
    await expect(
      runMaintenanceJob(failCheckpoint, {
        jobName: MAINTENANCE_JOBS.railAttestationRetention,
        ownerId: "interrupted-worker",
        batchSize: 1,
        maxBatches: 1,
      }),
    ).rejects.toThrow("simulated interruption");
    const { rows: rolledBack } = await db.query("SELECT transfer_id FROM rail_attestation");
    expect(rolledBack).toHaveLength(3);

    const first = await runMaintenanceJob(db, {
      jobName: MAINTENANCE_JOBS.railAttestationRetention,
      ownerId: "worker-one",
      batchSize: 1,
      maxBatches: 1,
    });
    expect(first).toMatchObject({
      acquired: true,
      completed: false,
      interrupted: true,
      rowsPruned: 1,
      resumeCursor: BigInt(outboundIds[0]!),
    });

    const second = await runMaintenanceJob(db, {
      jobName: MAINTENANCE_JOBS.railAttestationRetention,
      ownerId: "worker-two",
      batchSize: 1,
      maxBatches: 10,
    });
    expect(second.acquired).toBe(true);
    expect(second.completed).toBe(true);
    expect(second.fenceToken).toBeGreaterThan(first.fenceToken!);

    const { rows: attestations } = await db.query(
      "SELECT transfer_id FROM rail_attestation ORDER BY transfer_id",
    );
    expect(attestations.map((row) => Number(row.transfer_id))).toEqual(outboundIds.slice(1));
    const { rows: linkedSource } = await db.query("SELECT id FROM source_event WHERE id = $1", [
      provenance[0]!.id,
    ]);
    expect(linkedSource).toHaveLength(1);
    const { rows: checkpoint } = await db.query(
      "SELECT resume_cursor FROM maintenance_job_lease WHERE job_name = $1",
      [MAINTENANCE_JOBS.railAttestationRetention],
    );
    expect(checkpoint[0]!.resume_cursor).toBe("0");
  });

  it("serializes route-health compaction and retains change boundaries", async () => {
    await db.query(
      `INSERT INTO route_health
         (origin_chain, destination_chain, route, token, sampled_at, available, blocker, flow_available)
       VALUES
         ('maintenance-health', 'destination-test', 0, 'token', now() - INTERVAL '5 days', true, 0, 100),
         ('maintenance-health', 'destination-test', 0, 'token', now() - INTERVAL '4 days', true, 0, 100),
         ('maintenance-health', 'destination-test', 0, 'token', now() - INTERVAL '3 days', true, 0, 100),
         ('maintenance-health', 'destination-test', 0, 'token', now() - INTERVAL '2 days', false, 1, 0)`,
    );

    const result = await runMaintenanceJob(db, {
      jobName: MAINTENANCE_JOBS.routeHealthCompaction,
      ownerId: "health-worker",
      batchSize: 1,
      maxBatches: 10,
    });
    expect(result).toMatchObject({ acquired: true, completed: true, rowsPruned: 1 });
    const { rows } = await db.query(
      `SELECT available FROM route_health
        WHERE origin_chain = 'maintenance-health'
        ORDER BY sampled_at, id`,
    );
    expect(rows.map((row) => row.available)).toEqual([true, true, false]);
  });
});
