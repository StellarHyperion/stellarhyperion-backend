import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { EvmWatcher, evmEventRef } from "../../src/chains/evm/watcher.js";
import { readCursor } from "../../src/chains/stellar/store.js";
import { StellarWatcher } from "../../src/chains/stellar/watcher.js";
import {
  MAX_REJECTED_ERROR_MESSAGE_LENGTH,
  MAX_REJECTED_PAYLOAD_PREVIEW_LENGTH,
  listRejectedEvents,
  readRejectedEvent,
  replayRejectedEvents,
  writeOutbound,
  writeRejectedEvent,
} from "../../src/chains/writers.js";
import type { Queryable, QueryResultRows, Transactional } from "../../src/db/pool.js";
import {
  ANVIL_CHAIN_ID,
  ANVIL_ROUTER,
  ANVIL_START_BLOCK,
  FakeEvmClient,
  encodedLog,
} from "../evm-fakes.js";
import {
  FakeRpc,
  LIVE_ROUTER,
  ROUTER_HISTORY,
  capturingLogger,
  syntheticEvent,
  toid,
} from "../stellar-fakes.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

const pg = new PGlite();

function normalizeRows(result: {
  readonly rows: readonly unknown[];
  readonly fields: readonly { readonly name: string; readonly dataTypeID: number }[];
  readonly affectedRows?: number;
}): QueryResultRows {
  const int8Columns = result.fields
    .filter((field) => field.dataTypeID === 20)
    .map((field) => field.name);
  const rows = result.rows.map((raw) => {
    const row = { ...(raw as Record<string, unknown>) };
    for (const column of int8Columns) {
      const value = row[column];
      if (typeof value === "number" || typeof value === "bigint") {
        row[column] = String(value);
      }
    }
    return row;
  });
  return { rows, rowCount: result.affectedRows ?? rows.length };
}

class PgliteDb implements Transactional {
  async query(text: string, params: readonly unknown[] = []): Promise<QueryResultRows> {
    const res = await pg.query(text, [...params]);
    return normalizeRows(res);
  }

  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    await pg.exec("BEGIN");
    try {
      const value = await work(this);
      await pg.exec("COMMIT");
      return value;
    } catch (error) {
      await pg.exec("ROLLBACK");
      throw error;
    }
  }
}

