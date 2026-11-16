import { AddressKind, encodeStellarAddress } from "@hyperion/protocol";
import type { Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EvmWatcher } from "../../src/chains/evm/watcher.js";
import { Database } from "../../src/db/pool.js";
import { RailPass } from "../../src/rails/pass.js";
import type { PendingTransfer, RailClient } from "../../src/rails/types.js";
import { ANVIL_CHAIN_ID, ANVIL_ROUTER, FakeEvmClient, encodedLog } from "../evm-fakes.js";
import {
  applyRepositoryMigrations,
  readDatabaseHistorySnapshot,
  reconcileRestoredDatabase,
  replayMissingHistoryIntervals,
  type ChainExpectedRange,
} from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const CONNECTION = process.env.TEST_DATABASE_URL;
const suite = CONNECTION === undefined ? describe.skip : describe;

function hexWord(seed: number, bytesLen: number): Hex {
  const hex: string[] = [];
  for (let i = 0; i < bytesLen; i += 1) {
    hex.push(((seed + i * 19) & 0xff).toString(16).padStart(2, "0"));
  }
  return `0x${hex.join("")}`;
}

suite("indexed-history restore reconciliation against real Postgres (#145)", () => {
  let db: Database;

  beforeAll(async () => {
    db = Database.open(CONNECTION ?? "", { applicationName: "hyperion-restore-reconcile-test" });
    await db.query("DROP SCHEMA IF EXISTS restore_reconcile_test CASCADE");
    await db.query("CREATE SCHEMA restore_reconcile_test");
    await db.query("SET search_path TO restore_reconcile_test");
    await applyRepositoryMigrations(db);
  });

  afterAll(async () => {
    await db.query("DROP SCHEMA IF EXISTS restore_reconcile_test CASCADE");
    await db.close();
  });

  it("reconciles truncated backup state against source digests without duplicate payouts or attestations", async () => {
    const { logger } = capturingLogger();
    const sender = hexWord(0x12, 20);
    const recipient = hexWord(0x23, 20);
    const token = hexWord(0x34, 20);
    const destStellar = encodeStellarAddress(AddressKind.Account, hexWord(0x45, 32));

    const logs = [
      encodedLog(
        "BridgeOut",
        {
          route: 0,
          nonce: 501n,
          sender,
          token,
          grossAmount: 10_010_000n,
          fee: 10_000n,
          netAmount: 10_000_000n,
          destinationChain: "stellar-testnet",
          destinationAddress: destStellar,
          railRef: hexWord(0x56, 32),
        },
        { blockNumber: 12n, logIndex: 0, txHash: hexWord(0x91, 32) },
      ),
      encodedLog(
        "BridgeIn",
        {
          route: 0,
          recipient,
          token,
          amount: 7_500_000n,
          sourceChain: "stellar-testnet",
          sourceNonce: 88n,
          messageId: hexWord(0x67, 32),
        },
        { blockNumber: 30n, logIndex: 0, txHash: hexWord(0x92, 32) },
      ),
    ];

    const railClient: RailClient = {
      rail: "cctp",
      look(t: PendingTransfer) {
        return Promise.resolve({
          kind: "found",
          report: {
            status: "attested",
            railStatus: "complete",
            reference: `iris-${t.nonce.toString()}`,
            attestedAt: new Date("2026-10-12T00:00:00.000Z"),
          },
        });
      },
    };

    const fullClient = new FakeEvmClient({ logs, head: 38n });
    const fullWatcher = new EvmWatcher({
      chainKey: "sepolia",
      router: ANVIL_ROUTER,
      chainId: ANVIL_CHAIN_ID,
      startBlock: 1n,
      confirmations: 3,
      reorgDepth: 5,
      logRange: 50,
      client: fullClient,
      db,
      logger,
    });
    const pass = new RailPass({
      route: 0,
      client: railClient,
      db,
      logger,
      batchSize: 20,
      recheckAfterMs: 0,
      maxCheckFailures: 5,
    });

    await replayMissingHistoryIntervals({
      db,
      watchers: [fullWatcher],
      railPasses: [pass],
    });
    const reference = await readDatabaseHistorySnapshot(db);

    // Truncate post-block-20 state to emulate restoring an older snapshot.
    await db.query("DELETE FROM inbound_delivery WHERE destination_block > 20");
    await db.query(
      "UPDATE indexer_cursor SET last_processed = 20, last_processed_hash = $1 WHERE chain_key = 'sepolia'",
      [fullClient.stampFor(20n).hash],
    );

    const ranges: readonly ChainExpectedRange[] = [
      {
        chainKey: "sepolia",
        family: "evm",
        contract: ANVIL_ROUTER,
        fromHeight: 1n,
        targetHeight: 35n,
        expectedEventHeights: [12n, 30n],
      },
    ];

    const incomplete = await reconcileRestoredDatabase({
      db,
      expectedRanges: ranges,
      reference,
    });
    expect(incomplete.complete).toBe(false);
    expect(incomplete.chains[0]?.cursorLag).toBe(15n);

    await replayMissingHistoryIntervals({
      db,
      rewindCursors: [
        {
          chainKey: "sepolia",
          rewindToHeight: 10n,
          rewindHash: fullClient.stampFor(10n).hash,
        },
      ],
      watchers: [fullWatcher],
      railPasses: [pass],
    });

    const reconciled = await reconcileRestoredDatabase({
      db,
      expectedRanges: ranges,
      reference,
    });
    expect(reconciled.complete).toBe(true);
    expect(reconciled.digestMismatches).toEqual([]);
  });
});
