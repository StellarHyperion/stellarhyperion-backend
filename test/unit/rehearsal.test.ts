import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Queryable, Transactional } from "../../src/db/pool.js";
import {
  computeHistoryDigest,
  recordIngestionRejection,
  recordSourceEvent,
  writeAction,
  writeClaim,
  writeInbound,
  writeOutbound,
  type Position,
} from "../../src/chains/writers.js";
import {
  RehearsalError,
  assertRehearsalTarget,
  exportRehearsalDataset,
  parseRehearsalSnapshot,
  restoreRehearsalDataset,
  validateRehearsalRestore,
  type RehearsalSnapshot,
} from "../../src/db/rehearsal.js";
import {
  parseRehearsalArgs,
  protectedTargetAllowed,
  rehearsalConnections,
} from "../../src/cli/rehearsal.js";

const MIGRATIONS = readdirSync(new URL("../../migrations/", import.meta.url))
  .filter((name) => /^\d{13}_[a-z0-9-]+\.sql$/.test(name))
  .sort();
const U64_MAX = 18446744073709551615n;
const U256_MAX = 115792089237316195423570985008687907853269984665640564039457584007913129639935n;

function adapter(pg: PGlite): Transactional {
  const wrap = async (
    run: (sql: string, params: unknown[]) => ReturnType<PGlite["query"]>,
    sql: string,
    params: readonly unknown[],
  ) => {
    const result = await run(sql, [...params]);
    const rows = (result.rows as Record<string, unknown>[]).map((raw) => {
      const row = { ...raw };
      for (const field of result.fields)
        if (field.dataTypeID === 20 && row[field.name] != null)
          row[field.name] = String(row[field.name]);
      return row;
    });
    return { rows, rowCount: result.affectedRows ?? rows.length };
  };
  return {
    query: (sql, params = []) => wrap((s, p) => pg.query(s, p), sql, params),
    transaction: <T>(work: (tx: Queryable) => Promise<T>) =>
      pg.transaction<T>((tx) =>
        work({ query: (sql, params = []) => wrap((s, p) => tx.query(s, p), sql, params) }),
      ),
  };
}

async function migrated(): Promise<{ pg: PGlite; db: Transactional }> {
  const pg = new PGlite();
  for (const file of MIGRATIONS)
    await pg.exec(
      readFileSync(new URL(`../../migrations/${file}`, import.meta.url), "utf8").split(
        "-- Down Migration",
      )[0]!,
    );
  // node-pg-migrate's bookkeeping, which the rehearsal reads to compare schema versions.
  await pg.exec("CREATE TABLE pgmigrations (id serial PRIMARY KEY, name text, run_on timestamp)");
  for (const file of MIGRATIONS)
    await pg.query("INSERT INTO pgmigrations (name, run_on) VALUES ($1, now())", [
      file.slice(0, -4),
    ]);
  return { pg, db: adapter(pg) };
}

/** A representative indexed dataset: both families, full-width values, provenance, rejections. */
async function seed(db: Queryable): Promise<void> {
  await db.query(
    `INSERT INTO indexer_cursor (chain_key, family, contract, last_processed, last_processed_at)
     VALUES ('stellar-testnet', 'stellar', 'CROUTER', 500, '2026-11-20T00:00:00Z'),
            ('sepolia', 'evm', '0xrouter', $1, '2026-11-20T00:00:00Z')`,
    [U64_MAX.toString()],
  );
  for (let index = 0; index < 5; index++) {
    const source = await recordSourceEvent(db, {
      chainKey: "stellar-testnet",
      family: "stellar",
      contract: "CROUTER",
      block: BigInt(400 + index),
      txHash: `stellar-tx-${String(index)}`,
      position: `0000000${String(index)}-0000000001`,
      eventKind: "bridgeOut",
      payloadDigest: String(index).repeat(64).slice(0, 64),
    });
    const at: Position = {
      chainKey: "stellar-testnet",
      router: "CROUTER",
      block: BigInt(400 + index),
      txHash: `stellar-tx-${String(index)}`,
      logIndex: null,
      observedAt: new Date(`2026-11-20T00:0${String(index)}:00Z`),
      sourceEventId: source.id,
    };
    await writeOutbound(db, at, {
      route: index % 2,
      nonce: index === 4 ? U64_MAX : BigInt(index),
      sender: `Gsender${String(index)}`,
      token: index % 2 === 0 ? "CUSDC" : "CEURC",
      grossAmount: index === 4 ? U256_MAX : 1_000_000n + BigInt(index),
      fee: index === 4 ? 0n : 1000n,
      netAmount: index === 4 ? U256_MAX : 999_000n + BigInt(index),
      destinationChain: "sepolia",
      destination: `0x${String(index).repeat(40)}`,
      railRef: null,
    });
  }
  const transfers = (
    await db.query("SELECT id::text AS id, nonce::text AS nonce FROM outbound_transfer ORDER BY id")
  ).rows;
  const evmSource = await recordSourceEvent(db, {
    chainKey: "sepolia",
    family: "evm",
    contract: "0xrouter",
    block: U64_MAX,
    txHash: `0x${"ab".repeat(32)}`,
    position: 0,
    eventKind: "BridgeIn",
    payloadDigest: "ab".repeat(32),
  });
  const evmAt: Position = {
    chainKey: "sepolia",
    router: "0xrouter",
    block: U64_MAX,
    txHash: `0x${"ab".repeat(32)}`,
    logIndex: 0,
    observedAt: new Date("2026-11-20T01:00:00Z"),
    sourceEventId: evmSource.id,
  };
  await writeInbound(db, evmAt, {
    sourceTransferId: BigInt(String(transfers[0]?.id)),
    route: 0,
    sourceChain: "stellar-testnet",
    sourceNonce: 0n,
    railMessageId: `0x${"cd".repeat(32)}`,
    recipient: "0x0000000000000000000000000000000000000000",
    token: "0xusdc",
    amount: 999_000n,
    delivered: true,
    claimId: null,
  });
  await writeClaim(db, evmAt, {
    claimId: U64_MAX,
    recipient: "0xrecipient",
    token: "0xusdc",
    amount: U256_MAX,
    route: 1,
    sourceChain: "stellar-testnet",
    sourceNonce: 1n,
    createdAt: evmAt.observedAt,
  });
  await writeAction(
    db,
    { ...evmAt, logIndex: 1 },
    {
      actionId: 7n,
      kind: 2,
      payload: { note: "pause" },
      eta: null,
      expiresAt: null,
    },
  );
  await recordSourceEvent(db, {
    chainKey: "sepolia",
    family: "evm",
    contract: "0xrouter",
    block: U64_MAX,
    txHash: `0x${"ab".repeat(32)}`,
    position: 0,
    eventKind: "BridgeIn",
    payloadDigest: "ef".repeat(32),
  });
  await recordIngestionRejection(db, {
    chainKey: "sepolia",
    family: "evm",
    contract: "0xrouter",
    block: 12n,
    txHash: `0x${"12".repeat(32)}`,
    position: 3,
    errorClass: "unsupported_payload",
    detail: "LogShapeError",
  });
}

