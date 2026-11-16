import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildIndexer } from "../../src/chains/runner.js";
import { writeOutbound } from "../../src/chains/writers.js";
import { loadConfig } from "../../src/config/config.js";
import type { Queryable, QueryResultRows, Transactional } from "../../src/db/pool.js";
import { RailPass } from "../../src/rails/pass.js";
import { pendingForRail } from "../../src/rails/queue.js";
import {
  AsyncSemaphore,
  DestinationBudgetPool,
  TransferOwnershipGuard,
  type PendingTransfer,
  type RailClient,
  type RailLookup,
} from "../../src/rails/types.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const pg = new PGlite();

function normalizeRows(result: {
  readonly rows: readonly unknown[];
  readonly fields: readonly { readonly name: string; readonly dataTypeID: number }[];
  readonly affectedRows?: number;
}): QueryResultRows {
  const int8Columns = result.fields
    .filter((field) => field.dataTypeID === 20)
    .map((field) => field.name);
  const rows = result.rows.map((raw) => {
    const row = { ...(raw as Record<string, unknown>) };
    for (const column of int8Columns) {
      const value = row[column];
      if (typeof value === "number" || typeof value === "bigint") {
        row[column] = String(value);
      }
    }
    return row;
  });
  return { rows, rowCount: result.affectedRows ?? result.rows.length };
}

