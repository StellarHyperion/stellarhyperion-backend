import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_EVM_BLOCK_CHECKPOINTS,
  MAX_EVM_CHECKPOINT_CLEANUP,
  readEvmBlockCheckpointHash,
  recordEvmBlockCheckpoint,
} from "../../src/chains/evm/checkpoints.js";
import { EvmWatcher } from "../../src/chains/evm/watcher.js";
import { readCursor, writeCursor } from "../../src/chains/stellar/store.js";
import { Database, type Transactional } from "../../src/db/pool.js";
import { ANVIL_CHAIN_ID, ANVIL_ROUTER, ANVIL_START_BLOCK, FakeEvmClient } from "../evm-fakes.js";
import { capturingLogger } from "../stellar-fakes.js";

const connection = process.env.TEST_DATABASE_URL;
(connection ? describe : describe.skip)("canonical empty-range checkpoints in PostgreSQL", () => {
  let db: Database;
  const chainKey = `evm-checkpoint-test-${process.pid}`;
  const deployment = { chainKey, contract: ANVIL_ROUTER, deploymentRevision: 1 };
  const clean = async () => {
    for (const table of [
      "evm_block_checkpoint",
      "evm_scan_provenance",
      "evm_applied_event",
      "evm_deployment_revision",
      "indexer_cursor",
      "indexer_lease",
    ]) {
      await db.query(`DELETE FROM ${table} WHERE chain_key = $1`, [chainKey]);
    }
  };
  const make = (client: FakeEvmClient, database: Transactional = db, logRange = 2) =>
    new EvmWatcher({
      chainKey,
      router: ANVIL_ROUTER,
      chainId: ANVIL_CHAIN_ID,
      startBlock: ANVIL_START_BLOCK,
      confirmations: 0,
      reorgDepth: 5,
      logRange,
      releaseLeaseOnTick: true,
      client,
      db: database,
      logger: capturingLogger().logger,
    });
  const drain = async (watcher: EvmWatcher) => {
    let passes = 0;
    while (await watcher.tick(AbortSignal.timeout(20_000))) {
      if (++passes > 50) throw new Error("empty watcher failed to catch up");
    }
  };

  beforeAll(() => {
    db = Database.open(connection ?? "", { applicationName: "hyperion-evm-checkpoint-test" });
  });
  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await db.close();
  });

  it("commits canonical anchors for empty pages and resumes after a process restart", async () => {
    const head = ANVIL_START_BLOCK + 5n;
    const client = new FakeEvmClient({ head, logs: [] });
    await drain(make(client));
    const initial = (
      await db.query(
        "SELECT block_number, block_hash FROM evm_block_checkpoint WHERE chain_key=$1 ORDER BY block_number",
        [chainKey],
      )
    ).rows;
    expect(initial).toEqual(
      [1n, 3n, 5n].map((offset) => ({
        block_number: (ANVIL_START_BLOCK + offset).toString(),
        block_hash: client.stampFor(ANVIL_START_BLOCK + offset).hash,
      })),
    );
    expect((await readCursor(db, chainKey))?.hash).toBe(client.stampFor(head).hash);
    expect(
      client.blockQueries
        .flat()
        .every((block) => [ANVIL_START_BLOCK + 1n, ANVIL_START_BLOCK + 3n, head].includes(block)),
    ).toBe(true);

    await db.close();
    db = Database.open(connection ?? "", { applicationName: "hyperion-evm-checkpoint-restart" });
    client.advanceHeadTo(head + 2n);
    await drain(make(client));
    expect(client.logQueries.at(-1)?.fromBlock).toBe(head + 1n);
    expect(await readEvmBlockCheckpointHash(db, deployment, head + 2n)).toBe(
      client.stampFor(head + 2n).hash,
    );
    const { rows } = await db.query(
      `SELECT c.last_processed, c.last_processed_hash, p.block_hash, s.end_block_hash
       FROM indexer_cursor c JOIN evm_block_checkpoint p
       ON p.chain_key=c.chain_key AND p.contract=lower(c.contract)
       AND p.deployment_revision=c.deployment_revision AND p.block_number=c.last_processed
       JOIN evm_scan_provenance s ON s.chain_key=c.chain_key AND s.contract=lower(c.contract)
       AND s.to_block=c.last_processed WHERE c.chain_key=$1 ORDER BY s.id DESC LIMIT 1`,
      [chainKey],
    );
    expect(rows).toEqual([
      {
        last_processed: (head + 2n).toString(),
        last_processed_hash: client.stampFor(head + 2n).hash,
        block_hash: client.stampFor(head + 2n).hash,
        end_block_hash: client.stampFor(head + 2n).hash,
      },
    ]);
  });

  it("rewinds a legacy null-hash cursor on an empty reorg and preserves old scan evidence", async () => {
    const head = ANVIL_START_BLOCK + 5n;
    const client = new FakeEvmClient({ head, logs: [] });
    await drain(make(client));
    const oldHistory = (
      await db.query("SELECT * FROM evm_scan_provenance WHERE chain_key=$1 ORDER BY id", [chainKey])
    ).rows;
    await db.query("UPDATE indexer_cursor SET last_processed_hash=NULL WHERE chain_key=$1", [
      chainKey,
    ]);
    client.reorg(head - 2n, []);
    client.advanceHeadTo(head + 1n);
    const restarted = make(client);
    await restarted.tick(AbortSignal.timeout(20_000));
    expect(restarted.progress?.reorgs).toBe(1);
    expect(client.logQueries.at(-1)?.fromBlock).toBe(head - 4n);
    expect((await readCursor(db, chainKey))?.position).toBe(head - 3n);
    expect(await readEvmBlockCheckpointHash(db, deployment, head)).toBeNull();
    await drain(restarted);
    expect((await readCursor(db, chainKey))?.hash).toBe(client.stampFor(head + 1n).hash);
    expect(await readEvmBlockCheckpointHash(db, deployment, head + 1n)).toBe(
      client.stampFor(head + 1n).hash,
    );
    const history = (
      await db.query("SELECT * FROM evm_scan_provenance WHERE chain_key=$1 ORDER BY id", [chainKey])
    ).rows;
    expect(history.slice(0, oldHistory.length)).toEqual(oldHistory);
  });

  it("rolls back the anchor and audit when the cursor commit fails, then retries safely", async () => {
    const client = new FakeEvmClient({ head: ANVIL_START_BLOCK + 1n, logs: [] });
    let anchorWritten = false;
    const failing: Transactional = {
      query: db.query.bind(db),
      transaction: (work) =>
        db.transaction((tx) =>
          work({
            query: async (sql, params) => {
              if (sql.includes("INSERT INTO evm_block_checkpoint")) anchorWritten = true;
              if (sql.includes("INSERT INTO indexer_cursor"))
                throw new Error("injected cursor failure");
              return tx.query(sql, params);
            },
          }),
        ),
    };
    await expect(make(client, failing).tick(AbortSignal.timeout(20_000))).rejects.toThrow(
      "injected cursor failure",
    );
    expect(anchorWritten).toBe(true);
    expect(await readCursor(db, chainKey)).toBeNull();
    expect(await readEvmBlockCheckpointHash(db, deployment, client.latest)).toBeNull();
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM evm_scan_provenance WHERE chain_key=$1",
          [chainKey],
        )
      ).rows[0]?.count,
    ).toBe(0);
    expect(
      (
        await db.query("SELECT count(*)::int AS count FROM indexer_lease WHERE chain_key=$1", [
          chainKey,
        ])
      ).rows[0]?.count,
    ).toBe(0);
    await drain(make(client));
    expect((await readCursor(db, chainKey))?.hash).toBe(client.stampFor(client.latest).hash);
  });

  it("refuses a conflicting retained history without committing a cursor, scan or lease", async () => {
    const client = new FakeEvmClient({ head: ANVIL_START_BLOCK + 1n, logs: [] });
    const oldHash = `0x${"f".repeat(64)}`;
    await recordEvmBlockCheckpoint(db, { ...deployment, block: client.latest, hash: oldHash });
    await expect(make(client).tick(AbortSignal.timeout(20_000))).rejects.toThrow(
      "conflicts with retained canonical history",
    );
    expect(await readCursor(db, chainKey)).toBeNull();
    expect(await readEvmBlockCheckpointHash(db, deployment, client.latest)).toBe(oldHash);
    for (const table of ["evm_scan_provenance", "indexer_lease", "evm_deployment_revision"]) {
      expect(
        (
          await db.query(`SELECT count(*)::int AS count FROM ${table} WHERE chain_key=$1`, [
            chainKey,
          ])
        ).rows[0]?.count,
      ).toBe(0);
    }
  });

  it("keeps revision, router, deployment and Stellar guards when allowing an EVM rewind", async () => {
    const entry = {
      chainKey,
      family: "evm" as const,
      contract: ANVIL_ROUTER,
      position: 20n,
      observedAt: null,
      hash: `0x${"a".repeat(64)}`,
      deploymentRevision: 1,
    };
    await writeCursor(db, { ...entry, expectedRevision: null });
    const original = await readCursor(db, chainKey);
    if (original === null) throw new Error("missing original cursor");
    for (const overrides of [
      { allowEvmRewind: false },
      { expectedRevision: original.revision + 1n },
      { expectedContract: `0x${"b".repeat(40)}` },
      { expectedDeploymentRevision: 2 },
    ]) {
      await expect(
        db.transaction(async (tx) => {
          await recordEvmBlockCheckpoint(tx, { ...deployment, block: 18n, hash: entry.hash });
          await writeCursor(tx, {
            ...entry,
            position: 18n,
            expectedRevision: original.revision,
            allowEvmRewind: true,
            ...overrides,
          });
        }),
      ).rejects.toThrow("stale cursor");
      expect(await readCursor(db, chainKey)).toEqual(original);
      expect(await readEvmBlockCheckpointHash(db, deployment, 18n)).toBeNull();
    }
    await expect(
      writeCursor(db, {
        ...entry,
        family: "stellar",
        position: 18n,
        expectedRevision: original.revision,
        allowEvmRewind: true,
      }),
    ).rejects.toThrow("only valid for an EVM cursor");
    await writeCursor(db, { ...entry, family: "stellar", expectedRevision: original.revision });
    const stellar = await readCursor(db, chainKey);
    if (stellar === null) throw new Error("missing Stellar cursor");
    await expect(
      writeCursor(db, {
        ...entry,
        position: 18n,
        expectedRevision: stellar.revision,
        allowEvmRewind: true,
      }),
    ).rejects.toThrow("stale cursor");
    expect(await readCursor(db, chainKey)).toEqual(stellar);
  });

  it("bounds cleanup, preserves deployment isolation and rejects conflicting full-width anchors", async () => {
    const hash = `0x${"a".repeat(64)}`;
    const block = (1n << 63n) + 1000n;
    await db.query(
      `INSERT INTO evm_block_checkpoint(chain_key,contract,deployment_revision,block_number,block_hash)
       SELECT $1,$2,1,$3::numeric+anchor_offset,$4 FROM generate_series(0,521) AS anchor_offset`,
      [chainKey, ANVIL_ROUTER.toLowerCase(), (1n << 63n).toString(), hash],
    );
    const entry = { ...deployment, block, hash };
    await recordEvmBlockCheckpoint(db, { ...entry, deploymentRevision: 2 });
    const count = async () =>
      (
        await db.query(
          "SELECT count(*)::int AS count FROM evm_block_checkpoint WHERE chain_key=$1 AND deployment_revision=1",
          [chainKey],
        )
      ).rows[0]?.count;
    await db.transaction((tx) => recordEvmBlockCheckpoint(tx, entry));
    expect(await count()).toBe(523 - MAX_EVM_CHECKPOINT_CLEANUP);
    await db.transaction((tx) => recordEvmBlockCheckpoint(tx, entry));
    expect(await count()).toBe(MAX_EVM_BLOCK_CHECKPOINTS);
    expect(
      await readEvmBlockCheckpointHash(db, { ...deployment, deploymentRevision: 2 }, block),
    ).toBe(hash);
    const timestamp = async () =>
      (
        await db.query(
          "SELECT recorded_at FROM evm_block_checkpoint WHERE chain_key=$1 AND deployment_revision=1 AND block_number=$2",
          [chainKey, block.toString()],
        )
      ).rows[0]?.recorded_at;
    const firstRecorded = await timestamp();
    await db.transaction((tx) => recordEvmBlockCheckpoint(tx, entry));
    expect(await timestamp()).toEqual(firstRecorded);
    await expect(
      db.transaction((tx) =>
        recordEvmBlockCheckpoint(tx, {
          ...entry,
          hash: `0x${"b".repeat(64)}`,
        }),
      ),
    ).rejects.toThrow("conflicts with retained canonical history");
    expect(await readEvmBlockCheckpointHash(db, deployment, block)).toBe(hash);
  });
});
