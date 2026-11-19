import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  readEvmFinalityPolicyChanges,
  recordEvmScanProvenance,
  readLatestEvmScanProvenance,
} from "../../src/chains/evm/store.js";
import { EvmWatcher } from "../../src/chains/evm/watcher.js";
import {
  auditTransferAndClaimInvariants,
  acquireLease,
  assertLeaseHeld,
  compactRouteHealthSamples,
  settleClaim,
  writeAttestation,
  writeClaim,
  writeHealthSample,
  writeInbound,
  writeOutbound,
} from "../../src/chains/writers.js";
import type { Queryable, Transactional } from "../../src/db/pool.js";
import {
  ANVIL_CHAIN_ID,
  ANVIL_HEAD,
  ANVIL_ROUTER,
  ANVIL_START_BLOCK,
  FakeEvmClient,
} from "../evm-fakes.js";
import { capturingLogger } from "../stellar-fakes.js";

const MIGRATIONS = [
  "1790900000000_initial-schema.sql",
  "1791000000000_cursor-block-hash.sql",
  "1791100000000_cursor-autovacuum-tuning.sql",
  "1791300000000_stellar-durable-scan-evidence.sql",
  "1791400000000_stellar-cursor-cas-leases-gaps.sql",
  "1791500000000_stellar-revisions-and-quarantine.sql",
  "1791600000000_durable-rail-retry-schedules.sql",
  "1791700000000_rail-requeue-audit.sql",
  "1791800000000_outbound-router-identity.sql",
  "1791900000000_evm-log-quarantine.sql",
  "1792000000000_evm-backfill-jobs.sql",
  "1792100000000_route-health-compaction-and-audits.sql",
  "1792200000000_evm-scan-provenance.sql",
  "1792800000000_cctp-verification-failure-reasons.sql",
] as const;

function makePgliteDb(pg: PGlite): Transactional {
  const runQuery = async (
    executor: Pick<PGlite, "query">,
    sql: string,
    params: readonly unknown[] = [],
  ) => {
    const result = await executor.query(sql, [...params]);
    const int8 = result.fields
      .filter((field) => field.dataTypeID === 20)
      .map((field) => field.name);
    const rows = result.rows.map((raw) => {
      const row = { ...(raw as Record<string, unknown>) };
      for (const column of int8) {
        const value = row[column];
        if (typeof value === "number" || typeof value === "bigint") row[column] = String(value);
      }
      return row;
    });
    return { rows, rowCount: result.affectedRows ?? result.rows.length };
  };

  return {
    query: (sql, params = []) => runQuery(pg, sql, params),
    transaction: async <T>(work: (tx: Queryable) => Promise<T>): Promise<T> => {
      return pg.transaction(async (tx) =>
        work({
          query: (sql, params = []) => runQuery(tx, sql, params),
        }),
      );
    },
  };
}

