import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { AddressKind, encodeStellarAddress } from "@hyperion/protocol";
import pino from "pino";

import { settleClaim, writeClaim, writeInbound, writeOutbound } from "../src/chains/writers.js";
import {
  Database,
  type Queryable,
  type QueryResultRows,
  type Transactional,
} from "../src/db/pool.js";
import { RailPass } from "../src/rails/pass.js";
import type { PendingTransfer, RailClient } from "../src/rails/types.js";

export const PG_DEADLOCK_DETECTED = "40P01";
export const PG_LOCK_NOT_AVAILABLE = "55P03";
export const PG_SERIALIZATION_FAILURE = "40001";

const RETRYABLE_PG_CODES = new Set([
  PG_DEADLOCK_DETECTED,
  PG_LOCK_NOT_AVAILABLE,
  PG_SERIALIZATION_FAILURE,
]);

const PRODUCTION_HOST_PATTERNS = [
  /(?:^|[.-])prod(?:uction)?(?:[.-]|$)/i,
  /(?:^|[.-])mainnet(?:[.-]|$)/i,
  /\.rds\.amazonaws\.com$/i,
  /\.neon\.tech$/i,
  /\.supabase\.co$/i,
];

const MIGRATION_FILES = [
  "1790900000000_initial-schema.sql",
  "1791000000000_cursor-block-hash.sql",
  "1791100000000_cursor-autovacuum-tuning.sql",
] as const;

export class ConcurrencySafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrencySafetyError";
  }
}

export interface DedicatedConcurrencyDbConfig {
  readonly connectionString: string;
  readonly sanitizedTarget: string;
  readonly schemaName: string;
}

function redactDbUrl(url: URL): string {
  const clone = new URL(url.toString());
  if (clone.username !== "") clone.username = "[redacted]";
  if (clone.password !== "") clone.password = "[redacted]";
  return clone.toString();
}

function normalizeDbIdentity(url: URL): string {
  const defaultPort = "5432";
  const port = url.port === "" ? defaultPort : url.port;
  const dbName = url.pathname.replace(/^\/+/, "");
  return `${url.hostname.toLowerCase()}:${port}/${dbName}`;
}

/**
 * Guard ensuring the multi-worker concurrency runner NEVER points at a production or primary
 * application database without explicit separate test configuration.
 */
export function resolveDedicatedConcurrencyDbConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DedicatedConcurrencyDbConfig {
  if (
    (env.NODE_ENV === "production" || env.HYPERION_NETWORK === "mainnet") &&
    env.HYPERION_CONCURRENCY_ALLOW_NON_TEST_ENV !== "true"
  ) {
    throw new ConcurrencySafetyError(
      "Refusing to run multi-worker concurrency suite when NODE_ENV=production or HYPERION_NETWORK=mainnet without HYPERION_CONCURRENCY_ALLOW_NON_TEST_ENV=true",
    );
  }

  const explicitUrl =
    env.HYPERION_CONCURRENCY_TEST_DB_URL ??
    (env.HYPERION_ALLOW_TEST_DATABASE_CONCURRENCY === "true" ? env.TEST_DATABASE_URL : undefined);

  if (explicitUrl === undefined || explicitUrl.trim() === "") {
    throw new ConcurrencySafetyError(
      "Refusing to run multi-worker concurrency suite without explicit HYPERION_CONCURRENCY_TEST_DB_URL (or TEST_DATABASE_URL with HYPERION_ALLOW_TEST_DATABASE_CONCURRENCY=true)",
    );
  }

  let parsedTarget: URL;
  try {
    parsedTarget = new URL(explicitUrl);
  } catch {
    throw new ConcurrencySafetyError(
      "Invalid dedicated concurrency database URL (credentials redacted)",
    );
  }

  if (parsedTarget.protocol !== "postgres:" && parsedTarget.protocol !== "postgresql:") {
    throw new ConcurrencySafetyError(
      `Unsupported database protocol '${parsedTarget.protocol}' for PostgreSQL concurrency runner`,
    );
  }

  const sanitizedTarget = redactDbUrl(parsedTarget);

  if (env.DATABASE_URL !== undefined && env.DATABASE_URL.trim() !== "") {
    try {
      const parsedPrimary = new URL(env.DATABASE_URL);
      if (normalizeDbIdentity(parsedTarget) === normalizeDbIdentity(parsedPrimary)) {
        throw new ConcurrencySafetyError(
          `Refusing to run concurrency suite against the same database as DATABASE_URL (${sanitizedTarget})`,
        );
      }
    } catch (err) {
      if (err instanceof ConcurrencySafetyError) throw err;
    }
  }

  const dbName = parsedTarget.pathname.replace(/^\/+/, "");
  const looksLikeProdHost = PRODUCTION_HOST_PATTERNS.some((re) => re.test(parsedTarget.hostname));
  const looksLikeTestDb = /(?:test|ci|bench|concurrency|local|dev)/i.test(dbName);

  if (
    (looksLikeProdHost || !looksLikeTestDb) &&
    env.HYPERION_CONCURRENCY_CONFIRM_EXTERNAL_TEST_DB !== "true"
  ) {
    throw new ConcurrencySafetyError(
      `Refusing to run concurrency suite against non-test host or database (${sanitizedTarget}) without HYPERION_CONCURRENCY_CONFIRM_EXTERNAL_TEST_DB=true`,
    );
  }

  const rawSchema = env.HYPERION_CONCURRENCY_SCHEMA ?? "hyperion_concurrency_test";
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(rawSchema)) {
    throw new ConcurrencySafetyError(`Invalid PostgreSQL schema identifier '${rawSchema}'`);
  }

  return {
    connectionString: explicitUrl,
    sanitizedTarget,
    schemaName: rawSchema,
  };
}

