/**
 * The schema's own promises, checked against a real Postgres.
 *
 * Every assertion here is a column type or a constraint that was chosen for a reason, and the
 * reason is only worth writing in a comment if something fails when it stops being true. A column
 * declared `NUMERIC(20,0)` because `bigint` is too narrow is a comment until a test proves the
 * overflow, at which point it is a fact.
 *
 * Skipped entirely without `TEST_DATABASE_URL`, so `npm test` on a machine with no database still
 * runs the unit suite rather than failing in a way somebody learns to ignore.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runner } from "node-pg-migrate";
import { Client } from "pg";

import {
  auditTransferAndClaimInvariants,
  compactRouteHealthSamples,
  pruneUnlinkedSourceEvents,
  readOpenIngestionRejections,
  readSourceProvenance,
  reconcileIngestionRejection,
  recordIngestionRejection,
  recordSourceEvent,
  writeClaim,
} from "../../src/chains/writers.js";
import { Database } from "../../src/db/pool.js";
import { concurrencyBarrier, runConcurrent } from "../helpers.js";

const CONNECTION = process.env.TEST_DATABASE_URL;
const suite = CONNECTION === undefined ? describe.skip : describe;

/** Postgres error codes, so a test asserts on the failure it meant rather than on any failure. */
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const NUMERIC_OUT_OF_RANGE = "22003";
const MIGRATION_TEST_SCHEMA = `migration_lock_test_${process.pid}_${Date.now()}`;

const U64_MAX = "18446744073709551615";
const U256_MAX = "115792089237316195423570985008687907853269984665640564039457584007913129639935";

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

