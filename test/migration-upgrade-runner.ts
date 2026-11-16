import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { AddressKind, encodeStellarAddress } from "@hyperion/protocol";

import type { Queryable, QueryResultRows, Transactional } from "../src/db/pool.js";

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";

export const MIGRATION_U64_MAX = "18446744073709551615";
export const MIGRATION_U256_MAX =
  "115792089237316195423570985008687907853269984665640564039457584007913129639935";

export interface MigrationStepDefinition {
  readonly name: string;
  readonly upSql: string;
  readonly downSql: string;
}

export interface HistoricalSnapshotDescriptor {
  readonly snapshotId: string;
  readonly throughMigration: string;
  readonly description: string;
  readonly hasCursorBlockHash: boolean;
  readonly hasCursorAutovacuumOptions: boolean;
}

export interface TransferIdentitySnapshot {
  readonly id: string;
  readonly originChain: string;
  readonly route: number;
  readonly nonce: string;
  readonly sender: string;
  readonly token: string;
  readonly grossAmount: string;
  readonly fee: string;
  readonly netAmount: string;
  readonly destinationChain: string;
  readonly destination: string;
  readonly originBlock: string;
  readonly originTx: string;
}

export interface ClaimIdentitySnapshot {
  readonly chain: string;
  readonly claimId: string;
  readonly recipient: string;
  readonly token: string;
  readonly amount: string;
  readonly route: number;
  readonly sourceChain: string;
  readonly sourceNonce: string;
  readonly settled: boolean;
  readonly settledBy: string | null;
  readonly settledTx: string | null;
}

export interface ConstraintAndJoinVerification {
  readonly checkConstraintsVerified: boolean;
  readonly uniqueAndPartialIndexesVerified: boolean;
  readonly cascadeDeleteVerified: boolean;
  readonly lifecycleJoinRowsMatched: number;
  readonly cursorHasBlockHashColumn: boolean;
  readonly cursorAutovacuumOptions: readonly string[];
}

export interface UpgradePathRunResult {
  readonly snapshotId: string;
  readonly startingMigration: string;
  readonly appliedUpgradeSteps: readonly string[];
  readonly committedMigrationsAfter: readonly string[];
  readonly transfersBefore: readonly TransferIdentitySnapshot[];
  readonly transfersAfter: readonly TransferIdentitySnapshot[];
  readonly claimsBefore: readonly ClaimIdentitySnapshot[];
  readonly claimsAfter: readonly ClaimIdentitySnapshot[];
  readonly identitiesUnchanged: boolean;
  readonly verification: ConstraintAndJoinVerification;
}

export interface MigrationFailureBoundaryReport {
  readonly failedMigration: string;
  readonly errorMessage: string;
  readonly lastCommittedMigration: string | null;
  readonly committedMigrations: readonly string[];
  readonly pendingMigrations: readonly string[];
  readonly recoveryBoundaryDocumented: string;
  readonly preUpgradeTransfersIntact: boolean;
  readonly preUpgradeClaimsIntact: boolean;
}

export interface DedicatedMigrationDb extends Transactional {
  close(): Promise<void>;
}

function deterministicHex(seed: number, byteLen: number): `0x${string}` {
  const out: string[] = [];
  for (let i = 0; i < byteLen; i += 1) {
    out.push(((seed + i * 23) & 0xff).toString(16).padStart(2, "0"));
  }
  return `0x${out.join("")}`;
}

function pgErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const raw = (error as { code?: unknown }).code;
    return typeof raw === "string" ? raw : undefined;
  }
  return undefined;
}

export function loadRepositoryMigrations(): readonly MigrationStepDefinition[] {
  const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));

  return files.map((file) => {
    const raw = readFileSync(
      fileURLToPath(new URL(`../migrations/${file}`, import.meta.url)),
      "utf8",
    );
    const parts = raw.split(/^--\s*Down Migration\b/m);
    return {
      name: file.replace(/\.sql$/, ""),
      upSql: parts[0] ?? "",
      downSql: parts[1] ?? "",
    };
  });
}