export function pgSqlState(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const raw = (error as { code?: unknown }).code;
    return typeof raw === "string" ? raw : undefined;
  }
  return undefined;
}

export function createPgStateError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

export interface RetryTelemetry {
  readonly attempts: number;
  readonly deadlocksRecovered: number;
  readonly lockTimeoutsRecovered: number;
  readonly serializationFailuresRecovered: number;
}

export async function runWithConcurrencyRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: {
    readonly maxAttempts?: number;
    readonly baseDelayMs?: number;
    readonly sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ readonly result: T; readonly telemetry: RetryTelemetry }> {
  const maxAttempts = options.maxAttempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 5;
  const sleepFn =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve();
        }, ms);
      }));

  let deadlocksRecovered = 0;
  let lockTimeoutsRecovered = 0;
  let serializationFailuresRecovered = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await operation(attempt);
      return {
        result,
        telemetry: {
          attempts: attempt,
          deadlocksRecovered,
          lockTimeoutsRecovered,
          serializationFailuresRecovered,
        },
      };
    } catch (err) {
      const code = pgSqlState(err);
      if (code === undefined || !RETRYABLE_PG_CODES.has(code) || attempt >= maxAttempts) {
        throw err;
      }
      if (code === PG_DEADLOCK_DETECTED) deadlocksRecovered += 1;
      else if (code === PG_LOCK_NOT_AVAILABLE) lockTimeoutsRecovered += 1;
      else if (code === PG_SERIALIZATION_FAILURE) serializationFailuresRecovered += 1;

      const delay = baseDelayMs * attempt;
      if (delay > 0) {
        await sleepFn(delay);
      }
    }
  }

  throw new Error("Unreachable concurrency retry exhaustion");
}

export function createAsyncBarrier(parties: number): {
  arrive(): Promise<void>;
} {
  let arrived = 0;
  let releaseAll!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseAll = resolve;
  });

  return {
    async arrive(): Promise<void> {
      arrived += 1;
      if (arrived >= parties) {
        releaseAll();
      }
      await gate;
    },
  };
}

export interface ConcurrencyRunnerReport {
  readonly leaseConflicts: number;
  readonly cursorConflicts: number;
  readonly claimSettlementWinners: number;
  readonly claimSettlementConflicts: number;
  readonly migrationWinners: number;
  readonly migrationLeaseSkips: number;
  readonly finalCursorBlock: string;
  readonly outboundCount: number;
  readonly railAttestationCount: number;
  readonly fakeDeliveredCount: number;
  readonly settledClaimCount: number;
}