suite("the schema", () => {
  let db: Database;

  beforeAll(async () => {
    db = Database.open(CONNECTION ?? "", { applicationName: "hyperion-schema-test" });
    // A schema of its own, dropped and recreated, so a failed run leaves nothing behind and two
    // test files can share one database without seeing each other's rows.
    await db.query("DROP SCHEMA IF EXISTS schema_test CASCADE");
    await db.query("CREATE SCHEMA schema_test");
    await db.query("SET search_path TO schema_test");
  });

  afterAll(async () => {
    await db.query("DROP SCHEMA IF EXISTS schema_test CASCADE");
    await db.close();
  });

  it("has every table the indexer and the keeper read", async () => {
    // Against the public schema, which is what the migration actually wrote.
    const { rows } = await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
    );
    const names = rows.map((row) => String(row.table_name));
    for (const table of [
      "admin_action",
      "axelar_delivery_evidence",
      "axelar_status_quarantine",
      "inbound_delivery",
      "indexed_history_digest",
      "indexer_cursor",
      "indexer_worker_heartbeat",
      "ingestion_rejection",
      "outbound_transfer",
      "pending_claim",
      "rail_attestation",
      "route_health",
      "source_event",
      "source_event_conflict",
      "source_event_link",
    ]) {
      expect(names, `${table} is missing; has the migration run`).toContain(table);
    }
  });

  it("serializes real SQL migration runners and applies each step once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hyperion-migration-lock-"));
    const file = join(directory, "1790900000000_lock-test.sql");
    await writeFile(
      file,
      "-- Up Migration\nSELECT pg_sleep(1); CREATE TABLE lock_once (id integer PRIMARY KEY); INSERT INTO lock_once VALUES (1);\n-- Down Migration\nDROP TABLE lock_once;",
    );
    const run = (applicationName: string) =>
      runner({
        databaseUrl: { connectionString: CONNECTION ?? "", application_name: applicationName },
        dir: directory,
        migrationsTable: "pgmigrations",
        schema: MIGRATION_TEST_SCHEMA,
        createSchema: true,
        direction: "up",
        advisoryLockMode: "wait",
        log: () => undefined,
      });
    const first = run("hyperion-migration-lock-first");
    let second: Promise<unknown> | undefined;
    let secondRunnerWaiting = false;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        const { rows } = await db.query(
          "SELECT 1 FROM pg_stat_activity WHERE application_name='hyperion-migration-lock-first' AND wait_event='PgSleep'",
        );
        if (rows.length) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      second = run("hyperion-migration-lock-second");
      for (let attempt = 0; attempt < 100; attempt++) {
        const { rows } = await db.query(
          "SELECT 1 FROM pg_stat_activity WHERE application_name='hyperion-migration-lock-second' AND wait_event_type='Lock' AND wait_event='advisory'",
        );
        if (rows.length) {
          secondRunnerWaiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const outcomes = await Promise.allSettled([first, second]);
      expect(outcomes.map((value) => value.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(secondRunnerWaiting).toBe(true);
      const { rows } = await db.query(
        `SELECT count(*)::integer AS count FROM "${MIGRATION_TEST_SCHEMA}".lock_once`,
      );
      expect(rows[0]?.count).toBe(1);
    } finally {
      await Promise.allSettled([first, ...(second ? [second] : [])]);
      await db.query(`DROP SCHEMA IF EXISTS "${MIGRATION_TEST_SCHEMA}" CASCADE`);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("releases advisory ownership after a failed SQL migration and permits a clean retry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hyperion-migration-failure-"));
    const file = join(directory, "1790900000000_failure-test.sql");
    const schema = MIGRATION_TEST_SCHEMA + "_failed";
    const run = () =>
      runner({
        databaseUrl: CONNECTION ?? "",
        dir: directory,
        migrationsTable: "pgmigrations",
        schema,
        createSchema: true,
        direction: "up",
        advisoryLockMode: "wait",
        log: () => undefined,
      });
    try {
      await writeFile(file, "-- Up Migration\nSELECT 1/0;\n-- Down Migration\nSELECT 1;");
      await expect(run()).rejects.toThrow();
      await writeFile(
        file,
        "-- Up Migration\nCREATE TABLE retry_once(id integer PRIMARY KEY); INSERT INTO retry_once VALUES (1);\n-- Down Migration\nDROP TABLE retry_once;",
      );
      await expect(run()).resolves.toHaveLength(1);
    } finally {
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("releases migration ownership when PostgreSQL interrupts the runner", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hyperion-migration-interrupted-"));
    const file = join(directory, "1790900000000_interrupted.sql");
    const schema = `${MIGRATION_TEST_SCHEMA}_interrupted`;
    const interruptedClient = new Client({
      connectionString: CONNECTION ?? "",
      application_name: "hyperion-migration-interrupted",
    });
    const connectionErrors: Error[] = [];
    interruptedClient.on("error", (error: Error) => connectionErrors.push(error));
    const run = () =>
      runner({
        databaseUrl: {
          connectionString: CONNECTION ?? "",
          application_name: "hyperion-migration-interrupted",
        },
        dir: directory,
        migrationsTable: "pgmigrations",
        schema,
        createSchema: true,
        direction: "up",
        advisoryLockMode: "wait",
        log: () => undefined,
      });
    try {
      await writeFile(
        file,
        "-- Up Migration\nSELECT pg_sleep(30); CREATE TABLE interrupted_once(id integer PRIMARY KEY);\n-- Down Migration\nDROP TABLE interrupted_once;",
      );
      // Attach the rejection handler before interrupting the connection.
      await interruptedClient.connect();
      const interrupted = runner({
        dbClient: interruptedClient,
        dir: directory,
        migrationsTable: "pgmigrations",
        schema,
        createSchema: true,
        direction: "up",
        advisoryLockMode: "wait",
        log: () => undefined,
      }).then(
        () => null,
        (error: unknown) => error,
      );
      let pid: number | null = null;
      for (let attempt = 0; attempt < 100 && pid === null; attempt += 1) {
        const result = await db.query(
          "SELECT pid FROM pg_stat_activity WHERE application_name='hyperion-migration-interrupted' AND query LIKE '%pg_sleep(30)%' AND state='active'",
        );
        const value = result.rows[0]?.pid;
        if (typeof value === "number") pid = value;
        else await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(pid).not.toBeNull();
      await db.query("SELECT pg_terminate_backend($1)", [pid]);
      expect(await interrupted).toBeInstanceOf(Error);
      expect(
        connectionErrors.every((error) => error.message === "Connection terminated unexpectedly"),
      ).toBe(true);
      await writeFile(
        file,
        "-- Up Migration\nCREATE TABLE interrupted_once(id integer PRIMARY KEY); INSERT INTO interrupted_once VALUES(1);\n-- Down Migration\nDROP TABLE interrupted_once;",
      );
      await expect(run()).resolves.toHaveLength(1);
      const result = await db.query(
        `SELECT count(*)::int AS count FROM "${schema}".interrupted_once`,
      );
      expect(result.rows[0]?.count).toBe(1);
    } finally {
      await interruptedClient.end();
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);

  it("holds a u64 that bigint cannot", async () => {
    // The entire reason nonces and claim ids are NUMERIC(20,0). Postgres int8 stops at 2^63-1 and
    // a u64 goes to 2^64-1, so a long lived router eventually emits a nonce that would fail to
    // insert. This is the assertion that makes that a fact rather than a comment.
    await expect(db.query(`SELECT ${U64_MAX}::bigint`)).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === NUMERIC_OUT_OF_RANGE,
    );

    const { rows } = await db.query(`SELECT ${U64_MAX}::numeric(20,0) AS value`);
    expect(String(rows[0]?.value)).toBe(U64_MAX);
  });

  it("holds a uint256 without losing a digit", async () => {
    const { rows } = await db.query(`SELECT ${U256_MAX}::numeric(78,0) AS value`);
    expect(String(rows[0]?.value)).toBe(U256_MAX);
  });

  it("lets a cursor carry a block hash, and lets it be absent", async () => {
    // Added in the second migration for the EVM watcher. Nullable on purpose: a Stellar cursor
    // has nothing to put here and never will, and a NOT NULL column with a placeholder in half
    // the rows is a column that means two things.
    await db.query(
      "DELETE FROM public.indexer_cursor WHERE chain_key IN ('hash-test', 'no-hash-test')",
    );
    await db.query(
      "INSERT INTO public.indexer_cursor (chain_key, family, contract, last_processed, last_processed_hash) VALUES ('hash-test', 'evm', '0xrouter', 42, $1), ('no-hash-test', 'stellar', 'CROUTER', 42, NULL)",
      [`0x${"ab".repeat(32)}`],
    );

    const { rows } = await db.query(
      `SELECT chain_key, last_processed_hash FROM public.indexer_cursor
        WHERE chain_key IN ('hash-test', 'no-hash-test') ORDER BY chain_key`,
    );
    expect(rows.map((row) => row.last_processed_hash)).toEqual([`0x${"ab".repeat(32)}`, null]);

    await db.query(
      "DELETE FROM public.indexer_cursor WHERE chain_key IN ('hash-test', 'no-hash-test')",
    );
  });

  it("refuses a family that is neither of the two that exist", async () => {
    await expect(
      db.query(
        `INSERT INTO public.indexer_cursor (chain_key, family, contract, last_processed)
         VALUES ('bad-family', 'solana', 'x', 1)`,
      ),
    ).rejects.toSatisfy((error: unknown) => codeOf(error) === CHECK_VIOLATION);
  });

  it("configures autovacuum storage parameters on indexer_cursor", async () => {
    const { rows } = await db.query(
      "SELECT reloptions FROM pg_class WHERE relname = 'indexer_cursor'",
    );
    expect(rows.length).toBe(1);
    const reloptions = rows[0]?.reloptions as string[] | null;
    expect(reloptions).toBeDefined();
    expect(reloptions).toContain("autovacuum_vacuum_scale_factor=0.05");
    expect(reloptions).toContain("autovacuum_vacuum_cost_limit=500");
  });

  it("serializes competing worker transactions without losing an update", async () => {
    await db.query(
      "CREATE TABLE IF NOT EXISTS public.hyperion_concurrency_test (id integer PRIMARY KEY, value integer NOT NULL)",
    );
    await db.query("DELETE FROM public.hyperion_concurrency_test");
    await db.query("INSERT INTO public.hyperion_concurrency_test (id, value) VALUES (1, 0)");

    const started = concurrencyBarrier(2);
    const lockReady = concurrencyBarrier(2);
    const outcomes = await runConcurrent(2, async (worker) =>
      db.transaction(async (tx) => {
        await tx.query("SET LOCAL lock_timeout = '2s'");
        await started.wait();
        if (worker === 0) {
          await tx.query(
            "UPDATE public.hyperion_concurrency_test SET value = value + 1 WHERE id = 1",
          );
          await lockReady.wait();
        } else {
          await lockReady.wait();
          await tx.query(
            "UPDATE public.hyperion_concurrency_test SET value = value + 1 WHERE id = 1",
          );
        }
        return worker;
      }),
    );

    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
    const { rows } = await db.query(
      "SELECT value FROM public.hyperion_concurrency_test WHERE id = 1",
    );
    expect(rows[0]?.value).toBe(2);
    await db.query("DROP TABLE public.hyperion_concurrency_test");
  });
});

suite("outbound_transfer", () => {
  let db: Database;
  let nonce = 1_000_000;

  const insert = async (gross: string, fee: string, net: string): Promise<void> => {
    nonce += 1;
    await db.query(
      `INSERT INTO public.outbound_transfer
         (origin_chain, origin_router, route, nonce, sender, token, gross_amount, fee, net_amount,
          destination_chain, destination, origin_block, origin_tx)
       VALUES ('base-sepolia', $1, 0, $2, '0xsender', '0xtoken', $3, $4, $5,
               'stellar-testnet', 'GA5ZYIIV', 1, $6)`,
      [`router-${String(nonce)}`, String(nonce), gross, fee, net, `0xtx-${String(nonce)}`],
    );
  };

  beforeAll(() => {
    db = Database.open(CONNECTION ?? "", { applicationName: "hyperion-schema-test" });
  });

  afterAll(async () => {
    await db.query("DELETE FROM public.outbound_transfer WHERE origin_chain = 'base-sepolia'");
    await db.close();
  });

  it("refuses a split that does not add up", async () => {
    // The router guarantees gross equals fee plus net. Asserting it in the database turns a
    // decoder reading a field off the wrong offset into a failed insert rather than a plausible
    // row that quietly misreports what somebody was charged.
    await expect(insert("1000", "3", "996")).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === CHECK_VIOLATION,
    );
  });

  it("accepts a split that does", async () => {
    await expect(insert("1000", "3", "997")).resolves.toBeUndefined();
  });

  it("accepts a zero fee, because the fee rate can be zero", async () => {
    await expect(insert("1000", "0", "1000")).resolves.toBeUndefined();
  });

  it("allows the same nonce across router deployments", async () => {
    nonce += 1;
    const insertFor = async (router: string, tx: string): Promise<void> => {
      await db.query(
        `INSERT INTO public.outbound_transfer
           (origin_chain, origin_router, route, nonce, sender, token, gross_amount, fee, net_amount,
            destination_chain, destination, origin_block, origin_tx)
         VALUES ('base-sepolia', $1, 0, $2, '0xsender', '0xtoken', 1000, 3, 997,
                 'stellar-testnet', 'GA5ZYIIV', 1, $3)`,
        [router, String(nonce), tx],
      );
    };
    await insertFor("router-a", `0xtx-${String(nonce)}-a`);
    await expect(insertFor("router-b", `0xtx-${String(nonce)}-b`)).resolves.toBeUndefined();
  });

  it("refuses two departures with the same nonce from one router deployment", async () => {
    nonce += 1;
    const insertFor = async (tx: string): Promise<void> => {
      await db.query(
        `INSERT INTO public.outbound_transfer
           (origin_chain, origin_router, route, nonce, sender, token, gross_amount, fee, net_amount,
            destination_chain, destination, origin_block, origin_tx)
         VALUES ('base-sepolia', 'router-single', 0, $1, '0xsender', '0xtoken', 1000, 3, 997,
                 'stellar-testnet', 'GA5ZYIIV', 1, $2)`,
        [String(nonce), tx],
      );
    };
    await insertFor(`0xtx-${String(nonce)}-a`);
    await expect(insertFor(`0xtx-${String(nonce)}-b`)).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === UNIQUE_VIOLATION,
    );
  });
});

suite("inbound_delivery", () => {
  let db: Database;
  let seq = 2_000_000;

  interface Arrival {
    readonly chain?: string;
    readonly sourceNonce?: string;
    readonly messageId?: string | null;
    readonly delivered: boolean;
    readonly claimId?: string | null;
  }

  const insert = async (arrival: Arrival): Promise<void> => {
    seq += 1;
    await db.query(
      `INSERT INTO public.inbound_delivery
         (destination_chain, route, source_chain, source_nonce, rail_message_id,
          recipient, token, amount, delivered, claim_id, destination_block, destination_tx)
       VALUES ($1, 0, 'origin-test', $2, $3, 'recipient', 'token', 100, $4, $5, 1, $6)`,
      [
        arrival.chain ?? "inbound-test",
        arrival.sourceNonce ?? String(seq),
        arrival.messageId === undefined ? `0xmsg-${String(seq)}` : arrival.messageId,
        arrival.delivered,
        arrival.claimId ?? null,
        `0xtx-${String(seq)}`,
      ],
    );
  };

  beforeAll(() => {
    db = Database.open(CONNECTION ?? "", { applicationName: "hyperion-schema-test" });
  });

  afterAll(async () => {
    await db.query(
      "DELETE FROM public.inbound_delivery WHERE destination_chain IN ('inbound-test', 'stellar-shape-test')",
    );
    await db.close();
  });

  it("insists a delivery either landed or parked, never both", async () => {
    await expect(insert({ delivered: true, claimId: "7" })).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === CHECK_VIOLATION,
    );
    await expect(insert({ delivered: false, claimId: null })).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === CHECK_VIOLATION,
    );
  });

  it("accepts both honest shapes", async () => {
    await expect(insert({ delivered: true })).resolves.toBeUndefined();
    await expect(insert({ delivered: false, claimId: "9" })).resolves.toBeUndefined();
  });

  it("lets many Stellar arrivals coexist without a message id", async () => {
    // The reason the unique index on rail_message_id is partial. The Soroban BridgeIn event does
    // not emit the message id its own replay guard is keyed on, so every Stellar arrival offers
    // null here, and a plain unique index would let exactly one of them exist.
    await expect(
      insert({ chain: "stellar-shape-test", messageId: null, delivered: true }),
    ).resolves.toBeUndefined();
    await expect(
      insert({ chain: "stellar-shape-test", messageId: null, delivered: true }),
    ).resolves.toBeUndefined();
  });

  it("refuses the same rail message twice", async () => {
    await insert({ messageId: "0xduplicate", delivered: true });
    await expect(insert({ messageId: "0xduplicate", delivered: true })).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === UNIQUE_VIOLATION,
    );
  });

  it("refuses the same hop twice, which is the only key Stellar can offer", async () => {
    await insert({ sourceNonce: "4242", delivered: true });
    await expect(insert({ sourceNonce: "4242", delivered: true })).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === UNIQUE_VIOLATION,
    );
  });
});

