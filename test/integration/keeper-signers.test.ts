import { Keypair, rpc } from "@stellar/stellar-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/config.js";
import { Database } from "../../src/db/pool.js";
import {
  activateKeeperSigner,
  activeKeeperSigner,
  assertKeeperSignerOwnership,
} from "../../src/keeper/signers.js";
import { readKeeperSubmissionMetrics, recordKeeperSubmission } from "../../src/keeper/outcomes.js";
import { submitStellar } from "../../src/keeper/stellar.js";
import { completeEnv } from "../helpers.js";

const connection = process.env.TEST_DATABASE_URL;
(connection ? describe : describe.skip)("durable funded keeper signer rotation", () => {
  let db: Database;
  const old = Keypair.random(),
    next = Keypair.random();
  const chainKey = "keeper-rotation-test";
  const hash = "ab".repeat(32);
  const loaded = loadConfig({
    env: completeEnv({
      KEEPER_STELLAR_SECRETS: `${old.secret()},${next.secret()}`,
      KEEPER_STELLAR_ACTIVE_SIGNER: next.publicKey(),
    }),
  });
  const config = {
    ...loaded,
    indexer: { ...loaded.indexer, stellar: { ...loaded.indexer.stellar!, chain: chainKey } },
  };
  const previous = { ...config, keeper: { ...config.keeper, activeSigner: old.publicKey() } };
  const clean = async () => {
    await db.query("DELETE FROM keeper_checkpoint WHERE chain_key=$1", [chainKey]);
    await db.query("DELETE FROM keeper_signer_state WHERE chain_key=$1", [chainKey]);
    await db.query("DELETE FROM keeper_submission WHERE signer_public_key=ANY($1::text[])", [
      [old.publicKey(), next.publicKey()],
    ]);
  };
  const client = (
    status = rpc.Api.GetTransactionStatus.SUCCESS,
    balance = 100000000n,
    wrongNetwork = false,
  ) => ({
    getNetwork: vi.fn(() =>
      Promise.resolve({
        passphrase: wrongNetwork ? "wrong network" : config.indexer.stellar.networkPassphrase,
      }),
    ),
    getAccountEntry: vi.fn(() => Promise.resolve({ balance })),
    getTransaction: vi.fn(() => Promise.resolve({ status })),
  });
  const seed = async () => {
    await db.query(
      "INSERT INTO keeper_signer_state(chain_key,network_passphrase,active_signer) VALUES($1,$2,$3)",
      [chainKey, config.indexer.stellar.networkPassphrase, old.publicKey()],
    );
    await db.query(
      `INSERT INTO keeper_checkpoint(hash,operation,chain_key,contract,signer,intent_key,phase,state)
      VALUES($1,'settle_claim',$2,$3,$4,$5,'invoke','submitted')`,
      [hash, chainKey, config.indexer.stellar.routerContractId, old.publicKey(), "cd".repeat(32)],
    );
    await recordKeeperSubmission(db, {
      jobName: "claim-settlement",
      signerPublicKey: old.publicKey(),
      transactionHash: hash,
      stage: "pending",
    });
  };
  beforeAll(() => {
    db = Database.open(connection ?? "", { maxConnections: 3 });
  });
  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await db.close();
  });
  it("retains old pending hashes through restart and reconciles them before switching ownership", async () => {
    await seed();
    const baseline = await readKeeperSubmissionMetrics(db);
    const pending = client(rpc.Api.GetTransactionStatus.NOT_FOUND);
    await expect(
      activateKeeperSigner(db, config, pending as unknown as rpc.Server),
    ).rejects.toThrow("rotation remains blocked");
    expect(
      (
        await db.query("SELECT active_signer FROM keeper_signer_state WHERE chain_key=$1", [
          chainKey,
        ])
      ).rows,
    ).toEqual([{ active_signer: old.publicKey() }]);
    await db.close();
    db = Database.open(connection ?? "", { maxConnections: 3 });
    expect((await readKeeperSubmissionMetrics(db)).pending).toBe(baseline.pending);
    const terminal = client();
    expect(await activateKeeperSigner(db, config, terminal as unknown as rpc.Server)).toEqual({
      publicKey: next.publicKey(),
      balance: "100000000",
    });
    expect(terminal.getTransaction).toHaveBeenCalledWith(hash);
    expect(
      (await db.query("SELECT state FROM keeper_checkpoint WHERE hash=$1", [hash])).rows,
    ).toEqual([{ state: "confirmed" }]);
    expect(
      (await db.query("SELECT stage FROM keeper_submission WHERE transaction_hash=$1", [hash]))
        .rows,
    ).toEqual([{ stage: "confirmed" }]);
    await expect(
      assertKeeperSignerOwnership(db, previous, activeKeeperSigner(previous)),
    ).rejects.toThrow("ownership changed");
    await expect(
      assertKeeperSignerOwnership(db, config, activeKeeperSigner(config)),
    ).resolves.toBeUndefined();
  });
  it("refuses unfunded or wrong-network rotation before reconciling or modifying old ownership", async () => {
    await seed();
    for (const invalid of [
      client(rpc.Api.GetTransactionStatus.SUCCESS, 0n),
      client(rpc.Api.GetTransactionStatus.SUCCESS, 100000000n, true),
    ]) {
      await expect(
        activateKeeperSigner(db, config, invalid as unknown as rpc.Server),
      ).rejects.toThrow(/unfunded|network/);
      expect(invalid.getTransaction).not.toHaveBeenCalled();
    }
    expect(
      (
        await db.query("SELECT active_signer FROM keeper_signer_state WHERE chain_key=$1", [
          chainKey,
        ])
      ).rows,
    ).toEqual([{ active_signer: old.publicKey() }]);
  });
  it("blocks an old replica before preparing another maintenance envelope", async () => {
    await activateKeeperSigner(db, config, client() as unknown as rpc.Server);
    const provider = {
      ...client(),
      getAccount: vi.fn(),
      sendTransaction: vi.fn(),
      simulateTransaction: vi.fn(),
    };
    await expect(
      submitStellar(
        previous,
        db,
        chainKey,
        config.indexer.stellar.routerContractId,
        "settle_claim",
        "settle_claim",
        () => [],
        { client: provider as unknown as rpc.Server, confirmationAttempts: 1 },
      ),
    ).rejects.toThrow("ownership changed");
    expect(provider.getAccount).not.toHaveBeenCalled();
    expect(provider.sendTransaction).not.toHaveBeenCalled();
  });
  it("preserves full-width outcome IDs and keeps dry-run counts separate from confirmed work", async () => {
    const baseline = await readKeeperSubmissionMetrics(db);
    const sequence = (
      await db.query("SELECT pg_get_serial_sequence('keeper_submission','id') AS sequence")
    ).rows[0]?.sequence;
    await db.query("SELECT setval($1::regclass,$2)", [sequence, "9007199254740993"]);
    const id = await recordKeeperSubmission(db, {
      jobName: "ttl-bump",
      signerPublicKey: next.publicKey(),
      stage: "simulated",
      errorDetail: "password=never expose",
    });
    expect(id).toBe("9007199254740994");
    const metrics = await readKeeperSubmissionMetrics(db);
    expect(metrics.simulated).toBe(baseline.simulated + 1);
    expect(metrics.confirmed).toBe(baseline.confirmed);
    expect(
      (await db.query("SELECT error_detail FROM keeper_submission WHERE id=$1", [id])).rows[0]
        ?.error_detail,
    ).toBe("maintenance simulation or submission failed");
  });
});
