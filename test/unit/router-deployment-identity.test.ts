import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { StrKey } from "@stellar/stellar-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  settleAction,
  settleClaim,
  writeAction,
  writeAttestation,
  writeClaim,
  writeInbound,
  writeOutbound,
  type Position,
} from "../../src/chains/writers.js";
import { loadConfig } from "../../src/config/config.js";
import type { Database, Queryable } from "../../src/db/pool.js";
import { LEGACY_UNSPECIFIED_ROUTER } from "../../src/db/rows.js";
import { buildServer } from "../../src/http/server.js";
import { processClaimSettlement } from "../../src/keeper/jobs/claims.js";
import { processTtlBump } from "../../src/keeper/jobs/ttl.js";
import { pendingForRail } from "../../src/rails/queue.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const STELLAR_ROUTER_V1 = StrKey.encodeContract(new Uint8Array(32).fill(0x11));
const STELLAR_SENDER = StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(0x33));
const STELLAR_RECIPIENT = StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(0x44));
const STELLAR_TOKEN = StrKey.encodeContract(new Uint8Array(32).fill(0x55));

const EVM_ROUTER_V1_MIXED = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa01";
const EVM_ROUTER_V1 = EVM_ROUTER_V1_MIXED.toLowerCase();
const EVM_ROUTER_V2 = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb02";
const EVM_RECIPIENT_WORD = `0x${"00".repeat(12)}${"66".repeat(20)}`;
const EVM_RECIPIENT = `0x${"66".repeat(20)}`;
const EVM_TOKEN = `0x${"77".repeat(20)}`;

function wrapPglite(pg: PGlite): Queryable & {
  transaction: <T>(fn: (tx: Queryable) => Promise<T>) => Promise<T>;
  ping: () => Promise<void>;
} {
  const queryable: Queryable = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      const result = await pg.query(sql, [...params]);
      const int8 = result.fields
        .filter((field) => field.dataTypeID === 20)
        .map((field) => field.name);
      const rows = result.rows.map((raw) => {
        const row = { ...(raw as Record<string, unknown>) };
        for (const column of int8) {
          const value = row[column];
          if (typeof value === "number" || typeof value === "bigint") {
            row[column] = String(value);
          }
        }
        return row;
      });
      return { rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  };
  return {
    ...queryable,
    transaction: async <T>(fn: (tx: Queryable) => Promise<T>): Promise<T> => {
      await pg.exec("BEGIN");
      try {
        const out = await fn(queryable);
        await pg.exec("COMMIT");
        return out;
      } catch (err) {
        await pg.exec("ROLLBACK");
        throw err;
      }
    },
    ping: async () => {
      await pg.query("SELECT 1");
    },
  };
}

function migrationParts(filename: string): { up: string; down: string } {
  const raw = readFileSync(new URL(`../../migrations/${filename}`, import.meta.url), "utf8");
  const [up, down = ""] = raw.split("-- Down Migration");
  return { up: up ?? "", down };
}