export interface DedicatedConcurrencyPGliteDb extends Transactional {
  close(): Promise<void>;
}

export async function applyConcurrencyBaseSchema(db: Queryable): Promise<void> {
  for (const name of MIGRATION_FILES) {
    const fullPath = fileURLToPath(new URL(`../migrations/${name}`, import.meta.url));
    const upSql = readFileSync(fullPath, "utf8").split(/^--\s*Down Migration\b/m)[0] ?? "";
    await db.query(upSql);
  }
  await db.query(`
    CREATE TABLE IF NOT EXISTS worker_lease (
      lease_key   text PRIMARY KEY,
      holder_id   text NOT NULL,
      acquired_at timestamptz NOT NULL DEFAULT now(),
      expires_at  timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pgmigrations (
      id serial PRIMARY KEY,
      name varchar(255) NOT NULL UNIQUE,
      run_on timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export async function createDedicatedConcurrencyPGliteDb(): Promise<DedicatedConcurrencyPGliteDb> {
  const pg = await PGlite.create();
  let txLock: Promise<void> = Promise.resolve();

  const runQuery = async (
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResultRows> => {
    const normalized = params.map((p) => (p instanceof Date ? p.toISOString() : p));
    const result =
      normalized.length === 0 && sql.includes(";")
        ? await (async () => {
            await pg.exec(sql);
            return { rows: [], fields: [], affectedRows: 0 };
          })()
        : await pg.query(sql, normalized);

    const int8Cols = result.fields.filter((f) => f.dataTypeID === 20).map((f) => f.name);
    const rows = result.rows.map((raw) => {
      const copy = { ...(raw as Record<string, unknown>) };
      for (const col of int8Cols) {
        const val = copy[col];
        if (typeof val === "number" || typeof val === "bigint") {
          copy[col] = String(val);
        }
      }
      return copy;
    });
    return { rows, rowCount: result.affectedRows ?? rows.length };
  };

  const db: DedicatedConcurrencyPGliteDb = {
    query: runQuery,
    async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
      const prev = txLock;
      let release!: () => void;
      txLock = new Promise<void>((resolve) => {
        release = resolve;
      });
      await prev;
      await pg.exec("BEGIN");
      try {
        const out = await work({ query: runQuery });
        await pg.exec("COMMIT");
        return out;
      } catch (err) {
        await pg.exec("ROLLBACK");
        throw err;
      } finally {
        release();
      }
    },
    async close(): Promise<void> {
      await pg.close();
    },
  };

  await applyConcurrencyBaseSchema(db);
  return db;
}

function deterministicHex(seed: number, byteLen: number): `0x${string}` {
  const out: string[] = [];
  for (let i = 0; i < byteLen; i += 1) {
    out.push(((seed + i * 29) & 0xff).toString(16).padStart(2, "0"));
  }
  return `0x${out.join("")}`;
}

export async function tryAcquireTransactionalLease(
  tx: Queryable,
  leaseKey: string,
  holderId: string,
  now: Date,
  ttlMs: number,
  options: { readonly useAdvisoryLockKey?: number } = {},
): Promise<boolean> {
  if (options.useAdvisoryLockKey !== undefined) {
    const adv = await tx.query("SELECT pg_try_advisory_xact_lock($1) AS locked", [
      options.useAdvisoryLockKey,
    ]);
    if (adv.rows[0]?.locked !== true) {
      return false;
    }
  }

  const expiresAt = new Date(now.getTime() + ttlMs);
  const { rowCount } = await tx.query(
    `INSERT INTO worker_lease (lease_key, holder_id, acquired_at, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (lease_key) DO UPDATE
       SET holder_id = EXCLUDED.holder_id,
           acquired_at = EXCLUDED.acquired_at,
           expires_at = EXCLUDED.expires_at
     WHERE worker_lease.expires_at <= $3 OR worker_lease.holder_id = $2`,
    [leaseKey, holderId, now, expiresAt],
  );
  return rowCount > 0;
}

export async function advanceCursorMonotonically(
  tx: Queryable,
  args: {
    readonly chainKey: string;
    readonly family: "stellar" | "evm";
    readonly contract: string;
    readonly nextBlock: bigint;
    readonly blockHash: string | null;
    readonly processedAt: Date;
  },
): Promise<{ readonly advanced: boolean }> {
  const { rowCount } = await tx.query(
    `INSERT INTO indexer_cursor
       (chain_key, family, contract, last_processed, last_processed_hash, last_processed_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (chain_key) DO UPDATE
       SET last_processed = EXCLUDED.last_processed,
           last_processed_hash = EXCLUDED.last_processed_hash,
           last_processed_at = EXCLUDED.last_processed_at,
           updated_at = now()
     WHERE indexer_cursor.contract = EXCLUDED.contract
       AND indexer_cursor.last_processed < EXCLUDED.last_processed`,
    [
      args.chainKey,
      args.family,
      args.contract,
      args.nextBlock.toString(),
      args.blockHash,
      args.processedAt,
    ],
  );
  return { advanced: rowCount > 0 };
}

/**
 * Exercise competing watcher, rail, claim-settlement, and migration workers concurrently against
 * one dedicated database and report observed lease, cursor, and settlement conflicts.
 */
export async function runMultiWorkerConcurrencySuite(
  db: Transactional,
  options: { readonly multiSessionAdvisoryLocks?: boolean } = {},
): Promise<ConcurrencyRunnerReport> {
  const now = new Date("2026-10-16T14:00:00.000Z");
  const logger = pino({ level: "silent" });

  const stellarDest = encodeStellarAddress(AddressKind.Account, deterministicHex(0x11, 32));
  const evmSender = deterministicHex(0x21, 20);
  const evmToken = deterministicHex(0x31, 20);
  const evmRouter = deterministicHex(0x41, 20);
  const settler = deterministicHex(0x51, 20);

  let leaseConflicts = 0;
  let cursorConflicts = 0;
  let claimSettlementWinners = 0;
  let claimSettlementConflicts = 0;
  let migrationWinners = 0;
  let migrationLeaseSkips = 0;

  // Seed initial cursor at block 1000 and one unsettled parked claim #501.
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO indexer_cursor
         (chain_key, family, contract, last_processed, last_processed_hash, last_processed_at)
       VALUES ('sepolia', 'evm', $1, '1000', $2, $3)
       ON CONFLICT (chain_key) DO UPDATE SET last_processed = '1000'`,
      [evmRouter, deterministicHex(0x61, 32), now],
    );

    await writeClaim(
      tx,
      {
        chainKey: "sepolia",
        block: 1000n,
        txHash: deterministicHex(0x71, 32),
        logIndex: 0,
        observedAt: now,
      },
      {
        claimId: 501n,
        recipient: evmSender,
        token: evmToken,
        amount: 25_000_000n,
        route: 0,
        sourceChain: "stellar-testnet",
        sourceNonce: 88n,
        createdAt: now,
      },
    );
    await writeInbound(
      tx,
      {
        chainKey: "sepolia",
        block: 1000n,
        txHash: deterministicHex(0x71, 32),
        logIndex: 1,
        observedAt: now,
      },
      {
        route: 0,
        sourceChain: "stellar-testnet",
        sourceNonce: 88n,
        railMessageId: deterministicHex(0x72, 32),
        recipient: evmSender,
        token: evmToken,
        amount: 25_000_000n,
        delivered: false,
        claimId: 501n,
      },
    );
  });

  // 1) Competing migration workers: 3 workers race to acquire migration lease and apply an online index/column step.
  const migrationWork = [1, 2, 3].map(async (workerIdx) => {
    await db.transaction(async (tx) => {
      const acquired = await tryAcquireTransactionalLease(
        tx,
        "schema:migrations",
        `migrator-${String(workerIdx)}`,
        now,
        30_000,
        options.multiSessionAdvisoryLocks ? { useAdvisoryLockKey: 138_001 } : {},
      );
      if (!acquired) {
        leaseConflicts += 1;
        migrationLeaseSkips += 1;
        return;
      }
      const existing = await tx.query(
        "SELECT 1 FROM pgmigrations WHERE name = '1799800000000_concurrency-runner-step'",
      );
      if (existing.rows.length > 0) {
        migrationLeaseSkips += 1;
        return;
      }
      await tx.query(
        "CREATE INDEX IF NOT EXISTS outbound_transfer_concurrency_probe ON outbound_transfer (route, origin_block DESC)",
      );
      await tx.query("INSERT INTO pgmigrations (name) VALUES ($1)", [
        "1799800000000_concurrency-runner-step",
      ]);
      migrationWinners += 1;
    });
  });

  // 2) Competing watcher workers:
  //    - 4 watcher workers race on the 'watcher:sepolia' lease AND compete to write overlapping pages
  //      (blocks 1010, 1020, 1015, 1020) so stale/duplicate cursor updates hit monotonic CAS conflicts!
  const watcherTargets = [
    { worker: "watcher-a", block: 1020n, nonce: 1n, acquireLease: true },
    { worker: "watcher-b", block: 1015n, nonce: 1n, acquireLease: true },
    { worker: "watcher-c", block: 1020n, nonce: 2n, acquireLease: false },
    { worker: "watcher-d", block: 1025n, nonce: 3n, acquireLease: false },
  ] as const;

  const watcherWork = watcherTargets.map(async (item, idx) => {
    await db.transaction(async (tx) => {
      if (item.acquireLease) {
        const leased = await tryAcquireTransactionalLease(
          tx,
          "watcher:sepolia",
          item.worker,
          now,
          15_000,
          options.multiSessionAdvisoryLocks ? { useAdvisoryLockKey: 138_002 } : {},
        );
        if (!leased) {
          leaseConflicts += 1;
        }
      }

      await writeOutbound(
        tx,
        {
          chainKey: "sepolia",
          block: item.block,
          txHash: deterministicHex(0x80 + idx, 32),
          logIndex: 0,
          observedAt: new Date(now.getTime() + idx * 1_000),
        },
        {
          route: 1,
          nonce: item.nonce,
          sender: evmSender,
          token: evmToken,
          grossAmount: 10_010_000n,
          fee: 10_000n,
          netAmount: 10_000_000n,
          destinationChain: "stellar-testnet",
          destination: stellarDest,
          railRef: deterministicHex(0x90 + idx, 32),
        },
      );

      const cursorRes = await advanceCursorMonotonically(tx, {
        chainKey: "sepolia",
        family: "evm",
        contract: evmRouter,
        nextBlock: item.block,
        blockHash: deterministicHex(0xa0 + idx, 32),
        processedAt: new Date(now.getTime() + Number(item.block - 1000n) * 1_000),
      });
      if (!cursorRes.advanced) {
        cursorConflicts += 1;
      }
    });
  });

  // 3) Competing keeper claim-settlement workers racing on claim #501:
  const claimWork = [1, 2, 3, 4].map(async (workerIdx) => {
    await db.transaction(async (tx) => {
      const won = await settleClaim(
        tx,
        {
          chainKey: "sepolia",
          block: 1030n,
          txHash: deterministicHex(0xb0 + workerIdx, 32),
          logIndex: workerIdx,
          observedAt: new Date(now.getTime() + 30_000),
        },
        501n,
        settler,
      );
      if (won) {
        claimSettlementWinners += 1;
      } else {
        claimSettlementConflicts += 1;
      }
    });
  });

  await Promise.all([...migrationWork, ...watcherWork, ...claimWork]);

  // 4) Competing RailPass workers polling route 1 concurrently against the newly ingested transfers!
  const mockRailClient: RailClient = {
    rail: "axelar-its",
    look(transfer: PendingTransfer) {
      return Promise.resolve({
        kind: "found",
        report: {
          status: "attested",
          railStatus: "executed",
          reference: `axelar-conc-${transfer.nonce.toString()}`,
          attestedAt: new Date(now.getTime() + 10_000),
        },
      });
    },
  };

  const railWorkers = [1, 2, 3].map(
    () =>
      new RailPass({
        route: 1,
        client: mockRailClient,
        db,
        logger,
        batchSize: 10,
        recheckAfterMs: 60_000,
        maxCheckFailures: 5,
        now: () => new Date(now.getTime() + 45_000),
      }),
  );

  await Promise.all(railWorkers.map((w) => w.tick(AbortSignal.timeout(5_000))));

  const cursorRow = await db.query(
    "SELECT last_processed::text AS block FROM indexer_cursor WHERE chain_key = 'sepolia'",
  );
  const outboundRows = await db.query("SELECT count(*)::int AS n FROM outbound_transfer");
  const attRows = await db.query("SELECT count(*)::int AS n FROM rail_attestation");
  const fakeDeliveredRows = await db.query(
    `SELECT count(*)::int AS n
       FROM rail_attestation a
       JOIN outbound_transfer t ON t.id = a.transfer_id
       LEFT JOIN inbound_delivery d
         ON d.destination_chain = t.destination_chain
        AND d.route = t.route
        AND d.source_chain = t.origin_chain
        AND d.source_nonce = t.nonce
      WHERE a.status = 'delivered' AND d.id IS NULL`,
  );
  const settledRows = await db.query(
    "SELECT count(*)::int AS n FROM pending_claim WHERE chain = 'sepolia' AND claim_id = 501 AND settled = true",
  );

  return {
    leaseConflicts,
    cursorConflicts,
    claimSettlementWinners,
    claimSettlementConflicts,
    migrationWinners,
    migrationLeaseSkips,
    finalCursorBlock: (cursorRow.rows[0]?.block as string | undefined) ?? "0",
    outboundCount: (outboundRows.rows[0]?.n as number | undefined) ?? 0,
    railAttestationCount: (attRows.rows[0]?.n as number | undefined) ?? 0,
    fakeDeliveredCount: (fakeDeliveredRows.rows[0]?.n as number | undefined) ?? 0,
    settledClaimCount: (settledRows.rows[0]?.n as number | undefined) ?? 0,
  };
}

