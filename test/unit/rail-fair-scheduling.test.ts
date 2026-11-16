import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { AddressKind, encodeStellarAddress } from "@hyperion/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { writeOutbound } from "../../src/chains/writers.js";
import type { Queryable, QueryResultRows, Transactional } from "../../src/db/pool.js";
import { RailPass } from "../../src/rails/pass.js";
import { schedulePendingForRail } from "../../src/rails/queue.js";
import type { PendingTransfer, RailLookup } from "../../src/rails/types.js";
import { capturingLogger } from "../stellar-fakes.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function migrationUpSql(filename: string): string {
  const full = readFileSync(join(REPO_ROOT, "migrations", filename), "utf8");
  const [upPart] = full.split("-- Down Migration");
  if (upPart === undefined) {
    throw new Error(`missing -- Down Migration marker in ${filename}`);
  }
  return upPart;
}

function pgliteTransactional(pg: PGlite): Transactional {
  const toRows = (result: { rows: unknown[]; affectedRows?: number }): QueryResultRows => ({
    rows: result.rows as Record<string, unknown>[],
    rowCount: result.affectedRows ?? result.rows.length,
  });

  return {
    async query(sql: string, params?: readonly unknown[]): Promise<QueryResultRows> {
      const res = await pg.query(sql, params ? [...params] : []);
      return toRows(res);
    },
    async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
      return pg.transaction(async (tx) => {
        const wrapped: Queryable = {
          async query(sql: string, params?: readonly unknown[]): Promise<QueryResultRows> {
            const res = await tx.query(sql, params ? [...params] : []);
            return toRows(res);
          },
        };
        return work(wrapped);
      });
    },
  };
}

const STELLAR_SENDER = encodeStellarAddress(AddressKind.Account, new Uint8Array(32).fill(0x51));
const STELLAR_TOKEN = encodeStellarAddress(AddressKind.Contract, new Uint8Array(32).fill(0x62));
const EVM_RECIPIENT = `0x${"00".repeat(12)}${"73".repeat(20)}`;