export function loadHistoricalSnapshotFixtures(): readonly HistoricalSnapshotDescriptor[] {
  const fullPath = fileURLToPath(new URL("./fixtures/migration-snapshots.json", import.meta.url));
  const parsed = JSON.parse(readFileSync(fullPath, "utf8")) as {
    schemaSnapshots: readonly HistoricalSnapshotDescriptor[];
  };
  return parsed.schemaSnapshots;
}

export async function createDedicatedMigrationPGliteDb(): Promise<DedicatedMigrationDb> {
  const pg = await PGlite.create();

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

  return {
    query: runQuery,
    async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
      await pg.exec("BEGIN");
      try {
        const res = await work({ query: runQuery });
        await pg.exec("COMMIT");
        return res;
      } catch (err) {
        await pg.exec("ROLLBACK");
        throw err;
      }
    },
    async close(): Promise<void> {
      await pg.close();
    },
  };
}

export async function ensurePgMigrationsLedger(db: Queryable): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS pgmigrations (
      id serial PRIMARY KEY,
      name varchar(255) NOT NULL UNIQUE,
      run_on timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export async function listCommittedMigrations(db: Queryable): Promise<readonly string[]> {
  await ensurePgMigrationsLedger(db);
  const { rows } = await db.query("SELECT name FROM pgmigrations ORDER BY id ASC");
  return rows.map((r) => (typeof r.name === "string" ? r.name : ""));
}

export async function applyPendingMigrationSteps(
  db: Transactional,
  steps: readonly MigrationStepDefinition[],
): Promise<readonly string[]> {
  await ensurePgMigrationsLedger(db);
  const alreadyCommitted = new Set(await listCommittedMigrations(db));
  const newlyApplied: string[] = [];

  for (const step of steps) {
    if (alreadyCommitted.has(step.name)) continue;
    await db.transaction(async (tx) => {
      await tx.query(step.upSql);
      await tx.query("INSERT INTO pgmigrations (name) VALUES ($1)", [step.name]);
    });
    newlyApplied.push(step.name);
  }

  return newlyApplied;
}

export async function seedRepresentativeMonetaryRecords(
  db: Transactional,
  options: { readonly hasCursorBlockHash: boolean },
): Promise<void> {
  const stellarSender = encodeStellarAddress(AddressKind.Account, deterministicHex(0x11, 32));
  const stellarRecipient = encodeStellarAddress(AddressKind.Account, deterministicHex(0x22, 32));
  const stellarSettler = encodeStellarAddress(AddressKind.Account, deterministicHex(0x33, 32));
  const stellarToken = encodeStellarAddress(AddressKind.Contract, deterministicHex(0x44, 32));
  const stellarRouter = encodeStellarAddress(AddressKind.Contract, deterministicHex(0x55, 32));

  const evmSender = deterministicHex(0x61, 20);
  const evmRecipient = deterministicHex(0x71, 20);
  const evmRecipientWord = `0x${"0".repeat(24)}${evmRecipient.slice(2)}`;
  const evmToken = deterministicHex(0x81, 20);
  const evmRouter = deterministicHex(0x91, 20);

  const fee1 = 1_000_000n;
  const gross1 = BigInt(MIGRATION_U256_MAX);
  const net1 = gross1 - fee1;

  const u64AboveInt64 = "9223372036854775808";
  const parkedClaimId = "18446744073709551614";

  await db.transaction(async (tx) => {
    // 1) Stellar -> Sepolia CCTP transfer at U64_MAX nonce and U256_MAX gross_amount (delivered)
    await tx.query(
      `INSERT INTO outbound_transfer
         (origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
          destination_chain, destination, rail_ref, origin_block, origin_tx, origin_log_index, observed_at)
       VALUES
         ('stellar-testnet', 0, $1, $2, $3, $4, $5, $6, 'sepolia', $7, NULL,
          5000100, 'stellar-upgrade-tx-1', NULL, '2026-10-16T08:00:00.000Z'),
         ('sepolia', 1, $8, $9, $10, '500000000000000000000000000', '500000000000000000000000',
          '499500000000000000000000000', 'stellar-testnet', $11, $12,
          9400100, 'evm-upgrade-tx-2', 0, '2026-10-16T08:05:00.000Z'),
         ('sepolia', 3, '77', $9, $10, '25000000', '25000', '24975000',
          'stellar-testnet', $11, $13,
          9400200, 'evm-upgrade-tx-3', 1, '2026-10-16T08:10:00.000Z')`,
      [
        MIGRATION_U64_MAX,
        stellarSender,
        stellarToken,
        gross1.toString(),
        fee1.toString(),
        net1.toString(),
        evmRecipientWord,
        u64AboveInt64,
        evmSender,
        evmToken,
        stellarRecipient,
        deterministicHex(0xa1, 32),
        deterministicHex(0xa2, 32),
      ],
    );

    // Pair inbound deliveries: #1 delivered on EVM (with message id), #2 parked on Stellar (null message id), #3 parked & settled on Stellar.
    await tx.query(
      `INSERT INTO inbound_delivery
         (destination_chain, route, source_chain, source_nonce, rail_message_id, recipient, token,
          amount, delivered, claim_id, destination_block, destination_tx, destination_log_index, observed_at)
       VALUES
         ('sepolia', 0, 'stellar-testnet', $1, $2, $3, $4, $5, true, NULL,
          9400150, 'evm-inbound-tx-1', 0, '2026-10-16T08:02:00.000Z'),
         ('stellar-testnet', 1, 'sepolia', $6, NULL, $7, $8, '499500000000000000000000000',
          false, $9, 5000200, 'stellar-inbound-tx-2', NULL, '2026-10-16T08:06:00.000Z'),
         ('stellar-testnet', 3, 'sepolia', '77', NULL, $7, $8, '24975000',
          false, '404', 5000250, 'stellar-inbound-tx-3', NULL, '2026-10-16T08:11:00.000Z')`,
      [
        MIGRATION_U64_MAX,
        deterministicHex(0xb1, 32),
        evmRecipient,
        evmToken,
        net1.toString(),
        u64AboveInt64,
        stellarRecipient,
        stellarToken,
        parkedClaimId,
      ],
    );

    // Pending claims: one unsettled at near-U64_MAX claim_id, one settled.
    await tx.query(
      `INSERT INTO pending_claim
         (chain, claim_id, recipient, token, amount, route, source_chain, source_nonce,
          created_at, settled, settled_at, settled_by, settled_tx, observed_at)
       VALUES
         ('stellar-testnet', $1, $2, $3, '499500000000000000000000000', 1, 'sepolia', $4,
          '2026-10-16T08:06:00.000Z', false, NULL, NULL, NULL, '2026-10-16T08:06:00.000Z'),
         ('stellar-testnet', '404', $2, $3, '24975000', 3, 'sepolia', '77',
          '2026-10-16T08:11:00.000Z', true, '2026-10-16T08:15:00.000Z', $5, 'stellar-settle-tx-3', '2026-10-16T08:11:00.000Z')`,
      [parkedClaimId, stellarRecipient, stellarToken, u64AboveInt64, stellarSettler],
    );

    // Rail attestations: delivered only where inbound_delivery exists; attested on #2; pending on #3.
    await tx.query(
      `INSERT INTO rail_attestation
         (transfer_id, route, status, rail_status, rail_reference, attested_at, last_checked_at, check_failures)
       VALUES
         (1, 0, 'delivered', 'complete', 'cctp-ref-1', '2026-10-16T08:01:00.000Z', '2026-10-16T08:02:00.000Z', 0),
         (2, 1, 'attested', 'executed', 'axelar-ref-2', '2026-10-16T08:05:30.000Z', '2026-10-16T08:05:45.000Z', 0),
         (3, 3, 'delivered', 'completed', 'allbridge-ref-3', '2026-10-16T08:10:30.000Z', '2026-10-16T08:11:00.000Z', 0)`,
    );

    // Cursors using schema columns available at the historical snapshot!
    if (options.hasCursorBlockHash) {
      await tx.query(
        `INSERT INTO indexer_cursor
           (chain_key, family, contract, last_processed, last_processed_hash, last_processed_at)
         VALUES
           ('stellar-testnet', 'stellar', $1, '5000250', NULL, '2026-10-16T08:11:00.000Z'),
           ('sepolia', 'evm', $2, '9400200', $3, '2026-10-16T08:10:00.000Z')`,
        [stellarRouter, evmRouter, deterministicHex(0xc1, 32)],
      );
    } else {
      await tx.query(
        `INSERT INTO indexer_cursor
           (chain_key, family, contract, last_processed, last_processed_at)
         VALUES
           ('stellar-testnet', 'stellar', $1, '5000250', '2026-10-16T08:11:00.000Z'),
           ('sepolia', 'evm', $2, '9400200', '2026-10-16T08:10:00.000Z')`,
        [stellarRouter, evmRouter],
      );
    }

    await tx.query(
      `INSERT INTO admin_action
         (chain, action_id, kind, state, payload, eta, expires_at, queued_at, observed_at)
       VALUES
         ('stellar-testnet', '1', 0, 'queued', '{"kind":"Pause"}',
          '2026-10-16T12:00:00.000Z', '2026-10-17T12:00:00.000Z',
          '2026-10-16T08:00:00.000Z', '2026-10-16T08:00:00.000Z')`,
    );

    await tx.query(
      `INSERT INTO route_health
         (sampled_at, origin_chain, destination_chain, route, token, available, blocker, flow_available)
       VALUES
         ('2026-10-16T08:12:00.000Z', 'stellar-testnet', 'sepolia', 0, $1, true, 0, $2)`,
      [stellarToken, MIGRATION_U256_MAX],
    );
  });
}

export async function snapshotTransferIdentities(
  db: Queryable,
): Promise<readonly TransferIdentitySnapshot[]> {
  const { rows } = await db.query(
    `SELECT id::text AS id,
            origin_chain,
            route,
            nonce::text AS nonce,
            sender,
            token,
            gross_amount::text AS gross_amount,
            fee::text AS fee,
            net_amount::text AS net_amount,
            destination_chain,
            destination,
            origin_block::text AS origin_block,
            origin_tx
       FROM outbound_transfer
      ORDER BY id ASC`,
  );

  return rows.map((r) => ({
    id: r.id as string,
    originChain: r.origin_chain as string,
    route: Number(r.route),
    nonce: r.nonce as string,
    sender: r.sender as string,
    token: r.token as string,
    grossAmount: r.gross_amount as string,
    fee: r.fee as string,
    netAmount: r.net_amount as string,
    destinationChain: r.destination_chain as string,
    destination: r.destination as string,
    originBlock: r.origin_block as string,
    originTx: r.origin_tx as string,
  }));
}

export async function snapshotClaimIdentities(
  db: Queryable,
): Promise<readonly ClaimIdentitySnapshot[]> {
  const { rows } = await db.query(
    `SELECT chain,
            claim_id::text AS claim_id,
            recipient,
            token,
            amount::text AS amount,
            route,
            source_chain,
            source_nonce::text AS source_nonce,
            settled,
            settled_by,
            settled_tx
       FROM pending_claim
      ORDER BY chain ASC, claim_id ASC`,
  );

  return rows.map((r) => ({
    chain: r.chain as string,
    claimId: r.claim_id as string,
    recipient: r.recipient as string,
    token: r.token as string,
    amount: r.amount as string,
    route: Number(r.route),
    sourceChain: r.source_chain as string,
    sourceNonce: r.source_nonce as string,
    settled: r.settled === true,
    settledBy: typeof r.settled_by === "string" ? r.settled_by : null,
    settledTx: typeof r.settled_tx === "string" ? r.settled_tx : null,
  }));
}

async function expectSavepointErrorCode(
  tx: Queryable,
  savepoint: string,
  sql: string,
  params: readonly unknown[],
  expectedCode: string,
): Promise<boolean> {
  await tx.query(`SAVEPOINT ${savepoint}`);
  try {
    await tx.query(sql, params);
    await tx.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    return false;
  } catch (err) {
    const matched = pgErrorCode(err) === expectedCode;
    await tx.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    return matched;
  } finally {
    await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
  }
}

export async function verifyPostUpgradeConstraintsAndJoins(
  db: Transactional,
): Promise<ConstraintAndJoinVerification> {
  return db.transaction(async (tx) => {
    // 1) CHECK constraints
    const badSplit = await expectSavepointErrorCode(
      tx,
      "sp_bad_split",
      `INSERT INTO outbound_transfer
         (origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
          destination_chain, destination, origin_block, origin_tx)
       VALUES ('probe-chain', 0, 1, '0x11', '0x22', 1000, 10, 900, 'sepolia', '0x33', 1, 'probe-tx')`,
      [],
      CHECK_VIOLATION,
    );

    const badInboundClaim = await expectSavepointErrorCode(
      tx,
      "sp_bad_inbound",
      `INSERT INTO inbound_delivery
         (destination_chain, route, source_chain, source_nonce, recipient, token, amount,
          delivered, claim_id, destination_block, destination_tx)
       VALUES ('probe-chain', 0, 'sepolia', 1, '0x11', '0x22', 100, true, 99, 1, 'probe-tx')`,
      [],
      CHECK_VIOLATION,
    );

    const badClaimSettle = await expectSavepointErrorCode(
      tx,
      "sp_bad_settle",
      `INSERT INTO pending_claim
         (chain, claim_id, recipient, token, amount, route, source_chain, source_nonce,
          created_at, settled, settled_at, settled_by)
       VALUES ('probe-chain', 1, '0x11', '0x22', 100, 0, 'sepolia', 1, now(), true, now(), NULL)`,
      [],
      CHECK_VIOLATION,
    );

    const badCursorFamily = await expectSavepointErrorCode(
      tx,
      "sp_bad_family",
      `INSERT INTO indexer_cursor (chain_key, family, contract, last_processed)
       VALUES ('probe-chain', 'solana', 'x', 1)`,
      [],
      CHECK_VIOLATION,
    );

    // 2) UNIQUE & partial-index behavior
    const dupNonce = await expectSavepointErrorCode(
      tx,
      "sp_dup_nonce",
      `INSERT INTO outbound_transfer
         (origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
          destination_chain, destination, origin_block, origin_tx)
       VALUES ('sepolia', 3, '77', '0x11', '0x22', 100, 0, 100, 'stellar-testnet', 'GABC', 1, 'dup-tx')`,
      [],
      UNIQUE_VIOLATION,
    );

    // Partial unique index inbound_delivery_by_message rejects duplicate non-null rail_message_id...
    await tx.query("SAVEPOINT sp_partial_unique");
    let partialUniqueOk = false;
    try {
      await tx.query(
        `INSERT INTO inbound_delivery
           (destination_chain, route, source_chain, source_nonce, rail_message_id,
            recipient, token, amount, delivered, claim_id, destination_block, destination_tx)
         VALUES
           ('probe-evm', 0, 'stellar-testnet', 901, 'shared-msg-id', '0x11', '0x22', 100, true, NULL, 1, 'tx-a')`,
      );
      const rejectedDupMsg = await expectSavepointErrorCode(
        tx,
        "sp_dup_msg_inner",
        `INSERT INTO inbound_delivery
           (destination_chain, route, source_chain, source_nonce, rail_message_id,
            recipient, token, amount, delivered, claim_id, destination_block, destination_tx)
         VALUES
           ('probe-evm', 0, 'stellar-testnet', 902, 'shared-msg-id', '0x11', '0x22', 100, true, NULL, 2, 'tx-b')`,
        [],
        UNIQUE_VIOLATION,
      );
      // ...while allowing multiple NULL rail_message_id rows on Stellar!
      await tx.query(
        `INSERT INTO inbound_delivery
           (destination_chain, route, source_chain, source_nonce, rail_message_id,
            recipient, token, amount, delivered, claim_id, destination_block, destination_tx)
         VALUES
           ('probe-stellar', 1, 'sepolia', 903, NULL, 'G1', 'C1', 100, true, NULL, 1, 'tx-c'),
           ('probe-stellar', 1, 'sepolia', 904, NULL, 'G1', 'C1', 100, true, NULL, 2, 'tx-d')`,
      );
      partialUniqueOk = rejectedDupMsg;
    } finally {
      await tx.query("ROLLBACK TO SAVEPOINT sp_partial_unique");
      await tx.query("RELEASE SAVEPOINT sp_partial_unique");
    }

    // 3) ON DELETE CASCADE between outbound_transfer and rail_attestation
    await tx.query("SAVEPOINT sp_fk_cascade");
    let cascadeDeleteVerified = false;
    try {
      const ins = await tx.query(
        `INSERT INTO outbound_transfer
           (origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
            destination_chain, destination, origin_block, origin_tx)
         VALUES ('probe-cascade', 0, 1, '0x11', '0x22', 100, 0, 100, 'sepolia', '0x33', 1, 'tx-casc')
         RETURNING id::text AS id`,
      );
      const probeId = ins.rows[0]?.id as string;
      await tx.query(
        `INSERT INTO rail_attestation (transfer_id, route, status) VALUES ($1, 0, 'pending')`,
        [probeId],
      );
      await tx.query("DELETE FROM outbound_transfer WHERE id = $1", [probeId]);
      const rem = await tx.query(
        "SELECT count(*)::int AS n FROM rail_attestation WHERE transfer_id = $1",
        [probeId],
      );
      cascadeDeleteVerified = rem.rows[0]?.n === 0;
    } finally {
      await tx.query("ROLLBACK TO SAVEPOINT sp_fk_cascade");
      await tx.query("RELEASE SAVEPOINT sp_fk_cascade");
    }

    // 4) Full 4-table cross-chain lifecycle join check
    const joined = await tx.query(
      `SELECT t.id::text AS id,
              t.nonce::text AS nonce,
              t.gross_amount::text AS gross_amount,
              a.status AS attestation_status,
              d.delivered AS inbound_delivered,
              c.claim_id::text AS claim_id,
              c.settled AS claim_settled
         FROM outbound_transfer t
         LEFT JOIN rail_attestation a ON a.transfer_id = t.id
         LEFT JOIN inbound_delivery d
           ON d.destination_chain = t.destination_chain
          AND d.route = t.route
          AND d.source_chain = t.origin_chain
          AND d.source_nonce = t.nonce
         LEFT JOIN pending_claim c
           ON c.chain = t.destination_chain
          AND c.route = t.route
          AND c.source_chain = t.origin_chain
          AND c.source_nonce = t.nonce
        ORDER BY t.id ASC`,
    );

    // 5) Cursor column & autovacuum reloptions check
    const colCheck = await tx.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_name = 'indexer_cursor' AND column_name = 'last_processed_hash'`,
    );
    const relOpts = await tx.query(
      `SELECT c.reloptions
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'indexer_cursor'
          AND n.nspname = current_schema()`,
    );
    const rawOpts = relOpts.rows[0]?.reloptions;
    const cursorAutovacuumOptions = Array.isArray(rawOpts)
      ? rawOpts.filter((x): x is string => typeof x === "string")
      : typeof rawOpts === "string"
        ? rawOpts
            .replace(/^\{|\}$/g, "")
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : [];

    return {
      checkConstraintsVerified: badSplit && badInboundClaim && badClaimSettle && badCursorFamily,
      uniqueAndPartialIndexesVerified: dupNonce && partialUniqueOk,
      cascadeDeleteVerified,
      lifecycleJoinRowsMatched: joined.rows.filter((r) => r.attestation_status !== null).length,
      cursorHasBlockHashColumn: colCheck.rows.length === 1,
      cursorAutovacuumOptions,
    };
  });
}

export async function runUpgradePathFromSnapshot(
  db: Transactional,
  snapshot: HistoricalSnapshotDescriptor,
  allMigrations: readonly MigrationStepDefinition[] = loadRepositoryMigrations(),
): Promise<UpgradePathRunResult> {
  const stopIdx = allMigrations.findIndex((m) => m.name === snapshot.throughMigration);
  if (stopIdx < 0) {
    throw new Error(`Unknown historical snapshot migration '${snapshot.throughMigration}'`);
  }

  // Step 1: Bring fresh database up to the historical schema snapshot.
  const initialSlice = allMigrations.slice(0, stopIdx + 1);
  await applyPendingMigrationSteps(db, initialSlice);

  // Step 2: Seed representative monetary transfers, claims, attestations, and cursors at that snapshot.
  await seedRepresentativeMonetaryRecords(db, {
    hasCursorBlockHash: snapshot.hasCursorBlockHash,
  });

  const transfersBefore = await snapshotTransferIdentities(db);
  const claimsBefore = await snapshotClaimIdentities(db);

  // Step 3: Run all remaining repository migrations through head.
  const appliedUpgradeSteps = await applyPendingMigrationSteps(db, allMigrations);
  const committedMigrationsAfter = await listCommittedMigrations(db);

  const transfersAfter = await snapshotTransferIdentities(db);
  const claimsAfter = await snapshotClaimIdentities(db);

  const identitiesUnchanged =
    JSON.stringify(transfersBefore) === JSON.stringify(transfersAfter) &&
    JSON.stringify(claimsBefore) === JSON.stringify(claimsAfter);

  const verification = await verifyPostUpgradeConstraintsAndJoins(db);

  return {
    snapshotId: snapshot.snapshotId,
    startingMigration: snapshot.throughMigration,
    appliedUpgradeSteps,
    committedMigrationsAfter,
    transfersBefore,
    transfersAfter,
    claimsBefore,
    claimsAfter,
    identitiesUnchanged,
    verification,
  };
}

export async function verifyMigrationFailureBoundary(
  db: Transactional,
  startingSnapshot: HistoricalSnapshotDescriptor,
  failingStep: MigrationStepDefinition,
  allMigrations: readonly MigrationStepDefinition[] = loadRepositoryMigrations(),
): Promise<MigrationFailureBoundaryReport> {
  const stopIdx = allMigrations.findIndex((m) => m.name === startingSnapshot.throughMigration);
  if (stopIdx < 0) {
    throw new Error(`Unknown historical snapshot migration '${startingSnapshot.throughMigration}'`);
  }

  await applyPendingMigrationSteps(db, allMigrations.slice(0, stopIdx + 1));
  await seedRepresentativeMonetaryRecords(db, {
    hasCursorBlockHash: startingSnapshot.hasCursorBlockHash,
  });

  const transfersBefore = await snapshotTransferIdentities(db);
  const claimsBefore = await snapshotClaimIdentities(db);

  const remainingWithInjectedFailure: readonly MigrationStepDefinition[] = [
    ...allMigrations,
    failingStep,
  ];

  let caughtError: unknown;
  try {
    await applyPendingMigrationSteps(db, remainingWithInjectedFailure);
  } catch (err) {
    caughtError = err;
  }

  if (caughtError === undefined) {
    throw new Error(`Expected injected migration '${failingStep.name}' to fail, but it succeeded`);
  }

  const committedMigrations = await listCommittedMigrations(db);
  const lastCommittedMigration =
    committedMigrations.length > 0
      ? (committedMigrations[committedMigrations.length - 1] ?? null)
      : null;

  const committedSet = new Set(committedMigrations);
  const pendingMigrations = remainingWithInjectedFailure
    .map((s) => s.name)
    .filter((name) => !committedSet.has(name));

  const transfersAfterFailure = await snapshotTransferIdentities(db);
  const claimsAfterFailure = await snapshotClaimIdentities(db);

  const errorMessage =
    caughtError instanceof Error
      ? caughtError.message
      : typeof caughtError === "string"
        ? caughtError
        : JSON.stringify(caughtError);

  return {
    failedMigration: failingStep.name,
    errorMessage,
    lastCommittedMigration,
    committedMigrations,
    pendingMigrations,
    recoveryBoundaryDocumented: `Transactional DDL rolled back '${failingStep.name}'; pgmigrations remains cleanly at '${lastCommittedMigration ?? "none"}' so fixing '${failingStep.name}' and re-running applyPendingMigrationSteps resumes from '${failingStep.name}' without touching committed records.`,
    preUpgradeTransfersIntact:
      JSON.stringify(transfersBefore) === JSON.stringify(transfersAfterFailure),
    preUpgradeClaimsIntact: JSON.stringify(claimsBefore) === JSON.stringify(claimsAfterFailure),
  };
}