describe("PostgreSQL compaction, invariant audits, EVM leases and finality provenance", () => {
  const pg = new PGlite();
  const db = makePgliteDb(pg);

  beforeAll(async () => {
    for (const name of MIGRATIONS) {
      const sql = readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8").split(
        "-- Down Migration",
      )[0]!;
      await pg.exec(sql);
    }
  });

  afterAll(async () => {
    await pg.close();
  });

  beforeEach(async () => {
    await pg.exec(`
      TRUNCATE TABLE
        rail_attestation,
        outbound_transfer,
        inbound_delivery,
        pending_claim,
        admin_action,
        route_health,
        indexer_cursor,
        indexer_lease,
        evm_scan_provenance
      RESTART IDENTITY CASCADE;
    `);
  });

  it("records a weaker evidence policy without changing any previous scan", async () => {
    const entry = {
      chainKey: "sepolia",
      contract: ANVIL_ROUTER,
      chainId: ANVIL_CHAIN_ID,
      fromBlock: 1n,
      toBlock: 10n,
      endBlockHash: "0x" + "1".repeat(64),
      headBlock: 100n,
      logsWritten: 0,
      logsIgnored: 0,
      reorgDetected: false,
      ownerId: "worker",
    };
    await recordEvmScanProvenance(db, {
      ...entry,
      policy: { confirmations: 3, reorgDepth: 5, finalityMode: "finalized" },
      evidenceKind: "finalized",
      finalizedBlock: 10n,
      finalizedHash: entry.endBlockHash,
    });
    await recordEvmScanProvenance(db, {
      ...entry,
      fromBlock: 11n,
      toBlock: 20n,
      policy: { confirmations: 3, reorgDepth: 5, finalityMode: "confirmations" },
    });
    const changes = await readEvmFinalityPolicyChanges(db, "sepolia", ANVIL_ROUTER);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      previousFinalityMode: "finalized",
      finalityMode: "confirmations",
    });
    const { rows } = await db.query(
      "SELECT evidence_kind, finalized_block FROM evm_scan_provenance ORDER BY id",
    );
    expect(rows).toEqual([
      { evidence_kind: "finalized", finalized_block: "10" },
      { evidence_kind: "confirmations", finalized_block: null },
    ]);
  });

  it("allows a crashed owner's expired lease to be replaced and rejects its old ownership", async () => {
    const deployment = { chainKey: "sepolia", contract: ANVIL_ROUTER, ttlMs: 30_000 };
    expect(await acquireLease(db, { ...deployment, ownerId: "crashed-owner" })).not.toBeNull();
    expect(await acquireLease(db, { ...deployment, ownerId: "replacement" })).toBeNull();
    await db.query(
      "UPDATE indexer_lease SET lease_until = clock_timestamp() - interval '1 second'",
    );
    expect(await acquireLease(db, { ...deployment, ownerId: "replacement" })).not.toBeNull();
    await expect(assertLeaseHeld(db, { ...deployment, ownerId: "crashed-owner" })).rejects.toThrow(
      "watcher lease lost",
    );
    await expect(
      assertLeaseHeld(db, { ...deployment, ownerId: "replacement" }),
    ).resolves.toBeUndefined();
  });

  it("audits exact source identities when different deployments reuse a nonce", async () => {
    const at = {
      chainKey: "sepolia",
      block: 1n,
      txHash: "source-one",
      logIndex: 0,
      observedAt: new Date(),
    };
    const row = {
      route: 0,
      nonce: 7n,
      sender: "sender",
      token: "USDC",
      grossAmount: 100n,
      fee: 0n,
      netAmount: 100n,
      destinationChain: "stellar-testnet",
      destination: "recipient",
      railRef: null,
    };
    await writeOutbound(db, { ...at, router: "router-one" }, row);
    await writeOutbound(
      db,
      { ...at, router: "router-two", txHash: "source-two" },
      { ...row, grossAmount: 200n, netAmount: 200n },
    );
    const { rows } = await db.query("SELECT id FROM outbound_transfer ORDER BY id");
    const first = BigInt(String(rows[0]?.id));
    const second = BigInt(String(rows[1]?.id));
    await writeInbound(
      db,
      { ...at, chainKey: "stellar-testnet", txHash: "destination-proof" },
      {
        sourceTransferId: first,
        route: 0,
        sourceChain: "sepolia",
        sourceNonce: 7n,
        railMessageId: null,
        recipient: "recipient",
        token: "USDC",
        amount: 90n,
        delivered: true,
        claimId: null,
      },
    );
    for (const transferId of [first, second]) {
      await writeAttestation(db, {
        transferId,
        route: 0,
        status: "delivered",
        railStatus: "delivered",
        railReference: "provider-reference",
        attestedAt: new Date(),
        checkedAt: new Date(),
        checkFailures: 0,
        lastError: null,
        retryAttempts: 0,
        nextAttemptAt: null,
        retryClass: null,
      });
    }
    const report = await auditTransferAndClaimInvariants(db);
    expect(report.sourceAmountViolations).toHaveLength(1);
    expect(report.sourceAmountViolations[0]).toMatchObject({
      rowId: first.toString(),
      router: "router-one",
      expectedAmount: "100",
      actualAmount: "90",
    });
    expect(report.deliverySettlementViolations).toEqual([
      {
        kind: "delivered_attestation_without_inbound",
        chainKey: "sepolia",
        referenceId: second.toString(),
        detail: "rail_attestation status is delivered without a corresponding inbound_delivery",
      },
    ]);
  });

  it("#61 compacts old identical route_health samples in bounded batches while preserving change boundaries and recent samples", async () => {
    const now = Date.now();
    const hoursAgo = (h: number) => new Date(now - h * 3600 * 1000);

    // 5 identical old samples (100h..96h ago) -> state change at 95h -> 2 identical at 94h..93h -> recent at 2h, 1h
    const samples: { at: Date; available: boolean; blocker: number; flow: bigint }[] = [
      { at: hoursAgo(100), available: true, blocker: 0, flow: 1000n },
      { at: hoursAgo(99), available: true, blocker: 0, flow: 1000n },
      { at: hoursAgo(98), available: true, blocker: 0, flow: 1000n },
      { at: hoursAgo(97), available: true, blocker: 0, flow: 1000n },
      { at: hoursAgo(96), available: true, blocker: 0, flow: 1000n },
      { at: hoursAgo(95), available: false, blocker: 1, flow: 0n },
      { at: hoursAgo(94), available: false, blocker: 1, flow: 0n },
      { at: hoursAgo(93), available: false, blocker: 1, flow: 0n },
      { at: hoursAgo(2), available: false, blocker: 1, flow: 0n },
      { at: hoursAgo(1), available: false, blocker: 1, flow: 0n },
    ];

    for (const [idx, s] of samples.entries()) {
      await writeHealthSample(
        db,
        {
          chainKey: "sepolia",
          block: BigInt(idx + 1),
          txHash: `0x${String(idx + 1).padStart(64, "0")}`,
          logIndex: 0,
          observedAt: s.at,
        },
        {
          originChain: "sepolia",
          destinationChain: "stellar-testnet",
          route: 0,
          token: "USDC",
          available: s.available,
          blocker: s.blocker,
          flowAvailable: s.flow,
        },
      );
    }

    // Bounded batch of 2 deletes only 2 interior rows from the first run
    const pass1 = await compactRouteHealthSamples(db, { retainRecentHours: 24, batchSize: 2 });
    expect(pass1.deleted).toBe(2);

    // Second pass deletes remaining interior duplicates (1 from first run, 2 from second run)
    const pass2 = await compactRouteHealthSamples(db, { retainRecentHours: 24, batchSize: 10 });
    expect(pass2.deleted).toBe(3);

    // Third pass is a no-op
    const pass3 = await compactRouteHealthSamples(db, { retainRecentHours: 24, batchSize: 10 });
    expect(pass3.deleted).toBe(0);

    const { rows } = await db.query(
      "SELECT sampled_at, available, blocker, flow_available FROM route_health ORDER BY sampled_at ASC, id ASC",
    );
    // Remaining: 100h (start), 96h (end of first run), 95h (change boundary), 2h & 1h (recent diagnostic detail)
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.available)).toEqual([true, true, false, false, false]);
  });

  it("#59 audits source amount conservation, claim liabilities, and delivery/settlement consistency", async () => {
    const t0 = new Date("2026-10-01T12:00:00.000Z");
    await writeOutbound(
      db,
      { chainKey: "sepolia", block: 10n, txHash: "0xtx1", logIndex: 0, observedAt: t0 },
      {
        route: 0,
        nonce: 1n,
        sender: "0xsender",
        token: "0xusdc",
        grossAmount: 1_000_000n,
        fee: 3_000n,
        netAmount: 997_000n,
        destinationChain: "stellar-testnet",
        destination: "GA5ZYIIV",
        railRef: null,
      },
    );

    // Parked delivery + matching pending_claim
    await writeInbound(
      db,
      { chainKey: "stellar-testnet", block: 20n, txHash: "stx1", logIndex: null, observedAt: t0 },
      {
        route: 0,
        sourceChain: "sepolia",
        sourceNonce: 1n,
        railMessageId: null,
        recipient: "GA5ZYIIV",
        token: "CUSDC",
        amount: 997_000n,
        delivered: false,
        claimId: 7n,
      },
    );
    await writeClaim(
      db,
      { chainKey: "stellar-testnet", block: 20n, txHash: "stx1", logIndex: null, observedAt: t0 },
      {
        claimId: 7n,
        recipient: "GA5ZYIIV",
        token: "CUSDC",
        amount: 997_000n,
        route: 0,
        sourceChain: "sepolia",
        sourceNonce: 1n,
        createdAt: t0,
      },
    );

    const clean = await auditTransferAndClaimInvariants(db);
    expect(clean.ok).toBe(true);
    expect(clean.unsettledLiabilities).toEqual([
      {
        chainKey: "stellar-testnet",
        token: "CUSDC",
        openCount: 1,
        totalAmount: "997000",
      },
    ]);

    // Introduce a second outbound transfer whose attestation claims 'delivered' with NO inbound_delivery
    await writeOutbound(
      db,
      { chainKey: "sepolia", block: 11n, txHash: "0xtx2", logIndex: 0, observedAt: t0 },
      {
        route: 0,
        nonce: 2n,
        sender: "0xsender",
        token: "0xusdc",
        grossAmount: 500_000n,
        fee: 1_000n,
        netAmount: 499_000n,
        destinationChain: "stellar-testnet",
        destination: "GA5ZYIIV",
        railRef: null,
      },
    );
    const { rows: transferRows } = await db.query(
      "SELECT id FROM outbound_transfer WHERE origin_chain = 'sepolia' AND nonce = 2",
    );
    await writeAttestation(db, {
      transferId: BigInt(String(transferRows[0]?.id)),
      route: 0,
      status: "delivered",
      railStatus: "complete",
      railReference: "ref-2",
      attestedAt: t0,
      checkedAt: t0,
      checkFailures: 0,
      retryAttempts: 0,
      nextAttemptAt: null,
      retryClass: null,
      lastError: null,
    });

    // Settle claim 7 cleanly
    const settled = await settleClaim(
      db,
      { chainKey: "stellar-testnet", block: 25n, txHash: "stx2", logIndex: null, observedAt: t0 },
      7n,
      "GKEEPER",
    );
    expect(settled).toBe(true);

    // Introduce a mismatched inbound_delivery amount on nonce 2
    await writeInbound(
      db,
      { chainKey: "stellar-testnet", block: 26n, txHash: "stx3", logIndex: null, observedAt: t0 },
      {
        route: 0,
        sourceChain: "sepolia",
        sourceNonce: 2n,
        railMessageId: null,
        recipient: "GA5ZYIIV",
        token: "CUSDC",
        amount: 400_000n, // mismatch vs 499_000n
        delivered: true,
        claimId: null,
      },
    );

    const dirty = await auditTransferAndClaimInvariants(db);
    expect(dirty.ok).toBe(false);
    expect(dirty.sourceAmountViolations).toHaveLength(1);
    expect(dirty.sourceAmountViolations[0]?.kind).toBe("inbound_amount_mismatch");
    expect(dirty.unsettledLiabilities).toEqual([]);

    // Remove inbound_delivery for nonce 2 to verify 'delivered' attestation without inbound_delivery is flagged
    await db.query("DELETE FROM inbound_delivery WHERE source_nonce = 2");
    const unbacked = await auditTransferAndClaimInvariants(db);
    expect(unbacked.ok).toBe(false);
    expect(unbacked.deliverySettlementViolations.map((v) => v.kind)).toContain(
      "delivered_attestation_without_inbound",
    );
  });

  it("#47 & #46 record EVM finality-policy provenance, expose policy changes, and coordinate via leases", async () => {
    const { logger } = capturingLogger();
    const client = new FakeEvmClient({ head: ANVIL_HEAD });

    const watcherA = new EvmWatcher({
      chainKey: "sepolia",
      router: ANVIL_ROUTER,
      chainId: ANVIL_CHAIN_ID,
      startBlock: ANVIL_START_BLOCK,
      confirmations: 3,
      reorgDepth: 5,
      logRange: 2_000,
      ownerId: "watcher-a",
      leaseTtlMs: 30_000,
      client,
      db,
      logger,
    });

    const watcherB = new EvmWatcher({
      chainKey: "sepolia",
      router: ANVIL_ROUTER,
      chainId: ANVIL_CHAIN_ID,
      startBlock: ANVIL_START_BLOCK,
      confirmations: 1,
      reorgDepth: 8,
      logRange: 2_000,
      ownerId: "watcher-b",
      leaseTtlMs: 30_000,
      client,
      db,
      logger,
    });

    // Watcher A acquires lease and commits scan with policy (confirmations=3, reorgDepth=5)
    await watcherA.tick(AbortSignal.timeout(5_000));
    const prov1 = await readLatestEvmScanProvenance(db, "sepolia", ANVIL_ROUTER);
    expect(prov1).not.toBeNull();
    expect(prov1?.confirmations).toBe(3);
    expect(prov1?.reorgDepth).toBe(5);
    expect(prov1?.policyChanged).toBe(false);
    expect(prov1?.ownerId).toBe("watcher-a");

    // Watcher B cannot acquire lease while Watcher A holds it
    const bRan = await watcherB.tick(AbortSignal.timeout(5_000));
    expect(bRan).toBe(false);
    expect(watcherB.progress).toBeNull();

    // Watcher A releases lease; reset cursor to re-scan with Watcher B's different finality policy
    expect(await watcherA.release()).toBe(true);
    await db.query("DELETE FROM indexer_cursor WHERE chain_key = 'sepolia'");

    await watcherB.tick(AbortSignal.timeout(5_000));
    expect(watcherB.progress?.policy).toMatchObject({ confirmations: 1, reorgDepth: 8 });
    expect(watcherB.policyChanges).toHaveLength(1);

    const changes = await readEvmFinalityPolicyChanges(db, "sepolia", ANVIL_ROUTER);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      confirmations: 1,
      reorgDepth: 8,
      previousConfirmations: 3,
      previousReorgDepth: 5,
    });
  });
});