describe("fair rail scheduling across old and new transfers (#86)", () => {
  let pg: PGlite;
  let db: Transactional;

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(migrationUpSql("1790900000000_initial-schema.sql"));
    await pg.exec(migrationUpSql("1791000000000_cursor-block-hash.sql"));
    db = pgliteTransactional(pg);
  });

  beforeEach(async () => {
    await db.query("DELETE FROM outbound_transfer");
  });

  afterAll(async () => {
    await pg.close();
  });

  async function seedBatch(
    items: readonly {
      readonly nonce: bigint;
      readonly destinationChain: string;
      readonly observedAt: Date;
      readonly route?: number | undefined;
    }[],
  ): Promise<void> {
    await db.transaction(async (tx) => {
      for (const item of items) {
        await writeOutbound(
          tx,
          {
            chainKey: "stellar-testnet",
            block: 700_000n + item.nonce,
            txHash: `${"ab".repeat(30)}${item.nonce.toString().padStart(4, "0")}`,
            logIndex: null,
            observedAt: item.observedAt,
          },
          {
            route: item.route ?? 1,
            nonce: item.nonce,
            sender: STELLAR_SENDER,
            token: STELLAR_TOKEN,
            grossAmount: 3_001_000n,
            fee: 1_000n,
            netAmount: 3_000_000n,
            destinationChain: item.destinationChain,
            destination: EVM_RECIPIENT,
            railRef: null,
          },
        );
      }
    });
  }

  it("allocates configured processing opportunities to fresh, aging, and stale buckets despite a large stale backlog", async () => {
    const now = new Date("2026-10-15T12:00:00Z");
    const staleAt = new Date("2026-10-15T08:00:00Z"); // 4 hours old (> 60m)
    const agingAt = new Date("2026-10-15T11:30:00Z"); // 30 minutes old (5m..60m)
    const freshAt = new Date("2026-10-15T11:58:00Z"); // 2 minutes old (<= 5m)

    const items: {
      nonce: bigint;
      destinationChain: string;
      observedAt: Date;
    }[] = [];

    // Seed 60 stale transfers FIRST (lowest primary key IDs) so naive FIFO would return 100% stale!
    for (let i = 1; i <= 60; i += 1) {
      items.push({ nonce: BigInt(i), destinationChain: "sepolia", observedAt: staleAt });
    }
    // Seed 10 aging transfers
    for (let i = 101; i <= 110; i += 1) {
      items.push({ nonce: BigInt(i), destinationChain: "sepolia", observedAt: agingAt });
    }
    // Seed 10 fresh transfers LAST
    for (let i = 201; i <= 210; i += 1) {
      items.push({ nonce: BigInt(i), destinationChain: "sepolia", observedAt: freshAt });
    }
    await seedBatch(items);

    const scheduled = await schedulePendingForRail(db, {
      route: 1,
      limit: 10,
      notCheckedSince: now,
      maxCheckFailures: 5,
      now,
      scheduling: {
        freshWeight: 5,
        agingWeight: 3,
        staleWeight: 2,
      },
    });

    expect(scheduled.selected).toHaveLength(10);
    // Exact 5 / 3 / 2 split across fresh, aging, and stale buckets!
    expect(scheduled.bucketCounts).toEqual({
      fresh: 5,
      aging: 3,
      stale: 2,
    });
    expect(scheduled.selected.filter((t) => t.ageBucket === "fresh").map((t) => t.nonce)).toEqual([
      201n,
      202n,
      203n,
      204n,
      205n,
    ]);
    expect(scheduled.selected.filter((t) => t.ageBucket === "aging").map((t) => t.nonce)).toEqual([
      101n,
      102n,
      103n,
    ]);
    expect(scheduled.selected.filter((t) => t.ageBucket === "stale").map((t) => t.nonce)).toEqual([
      1n,
      2n,
    ]);
  });

  it("enforces per-destination limits so a single noisy destination cannot monopolize a pass", async () => {
    const now = new Date("2026-10-15T12:00:00Z");
    const freshAt = new Date("2026-10-15T11:59:00Z");

    const items: {
      nonce: bigint;
      destinationChain: string;
      observedAt: Date;
    }[] = [];

    // 40 transfers to sepolia, 3 to base-sepolia, 3 to arbitrum-sepolia
    for (let i = 1; i <= 40; i += 1) {
      items.push({ nonce: BigInt(i), destinationChain: "sepolia", observedAt: freshAt });
    }
    for (let i = 51; i <= 53; i += 1) {
      items.push({ nonce: BigInt(i), destinationChain: "base-sepolia", observedAt: freshAt });
    }
    for (let i = 61; i <= 63; i += 1) {
      items.push({ nonce: BigInt(i), destinationChain: "arbitrum-sepolia", observedAt: freshAt });
    }
    await seedBatch(items);

    const scheduled = await schedulePendingForRail(db, {
      route: 1,
      limit: 8,
      notCheckedSince: now,
      maxCheckFailures: 5,
      now,
      scheduling: {
        maxPerDestination: 3,
      },
    });

    expect(scheduled.selected).toHaveLength(8);
    expect(scheduled.destinationCounts.sepolia).toBeLessThanOrEqual(3);
    expect(scheduled.destinationCounts["base-sepolia"]).toBeGreaterThanOrEqual(2);
    expect(scheduled.destinationCounts["arbitrum-sepolia"]).toBeGreaterThanOrEqual(2);
  });

  it("proves deterministically across consecutive passes that no eligible item is permanently starved", async () => {
    let clock = new Date("2026-10-15T12:00:00Z");
    const staleAt = new Date("2026-10-15T06:00:00Z");
    const agingAt = new Date("2026-10-15T11:30:00Z");
    const freshAt = new Date("2026-10-15T11:59:00Z");

    // 12 transfers spanning all 3 age buckets and 3 destination chains, processed with a tiny
    // batchSize = 2 (smaller than the 3 buckets!) and recheckAfterMs = 60_000.
    const expectedNonces = [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n, 11n, 12n];
    await seedBatch([
      { nonce: 1n, destinationChain: "sepolia", observedAt: staleAt },
      { nonce: 2n, destinationChain: "sepolia", observedAt: staleAt },
      { nonce: 3n, destinationChain: "sepolia", observedAt: staleAt },
      { nonce: 4n, destinationChain: "sepolia", observedAt: staleAt },
      { nonce: 5n, destinationChain: "base-sepolia", observedAt: staleAt },
      { nonce: 6n, destinationChain: "arbitrum-sepolia", observedAt: staleAt },
      { nonce: 7n, destinationChain: "sepolia", observedAt: agingAt },
      { nonce: 8n, destinationChain: "base-sepolia", observedAt: agingAt },
      { nonce: 9n, destinationChain: "arbitrum-sepolia", observedAt: agingAt },
      { nonce: 10n, destinationChain: "sepolia", observedAt: freshAt },
      { nonce: 11n, destinationChain: "base-sepolia", observedAt: freshAt },
      { nonce: 12n, destinationChain: "arbitrum-sepolia", observedAt: freshAt },
    ]);

    const visitedCounts = new Map<bigint, number>();
    const firstTickSeen = new Map<bigint, number>();
    const { logger } = capturingLogger();

    const pass = new RailPass({
      route: 1,
      client: {
        rail: "axelar",
        look(transfer: PendingTransfer): Promise<RailLookup> {
          visitedCounts.set(transfer.nonce, (visitedCounts.get(transfer.nonce) ?? 0) + 1);
          return Promise.resolve({ kind: "missing" });
        },
      },
      db,
      logger,
      batchSize: 2,
      recheckAfterMs: 60_000,
      maxCheckFailures: 5,
      now: () => clock,
      scheduling: {
        freshMaxAgeMs: 10 * 60_000,
        agingMaxAgeMs: 120 * 60_000,
        maxPerDestination: 1,
      },
    });

    // Run 10 deterministic ticks spaced 5 seconds apart (within 60s recheck window initially, then
    // advancing so every item gets its first visit in bounded passes)
    for (let tickIndex = 1; tickIndex <= 10; tickIndex += 1) {
      await pass.tick(new AbortController().signal);
      for (const nonce of expectedNonces) {
        if ((visitedCounts.get(nonce) ?? 0) > 0 && !firstTickSeen.has(nonce)) {
          firstTickSeen.set(nonce, tickIndex);
        }
      }
      clock = new Date(clock.getTime() + 5_000);
    }

    // Every single one of the 12 transfers across all 3 buckets and all 3 destinations was visited
    // with zero permanent starvation!
    for (const nonce of expectedNonces) {
      expect(
        visitedCounts.get(nonce) ?? 0,
        `nonce ${nonce.toString()} starved`,
      ).toBeGreaterThanOrEqual(1);
    }
    expect(firstTickSeen.size).toBe(expectedNonces.length);
  });
});