function createSerializedPgliteDb(): Transactional & Queryable {
  const connectionGate = new AsyncSemaphore(1);

  const rawQuery = async (
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResultRows> => {
    const result = await pg.query(sql, [...params]);
    return normalizeRows(result);
  };

  return {
    query: (sql: string, params: readonly unknown[] = []) =>
      connectionGate.run(() => rawQuery(sql, params)),
    transaction: <T>(work: (tx: Queryable) => Promise<T>) =>
      connectionGate.run(async () => {
        await pg.exec("BEGIN");
        try {
          const tx: Queryable = {
            query: (sql: string, params: readonly unknown[] = []) => rawQuery(sql, params),
          };
          const out = await work(tx);
          await pg.exec("COMMIT");
          return out;
        } catch (error) {
          await pg.exec("ROLLBACK");
          throw error;
        }
      }),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("destination-specific rail concurrency budgets and per-transfer ownership", () => {
  const db = createSerializedPgliteDb();
  const { logger } = capturingLogger();
  const config = loadConfig({
    env: completeEnv({
      KEEPER_ENABLED: "false",
      RAIL_PROVIDER_CONCURRENCY: "3",
      RAIL_DESTINATION_CONCURRENCY: "2",
      RAIL_DESTINATION_CONCURRENCY_SEPOLIA: "1",
    }),
  });
  const stellarDeployment = config.deployments.networks["stellar-testnet"];
  if (stellarDeployment?.family !== "stellar" || !stellarDeployment.tokens.USDC) {
    throw new Error("Expected stellar-testnet deployment in test fixture");
  }
  const senderAddress = stellarDeployment.admin;
  const sacToken = stellarDeployment.tokens.USDC.sacId;
  const recipientWord = "0x0000000000000000000000001111111111111111111111111111111111111111";

  beforeAll(async () => {
    for (const name of [
      "1790900000000_initial-schema.sql",
      "1791000000000_cursor-block-hash.sql",
      "1791100000000_cursor-autovacuum-tuning.sql",
    ]) {
      const sql = readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8").split(
        "-- Down Migration",
      )[0]!;
      await pg.exec(sql);
    }
  }, 30_000);

  beforeEach(async () => {
    await pg.exec(`
      TRUNCATE outbound_transfer, rail_attestation, inbound_delivery, pending_claim RESTART IDENTITY CASCADE;
    `);
  });

  afterAll(async () => {
    await pg.close();
  });

  async function seedTransfer(nonce: number, destinationChain: string, route = 0): Promise<void> {
    await db.transaction(async (tx) => {
      await writeOutbound(
        tx,
        {
          chainKey: "stellar-testnet",
          block: BigInt(1287400 + nonce),
          txHash: `stellar-source-${String(nonce)}`,
          logIndex: null,
          observedAt: new Date("2026-10-30T00:00:00.000Z"),
        },
        {
          route,
          nonce: BigInt(nonce),
          sender: senderAddress,
          token: sacToken,
          grossAmount: 10_000_000n,
          fee: 30_000n,
          netAmount: 9_970_000n,
          destinationChain,
          destination: recipientWord,
          railRef: null,
        },
      );
    });
  }

  it("loads global and per-destination concurrency overrides in config and shares budgets across rail workers", () => {
    expect(config.rails.providerConcurrency).toBe(3);
    expect(config.rails.destinationConcurrency).toBe(2);
    expect(config.rails.destinationBudgets).toEqual({ sepolia: 1 });

    const indexer = buildIndexer({ config, logger, db });
    const railNames = indexer.workers
      .filter((worker) => worker.name.startsWith("rail:"))
      .map((worker) => worker.name);
    expect(railNames).toEqual(["rail:cctp", "rail:axelar"]);
  });

  it("enforces separate provider and destination RPC budgets while letting healthy destinations finish ahead of a slow destination", async () => {
    // Seed 6 slow sepolia transfers first, followed by 3 fast base-sepolia and 3 fast arc-testnet transfers.
    for (let nonce = 1; nonce <= 6; nonce += 1) {
      await seedTransfer(nonce, "sepolia");
    }
    for (let nonce = 7; nonce <= 9; nonce += 1) {
      await seedTransfer(nonce, "base-sepolia");
    }
    for (let nonce = 10; nonce <= 12; nonce += 1) {
      await seedTransfer(nonce, "arc-testnet");
    }

    // Fair queue selection ensures all three destinations enter a bounded batch of 6 even though
    // sepolia was inserted first.
    const fairBatch = await pendingForRail(db, {
      route: 0,
      limit: 6,
      notCheckedSince: new Date("2026-10-30T00:05:00.000Z"),
      maxCheckFailures: 5,
    });
    expect(new Set(fairBatch.map((item) => item.destinationChain))).toEqual(
      new Set(["sepolia", "base-sepolia", "arc-testnet"]),
    );

    let activeProvider = 0;
    let peakProvider = 0;
    const activeByDest: Record<string, number> = {};
    const peakByDest: Record<string, number> = {};
    const completionOrder: string[] = [];

    const client: RailClient = {
      rail: "cctp",
      look: async (transfer: PendingTransfer): Promise<RailLookup> => {
        activeProvider += 1;
        peakProvider = Math.max(peakProvider, activeProvider);
        try {
          await delay(10);
          return {
            kind: "found",
            report: {
              status: "attested",
              railStatus: "complete",
              reference: `iris-${transfer.nonce.toString()}`,
              attestedAt: new Date("2026-10-30T00:01:00.000Z"),
              forwardTxHash: `0x${transfer.nonce.toString().padStart(64, "b")}`,
            },
          };
        } finally {
          activeProvider -= 1;
        }
      },
    };

    const destinationPool = new DestinationBudgetPool({
      defaultConcurrency: 2,
      overrides: { sepolia: 1 },
    });

    const pass = new RailPass({
      route: 0,
      client,
      db,
      logger,
      batchSize: 9,
      recheckAfterMs: 10_000,
      maxCheckFailures: 5,
      providerConcurrency: 3,
      destinationPool,
      now: () => new Date("2026-10-30T00:02:00.000Z"),
      verifyDelivery: async (transfer) => {
        const dest = transfer.destinationChain;
        activeByDest[dest] = (activeByDest[dest] ?? 0) + 1;
        peakByDest[dest] = Math.max(peakByDest[dest] ?? 0, activeByDest[dest]);
        try {
          await delay(dest === "sepolia" ? 90 : 8);
          completionOrder.push(`${dest}:${transfer.nonce.toString()}`);
          return {
            at: {
              chainKey: dest,
              block: 9000n + transfer.nonce,
              txHash: `0x${transfer.nonce.toString().padStart(64, "c")}`,
              logIndex: 1,
              observedAt: new Date("2026-10-30T00:02:00.000Z"),
            },
            row: {
              route: transfer.route,
              sourceChain: transfer.originChain,
              sourceNonce: transfer.nonce,
              railMessageId: `0x${transfer.nonce.toString().padStart(64, "d")}`,
              recipient: "0x1111111111111111111111111111111111111111",
              token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
              amount: 997_000n,
              delivered: true,
              claimId: null,
            },
          };
        } finally {
          activeByDest[dest] = (activeByDest[dest] ?? 1) - 1;
        }
      },
    });

    await pass.tick(new AbortController().signal);

    expect(peakProvider).toBeLessThanOrEqual(3);
    expect(peakProvider).toBeGreaterThanOrEqual(2);
    expect(peakByDest.sepolia).toBe(1);
    expect(peakByDest["base-sepolia"]).toBeLessThanOrEqual(2);
    expect(peakByDest["arc-testnet"]).toBeLessThanOrEqual(2);

    // Healthy destinations complete before slow sepolia drains its serialized queue.
    const lastSepoliaIndex = completionOrder.findLastIndex((item) => item.startsWith("sepolia:"));
    const lastArcIndex = completionOrder.findLastIndex((item) => item.startsWith("arc-testnet:"));
    const lastBaseIndex = completionOrder.findLastIndex((item) => item.startsWith("base-sepolia:"));
    expect(lastArcIndex).toBeGreaterThanOrEqual(0);
    expect(lastBaseIndex).toBeGreaterThanOrEqual(0);
    expect(lastArcIndex).toBeLessThan(lastSepoliaIndex);
    expect(lastBaseIndex).toBeLessThan(lastSepoliaIndex);
  });

  it("preserves per-transfer ownership across concurrent replicas and never marks unverified provider status as delivered", async () => {
    for (let nonce = 1; nonce <= 5; nonce += 1) {
      await seedTransfer(nonce, "sepolia");
    }

    const providerCallsByNonce = new Map<string, number>();
    const makeClient = (): RailClient => ({
      rail: "cctp",
      look: async (transfer: PendingTransfer): Promise<RailLookup> => {
        const key = transfer.nonce.toString();
        providerCallsByNonce.set(key, (providerCallsByNonce.get(key) ?? 0) + 1);
        await delay(15);
        return {
          kind: "found",
          report: {
            status: "attested",
            railStatus: "complete",
            reference: `iris-unverified-${key}`,
            attestedAt: new Date("2026-10-30T00:01:00.000Z"),
            forwardTxHash: `0x${key.padStart(64, "e")}`,
          },
        };
      },
    });

    const sharedGuard = new TransferOwnershipGuard();
    const fixedTime = new Date("2026-10-30T00:10:00.000Z");

    // Simulate two independent replicas (separate in-memory guards) racing against the same DB
    // plus shared destination verification returning null (candidate tx not yet finalized on-chain).
    const replicaA = new RailPass({
      route: 0,
      client: makeClient(),
      db,
      logger,
      batchSize: 5,
      recheckAfterMs: 30_000,
      maxCheckFailures: 5,
      providerConcurrency: 3,
      ownershipGuard: sharedGuard,
      now: () => fixedTime,
      verifyDelivery: async () => {
        await delay(10);
        return null;
      },
    });

    const replicaB = new RailPass({
      route: 0,
      client: makeClient(),
      db,
      logger,
      batchSize: 5,
      recheckAfterMs: 30_000,
      maxCheckFailures: 5,
      providerConcurrency: 3,
      now: () => fixedTime,
      verifyDelivery: async () => {
        await delay(10);
        return null;
      },
    });

    await Promise.all([
      replicaA.tick(new AbortController().signal),
      replicaB.tick(new AbortController().signal),
    ]);

    // Each transfer was claimed and looked up exactly once across the two concurrent replicas.
    for (let nonce = 1; nonce <= 5; nonce += 1) {
      expect(providerCallsByNonce.get(String(nonce))).toBe(1);
    }

    // Provider "complete" + forwardTxHash without verified destination receipt MUST stay attested,
    // never delivered, and write zero inbound_delivery rows.
    const inboundCount = await db.query("SELECT count(*)::int AS n FROM inbound_delivery");
    expect(inboundCount.rows[0]?.n).toBe(0);

    const attestations = await db.query(
      "SELECT status, rail_status FROM rail_attestation ORDER BY transfer_id ASC",
    );
    expect(attestations.rows).toHaveLength(5);
    for (const row of attestations.rows) {
      expect(row.status).toBe("attested");
      expect(row.rail_status).toBe("complete");
    }
  });
});