suite("maintenance and pruning", () => {
  let db: Database;

  beforeAll(() => {
    db = Database.open(CONNECTION ?? "", { applicationName: "hyperion-schema-test" });
  });

  afterAll(async () => {
    await db.query(
      "DELETE FROM public.rail_attestation WHERE transfer_id IN (999991, 999992, 999993)",
    );
    await db.query("DELETE FROM public.outbound_transfer WHERE id IN (999991, 999992, 999993)");
    await db.close();
  });

  it("cleans up completed attestation audit rows older than 30 days", async () => {
    await db.query(
      `INSERT INTO public.outbound_transfer
         (id, origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
          destination_chain, destination, origin_block, origin_tx)
       VALUES (999991, 'prune-test-1', 0, 999991, '0xsender', '0xtoken', 100, 0, 100,
               'stellar-testnet', 'GA5ZYIIV', 1, '0xtx-1'),
              (999992, 'prune-test-2', 0, 999992, '0xsender', '0xtoken', 100, 0, 100,
               'stellar-testnet', 'GA5ZYIIV', 1, '0xtx-2'),
              (999993, 'prune-test-3', 0, 999993, '0xsender', '0xtoken', 100, 0, 100,
               'stellar-testnet', 'GA5ZYIIV', 1, '0xtx-3')
       ON CONFLICT (origin_chain, origin_router, nonce) DO NOTHING`,
    );

    // Old completed attestation (40 days old)
    await db.query(
      `INSERT INTO public.rail_attestation (transfer_id, route, status, updated_at)
       VALUES (999991, 0, 'delivered', now() - INTERVAL '40 days')
       ON CONFLICT (transfer_id) DO UPDATE SET status = 'delivered', updated_at = now() - INTERVAL '40 days'`,
    );

    // Recent completed attestation (5 days old)
    await db.query(
      `INSERT INTO public.rail_attestation (transfer_id, route, status, updated_at)
       VALUES (999992, 0, 'delivered', now() - INTERVAL '5 days')
       ON CONFLICT (transfer_id) DO UPDATE SET status = 'delivered', updated_at = now() - INTERVAL '5 days'`,
    );

    // Old in-progress attestation (40 days old) - should NOT be pruned
    await db.query(
      `INSERT INTO public.rail_attestation (transfer_id, route, status, updated_at)
       VALUES (999993, 0, 'pending', now() - INTERVAL '40 days')
       ON CONFLICT (transfer_id) DO UPDATE SET status = 'pending', updated_at = now() - INTERVAL '40 days'`,
    );

    const deletedCount = await db.pruneCompletedAttestations(30);
    expect(deletedCount).toBeGreaterThanOrEqual(1);

    const { rows } = await db.query(
      "SELECT transfer_id FROM public.rail_attestation WHERE transfer_id IN (999991, 999992, 999993)",
    );
    const ids = rows.map((r) => Number(r.transfer_id));
    expect(ids).not.toContain(999991);
    expect(ids).toContain(999992);
    expect(ids).toContain(999993);
  });

  it("compacts old identical route_health samples in bounded batches while preserving change boundaries", async () => {
    await db.query("DELETE FROM public.route_health WHERE origin_chain = 'compact-test'");
    // 5 identical old samples (t-10d .. t-6d), then a state change (t-5d), then 2 recent samples (t-2h, t-1h)
    await db.query(
      `INSERT INTO public.route_health
         (sampled_at, origin_chain, destination_chain, route, token, available, blocker, flow_available)
       VALUES
         (now() - INTERVAL '10 days', 'compact-test', 'stellar-testnet', 0, 'USDC', true, 0, 1000),
         (now() - INTERVAL '9 days',  'compact-test', 'stellar-testnet', 0, 'USDC', true, 0, 1000),
         (now() - INTERVAL '8 days',  'compact-test', 'stellar-testnet', 0, 'USDC', true, 0, 1000),
         (now() - INTERVAL '7 days',  'compact-test', 'stellar-testnet', 0, 'USDC', true, 0, 1000),
         (now() - INTERVAL '6 days',  'compact-test', 'stellar-testnet', 0, 'USDC', true, 0, 1000),
         (now() - INTERVAL '5 days',  'compact-test', 'stellar-testnet', 0, 'USDC', false, 1, 0),
         (now() - INTERVAL '2 hours', 'compact-test', 'stellar-testnet', 0, 'USDC', false, 1, 0),
         (now() - INTERVAL '1 hours', 'compact-test', 'stellar-testnet', 0, 'USDC', false, 1, 0)`,
    );

    const firstPass = await compactRouteHealthSamples(db, { retainRecentHours: 24, batchSize: 2 });
    expect(firstPass.deleted).toBe(2);

    const secondPass = await compactRouteHealthSamples(db, {
      retainRecentHours: 24,
      batchSize: 10,
    });
    expect(secondPass.deleted).toBe(1);

    const thirdPass = await compactRouteHealthSamples(db, { retainRecentHours: 24, batchSize: 10 });
    expect(thirdPass.deleted).toBe(0);

    const { rows } = await db.query(
      "SELECT available, blocker FROM public.route_health WHERE origin_chain = 'compact-test' ORDER BY sampled_at ASC, id ASC",
    );
    // Kept: first (t-10d), last of first run (t-6d), change boundary (t-5d), and both recent (t-2h, t-1h)
    expect(rows).toHaveLength(5);
  });

  it("audits transfer and claim invariants without mutating state", async () => {
    const report = await auditTransferAndClaimInvariants(db);
    expect(report).toHaveProperty("ok");
    expect(Array.isArray(report.sourceAmountViolations)).toBe(true);
    expect(Array.isArray(report.claimLiabilityViolations)).toBe(true);
    expect(Array.isArray(report.deliverySettlementViolations)).toBe(true);
    expect(Array.isArray(report.unsettledLiabilities)).toBe(true);
  });
});

