/**
 * Deterministic crash-injection and worker restart coverage against real PostgreSQL DDL (`PGlite`).
 *
 * Verifies that every pre-commit and post-commit fault boundary across `StellarWatcher`,
 * `EvmWatcher`, and `RailPass` yields either atomic rollback or safe replay, produces zero
 * duplicate source records after restarting fresh workers, preserves full-width identifiers and
 * integer-string amounts, never promotes provider status alone to destination delivery, and
 * retains seed, operation boundary, and database snapshot on failure.
 */
import { AddressKind, RouteKind, encodeStellarAddress } from "@hyperion/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EvmWatcher } from "../../src/chains/evm/watcher.js";
import { StellarWatcher } from "../../src/chains/stellar/watcher.js";
import { RailPass } from "../../src/rails/pass.js";
import type { PendingTransfer, RailClient, RailLookup } from "../../src/rails/types.js";
import {
  ALL_CRASH_BOUNDARIES,
  CrashHarnessFailureError,
  CrashInjectingDatabase,
  CrashInjectionError,
  buildSeededCrashRules,
  captureDatabaseSnapshot,
  drainWorker,
  openPGliteDatabase,
  resetHarnessTables,
  runCrashRestartScenario,
  type CrashBoundary,
  type DatabaseSnapshot,
  type PGliteDatabase,
} from "../crash-harness.js";
import {
  ANVIL_CHAIN_ID,
  ANVIL_HISTORY,
  ANVIL_ROUTER,
  ANVIL_START_BLOCK,
  FakeEvmClient,
  encodedLog,
} from "../evm-fakes.js";
import {
  FakeRpc,
  LIVE_ROUTER,
  capturingLogger,
  syntheticBridgeInEvent,
  syntheticBridgeOutEvent,
  syntheticClaimParkedEvent,
  syntheticClaimSettledEvent,
} from "../stellar-fakes.js";

const STELLAR_CHAIN = "stellar-testnet";
const EVM_CHAIN = "sepolia";
const START_LEDGER = 5_000_000;
const HEAD_LEDGER = 5_015_000;

const ACCOUNT_RECIPIENT = encodeStellarAddress(AddressKind.Account, new Uint8Array(32).fill(0x41));
const MUXED_RECIPIENT = encodeStellarAddress(
  AddressKind.MuxedAccount,
  new Uint8Array(32).fill(0x42),
  9001n,
);
const TOKEN_CONTRACT = encodeStellarAddress(AddressKind.Contract, new Uint8Array(32).fill(0x55));

const LARGE_U64_NONCE = 9_223_372_036_854_775_900n;
const LARGE_U256_GROSS = 123_456_789_012_345_678_901_234_567_890n;
const LARGE_U256_FEE = 123_456_789_012_345_678_901_234_000_000n;
const LARGE_U256_NET = LARGE_U256_GROSS - LARGE_U256_FEE;
const FULL_WIDTH_DEST_WORD = `0x${"00".repeat(12)}${"de".repeat(20)}`;
const FULL_WIDTH_RAIL_MSG = `0x${"cd".repeat(32)}`;

function buildStellarEvents() {
  return [
    syntheticBridgeOutEvent({
      ledger: START_LEDGER + 10,
      route: RouteKind.Cctp,
      nonce: LARGE_U64_NONCE,
      sender: ACCOUNT_RECIPIENT,
      token: TOKEN_CONTRACT,
      grossAmount: LARGE_U256_GROSS,
      fee: LARGE_U256_FEE,
      netAmount: LARGE_U256_NET,
      destinationChain: EVM_CHAIN,
      destinationHex: FULL_WIDTH_DEST_WORD,
    }),
    syntheticBridgeInEvent({
      ledger: START_LEDGER + 25,
      route: RouteKind.AxelarIts,
      recipient: MUXED_RECIPIENT,
      token: TOKEN_CONTRACT,
      amount: 500_000_000n,
      sourceChain: EVM_CHAIN,
      sourceNonce: 77n,
      delivered: true,
    }),
    syntheticClaimParkedEvent({
      ledger: START_LEDGER + 11_000,
      claimId: 404n,
      recipient: ACCOUNT_RECIPIENT,
      token: TOKEN_CONTRACT,
      amount: 250_000_000n,
      route: RouteKind.Cctp,
      sourceChain: EVM_CHAIN,
      sourceNonce: 88n,
    }),
    syntheticBridgeInEvent({
      ledger: START_LEDGER + 11_000,
      eventIndex: 1,
      route: RouteKind.Cctp,
      recipient: ACCOUNT_RECIPIENT,
      token: TOKEN_CONTRACT,
      amount: 250_000_000n,
      sourceChain: EVM_CHAIN,
      sourceNonce: 88n,
      delivered: false,
      claimId: 404n,
    }),
    syntheticClaimSettledEvent({
      ledger: START_LEDGER + 11_050,
      claimId: 404n,
      recipient: ACCOUNT_RECIPIENT,
      token: TOKEN_CONTRACT,
      amount: 250_000_000n,
    }),
  ];
}

