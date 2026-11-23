import { randomUUID } from "node:crypto";
import { Account, Keypair, rpc } from "@stellar/stellar-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/config.js";
import { Database } from "../../src/db/pool.js";
import {
  acquireKeeperSignerLease,
  assertKeeperSignerLease,
  keeperSignerLeaseParams,
  releaseKeeperSignerLease,
} from "../../src/keeper/signers.js";
import { submitStellar } from "../../src/keeper/stellar.js";
import { completeEnv } from "../helpers.js";

const connection = process.env.TEST_DATABASE_URL;
(connection ? describe : describe.skip)("keeper signer leases on PostgreSQL", () => {
  let db: Database;
  const key = Keypair.random();
  const config = loadConfig({
    env: completeEnv({ KEEPER_STELLAR_SECRET: key.secret() }),
  });
  const chain = config.indexer.stellar!;
  const owner = () => `fixture:${randomUUID()}`;
  const lease = keeperSignerLeaseParams(config, owner());
  const clean = async () => {
    await db.query("DELETE FROM indexer_lease WHERE chain_key=$1 AND contract=$2", [
      lease.chainKey,
      lease.contract,
    ]);
    await db.query("DELETE FROM keeper_checkpoint WHERE signer=$1", [key.publicKey()]);
    await db.query("DELETE FROM keeper_submission WHERE signer_public_key=$1", [key.publicKey()]);
    await db.query("DELETE FROM keeper_spending_audit WHERE signer=$1", [key.publicKey()]);
    await db.query("DELETE FROM keeper_spending_window WHERE signer=$1", [key.publicKey()]);
    await db.query("DELETE FROM keeper_signer_state WHERE chain_key=$1", [chain.chain]);
  };
  const fixture = () => {
    let broadcasts = 0;
    let preparations = 0;
    const client = {
      getNetwork: () => Promise.resolve({ passphrase: chain.networkPassphrase }),
      getAccountEntry: () => Promise.resolve({ balance: 100000000n }),
      getLatestLedger: () => Promise.resolve({ sequence: 100 }),
      getAccount: () => {
        preparations++;
        return Promise.resolve(new Account(key.publicKey(), "1"));
      },
      sendTransaction: async (transaction: { hash(): Uint8Array }) => {
        broadcasts++;
        const hash = Buffer.from(transaction.hash()).toString("hex");
        // A different connection must already see the checkpoint before broadcast.
        expect(
          (await db.query("SELECT hash,state FROM keeper_checkpoint WHERE hash=$1", [hash])).rows,
        ).toEqual([{ hash, state: "submitted" }]);
        return { hash, status: "PENDING" };
      },
      getTransaction: () => Promise.resolve({ status: rpc.Api.GetTransactionStatus.SUCCESS }),
    } as unknown as rpc.Server;
    return { client, counts: () => ({ broadcasts, preparations }) };
  };
  const submit = (
    f: ReturnType<typeof fixture>,
    prepare: NonNullable<Parameters<typeof submitStellar>[7]>["prepareWithRestore"],
    processOwner = owner(),
  ) =>
    submitStellar(
      config,
      db,
      chain.chain,
      chain.routerContractId,
      "settle_claim",
      "settle_claim",
      () => [],
      {
        client: f.client,
        confirmationAttempts: 1,
        signerLeaseOwnerId: processOwner,
        ...(prepare === undefined ? {} : { prepareWithRestore: prepare }),
      },
    );

  beforeAll(() => {
    db = Database.open(connection ?? "", {
      maxConnections: 5,
      lockTimeoutMs: 500,
      transactionLockTimeoutMs: 500,
    });
  });
  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await db.close();
  });

  it("shares one lease across routers using the same network and signer", async () => {
    const first = owner();
    const other = {
      ...config,
      indexer: { ...config.indexer, stellar: { ...chain, routerContractId: "another-router" } },
    };
    expect(keeperSignerLeaseParams(other, first)).toEqual(keeperSignerLeaseParams(config, first));
    await acquireKeeperSignerLease(db, config, first);
    await expect(acquireKeeperSignerLease(db, other, owner())).rejects.toThrow("another replica");
    await releaseKeeperSignerLease(db, config, first);
  });

  it("fences simultaneous jobs with one process identity and broadcasts without self-deadlock", async () => {
    const f = fixture();
    let started!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const sharedProcess = owner();
    const first = submit(
      f,
      async (_client, build) => {
        const transaction = await build();
        started();
        await gate;
        return transaction;
      },
      sharedProcess,
    );
    await entered;
    await expect(submit(f, async (_client, build) => build(), sharedProcess)).rejects.toThrow(
      "another replica",
    );
    resume();
    expect(await first).toMatch(/^[0-9a-f]{64}$/);
    expect(f.counts()).toEqual({ broadcasts: 1, preparations: 1 });
    expect(
      (await db.query("SELECT owner_id FROM indexer_lease WHERE contract=$1", [lease.contract]))
        .rows,
    ).toEqual([]);
  });

  it("refuses signing after expiry and takeover and never deletes the replacement lease", async () => {
    const f = fixture();
    const replacement = owner();
    await expect(
      submit(f, async (_client, build) => {
        const transaction = await build();
        await db.query(
          "UPDATE indexer_lease SET lease_until=clock_timestamp()-interval '1 second' WHERE chain_key=$1 AND contract=$2",
          [lease.chainKey, lease.contract],
        );
        await acquireKeeperSignerLease(db, config, replacement);
        return transaction;
      }),
    ).rejects.toThrow("lease lost");
    expect(f.counts()).toEqual({ broadcasts: 0, preparations: 1 });
    expect(
      (await db.query("SELECT hash FROM keeper_checkpoint WHERE signer=$1", [key.publicKey()]))
        .rows,
    ).toEqual([]);
    await assertKeeperSignerLease(db, config, replacement);
    await releaseKeeperSignerLease(db, config, replacement);
  });

  it("recovers a crashed expired lease on a reopened connection and renews only live ownership", async () => {
    const crashed = owner();
    await acquireKeeperSignerLease(db, config, crashed);
    await db.close();
    db = Database.open(connection ?? "", { maxConnections: 5 });
    await expect(acquireKeeperSignerLease(db, config, owner())).rejects.toThrow("another replica");
    await db.query(
      "UPDATE indexer_lease SET lease_until=clock_timestamp()-interval '1 second' WHERE chain_key=$1 AND contract=$2",
      [lease.chainKey, lease.contract],
    );
    await expect(assertKeeperSignerLease(db, config, crashed)).rejects.toThrow("lease lost");
    const recovered = owner();
    await acquireKeeperSignerLease(db, config, recovered);
    await assertKeeperSignerLease(db, config, recovered);
    await expect(assertKeeperSignerLease(db, config, crashed)).rejects.toThrow("lease lost");
    await releaseKeeperSignerLease(db, config, crashed);
    await assertKeeperSignerLease(db, config, recovered);
    await releaseKeeperSignerLease(db, config, recovered);
  });
});
