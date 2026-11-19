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

const CONNECTION = process.env.TEST_DATABASE_URL;
const suite = CONNECTION === undefined ? describe.skip : describe;
const SCHEMA = "migration_upgrade_fixture";
const MIGRATIONS = resolve(process.cwd(), "migrations");

async function migrate(options: { readonly file?: string } = {}): Promise<void> {
  await runner({
    databaseUrl: CONNECTION ?? "",
    dir: MIGRATIONS,
    direction: "up",
    ...(options.file === undefined ? {} : { file: options.file }),
    migrationsSchema: SCHEMA,
    migrationsTable: "schema_migrations",
    schema: SCHEMA,
    createMigrationsSchema: true,
    createSchema: true,
    checkOrder: true,
    singleTransaction: true,
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
    await migrate();

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
});