describe("router deployment identity in transfer uniqueness", () => {
  const pg = new PGlite();
  const db = wrapPglite(pg);
  const { logger } = capturingLogger();
  const config = loadConfig({
    env: completeEnv({
      KEEPER_ENABLED: "false",
    }),
  });
  const STELLAR_ROUTER_V2 =
    config.indexer.stellar?.routerContractId ??
    StrKey.encodeContract(new Uint8Array(32).fill(0x22));
  const app = buildServer({
    config,
    logger,
    db: db as unknown as Database,
    readiness: [],
    redis: { ping: () => Promise.resolve("PONG") },
  });

  beforeAll(async () => {
    for (const name of [
      "1790900000000_initial-schema.sql",
      "1791000000000_cursor-block-hash.sql",
      "1791100000000_cursor-autovacuum-tuning.sql",
      "1791200000000_router-deployment-identity.sql",
    ]) {
      await pg.exec(migrationParts(name).up);
    }
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await pg.close();
  });

  it("retains separate outbound, claim, and admin action histories when two routers reuse nonces and ids", async () => {
    const t0 = new Date("2026-10-10T10:00:00Z");
    const t1 = new Date("2026-10-10T11:00:00Z");

    const posV1: Position = {
      chainKey: "sepolia",
      contract: EVM_ROUTER_V1_MIXED,
      block: 100n,
      txHash: `0x${"a1".repeat(32)}`,
      logIndex: 0,
      observedAt: t0,
    };
    const posV2: Position = {
      chainKey: "sepolia",
      contract: EVM_ROUTER_V2,
      block: 200n,
      txHash: `0x${"b2".repeat(32)}`,
      logIndex: 0,
      observedAt: t1,
    };

    await writeOutbound(db, posV1, {
      route: 0,
      nonce: 1n,
      sender: EVM_RECIPIENT,
      token: EVM_TOKEN,
      grossAmount: 1_000_000n,
      fee: 1_000n,
      netAmount: 999_000n,
      destinationChain: "stellar-testnet",
      destination: STELLAR_RECIPIENT,
      railRef: "v1-ref",
    });

    await writeOutbound(db, posV2, {
      route: 0,
      nonce: 1n,
      sender: EVM_RECIPIENT,
      token: EVM_TOKEN,
      grossAmount: 5_000_000n,
      fee: 5_000n,
      netAmount: 4_995_000n,
      destinationChain: "stellar-testnet",
      destination: STELLAR_RECIPIENT,
      railRef: "v2-ref",
    });

    // Replaying V1 with updated block metadata updates V1 in place without touching V2.
    await writeOutbound(
      db,
      { ...posV1, block: 101n },
      {
        route: 0,
        nonce: 1n,
        sender: EVM_RECIPIENT,
        token: EVM_TOKEN,
        grossAmount: 1_000_000n,
        fee: 1_000n,
        netAmount: 999_000n,
        destinationChain: "stellar-testnet",
        destination: STELLAR_RECIPIENT,
        railRef: null,
      },
    );

    const { rows: transfers } = await db.query(
      `SELECT origin_router, gross_amount, rail_ref, origin_block
         FROM outbound_transfer
        WHERE origin_chain = 'sepolia' AND nonce = 1
        ORDER BY origin_router`,
    );
    expect(transfers).toEqual([
      {
        origin_router: EVM_ROUTER_V1,
        gross_amount: "1000000",
        rail_ref: "v1-ref",
        origin_block: "101",
      },
      {
        origin_router: EVM_ROUTER_V2,
        gross_amount: "5000000",
        rail_ref: "v2-ref",
        origin_block: "200",
      },
    ]);

    // Claims and admin actions with identical numeric IDs stay isolated per router deployment.
    await writeClaim(db, posV1, {
      claimId: 7n,
      recipient: EVM_RECIPIENT,
      token: EVM_TOKEN,
      amount: 999_000n,
      route: 0,
      sourceChain: "stellar-testnet",
      sourceRouter: STELLAR_ROUTER_V1,
      sourceNonce: 9n,
      createdAt: t0,
    });
    await writeClaim(db, posV2, {
      claimId: 7n,
      recipient: EVM_RECIPIENT,
      token: EVM_TOKEN,
      amount: 4_995_000n,
      route: 0,
      sourceChain: "stellar-testnet",
      sourceRouter: STELLAR_ROUTER_V2,
      sourceNonce: 9n,
      createdAt: t1,
    });

    const settledV1 = await settleClaim(
      db,
      { ...posV1, block: 105n, txHash: `0x${"c3".repeat(32)}` },
      7n,
      EVM_RECIPIENT,
    );
    expect(settledV1).toBe(true);

    const { rows: claims } = await db.query(
      `SELECT router, settled, source_router
         FROM pending_claim
        WHERE chain = 'sepolia' AND claim_id = 7
        ORDER BY router`,
    );
    expect(claims).toEqual([
      { router: EVM_ROUTER_V1, settled: true, source_router: STELLAR_ROUTER_V1 },
      { router: EVM_ROUTER_V2, settled: false, source_router: STELLAR_ROUTER_V2 },
    ]);

    await writeAction(db, posV1, {
      actionId: 3n,
      kind: 1,
      payload: { pause: true },
      eta: t0,
      expiresAt: t1,
    });
    await writeAction(db, posV2, {
      actionId: 3n,
      kind: 2,
      payload: { pause: false },
      eta: t1,
      expiresAt: null,
    });

    expect(await settleAction(db, posV2, 3n, "executed", EVM_RECIPIENT)).toBe(true);

    const { rows: actions } = await db.query(
      `SELECT router, state FROM admin_action WHERE chain = 'sepolia' AND action_id = 3 ORDER BY router`,
    );
    expect(actions).toEqual([
      { router: EVM_ROUTER_V1, state: "queued" },
      { router: EVM_ROUTER_V2, state: "executed" },
    ]);
  });

  it("isolates delivery, rail attestation queue, keeper queries, and HTTP lookups by router deployment", async () => {
    const t0 = new Date("2026-10-11T08:00:00Z");
    const t1 = new Date("2026-10-11T09:00:00Z");

    // Revision 1 on stellar-testnet emits nonce 50 and completes delivery on sepolia.
    await writeOutbound(
      db,
      {
        chainKey: "stellar-testnet",
        contract: STELLAR_ROUTER_V1,
        block: 5000n,
        txHash: "stellar-v1-nonce50",
        logIndex: null,
        observedAt: t0,
      },
      {
        route: 1,
        nonce: 50n,
        sender: STELLAR_SENDER,
        token: STELLAR_TOKEN,
        grossAmount: 10_000_000n,
        fee: 30_000n,
        netAmount: 9_970_000n,
        destinationChain: "sepolia",
        destination: EVM_RECIPIENT_WORD,
        railRef: null,
      },
    );

    // Destination BridgeIn without explicit sourceRouter resolves uniquely to STELLAR_ROUTER_V1.
    await writeInbound(
      db,
      {
        chainKey: "sepolia",
        contract: EVM_ROUTER_V1,
        block: 600n,
        txHash: `0x${"d4".repeat(32)}`,
        logIndex: 0,
        observedAt: t0,
      },
      {
        route: 1,
        sourceChain: "stellar-testnet",
        sourceNonce: 50n,
        railMessageId: `0x${"11".repeat(32)}`,
        recipient: EVM_RECIPIENT,
        token: EVM_TOKEN,
        amount: 9_970_000n,
        delivered: true,
        claimId: null,
      },
    );

    // Revision 2 on stellar-testnet is deployed later and ALSO emits nonce 50, still in flight.
    await writeOutbound(
      db,
      {
        chainKey: "stellar-testnet",
        contract: STELLAR_ROUTER_V2,
        block: 6000n,
        txHash: "stellar-v2-nonce50",
        logIndex: null,
        observedAt: t1,
      },
      {
        route: 1,
        nonce: 50n,
        sender: STELLAR_SENDER,
        token: STELLAR_TOKEN,
        grossAmount: 25_000_000n,
        fee: 50_000n,
        netAmount: 24_950_000n,
        destinationChain: "sepolia",
        destination: EVM_RECIPIENT_WORD,
        railRef: null,
      },
    );

    const queue = await pendingForRail(db, {
      route: 1,
      limit: 20,
      notCheckedSince: new Date("2026-10-12T00:00:00Z"),
      maxCheckFailures: 5,
    });
    const v1Pending = queue.find((item) => item.originRouter === STELLAR_ROUTER_V1);
    const v2Pending = queue.find((item) => item.originRouter === STELLAR_ROUTER_V2);
    expect(v1Pending?.delivered).toBe(true);
    expect(v2Pending?.delivered).toBe(false);

    if (!v2Pending) throw new Error("Expected V2 transfer in rail queue");
    await writeAttestation(db, {
      transferId: v2Pending.transferId,
      route: 1,
      status: "attested",
      railStatus: "approved",
      railReference: "gmp-v2-50",
      attestedAt: t1,
      checkedAt: t1,
      checkFailures: 0,
      lastError: null,
    });

    // HTTP explicit router lookup distinguishes V1 (delivered) from V2 (delivering).
    const v1Res = await app.inject(`/v1/transfers/stellar-testnet/${STELLAR_ROUTER_V1}/50`);
    expect(v1Res.statusCode).toBe(200);
    expect(v1Res.json().stage).toBe("delivered");
    expect(v1Res.json().origin.router).toBe(STELLAR_ROUTER_V1);
    expect(v1Res.json().origin.grossAmount).toBe("10000000");
    expect(v1Res.json().destination.router).toBe(EVM_ROUTER_V1);
    expect(v1Res.json().destination.delivered).toBe(true);

    const v2Res = await app.inject(`/v1/transfers/stellar-testnet/${STELLAR_ROUTER_V2}/50`);
    expect(v2Res.statusCode).toBe(200);
    expect(v2Res.json().stage).toBe("delivering");
    expect(v2Res.json().origin.router).toBe(STELLAR_ROUTER_V2);
    expect(v2Res.json().origin.grossAmount).toBe("25000000");
    expect(v2Res.json().destination.delivered).toBe(false);
    expect(v2Res.json().rail.reference).toBe("gmp-v2-50");

    // Legacy 2-segment path returns the latest revision when ?router= is omitted, and honors ?router=.
    const latestRes = await app.inject("/v1/transfers/stellar-testnet/50");
    expect(latestRes.statusCode).toBe(200);
    expect(latestRes.json().origin.router).toBe(STELLAR_ROUTER_V2);

    const filteredByQuery = await app.inject(
      `/v1/transfers/stellar-testnet/50?router=${STELLAR_ROUTER_V1}`,
    );
    expect(filteredByQuery.statusCode).toBe(200);
    expect(filteredByQuery.json().origin.router).toBe(STELLAR_ROUTER_V1);

    const listV1 = await app.inject(`/v1/transfers?router=${STELLAR_ROUTER_V1}`);
    expect(listV1.statusCode).toBe(200);
    expect(listV1.json().transfers).toHaveLength(1);
    expect(listV1.json().transfers[0].origin.router).toBe(STELLAR_ROUTER_V1);

    // When V2's BridgeIn later arrives without sourceRouter, it attributes to V2 (the remaining undelivered hop).
    await writeInbound(
      db,
      {
        chainKey: "sepolia",
        contract: EVM_ROUTER_V1,
        block: 650n,
        txHash: `0x${"e5".repeat(32)}`,
        logIndex: 1,
        observedAt: t1,
      },
      {
        route: 1,
        sourceChain: "stellar-testnet",
        sourceNonce: 50n,
        railMessageId: `0x${"22".repeat(32)}`,
        recipient: EVM_RECIPIENT,
        token: EVM_TOKEN,
        amount: 24_950_000n,
        delivered: true,
        claimId: null,
      },
    );

    const v2AfterArrival = await app.inject(
      `/v1/transfers/stellar-testnet/${STELLAR_ROUTER_V2}/50`,
    );
    expect(v2AfterArrival.json().stage).toBe("delivered");
    expect(v2AfterArrival.json().destination.amount).toBe("24950000");

    // Keeper jobs on STELLAR_ROUTER_V2 ignore unsettled claims parked on retired STELLAR_ROUTER_V1.
    await writeClaim(
      db,
      {
        chainKey: "stellar-testnet",
        contract: STELLAR_ROUTER_V1,
        block: 5100n,
        txHash: "stellar-v1-claim",
        logIndex: null,
        observedAt: t0,
      },
      {
        claimId: 99n,
        recipient: STELLAR_RECIPIENT,
        token: STELLAR_TOKEN,
        amount: 1_000n,
        route: 0,
        sourceChain: "sepolia",
        sourceRouter: EVM_ROUTER_V1,
        sourceNonce: 88n,
        createdAt: t0,
      },
    );
    await writeClaim(
      db,
      {
        chainKey: "stellar-testnet",
        contract: STELLAR_ROUTER_V2,
        block: 6100n,
        txHash: "stellar-v2-claim",
        logIndex: null,
        observedAt: t1,
      },
      {
        claimId: 99n,
        recipient: STELLAR_RECIPIENT,
        token: STELLAR_TOKEN,
        amount: 2_000n,
        route: 0,
        sourceChain: "sepolia",
        sourceRouter: EVM_ROUTER_V2,
        sourceNonce: 88n,
        createdAt: t1,
      },
    );

    const settlementDryRun = await processClaimSettlement({ config, db, logger });
    expect(settlementDryRun.pending).toBe(1);

    const ttlDryRun = await processTtlBump({ config, db, logger });
    expect(ttlDryRun.detail).toContain("1 claims, 1 transfers");

    const claimV1Res = await app.inject(`/v1/claims/stellar-testnet/${STELLAR_ROUTER_V1}/99`);
    expect(claimV1Res.statusCode).toBe(200);
    expect(claimV1Res.json().id).toBe("stellar-testnet:99");
    expect(claimV1Res.json().router).toBe(STELLAR_ROUTER_V1);
    expect(claimV1Res.json().amount).toBe("1000");

    const claimV2Res = await app.inject(`/v1/claims/stellar-testnet/${STELLAR_ROUTER_V2}/99`);
    expect(claimV2Res.statusCode).toBe(200);
    expect(claimV2Res.json().router).toBe(STELLAR_ROUTER_V2);
    expect(claimV2Res.json().amount).toBe("2000");
  });

  it("backfills pre-existing rows from indexer_cursor or legacy sentinel and supports down migration", async () => {
    const migPg = new PGlite();
    const migDb = wrapPglite(migPg);
    try {
      for (const name of [
        "1790900000000_initial-schema.sql",
        "1791000000000_cursor-block-hash.sql",
        "1791100000000_cursor-autovacuum-tuning.sql",
      ]) {
        await migPg.exec(migrationParts(name).up);
      }

      await migDb.query(
        `INSERT INTO indexer_cursor (chain_key, family, contract, last_processed, last_processed_hash)
         VALUES ('stellar-testnet', 'stellar', $1, 500, NULL),
                ('sepolia', 'evm', $2, 700, $3)`,
        [STELLAR_ROUTER_V1, EVM_ROUTER_V1_MIXED, `0x${"ab".repeat(32)}`],
      );

      await migPg.exec(`
        INSERT INTO outbound_transfer
          (origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
           destination_chain, destination, origin_block, origin_tx)
        VALUES
          ('stellar-testnet', 0, 11, 'Gsender', 'USDC', 1000, 10, 990, 'sepolia', '0xrecipient', 400, 'tx-known'),
          ('base-sepolia', 0, 12, '0xsender', 'USDC', 2000, 20, 1980, 'stellar-testnet', 'Grecip', 80, 'tx-orphan');

        INSERT INTO inbound_delivery
          (destination_chain, route, source_chain, source_nonce, rail_message_id, recipient, token,
           amount, delivered, claim_id, destination_block, destination_tx)
        VALUES
          ('sepolia', 0, 'stellar-testnet', 11, '0xmsg11', '0xrecipient', '0xusdc', 990, true, NULL, 650, '0xdest11');

        INSERT INTO pending_claim
          (chain, claim_id, recipient, token, amount, route, source_chain, source_nonce, created_at)
        VALUES
          ('stellar-testnet', 5, 'Grecip', 'USDC', 1980, 0, 'base-sepolia', 12, now());

        INSERT INTO admin_action
          (chain, action_id, kind, state, payload, queued_at)
        VALUES
          ('sepolia', 2, 1, 'queued', '{"ok":true}'::jsonb, now());
      `);

      const { up, down } = migrationParts("1791200000000_router-deployment-identity.sql");
      await migPg.exec(up);

      const { rows: migratedTransfers } = await migDb.query(
        `SELECT origin_chain, origin_router FROM outbound_transfer ORDER BY nonce`,
      );
      expect(migratedTransfers).toEqual([
        { origin_chain: "stellar-testnet", origin_router: STELLAR_ROUTER_V1 },
        { origin_chain: "base-sepolia", origin_router: LEGACY_UNSPECIFIED_ROUTER },
      ]);

      const { rows: migratedDeliveries } = await migDb.query(
        `SELECT destination_router, source_router FROM inbound_delivery`,
      );
      expect(migratedDeliveries).toEqual([
        { destination_router: EVM_ROUTER_V1, source_router: STELLAR_ROUTER_V1 },
      ]);

      const { rows: migratedClaims } = await migDb.query(
        `SELECT router, source_router FROM pending_claim`,
      );
      expect(migratedClaims).toEqual([
        { router: STELLAR_ROUTER_V1, source_router: LEGACY_UNSPECIFIED_ROUTER },
      ]);

      const { rows: migratedActions } = await migDb.query(`SELECT router FROM admin_action`);
      expect(migratedActions).toEqual([{ router: EVM_ROUTER_V1 }]);

      await migPg.exec(down);
      const { rows: postDown } = await migDb.query(
        `SELECT count(*)::int AS n FROM outbound_transfer`,
      );
      expect(postDown[0]?.n).toBe(2);
    } finally {
      await migPg.close();
    }
  });
});
