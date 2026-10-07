/**
 * Unit tests for the BullMQ keeper jobs and worker.
 *
 * Verifies that the four keeper jobs correctly inspect database state,
 * format operational targets, and handle dry-run execution safely without keys.
 */
import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/config.js";
import { processClaimSettlement } from "../../src/keeper/jobs/claims.js";
import { processGasTopup } from "../../src/keeper/jobs/gas.js";
import { processRailSecondStep } from "../../src/keeper/jobs/second-step.js";
import { processTtlBump } from "../../src/keeper/jobs/ttl.js";
import { KeeperWorker } from "../../src/keeper/worker.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

/** Mock in-memory database answering queries for unit tests. */
class MockDb {
  constructor(private readonly responses: Record<string, readonly Record<string, unknown>[]>) {}

  query(text: string): Promise<{ rows: readonly Record<string, unknown>[]; rowCount: number }> {
    for (const [key, rows] of Object.entries(this.responses)) {
      if (text.includes(key)) {
        return Promise.resolve({ rows, rowCount: rows.length });
      }
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  transaction<T>(work: (tx: MockDb) => Promise<T>): Promise<T> {
    return work(this);
  }
}

describe("keeper upkeep jobs", () => {
  const config = loadConfig({ env: completeEnv() });
  const { logger } = capturingLogger();

  it("identifies Soroban TTL bump targets for tokens, claims and transfers", async () => {
    const db = new MockDb({
      route_health: [{ token: "CAS3J7GYCCXGRQ2D2OE2..." }],
      pending_claim: [{ claim_id: "1" }, { claim_id: "2" }],
      outbound_transfer: [{ nonce: "100" }, { nonce: "101" }],
    });

    const result = await processTtlBump({ db, config, logger });
    expect(result.bumpedTokens).toBe(1);
    expect(result.bumpedClaims).toBe(2);
    expect(result.bumpedTransfers).toBe(2);
    expect(result.dryRun).toBe(true);
    expect(result.detail).toContain("dry-run");
  });

  it("scans unsettled parked claims", async () => {
    const db = new MockDb({
      pending_claim: [
        {
          id: "1",
          chain: "stellar-testnet",
          claim_id: "10",
          recipient: "GAA...",
          token: "CAS...",
          amount: "1000000",
          route: 0,
        },
      ],
    });

    const result = await processClaimSettlement({ db, config, logger });
    expect(result.pending).toBe(1);
    expect(result.attempted).toBe(1);
    expect(result.settled).toBe(0);
    expect(result.dryRun).toBe(true);
  });

  it("identifies attested transfers awaiting rail second-step arrival", async () => {
    const db = new MockDb({
      outbound_transfer: [
        {
          id: "5",
          origin_chain: "sepolia",
          destination_chain: "stellar-testnet",
          route: 0,
          nonce: "42",
          origin_tx: "0xabc",
          rail_reference: "iris-123",
          rail_status: "complete",
        },
      ],
    });

    const result = await processRailSecondStep({ db, config, logger });
    expect(result.pending).toBe(1);
    expect(result.dryRun).toBe(true);
  });

  it("identifies underfunded Axelar transfers requiring gas top-up", async () => {
    const db = new MockDb({
      outbound_transfer: [
        {
          id: "8",
          origin_chain: "stellar-testnet",
          destination_chain: "sepolia",
          nonce: "77",
          origin_tx: "0xdef",
          rail_reference: "0xmsg",
          rail_status: "called/confirming/is_insufficient_fee",
        },
      ],
    });

    const result = await processGasTopup({ db, config, logger });
    expect(result.pending).toBe(1);
    expect(result.dryRun).toBe(true);
  });
});

describe("KeeperWorker lifecycle and readiness", () => {
  it("reports ready when disabled by configuration", () => {
    const config = loadConfig({ env: completeEnv({ KEEPER_ENABLED: "false" }) });
    const { logger } = capturingLogger();
    const db = new MockDb({});
    const worker = new KeeperWorker(config, db, logger);

    const report = worker.readiness();
    expect(report.state).toBe("ready");
    expect(report.detail).toContain("disabled by configuration");
  });

  it("reports degraded before starting when enabled", () => {
    const config = loadConfig({ env: completeEnv() });
    const { logger } = capturingLogger();
    const db = new MockDb({});
    const worker = new KeeperWorker(config, db, logger);

    const report = worker.readiness();
    expect(report.state).toBe("degraded");
    expect(report.detail).toContain("not started yet");
  });
});