let source: { pg: PGlite; db: Transactional };
let snapshot: RehearsalSnapshot;

beforeAll(async () => {
  source = await migrated();
  await seed(source.db);
  snapshot = parseRehearsalSnapshot(
    JSON.stringify(await exportRehearsalDataset(source.db, new Date("2026-11-20T02:00:00Z"))),
  );
}, 60_000);
afterAll(async () => {
  await source.pg.close();
});

describe("backup and restore rehearsal", () => {
  it("restores counts and monetary digests that match the source fixture", async () => {
    const target = await migrated();
    try {
      const restored = await restoreRehearsalDataset(target.db, snapshot);
      expect(restored).toEqual(snapshot.manifest.counts);
      expect(snapshot.manifest.counts).toMatchObject({
        outbound_transfer: 5,
        inbound_delivery: 1,
        pending_claim: 1,
        admin_action: 1,
        source_event: 6,
        source_event_conflict: 1,
        ingestion_rejection: 1,
      });
      const result = await validateRehearsalRestore(target.db, snapshot.manifest);
      expect(result).toEqual({ ok: true, mismatches: [] });

      for (const chainKey of ["stellar-testnet", "sepolia"]) {
        const options = { chainKey, startBlock: 0n, endBlock: U64_MAX, recordKind: "all" as const };
        const [before, after] = await Promise.all([
          computeHistoryDigest(source.db, options),
          computeHistoryDigest(target.db, options),
        ]);
        expect(after.digest).toBe(before.digest);
        expect(after.monetarySummary).toEqual(before.monetarySummary);
      }
      // Full-width values survive as exact integers, never through a JavaScript number.
      const wide = await target.db.query(
        "SELECT nonce::text AS nonce, net_amount::text AS amount FROM outbound_transfer WHERE nonce = $1",
        [U64_MAX.toString()],
      );
      expect(wide.rows[0]).toEqual({ nonce: U64_MAX.toString(), amount: U256_MAX.toString() });
      // Sequences continue after the restored ids instead of colliding with them.
      const next = await target.db.query(
        `INSERT INTO outbound_transfer
           (origin_chain, origin_router, route, nonce, sender, token, gross_amount, fee, net_amount,
            destination_chain, destination, origin_block, origin_tx)
         VALUES ('stellar-testnet', 'CROUTER', 0, 99, 'G', 'CUSDC', 2, 1, 1, 'sepolia', '0x', 1, 'tx')
         RETURNING id::text AS id`,
      );
      const maxRestored = Math.max(
        ...snapshot.tables.outbound_transfer!.rows.map((row) => Number(row[0])),
      );
      expect(Number(next.rows[0]?.id)).toBeGreaterThan(maxRestored);
    } finally {
      await target.pg.close();
    }
  });

  it("keeps cursor and provenance joins consistent, and detects when they are not", async () => {
    const target = await migrated();
    try {
      await restoreRehearsalDataset(target.db, snapshot);
      expect(snapshot.manifest.joins.danglingLinks).toBe(0);
      expect(snapshot.manifest.joins.danglingDeliveries).toBe(0);
      expect(snapshot.manifest.joins.cursors).toEqual([
        {
          chainKey: "sepolia",
          contract: "0xrouter",
          lastProcessed: U64_MAX.toString(),
          sourceEventsThrough: 1,
          sourceEventsBeyond: 0,
        },
        {
          chainKey: "stellar-testnet",
          contract: "CROUTER",
          lastProcessed: "500",
          sourceEventsThrough: 5,
          sourceEventsBeyond: 0,
        },
      ]);
      expect(snapshot.manifest.joins.links).toEqual({
        "admin_action:created": 1,
        "inbound_delivery:created": 1,
        "outbound_transfer:created": 5,
        "pending_claim:created": 1,
      });

      await target.db.query(
        "UPDATE indexer_cursor SET last_processed = 402 WHERE chain_key = 'stellar-testnet'",
      );
      await target.db.query("DELETE FROM admin_action");
      await target.db.query(
        "UPDATE outbound_transfer SET net_amount = net_amount + 1, gross_amount = gross_amount + 1 WHERE nonce = 0",
      );
      const result = await validateRehearsalRestore(target.db, snapshot.manifest);
      expect(result.ok).toBe(false);
      expect(result.mismatches).toEqual(
        expect.arrayContaining([
          "count admin_action: expected 1, restored 0",
          "digest stellar-testnet: history digest differs",
          "joins: cursor or provenance join fingerprint differs",
          "joins: 1 dangling provenance links",
        ]),
      );
    } finally {
      await target.pg.close();
    }
  });

  it("cannot target a production database without explicit configuration", async () => {
    const target = await migrated();
    try {
      await target.db.query(
        "INSERT INTO hyperion_database_identity (environment) VALUES ('production')",
      );
      await expect(restoreRehearsalDataset(target.db, snapshot)).rejects.toThrow(
        /Refusing to restore into a production database/,
      );
      expect(
        (await target.db.query("SELECT count(*)::int AS n FROM outbound_transfer")).rows[0]?.n,
      ).toBe(0);
      await expect(
        restoreRehearsalDataset(target.db, snapshot, { allowProtectedTarget: true }),
      ).resolves.toBeDefined();
      // Even when explicitly allowed, a restore never writes over existing rows.
      await expect(
        restoreRehearsalDataset(target.db, snapshot, { allowProtectedTarget: true }),
      ).rejects.toThrow(/not empty/);
      await target.db.query("UPDATE hyperion_database_identity SET environment = 'preview'");
      await expect(assertRehearsalTarget(target.db)).rejects.toBeInstanceOf(RehearsalError);
      await target.db.query("UPDATE hyperion_database_identity SET environment = 'development'");
      await expect(assertRehearsalTarget(target.db)).resolves.toBe("development");
    } finally {
      await target.pg.close();
    }

    const args = parseRehearsalArgs(["rehearse", "--allow-protected-target"]);
    expect(protectedTargetAllowed(args, {})).toBe(false);
    expect(
      protectedTargetAllowed(parseRehearsalArgs(["rehearse"]), {
        HYPERION_REHEARSAL_ALLOW_PROTECTED: "true",
      }),
    ).toBe(false);
    expect(protectedTargetAllowed(args, { HYPERION_REHEARSAL_ALLOW_PROTECTED: "true" })).toBe(true);

    const secret = "postgres://hyperion:s3cret@db.internal:5432/hyperion";
    expect(() => rehearsalConnections("restore", { DATABASE_URL: secret })).toThrow(
      /HYPERION_REHEARSAL_DATABASE_URL is not set/,
    );
    let message = "";
    try {
      rehearsalConnections("rehearse", {
        DATABASE_URL: secret,
        HYPERION_REHEARSAL_DATABASE_URL: "postgres://other:pw@DB.internal/hyperion",
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/must not be the source database/);
    expect(message).not.toContain("s3cret");
    expect(
      rehearsalConnections("rehearse", {
        DATABASE_URL: secret,
        HYPERION_REHEARSAL_DATABASE_URL: "postgres://u:p@localhost:5433/hyperion_rehearsal",
      }).target,
    ).toContain("hyperion_rehearsal");
  });

  it("refuses tampered snapshots and mismatched schema versions", async () => {
    const tampered = structuredClone(snapshot) as unknown as {
      tables: Record<string, { rows: (string | null)[][] }>;
    };
    tampered.tables.outbound_transfer!.rows[0]![0] = "999";
    expect(() => parseRehearsalSnapshot(JSON.stringify(tampered))).toThrow(/manifest digest/);
    expect(() => parseRehearsalSnapshot("{}")).toThrow(RehearsalError);
    expect(JSON.stringify(snapshot)).not.toMatch(/postgres(ql)?:\/\//);

    const target = await migrated();
    try {
      await target.db.query(
        "DELETE FROM pgmigrations WHERE name = (SELECT max(name) FROM pgmigrations)",
      );
      await expect(restoreRehearsalDataset(target.db, snapshot)).rejects.toThrow(
        /migrate the target to the same version/,
      );
    } finally {
      await target.pg.close();
    }
  });
});