function buildEvmLogs() {
  const parkedBlock = ANVIL_START_BLOCK + 12n;
  const txHash = `0x${"7e".repeat(32)}` as const;
  return [
    ...ANVIL_HISTORY,
    encodedLog(
      "ClaimParked",
      {
        id: 19n,
        recipient: "0x2222222222222222222222222222222222222222",
        token: "0x3333333333333333333333333333333333333333",
        amount: 9_876_543_210_987_654_321n,
        route: RouteKind.Cctp,
        sourceChain: STELLAR_CHAIN,
        sourceNonce: 501n,
      },
      { blockNumber: parkedBlock, logIndex: 0, txHash },
    ),
    encodedLog(
      "BridgeIn",
      {
        messageId: FULL_WIDTH_RAIL_MSG,
        route: RouteKind.Cctp,
        recipient: "0x2222222222222222222222222222222222222222",
        token: "0x3333333333333333333333333333333333333333",
        amount: 9_876_543_210_987_654_321n,
        sourceChain: STELLAR_CHAIN,
        sourceNonce: 501n,
      },
      { blockNumber: parkedBlock, logIndex: 1, txHash },
    ),
  ];
}

describe("deterministic indexer crash-injection harness", () => {
  let db: PGliteDatabase;
  let stellarReference: DatabaseSnapshot;
  let evmReference: DatabaseSnapshot;

  const createStellarWorker = (
    targetDb: Parameters<typeof drainWorker>[0] extends never
      ? never
      : ConstructorParameters<typeof StellarWatcher>[0]["db"],
  ) => {
    const { logger } = capturingLogger();
    return new StellarWatcher({
      chainKey: STELLAR_CHAIN,
      router: LIVE_ROUTER,
      startLedger: START_LEDGER,
      pageSize: 100,
      rpc: new FakeRpc({ events: buildStellarEvents(), latestLedger: HEAD_LEDGER }),
      db: targetDb,
      logger,
    });
  };

  const createEvmWorker = (targetDb: ConstructorParameters<typeof EvmWatcher>[0]["db"]) => {
    const { logger } = capturingLogger();
    const logs = buildEvmLogs();
    const maxBlock = logs.reduce((m, entry) => (entry.blockNumber > m ? entry.blockNumber : m), 0n);
    return new EvmWatcher({
      chainKey: EVM_CHAIN,
      router: ANVIL_ROUTER,
      chainId: ANVIL_CHAIN_ID,
      startBlock: ANVIL_START_BLOCK,
      confirmations: 1,
      reorgDepth: 4,
      logRange: 8,
      client: new FakeEvmClient({ logs, head: maxBlock + 2n }),
      db: targetDb,
      logger,
    });
  };

  beforeAll(async () => {
    db = await openPGliteDatabase();

    await resetHarnessTables(db);
    await drainWorker(createStellarWorker(db));
    stellarReference = await captureDatabaseSnapshot(db, { chains: [STELLAR_CHAIN] });

    await resetHarnessTables(db);
    await drainWorker(createEvmWorker(db));
    evmReference = await captureDatabaseSnapshot(db, { chains: [EVM_CHAIN] });
  });

  afterAll(async () => {
    await db.close();
  });

  it("recovers StellarWatcher cleanly across every event and cursor crash boundary", async () => {
    const watcherBoundaries: readonly CrashBoundary[] = [
      "before_begin",
      "before_event_write",
      "after_event_write",
      "before_cursor_write",
      "after_cursor_write",
      "before_commit",
      "after_commit",
    ];

    for (const [index, boundary] of watcherBoundaries.entries()) {
      await resetHarnessTables(db);
      const seed = 1000 + index;
      const result = await runCrashRestartScenario({
        db,
        rule: { seed, boundary, occurrence: 1 },
        createWorker: (faultDb) => createStellarWorker(faultDb),
        filter: { chains: [STELLAR_CHAIN] },
        expectedFinalSnapshot: stellarReference,
        verifyMidCrash: (midSnapshot) => {
          if (boundary !== "after_commit") {
            // Every pre-commit crash on the first pass must roll back completely.
            expect(midSnapshot.cursors).toEqual([]);
            expect(midSnapshot.outboundTransfers).toEqual([]);
            expect(midSnapshot.inboundDeliveries).toEqual([]);
            expect(midSnapshot.pendingClaims).toEqual([]);
          } else {
            // Post-commit crash on pass 1 preserves both the committed cursor and window 1 events.
            expect(midSnapshot.cursors).toHaveLength(1);
            expect(midSnapshot.outboundTransfers).toHaveLength(1);
          }
        },
      });

      expect(result.crashed).toBe(true);
      expect(result.finalSnapshot.outboundTransfers[0]?.nonce).toBe(LARGE_U64_NONCE.toString());
      expect(result.finalSnapshot.outboundTransfers[0]?.grossAmount).toBe(
        LARGE_U256_GROSS.toString(),
      );
      expect(result.finalSnapshot.outboundTransfers[0]?.destination).toBe(FULL_WIDTH_DEST_WORD);
      expect(result.finalSnapshot.inboundDeliveries[0]?.recipient).toBe(ACCOUNT_RECIPIENT);
      expect(result.finalSnapshot.inboundDeliveries[1]?.recipient).toBe(MUXED_RECIPIENT);
      expect(result.finalSnapshot.pendingClaims[0]?.settled).toBe(true);
    }
  });

  it("recovers EvmWatcher cleanly across every log write and cursor hash commit boundary", async () => {
    const watcherBoundaries: readonly CrashBoundary[] = [
      "before_begin",
      "before_event_write",
      "after_event_write",
      "before_cursor_write",
      "after_cursor_write",
      "before_commit",
      "after_commit",
    ];

    for (const [index, boundary] of watcherBoundaries.entries()) {
      await resetHarnessTables(db);
      const seed = 2000 + index;
      const result = await runCrashRestartScenario({
        db,
        rule: { seed, boundary, occurrence: 1 },
        createWorker: (faultDb) => createEvmWorker(faultDb),
        filter: { chains: [EVM_CHAIN] },
        expectedFinalSnapshot: evmReference,
        verifyMidCrash: (midSnapshot) => {
          if (boundary !== "after_commit") {
            // Occurrence 1 of event_write happens on a later range if range 1 had only admin logs,
            // so cursor and event tables must agree on the last committed range.
            if (midSnapshot.cursors.length === 0) {
              expect(midSnapshot.outboundTransfers).toEqual([]);
              expect(midSnapshot.inboundDeliveries).toEqual([]);
            }
          } else {
            expect(midSnapshot.cursors).toHaveLength(1);
            expect(midSnapshot.cursors[0]?.lastProcessedHash).toMatch(/^0x[0-9a-f]{64}$/);
          }
        },
      });

      expect(result.crashed).toBe(true);
      expect(result.finalSnapshot.inboundDeliveries[0]?.railMessageId).toBe(FULL_WIDTH_RAIL_MSG);
      expect(result.finalSnapshot.pendingClaims[0]?.amount).toBe("9876543210987654321");
    }
  });

  it("recovers RailPass across attestation crash boundaries without promoting provider status to delivered", async () => {
    const railBoundaries: readonly CrashBoundary[] = [
      "before_begin",
      "before_attestation_write",
      "after_attestation_write",
      "before_commit",
      "after_commit",
    ];

    const providerOnlyClient: RailClient = {
      rail: "cctp",
      look: (_transfer: PendingTransfer): Promise<RailLookup> =>
        Promise.resolve({
          kind: "found",
          report: {
            status: "attested",
            railStatus: "complete",
            reference: "cctp-attestation-ref-1",
            attestedAt: new Date("2026-11-01T00:00:00.000Z"),
          },
        }),
    };

    for (const [index, boundary] of railBoundaries.entries()) {
      await resetHarnessTables(db);
      await drainWorker(createStellarWorker(db));

      const result = await runCrashRestartScenario({
        db,
        rule: { seed: 3000 + index, boundary, occurrence: 1 },
        createWorker: (faultDb) => {
          const { logger } = capturingLogger();
          return new RailPass({
            route: RouteKind.Cctp,
            client: providerOnlyClient,
            db: faultDb,
            logger,
            batchSize: 10,
            recheckAfterMs: 60_000,
            maxCheckFailures: 5,
            now: () => new Date("2026-11-01T01:00:00.000Z"),
          });
        },
        filter: { chains: [STELLAR_CHAIN] },
        verifyMidCrash: (midSnapshot) => {
          if (boundary !== "after_commit") {
            expect(midSnapshot.railAttestations).toEqual([]);
          } else {
            expect(midSnapshot.railAttestations).toHaveLength(1);
            expect(midSnapshot.railAttestations[0]?.status).toBe("attested");
          }
        },
      });

      expect(result.crashed).toBe(true);
      expect(result.finalSnapshot.railAttestations).toHaveLength(1);
      // Provider status alone remains `attested` and never fabricates destination delivery.
      expect(result.finalSnapshot.railAttestations[0]?.status).toBe("attested");
      expect(
        result.finalSnapshot.inboundDeliveries.filter((row) => row.sourceChain === STELLAR_CHAIN),
      ).toEqual([]);
    }
  });

  it("replays multi-fault seeded crash sequences deterministically without duplicating records", async () => {
    await resetHarnessTables(db);
    await drainWorker(createStellarWorker(db));
    await drainWorker(createEvmWorker(db));
    const combinedReference = await captureDatabaseSnapshot(db);

    for (const seed of [137, 2026, 9001]) {
      const rules = buildSeededCrashRules(
        seed,
        [
          "before_begin",
          "before_event_write",
          "after_event_write",
          "before_cursor_write",
          "after_cursor_write",
          "before_commit",
          "after_commit",
        ],
        4,
        1,
      );
      // Re-generating with the same seed yields the exact same schedule.
      expect(
        buildSeededCrashRules(
          seed,
          [
            "before_begin",
            "before_event_write",
            "after_event_write",
            "before_cursor_write",
            "after_cursor_write",
            "before_commit",
            "after_commit",
          ],
          4,
          1,
        ),
      ).toEqual(rules);

      await resetHarnessTables(db);
      const faultDb = new CrashInjectingDatabase(db);

      for (const [idx, rule] of rules.entries()) {
        faultDb.resetTrace();
        faultDb.armFault(rule);
        const worker = idx % 2 === 0 ? createStellarWorker(faultDb) : createEvmWorker(faultDb);
        try {
          await drainWorker(worker);
        } catch (error) {
          expect(error).toBeInstanceOf(CrashInjectionError);
        }
      }

      faultDb.clearFault();
      await drainWorker(createStellarWorker(faultDb));
      await drainWorker(createEvmWorker(faultDb));

      const converged = await captureDatabaseSnapshot(db);
      expect(converged).toEqual(combinedReference);
    }
  });

  it("retains seed, operation boundary, trace, and redacted database snapshot on failure", async () => {
    expect(ALL_CRASH_BOUNDARIES).toHaveLength(9);
    await resetHarnessTables(db);

    let capturedError: unknown = null;
    try {
      await runCrashRestartScenario({
        db,
        rule: { seed: 77_137, boundary: "after_event_write", occurrence: 1 },
        createWorker: (faultDb) => createStellarWorker(faultDb),
        filter: { chains: [STELLAR_CHAIN] },
        verifyMidCrash: () => {
          throw new Error(
            "simulated invariant failure against postgres://hyperion:super-secret-password@127.0.0.1:5433/hyperion",
          );
        },
      });
    } catch (error) {
      capturedError = error;
    }

    expect(capturedError).toBeInstanceOf(CrashHarnessFailureError);
    const failure = capturedError as CrashHarnessFailureError;
    expect(failure.seed).toBe(77_137);
    expect(failure.operationBoundary).toBe("after_event_write");
    expect(failure.occurrence).toBe(1);
    expect(failure.trace.some((entry) => entry.injected)).toBe(true);
    expect(failure.snapshot.cursors).toEqual([]);
    expect(failure.message).toContain("seed=77137");
    expect(failure.message).toContain("boundary=after_event_write");
    expect(failure.message).toContain("snapshot=");
    expect(failure.message).not.toContain("super-secret-password");
    expect(failure.message).toContain("[REDACTED]@");
  });
});
