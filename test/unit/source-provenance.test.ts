import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Queryable, Transactional } from "../../src/db/pool.js";
import { StellarWatcher } from "../../src/chains/stellar/watcher.js";
import {
  MAX_SOURCE_LINKS_PER_RECORD,
  pruneUnlinkedSourceEvents,
  readSourceProvenance,
  recordSourceEvent,
  writeOutbound,
  type Position,
  type SourceEventIdentity,
} from "../../src/chains/writers.js";
import { FakeRpc, LIVE_ROUTER, ROUTER_HISTORY, capturingLogger } from "../stellar-fakes.js";

const pg = new PGlite();
const toRows = (result: {
  rows: Record<string, unknown>[];
  fields: { name: string; dataTypeID: number }[];
}) =>
  result.rows.map((raw) => {
    const row = { ...raw };
    for (const field of result.fields)
      if (field.dataTypeID === 20 && row[field.name] != null)
        row[field.name] = String(row[field.name]);
    return row;
  });
const db: Transactional = {
  async query(sql, params = []) {
    const result = await pg.query<Record<string, unknown>>(sql, [...params]);
    const rows = toRows(result);
    return { rows, rowCount: result.affectedRows ?? rows.length };
  },
  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    return pg.transaction(async (tx) =>
      work({
        query: async (sql: string, params: readonly unknown[] = []) => {
          const result = await tx.query<Record<string, unknown>>(sql, [...params]);
          const rows = toRows(result);
          return { rows, rowCount: result.affectedRows ?? rows.length };
        },
      }),
    );
  },
};

beforeAll(async () => {
  for (const file of [
    "1790900000000_initial-schema.sql",
    "1791000000000_cursor-block-hash.sql",
    "1791300000000_stellar-durable-scan-evidence.sql",
    "1791400000000_stellar-cursor-cas-leases-gaps.sql",
    "1791500000000_stellar-revisions-and-quarantine.sql",
    "1791800000000_outbound-router-identity.sql",
    "1793500000000_ingestion-rejections.sql",
    "1793600000000_source-event-provenance.sql",
  ])
    await pg.exec(
      readFileSync(new URL(`../../migrations/${file}`, import.meta.url), "utf8").split(
        "-- Down Migration",
      )[0]!,
    );
}, 30_000);
afterAll(async () => {
  await pg.close();
});

const digest = (byte: string) => byte.repeat(32);
const identity = (chainKey: string, position: string | number = 3): SourceEventIdentity => ({
  chainKey,
  family: "evm",
  contract: "0x00000000000000000000000000000000000000aa",
  block: 18446744073709551615n,
  txHash: `0x${"cd".repeat(32)}`,
  position,
  eventKind: "BridgeOut",
  payloadDigest: digest("ab"),
});
const count = async (sql: string, params: unknown[] = []) =>
  Number((await db.query(sql, params)).rows[0]?.n);

