import { parseStellarAddress } from "@hyperion/protocol";
import { describe, expect, it } from "vitest";

import {
  BENCHMARK_SCALES,
  createDedicatedBenchmarkPGliteDb,
  runDatabaseLoadBenchmark,
} from "../helpers.js";

describe("Database load and bounded-latency benchmarks (#142)", () => {
  it("runs deterministic small and medium benchmark scales on dedicated isolated databases with zero plan or latency regressions", async () => {
    const dbSmallA = await createDedicatedBenchmarkPGliteDb();
    const dbSmallB = await createDedicatedBenchmarkPGliteDb();
    const dbMedium = await createDedicatedBenchmarkPGliteDb();

    try {
      const reportSmallA = await runDatabaseLoadBenchmark(dbSmallA, { scale: "small" });
      const reportSmallB = await runDatabaseLoadBenchmark(dbSmallB, { scale: "small" });
      const reportMedium = await runDatabaseLoadBenchmark(dbMedium, { scale: "medium" });

      expect(reportSmallA.passed).toBe(true);
      expect(reportSmallA.planRegressions).toEqual([]);
      expect(reportSmallA.latencyRegressions).toEqual([]);

      // Deterministic seed produces identical workload counts, addresses, and sample identifiers across isolated DBs.
      expect(reportSmallB.history).toEqual(reportSmallA.history);
      expect(reportSmallA.history.outboundTransfers).toBe(BENCHMARK_SCALES.small.outboundCount);

      // Verify isolation: dbSmallA and dbMedium have independent row counts and state.
      expect(reportMedium.passed).toBe(true);
      expect(reportMedium.planRegressions).toEqual([]);
      expect(reportMedium.latencyRegressions).toEqual([]);
      expect(reportMedium.history.outboundTransfers).toBe(BENCHMARK_SCALES.medium.outboundCount);

      const countSmall = await dbSmallA.query("SELECT count(*)::int AS n FROM outbound_transfer");
      const countMedium = await dbMedium.query("SELECT count(*)::int AS n FROM outbound_transfer");
      expect(countSmall.rows[0]?.n).toBe(100);
      expect(countMedium.rows[0]?.n).toBe(240);

      // Verify generated Stellar strkey carries valid CRC16 checksum.
      const decoded = parseStellarAddress(reportSmallA.history.sampleSenderStellar);
      expect(decoded.key).toMatch(/^0x[0-9a-f]{64}$/);

      // Every key query, proof backlog scan, and position lookup was measured with positive bounded timings.
      const operations = reportMedium.measurements.map((m) => m.operation);
      expect(operations).toEqual([
        "transfer_by_origin_nonce",
        "transfers_by_sender",
        "reorg_position_scan",
        "outstanding_claims_scan",
        "rail_attestation_partial_poll",
        "proof_backlog_queue_scan",
      ]);
      for (const m of reportMedium.measurements) {
        expect(m.iterations).toBe(BENCHMARK_SCALES.medium.queryIterations);
        expect(m.minMs).toBeGreaterThanOrEqual(0);
        expect(m.p95Ms).toBeLessThanOrEqual(m.maxAllowedP95Ms);
        expect(m.lastRowCount).toBeGreaterThan(0);
      }
    } finally {
      await dbSmallA.close();
      await dbSmallB.close();
      await dbMedium.close();
    }
  }, 45_000);

  it("preserves full-width NUMERIC(78,0) amounts, u64 NUMERIC(20,0) nonces, real schema constraints, and destination delivery invariants", async () => {
    const db = await createDedicatedBenchmarkPGliteDb();
    try {
      const report = await runDatabaseLoadBenchmark(db, { scale: "small" });
      expect(report.passed).toBe(true);

      // Wide uint256 (> 10^28) exact integer strings and gross = fee + net check.
      const wideRows = await db.query(
        `SELECT gross_amount::text AS gross, fee::text AS fee, net_amount::text AS net
           FROM outbound_transfer
          WHERE gross_amount > 10000000000000000000000000000`,
      );
      expect(wideRows.rows.length).toBeGreaterThan(0);
      for (const row of wideRows.rows) {
        const gross = BigInt(row.gross as string);
        const fee = BigInt(row.fee as string);
        const net = BigInt(row.net as string);
        expect(gross).toBe(fee + net);
      }

      // High u64 nonces above signed int8 max (2^63 - 1) stored without precision loss.
      const highNonces = await db.query(
        `SELECT nonce::text AS nonce
           FROM outbound_transfer
          WHERE nonce > 9223372036854775807`,
      );
      expect(highNonces.rows.length).toBeGreaterThan(0);
      expect(BigInt(highNonces.rows[0]?.nonce as string)).toBeGreaterThan(
        9_223_372_036_854_775_807n,
      );

      // No rail_attestation is ever marked 'delivered' without a matching inbound_delivery row!
      const unverifiedDelivered = await db.query(
        `SELECT a.transfer_id
           FROM rail_attestation a
           JOIN outbound_transfer t ON t.id = a.transfer_id
           LEFT JOIN inbound_delivery d
             ON d.destination_chain = t.destination_chain
            AND d.route = t.route
            AND d.source_chain = t.origin_chain
            AND d.source_nonce = t.nonce
          WHERE a.status = 'delivered' AND d.id IS NULL`,
      );
      expect(unverifiedDelivered.rows).toHaveLength(0);

      // Real schema CHECK constraints remain active and reject invalid rows.
      await expect(
        db.query(
          `INSERT INTO outbound_transfer
             (origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
              destination_chain, destination, origin_block, origin_tx)
           VALUES ('sepolia', 0, 999999, '0x11', '0x22', 100, 10, 80, 'stellar-testnet', 'GABC', 1, '0x33')`,
        ),
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  }, 30_000);

  it("flags query-plan regressions when indexes are missing and flags bounded-latency regressions when thresholds are exceeded", async () => {
    const db = await createDedicatedBenchmarkPGliteDb();
    try {
      // Simulate an accidental index drop migration regression on sender and partial claim indexes.
      await db.query("DROP INDEX outbound_transfer_by_sender");
      await db.query("DROP INDEX pending_claim_outstanding");

      const report = await runDatabaseLoadBenchmark(db, {
        scale: {
          name: "custom",
          seed: 0x1420_9999,
          outboundCount: 80,
          senderPoolSize: 20,
          recipientPoolSize: 20,
          adminActionCount: 4,
          healthSampleCount: 8,
          replayWindowSize: 8,
          queryIterations: 3,
        },
        thresholds: {
          defaultQueryMaxP95Ms: 0.0001,
          ingestionBatchMaxMs: 0.0001,
          replayWindowMaxMs: 0.0001,
        },
      });

      expect(report.passed).toBe(false);

      const regressedPlanOps = report.planRegressions.map((r) => r.operation);
      expect(regressedPlanOps).toContain("transfers_by_sender");
      expect(regressedPlanOps).toContain("outstanding_claims_scan");

      const regressedLatencyOps = report.latencyRegressions.map((r) => r.operation);
      expect(regressedLatencyOps).toContain("ingestion_initial_batch");
      expect(regressedLatencyOps).toContain("ingestion_replay_window");
      expect(regressedLatencyOps).toContain("transfers_by_sender");
    } finally {
      await db.close();
    }
  }, 30_000);
});