suite("ingestion rejections", () => {
  let db: Database;
  const chainKey = `rejection-schema-${process.pid}`;
  const source = {
    chainKey,
    family: "evm" as const,
    contract: "0x00000000000000000000000000000000000000aa",
    block: BigInt(U64_MAX),
    txHash: `0x${"ab".repeat(32)}`,
    position: 7,
  };

  beforeAll(() => {
    db = Database.open(CONNECTION ?? "", { applicationName: "hyperion-schema-test" });
  });

  afterAll(async () => {
    await db.query("DELETE FROM public.ingestion_rejection WHERE chain_key = $1", [chainKey]);
    await db.close();
  });

  it("keeps full-width source references and reconciles only on successful replay", async () => {
    await recordIngestionRejection(db, {
      ...source,
      errorClass: "unsupported_payload",
      detail: "LogShapeError via https://rpc.example/key/abc123",
    });
    const [open] = await readOpenIngestionRejections(db, chainKey);
    expect(open).toMatchObject({
      block: BigInt(U64_MAX),
      txHash: source.txHash,
      position: "7",
      errorClass: "unsupported_payload",
      replayEligible: true,
      detail: "LogShapeError via [redacted URL]",
    });
    expect(await reconcileIngestionRejection(db, source)).toBe(true);
    expect(await readOpenIngestionRejections(db, chainKey)).toHaveLength(0);
  });

  it("rejects credential-bearing detail, unbounded payloads and unknown classes", async () => {
    const insert = (detail: string, payload: string, errorClass = "decode_error") =>
      db.query(
        `INSERT INTO public.ingestion_rejection
           (chain_key, family, contract, block_number, tx_hash, source_position, error_class,
            replay_eligible, detail, payload)
         VALUES ($1, 'evm', '0xrouter', 1, '0xtx', 'check', $2, true, $3, $4::jsonb)`,
        [chainKey, errorClass, detail, payload],
      );
    for (const attempt of [
      insert("postgresql://u:p@db/hyperion", "{}"),
      insert("api_key=abc", "{}"),
      insert("ok", JSON.stringify({ blob: "z".repeat(5000) })),
      insert("ok", "[]"),
      insert("ok", "{}", "provider_status"),
    ]) {
      await expect(attempt).rejects.toSatisfy((error) => codeOf(error) === CHECK_VIOLATION);
    }
  });
});

