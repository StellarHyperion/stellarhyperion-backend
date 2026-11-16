/**
 * Rail status polling against a real Postgres instance.
 *
 * Checks that pendingForRail correctly finds uncompleted transfers, that RailPass updates
 * rail_attestation rows with proper status mapping and timestamps, and that an existing
 * inbound_delivery marks the transfer delivered without calling the external rail client.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { writeOutbound, writeInbound } from "../../src/chains/writers.js";
import { Database } from "../../src/db/pool.js";
import {
  outstandingForRail,
  pendingForRail,
  schedulePendingForRail,
} from "../../src/rails/queue.js";
import { RailPass } from "../../src/rails/pass.js";
import type { PendingTransfer, RailClient, RailLookup } from "../../src/rails/types.js";
import { capturingLogger } from "../stellar-fakes.js";

const CONNECTION = process.env.TEST_DATABASE_URL;
const suite = CONNECTION === undefined ? describe.skip : describe;

const ORIGIN_CHAIN = "sepolia";
const DESTINATION_CHAIN = "stellar-testnet";

suite("rail pollers against real Postgres", () => {
  let db: Database;

  const clean = async (): Promise<void> => {
    await db.query("DELETE FROM rail_attestation WHERE route IN (0, 1)");
    await db.query("DELETE FROM inbound_delivery WHERE route IN (0, 1)");
    await db.query("DELETE FROM outbound_transfer WHERE route IN (0, 1)");
  };

  beforeAll(async () => {
    db = Database.open(CONNECTION ?? "", { applicationName: "hyperion-rails-test" });
    await clean();
  });

  afterAll(async () => {
    await clean();
    await db.close();
  });

  it("finds pending transfers, polls rail, and updates rail_attestation", async () => {
    const { logger } = capturingLogger();

    // 1. Seed an outbound transfer for CCTP (route 0)
    await db.transaction(async (tx) => {
      await writeOutbound(
        tx,
        {
          chainKey: ORIGIN_CHAIN,
          block: 1000n,
          txHash: "0xaaa101",
          logIndex: 0,
          observedAt: new Date(),
        },
        {
          route: 0,
          nonce: 101n,
          sender: "0x1111111111111111111111111111111111111111",
          token: "0x3333333333333333333333333333333333333333",
          grossAmount: 1001000n,
          fee: 1000n,
          netAmount: 1000000n,
          destinationChain: DESTINATION_CHAIN,
          destination: "0x2222222222222222222222222222222222222222",
          railRef: "0x0000",
        },
      );
    });

    const pending = await pendingForRail(db, {
      route: 0,
      limit: 10,
      notCheckedSince: new Date(Date.now() + 1000),
      maxCheckFailures: 5,
    });
    expect(pending.length).toBeGreaterThanOrEqual(1);
    const first = pending.find((p) => p.nonce === 101n);
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(first.nonce).toBe(101n);
    expect(first.delivered).toBe(false);

    // 2. Mock RailClient returning an attested status
    const mockClient: RailClient = {
      rail: "cctp",
      look: (_transfer: PendingTransfer): Promise<RailLookup> => {
        return Promise.resolve({
          kind: "found",
          report: {
            status: "attested",
            railStatus: "complete",
            reference: "iris-ref-101",
            attestedAt: new Date("2026-10-07T12:00:00Z"),
          },
        });
      },
    };

    const pass = new RailPass({
      route: 0,
      client: mockClient,
      db,
      logger,
      batchSize: 10,
      recheckAfterMs: 0,
      maxCheckFailures: 5,
    });

    const more = await pass.tick(new AbortController().signal);
    expect(more).toBe(false);

    // Verify rail_attestation table
    const { rows } = await db.query("SELECT * FROM rail_attestation WHERE transfer_id = $1", [
      first.transferId.toString(),
    ]);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(row.status).toBe("attested");
    expect(row.rail_status).toBe("complete");
    expect(row.rail_reference).toBe("iris-ref-101");
    expect(row.attested_at).toBeInstanceOf(Date);
    expect((row.attested_at as Date).toISOString()).toBe("2026-10-07T12:00:00.000Z");
  });

  it("short-circuits to delivered when inbound_delivery exists", async () => {
    const { logger } = capturingLogger();

    // 1. Seed outbound transfer and matching inbound delivery
    await db.transaction(async (tx) => {
      await writeOutbound(
        tx,
        {
          chainKey: ORIGIN_CHAIN,
          block: 1005n,
          txHash: "0xaaa202",
          logIndex: 0,
          observedAt: new Date(),
        },
        {
          route: 1, // Axelar
          nonce: 202n,
          sender: "0x1111111111111111111111111111111111111111",
          token: "0x3333333333333333333333333333333333333333",
          grossAmount: 5005000n,
          fee: 5000n,
          netAmount: 5000000n,
          destinationChain: DESTINATION_CHAIN,
          destination: "0x2222222222222222222222222222222222222222",
          railRef: "0x0000",
        },
      );

      await writeInbound(
        tx,
        {
          chainKey: DESTINATION_CHAIN,
          block: 2000n,
          txHash: "0xdest202",
          logIndex: 0,
          observedAt: new Date(),
        },
        {
          route: 1,
          sourceChain: ORIGIN_CHAIN,
          sourceNonce: 202n,
          recipient: "0x2222222222222222222222222222222222222222",
          token: "0x3333333333333333333333333333333333333333",
          amount: 5000000n,
          delivered: true,
          claimId: null,
          railMessageId: "0xmsg202",
        },
      );
    });

    let clientCalled = false;
    const mockClient: RailClient = {
      rail: "axelar",
      look: (): Promise<RailLookup> => {
        clientCalled = true;
        return Promise.reject(new Error("Should not be called!"));
      },
    };

    const pass = new RailPass({
      route: 1,
      client: mockClient,
      db,
      logger,
      batchSize: 10,
      recheckAfterMs: 0,
      maxCheckFailures: 5,
    });

    await pass.tick(new AbortController().signal);
    expect(clientCalled).toBe(false);

    // Verify row status is delivered
    const { rows } = await db.query(
      `SELECT a.status, a.check_failures FROM rail_attestation a
       JOIN outbound_transfer t ON t.id = a.transfer_id
       WHERE t.nonce = 202 AND t.route = 1`,
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(row.status).toBe("delivered");
    expect(row.check_failures).toBe(0);

    // Outstanding should now be 0 for this transfer since delivered is terminal
    const outstanding = await outstandingForRail(db, 1);
    expect(outstanding).toBe(0);
  });

  it("schedules across fresh and stale age buckets and caps per-destination share", async () => {
    const now = new Date("2026-10-16T12:00:00Z");
    await db.transaction(async (tx) => {
      for (let i = 601; i <= 606; i += 1) {
        await writeOutbound(
          tx,
          {
            chainKey: ORIGIN_CHAIN,
            block: BigInt(1100 + i),
            txHash: `0xaaa${String(i)}`,
            logIndex: 0,
            observedAt: new Date("2026-10-16T08:00:00Z"),
          },
          {
            route: 0,
            nonce: BigInt(i),
            sender: "0x1111111111111111111111111111111111111111",
            token: "0x3333333333333333333333333333333333333333",
            grossAmount: 1001000n,
            fee: 1000n,
            netAmount: 1000000n,
            destinationChain: DESTINATION_CHAIN,
            destination: "0x2222222222222222222222222222222222222222",
            railRef: "0x0000",
          },
        );
      }
      await writeOutbound(
        tx,
        {
          chainKey: ORIGIN_CHAIN,
          block: 1800n,
          txHash: "0xaaa699",
          logIndex: 0,
          observedAt: new Date("2026-10-16T11:59:30Z"),
        },
        {
          route: 0,
          nonce: 699n,
          sender: "0x1111111111111111111111111111111111111111",
          token: "0x3333333333333333333333333333333333333333",
          grossAmount: 1001000n,
          fee: 1000n,
          netAmount: 1000000n,
          destinationChain: "base-sepolia",
          destination: "0x2222222222222222222222222222222222222222",
          railRef: "0x0000",
        },
      );
    });

    const scheduled = await schedulePendingForRail(db, {
      route: 0,
      limit: 4,
      notCheckedSince: new Date("2026-10-16T12:01:00Z"),
      maxCheckFailures: 5,
      now,
      scheduling: { maxPerDestination: 2 },
    });

    expect(scheduled.selected.some((item) => item.nonce === 699n)).toBe(true);
    expect(scheduled.destinationCounts[DESTINATION_CHAIN] ?? 0).toBeLessThanOrEqual(2);
  });
});
