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
  public readonly executedQueries: { text: string; params: readonly unknown[] }[] = [];

  constructor(private readonly responses: Record<string, readonly Record<string, unknown>[]>) {}

  query(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: readonly Record<string, unknown>[]; rowCount: number }> {
    this.executedQueries.push({ text, params });
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

  it("submits EVM second-step execution with receiveMessage and records delivery on success", async () => {
    const db = new MockDb({
      outbound_transfer: [
        {
          id: "10",
          origin_chain: "stellar-testnet",
          destination_chain: "sepolia",
          route: 0,
          nonce: "42",
          sender: "GBB...",
          token: "0x2222",
          gross_amount: "1000",
          fee: "10",
          net_amount: "990",
          destination: "0x1111",
          origin_tx: "tx-stellar-42",
          rail_reference: JSON.stringify({ message: "0xmsgbytes", attestation: "0xsigbytes" }),
          rail_status: "complete",
        },
      ],
    });

    const calls: { address: string; functionName: string; args: readonly unknown[] }[] = [];
    const evmRpcProvider = {
      writeContract: (args: {
        address: string;
        functionName: string;
        args: readonly unknown[];
      }) => {
        calls.push(args);
        return Promise.resolve(
          "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as const,
        );
      },
      waitForTransactionReceipt: () =>
        Promise.resolve({
          status: "success" as const,
          blockNumber: 9999n,
          transactionHash:
            "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as const,
          transactionIndex: 1,
        }),
    };

    const worker = new KeeperWorker(config, db, logger);
    const result = await worker.processSecondStep({ evmRpcProvider });

    expect(result.relayed).toBe(1);
    expect(result.pending).toBe(1);
    expect(result.dryRun).toBe(false);
    expect(result.detail).toBe("relayed 1 of 1 transfers");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.functionName).toBe("receiveMessage");
    expect(calls[0]?.args).toEqual(["0xmsgbytes", "0xsigbytes"]);

    const inboundInsert = db.executedQueries.find((q) =>
      q.text.includes("INSERT INTO inbound_delivery"),
    );
    expect(inboundInsert).toBeDefined();
    expect(inboundInsert?.params).toContain("sepolia");
    expect(inboundInsert?.params).toContain("0x1111");
    expect(inboundInsert?.params).toContain("990");
    expect(inboundInsert?.params).toContain(true); // delivered
    expect(inboundInsert?.params).toContain(
      "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    );

    const attestationUpdate = db.executedQueries.find((q) =>
      q.text.includes("UPDATE rail_attestation"),
    );
    expect(attestationUpdate).toBeDefined();
  });

  it("validates delivery before completing and aborts if EVM transaction reverts", async () => {
    const db = new MockDb({
      outbound_transfer: [
        {
          id: "11",
          origin_chain: "stellar-testnet",
          destination_chain: "sepolia",
          route: 0,
          nonce: "43",
          sender: "GBB...",
          token: "0x2222",
          gross_amount: "1000",
          fee: "10",
          net_amount: "990",
          destination: "0x1111",
          origin_tx: "tx-stellar-43",
          rail_reference: JSON.stringify({ message: "0xbadmsg", attestation: "0xbadsig" }),
          rail_status: "complete",
        },
      ],
    });

    const evmRpcProvider = {
      writeContract: () => Promise.resolve("0xreverttx" as const),
      waitForTransactionReceipt: () =>
        Promise.resolve({
          status: "reverted" as const,
          blockNumber: 10000n,
          transactionHash: "0xreverttx" as const,
        }),
    };

    const result = await processRailSecondStep({ db, config, logger }, { evmRpcProvider });
    expect(result.relayed).toBe(0);
    expect(result.pending).toBe(1);
    expect(result.dryRun).toBe(false);

    const inboundInsert = db.executedQueries.find((q) =>
      q.text.includes("INSERT INTO inbound_delivery"),
    );
    expect(inboundInsert).toBeUndefined();
  });

  it("submits Stellar second-step execution with receive_message and records delivery", async () => {
    const db = new MockDb({
      outbound_transfer: [
        {
          id: "12",
          origin_chain: "sepolia",
          destination_chain: "stellar-testnet",
          route: 0,
          nonce: "44",
          sender: "0x1111",
          token: "CAS...",
          gross_amount: "5000",
          fee: "15",
          net_amount: "4985",
          destination: "GBB...",
          origin_tx: "0xevmtx",
          rail_reference: null,
          rail_status: "complete",
        },
      ],
    });

    const stellarCalls: { contractId: string; method: string; args: readonly unknown[] }[] = [];
    const stellarRpcProvider = {
      submitTransaction: (args: {
        contractId: string;
        method: string;
        args: readonly unknown[];
      }) => {
        stellarCalls.push(args);
        return Promise.resolve({
          status: "SUCCESS" as const,
          hash: "stellar-tx-hash-777",
          ledger: 123456n,
        });
      },
    };

    const attestationFetcher = () =>
      Promise.resolve({ message: "0xstellarmessage", attestation: "0xstellarsig" });

    const result = await processRailSecondStep(
      { db, config, logger },
      { stellarRpcProvider, attestationFetcher },
    );

    expect(result.relayed).toBe(1);
    expect(result.pending).toBe(1);
    expect(result.dryRun).toBe(false);

    expect(stellarCalls).toHaveLength(1);
    expect(stellarCalls[0]?.method).toBe("receive_message");
    expect(stellarCalls[0]?.args).toEqual(["0xstellarmessage", "0xstellarsig"]);

    const inboundInsert = db.executedQueries.find((q) =>
      q.text.includes("INSERT INTO inbound_delivery"),
    );
    expect(inboundInsert).toBeDefined();
    expect(inboundInsert?.params).toContain("stellar-testnet");
    expect(inboundInsert?.params).toContain("stellar-tx-hash-777");
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