describe("source event provenance", () => {
  it("links a Stellar replay to the same raw identity without duplicating facts", async () => {
    const chainKey = "provenance-replay";
    const queued = ROUTER_HISTORY.find((event) => event.topicJson[1]?.symbol === "queued")!;
    const options = {
      chainKey,
      router: LIVE_ROUTER,
      startLedger: queued.ledger,
      pageSize: 200,
      rpc: new FakeRpc({ events: [queued], latestLedger: queued.ledger + 1 }),
      db,
      logger: capturingLogger().logger,
      releaseLeaseOnTick: true,
    };
    await new StellarWatcher(options).tick(AbortSignal.timeout(5_000));
    await db.query("DELETE FROM indexer_cursor WHERE chain_key = $1", [chainKey]);
    await new StellarWatcher(options).tick(AbortSignal.timeout(5_000));

    const action = (
      await db.query("SELECT action_id::text AS id FROM admin_action WHERE chain = $1", [chainKey])
    ).rows;
    expect(action).toHaveLength(1);
    expect(
      await count("SELECT count(*)::int AS n FROM source_event WHERE chain_key = $1", [chainKey]),
    ).toBe(1);
    const [provenance, ...rest] = await readSourceProvenance(
      db,
      "admin_action",
      `${chainKey}:${String(action[0]?.id)}`,
    );
    expect(rest).toHaveLength(0);
    expect(provenance).toMatchObject({
      role: "created",
      family: "stellar",
      contract: LIVE_ROUTER,
      block: BigInt(queued.ledger),
      txHash: queued.txHash,
      position: queued.id,
      eventKind: "actionQueued",
      replays: 1,
      conflicts: 0,
    });
    expect(provenance?.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("links materialized writers once per source and keeps replay idempotent", async () => {
    const chainKey = "provenance-writer";
    const first = await recordSourceEvent(db, identity(chainKey));
    expect(first.kind).toBe("new");
    const at: Position = {
      chainKey,
      router: "0xrouter",
      block: 10n,
      txHash: `0x${"cd".repeat(32)}`,
      logIndex: 3,
      observedAt: new Date("2026-11-20T00:00:00Z"),
      sourceEventId: first.id,
    };
    const row = {
      route: 0,
      nonce: 18446744073709551615n,
      sender: "0xsender",
      token: "0xtoken",
      grossAmount: 115792089237316195423570985008687907853269984665640564039457584007913129639935n,
      fee: 0n,
      netAmount: 115792089237316195423570985008687907853269984665640564039457584007913129639935n,
      destinationChain: "stellar-testnet",
      destination: "Gdestination",
      railRef: null,
    };
    await writeOutbound(db, at, row);
    const replay = await recordSourceEvent(db, identity(chainKey));
    expect(replay).toEqual({ kind: "replay", id: first.id });
    await writeOutbound(db, { ...at, sourceEventId: replay.id }, row);

    const transfer = (
      await db.query(
        "SELECT id::text AS id, net_amount::text AS amount FROM outbound_transfer WHERE origin_chain = $1",
        [chainKey],
      )
    ).rows;
    expect(transfer).toHaveLength(1);
    expect(transfer[0]?.amount).toBe(row.netAmount.toString());
    const links = await readSourceProvenance(db, "outbound_transfer", String(transfer[0]?.id));
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ sourceEventId: first.id, replays: 1, position: "3" });
  });

  it("never lets a conflicting payload replace the original provenance", async () => {
    const chainKey = "provenance-conflict";
    const original = await recordSourceEvent(db, identity(chainKey));
    const conflicting = { ...identity(chainKey), payloadDigest: digest("ef") };
    expect(await recordSourceEvent(db, conflicting)).toEqual({
      kind: "conflict",
      id: original.id,
      originalDigest: digest("ab"),
      incomingDigest: digest("ef"),
    });
    await recordSourceEvent(db, conflicting);
    const stored = await db.query(
      "SELECT payload_digest, replays FROM source_event WHERE id = $1",
      [original.id.toString()],
    );
    expect(stored.rows[0]).toEqual({ payload_digest: digest("ab"), replays: 0 });
    expect(
      (
        await db.query(
          "SELECT incoming_digest, occurrences FROM source_event_conflict WHERE source_event_id = $1",
          [original.id.toString()],
        )
      ).rows,
    ).toEqual([{ incoming_digest: digest("ef"), occurrences: 2 }]);
    // The schema refuses a direct rewrite of provenance, whoever attempts it.
    await expect(
      db.query("UPDATE source_event SET payload_digest = $1 WHERE id = $2", [
        digest("ef"),
        original.id.toString(),
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.query("UPDATE source_event SET block_number = 1 WHERE id = $1", [original.id.toString()]),
    ).rejects.toThrow(/immutable/);
    await expect(
      recordSourceEvent(db, { ...identity(chainKey), payloadDigest: "not-a-digest" }),
    ).rejects.toThrow(RangeError);
  });

  it("enforces documented retention and access bounds", async () => {
    const chainKey = "provenance-retention";
    const linked = await recordSourceEvent(db, identity(chainKey, 1));
    const conflicted = await recordSourceEvent(db, identity(chainKey, 2));
    const unlinked = await recordSourceEvent(db, identity(chainKey, 3));
    await db.query(
      "INSERT INTO source_event_link (source_event_id, record_kind, record_key, role) VALUES ($1, 'outbound_transfer', '1', 'created')",
      [linked.id.toString()],
    );
    await recordSourceEvent(db, { ...identity(chainKey, 2), payloadDigest: digest("01") });

    // Linked and conflicted provenance cannot be deleted out from under its evidence.
    await expect(
      db.query("DELETE FROM source_event WHERE id = $1", [linked.id.toString()]),
    ).rejects.toThrow();
    await expect(
      db.query("DELETE FROM source_event WHERE id = $1", [conflicted.id.toString()]),
    ).rejects.toThrow();

    const future = new Date(Date.now() + 60_000);
    expect(await pruneUnlinkedSourceEvents(db, new Date(0))).toBe(0);
    let pruned = 0;
    for (let batch = 0; batch < 100; batch++) {
      const removed = await pruneUnlinkedSourceEvents(db, future, 1);
      if (removed === 0) break;
      pruned += removed;
    }
    expect(pruned).toBeGreaterThanOrEqual(1);
    const left = (
      await db.query("SELECT id::text AS id FROM source_event WHERE chain_key = $1 ORDER BY id", [
        chainKey,
      ])
    ).rows.map((row) => row.id);
    expect(left).toEqual([linked.id.toString(), conflicted.id.toString()]);
    expect(left).not.toContain(unlinked.id.toString());

    await expect(pruneUnlinkedSourceEvents(db, future, 10_001)).rejects.toThrow(RangeError);
    await expect(
      readSourceProvenance(db, "outbound_transfer", "1", MAX_SOURCE_LINKS_PER_RECORD + 1),
    ).rejects.toThrow(RangeError);

    // No raw payload is retained, so nothing a provider sent can be read back.
    const columns = (
      await db.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name IN ('source_event', 'source_event_conflict', 'source_event_link')`,
      )
    ).rows.map((row) => String(row.column_name));
    expect(columns.filter((name) => /payload$|raw|data|body/.test(name))).toEqual([]);
  });
});
