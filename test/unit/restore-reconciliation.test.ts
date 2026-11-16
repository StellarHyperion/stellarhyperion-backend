import { AddressKind, encodeStellarAddress } from "@hyperion/protocol";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";

import { EvmWatcher } from "../../src/chains/evm/watcher.js";
import { decodeStellarEvent } from "../../src/chains/stellar/events.js";
import { StellarWatcher } from "../../src/chains/stellar/watcher.js";
import { RailPass } from "../../src/rails/pass.js";
import type { PendingTransfer, RailClient } from "../../src/rails/types.js";
import { ANVIL_CHAIN_ID, ANVIL_ROUTER, FakeEvmClient, encodedLog } from "../evm-fakes.js";
import {
  createMigratedPGliteDb,
  readDatabaseHistorySnapshot,
  reconcileRestoredDatabase,
  replayMissingHistoryIntervals,
  type ChainExpectedRange,
} from "../helpers.js";
import {
  FakeRpc,
  LIVE_ROUTER,
  ROUTER_HISTORY,
  capturingLogger,
  syntheticEvent,
} from "../stellar-fakes.js";

function dynamicHex(seedByte: number, byteLen: number): Hex {
  const parts: string[] = [];
  for (let i = 0; i < byteLen; i += 1) {
    parts.push(((seedByte + i * 17) & 0xff).toString(16).padStart(2, "0"));
  }
  return `0x${parts.join("")}`;
}

const STELLAR_CHAIN = "stellar-testnet";
const EVM_CHAIN = "sepolia";
const FIRST_STELLAR_LEDGER = 4_965_951;
const STELLAR_OUT_LEDGER = 4_976_500;
const TARGET_STELLAR_LEDGER = 4_977_000;

const SENDER_EVM = dynamicHex(0x11, 20);
const RECIPIENT_EVM = dynamicHex(0x22, 20);
const SETTLER_EVM = dynamicHex(0x33, 20);
const TOKEN_EVM = dynamicHex(0x44, 20);

const DEST_STELLAR_STRKEY = encodeStellarAddress(AddressKind.Account, dynamicHex(0x55, 32));
const STELLAR_TOKEN_STRKEY = encodeStellarAddress(AddressKind.Contract, dynamicHex(0x56, 32));
const RAIL_REF_1 = dynamicHex(0x61, 32);
const RAIL_REF_2 = dynamicHex(0x62, 32);
const MSG_ID_PARKED = dynamicHex(0x71, 32);
const MSG_ID_LANDED = dynamicHex(0x72, 32);

const TX_BLOCK_10 = dynamicHex(0x81, 32);
const TX_BLOCK_20 = dynamicHex(0x82, 32);
const TX_BLOCK_42 = dynamicHex(0x83, 32);
const TX_BLOCK_48 = dynamicHex(0x84, 32);

// Wide uint256 (> 2^128) and u64 (> 2^63) values to exercise full-width integer preservation.
const WIDE_GROSS = (1n << 200n) + 999_999n;
const WIDE_FEE = 999_999n;
const WIDE_NET = 1n << 200n;
const WIDE_NONCE = (1n << 63n) + 77n;
const WIDE_CLAIM_ID = (1n << 63n) + 501n;

