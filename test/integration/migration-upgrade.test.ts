/**
 * Upgrade coverage for the supported migration history.
 *
 * The fixture deliberately starts at the first schema rather than creating the current schema
 * directly. That catches a migration which works on a fresh database but cannot carry a real
 * transfer and claim row across the upgrade boundary.
 */
import { Client } from "pg";
import { runner } from "node-pg-migrate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { mkdtemp, readdir, cp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const CONNECTION = process.env.TEST_DATABASE_URL;
const suite = CONNECTION === undefined ? describe.skip : describe;
const SCHEMA = "migration_upgrade_fixture";
const MIGRATIONS = resolve(process.cwd(), "migrations");

async function migrate(
  options: { readonly file?: string; readonly dir?: string } = {},
): Promise<void> {
  await runner({
    databaseUrl: CONNECTION ?? "",
    dir: options.dir ?? MIGRATIONS,
    direction: "up",
    ...(options.file === undefined ? {} : { file: options.file.replace(/\.sql$/, "") }),
    migrationsSchema: SCHEMA,
    migrationsTable: "schema_migrations",
    schema: SCHEMA,
    createMigrationsSchema: true,
    createSchema: true,
    checkOrder: true,
    singleTransaction: true,
    advisoryLockMode: "wait",
    log: () => undefined,
  });
}

