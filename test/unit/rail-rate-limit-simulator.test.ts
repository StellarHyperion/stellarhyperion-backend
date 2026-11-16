import { AddressKind, encodeStellarAddress } from "@hyperion/protocol";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";

import { EvmWatcher } from "../../src/chains/evm/watcher.js";
import { writeOutbound } from "../../src/chains/writers.js";
import { AxelarGmpClient } from "../../src/rails/axelar/gmp.js";
import { IrisClient } from "../../src/rails/cctp/iris.js";
import { RailPass } from "../../src/rails/pass.js";
import { parseRetryAfterMs, type PendingTransfer, type RailClient } from "../../src/rails/types.js";
import { ANVIL_CHAIN_ID, ANVIL_ROUTER, FakeEvmClient, encodedLog } from "../evm-fakes.js";
import { createRailProviderSimulator, createSimulatorPGliteDb } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

function hexBytes(seed: number, len: number): Hex {
  const bytes: string[] = [];
  for (let i = 0; i < len; i += 1) {
    bytes.push(((seed + i * 29) & 0xff).toString(16).padStart(2, "0"));
  }
  return `0x${bytes.join("")}`;
}

describe("Rail-provider rate-limit simulator (#143)", () => {
  it("parses Retry-After delta-seconds and HTTP-date headers accurately", () => {
    const baseNow = Date.parse("2026-10-16T12:00:00.000Z");
    expect(parseRetryAfterMs("45", baseNow)).toBe(45_000);
    expect(parseRetryAfterMs("  12.5 ", baseNow)).toBe(12_500);
    expect(parseRetryAfterMs("Fri, 16 Oct 2026 12:01:30 GMT", baseNow)).toBe(90_000);
    expect(parseRetryAfterMs("Fri, 16 Oct 2026 11:59:00 GMT", baseNow)).toBeNull();
    expect(parseRetryAfterMs("0", baseNow)).toBeNull();
    expect(parseRetryAfterMs("not-a-date", baseNow)).toBeNull();
    expect(parseRetryAfterMs(null, baseNow)).toBeNull();
  });

  it("respects Retry-After cooldown across concurrent workers without starving unrelated rails or chain watchers, while recovering from timeouts and malformed responses", async () => {
    const db = await createSimulatorPGliteDb();
    try {
      const { logger } = capturingLogger();
      let clockMs = Date.parse("2026-10-16T12:00:00.000Z");
      const now = () => new Date(clockMs);

      const sender = hexBytes(0x11, 20);
      const token = hexBytes(0x22, 20);
      const destStellar = encodeStellarAddress(AddressKind.Account, hexBytes(0x33, 32));
      const cctpTx1 = hexBytes(0x41, 32);
      const cctpTx2 = hexBytes(0x42, 32);
      const axelarTx1 = hexBytes(0x51, 32);
      const watcherTx = hexBytes(0x61, 32);

      await db.transaction(async (tx) => {
        await writeOutbound(
          tx,
          {
            chainKey: "sepolia",
            block: 100n,
            txHash: cctpTx1,
            logIndex: 0,
            observedAt: now(),
          },
          {
            route: 0,
            nonce: 1n,
            sender,
            token,
            grossAmount: 1_001_000n,
            fee: 1_000n,
            netAmount: 1_000_000n,
            destinationChain: "stellar-testnet",
            destination: destStellar,
            railRef: null,
          },
        );
        await writeOutbound(
          tx,
          {
            chainKey: "sepolia",
            block: 101n,
            txHash: cctpTx2,
            logIndex: 0,
            observedAt: now(),
          },
          {
            route: 0,
            nonce: 2n,
            sender,
            token,
            grossAmount: 2_002_000n,
            fee: 2_000n,
            netAmount: 2_000_000n,
            destinationChain: "stellar-testnet",
            destination: destStellar,
            railRef: null,
          },
        );
        await writeOutbound(
          tx,
          {
            chainKey: "sepolia",
            block: 102n,
            txHash: axelarTx1,
            logIndex: 0,
            observedAt: now(),
          },
          {
            route: 1,
            nonce: 3n,
            sender,
            token,
            grossAmount: 3_003_000n,
            fee: 3_000n,
            netAmount: 3_000_000n,
            destinationChain: "stellar-testnet",
            destination: destStellar,
            railRef: hexBytes(0x71, 32),
          },
        );
      });

      const simulator = createRailProviderSimulator({ now });
      // CCTP immediately returns 429 with Retry-After: 45s, then later succeeds with attested.
      simulator.enqueue(
        "cctp",
        { kind: "rate_limit", retryAfterSeconds: 45 },
        { kind: "iris_attested", eventNonce: "701", status: "complete" },
        { kind: "iris_attested", eventNonce: "702", status: "complete" },
      );

      // Axelar experiences timeout -> malformed JSON -> invalid schema -> attested recovery!
      simulator.enqueue(
        "axelar",
        { kind: "timeout", message: "socket hang up" },
        { kind: "malformed_json", rawBody: "<html>502 Bad Gateway</html>" },
        { kind: "invalid_schema", body: { methods: ["searchGMP"] } },
        { kind: "axelar_attested", messageId: `${axelarTx1}-0`, status: "executed" },
      );

      const irisClient = new IrisClient("testnet", {
        baseUrl: "https://iris-sim.example.invalid",
        fetch: simulator.fetch,
        now,
      });
      const axelarClient = new AxelarGmpClient("https://axelar-sim.example.invalid", {
        fetch: simulator.fetch,
        now,
      });

      const cctpWorkerA = new RailPass({
        route: 0,
        client: irisClient,
        db,
        logger,
        batchSize: 10,
        recheckAfterMs: 1_000,
        maxCheckFailures: 5,
        now,
      });
      const cctpWorkerB = new RailPass({
        route: 0,
        client: irisClient,
        db,
        logger,
        batchSize: 10,
        recheckAfterMs: 1_000,
        maxCheckFailures: 5,
        now,
      });
      const axelarWorker = new RailPass({
        route: 1,
        client: axelarClient,
        db,
        logger,
        batchSize: 10,
        recheckAfterMs: 1_000,
        maxCheckFailures: 5,
        now,
      });

      const evmClient = new FakeEvmClient({
        logs: [
          encodedLog(
            "BridgeOut",
            {
              route: 1,
              nonce: 4n,
              sender,
              token,
              grossAmount: 4_004_000n,
              fee: 4_000n,
              netAmount: 4_000_000n,
              destinationChain: "stellar-testnet",
              destinationAddress: destStellar,
              railRef: hexBytes(0x72, 32),
            },
            { blockNumber: 110n, logIndex: 0, txHash: watcherTx },
          ),
        ],
        head: 115n,
      });
      const chainWatcher = new EvmWatcher({
        chainKey: "sepolia",
        router: ANVIL_ROUTER,
        chainId: ANVIL_CHAIN_ID,
        startBlock: 105n,
        confirmations: 3,
        reorgDepth: 5,
        logRange: 20,
        client: evmClient,
        db,
        logger,
      });

      // Round 1 (T = 0s): cctpWorkerA hits 429 (45s cooldown); axelarWorker hits timeout; chainWatcher indexes block 110!
      await Promise.all([
        cctpWorkerA.tick(AbortSignal.timeout(5_000)),
        axelarWorker.tick(AbortSignal.timeout(5_000)),
        chainWatcher.tick(AbortSignal.timeout(5_000)),
      ]);

      expect(simulator.requestCount("cctp")).toBe(1);
      expect(cctpWorkerA.readiness().state).toBe("degraded");
      expect(cctpWorkerA.readiness().detail).toContain("2026-10-16T12:00:45.000Z");

      // Confirm chainWatcher was NOT starved by rail cooldown/faults!
      const watcherInserted = await db.query(
        "SELECT nonce::text AS nonce FROM outbound_transfer WHERE origin_chain = 'sepolia' AND nonce = 4",
      );
      expect(watcherInserted.rows).toHaveLength(1);

      // Rounds 2, 3, 4 (T = +10s, +20s, +30s -- still inside CCTP's 45s Retry-After window!):
      // Both cctpWorkerA AND concurrent cctpWorkerB hold off completely (0 extra CCTP calls),
      // while axelarWorker works through malformed_json -> invalid_schema -> attested!
      simulator.setDefault("axelar", {
        kind: "axelar_attested",
        status: "executed",
      });
      for (const offsetSec of [10, 20, 30]) {
        clockMs = Date.parse("2026-10-16T12:00:00.000Z") + offsetSec * 1_000;
        await Promise.all([
          cctpWorkerA.tick(AbortSignal.timeout(5_000)),
          cctpWorkerB.tick(AbortSignal.timeout(5_000)),
          axelarWorker.tick(AbortSignal.timeout(5_000)),
        ]);
      }

      // CCTP made ZERO requests during the 45s cooldown across both concurrent CCTP workers!
      expect(simulator.requestCount("cctp")).toBe(1);
      expect(cctpWorkerB.readiness().state).toBe("degraded");

      // Meanwhile Axelar was NOT starved and recovered to `attested` with check_failures reset to 0!
      const axelarRows = await db.query(
        `SELECT a.status, a.rail_status, a.check_failures
           FROM rail_attestation a
           JOIN outbound_transfer o ON o.id = a.transfer_id
          WHERE o.origin_chain = 'sepolia' AND o.nonce = 3`,
      );
      expect(axelarRows.rows[0]).toMatchObject({
        status: "attested",
        rail_status: "executed",
        check_failures: 0,
      });

      // Round 5 (T = +46s -- past CCTP Retry-After cooldown): CCTP resumes and refreshes both transfers!
      clockMs = Date.parse("2026-10-16T12:00:46.000Z");
      await cctpWorkerB.tick(AbortSignal.timeout(5_000));
      expect(simulator.requestCount("cctp")).toBe(3);
      expect(cctpWorkerB.readiness().state).toBe("ready");

      const cctpRows = await db.query(
        `SELECT o.nonce::text AS nonce, a.status, a.rail_reference
           FROM rail_attestation a
           JOIN outbound_transfer o ON o.id = a.transfer_id
          WHERE o.origin_chain = 'sepolia' AND o.nonce IN (1, 2)
          ORDER BY o.nonce ASC`,
      );
      expect(cctpRows.rows).toEqual([
        { nonce: "1", status: "attested", rail_reference: "701" },
        { nonce: "2", status: "attested", rail_reference: "702" },
      ]);
    } finally {
      await db.close();
    }
  }, 30_000);

  it("retains durable backoff decisions across process restarts via rail_cooldown", async () => {
    const db = await createSimulatorPGliteDb();
    try {
      const { logger } = capturingLogger();
      let clockMs = Date.parse("2026-10-16T15:00:00.000Z");
      const now = () => new Date(clockMs);

      const sender = hexBytes(0x15, 20);
      const token = hexBytes(0x25, 20);
      const destStellar = encodeStellarAddress(AddressKind.Account, hexBytes(0x35, 32));
      const txHash = hexBytes(0x55, 32);

      await db.transaction(async (tx) => {
        await writeOutbound(
          tx,
          {
            chainKey: "sepolia",
            block: 200n,
            txHash,
            logIndex: 0,
            observedAt: now(),
          },
          {
            route: 1,
            nonce: 55n,
            sender,
            token,
            grossAmount: 5_005_000n,
            fee: 5_000n,
            netAmount: 5_000_000n,
            destinationChain: "stellar-testnet",
            destination: destStellar,
            railRef: hexBytes(0x75, 32),
          },
        );
      });

      const simulator = createRailProviderSimulator({ now });
      // Axelar returns 429 with HTTP-date Retry-After 90 seconds in the future.
      simulator.enqueue(
        "axelar",
        { kind: "rate_limit", retryAfterHttpDate: "Fri, 16 Oct 2026 15:01:30 GMT" },
        { kind: "axelar_attested", messageId: `${txHash}-0`, status: "executed" },
      );

      // Process #1 hits 429 and exits/restarts.
      {
        const client1 = new AxelarGmpClient("https://axelar-sim.example.invalid", {
          fetch: simulator.fetch,
          now,
        });
        const pass1 = new RailPass({
          route: 1,
          client: client1,
          db,
          logger,
          batchSize: 10,
          recheckAfterMs: 1_000,
          maxCheckFailures: 5,
          now,
        });
        await pass1.tick(AbortSignal.timeout(5_000));
        expect(simulator.requestCount("axelar")).toBe(1);
      }

      // Verify durable row in Postgres.
      const storedCooldown = await db.query(
        "SELECT rail, cooldown_until FROM rail_cooldown WHERE rail = 'axelar'",
      );
      expect(storedCooldown.rows).toHaveLength(1);

      // Process #2 starts 30 seconds later (still 60s before cooldown expires) with fresh instances.
      clockMs = Date.parse("2026-10-16T15:00:30.000Z");
      const client2 = new AxelarGmpClient("https://axelar-sim.example.invalid", {
        fetch: simulator.fetch,
        now,
      });
      const pass2 = new RailPass({
        route: 1,
        client: client2,
        db,
        logger,
        batchSize: 10,
        recheckAfterMs: 1_000,
        maxCheckFailures: 5,
        now,
      });

      const didMoreDuringCooldown = await pass2.tick(AbortSignal.timeout(5_000));
      expect(didMoreDuringCooldown).toBe(false);
      // Zero new HTTP calls made after restart while cooldown is active!
      expect(simulator.requestCount("axelar")).toBe(1);
      expect(pass2.readiness().state).toBe("degraded");
      expect(pass2.readiness().detail).toContain("2026-10-16T15:01:30.000Z");

      // Advance past 15:01:30Z: restarted worker clears expired cooldown and polls cleanly!
      clockMs = Date.parse("2026-10-16T15:01:31.000Z");
      await pass2.tick(AbortSignal.timeout(5_000));
      expect(simulator.requestCount("axelar")).toBe(2);
      expect(pass2.readiness().state).toBe("ready");

      const remainingCooldown = await db.query(
        "SELECT rail FROM rail_cooldown WHERE rail = 'axelar'",
      );
      expect(remainingCooldown.rows).toHaveLength(0);
    } finally {
      await db.close();
    }
  });

  it("never generates fake delivered records or inbound_delivery rows from simulator responses alone", async () => {
    const db = await createSimulatorPGliteDb();
    try {
      const { logger } = capturingLogger();
      const now = () => new Date("2026-10-16T16:00:00.000Z");

      const sender = hexBytes(0x18, 20);
      const token = hexBytes(0x28, 20);
      const destStellar = encodeStellarAddress(AddressKind.Account, hexBytes(0x38, 32));
      const cctpTx = hexBytes(0x48, 32);
      const axelarTx = hexBytes(0x58, 32);
      const rogueTx = hexBytes(0x68, 32);

      await db.transaction(async (tx) => {
        await writeOutbound(
          tx,
          { chainKey: "sepolia", block: 300n, txHash: cctpTx, logIndex: 0, observedAt: now() },
          {
            route: 0,
            nonce: 91n,
            sender,
            token,
            grossAmount: 1_000_100n,
            fee: 100n,
            netAmount: 1_000_000n,
            destinationChain: "stellar-testnet",
            destination: destStellar,
            railRef: null,
          },
        );
        await writeOutbound(
          tx,
          { chainKey: "sepolia", block: 301n, txHash: axelarTx, logIndex: 0, observedAt: now() },
          {
            route: 1,
            nonce: 92n,
            sender,
            token,
            grossAmount: 2_000_200n,
            fee: 200n,
            netAmount: 2_000_000n,
            destinationChain: "stellar-testnet",
            destination: destStellar,
            railRef: hexBytes(0x78, 32),
          },
        );
        await writeOutbound(
          tx,
          { chainKey: "sepolia", block: 302n, txHash: rogueTx, logIndex: 0, observedAt: now() },
          {
            route: 2,
            nonce: 93n,
            sender,
            token,
            grossAmount: 3_000_300n,
            fee: 300n,
            netAmount: 3_000_000n,
            destinationChain: "stellar-testnet",
            destination: destStellar,
            railRef: hexBytes(0x79, 32),
          },
        );
      });

      const simulator = createRailProviderSimulator({ now });
      // Simulator emits adversarial "complete"/"executed" payloads with candidate destination tx hashes.
      simulator.enqueue("cctp", {
        kind: "iris_attested",
        status: "complete",
        eventNonce: "991",
        forwardTxHash: hexBytes(0x88, 32),
      });
      simulator.enqueue("axelar", {
        kind: "axelar_attested",
        status: "executed",
        executedTxHash: hexBytes(0x89, 32),
        commandId: hexBytes(0x90, 32),
      });

      const cctpPass = new RailPass({
        route: 0,
        client: new IrisClient("testnet", {
          baseUrl: "https://iris-sim.example.invalid",
          fetch: simulator.fetch,
          now,
        }),
        db,
        logger,
        batchSize: 10,
        recheckAfterMs: 1_000,
        maxCheckFailures: 5,
        now,
      });

      const axelarPass = new RailPass({
        route: 1,
        client: new AxelarGmpClient("https://axelar-sim.example.invalid", {
          fetch: simulator.fetch,
          now,
        }),
        db,
        logger,
        batchSize: 10,
        recheckAfterMs: 1_000,
        maxCheckFailures: 5,
        now,
      });

      // Even a buggy/rogue custom RailClient attempting to return `status: "delivered"` directly is clamped!
      const rogueClient: RailClient = {
        rail: "axelar-gmp",
        look(_transfer: PendingTransfer) {
          return Promise.resolve({
            kind: "found",
            report: {
              status: "delivered",
              railStatus: "delivered",
              reference: "rogue-ref",
              attestedAt: now(),
            },
          });
        },
      };
      const roguePass = new RailPass({
        route: 2,
        client: rogueClient,
        db,
        logger,
        batchSize: 10,
        recheckAfterMs: 1_000,
        maxCheckFailures: 5,
        now,
      });

      await cctpPass.tick(AbortSignal.timeout(5_000));
      await axelarPass.tick(AbortSignal.timeout(5_000));
      await roguePass.tick(AbortSignal.timeout(5_000));

      const inboundRows = await db.query("SELECT * FROM inbound_delivery");
      expect(inboundRows.rows).toHaveLength(0);

      const attestations = await db.query(
        "SELECT route, status FROM rail_attestation ORDER BY route ASC",
      );
      expect(attestations.rows).toEqual([
        { route: 0, status: "attested" },
        { route: 1, status: "attested" },
        { route: 2, status: "attested" },
      ]);
    } finally {
      await db.close();
    }
  });
});