function buildSourceEvmLogs() {
  return [
    // Block 10: EVM -> Stellar outbound transfer #1 (route 0 / CCTP)
    encodedLog(
      "BridgeOut",
      {
        route: 0,
        nonce: 1001n,
        sender: SENDER_EVM,
        token: TOKEN_EVM,
        grossAmount: 5_005_000n,
        fee: 5_000n,
        netAmount: 5_000_000n,
        destinationChain: STELLAR_CHAIN,
        destinationAddress: DEST_STELLAR_STRKEY,
        railRef: RAIL_REF_1,
      },
      { blockNumber: 10n, logIndex: 0, txHash: TX_BLOCK_10 },
    ),
    // Block 20: Parked inbound delivery on EVM (ClaimParked + BridgeIn in same tx)
    encodedLog(
      "ClaimParked",
      {
        id: WIDE_CLAIM_ID,
        recipient: RECIPIENT_EVM,
        token: TOKEN_EVM,
        amount: 2_500_000n,
        route: 0,
        sourceChain: STELLAR_CHAIN,
        sourceNonce: 1n,
      },
      { blockNumber: 20n, logIndex: 0, txHash: TX_BLOCK_20 },
    ),
    encodedLog(
      "BridgeIn",
      {
        route: 0,
        recipient: RECIPIENT_EVM,
        token: TOKEN_EVM,
        amount: 2_500_000n,
        sourceChain: STELLAR_CHAIN,
        sourceNonce: 1n,
        messageId: MSG_ID_PARKED,
      },
      { blockNumber: 20n, logIndex: 1, txHash: TX_BLOCK_20 },
    ),
    // Block 42: Settlement of parked claim + direct landed BridgeIn
    encodedLog(
      "ClaimSettled",
      {
        id: WIDE_CLAIM_ID,
        recipient: RECIPIENT_EVM,
        token: TOKEN_EVM,
        amount: 2_500_000n,
        settledBy: SETTLER_EVM,
      },
      { blockNumber: 42n, logIndex: 0, txHash: TX_BLOCK_42 },
    ),
    encodedLog(
      "BridgeIn",
      {
        route: 0,
        recipient: RECIPIENT_EVM,
        token: TOKEN_EVM,
        amount: 8_750_000n,
        sourceChain: STELLAR_CHAIN,
        sourceNonce: 2n,
        messageId: MSG_ID_LANDED,
      },
      { blockNumber: 42n, logIndex: 1, txHash: TX_BLOCK_42 },
    ),
    // Block 48: Wide uint256 / u64 outbound transfer #2 (route 0 / CCTP)
    encodedLog(
      "BridgeOut",
      {
        route: 0,
        nonce: WIDE_NONCE,
        sender: SENDER_EVM,
        token: TOKEN_EVM,
        grossAmount: WIDE_GROSS,
        fee: WIDE_FEE,
        netAmount: WIDE_NET,
        destinationChain: STELLAR_CHAIN,
        destinationAddress: DEST_STELLAR_STRKEY,
        railRef: RAIL_REF_2,
      },
      { blockNumber: 48n, logIndex: 0, txHash: TX_BLOCK_48 },
    ),
  ];
}

function buildSourceStellarEvents() {
  return [
    ...ROUTER_HISTORY,
    syntheticEvent({
      ledger: STELLAR_OUT_LEDGER,
      txHash: dynamicHex(0x95, 32).slice(2),
      topicJson: [{ symbol: "hyperion" }, { symbol: "out" }],
      valueJson: {
        map: [
          {
            key: { symbol: "transfer" },
            val: {
              map: [
                { key: { symbol: "route" }, val: { u32: 0 } },
                { key: { symbol: "nonce" }, val: { u64: "9" } },
                { key: { symbol: "sender" }, val: { address: DEST_STELLAR_STRKEY } },
                { key: { symbol: "token" }, val: { address: STELLAR_TOKEN_STRKEY } },
                { key: { symbol: "gross_amount" }, val: { i128: "3003000" } },
                { key: { symbol: "fee" }, val: { i128: "3000" } },
                { key: { symbol: "net_amount" }, val: { i128: "3000000" } },
                { key: { symbol: "destination_chain" }, val: { string: EVM_CHAIN } },
                {
                  key: { symbol: "destination" },
                  val: { bytes: `000000000000000000000000${RECIPIENT_EVM.slice(2)}` },
                },
                { key: { symbol: "created_ledger" }, val: { u32: STELLAR_OUT_LEDGER } },
                { key: { symbol: "created_at" }, val: { u64: "1790856800" } },
              ],
            },
          },
        ],
      },
    }),
  ];
}

function createMockCctpClient(): RailClient {
  return {
    rail: "cctp",
    look(transfer: PendingTransfer) {
      // Provider reports "complete", which must map only to "attested" unless inbound_delivery exists.
      return Promise.resolve({
        kind: "found",
        report: {
          status: "attested",
          railStatus: "complete",
          reference: `iris-attestation-${transfer.originChain}-${transfer.nonce.toString()}`,
          attestedAt: new Date("2026-10-12T00:00:00.000Z"),
        },
      });
    },
  };
}