suite("migration upgrade fixtures", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: CONNECTION });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await migrate({ file: "1790900000000_initial-schema.sql" });
    await client.query(
      `INSERT INTO ${SCHEMA}.outbound_transfer
         (origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
          destination_chain, destination, origin_block, origin_tx)
       VALUES ('stellar-testnet', 1, $1, 'Gsender', 'CUSDC', $2, 3, $3,
               'sepolia', '0xrecipient', $4, 'source-tx')`,
      [
        "18446744073709551615",
        "100000000000000000000000000000000000000",
        "99999999999999999999999999999999999997",
        "9223372036854775808",
      ],
    );
    await client.query(
      `INSERT INTO ${SCHEMA}.pending_claim
         (chain, claim_id, recipient, token, amount, route, source_chain, source_nonce, created_at)
       VALUES ('sepolia', $1, '0xrecipient', 'CUSDC', $2, 1, 'stellar-testnet', $3, now())`,
      ["18446744073709551615", "99999999999999999999999999999999999997", "18446744073709551615"],
    );
  });

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.end();
  });

  it("carries representative identities through every later migration", async () => {
    const files = (await readdir(MIGRATIONS)).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files.slice(1)) {
      await migrate({ file });
      const identity =
        await client.query(`SELECT t.nonce,t.gross_amount,t.net_amount,t.origin_block,c.claim_id,c.amount
        FROM ${SCHEMA}.outbound_transfer t JOIN ${SCHEMA}.pending_claim c
          ON c.source_chain=t.origin_chain AND c.source_nonce=t.nonce AND c.route=t.route AND c.chain=t.destination_chain
        WHERE t.origin_tx='source-tx'`);
      expect(identity.rows, file).toEqual([
        {
          nonce: "18446744073709551615",
          gross_amount: "100000000000000000000000000000000000000",
          net_amount: "99999999999999999999999999999999999997",
          origin_block: "9223372036854775808",
          claim_id: "18446744073709551615",
          amount: "99999999999999999999999999999999999997",
        },
      ]);
      await expect(
        client.query(
          `UPDATE ${SCHEMA}.outbound_transfer SET net_amount=1 WHERE origin_tx='source-tx'`,
        ),
        file,
      ).rejects.toMatchObject({ code: "23514" });
      if (file >= "1791800000000_outbound-router-identity.sql") {
        const binding = await client.query(`SELECT c.source_transfer_id=t.id AS exact_source
          FROM ${SCHEMA}.pending_claim c JOIN ${SCHEMA}.outbound_transfer t ON c.source_transfer_id=t.id`);
        expect(binding.rows, file).toEqual([{ exact_source: true }]);
      }
    }

    const outbound = await client.query(
      `SELECT origin_chain, nonce, gross_amount, net_amount, origin_block
         FROM ${SCHEMA}.outbound_transfer WHERE origin_tx = 'source-tx'`,
    );
    expect(outbound.rows).toEqual([
      {
        origin_chain: "stellar-testnet",
        nonce: "18446744073709551615",
        gross_amount: "100000000000000000000000000000000000000",
        net_amount: "99999999999999999999999999999999999997",
        origin_block: "9223372036854775808",
      },
    ]);

    const claim = await client.query(
      `SELECT chain, claim_id, amount, source_nonce
         FROM ${SCHEMA}.pending_claim WHERE recipient = '0xrecipient'`,
    );
    expect(claim.rows).toEqual([
      {
        chain: "sepolia",
        claim_id: "18446744073709551615",
        amount: "99999999999999999999999999999999999997",
        source_nonce: "18446744073709551615",
      },
    ]);

    await expect(
      client.query(
        `INSERT INTO ${SCHEMA}.outbound_transfer
           (origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
            destination_chain, destination, origin_block, origin_tx)
         VALUES ('stellar-testnet', 1, $1, 'Gsender', 'CUSDC', 100, 4, 95,
                 'sepolia', '0xother', 1, 'bad-split')`,
        ["18446744073709551614"],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("is idempotent after the upgrade boundary", async () => {
    await migrate();
    const { rows } = await client.query(
      `SELECT count(*)::int AS count FROM ${SCHEMA}.outbound_transfer WHERE origin_tx = 'source-tx'`,
    );
    expect(rows[0]?.count).toBe(1);
  });

  it("rolls back a failed monetary upgrade and resumes from the unchanged recorded boundary", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "hyperion-upgrade-boundary-"));
    await cp(MIGRATIONS, directory, { recursive: true });
    // Always one step after the newest shipped migration, so the fault fixture never sorts before
    // a real migration and trips checkOrder as new migrations land.
    const newest = (await readdir(MIGRATIONS))
      .filter((name) => /^\d{13}_.+\.sql$/.test(name))
      .map((name) => BigInt(name.slice(0, 13)))
      .reduce((max, value) => (value > max ? value : max), 0n);
    const file = resolve(directory, `${String(newest + 100000000n)}_fault-boundary.sql`);
    const before = await client.query(
      `SELECT name FROM ${SCHEMA}.schema_migrations ORDER BY run_on,id`,
    );
    try {
      await writeFile(
        file,
        "-- Up Migration\nUPDATE outbound_transfer SET sender='changed' WHERE origin_tx='source-tx'; SELECT 1/0;\n-- Down Migration\nSELECT 1;",
      );
      await expect(migrate({ dir: directory })).rejects.toThrow();
      expect(
        (
          await client.query(
            `SELECT sender FROM ${SCHEMA}.outbound_transfer WHERE origin_tx='source-tx'`,
          )
        ).rows,
      ).toEqual([{ sender: "Gsender" }]);
      expect(
        (await client.query(`SELECT name FROM ${SCHEMA}.schema_migrations ORDER BY run_on,id`))
          .rows,
      ).toEqual(before.rows);
      await writeFile(
        file,
        "-- Up Migration\nCREATE TABLE recovered_upgrade_boundary (source_id bigint REFERENCES outbound_transfer(id)); INSERT INTO recovered_upgrade_boundary SELECT id FROM outbound_transfer WHERE origin_tx='source-tx';\n-- Down Migration\nDROP TABLE recovered_upgrade_boundary;",
      );
      await migrate({ dir: directory });
      expect(
        (
          await client.query(
            `SELECT count(*)::integer AS count FROM ${SCHEMA}.recovered_upgrade_boundary`,
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
      await migrate({ dir: directory });
      expect(
        (
          await client.query(
            `SELECT count(*)::integer AS count FROM ${SCHEMA}.recovered_upgrade_boundary`,
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
