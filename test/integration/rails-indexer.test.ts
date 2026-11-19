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
import { requeueTerminalTransfer } from "../../src/rails/requeue.js";
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
    await db.query("DELETE FROM rail_requeue_audit WHERE route IN (0, 1)");
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
  it("requeues an expired transfer with its original identity and records the review", async () => {
    const { logger } = capturingLogger();
    const nonce = 18446744073709551615n;
    const amount = 100000000000000000000000000000000000000n;
    const transfer = {
      chainKey: ORIGIN_CHAIN,
      block: 1009n,
      txHash: "0xaaa606",
      logIndex: 0,
      observedAt: new Date(),
    };
    const outbound = {
      route: 0,
      nonce,
      sender: "0x1111111111111111111111111111111111111111",
      token: "0x3333333333333333333333333333333333333333",
      grossAmount: amount + 1_000n,
      fee: 1_000n,
      netAmount: amount,
      destinationChain: DESTINATION_CHAIN,
      destination: "0x2222222222222222222222222222222222222222",
      railRef: "0xrail-reference",
    };
    await db.transaction(async (tx) => {
      await writeOutbound(tx, transfer, outbound);
    });

    const seeded = await db.query(
      "SELECT id FROM outbound_transfer WHERE origin_chain = $1 AND nonce = $2",
      [ORIGIN_CHAIN, nonce.toString()],
    );
    const transferId = BigInt(String(seeded.rows[0]?.id));
    await db.query(
      `INSERT INTO rail_attestation
         (transfer_id, route, status, rail_status, rail_reference, check_failures,
          last_error, retry_class, next_attempt_at)
       VALUES ($1, 0, 'expired', 'timeout', 'old-rail-ref', 5,
               'generic lookup failure', 'exhausted', NULL)`,
      [transferId.toString()],
    );

    const result = await requeueTerminalTransfer(db, {
      transferId,
      reviewedBy: "rail-operator",
      reason: "Provider evidence became available",
    });
    expect(result).toEqual({ transferId, route: 0, priorStatus: "expired" });

    const identity = await db.query(
      `SELECT origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
              destination_chain, destination, origin_tx
         FROM outbound_transfer WHERE id = $1`,
      [transferId.toString()],
    );
    expect(identity.rows[0]).toMatchObject({
      origin_chain: ORIGIN_CHAIN,
      route: 0,
      nonce: nonce.toString(),
      sender: outbound.sender,
      token: outbound.token,
      gross_amount: outbound.grossAmount.toString(),
      fee: outbound.fee.toString(),
      net_amount: amount.toString(),
      destination_chain: DESTINATION_CHAIN,
      destination: outbound.destination,
      origin_tx: transfer.txHash,
    });

    const audit = await db.query(
      `SELECT origin_chain, nonce, prior_status, new_status, reviewed_by, reviewed_reason
         FROM rail_requeue_audit WHERE transfer_id = $1`,
      [transferId.toString()],
    );
    expect(audit.rows).toEqual([
      {
        origin_chain: ORIGIN_CHAIN,
        nonce: nonce.toString(),
        prior_status: "expired",
        new_status: "pending",
        reviewed_by: "rail-operator",
        reviewed_reason: "Provider evidence became available",
      },
    ]);

    const client: RailClient = {
      rail: "cctp",
      look: (candidate): Promise<RailLookup> => {
        expect(candidate.transferId).toBe(transferId);
        expect(candidate.nonce).toBe(nonce);
        expect(candidate.originChain).toBe(ORIGIN_CHAIN);
        expect(candidate.originTx).toBe(transfer.txHash);
        return Promise.resolve({
          kind: "found",
          report: {
            status: "attested",
            railStatus: "complete",
            reference: "new-rail-ref",
            attestedAt: new Date(),
          },
        });
      },
    };
    const pass = new RailPass({
      route: 0,
      client,
      db,
      logger,
      batchSize: 10,
      recheckAfterMs: 1_000,
      maxCheckFailures: 5,
    });
    await pass.evaluateTransfer(transferId);
    const status = await db.query(
      "SELECT status, rail_reference FROM rail_attestation WHERE transfer_id = $1",
      [transferId.toString()],
    );
    expect(status.rows[0]).toMatchObject({ status: "attested", rail_reference: "new-rail-ref" });
    await expect(
      requeueTerminalTransfer(db, {
        transferId,
        reviewedBy: "rail-operator",
        reason: "Repeated requeue must not reopen an active transfer",
      }),
    ).rejects.toMatchObject({ kind: "not_terminal" });
  });

  it("refuses to requeue a failed transfer after destination evidence is indexed", async () => {
    const transferId = 607n;
    await db.transaction(async (tx) => {
      await writeOutbound(
        tx,
        {
          chainKey: ORIGIN_CHAIN,
          block: 1010n,
          txHash: "0xaaa607",
          logIndex: 0,
          observedAt: new Date(),
        },
        {
          route: 0,
          nonce: transferId,
          sender: "0x1111111111111111111111111111111111111111",
          token: "0x3333333333333333333333333333333333333333",
          grossAmount: 1001000n,
          fee: 1000n,
          netAmount: 1000000n,
          destinationChain: DESTINATION_CHAIN,
          destination: "0x2222222222222222222222222222222222222222",
          railRef: "0xrail-607",
        },
      );
      await writeInbound(
        tx,
        {
          chainKey: DESTINATION_CHAIN,
          block: 2010n,
          txHash: "0xdest607",
          logIndex: 0,
          observedAt: new Date(),
        },
        {
          route: 0,
          sourceChain: ORIGIN_CHAIN,
          sourceNonce: transferId,
          recipient: "0x2222222222222222222222222222222222222222",
          token: "0x3333333333333333333333333333333333333333",
          amount: 1000000n,
          delivered: true,
          claimId: null,
          railMessageId: "0xmsg607",
        },
      );
    });
    const seeded = await db.query(
      "SELECT id FROM outbound_transfer WHERE origin_chain = $1 AND nonce = $2",
      [ORIGIN_CHAIN, transferId.toString()],
    );
    const id = BigInt(String(seeded.rows[0]?.id));
    await db.query(
      "INSERT INTO rail_attestation (transfer_id, route, status) VALUES ($1, 0, 'failed')",
      [id.toString()],
    );

    await expect(
      requeueTerminalTransfer(db, {
        transferId: id,
        reviewedBy: "rail-operator",
        reason: "Do not repeat a confirmed payout",
      }),
    ).rejects.toMatchObject({ kind: "already_delivered" });
    const status = await db.query("SELECT status FROM rail_attestation WHERE transfer_id = $1", [
      id.toString(),
    ]);
    expect(status.rows[0]?.status).toBe("failed");
    const audit = await db.query("SELECT id FROM rail_requeue_audit WHERE transfer_id = $1", [
      id.toString(),
    ]);
    expect(audit.rows).toHaveLength(0);
  });
  it("audits held evidence recovery exactly once under concurrent operator requests", async () => {
    await seedRetry(1001n);
    const id = String(
      (await db.query("SELECT id FROM outbound_transfer WHERE nonce = 1001")).rows[0]?.id,
    );
    await db.query(
      `INSERT INTO rail_attestation
      (transfer_id, route, status, check_failures, retry_attempts, retry_class)
      VALUES ($1, 0, 'pending', 5, 30, 'exhausted')`,
      [id],
    );
    const request = {
      transferId: BigInt(id),
      reviewedBy: "operator",
      reason: "Source evidence corrected",
    };
    const results = await Promise.allSettled([
      requeueTerminalTransfer(db, request),
      requeueTerminalTransfer(db, request),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const row = (await db.query("SELECT * FROM rail_attestation WHERE transfer_id = $1", [id]))
      .rows[0];
    expect(row).toMatchObject({
      status: "pending",
      check_failures: 0,
      retry_attempts: 0,
      retry_class: null,
    });
    const audit = (await db.query("SELECT * FROM rail_requeue_audit WHERE transfer_id = $1", [id]))
      .rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      prior_status: "pending",
      prior_retry_class: "exhausted",
      reviewed_by: "operator",
    });
  });

  it("immediate evaluation respects future schedules and replica ownership", async () => {
    await seedRetry(1002n);
    const id = BigInt(
      String((await db.query("SELECT id FROM outbound_transfer WHERE nonce = 1002")).rows[0]?.id),
    );
    await db.query(
      `INSERT INTO rail_attestation (transfer_id, route, status, next_attempt_at)
      VALUES ($1, 0, 'pending', now() + interval '1 hour')`,
      [id.toString()],
    );
    const { logger } = capturingLogger();
    let calls = 0;
    const options = {
      route: 0,
      db,
      logger,
      batchSize: 1,
      recheckAfterMs: 60_000,
      maxCheckFailures: 5,
      client: {
        rail: "cctp",
        look: (): Promise<RailLookup> => {
          calls += 1;
          return Promise.resolve({ kind: "missing" });
        },
      },
    };
    expect(await new RailPass(options).evaluateTransfer(id)).toBe(false);
    expect(calls).toBe(0);
    await db.query("UPDATE rail_attestation SET next_attempt_at = now() WHERE transfer_id = $1", [
      id.toString(),
    ]);
    await db.transaction(async (tx) => {
      await tx.query("SELECT id FROM outbound_transfer WHERE id = $1 FOR UPDATE", [id.toString()]);
      expect(await new RailPass(options).evaluateTransfer(id)).toBe(false);
      expect(calls).toBe(0);
    });
    await new RailPass(options).evaluateTransfer(id);
    expect(calls).toBe(1);
  });
});
