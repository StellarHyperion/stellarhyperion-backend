import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { loadConfig } from "../../src/config/config.js";
import { processTtlBump } from "../../src/keeper/jobs/ttl.js";
import { processClaimSettlement } from "../../src/keeper/jobs/claims.js";
import { reconcileKeeperCheckpointsBeforeRetry, submitStellar } from "../../src/keeper/stellar.js";
import { requeueFailedKeeperJob } from "../../src/keeper/queue.js";
import type { Queue } from "bullmq";
import { KeeperMaintenancePausedError, reserveKeeperSpending } from "../../src/keeper/spending.js";
import { KeeperWorker } from "../../src/keeper/worker.js";
import type { rpc } from "@stellar/stellar-sdk";
import type { Queryable } from "../../src/db/pool.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";
vi.mock("../../src/keeper/stellar.js", () => ({
  reconcileKeeperCheckpointsBeforeRetry: vi.fn(),
  submitStellar: vi.fn(),
}));
class Db {
  calls: { sql: string; params: readonly unknown[] }[] = [];
  constructor(
    private readonly claims: readonly Record<string, unknown>[] = [
      {
        claim_id: "1",
        settled: false,
        recipient: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        amount: "90000000000000000001",
      },
      {
        claim_id: "2",
        settled: false,
        recipient: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        amount: "42",
      },
    ],
  ) {}
  query(sql: string, params: readonly unknown[] = []) {
    this.calls.push({ sql, params });
    return Promise.resolve({
      rows: sql.includes("INSERT INTO keeper_submission")
        ? [{ id: "9223372036854775000" }]
        : sql.includes("pending_claim")
          ? [...this.claims]
          : [{ nonce: "9223372036854775808" }],
      rowCount: 2,
    });
  }
  transaction<T>(work: (db: Db) => Promise<T>) {
    return work(this);
  }
}
class SpendingDb implements Queryable {
  calls: { sql: string; params: readonly unknown[] }[] = [];
  constructor(private readonly spent = "0") {}
  query(sql: string, params: readonly unknown[] = []) {
    this.calls.push({ sql, params });
    if (sql.includes("INSERT INTO keeper_spending_window"))
      return Promise.resolve({ rows: [{ window_key: params[3] }], rowCount: 1 });
    if (sql.includes("SELECT spent_stroops,cap_stroops"))
      return Promise.resolve({
        rows: [
          {
            spent_stroops: this.spent,
            cap_stroops: "1000000",
            override_stroops: null,
            override_reason: null,
          },
        ],
        rowCount: 1,
      });
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  transaction<T>(work: (tx: Queryable) => Promise<T>) {
    return work(this);
  }
}
const { logger } = capturingLogger();
beforeEach(() => {
  vi.mocked(submitStellar).mockReset();
  vi.mocked(reconcileKeeperCheckpointsBeforeRetry).mockReset().mockResolvedValue(undefined);
});
describe("Stellar keeper execution", () => {
  it("reports zero completed maintenance when there is no signer", async () => {
    const config = loadConfig({ env: completeEnv() });
    const db = new Db();
    const result = await processTtlBump({ config, db, logger });
    expect(result.dryRun).toBe(true);
    expect(result.bumpedTokens).toBe(0);
    expect(result.bumpedClaims).toBe(0);
    expect(submitStellar).not.toHaveBeenCalled();
    expect(db.calls[0]?.params[0]).toBe(config.indexer.stellar?.chain);
    expect(
      db.calls.every(
        (call) => !call.sql.includes("ORDER BY id") || !call.sql.includes("pending_claim"),
      ),
    ).toBe(true);
  });
  it("counts maintenance only after a confirmed transaction", async () => {
    const config = loadConfig({
      env: completeEnv({ KEEPER_STELLAR_SECRET: Keypair.random().secret() }),
    });
    vi.mocked(submitStellar).mockResolvedValue("confirmed-hash");
    const result = await processTtlBump({ config, db: new Db(), logger });
    expect(result.dryRun).toBe(false);
    expect(result.bumpedClaims).toBe(2);
    expect(result.bumpedTransfers).toBe(1);
    expect(vi.mocked(submitStellar).mock.calls[0]?.[4]).toBe("keep_alive");
    expect(vi.mocked(submitStellar).mock.calls[0]?.[5]).toBe("keep_alive");
    expect(vi.mocked(submitStellar).mock.calls[0]?.[6]("ignored")).toHaveLength(4);
  });
  it("does not claim upkeep succeeded if submission fails", async () => {
    const config = loadConfig({
      env: completeEnv({ KEEPER_STELLAR_SECRET: Keypair.random().secret() }),
    });
    vi.mocked(submitStellar).mockRejectedValue(new Error("simulation refused"));
    await expect(processTtlBump({ config, db: new Db(), logger })).rejects.toThrow(
      "simulation refused",
    );
  });
  it("settles only configured-chain claims and leaves indexing to chain events", async () => {
    const config = loadConfig({
      env: completeEnv({ KEEPER_STELLAR_SECRET: Keypair.random().secret() }),
    });
    vi.mocked(submitStellar)
      .mockResolvedValueOnce("settled-hash")
      .mockRejectedValueOnce(new Error("recipient not ready"));
    const db = new Db();
    const result = await processClaimSettlement({ config, db, logger });
    expect(result.settled).toBe(1);
    expect(result.attempted).toBe(2);
    expect(result.pending).toBe(1);
    expect(result.claims).toEqual([
      { claimId: "1", outcome: "confirmed", transactionHash: "settled-hash" },
      { claimId: "2", outcome: "pending" },
    ]);
    expect(db.calls[0]?.params[0]).toBe(config.indexer.stellar?.chain);
    expect(db.calls.some((call) => /INSERT|UPDATE/.test(call.sql))).toBe(false);
  });

  it("reports missing and already-settled claims individually without signing them", async () => {
    const config = loadConfig({
      env: completeEnv({ KEEPER_STELLAR_SECRET: Keypair.random().secret() }),
    });
    const db = new Db([{ claim_id: "18446744073709551615", settled: true }]);
    const result = await processClaimSettlement(
      { config, db, logger },
      { claimIds: ["18446744073709551615", "9007199254740993"] },
    );

    expect(result.claims).toEqual([
      { claimId: "18446744073709551615", outcome: "already_settled" },
      { claimId: "9007199254740993", outcome: "missing" },
    ]);
    expect(result.settled).toBe(1);
    expect(result.missing).toBe(1);
    expect(result.attempted).toBe(0);
    expect(submitStellar).not.toHaveBeenCalled();
  });

  it("bounds and validates claim settlement batches before querying or submitting", async () => {
    const config = loadConfig({
      env: completeEnv({ KEEPER_STELLAR_SECRET: Keypair.random().secret() }),
    });
    const db = new Db();

    await expect(processClaimSettlement({ config, db, logger }, { limit: 21 })).rejects.toThrow(
      "batch size",
    );
    await expect(
      processClaimSettlement({ config, db, logger }, { claimIds: ["9007199254740993.5"] }),
    ).rejects.toThrow("decimal strings");
    expect(db.calls).toEqual([]);
    expect(submitStellar).not.toHaveBeenCalled();
  });
  it("performs no claim submissions without a Stellar signer", async () => {
    const config = loadConfig({ env: completeEnv() });
    const result = await processClaimSettlement({ config, db: new Db(), logger });
    expect(result.attempted).toBe(0);
    expect(result.settled).toBe(0);
    expect(result.dryRun).toBe(true);
    expect(result.unsigned).toBe(true);
    expect(result.operations).toHaveLength(2);
    expect(result.operations[0]?.args).toEqual({
      claimId: "1",
      recipient: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      amount: "90000000000000000001",
    });
    expect(result.operations[1]?.args).toEqual({
      claimId: "2",
      recipient: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      amount: "42",
    });
    expect(submitStellar).not.toHaveBeenCalled();
  });
  it("leaves claims pending when maintenance is paused by spending policy", async () => {
    const config = loadConfig({
      env: completeEnv({ KEEPER_STELLAR_SECRET: Keypair.random().secret() }),
    });
    vi.mocked(submitStellar).mockRejectedValue(
      new KeeperMaintenancePausedError("Keeper maintenance is paused."),
    );
    const db = new Db();
    const result = await processClaimSettlement({ config, db, logger });
    expect(result.settled).toBe(0);
    expect(result.pending).toBe(2);
    expect(result.dryRun).toBe(true);
    expect(db.calls.some((call) => /UPDATE\s+pending_claim/i.test(call.sql))).toBe(false);
  });
  it("reserves full-width fee amounts atomically for both reset windows", async () => {
    const config = loadConfig({
      env: completeEnv({
        KEEPER_SPENDING_OVERRIDE_STROOPS: "99999999999999999999",
        KEEPER_SPENDING_OVERRIDE_REASON: "approved maintenance budget",
      }),
    });
    const db = new SpendingDb();
    const client = {
      getLatestLedger: async () => ({ sequence: "9223372036854775808" }),
    } as unknown as rpc.Server;
    const amount = 9007199254740993123n;
    const result = await reserveKeeperSpending(
      config,
      db,
      "stellar-testnet",
      Keypair.random().publicKey(),
      amount,
      client,
    );
    expect(result.allowed).toBe(true);
    expect(
      db.calls
        .filter((call) => call.sql.includes("SET spent_stroops=spent_stroops+$5"))
        .map((call) => call.params[4]),
    ).toEqual([amount.toString(), amount.toString()]);
    const expectedLedgerWindow = ((9223372036854775808n / 17280n) * 17280n).toString();
    expect(db.calls.some((call) => call.params.includes(expectedLedgerWindow))).toBe(true);
    expect(db.calls.filter((call) => call.sql.includes("'reset'"))).toHaveLength(2);
    expect(db.calls.filter((call) => call.sql.includes("'override'"))).toHaveLength(2);
  });
  it("audits cap denial without charging an additional reservation", async () => {
    const config = loadConfig({ env: completeEnv() });
    const db = new SpendingDb("1000000");
    const client = {
      getLatestLedger: async () => ({ sequence: 100 }),
    } as unknown as rpc.Server;
    const result = await reserveKeeperSpending(
      config,
      db,
      "stellar-testnet",
      Keypair.random().publicKey(),
      100n,
      client,
    );
    expect(result.allowed).toBe(false);
    expect(
      db.calls.some(
        (call) =>
          call.sql.includes("INSERT INTO keeper_spending_audit") &&
          call.params.some(
            (value) => typeof value === "string" && value.startsWith("spending cap reached:"),
          ),
      ),
    ).toBe(true);
    expect(db.calls.some((call) => call.sql.includes("SET spent_stroops=spent_stroops+$5"))).toBe(
      false,
    );
  });
  it("reports disabled versus not-started worker states", () => {
    const config = loadConfig({ env: completeEnv() });
    expect(new KeeperWorker(config, new Db(), logger).readiness().state).toBe("degraded");
    const disabled = loadConfig({ env: completeEnv({ KEEPER_ENABLED: "false" }) });
    expect(new KeeperWorker(disabled, new Db(), logger).readiness().state).toBe("ready");
  });
  it("reconciles public checkpoints before a reviewed failed-job retry", async () => {
    const config = loadConfig({ env: completeEnv() });
    const events: string[] = [];
    vi.mocked(reconcileKeeperCheckpointsBeforeRetry).mockImplementationOnce(async () => {
      events.push("reconcile");
    });
    let state = "failed";
    const job = {
      name: "claim-settlement",
      getState: vi.fn(async () => state),
      retry: vi.fn(async () => {
        events.push("retry");
        state = "waiting";
      }),
    };
    const queue = {
      getJob: vi.fn(async () => job),
    } as unknown as Queue;
    await requeueFailedKeeperJob(
      queue,
      new Db(),
      config,
      "failed-job-1",
      "operator",
      "reviewed after checking the chain",
    );
    expect(reconcileKeeperCheckpointsBeforeRetry).toHaveBeenCalledOnce();
    expect(job.retry).toHaveBeenCalledOnce();
    expect(events).toEqual(["reconcile", "retry"]);
  });
  it("does not requeue a failed job while a public transaction is unresolved", async () => {
    const config = loadConfig({ env: completeEnv() });
    const job = {
      name: "ttl-bump",
      getState: vi.fn(async () => "failed"),
      retry: vi.fn(),
    };
    vi.mocked(reconcileKeeperCheckpointsBeforeRetry).mockRejectedValue(
      new Error("public hash is unresolved"),
    );
    await expect(
      requeueFailedKeeperJob(
        { getJob: vi.fn(async () => job) } as unknown as Queue,
        new Db(),
        config,
        "failed-job-2",
        "operator",
        "reviewed",
      ),
    ).rejects.toThrow("public hash is unresolved");
    expect(job.retry).not.toHaveBeenCalled();
  });
  it("matches plan previews and handles full-width values", async () => {
    const config = loadConfig({
      env: completeEnv({ KEEPER_STELLAR_SECRET: Keypair.random().secret() }),
    });
    vi.mocked(submitStellar).mockResolvedValue("confirmed-hash");
    const result = await processTtlBump({ config, db: new Db(), logger });
    expect(result.dryRun).toBe(false);
    expect(result.bumpedClaims).toBe(2);
    expect(result.bumpedTransfers).toBe(1);
    expect(result.unsigned).toBe(false);
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]?.args).toEqual({
      tokens: [expect.any(String)],
      routes: [0, 1, 2, 3],
      claimIds: ["1", "2"],
      transferIds: ["9223372036854775808"],
    });
    expect(result.targetKeys).toContain("claim:" + config.indexer.stellar?.chain + ":2");
    expect(JSON.stringify(result)).not.toContain(Keypair.random().secret());
  });
});
