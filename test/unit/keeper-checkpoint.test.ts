import { Account, Keypair, SorobanDataBuilder, rpc, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/config.js";
import { reconcileKeeperCheckpointsBeforeRetry, submitStellar } from "../../src/keeper/stellar.js";
import { BudgetTracker, runBudgetedCatchUp } from "../../src/runtime/budget.js";
import { checkSchemaCompatibility, EXPECTED_SCHEMA_VERSION } from "../../src/db/schema.js";
import { completeEnv } from "../helpers.js";

function fixture() {
  const signer = Keypair.random();
  const config = loadConfig({ env: completeEnv({ KEEPER_STELLAR_SECRET: signer.secret() }) });
  const calls: string[] = [];
  let pending: Record<string, unknown> | null = null;
  let confirmed: Record<string, unknown> | null = null;
  let accountSequence = 1;
  let broadcasts = 0;
  let preparations = 0;
  let unknown = false;
  const db = {
    transaction: async <T>(work: (tx: { query: typeof query }) => Promise<T>) => work({ query }),
    query,
  };
  function query(sql: string, params: readonly unknown[] = []) {
    calls.push(sql);
    if (sql.includes("INSERT INTO keeper_checkpoint"))
      pending = { hash: params[0], intent_key: params[5], phase: params[6] };
    if (sql.includes("UPDATE keeper_checkpoint")) {
      if (sql.includes("state = 'confirmed'") && pending) confirmed = pending;
      pending = null;
    }
    if (sql.includes("INSERT INTO keeper_spending_window"))
      return Promise.resolve({ rows: [{ window_key: params[3] }], rowCount: 1 });
    return Promise.resolve({
      rows: sql.includes("SELECT active_signer,network_passphrase")
        ? [
            {
              active_signer: signer.publicKey(),
              network_passphrase: config.indexer.stellar!.networkPassphrase,
            },
          ]
        : sql.includes("SELECT spent_stroops,cap_stroops")
          ? [
              {
                spent_stroops: "0",
                cap_stroops: "1000000",
                override_stroops: null,
                override_reason: null,
              },
            ]
          : sql.includes("SELECT hash FROM keeper_checkpoint") &&
              sql.includes("state = 'confirmed'") &&
              confirmed?.intent_key === params[2]
            ? [confirmed]
            : sql.includes("state = 'submitted' ORDER BY") && pending
              ? [pending]
              : [],
      rowCount: 1,
    });
  }
  const client = {
    getLatestLedger: () => Promise.resolve({ sequence: 100 }),
    getNetwork: () => Promise.resolve({ passphrase: config.indexer.stellar!.networkPassphrase }),
    getAccountEntry: () => Promise.resolve({ balance: 100000000n }),
    getAccount: () => Promise.resolve(new Account(signer.publicKey(), String(accountSequence++))),
    simulateTransaction: () => {
      preparations++;
      return Promise.resolve({
        _parsed: true,
        id: "fixture",
        latestLedger: 1,
        events: [],
        transactionData: new SorobanDataBuilder(),
        minResourceFee: "0",
        result: { auth: [], retval: xdr.ScVal.scvVoid() },
      });
    },
    prepareTransaction: (transaction: unknown) => {
      preparations++;
      return Promise.resolve(transaction);
    },
    sendTransaction: (transaction: { hash(): Buffer }) => {
      broadcasts++;
      expect(pending?.hash).toBe(Buffer.from(transaction.hash()).toString("hex"));
      if (unknown) return Promise.reject(new Error("provider secret must not leak"));
      return Promise.resolve({
        hash: Buffer.from(transaction.hash()).toString("hex"),
        status: "PENDING",
      });
    },
    getTransaction: () =>
      Promise.resolve({
        status: unknown
          ? rpc.Api.GetTransactionStatus.NOT_FOUND
          : rpc.Api.GetTransactionStatus.SUCCESS,
      }),
  } as unknown as rpc.Server;
  const submit = (operation: "keep_alive" | "settle_claim" = "keep_alive") =>
    submitStellar(
      config,
      db,
      config.indexer.stellar!.chain,
      config.indexer.stellar!.routerContractId,
      operation,
      operation,
      () => [],
      { client, confirmationAttempts: 1 },
    );
  return {
    submit,
    calls,
    setUnknown: (value: boolean) => {
      unknown = value;
    },
    counts: () => ({ broadcasts, preparations }),
    pending: () => pending,
  };
}

describe("durable keeper admission and recovery", () => {
  it("reconciles every submitted hash before recovery without changing delivery records", async () => {
    const config = loadConfig({ env: completeEnv() });
    const hash = "ab".repeat(32);
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    const query = (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      return Promise.resolve({
        rows: sql.includes("SELECT hash FROM keeper_checkpoint") ? [{ hash }] : [],
        rowCount: sql.includes("SELECT hash FROM keeper_checkpoint") ? 1 : 0,
      });
    };
    const db = {
      query,
      transaction: async <T>(work: (tx: { query: typeof query }) => Promise<T>) => work({ query }),
    };
    const client = {
      getNetwork: () => Promise.resolve({ passphrase: config.indexer.stellar!.networkPassphrase }),
      getTransaction: (requested: string) => {
        expect(requested).toBe(hash);
        return Promise.resolve({ status: rpc.Api.GetTransactionStatus.SUCCESS });
      },
    } as unknown as rpc.Server;
    await reconcileKeeperCheckpointsBeforeRetry(config, db, client);
    expect(
      calls.some(
        (call) =>
          call.sql.includes("UPDATE keeper_checkpoint") &&
          call.params[0] === hash &&
          call.params[1] === "confirmed",
      ),
    ).toBe(true);
    expect(calls.some((call) => call.sql.includes("UPDATE pending_claim"))).toBe(false);
  });
  it("commits a64hex public hash before sending and acquires a cross-replica signer lock", async () => {
    const f = fixture();
    const hash = await f.submit();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(f.calls[0]).toContain("pg_advisory_xact_lock");
    expect(f.calls.some((sql) => sql.includes("confirmed_at = now()"))).toBe(true);
  });
  it("renews TTL for unchanged keep_alive targets after prior confirmed upkeep", async () => {
    const f = fixture();
    const first = await f.submit();
    const second = await f.submit();
    expect(second).not.toBe(first);
    expect(f.counts()).toEqual({ broadcasts: 2, preparations: 2 });
  });
  it("reuses confirmed claim settlement while indexing catches up", async () => {
    const f = fixture();
    const first = await f.submit("settle_claim");
    expect(await f.submit("settle_claim")).toBe(first);
    expect(f.counts()).toEqual({ broadcasts: 1, preparations: 1 });
  });
  it("retains unknown broadcast outcomes and blocks another prepare or send on retry", async () => {
    const f = fixture();
    f.setUnknown(true);
    await expect(f.submit()).rejects.toThrow("outcome is unknown");
    expect(f.pending()).not.toBeNull();
    await expect(f.submit()).rejects.toThrow("saved checkpoint blocks");
    expect(f.counts()).toEqual({ broadcasts: 1, preparations: 1 });
    f.setUnknown(false);
    await f.submit();
    expect(f.counts()).toEqual({ broadcasts: 1, preparations: 1 });
  });
  it("sanitizes database admission errors and rejects an override below the shipped schema", async () => {
    await expect(
      checkSchemaCompatibility({
        query: () => Promise.reject(new Error("database password=never-print")),
      }),
    ).rejects.toThrow("Apply the shipped migrations");
    expect(() =>
      loadConfig({ env: completeEnv({ SCHEMA_VERSION: "1790900000000_initial-schema" }) }),
    ).toThrow("must match this build");
    expect(EXPECTED_SCHEMA_VERSION).toMatch(/^\d{13}_[a-z0-9-]+$/);
  });
  it("rejects a one-connection pool before opening a signer transaction", async () => {
    const config = loadConfig({
      env: completeEnv({ KEEPER_STELLAR_SECRET: Keypair.random().secret() }),
    });
    const db = {
      poolSnapshot: () => ({ maxConnections: 1 }),
      query: () => Promise.resolve({ rows: [], rowCount: 0 }),
      transaction: () => Promise.reject(new Error("must not acquire")),
    };
    await expect(
      submitStellar(
        config,
        db,
        config.indexer.stellar!.chain,
        config.indexer.stellar!.routerContractId,
        "keep_alive",
        "keep_alive",
        () => [],
      ),
    ).rejects.toThrow("at least two database connections");
  });
  it("keeps a drain reserve when a previous stage ran past its allocation", () => {
    let now = 0;
    const budget = new BudgetTracker(1000, () => now);
    budget.advanceStage();
    now = 950;
    expect(budget.snapshot().stageRemainingMs).toBe(0);
    expect(budget.snapshot().totalRemainingMs).toBe(50);
  });
  it("runs source workers before proof workers and drains exactly once", async () => {
    const events: string[] = [];
    const worker = (name: string) => ({
      name,
      start: () => {
        events.push(name + ":start");
      },
      stop: () => {
        events.push(name + ":stop");
        return Promise.resolve();
      },
    });
    await runBudgetedCatchUp([worker("stellar"), worker("rail:axelar")], 50, () => {
      events.push("drain");
      return Promise.resolve();
    });
    expect(events).toEqual([
      "stellar:start",
      "stellar:stop",
      "rail:axelar:start",
      "rail:axelar:stop",
      "drain",
    ]);
  });
});
