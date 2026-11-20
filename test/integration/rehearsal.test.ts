/**
 * Backup and restore rehearsal against a real PostgreSQL (#60).
 *
 * Exports the migrated test database, restores into a separately migrated schema on the same
 * dedicated test server, and validates counts, monetary digests and cursor/provenance joins.
 * Skipped without TEST_DATABASE_URL.
 */
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runner } from "node-pg-migrate";
import { Client } from "pg";
import { Database, type Queryable, type Transactional } from "../../src/db/pool.js";
import { recordSourceEvent, writeOutbound } from "../../src/chains/writers.js";
import {
  exportRehearsalDataset,
  parseRehearsalSnapshot,
  restoreRehearsalDataset,
  validateRehearsalRestore,
} from "../../src/db/rehearsal.js";

const CONNECTION = process.env.TEST_DATABASE_URL;
const suite = CONNECTION === undefined ? describe.skip : describe;
const SCHEMA = `rehearsal_target_${String(process.pid)}_${String(Date.now())}`;
const CHAIN = `rehearsal-int-${String(process.pid)}`;

function scoped(client: Client): Transactional {
  const query = async (sql: string, params: readonly unknown[] = []) => {
    const result = await client.query(sql, [...params]);
    return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? 0 };
  };
  return {
    query,
    async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
      await client.query("BEGIN");
      try {
        const value = await work({ query });
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    },
  };
}

suite("backup and restore rehearsal", () => {
  let source: Database;
  let target: Client;

  beforeAll(async () => {
    source = Database.open(CONNECTION ?? "", { applicationName: "hyperion-rehearsal-test" });
    const transfer = await recordSourceEvent(source, {
      chainKey: CHAIN,
      family: "stellar",
      contract: "CREHEARSAL",
      block: 10n,
      txHash: "rehearsal-tx",
      position: "0000000010-0000000001",
      eventKind: "bridgeOut",
      payloadDigest: "aa".repeat(32),
    });
    await writeOutbound(
      source,
      {
        chainKey: CHAIN,
        router: "CREHEARSAL",
        block: 10n,
        txHash: "rehearsal-tx",
        logIndex: null,
        observedAt: new Date("2026-11-20T00:00:00Z"),
        sourceEventId: transfer.id,
      },
      {
        route: 0,
        nonce: 18446744073709551615n,
        sender: "Gsender",
        token: "CUSDC",
        grossAmount:
          115792089237316195423570985008687907853269984665640564039457584007913129639935n,
        fee: 0n,
        netAmount: 115792089237316195423570985008687907853269984665640564039457584007913129639935n,
        destinationChain: "sepolia",
        destination: "0x01",
        railRef: null,
      },
    );
    await runner({
      databaseUrl: CONNECTION ?? "",
      dir: resolve(process.cwd(), "migrations"),
      migrationsTable: "pgmigrations",
      schema: SCHEMA,
      createSchema: true,
      direction: "up",
      log: () => undefined,
    });
    target = new Client({ connectionString: CONNECTION, options: `-c search_path=${SCHEMA}` });
    await target.connect();
  }, 120_000);

  afterAll(async () => {
    await target.end();
    await source.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await source.query(
      "DELETE FROM public.source_event_link WHERE source_event_id IN (SELECT id FROM public.source_event WHERE chain_key = $1)",
      [CHAIN],
    );
    await source.query("DELETE FROM public.outbound_transfer WHERE origin_chain = $1", [CHAIN]);
    await source.query("DELETE FROM public.source_event WHERE chain_key = $1", [CHAIN]);
    await source.close();
  });

  it("restores into a dedicated schema with matching counts, digests and joins", async () => {
    const snapshot = parseRehearsalSnapshot(JSON.stringify(await exportRehearsalDataset(source)));
    expect(snapshot.manifest.digests.some((entry) => entry.chainKey === CHAIN)).toBe(true);
    const db = scoped(target);
    await restoreRehearsalDataset(db, snapshot);
    expect(await validateRehearsalRestore(db, snapshot.manifest)).toEqual({
      ok: true,
      mismatches: [],
    });
    await expect(restoreRehearsalDataset(db, snapshot)).rejects.toThrow(/not empty/);
  });
});
