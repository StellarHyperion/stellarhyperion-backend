import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { loadConfig } from "../../src/config/config.js";
import { processTtlBump } from "../../src/keeper/jobs/ttl.js";
import { processClaimSettlement } from "../../src/keeper/jobs/claims.js";
import { processRestore } from "../../src/keeper/jobs/claims.js";
import { submitStellar, submitRestore } from "../../src/keeper/stellar.js";
import { KeeperWorker } from "../../src/keeper/worker.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";
vi.mock("../../src/keeper/stellar.js", () => ({ submitStellar: vi.fn(), submitRestore: vi.fn() }));
class Db {
  calls: { sql: string; params: readonly unknown[] }[] = [];
  claims: { claim_id: string; archived?: boolean }[] = [];
  transfers: { nonce: string; archived?: boolean }[] = [];
  query(sql: string, params: readonly unknown[] = []) {
    this.calls.push({ sql, params });
    if (sql.includes("pending_claim") && sql.includes("archived")) {
      const filtered = this.claims.filter((c) => c.archived === true);
      return Promise.resolve({
        rows: filtered.map((c) => ({ claim_id: c.claim_id })),
        rowCount: filtered.length,
      });
    }
    if (sql.includes("pending_claim")) {
      return Promise.resolve({
        rows: this.claims.map((c) => ({ claim_id: c.claim_id })),
        rowCount: this.claims.length,
      });
    }
    if (sql.includes("outbound_transfer") && sql.includes("archived")) {
      const filtered = this.transfers.filter((t) => t.archived === true);
      return Promise.resolve({
        rows: filtered.map((t) => ({ nonce: t.nonce })),
        rowCount: filtered.length,
      });
    }
    return Promise.resolve({
      rows: [{ nonce: "3" }],
      rowCount: 1,
    });
  }
  transaction<T>(work: (db: Db) => Promise<T>) {
    return work(this);
  }
}
const { logger } = capturingLogger();
beforeEach(() => {
  vi.mocked(submitStellar).mockReset();
  vi.mocked(submitRestore).mockReset();
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
    expect(vi.mocked(submitStellar).mock.calls[0]?.[2]).toBe("keep_alive");
    expect(vi.mocked(submitStellar).mock.calls[0]?.[3]("ignored")).toHaveLength(4);
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
    expect(db.calls[0]?.params[0]).toBe(config.indexer.stellar?.chain);
    expect(db.calls.some((call) => /INSERT|UPDATE/.test(call.sql))).toBe(false);
  });
  it("performs no claim submissions without a Stellar signer", async () => {
    const config = loadConfig({ env: completeEnv() });
    const result = await processClaimSettlement({ config, db: new Db(), logger });
    expect(result.attempted).toBe(0);
    expect(result.settled).toBe(0);
    expect(submitStellar).not.toHaveBeenCalled();
  });
  it("reports disabled versus not-started worker states", () => {
    const config = loadConfig({ env: completeEnv() });
    expect(new KeeperWorker(config, new Db(), logger).readiness().state).toBe("degraded");
    const disabled = loadConfig({ env: completeEnv({ KEEPER_ENABLED: "false" }) });
    expect(new KeeperWorker(disabled, new Db(), logger).readiness().state).toBe("ready");
  });
  it("restores archived claims without changing recipient or amount", async () => {
    const config = loadConfig({
      env: completeEnv({ KEEPER_STELLAR_SECRET: Keypair.random().secret() }),
    });
    vi.mocked(submitRestore).mockResolvedValue("restore-hash");
    const db = new Db();
    db.claims = [{ claim_id: "10", archived: true }];
    db.transfers = [{ nonce: "20", archived: true }];
    const result = await processRestore({ config, db, logger });
    expect(result.restoredClaims).toBe(1);
    expect(result.restoredTransfers).toBe(1);
    expect(result.dryRun).toBe(false);
    expect(vi.mocked(submitRestore).mock.calls[0]?.[2]).toEqual([10n]);
    expect(vi.mocked(submitRestore).mock.calls[0]?.[3]).toEqual([20n]);
  });
  it("treats archived entries as present, not absent", async () => {
    const config = loadConfig({
      env: completeEnv({ KEEPER_STELLAR_SECRET: Keypair.random().secret() }),
    });
    vi.mocked(submitRestore).mockResolvedValue("restore-hash");
    const db = new Db();
    db.claims = [{ claim_id: "11", archived: true }];
    db.transfers = [];
    const result = await processRestore({ config, db, logger });
    expect(result.restoredClaims).toBe(1);
    expect(result.restoredTransfers).toBe(0);
    expect(result.dryRun).toBe(false);
  });
  it("performs dry run restore when no signer", async () => {
    const config = loadConfig({ env: completeEnv() });
    const db = new Db();
    db.claims = [{ claim_id: "12", archived: true }];
    const result = await processRestore({ config, db, logger });
    expect(result.dryRun).toBe(true);
    expect(result.restoredClaims).toBe(1);
    expect(vi.mocked(submitRestore)).not.toHaveBeenCalled();
  });
});