describe("Indexed-history restore reconciliation runner (#145)", () => {
  const sourceStellarEvents = buildSourceStellarEvents();
  const expectedRanges: readonly ChainExpectedRange[] = [
    {
      chainKey: STELLAR_CHAIN,
      family: "stellar",
      contract: LIVE_ROUTER,
      fromHeight: BigInt(FIRST_STELLAR_LEDGER),
      targetHeight: BigInt(TARGET_STELLAR_LEDGER),
      expectedEventHeights: [
        ...new Set(
          sourceStellarEvents
            .filter((e) => decodeStellarEvent(e).kind === "bridgeOut")
            .map((e) => BigInt(e.ledger)),
        ),
      ],
    },
    {
      chainKey: EVM_CHAIN,
      family: "evm",
      contract: ANVIL_ROUTER,
      fromHeight: 1n,
      targetHeight: 50n,
      expectedEventHeights: [10n, 20n, 42n, 48n],
    },
  ];

  it("flags incomplete backup restores and reconciles to verified digests via safe missing-interval replay without duplicates", async () => {
    const referenceDb = await createMigratedPGliteDb();
    const restoredDb = await createMigratedPGliteDb();

    try {
      const { logger } = capturingLogger();
      const sourceLogs = buildSourceEvmLogs();

      // 1. Index full source history into referenceDb to obtain verified ground-truth digests.
      const refStellarRpc = new FakeRpc({
        events: sourceStellarEvents,
        latestLedger: TARGET_STELLAR_LEDGER,
      });
      const refEvmClient = new FakeEvmClient({
        logs: sourceLogs,
        head: 53n, // confirmations=3 -> confirmed height 50n
      });
      const refStellarWatcher = new StellarWatcher({
        chainKey: STELLAR_CHAIN,
        router: LIVE_ROUTER,
        startLedger: FIRST_STELLAR_LEDGER,
        pageSize: 100,
        rpc: refStellarRpc,
        db: referenceDb,
        logger,
      });
      const refEvmWatcher = new EvmWatcher({
        chainKey: EVM_CHAIN,
        router: ANVIL_ROUTER,
        chainId: ANVIL_CHAIN_ID,
        startBlock: 1n,
        confirmations: 3,
        reorgDepth: 5,
        logRange: 25,
        client: refEvmClient,
        db: referenceDb,
        logger,
      });
      const refClockMs = Date.parse("2026-10-12T01:00:00.000Z");
      const refRailPass = new RailPass({
        route: 0,
        client: createMockCctpClient(),
        db: referenceDb,
        logger,
        batchSize: 50,
        recheckAfterMs: 1_000,
        maxCheckFailures: 5,
        now: () => new Date(refClockMs),
      });

      await replayMissingHistoryIntervals({
        db: referenceDb,
        watchers: [refStellarWatcher, refEvmWatcher],
        railPasses: [refRailPass],
      });

      const referenceSnapshot = await readDatabaseHistorySnapshot(referenceDb);
      expect(referenceSnapshot.outbound.length).toBeGreaterThanOrEqual(3);
      expect(referenceSnapshot.inbound).toHaveLength(2);
      expect(referenceSnapshot.claims).toHaveLength(1);
      expect(referenceSnapshot.claims[0]?.settled).toBe(true);
      expect(referenceSnapshot.attestations.length).toBeGreaterThanOrEqual(2);

      // Verify provider status alone never marked unlanded outbound transfers as "delivered".
      const unlandedAttestation = referenceSnapshot.attestations.find(
        (a) => a.originChain === EVM_CHAIN && a.nonce === "1001",
      );
      expect(unlandedAttestation?.status).toBe("attested");

      // 2. Simulate restoring an older backup into restoredDb:
      //    - EVM only indexed up to block 25 (head was 28), missing blocks 26..50 (settlement at 42, landed BridgeIn at 42, wide BridgeOut at 48)
      //    - Stellar only indexed up to ledger 4_968_000, behind TARGET_STELLAR_LEDGER
      const backupStellarRpc = new FakeRpc({
        events: sourceStellarEvents.filter((e) => e.ledger <= 4_968_000),
        latestLedger: 4_968_000,
      });
      const backupEvmClient = new FakeEvmClient({
        logs: sourceLogs.filter((l) => l.blockNumber <= 25n),
        head: 28n, // confirmed = 25n
      });
      const backupStellarWatcher = new StellarWatcher({
        chainKey: STELLAR_CHAIN,
        router: LIVE_ROUTER,
        startLedger: FIRST_STELLAR_LEDGER,
        pageSize: 100,
        rpc: backupStellarRpc,
        db: restoredDb,
        logger,
      });
      const backupEvmWatcher = new EvmWatcher({
        chainKey: EVM_CHAIN,
        router: ANVIL_ROUTER,
        chainId: ANVIL_CHAIN_ID,
        startBlock: 1n,
        confirmations: 3,
        reorgDepth: 5,
        logRange: 25,
        client: backupEvmClient,
        db: restoredDb,
        logger,
      });
      let restoredClockMs = Date.parse("2026-10-12T01:00:00.000Z");
      const restoredRailPass = new RailPass({
        route: 0,
        client: createMockCctpClient(),
        db: restoredDb,
        logger,
        batchSize: 50,
        recheckAfterMs: 1_000,
        maxCheckFailures: 5,
        now: () => new Date(restoredClockMs),
      });

      await replayMissingHistoryIntervals({
        db: restoredDb,
        watchers: [backupStellarWatcher, backupEvmWatcher],
        railPasses: [restoredRailPass],
      });

      // Check reconciliation right after restore: incomplete coverage MUST be visible!
      const beforeReplay = await reconcileRestoredDatabase({
        db: restoredDb,
        expectedRanges,
        reference: referenceSnapshot,
      });

      expect(beforeReplay.complete).toBe(false);
      expect(beforeReplay.digestsMatch.monetaryAndClaims).toBe(false);

      const evmCoverageBefore = beforeReplay.chains.find((c) => c.chainKey === EVM_CHAIN);
      expect(evmCoverageBefore?.cursorPosition).toBe(25n);
      expect(evmCoverageBefore?.cursorLag).toBe(25n);
      expect(evmCoverageBefore?.missingIntervals).toContainEqual({ from: 26n, to: 50n });

      const stellarCoverageBefore = beforeReplay.chains.find((c) => c.chainKey === STELLAR_CHAIN);
      expect(stellarCoverageBefore?.cursorLag).toBeGreaterThan(0n);

      // Claim parked at block 20 is still unsettled in backup, so claims digest mismatches as field_mismatch.
      expect(
        beforeReplay.digestMismatches.some(
          (m) => m.category === "claims" && m.reason === "field_mismatch",
        ),
      ).toBe(true);
      expect(
        beforeReplay.digestMismatches.some(
          (m) => m.category === "outbound" && m.reason === "missing_in_db",
        ),
      ).toBe(true);

      // 3. Replay missing intervals AND an overlapping window (rewind EVM cursor back to block 15
      //    so block 20's ClaimParked + BridgeIn is replayed alongside blocks 26..50, and advance clock for RailPass).
      const replayStellarRpc = new FakeRpc({
        events: sourceStellarEvents,
        latestLedger: TARGET_STELLAR_LEDGER,
      });
      const replayEvmClient = new FakeEvmClient({
        logs: sourceLogs,
        head: 53n,
      });
      const replayStellarWatcher = new StellarWatcher({
        chainKey: STELLAR_CHAIN,
        router: LIVE_ROUTER,
        startLedger: FIRST_STELLAR_LEDGER,
        pageSize: 100,
        rpc: replayStellarRpc,
        db: restoredDb,
        logger,
      });
      const replayEvmWatcher = new EvmWatcher({
        chainKey: EVM_CHAIN,
        router: ANVIL_ROUTER,
        chainId: ANVIL_CHAIN_ID,
        startBlock: 1n,
        confirmations: 3,
        reorgDepth: 5,
        logRange: 20,
        client: replayEvmClient,
        db: restoredDb,
        logger,
      });

      restoredClockMs += 5_000;
      await replayMissingHistoryIntervals({
        db: restoredDb,
        rewindCursors: [
          {
            chainKey: EVM_CHAIN,
            rewindToHeight: 15n,
            rewindHash: replayEvmClient.stampFor(15n).hash,
          },
        ],
        watchers: [replayStellarWatcher, replayEvmWatcher],
        railPasses: [restoredRailPass],
      });

      // Run a second overlapping replay pass to prove complete idempotence (zero duplicates).
      restoredClockMs += 5_000;
      await replayMissingHistoryIntervals({
        db: restoredDb,
        rewindCursors: [
          {
            chainKey: EVM_CHAIN,
            rewindToHeight: 1n,
            rewindHash: replayEvmClient.stampFor(1n).hash,
          },
          {
            chainKey: STELLAR_CHAIN,
            rewindToHeight: null,
          },
        ],
        watchers: [replayStellarWatcher, replayEvmWatcher],
        railPasses: [restoredRailPass],
      });

      const afterReplay = await reconcileRestoredDatabase({
        db: restoredDb,
        expectedRanges,
        reference: referenceSnapshot,
      });

      expect(afterReplay.complete).toBe(true);
      expect(afterReplay.digestMismatches).toEqual([]);
      expect(afterReplay.unbackedDeliveredAttestations).toEqual([]);
      expect(afterReplay.actualDigests).toEqual(afterReplay.expectedDigests);
      expect(afterReplay.rowCounts).toEqual({
        outboundCount: referenceSnapshot.outbound.length,
        inboundCount: referenceSnapshot.inbound.length,
        claimCount: referenceSnapshot.claims.length,
        attestationCount: referenceSnapshot.attestations.length,
      });
    } finally {
      await referenceDb.close();
      await restoredDb.close();
    }
  }, 30_000);

  it("detects monetary single-unit drift and rejects unbacked delivered rail attestations", async () => {
    const db = await createMigratedPGliteDb();
    try {
      const { logger } = capturingLogger();
      const evmClient = new FakeEvmClient({
        logs: buildSourceEvmLogs(),
        head: 53n,
      });
      const watcher = new EvmWatcher({
        chainKey: EVM_CHAIN,
        router: ANVIL_ROUTER,
        chainId: ANVIL_CHAIN_ID,
        startBlock: 1n,
        confirmations: 3,
        reorgDepth: 5,
        logRange: 50,
        client: evmClient,
        db,
        logger,
      });
      const pass = new RailPass({
        route: 0,
        client: createMockCctpClient(),
        db,
        logger,
        batchSize: 50,
        recheckAfterMs: 1_000,
        maxCheckFailures: 5,
      });

      await replayMissingHistoryIntervals({
        db,
        watchers: [watcher],
        railPasses: [pass],
      });

      const cleanReference = await readDatabaseHistorySnapshot(db);
      const evmRangeOnly: readonly ChainExpectedRange[] = [
        {
          chainKey: EVM_CHAIN,
          family: "evm",
          contract: ANVIL_ROUTER,
          fromHeight: 1n,
          targetHeight: 50n,
          expectedEventHeights: [10n, 20n, 42n, 48n],
        },
      ];

      const baselineReport = await reconcileRestoredDatabase({
        db,
        expectedRanges: evmRangeOnly,
        reference: cleanReference,
      });
      expect(baselineReport.complete).toBe(true);

      // Corrupt wide uint256 net_amount by 1 (while keeping gross_amount = fee + net_amount valid for CHECK constraint)
      // and force rail_attestation.status = 'delivered' without a destination inbound_delivery row.
      await db.query(
        `UPDATE outbound_transfer
            SET fee = (fee - 1),
                net_amount = (net_amount + 1)
          WHERE origin_chain = $1 AND nonce = $2`,
        [EVM_CHAIN, WIDE_NONCE.toString()],
      );
      await db.query(
        `UPDATE rail_attestation
            SET status = 'delivered'
          WHERE transfer_id IN (
            SELECT id FROM outbound_transfer WHERE origin_chain = $1 AND nonce = '1001'
          )`,
        [EVM_CHAIN],
      );

      const corruptedReport = await reconcileRestoredDatabase({
        db,
        expectedRanges: evmRangeOnly,
        reference: cleanReference,
      });

      expect(corruptedReport.complete).toBe(false);
      expect(corruptedReport.digestsMatch.outbound).toBe(false);
      expect(corruptedReport.digestsMatch.monetaryAndClaims).toBe(false);
      expect(
        corruptedReport.digestMismatches.some(
          (m) =>
            m.category === "outbound" &&
            m.key === `${EVM_CHAIN}:${WIDE_NONCE.toString()}` &&
            m.reason === "field_mismatch",
        ),
      ).toBe(true);
      expect(corruptedReport.unbackedDeliveredAttestations).toEqual([
        { originChain: EVM_CHAIN, nonce: "1001", route: 0 },
      ]);
    } finally {
      await db.close();
    }
  });
});