describe("durable rejected-event records", () => {
  const db = new PgliteDb();

  beforeAll(async () => {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const fullSql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      const upSql = fullSql.split("-- Down Migration")[0] ?? fullSql;
      await pg.exec(upSql);
    }
  });

  beforeEach(async () => {
    await pg.exec(`
      TRUNCATE TABLE
        rejected_event,
        rail_attestation,
        route_health,
        admin_action,
        pending_claim,
        inbound_delivery,
        outbound_transfer,
        indexer_cursor
      RESTART IDENTITY CASCADE;
    `);
  });

  afterAll(async () => {
    await pg.close();
  });

  it("prevents a failed Stellar event from advancing the committed cursor and reconciles on replay", async () => {
    const chainKey = "stellar-testnet";
    const startLedger = 4_965_951;
    const validQueued = ROUTER_HISTORY.find((event) => event.topicJson[1]?.symbol === "queued");
    if (validQueued === undefined) {
      throw new Error("expected captured queued event in stellar fixture");
    }

    const malformedId = `${toid(startLedger + 1)
      .toString()
      .padStart(19, "0")}-0000000000`;
    const malformedEvent = syntheticEvent({
      ledger: startLedger + 1,
      id: malformedId,
      txHash: "tx-malformed-bridge-out",
      topicJson: [{ symbol: "hyperion" }, { symbol: "out" }],
      // Missing required out map fields triggers ScValError during ingestion.
      valueJson: { map: [] },
    });

    const { logger } = capturingLogger();
    const failingWatcher = new StellarWatcher({
      chainKey,
      router: LIVE_ROUTER,
      startLedger,
      pageSize: 200,
      rpc: new FakeRpc({
        events: [validQueued, malformedEvent],
        latestLedger: startLedger + 5,
      }),
      db,
      logger,
    });

    await expect(failingWatcher.tick(AbortSignal.timeout(5_000))).rejects.toThrow();

    // Neither the cursor nor the earlier valid event in the rolled-back batch committed.
    expect(await readCursor(db, chainKey)).toBeNull();
    const uncommittedActions = await db.query("SELECT * FROM admin_action WHERE chain = $1", [
      chainKey,
    ]);
    expect(uncommittedActions.rows).toHaveLength(0);

    // The durable rejection record survived outside the rolled-back transaction.
    const rejected = await readRejectedEvent(db, chainKey, LIVE_ROUTER, malformedId);
    expect(rejected).not.toBeNull();
    expect(rejected?.family).toBe("stellar");
    expect(rejected?.blockNumber).toBe(BigInt(startLedger + 1));
    expect(rejected?.txHash).toBe("tx-malformed-bridge-out");
    expect(rejected?.eventTag).toBe("hyperion:out");
    expect(rejected?.errorClass).toBe("decode_error");
    expect(rejected?.replayEligible).toBe(true);
    expect(rejected?.status).toBe("rejected");
    expect(rejected?.failureCount).toBe(1);
    expect(rejected?.reconciledAt).toBeNull();

    // Replaying the corrected event stream advances the cursor and marks the rejection reconciled.
    const correctedBridgeOut =
      ROUTER_HISTORY.find((event) => event.topicJson[1]?.symbol === "out") ?? validQueued;
    const fixedSameId = {
      ...correctedBridgeOut,
      ledger: startLedger + 1,
      id: malformedId,
      txHash: "tx-malformed-bridge-out",
    };

    const replayWatcher = new StellarWatcher({
      chainKey,
      router: LIVE_ROUTER,
      startLedger,
      pageSize: 200,
      rpc: new FakeRpc({
        events: [validQueued, fixedSameId],
        latestLedger: startLedger + 5,
      }),
      db,
      logger,
    });

    await replayWatcher.tick(AbortSignal.timeout(5_000));

    const cursorAfterReplay = await readCursor(db, chainKey);
    expect(cursorAfterReplay?.position).toBe(BigInt(startLedger + 5));

    const reconciled = await readRejectedEvent(db, chainKey, LIVE_ROUTER, malformedId);
    expect(reconciled?.status).toBe("reconciled");
    expect(reconciled?.reconciledAt).toBeInstanceOf(Date);
    expect(reconciled?.reconciledTx).toBe("tx-malformed-bridge-out");
  });

  it("captures EVM constraint violations without advancing cursor and marks non-replayable until overridden", async () => {
    const chainKey = "sepolia";
    const badTx = `0x${"ab".repeat(32)}` as const;
    const badSplitLog = encodedLog(
      "BridgeOut",
      {
        nonce: 99n,
        route: 0,
        sender: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
        token: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
        // Violates outbound_transfer_amounts: 1000 != 10 + 980.
        grossAmount: 1_000n,
        fee: 10n,
        netAmount: 980n,
        destinationChain: "stellar-testnet",
        destinationAddress: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        railRef: `0x${"0".repeat(64)}`,
      },
      { blockNumber: 25n, logIndex: 3, txHash: badTx },
    );

    const { logger } = capturingLogger();
    const client = new FakeEvmClient({ logs: [badSplitLog], head: 40n });
    const watcher = new EvmWatcher({
      chainKey,
      router: ANVIL_ROUTER,
      chainId: ANVIL_CHAIN_ID,
      startBlock: ANVIL_START_BLOCK,
      confirmations: 3,
      reorgDepth: 5,
      logRange: 100,
      client,
      db,
      logger,
    });

    await expect(watcher.tick(AbortSignal.timeout(5_000))).rejects.toThrow();

    expect(await readCursor(db, chainKey)).toBeNull();
    const ref = evmEventRef(badSplitLog);
    const rejected = await readRejectedEvent(db, chainKey, ANVIL_ROUTER.toLowerCase(), ref);
    expect(rejected).not.toBeNull();
    expect(rejected?.family).toBe("evm");
    expect(rejected?.logIndex).toBe(3);
    expect(rejected?.errorClass).toBe("constraint_violation");
    expect(rejected?.errorCode).toBe("23514");
    expect(rejected?.replayEligible).toBe(false);
    expect(rejected?.status).toBe("rejected");
  });

  it("scrubs credentials, bounds payload and error lengths, and enforces replay failure ceilings", async () => {
    const chainKey = "stellar-testnet";
    const dbCredUrl = [
      "postgres://",
      "indexer_user",
      ":",
      "super_secret_pw_99",
      "@db.internal:5432/hyperion",
    ].join("");
    const rpcCredUrl = [
      "https://rpc.example.org/v1?api_key=",
      "rpc_live_secret_token_12345",
      "&network=testnet",
    ].join("");
    const bearerHeader = ["Authorization: Bearer ", "eyJhbGciOiJIUzI1NiJ9.secretpayload"].join("");
    const stellarSeed = ["S", "B".repeat(55)].join("");

    const hugeError = new Error(
      `upstream failure on ${dbCredUrl} via ${rpcCredUrl} with ${bearerHeader} seed=${stellarSeed} ${"detail-".repeat(250)}`,
    );
    hugeError.name = "ScValError";

    const hugePayload = {
      amount: 115792089237316195423570985008687907853269984665640564039457584007913129639935n,
      endpoint: rpcCredUrl,
      auth: bearerHeader,
      seed: stellarSeed,
      padding: "payload-segment-".repeat(400),
    };

    await writeRejectedEvent(db, {
      chainKey,
      family: "stellar",
      contract: LIVE_ROUTER,
      blockNumber: 5_000_000n,
      txHash: "tx-bounded-1",
      eventRef: "0002147483648000000-0000000001",
      logIndex: null,
      eventTag: "hyperion:bridge_out",
      error: hugeError,
      payload: hugePayload,
      maxReplayFailures: 2,
    });

    const stored = await readRejectedEvent(
      db,
      chainKey,
      LIVE_ROUTER,
      "0002147483648000000-0000000001",
    );
    expect(stored).not.toBeNull();
    expect(stored!.errorMessage.length).toBeLessThanOrEqual(MAX_REJECTED_ERROR_MESSAGE_LENGTH);
    expect(stored!.payloadPreview!.length).toBeLessThanOrEqual(MAX_REJECTED_PAYLOAD_PREVIEW_LENGTH);
    expect(stored!.payloadTruncated).toBe(true);

    // Zero raw secrets survive in either error_message or payload_preview.
    for (const secretFragment of [
      "super_secret_pw_99",
      "rpc_live_secret_token_12345",
      "eyJhbGciOiJIUzI1NiJ9.secretpayload",
      stellarSeed,
    ]) {
      expect(stored!.errorMessage).not.toContain(secretFragment);
      expect(stored!.payloadPreview).not.toContain(secretFragment);
    }
    // Full-width uint256 integer-string amount is preserved verbatim in payload preview.
    expect(stored!.payloadPreview).toContain(
      '"115792089237316195423570985008687907853269984665640564039457584007913129639935"',
    );

    // First failed replay increments failure_count to 2 and hits maxReplayFailures=2 -> replayEligible=false.
    const firstPass = await replayRejectedEvents(db, {
      chainKey,
      maxReplayFailures: 2,
      apply: () => Promise.reject(new Error(`still broken at ${dbCredUrl}`)),
    });
    expect(firstPass).toEqual({ attempted: 1, reconciled: 0, failed: 1 });

    const afterFailedReplay = await readRejectedEvent(
      db,
      chainKey,
      LIVE_ROUTER,
      "0002147483648000000-0000000001",
    );
    expect(afterFailedReplay?.failureCount).toBe(2);
    expect(afterFailedReplay?.replayEligible).toBe(false);
    expect(afterFailedReplay?.errorMessage).not.toContain("super_secret_pw_99");

    // Subsequent replay skips exhausted record; re-enabling and applying valid write reconciles it.
    const skippedPass = await replayRejectedEvents(db, {
      chainKey,
      apply: () => Promise.resolve(undefined),
    });
    expect(skippedPass).toEqual({ attempted: 0, reconciled: 0, failed: 0 });

    await writeRejectedEvent(db, {
      chainKey,
      family: "stellar",
      contract: LIVE_ROUTER,
      blockNumber: 5_000_001n,
      txHash: "tx-replay-ok",
      eventRef: "0002147483648000000-0000000002",
      logIndex: null,
      eventTag: "hyperion:bridge_out",
      error: new Error("temporary failure"),
      replayEligible: true,
    });

    const successPass = await replayRejectedEvents(db, {
      chainKey,
      apply: async (tx, record) => {
        await writeOutbound(
          tx,
          {
            chainKey: record.chainKey,
            block: record.blockNumber,
            txHash: record.txHash,
            logIndex: null,
            observedAt: new Date("2026-10-15T00:00:00.000Z"),
          },
          {
            route: 0,
            nonce: 1n,
            sender: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
            token: LIVE_ROUTER,
            grossAmount: 1_000_000n,
            fee: 3_000n,
            netAmount: 997_000n,
            destinationChain: "base-sepolia",
            destination: `0x${"11".repeat(32)}`,
            railRef: null,
          },
        );
        return { reconciledTx: record.txHash };
      },
    });
    expect(successPass).toEqual({ attempted: 1, reconciled: 1, failed: 0 });

    const allRows = await listRejectedEvents(db, { chainKey });
    expect(allRows.map((row) => [row.eventRef, row.status])).toEqual([
      ["0002147483648000000-0000000001", "rejected"],
      ["0002147483648000000-0000000002", "reconciled"],
    ]);
  });
});
