import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EvmWatcher } from "../../src/chains/evm/watcher.js";
import { StellarWatcher } from "../../src/chains/stellar/watcher.js";
import {
  MAX_PROVENANCE_ENVELOPE_BYTES,
  MAX_PROVENANCE_QUERY_LIMIT,
  ProvenanceConflictError,
  canonicalizePayload,
  listRawEventProvenance,
  pruneRawEventProvenance,
  recordRawEventProvenance,
} from "../../src/chains/writers.js";
import type { Queryable, Transactional } from "../../src/db/pool.js";
import {
  ANVIL_CHAIN_ID,
  ANVIL_HEAD,
  ANVIL_ROUTER,
  ANVIL_START_BLOCK,
  FakeEvmClient,
  encodedLog,
} from "../evm-fakes.js";
import { FakeRpc, LIVE_ROUTER, ROUTER_HISTORY, capturingLogger } from "../stellar-fakes.js";

const MIGRATIONS = [
  "1790900000000_initial-schema.sql",
  "1791000000000_cursor-block-hash.sql",
  "1791100000000_cursor-autovacuum-tuning.sql",
  "1791200000000_raw-event-provenance.sql",
] as const;

const RECIPIENT = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const TOKEN = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const SENDER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const STELLAR_DEST = "GC4FD5G3CZJ57VPYTVNWU4FRDLLV37EYDGT3OVZA35WKHBWDI6PKTYTN";

function createPgliteTransactional(pg: PGlite): Transactional {
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
    query: (sql, params) => queryable.query(sql, params),
    transaction: async <T>(work: (tx: Queryable) => Promise<T>): Promise<T> => {
      await pg.query("BEGIN");
      try {
        const result = await work(queryable);
        await pg.query("COMMIT");
        return result;
      } catch (error) {
        await pg.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    },
  };
}

function sqlErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

