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

import { Database } from "../../src/db/pool.js";

const CONNECTION = process.env.TEST_DATABASE_URL;
const suite = CONNECTION === undefined ? describe.skip : describe;

/** Postgres error codes, so a test asserts on the failure it meant rather than on any failure. */
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const NUMERIC_OUT_OF_RANGE = "22003";

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
      "inbound_delivery",
      "indexer_cursor",
      "outbound_transfer",
      "pending_claim",
      "rail_attestation",
      "route_health",
    ]) {
      expect(names, `${table} is missing; has the migration run`).toContain(table);
    }
  });

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
});

suite("outbound_transfer", () => {
  let db: Database;
  let nonce = 1_000_000;

  const insert = async (gross: string, fee: string, net: string): Promise<void> => {
    nonce += 1;
    await db.query(
      `INSERT INTO public.outbound_transfer
         (origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
          destination_chain, destination, origin_block, origin_tx)
       VALUES ('base-sepolia', 0, $1, '0xsender', '0xtoken', $2, $3, $4,
               'stellar-testnet', 'GA5ZYIIV', 1, $5)`,
      [String(nonce), gross, fee, net, `0xtx-${String(nonce)}`],
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

  it("refuses two departures with the same nonce from one chain", async () => {
    // The router's counter is monotonic per router, so this is the identity of a departure. A
    // duplicate means the watcher re-read a page, and it should be a no-op rather than a second row.
    nonce += 1;
    const values = [String(nonce), "1000", "3", "997", `0xtx-${String(nonce)}`];
    const run = async (): Promise<void> => {
      await db.query(
        `INSERT INTO public.outbound_transfer
           (origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
            destination_chain, destination, origin_block, origin_tx)
         VALUES ('base-sepolia', 0, $1, '0xsender', '0xtoken', $2, $3, $4,
                 'stellar-testnet', 'GA5ZYIIV', 1, $5)`,
        values,
      );
    };
    await run();
    await expect(run()).rejects.toSatisfy((error: unknown) => codeOf(error) === UNIQUE_VIOLATION);
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
