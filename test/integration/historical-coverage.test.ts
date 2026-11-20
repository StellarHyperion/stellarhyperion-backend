import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { Database, type Queryable } from "../../src/db/pool.js";
import { persistScanJournal } from "../../src/chains/stellar/store.js";
import { readHistoricalCoverage } from "../../src/http/historical-coverage.js";
const connection = process.env.TEST_DATABASE_URL;
(connection ? describe : describe.skip)("durable historical coverage snapshot", () => {
  let db: Database;
  const stellar = {
    chain: "metrics-coverage-stellar",
    family: "stellar" as const,
    contract: "metrics-coverage-router",
  };
  const evm = {
    chain: "metrics-coverage-evm",
    family: "evm" as const,
    contract: "metrics-coverage-evm-router",
  };
  const clean = async () => {
    for (const table of [
      "stellar_history_gap",
      "stellar_scan_journal",
      "evm_backfill_job",
      "evm_scan_provenance",
      "indexer_cursor",
    ]) {
      await db.query(`DELETE FROM ${table} WHERE chain_key IN ($1,$2)`, [stellar.chain, evm.chain]);
    }
  };
  beforeAll(() => {
    db = Database.open(connection ?? "");
  });
  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await db.close();
  });
  const cursor = async (source: typeof stellar | typeof evm) => {
    await db.query(
      `INSERT INTO indexer_cursor(chain_key,family,contract,last_processed,updated_at)
      VALUES($1,$2,$3,18446744073709551615,clock_timestamp())`,
      [source.chain, source.family, source.contract],
    );
  };
  const journal = async (range: unknown = { from: 100, to: 200 }) =>
    persistScanJournal(db, stellar.contract, { chainKey: stellar.chain, committedRange: range });
  const read = async () => (await readHistoricalCoverage(db, [stellar, evm])).historicalCoverage;
  const source = async (chain = stellar.chain) =>
    (await read()).sources.find((s) => s.chain === chain);
  const gap = async (from = "100", to = "200") => {
    await db.query(
      `INSERT INTO stellar_history_gap(chain_key,contract,start_ledger,end_ledger,status,reason)
      VALUES($1,$2,$3,$4,'open','rpc_retention_window_moved')`,
      [stellar.chain, stellar.contract, from, to],
    );
  };
  it("a current cursor preserves old gaps, partial replay advances their actual missing start, and resolution clears them", async () => {
    await cursor(stellar);
    await journal();
    await gap();
    await gap("18446744073709551000", "18446744073709551600");
    expect(await source()).toMatchObject({
      unresolved: 2,
      oldestMissingStart: "100",
      oldestMissingEnd: "200",
      unknown: false,
    });
    await db.query(
      "UPDATE stellar_history_gap SET status='reconciling',replayed_through=149 WHERE chain_key=$1 AND start_ledger=100",
      [stellar.chain],
    );
    expect(await source()).toMatchObject({
      unresolved: 2,
      oldestMissingStart: "150",
      oldestMissingEnd: "200",
    });
    await db.query(
      "UPDATE stellar_history_gap SET status='reconciled',replayed_through=end_ledger WHERE chain_key=$1 AND start_ledger=100",
      [stellar.chain],
    );
    expect(await source()).toMatchObject({
      unresolved: 1,
      oldestMissingStart: "18446744073709551000",
      oldestMissingEnd: "18446744073709551600",
    });
    await db.query(
      "UPDATE stellar_history_gap SET status='reconciled',replayed_through=end_ledger WHERE chain_key=$1",
      [stellar.chain],
    );
    expect(await source()).toMatchObject({
      unresolved: 0,
      oldestMissingStart: null,
      oldestMissingEnd: null,
    });
  });
  it("keeps missing, malformed or outdated deployment history unknown", async () => {
    expect(await source()).toMatchObject({ unresolved: 0, unknown: true });
    await cursor(stellar);
    await journal({});
    expect(await source()).toMatchObject({ unknown: true });
    await journal();
    expect(await source()).toMatchObject({ unknown: false });
    const replaced = await readHistoricalCoverage(db, [{ ...stellar, contract: "new-router" }]);
    expect(
      replaced.historicalCoverage.sources.find((s) => s.chain === stellar.chain)?.unknown,
    ).toBe(true);
  });
  it("returns one consistent snapshot even when a concurrent backfill resolves the gaps just after its read", async () => {
    await cursor(stellar);
    await journal();
    await gap();
    const resolving: Queryable = {
      query: async (sql, params) => {
        const snapshot = await db.query(sql, params);
        await db.query(
          "UPDATE stellar_history_gap SET status='reconciled',replayed_through=end_ledger WHERE chain_key=$1",
          [stellar.chain],
        );
        return snapshot;
      },
    };
    const snapshot = (
      await readHistoricalCoverage(resolving, [stellar])
    ).historicalCoverage.sources.find((s) => s.chain === stellar.chain);
    expect(snapshot).toMatchObject({
      unresolved: 1,
      oldestMissingStart: "100",
      oldestMissingEnd: "200",
    });
    expect(await source()).toMatchObject({ unresolved: 0, oldestMissingStart: null });
  });
  it("tracks declared unfinished EVM block ranges independently of a recent cursor", async () => {
    await cursor(evm);
    await db.query(
      `INSERT INTO evm_scan_provenance(chain_key,contract,chain_id,from_block,to_block,end_block_hash,head_block,confirmations,reorg_depth)
      VALUES($1,$2,1,100,200,'public-hash',250,12,6)`,
      [evm.chain, evm.contract],
    );
    await db.query(
      `INSERT INTO evm_backfill_job(id,owner,chain_key,contract,from_block,to_block,next_block,state)
      VALUES('metrics-coverage-job','test-owner',$1,$2,90071992547409930000,90071992547409930100,90071992547409930020,'failed')`,
      [evm.chain, evm.contract],
    );
    expect(await source(evm.chain)).toMatchObject({
      unresolved: 1,
      oldestMissingStart: "90071992547409930020",
      oldestMissingEnd: "90071992547409930100",
      unknown: false,
    });
    await db.query(
      "UPDATE evm_backfill_job SET next_block=to_block+1,state='completed' WHERE id='metrics-coverage-job'",
    );
    expect(await source(evm.chain)).toMatchObject({ unresolved: 0, oldestMissingStart: null });
  });
});
