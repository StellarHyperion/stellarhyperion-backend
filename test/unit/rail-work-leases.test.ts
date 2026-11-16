import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { AddressKind, encodeStellarAddress } from "@hyperion/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeAttestation, writeOutbound } from "../../src/chains/writers.js";
import type { Queryable, QueryResultRows, Transactional } from "../../src/db/pool.js";
import { bigintOf, integer, text, textOrNull, timestampOrNull } from "../../src/db/rows.js";
import {
  RailLeaseLostError,
  claimPendingForRail,
  commitWithRailLease,
} from "../../src/rails/leases.js";
import { RailPass } from "../../src/rails/pass.js";
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

const STELLAR_SENDER = encodeStellarAddress(AddressKind.Account, new Uint8Array(32).fill(0x41));
const STELLAR_TOKEN = encodeStellarAddress(AddressKind.Contract, new Uint8Array(32).fill(0x52));
const EVM_RECIPIENT = `0x${"00".repeat(12)}${"63".repeat(20)}`;
const EVM_TOKEN = `0x${"74".repeat(20)}`;

describe("database-backed rail work leases (#87)", () => {
  let pg: PGlite;
  let db: Transactional;

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec(migrationUpSql("1790900000000_initial-schema.sql"));
    await pg.exec(migrationUpSql("1791000000000_cursor-block-hash.sql"));
    await pg.exec(migrationUpSql("1791200000000_rail-work-leases.sql"));
    db = pgliteTransactional(pg);
  });

  afterEach(async () => {
    await pg.close();
  });

  async function seedOutbound(nonce: bigint, route = 1): Promise<bigint> {
    await db.transaction(async (tx) => {
      await writeOutbound(
        tx,
        {
          chainKey: "stellar-testnet",
          block: 910_000n + nonce,
          txHash: `${"dd".repeat(30)}${nonce.toString().padStart(4, "0")}`,
          logIndex: null,
          observedAt: new Date("2026-10-14T00:00:00Z"),
        },
        {
          route,
          nonce,
          sender: STELLAR_SENDER,
          token: STELLAR_TOKEN,
          grossAmount: 8_002_000n,
          fee: 2_000n,
          netAmount: 8_000_000n,
          destinationChain: "sepolia",
          destination: EVM_RECIPIENT,
          railRef: null,
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

  it("prevents two workers from claiming the same candidate or committing conflicting decisions", async () => {
    await seedOutbound(1n, 1);
    await seedOutbound(2n, 1);
    await seedOutbound(3n, 1);

    const t0 = new Date("2026-10-14T01:00:00Z");

    const claimedByA = await claimPendingForRail(db, {
      route: 1,
      limit: 2,
      notCheckedSince: new Date("2026-10-14T02:00:00Z"),
      maxCheckFailures: 5,
      owner: "replica-a",
      now: t0,
      leaseDurationMs: 30_000,
    });
    expect(claimedByA.map((item) => item.nonce)).toEqual([1n, 2n]);
    expect(claimedByA[0]?.lease.fencingToken).toBe(1n);

    // Replica B claims while Replica A's leases are active -> skips nonces 1 & 2, gets only nonce 3!
    const claimedByB = await claimPendingForRail(db, {
      route: 1,
      limit: 5,
      notCheckedSince: new Date("2026-10-14T02:00:00Z"),
      maxCheckFailures: 5,
      owner: "replica-b",
      now: new Date("2026-10-14T01:00:05Z"),
      leaseDurationMs: 30_000,
    });
    expect(claimedByB.map((item) => item.nonce)).toEqual([3n]);

    // Replica A stalls past 30s lease window; Replica B reclaims nonce 1 with fencingToken = 2 and commits attested!
    const tExpired = new Date("2026-10-14T01:00:31Z");
    const reclaimedByB = await claimPendingForRail(db, {
      route: 1,
      limit: 1,
      notCheckedSince: new Date("2026-10-14T02:00:00Z"),
      maxCheckFailures: 5,
      owner: "replica-b",
      now: tExpired,
      leaseDurationMs: 30_000,
    });
    expect(reclaimedByB).toHaveLength(1);
    const bItem = reclaimedByB[0];
    expect(bItem).toBeDefined();
    if (bItem === undefined) return;
    expect(bItem.nonce).toBe(1n);
    expect(bItem.lease.fencingToken).toBe(2n);

    await commitWithRailLease(db, bItem.lease, new Date("2026-10-14T01:00:35Z"), async (tx) => {
      await writeAttestation(tx, {
        transferId: bItem.transferId,
        route: 1,
        status: "attested",
        railStatus: "approved",
        railReference: "axelar-canonical-ref-1",
        attestedAt: new Date("2026-10-14T01:00:35Z"),
        checkedAt: new Date("2026-10-14T01:00:35Z"),
        checkFailures: 0,
        lastError: null,
      });
    });

    // Replica A wakes up and attempts to commit a conflicting "failed" status using stale fencingToken = 1
    const staleA = claimedByA[0];
    expect(staleA).toBeDefined();
    if (staleA === undefined) return;

    await expect(
      commitWithRailLease(db, staleA.lease, new Date("2026-10-14T01:00:36Z"), async (tx) => {
        await writeAttestation(tx, {
          transferId: staleA.transferId,
          route: 1,
          status: "failed",
          railStatus: "error",
          railReference: "stale-conflict",
          attestedAt: null,
          checkedAt: new Date("2026-10-14T01:00:36Z"),
          checkFailures: 1,
          lastError: "stale decision",
        });
      }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof RailLeaseLostError && err.reason === "lease_stolen",
    );

    const persisted = await db.query(
      "SELECT status, rail_reference FROM rail_attestation WHERE transfer_id = $1",
      [bItem.transferId.toString()],
    );
    expect(persisted.rows[0]).toEqual({
      status: "attested",
      rail_reference: "axelar-canonical-ref-1",
    });
  });

  it("recovers crashed leases after bounded expiration without losing previously committed progress", async () => {
    const transferId = await seedOutbound(10n, 0);
    const attestedAt = new Date("2026-10-14T02:00:00Z");

    // Initial committed progress before crash
    await writeAttestation(db, {
      transferId,
      route: 0,
      status: "attested",
      railStatus: "complete",
      railReference: "cctp-progress-10",
      attestedAt,
      checkedAt: new Date("2026-10-14T02:00:00Z"),
      checkFailures: 1,
      lastError: null,
    });

    // Crashed worker claims lease at 02:05:00 (expires 02:05:20) and dies without releasing
    const crashedClaim = await claimPendingForRail(db, {
      route: 0,
      limit: 10,
      notCheckedSince: new Date("2026-10-14T02:04:00Z"),
      maxCheckFailures: 5,
      owner: "crashed-pod",
      now: new Date("2026-10-14T02:05:00Z"),
      leaseDurationMs: 20_000,
    });
    expect(crashedClaim).toHaveLength(1);
    expect(crashedClaim[0]?.lease.fencingToken).toBe(1n);

    // Healthy worker polling before 02:05:20 sees 0 eligible transfers
    const tooEarly = await claimPendingForRail(db, {
      route: 0,
      limit: 10,
      notCheckedSince: new Date("2026-10-14T02:04:00Z"),
      maxCheckFailures: 5,
      owner: "healthy-pod",
      now: new Date("2026-10-14T02:05:19Z"),
      leaseDurationMs: 20_000,
    });
    expect(tooEarly).toHaveLength(0);

    // At 02:05:20 bounded lease expires -> healthy worker claims with fencingToken = 2 and intact progress!
    const clock = new Date("2026-10-14T02:05:20Z");
    const { logger } = capturingLogger();
    const observedByHealthy: { status: string | null; failures: number }[] = [];

    const healthyPass = new RailPass({
      route: 0,
      workerId: "healthy-pod",
      leaseDurationMs: 20_000,
      client: {
        rail: "cctp",
        look(transfer: PendingTransfer): Promise<RailLookup> {
          observedByHealthy.push({
            status: transfer.status,
            failures: transfer.checkFailures,
          });
          return Promise.resolve({ kind: "missing" });
        },
      },
      db,
      logger,
      batchSize: 10,
      recheckAfterMs: 30_000,
      maxCheckFailures: 5,
      now: () => clock,
    });

    await healthyPass.tick(new AbortController().signal);
    expect(observedByHealthy).toEqual([{ status: "attested", failures: 1 }]);

    const afterRecovery = await db.query(
      `SELECT status, rail_status, rail_reference, attested_at, check_failures
         FROM rail_attestation
        WHERE transfer_id = $1`,
      [transferId.toString()],
    );
    const row = afterRecovery.rows[0];
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(text(row, "status")).toBe("attested");
    expect(textOrNull(row, "rail_status")).toBe("complete");
    expect(textOrNull(row, "rail_reference")).toBe("cctp-progress-10");
    expect(timestampOrNull(row, "attested_at")?.toISOString()).toBe(attestedAt.toISOString());
    expect(integer(row, "check_failures")).toBe(0);
  });

  it("stops a stale worker that lost its lease from marking delivery or writing inbound_delivery", async () => {
    const transferId = await seedOutbound(20n, 1);

    let clock = new Date("2026-10-14T03:00:00Z");
    const { logger } = capturingLogger();

    const stalePass = new RailPass({
      route: 1,
      workerId: "stale-worker",
      leaseDurationMs: 10_000,
      client: {
        rail: "axelar",
        look(): Promise<RailLookup> {
          return Promise.resolve({
            kind: "found",
            report: {
              status: "attested",
              railStatus: "executed",
              reference: "axelar-20",
              attestedAt: clock,
              execution: {
                txHash: `0x${"88".repeat(32)}`,
                commandId: `0x${"99".repeat(32)}`,
              },
            },
          });
        },
      },
      db,
      logger,
      batchSize: 10,
      recheckAfterMs: 0,
      maxCheckFailures: 5,
      now: () => clock,
      verifyCandidateDelivery: async (transfer, report) => {
        // Simulate stale worker freezing past its 10s lease while another replica steals the lease!
        clock = new Date("2026-10-14T03:00:15Z");
        await claimPendingForRail(db, {
          route: 1,
          limit: 1,
          notCheckedSince: new Date("2026-10-14T03:05:00Z"),
          maxCheckFailures: 5,
          owner: "active-worker",
          now: clock,
          leaseDurationMs: 30_000,
        });

        return {
          at: {
            chainKey: transfer.destinationChain,
            block: 4_444_444n,
            txHash: report.execution?.txHash ?? `0x${"88".repeat(32)}`,
            logIndex: 1,
            observedAt: clock,
          },
          row: {
            route: transfer.route,
            sourceChain: transfer.originChain,
            sourceNonce: transfer.nonce,
            railMessageId: report.execution?.commandId ?? null,
            recipient: EVM_RECIPIENT,
            token: EVM_TOKEN,
            amount: 8_000_000n,
            delivered: true,
            claimId: null,
          },
        };
      },
    });

    await stalePass.tick(new AbortController().signal);

    // Stale worker recorded leaseLoss and did NOT write inbound_delivery or mark delivered!
    expect(stalePass.progress?.leaseLosses).toBe(1);
    expect(stalePass.progress?.settled).toBe(0);

    const inboundRows = await db.query(
      "SELECT count(*)::int AS n FROM inbound_delivery WHERE source_chain = $1 AND source_nonce = 20",
      ["stellar-testnet"],
    );
    expect(integer(inboundRows.rows[0] ?? {}, "n")).toBe(0);

    const attestationRows = await db.query(
      "SELECT status FROM rail_attestation WHERE transfer_id = $1",
      [transferId.toString()],
    );
    expect(attestationRows.rows).toHaveLength(0);
  });
});
