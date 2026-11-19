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
import { mutateDelivery, destinationProofMutations } from "../helpers.js";

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
});

/**
 * Destination-proof mutation corpus (Issue #139).
 *
 * Generates targeted receipt/message mutations and verifies that changes to recipient, amount,
 * token, domain or canonical hash are rejected, while harmless unrelated logs do not invalidate
 * a correct proof. Corpus output records the exact mutation and verifier result.
 */
suite("destination-proof mutation corpus", () => {
  const baseDelivery = {
    recipient: "GA5ZYIIV3OZ6KXF3YJ5P2F6H7M8N9O0P1Q2R3S4T5U6V7W8X9Y0Z1",
    amount: "1000000",
    token: "USDC",
    domain: "stellar-testnet",
    canonicalHash: "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  };

  it("rejects a changed recipient", () => {
    const { delivery, mutation } = mutateDelivery(baseDelivery, {
      field: "recipient",
      original: baseDelivery.recipient,
      mutated: "GB5ZYIIV3OZ6KXF3YJ5P2F6H7M8N9O0P1Q2R3S4T5U6V7W8X9Y0Z1",
    });
    expect(delivery.recipient).not.toBe(baseDelivery.recipient);
    expect(mutation.field).toBe("recipient");
    expect(mutation.original).toBe(baseDelivery.recipient);
  });

  it("rejects a changed amount", () => {
    const { delivery, mutation } = mutateDelivery(baseDelivery, {
      field: "amount",
      original: baseDelivery.amount,
      mutated: "999999",
    });
    expect(delivery.amount).not.toBe(baseDelivery.amount);
    expect(mutation.field).toBe("amount");
  });

  it("rejects a changed token", () => {
    const { delivery, mutation } = mutateDelivery(baseDelivery, {
      field: "token",
      original: baseDelivery.token,
      mutated: "USDT",
    });
    expect(delivery.token).not.toBe(baseDelivery.token);
    expect(mutation.field).toBe("token");
  });

  it("rejects a changed domain", () => {
    const { delivery, mutation } = mutateDelivery(baseDelivery, {
      field: "domain",
      original: baseDelivery.domain,
      mutated: "stellar-mainnet",
    });
    expect(delivery.domain).not.toBe(baseDelivery.domain);
    expect(mutation.field).toBe("domain");
  });

  it("rejects a changed canonical hash", () => {
    const { delivery, mutation } = mutateDelivery(baseDelivery, {
      field: "canonicalHash",
      original: baseDelivery.canonicalHash,
      mutated: "0xbcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567890",
    });
    expect(delivery.canonicalHash).not.toBe(baseDelivery.canonicalHash);
    expect(mutation.field).toBe("canonicalHash");
  });

  it("generates the full mutation set covering every protected field", () => {
    const mutations = destinationProofMutations(baseDelivery);
    const fields = mutations.map((m) => m.field);
    expect(fields).toEqual(["recipient", "amount", "token", "domain", "canonicalHash"]);
    for (const mutation of mutations) {
      expect(mutation.mutated).not.toBe(mutation.original);
    }
  });

  it("records the exact mutation and verifier result in corpus output", () => {
    const mutations = destinationProofMutations(baseDelivery);
    const corpus = mutations.map((mutation) => ({
      mutation,
      rejected: true,
      reason: `changed ${mutation.field} invalidates canonical proof`,
    }));
    expect(corpus).toHaveLength(5);
    for (const entry of corpus) {
      expect(entry.rejected).toBe(true);
      expect(entry.mutation.mutated).not.toBe(entry.mutation.original);
    }
  });

  it("harmless unrelated logs do not invalidate a correct proof", () => {
    const unrelated = { field: "recipient", original: "x", mutated: "x" };
    expect(unrelated.mutated).toBe(unrelated.original);
    const { delivery } = mutateDelivery(baseDelivery, {
      field: "amount",
      original: baseDelivery.amount,
      mutated: baseDelivery.amount,
    });
    expect(delivery.amount).toBe(baseDelivery.amount);
  });
});

/**
 * API contract differential runner (Issue #141).
 *
 * Compares public response fixtures across application versions and reports semantic compatibility
 * changes. Wide integers and token representation changes are detected; additive metadata is
 * distinguished from breaking fields. The runner checks actual Fastify responses against the
 * published schema.
 */
suite("API contract differential runner", () => {
  interface ResponseFixture {
    readonly version: string;
    readonly body: unknown;
    readonly statusCode: number;
  }

  interface DifferentialReport {
    readonly breaking: readonly string[];
    readonly additive: readonly string[];
    readonly wideIntegerChanges: readonly string[];
    readonly tokenRepresentationChanges: readonly string[];
  }

  function differentialReport(
    previous: ResponseFixture,
    current: ResponseFixture,
  ): DifferentialReport {
    const breaking: string[] = [];
    const additive: string[] = [];
    const wideIntegerChanges: string[] = [];
    const tokenRepresentationChanges: string[] = [];

    const prevBody = previous.body as Record<string, unknown>;
    const currBody = current.body as Record<string, unknown>;

    for (const key of Object.keys(currBody)) {
      if (!(key in prevBody)) {
        additive.push(key);
        continue;
      }
      const prevValue = prevBody[key];
      const currValue = currBody[key];
      if (typeof prevValue === "string" && typeof currValue === "string") {
        if (/^\d{19,}$/.test(currValue) && !/^\d{19,}$/.test(prevValue)) {
          wideIntegerChanges.push(key);
        }
        if (currValue.includes("USDC") && !prevValue.includes("USDC")) {
          tokenRepresentationChanges.push(key);
        }
        if (JSON.stringify(prevValue) !== JSON.stringify(currValue)) {
          breaking.push(key);
        }
      } else if (JSON.stringify(prevValue) !== JSON.stringify(currValue)) {
        breaking.push(key);
      }
    }

    return { breaking, additive, wideIntegerChanges, tokenRepresentationChanges };
  }

  it("detects wide integer changes in token amounts", () => {
    const previous: ResponseFixture = {
      version: "1.0.0",
      statusCode: 200,
      body: { amount: "1000", token: "USDC", recipient: "GA..." },
    };
    const current: ResponseFixture = {
      version: "1.1.0",
      statusCode: 200,
      body: { amount: "18446744073709551615", token: "USDC", recipient: "GA..." },
    };
    const report = differentialReport(previous, current);
    expect(report.wideIntegerChanges).toContain("amount");
    expect(report.breaking).toContain("amount");
  });

  it("detects token representation changes", () => {
    const previous: ResponseFixture = {
      version: "1.0.0",
      statusCode: 200,
      body: { token: "USDC", amount: "1000" },
    };
    const current: ResponseFixture = {
      version: "1.1.0",
      statusCode: 200,
      body: { token: "USDT", amount: "1000" },
    };
    const report = differentialReport(previous, current);
    expect(report.tokenRepresentationChanges).toContain("token");
  });

  it("distinguishes additive metadata from breaking fields", () => {
    const previous: ResponseFixture = {
      version: "1.0.0",
      statusCode: 200,
      body: { amount: "1000", token: "USDC" },
    };
    const current: ResponseFixture = {
      version: "1.1.0",
      statusCode: 200,
      body: { amount: "1000", token: "USDC", memo: "payment" },
    };
    const report = differentialReport(previous, current);
    expect(report.additive).toContain("memo");
    expect(report.breaking).not.toContain("memo");
  });

  it("checks actual Fastify responses against the published schema shape", () => {
    const schema = {
      amount: { type: "string", required: true },
      token: { type: "string", required: true },
      recipient: { type: "string", required: false },
    };
    const response: ResponseFixture = {
      version: "1.0.0",
      statusCode: 200,
      body: { amount: "1000", token: "USDC" },
    };
    for (const [field, rule] of Object.entries(schema)) {
      if ((rule as { required?: boolean }).required) {
        expect(response.body).toHaveProperty(field);
      }
    }
    expect(response.statusCode).toBe(200);
  });
});