/**
 * Exercise deadlock (40P01) and lock-timeout (55P03) transactional rollback and retry recovery,
 * proving dirty partial writes inside aborted transactions never leak and retried state is valid.
 */
export async function verifyDeadlockAndLockTimeoutRecovery(db: Transactional): Promise<{
  readonly deadlocksRecovered: number;
  readonly lockTimeoutsRecovered: number;
  readonly finalTransferGross: string;
  readonly finalTransferNet: string;
  readonly leakedDirtyRows: number;
}> {
  const stellarDest = encodeStellarAddress(AddressKind.Account, deterministicHex(0xc1, 32));
  const evmSender = deterministicHex(0xc2, 20);
  const evmToken = deterministicHex(0xc3, 20);

  // Worker 1 experiences a 40P01 deadlock on attempt 1 AFTER writing a dirty transfer, then succeeds on attempt 2.
  const deadlockRun = await runWithConcurrencyRetry(
    async (attempt) =>
      db.transaction(async (tx) => {
        if (attempt === 1) {
          await writeOutbound(
            tx,
            {
              chainKey: "sepolia",
              block: 2001n,
              txHash: deterministicHex(0xd1, 32),
              logIndex: 0,
              observedAt: new Date("2026-10-16T15:00:00.000Z"),
            },
            {
              route: 0,
              nonce: 9999n,
              sender: evmSender,
              token: evmToken,
              grossAmount: 999n,
              fee: 9n,
              netAmount: 990n,
              destinationChain: "stellar-testnet",
              destination: stellarDest,
              railRef: null,
            },
          );
          throw createPgStateError(
            PG_DEADLOCK_DETECTED,
            "deadlock detected between competing workers",
          );
        }

        await writeOutbound(
          tx,
          {
            chainKey: "sepolia",
            block: 2002n,
            txHash: deterministicHex(0xd2, 32),
            logIndex: 0,
            observedAt: new Date("2026-10-16T15:00:05.000Z"),
          },
          {
            route: 0,
            nonce: 701n,
            sender: evmSender,
            token: evmToken,
            grossAmount: 50_050_000n,
            fee: 50_000n,
            netAmount: 50_000_000n,
            destinationChain: "stellar-testnet",
            destination: stellarDest,
            railRef: null,
          },
        );
        return "committed-after-deadlock";
      }),
    { baseDelayMs: 1 },
  );

  // Worker 2 experiences two 55P03 lock-timeout errors after partial writes, then commits on attempt 3.
  const lockTimeoutRun = await runWithConcurrencyRetry(
    async (attempt) =>
      db.transaction(async (tx) => {
        if (attempt <= 2) {
          await writeOutbound(
            tx,
            {
              chainKey: "sepolia",
              block: 2003n,
              txHash: deterministicHex(0xd3 + attempt, 32),
              logIndex: 0,
              observedAt: new Date("2026-10-16T15:01:00.000Z"),
            },
            {
              route: 0,
              nonce: BigInt(8880 + attempt),
              sender: evmSender,
              token: evmToken,
              grossAmount: 888n,
              fee: 8n,
              netAmount: 880n,
              destinationChain: "stellar-testnet",
              destination: stellarDest,
              railRef: null,
            },
          );
          throw createPgStateError(
            PG_LOCK_NOT_AVAILABLE,
            "canceling statement due to lock timeout",
          );
        }

        await writeOutbound(
          tx,
          {
            chainKey: "sepolia",
            block: 2005n,
            txHash: deterministicHex(0xd8, 32),
            logIndex: 0,
            observedAt: new Date("2026-10-16T15:01:10.000Z"),
          },
          {
            route: 0,
            nonce: 702n,
            sender: evmSender,
            token: evmToken,
            grossAmount: 75_075_000n,
            fee: 75_000n,
            netAmount: 75_000_000n,
            destinationChain: "stellar-testnet",
            destination: stellarDest,
            railRef: null,
          },
        );
        return "committed-after-lock-timeout";
      }),
    { baseDelayMs: 1 },
  );

  const dirtyRows = await db.query(
    "SELECT count(*)::int AS n FROM outbound_transfer WHERE origin_chain = 'sepolia' AND nonce IN (9999, 8881, 8882)",
  );
  const committedRows = await db.query(
    `SELECT gross_amount::text AS gross, net_amount::text AS net
       FROM outbound_transfer
      WHERE origin_chain = 'sepolia' AND nonce = 702`,
  );

  return {
    deadlocksRecovered: deadlockRun.telemetry.deadlocksRecovered,
    lockTimeoutsRecovered: lockTimeoutRun.telemetry.lockTimeoutsRecovered,
    finalTransferGross: (committedRows.rows[0]?.gross as string | undefined) ?? "0",
    finalTransferNet: (committedRows.rows[0]?.net as string | undefined) ?? "0",
    leakedDirtyRows: (dirtyRows.rows[0]?.n as number | undefined) ?? 0,
  };
}

export async function openDedicatedConcurrencyDatabase(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<{
  readonly db: Database;
  readonly config: DedicatedConcurrencyDbConfig;
}> {
  const config = resolveDedicatedConcurrencyDbConfig(env);
  const bootstrap = Database.open(config.connectionString, {
    maxConnections: 1,
    applicationName: "hyperion-concurrency-bootstrap",
  });
  try {
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${config.schemaName} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${config.schemaName}`);
  } finally {
    await bootstrap.close();
  }

  const scopedUrl = new URL(config.connectionString);
  const existingOptions = scopedUrl.searchParams.get("options");
  const searchPathFlag = `-c search_path=${config.schemaName},public`;
  scopedUrl.searchParams.set(
    "options",
    existingOptions !== null && existingOptions !== ""
      ? `${existingOptions} ${searchPathFlag}`
      : searchPathFlag,
  );

  const db = Database.open(scopedUrl.toString(), {
    maxConnections: 12,
    applicationName: "hyperion-concurrency-runner",
  });
  await db.ping();
  await applyConcurrencyBaseSchema(db);
  return { db, config };
}