suite("source event provenance", () => {
  let db: Database;
  const chainKey = `provenance-schema-${process.pid}`;
  const identity = {
    chainKey,
    family: "evm" as const,
    contract: "0x00000000000000000000000000000000000000bb",
    block: BigInt(U64_MAX),
    txHash: `0x${"ab".repeat(32)}`,
    position: 4,
    eventKind: "ClaimParked",
    payloadDigest: "cd".repeat(32),
  };

  beforeAll(() => {
    db = Database.open(CONNECTION ?? "", { applicationName: "hyperion-schema-test" });
  });

  afterAll(async () => {
    await db.query(
      "DELETE FROM public.source_event_link WHERE source_event_id IN (SELECT id FROM public.source_event WHERE chain_key = $1)",
      [chainKey],
    );
    await db.query(
      "DELETE FROM public.source_event_conflict WHERE source_event_id IN (SELECT id FROM public.source_event WHERE chain_key = $1)",
      [chainKey],
    );
    await db.query("DELETE FROM public.source_event WHERE chain_key = $1", [chainKey]);
    await db.query("DELETE FROM public.pending_claim WHERE chain = $1", [chainKey]);
    await db.close();
  });

  it("links replays to one raw identity and keeps the original digest on conflict", async () => {
    const first = await recordSourceEvent(db, identity);
    const at = {
      chainKey,
      block: BigInt(U64_MAX),
      txHash: identity.txHash,
      logIndex: 4,
      observedAt: new Date("2026-11-20T00:00:00Z"),
      sourceEventId: first.id,
    };
    const claim = {
      claimId: BigInt(U64_MAX),
      recipient: "0xrecipient",
      token: "0xtoken",
      amount: BigInt(U256_MAX),
      route: 0,
      sourceChain: "stellar-testnet",
      sourceNonce: 1n,
      createdAt: at.observedAt,
    };
    await writeClaim(db, at, claim);
    const replay = await recordSourceEvent(db, identity);
    await writeClaim(db, { ...at, sourceEventId: replay.id }, claim);
    expect(replay).toEqual({ kind: "replay", id: first.id });
    const links = await readSourceProvenance(db, "pending_claim", `${chainKey}:${U64_MAX}`);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ block: BigInt(U64_MAX), replays: 1, conflicts: 0 });

    expect(
      (await recordSourceEvent(db, { ...identity, payloadDigest: "ef".repeat(32) })).kind,
    ).toBe("conflict");
    const stored = await db.query("SELECT payload_digest FROM public.source_event WHERE id = $1", [
      first.id.toString(),
    ]);
    expect(stored.rows[0]?.payload_digest).toBe(identity.payloadDigest);
    await expect(
      db.query("UPDATE public.source_event SET payload_digest = $1 WHERE id = $2", [
        "ef".repeat(32),
        first.id.toString(),
      ]),
    ).rejects.toSatisfy((error) => codeOf(error) === CHECK_VIOLATION);
    await expect(
      db.query("DELETE FROM public.source_event WHERE id = $1", [first.id.toString()]),
    ).rejects.toSatisfy((error) => codeOf(error) === "23503");
    expect(
      await pruneUnlinkedSourceEvents(db, new Date(Date.now() + 60_000), 10),
    ).toBeGreaterThanOrEqual(0);
    expect(
      (await db.query("SELECT 1 FROM public.source_event WHERE id = $1", [first.id.toString()]))
        .rows,
    ).toHaveLength(1);
  });
});
