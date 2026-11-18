/**
 * Rail status polling against a real Postgres instance.
 *
 * Checks that pendingForRail correctly finds uncompleted transfers, that RailPass updates
 * rail_attestation rows with proper status mapping and timestamps, and that an existing
 * inbound_delivery marks the transfer delivered without calling the external rail client.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { writeOutbound, writeInbound } from "../../src/chains/writers.js";
import { Database } from "../../src/db/pool.js";
import { outstandingForRail, pendingForRail } from "../../src/rails/queue.js";
import { RailPass } from "../../src/rails/pass.js";
import {
  RailError,
  type PendingTransfer,
  type RailClient,
  type RailLookup,
} from "../../src/rails/types.js";
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

  beforeEach(clean);

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
      now: new Date(),
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

  it("persists transient retry schedules across pass instances", async () => {
    const { logger } = capturingLogger();
    const startedAt = new Date();
    await db.transaction(async (tx) => {
      await writeOutbound(
        tx,
        {
          chainKey: ORIGIN_CHAIN,
          block: 1006n,
          txHash: "0xaaa303",
          logIndex: 0,
          observedAt: startedAt,
        },
        {
          route: 0,
          nonce: 303n,
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

    let now = startedAt;
    let calls = 0;
    const failingClient: RailClient = {
      rail: "cctp",
      look: (): Promise<RailLookup> => {
        calls += 1;
        return Promise.reject(new RailError("cctp", "transient", "secret=must-not-be-persisted"));
      },
    };
    const options = {
      route: 0,
      client: failingClient,
      db,
      logger,
      batchSize: 10,
      recheckAfterMs: 10_000,
      maxCheckFailures: 5,
      now: () => now,
    };

    await new RailPass(options).tick(new AbortController().signal);
    expect(calls).toBe(1);

    const { rows } = await db.query(
      `SELECT a.retry_class, a.next_attempt_at, a.last_error
         FROM rail_attestation a
         JOIN outbound_transfer t ON t.id = a.transfer_id
        WHERE t.nonce = 303 AND t.route = 0`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.retry_class).toBe("transient");
    expect(rows[0]?.next_attempt_at).toEqual(new Date(startedAt.getTime() + 10_000));
    expect(rows[0]?.last_error).toBe("cctp transient lookup failure");

    now = new Date(startedAt.getTime() + 9_999);
    await new RailPass(options).tick(new AbortController().signal);
    expect(calls).toBe(1);

    now = new Date(startedAt.getTime() + 10_000);
    await new RailPass(options).tick(new AbortController().signal);
    expect(calls).toBe(2);
  });

  it("holds permanent lookup failures until an operator explicitly recovers them", async () => {
    const { logger } = capturingLogger();
    const now = new Date();
    await db.transaction(async (tx) => {
      await writeOutbound(
        tx,
        {
          chainKey: ORIGIN_CHAIN,
          block: 1007n,
          txHash: "0xaaa404",
          logIndex: 0,
          observedAt: now,
        },
        {
          route: 0,
          nonce: 404n,
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

    const client: RailClient = {
      rail: "cctp",
      look: (): Promise<RailLookup> =>
        Promise.reject(new RailError("cctp", "permanent", "provider detail")),
    };
    await new RailPass({
      route: 0,
      client,
      db,
      logger,
      batchSize: 10,
      recheckAfterMs: 1000,
      maxCheckFailures: 5,
      now: () => now,
    }).tick(new AbortController().signal);

    let pending = await pendingForRail(db, {
      route: 0,
      limit: 10,
      now,
      notCheckedSince: new Date(now.getTime() - 1000),
      maxCheckFailures: 5,
    });
    expect(pending.some((transfer) => transfer.nonce === 404n)).toBe(false);

    await db.query(
      `UPDATE rail_attestation
          SET check_failures = 0,
              retry_class = NULL,
              next_attempt_at = now(),
              last_error = NULL
        WHERE transfer_id = (
          SELECT id FROM outbound_transfer WHERE route = 0 AND nonce = 404
        )
          AND retry_class IN ('permanent', 'exhausted')`,
    );

    pending = await pendingForRail(db, {
      route: 0,
      limit: 10,
      now: new Date(Date.now() + 1000),
      notCheckedSince: new Date(Date.now() + 1000),
      maxCheckFailures: 5,
    });
    expect(pending.some((transfer) => transfer.nonce === 404n)).toBe(true);
  });

  it("does not accept a provider's delivered status as destination evidence", async () => {
    const { logger } = capturingLogger();
    await db.transaction(async (tx) => {
      await writeOutbound(
        tx,
        {
          chainKey: ORIGIN_CHAIN,
          block: 1008n,
          txHash: "0xaaa505",
          logIndex: 0,
          observedAt: new Date(),
        },
        {
          route: 0,
          nonce: 505n,
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

    const client: RailClient = {
      rail: "cctp",
      look: (): Promise<RailLookup> =>
        Promise.resolve({
          kind: "found",
          report: {
            status: "delivered",
            railStatus: "complete",
            reference: "provider-reference",
            attestedAt: null,
          },
        }),
    };
    await new RailPass({
      route: 0,
      client,
      db,
      logger,
      batchSize: 10,
      recheckAfterMs: 1000,
      maxCheckFailures: 5,
    }).tick(new AbortController().signal);

    const { rows } = await db.query(
      `SELECT a.status, EXISTS (
         SELECT 1 FROM inbound_delivery d
          WHERE d.source_chain = t.origin_chain
            AND d.route = t.route
            AND d.source_nonce = t.nonce
       ) AS delivered
         FROM rail_attestation a
         JOIN outbound_transfer t ON t.id = a.transfer_id
        WHERE t.nonce = 505 AND t.route = 0`,
    );
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.delivered).toBe(false);
  });
  async function seedRetry(nonce: bigint): Promise<void> {
    await db.transaction(async (tx) => {
      await writeOutbound(
        tx,
        {
          chainKey: ORIGIN_CHAIN,
          block: nonce,
          txHash: `0xretry${nonce}`,
          logIndex: 0,
          observedAt: new Date(),
        },
        {
          route: 0,
          nonce,
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
  }

  it("keeps transient and rate-limit retries out of permanent exhaustion across restarts", async () => {
    await seedRetry(606n);
    const { logger } = capturingLogger();
    let now = new Date();
    let calls = 0;
    const options = {
      route: 0,
      db,
      logger,
      batchSize: 1,
      recheckAfterMs: 1000,
      maxCheckFailures: 1,
      now: () => now,
      client: {
        rail: "cctp",
        look: () => {
          calls += 1;
          return Promise.reject(
            new RailError("cctp", calls % 2 ? "transient" : "rateLimited", "private", 7_200_000),
          );
        },
      },
    };
    for (let i = 0; i < 4; i++) {
      await new RailPass(options).tick(new AbortController().signal);
      const { rows } = await db.query("SELECT * FROM rail_attestation");
      expect(rows[0]?.check_failures).toBe(0);
      expect(rows[0]?.retry_attempts).toBe(i + 1);
      expect(rows[0]?.retry_class).toBe(i % 2 ? "rate_limited" : "transient");
      const next = rows[0]?.next_attempt_at as Date;
      if (i % 2) expect(next.getTime() - now.getTime()).toBe(7_200_000);
      now = new Date(next.getTime());
    }
    expect(calls).toBe(4);
  });

  it("skips a replica's active transfer, then commits its schedule once", async () => {
    await seedRetry(707n);
    await seedRetry(708n);
    const { logger } = capturingLogger();
    let release!: () => void;
    let started!: () => void;
    const active = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: bigint[] = [];
    const options = {
      route: 0,
      db,
      logger,
      batchSize: 1,
      recheckAfterMs: 60_000,
      maxCheckFailures: 5,
      client: {
        rail: "cctp",
        look: async (transfer: PendingTransfer): Promise<RailLookup> => {
          seen.push(transfer.nonce);
          if (transfer.nonce === 707n) {
            started();
            await held;
          }
          return { kind: "missing" };
        },
      },
    };
    const first = new RailPass(options).tick(new AbortController().signal);
    await active;
    try {
      await new RailPass(options).tick(new AbortController().signal);
      expect(seen).toEqual([707n, 708n]);
    } finally {
      release();
      await first;
    }
    await new RailPass(options).tick(new AbortController().signal);
    expect(seen).toEqual([707n, 708n]);
  });

  it("rolls back aborted polling so a restarted worker can retry", async () => {
    await seedRetry(808n);
    const { logger } = capturingLogger();
    const abort = new AbortController();
    await expect(
      new RailPass({
        route: 0,
        db,
        logger,
        batchSize: 1,
        recheckAfterMs: 60_000,
        maxCheckFailures: 5,
        client: {
          rail: "cctp",
          look: (): Promise<RailLookup> => {
            abort.abort();
            return Promise.resolve({ kind: "missing" });
          },
        },
      }).tick(abort.signal),
    ).rejects.toThrow();
    expect((await db.query("SELECT * FROM rail_attestation")).rows).toHaveLength(0);
    expect(
      await pendingForRail(db, {
        route: 0,
        limit: 1,
        now: new Date(),
        notCheckedSince: new Date(),
        maxCheckFailures: 5,
      }),
    ).toHaveLength(1);
  });

  it("does not settle a parked or wrong-recipient destination event", async () => {
    await seedRetry(909n);
    await db.transaction(async (tx) => {
      await writeInbound(
        tx,
        {
          chainKey: DESTINATION_CHAIN,
          block: 2000n,
          txHash: "0xpark909",
          logIndex: 0,
          observedAt: new Date(),
        },
        {
          route: 0,
          sourceChain: ORIGIN_CHAIN,
          sourceNonce: 909n,
          recipient: "0x2222222222222222222222222222222222222222",
          token: "0x3333333333333333333333333333333333333333",
          amount: 1000000n,
          delivered: false,
          claimId: 90n,
          railMessageId: null,
        },
      );
    });
    const query = {
      route: 0,
      limit: 1,
      now: new Date(),
      notCheckedSince: new Date(),
      maxCheckFailures: 5,
    };
    expect((await pendingForRail(db, query))[0]?.delivered).toBe(false);
    await db.query(
      "UPDATE inbound_delivery SET delivered = true, claim_id = NULL, recipient = $1",
      ["0x4444444444444444444444444444444444444444"],
    );
    expect((await pendingForRail(db, query))[0]?.delivered).toBe(false);
  });
});