describe("immutable raw-event provenance storage", () => {
  let pg: PGlite;
  let db: Transactional;

  beforeAll(async () => {
    pg = new PGlite();
    db = createPgliteTransactional(pg);
    for (const file of MIGRATIONS) {
      const content = readFileSync(new URL(`../../migrations/${file}`, import.meta.url), "utf8");
      const [upSql] = content.split("-- Down Migration");
      if (upSql === undefined) {
        throw new Error(`missing up migration in ${file}`);
      }
      await pg.exec(upSql);
    }
  }, 30_000);

  afterAll(async () => {
    await pg.close();
  });

  it("links replayed EVM and Stellar history to the same raw provenance identity without duplicating facts", async () => {
    const evmChain = "evm-prov-replay";
    const stellarChain = "stellar-prov-replay";
    const { logger } = capturingLogger();

    const drainEvm = async (): Promise<void> => {
      const watcher = new EvmWatcher({
        chainKey: evmChain,
        router: ANVIL_ROUTER,
        chainId: ANVIL_CHAIN_ID,
        startBlock: ANVIL_START_BLOCK,
        confirmations: 0,
        reorgDepth: 5,
        logRange: 2_000,
        client: new FakeEvmClient({ head: ANVIL_HEAD }),
        db,
        logger,
      });
      while (await watcher.tick(AbortSignal.timeout(10_000))) {
        // catch up
      }
    };

    const drainStellar = async (): Promise<void> => {
      const watcher = new StellarWatcher({
        chainKey: stellarChain,
        router: LIVE_ROUTER,
        startLedger: 4_965_951,
        pageSize: 200,
        rpc: new FakeRpc({ events: ROUTER_HISTORY, latestLedger: 4_994_010 }),
        db,
        logger,
      });
      while (await watcher.tick(AbortSignal.timeout(10_000))) {
        // catch up
      }
    };

    await drainEvm();
    await drainStellar();

    const evmFirst = await listRawEventProvenance(db, { chainKey: evmChain, limit: 100 });
    const stellarFirst = await listRawEventProvenance(db, { chainKey: stellarChain, limit: 100 });
    expect(evmFirst.length).toBeGreaterThan(0);
    expect(stellarFirst.length).toBeGreaterThan(0);

    const outboundBefore = await db.query(
      "SELECT id, nonce, net_amount, provenance_id FROM outbound_transfer WHERE origin_chain = $1",
      [evmChain],
    );
    expect(outboundBefore.rows).toHaveLength(1);
    const firstTransfer = outboundBefore.rows[0];
    expect(firstTransfer?.provenance_id).not.toBeNull();

    // Replay both watchers from scratch after clearing cursors.
    await db.query("DELETE FROM indexer_cursor WHERE chain_key IN ($1, $2)", [
      evmChain,
      stellarChain,
    ]);
    await drainEvm();
    await drainStellar();

    const evmReplay = await listRawEventProvenance(db, { chainKey: evmChain, limit: 100 });
    const stellarReplay = await listRawEventProvenance(db, { chainKey: stellarChain, limit: 100 });
    expect(evmReplay.map((row) => row.id)).toEqual(evmFirst.map((row) => row.id));
    expect(evmReplay.map((row) => row.payloadSha256)).toEqual(
      evmFirst.map((row) => row.payloadSha256),
    );
    expect(stellarReplay.map((row) => row.id)).toEqual(stellarFirst.map((row) => row.id));

    const outboundAfter = await db.query(
      "SELECT id, nonce, net_amount, provenance_id FROM outbound_transfer WHERE origin_chain = $1",
      [evmChain],
    );
    expect(outboundAfter.rows).toEqual(outboundBefore.rows);
  });

  it("preserves original provenance when materialized claim rows settle later", async () => {
    const chain = "evm-prov-claim";
    const txPark = `0x${"11".repeat(32)}` as const;
    const txSettle = `0x${"22".repeat(32)}` as const;
    const messageId = `0x${"33".repeat(32)}` as const;

    const logs = [
      encodedLog(
        "ClaimParked",
        {
          id: 9n,
          recipient: RECIPIENT,
          token: TOKEN,
          amount: 750_000n,
          route: 0,
          sourceChain: "stellar-testnet",
          sourceNonce: 88n,
        },
        { blockNumber: 20n, logIndex: 0, txHash: txPark },
      ),
      encodedLog(
        "BridgeIn",
        {
          route: 0,
          recipient: RECIPIENT,
          token: TOKEN,
          amount: 750_000n,
          sourceChain: "stellar-testnet",
          sourceNonce: 88n,
          messageId,
        },
        { blockNumber: 20n, logIndex: 1, txHash: txPark },
      ),
      encodedLog(
        "ClaimSettled",
        {
          id: 9n,
          recipient: RECIPIENT,
          token: TOKEN,
          amount: 750_000n,
          settledBy: SENDER,
        },
        { blockNumber: 21n, logIndex: 0, txHash: txSettle },
      ),
    ];

    const { logger } = capturingLogger();
    const watcher = new EvmWatcher({
      chainKey: chain,
      router: ANVIL_ROUTER,
      chainId: ANVIL_CHAIN_ID,
      startBlock: 1n,
      confirmations: 0,
      reorgDepth: 5,
      logRange: 100,
      client: new FakeEvmClient({ logs, head: 25n }),
      db,
      logger,
    });
    await watcher.tick(AbortSignal.timeout(5_000));

    const claimRows = await db.query(
      "SELECT settled, settled_by, provenance_id FROM pending_claim WHERE chain = $1 AND claim_id = 9",
      [chain],
    );
    expect(claimRows.rows[0]?.settled).toBe(true);
    expect(claimRows.rows[0]?.provenance_id).not.toBeNull();

    const provenance = await listRawEventProvenance(db, {
      chainKey: chain,
      includeEnvelope: true,
    });
    expect(provenance.map((row) => row.eventTag)).toEqual([
      "ClaimParked",
      "BridgeIn",
      "ClaimSettled",
    ]);
    expect(String(claimRows.rows[0]?.provenance_id)).toBe(provenance[0]?.id.toString());

    // Foreign key ON DELETE RESTRICT protects provenance linked to a materialized row.
    await expect(
      db.query("DELETE FROM raw_event_provenance WHERE id = $1", [provenance[0]?.id.toString()]),
    ).rejects.toSatisfy((error: unknown) => {
      const code = sqlErrorCode(error);
      return code === "23001" || code === "23503";
    });
  });

  it("rejects conflicting payloads without overwriting original provenance or materialized transfers", async () => {
    const chain = "evm-prov-conflict";
    const txHash = `0x${"44".repeat(32)}` as const;
    const originalLog = encodedLog(
      "BridgeOut",
      {
        route: 0,
        nonce: 501n,
        sender: SENDER,
        token: TOKEN,
        grossAmount: 1_000_000n,
        fee: 3_000n,
        netAmount: 997_000n,
        destinationChain: "stellar-testnet",
        destinationAddress: STELLAR_DEST,
        railRef: `0x${"00".repeat(32)}`,
      },
      { blockNumber: 30n, logIndex: 0, txHash },
    );
    const tamperedLog = encodedLog(
      "BridgeOut",
      {
        route: 0,
        nonce: 501n,
        sender: SENDER,
        token: TOKEN,
        grossAmount: 9_000_000n,
        fee: 27_000n,
        netAmount: 8_973_000n,
        destinationChain: "stellar-testnet",
        destinationAddress: STELLAR_DEST,
        railRef: `0x${"00".repeat(32)}`,
      },
      { blockNumber: 30n, logIndex: 0, txHash },
    );

    const { logger, lines } = capturingLogger();
    const firstWatcher = new EvmWatcher({
      chainKey: chain,
      router: ANVIL_ROUTER,
      chainId: ANVIL_CHAIN_ID,
      startBlock: 1n,
      confirmations: 0,
      reorgDepth: 5,
      logRange: 100,
      client: new FakeEvmClient({ logs: [originalLog], head: 35n }),
      db,
      logger,
    });
    await firstWatcher.tick(AbortSignal.timeout(5_000));

    const storedBefore = await listRawEventProvenance(db, {
      chainKey: chain,
      includeEnvelope: true,
    });
    expect(storedBefore).toHaveLength(1);
    const originalDigest = storedBefore[0]?.payloadSha256;

    // Reset cursor and replay with tampered payload at the exact same source event identity.
    await db.query("DELETE FROM indexer_cursor WHERE chain_key = $1", [chain]);
    const secondWatcher = new EvmWatcher({
      chainKey: chain,
      router: ANVIL_ROUTER,
      chainId: ANVIL_CHAIN_ID,
      startBlock: 1n,
      confirmations: 0,
      reorgDepth: 5,
      logRange: 100,
      client: new FakeEvmClient({ logs: [tamperedLog], head: 35n }),
      db,
      logger,
    });
    await secondWatcher.tick(AbortSignal.timeout(5_000));

    expect(
      lines.some((entry) => entry.message.includes("conflicting raw event payload detected")),
    ).toBe(true);

    // Original provenance digest and envelope remain untouched.
    const storedAfter = await listRawEventProvenance(db, {
      chainKey: chain,
      includeEnvelope: true,
    });
    expect(storedAfter).toHaveLength(1);
    expect(storedAfter[0]?.payloadSha256).toBe(originalDigest);

    // Materialized transfer retains original integer-string amounts rather than tampered values.
    const transferRows = await db.query(
      "SELECT gross_amount, fee, net_amount FROM outbound_transfer WHERE origin_chain = $1 AND nonce = 501",
      [chain],
    );
    expect(transferRows.rows).toEqual([
      { gross_amount: "1000000", fee: "3000", net_amount: "997000" },
    ]);

    // Conflict audit table captured the discrepancy and also refuses UPDATE mutations.
    const conflicts = await db.query(
      "SELECT id, expected_payload_sha256, observed_payload_sha256 FROM raw_event_provenance_conflict WHERE chain_key = $1",
      [chain],
    );
    expect(conflicts.rows).toHaveLength(1);
    expect(conflicts.rows[0]?.expected_payload_sha256).toBe(originalDigest);
    expect(conflicts.rows[0]?.observed_payload_sha256).not.toBe(originalDigest);

    await expect(
      db.query("UPDATE raw_event_provenance SET payload_sha256 = $1 WHERE chain_key = $2", [
        "f".repeat(64),
        chain,
      ]),
    ).rejects.toSatisfy((error: unknown) => sqlErrorCode(error) === "23514");

    await expect(
      db.query(
        "UPDATE raw_event_provenance_conflict SET observed_payload_sha256 = $1 WHERE chain_key = $2",
        ["e".repeat(64), chain],
      ),
    ).rejects.toSatisfy((error: unknown) => sqlErrorCode(error) === "23514");

    // Direct strict mode throws ProvenanceConflictError on conflicting digest.
    await expect(
      recordRawEventProvenance(
        db,
        {
          chainKey: chain,
          family: "evm",
          contract: ANVIL_ROUTER.toLowerCase(),
          eventKey: `30:${txHash.toLowerCase()}:0`,
          blockNumber: 30n,
          blockHash: null,
          txHash,
          logIndex: 0,
          eventTag: "BridgeOut",
          retentionClass: "monetary",
          chainTimestamp: new Date("2026-10-10T00:00:00Z"),
          payload: { mutated: true },
        },
        { throwOnConflict: true },
      ),
    ).rejects.toThrow(ProvenanceConflictError);
  });

  it("enforces retention classes, batch bounds, query access limits, envelope bounds and credential redaction", async () => {
    const chain = "prov-bounds-test";
    const rpcCredentialUrl = ["https://indexer", "s3cr3t_pass@rpc.internal.example/v1"].join(":");
    const oversized = {
      authorization: "Bearer should-never-persist",
      endpoint: rpcCredentialUrl,
      token: TOKEN,
      zPadding: "x".repeat(MAX_PROVENANCE_ENVELOPE_BYTES + 2_048),
    };

    const canonical = canonicalizePayload(oversized);
    expect(canonical.truncated).toBe(true);
    expect(Buffer.byteLength(canonical.envelopeJson, "utf8")).toBeLessThanOrEqual(
      MAX_PROVENANCE_ENVELOPE_BYTES,
    );
    expect(canonical.envelopeJson).not.toContain("s3cr3t_pass");
    expect(canonical.envelopeJson).not.toContain("should-never-persist");
    expect(canonical.envelopeJson).toContain(TOKEN);

    await recordRawEventProvenance(db, {
      chainKey: chain,
      family: "stellar",
      contract: LIVE_ROUTER,
      eventKey: "monetary-old",
      blockNumber: 100n,
      blockHash: null,
      txHash: "tx-m-old",
      logIndex: null,
      eventTag: "bridgeOut",
      retentionClass: "monetary",
      chainTimestamp: new Date("2026-08-01T00:00:00Z"),
      payload: oversized,
    });

    for (const key of ["telemetry-old-1", "telemetry-old-2", "telemetry-fresh"]) {
      await recordRawEventProvenance(db, {
        chainKey: chain,
        family: "stellar",
        contract: LIVE_ROUTER,
        eventKey: key,
        blockNumber: 101n,
        blockHash: null,
        txHash: `tx-${key}`,
        logIndex: null,
        eventTag: "routeConfigured",
        retentionClass: "telemetry",
        chainTimestamp: new Date("2026-08-01T00:00:00Z"),
        payload: { key },
      });
    }

    // Age monetary-old and two telemetry rows past 30 days via a direct fixture setup before pruning
    //? Note: raw_event_provenance forbids UPDATE! Verify we can insert aged first_observed_at directly:
    await db.query(
      `INSERT INTO raw_event_provenance
         (chain_key, family, contract, event_key, block_number, tx_hash, event_tag,
          retention_class, payload_sha256, canonical_envelope, chain_timestamp, first_observed_at)
       VALUES
         ($1, 'stellar', $2, 'aged-monetary', 102, 'tx-am', 'bridgeOut', 'monetary', $3, '{"a":1}'::jsonb, now(), now() - INTERVAL '60 days'),
         ($1, 'stellar', $2, 'aged-telemetry-1', 103, 'tx-at1', 'routeConfigured', 'telemetry', $4, '{"a":2}'::jsonb, now(), now() - INTERVAL '60 days'),
         ($1, 'stellar', $2, 'aged-telemetry-2', 104, 'tx-at2', 'routeConfigured', 'telemetry', $5, '{"a":3}'::jsonb, now(), now() - INTERVAL '60 days')`,
      [chain, LIVE_ROUTER, "1".repeat(64), "2".repeat(64), "3".repeat(64)],
    );

    // Prune with batchLimit = 1 removes exactly 1 aged telemetry row and leaves aged monetary untouched.
    const prunedFirst = await pruneRawEventProvenance(db, { olderThanDays: 30, batchLimit: 1 });
    expect(prunedFirst).toBe(1);

    const prunedSecond = await pruneRawEventProvenance(db, { olderThanDays: 30, batchLimit: 10 });
    expect(prunedSecond).toBe(1);

    // Access bounds: empty chainKey or out-of-range limits are rejected.
    await expect(listRawEventProvenance(db, { chainKey: "   " })).rejects.toThrow(RangeError);
    await expect(listRawEventProvenance(db, { chainKey: chain, limit: 0 })).rejects.toThrow(
      RangeError,
    );
    await expect(
      listRawEventProvenance(db, { chainKey: chain, limit: MAX_PROVENANCE_QUERY_LIMIT + 1 }),
    ).rejects.toThrow(RangeError);
    await expect(pruneRawEventProvenance(db, { olderThanDays: 0 })).rejects.toThrow(RangeError);
    await expect(pruneRawEventProvenance(db, { batchLimit: 0 })).rejects.toThrow(RangeError);

    // Default reads omit canonicalEnvelope while preserving payloadSha256 and aged-monetary retention.
    const withoutEnvelope = await listRawEventProvenance(db, { chainKey: chain });
    const keys = withoutEnvelope.map((entry) => entry.eventKey);
    expect(keys).toContain("aged-monetary");
    expect(keys).toContain("telemetry-fresh");
    expect(keys).not.toContain("aged-telemetry-1");
    expect(keys).not.toContain("aged-telemetry-2");
    expect(withoutEnvelope.every((entry) => entry.canonicalEnvelope === null)).toBe(true);

    const withEnvelope = await listRawEventProvenance(db, {
      chainKey: chain,
      txHash: "tx-m-old",
      includeEnvelope: true,
    });
    expect(withEnvelope).toHaveLength(1);
    expect(withEnvelope[0]?.canonicalEnvelope).toMatchObject({ truncated: true });
  });
});
