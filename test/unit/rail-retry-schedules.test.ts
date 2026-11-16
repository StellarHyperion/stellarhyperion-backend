import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { AddressKind, encodeStellarAddress } from "@hyperion/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { writeInbound, writeOutbound } from "../../src/chains/writers.js";
import type { Queryable, QueryResultRows, Transactional } from "../../src/db/pool.js";
import { bigintOf } from "../../src/db/rows.js";
import { RailPass } from "../../src/rails/pass.js";
import { readRetrySchedule, recoverTerminalRetrySchedule } from "../../src/rails/queue.js";
import { RailError, type PendingTransfer, type RailLookup } from "../../src/rails/types.js";
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

const STELLAR_SENDER = encodeStellarAddress(AddressKind.Account, new Uint8Array(32).fill(0x61));
const STELLAR_TOKEN = encodeStellarAddress(AddressKind.Contract, new Uint8Array(32).fill(0x72));
const EVM_RECIPIENT = `0x${"00".repeat(12)}${"83".repeat(20)}`;
const GROSS_U256 = 777777777777777777777777777777n;
const FEE_U256 = 777777777777777777777777n;
const NET_U256 = GROSS_U256 - FEE_U256;

describe("durable per-transfer rail retry schedules (#85)", () => {
  let pg: PGlite;
  let db: Transactional;

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(migrationUpSql("1790900000000_initial-schema.sql"));
    await pg.exec(migrationUpSql("1791000000000_cursor-block-hash.sql"));
    await pg.exec(migrationUpSql("1791200000000_rail-retry-schedules.sql"));
    db = pgliteTransactional(pg);
  });

  beforeEach(async () => {
    await db.query("DELETE FROM inbound_delivery");
    await db.query("DELETE FROM outbound_transfer");
  });

  afterAll(async () => {
    await pg.close();
  });

  async function seedOutbound(nonce: bigint, route = 0): Promise<bigint> {
    await db.transaction(async (tx) => {
      await writeOutbound(
        tx,
        {
          chainKey: "stellar-testnet",
          block: 610_000n + nonce,
          txHash: `${"ef".repeat(30)}${nonce.toString().padStart(4, "0")}`,
          logIndex: null,
          observedAt: new Date("2026-10-18T00:00:00Z"),
        },
        {
          route,
          nonce,
          sender: STELLAR_SENDER,
          token: STELLAR_TOKEN,
          grossAmount: GROSS_U256,
          fee: FEE_U256,
          netAmount: NET_U256,
          destinationChain: "sepolia",
          destination: EVM_RECIPIENT,
          railRef: `0x${"11".repeat(32)}`,
        },
      );
    });
    const res = await db.query(
      "SELECT id FROM outbound_transfer WHERE origin_chain = $1 AND nonce = $2",
      ["stellar-testnet", nonce.toString()],
    );
    const row = res.rows[0];
    if (row === undefined) throw new Error("failed to seed outbound_transfer");
    return bigintOf(row, "id");
  }

  it("persists transient and rate-limited retry schedules across worker restarts without retry storms", async () => {
    const t1 = await seedOutbound(1n, 0);
    const t2 = await seedOutbound(2n, 0);

    const t0 = new Date("2026-10-18T01:00:00Z");
    let clock = t0;
    const { logger } = capturingLogger();

    let lookups = 0;
    const makeWorkerPass = (mode: "transient" | "rateLimited" | "ok") =>
      new RailPass({
        route: 0,
        client: {
          rail: "cctp",
          look(_transfer: PendingTransfer): Promise<RailLookup> {
            lookups += 1;
            if (mode === "transient") {
              return Promise.reject(new RailError("cctp", "transient", "http 503 upstream"));
            }
            if (mode === "rateLimited") {
              return Promise.reject(new RailError("cctp", "rateLimited", "429 block", 300_000));
            }
            return Promise.resolve({ kind: "missing" });
          },
        },
        db,
        logger,
        batchSize: 10,
        recheckAfterMs: 1_000, // Small recheck window to prove next_attempt_at governs!
        maxCheckFailures: 5,
        now: () => clock,
        retryPolicy: {
          baseBackoffMs: 15_000,
          maxBackoffMs: 120_000,
        },
      });

    // Worker 1 fails transiently on both transfers -> next_attempt_at = t0 + 15s
    await makeWorkerPass("transient").tick(new AbortController().signal);
    expect(lookups).toBe(2);

    const s1 = await readRetrySchedule(db, t1);
    expect(s1?.retryClass).toBe("transient_provider");
    expect(s1?.nextAttemptAt?.toISOString()).toBe("2026-10-18T01:00:15.000Z");

    // Process restarts 3 seconds later (past 1s recheckAfterMs, BEFORE 15s durable backoff!):
    // Brand-new RailPass instance makes ZERO requests (no retry storm!)
    clock = new Date("2026-10-18T01:00:03Z");
    await makeWorkerPass("ok").tick(new AbortController().signal);
    expect(lookups).toBe(2);

    // At 01:00:15 durable backoff expires -> Worker 2 attempts and hits 429 rate limit (5m = 300s)
    clock = new Date("2026-10-18T01:00:15Z");
    await makeWorkerPass("rateLimited").tick(new AbortController().signal);
    expect(lookups).toBe(3); // Halted on first transfer and persisted rate_limited on remaining batch!

    const s1Rate = await readRetrySchedule(db, t1);
    const s2Rate = await readRetrySchedule(db, t2);
    expect(s1Rate?.retryClass).toBe("rate_limited");
    expect(s2Rate?.retryClass).toBe("rate_limited");
    expect(s1Rate?.nextAttemptAt?.toISOString()).toBe("2026-10-18T01:05:15.000Z");

    // Another process restart 30s later (in-memory cooldown gone, but durable DB schedule blocks storm!)
    clock = new Date("2026-10-18T01:00:45Z");
    await makeWorkerPass("ok").tick(new AbortController().signal);
    expect(lookups).toBe(3);

    // After 5m cooldown expires, restarted worker resumes cleanly
    clock = new Date("2026-10-18T01:05:15Z");
    await makeWorkerPass("ok").tick(new AbortController().signal);
    expect(lookups).toBe(5);
  });

  it("halts terminal_evidence failures until explicit operator recovery and preserves intent and proof rules", async () => {
    const transferId = await seedOutbound(50n, 1);

    let clock = new Date("2026-10-18T02:00:00Z");
    const { logger } = capturingLogger();
    let lookupCount = 0;
    let shouldFailPermanent = true;

    const pass = new RailPass({
      route: 1,
      client: {
        rail: "axelar",
        look(): Promise<RailLookup> {
          lookupCount += 1;
          if (shouldFailPermanent) {
            return Promise.reject(
              new RailError("axelar", "permanent", "unsupported source domain parameter"),
            );
          }
          // Even when provider says executed, status maps to attested (never delivered without proof!)
          return Promise.resolve({
            kind: "found",
            report: {
              status: "attested",
              railStatus: "executed",
              reference: "0xmsg50-0",
              attestedAt: clock,
            },
          });
        },
      },
      db,
      logger,
      batchSize: 10,
      recheckAfterMs: 1_000,
      maxCheckFailures: 5,
      now: () => clock,
    });

    await pass.tick(new AbortController().signal);
    expect(lookupCount).toBe(1);

    const halted = await readRetrySchedule(db, transferId);
    expect(halted?.retryClass).toBe("terminal_evidence");
    expect(halted?.nextAttemptAt).toBeNull();

    // Even 2 hours later, automatic polling will NOT touch a terminal_evidence transfer
    shouldFailPermanent = false;
    clock = new Date("2026-10-18T04:00:00Z");
    await pass.tick(new AbortController().signal);
    expect(lookupCount).toBe(1);

    // Explicit operator recovery with scheduled next_attempt_at 10 minutes in the future
    const scheduledRecoveryTime = new Date("2026-10-18T04:10:00Z");
    const recovered = await recoverTerminalRetrySchedule(db, {
      transferId,
      reviewedBy: "ops-frank",
      reason: "Chain registry updated for lane",
      now: clock,
      scheduleAt: scheduledRecoveryTime,
    });
    expect(recovered).toEqual({
      kind: "recovered",
      transferId,
      priorStatus: "pending",
      priorRetryClass: "terminal_evidence",
      newStatus: "pending",
      newRetryClass: "awaiting_index",
      nextAttemptAt: scheduledRecoveryTime,
      recoveryNote: "ops-frank: Chain registry updated for lane",
    });

    //Refuses recovery when transfer is already active (not terminal_evidence)
    const duplicateRecovery = await recoverTerminalRetrySchedule(db, {
      transferId,
      reviewedBy: "ops-frank",
      reason: "Second attempt while active",
      now: clock,
    });
    expect(duplicateRecovery.kind).toBe("refused");

    // Before scheduledRecoveryTime (04:05:00), still waiting; at 04:10:00, polled -> attested (awaiting_delivery_proof)!
    clock = new Date("2026-10-18T04:05:00Z");
    await pass.tick(new AbortController().signal);
    expect(lookupCount).toBe(1);

    clock = scheduledRecoveryTime;
    await pass.tick(new AbortController().signal);
    expect(lookupCount).toBe(2);

    const afterPoll = await readRetrySchedule(db, transferId);
    expect(afterPoll?.status).toBe("attested");
    expect(afterPoll?.retryClass).toBe("awaiting_delivery_proof");

    // Source transfer intent in outbound_transfer is 100% unchanged!
    const outboundCheck = await db.query(
      `SELECT sender, token, gross_amount::text AS gross_amount, fee::text AS fee,
              net_amount::text AS net_amount, destination_chain, destination
         FROM outbound_transfer
        WHERE id = $1`,
      [transferId.toString()],
    );
    expect(outboundCheck.rows[0]).toEqual({
      sender: STELLAR_SENDER,
      token: STELLAR_TOKEN,
      gross_amount: GROSS_U256.toString(),
      fee: FEE_U256.toString(),
      net_amount: NET_U256.toString(),
      destination_chain: "sepolia",
      destination: EVM_RECIPIENT,
    });

    // Only canonical destination inbound_delivery settles the transfer to delivered/settled!
    await db.transaction(async (tx) => {
      await writeInbound(
        tx,
        {
          chainKey: "sepolia",
          block: 8_888_888n,
          txHash: `0x${"ab".repeat(32)}`,
          logIndex: 0,
          observedAt: clock,
        },
        {
          route: 1,
          sourceChain: "stellar-testnet",
          sourceNonce: 50n,
          railMessageId: "0xmsg50-0",
          recipient: EVM_RECIPIENT,
          token: `0x${"22".repeat(20)}`,
          amount: NET_U256,
          delivered: true,
          claimId: null,
        },
      );
    });

    await pass.tick(new AbortController().signal);
    const finalSchedule = await readRetrySchedule(db, transferId);
    expect(finalSchedule?.status).toBe("delivered");
    expect(finalSchedule?.retryClass).toBe("settled");
    expect(finalSchedule?.nextAttemptAt).toBeNull();
  });
});
