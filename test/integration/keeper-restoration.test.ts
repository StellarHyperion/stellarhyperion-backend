import {
  Account,
  Address,
  Contract,
  Keypair,
  SorobanDataBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import type { Transaction } from "@stellar/stellar-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/config.js";
import { Database } from "../../src/db/pool.js";
import { submitStellar } from "../../src/keeper/stellar.js";
import { completeEnv } from "../helpers.js";

const connection = process.env.TEST_DATABASE_URL;
const suite = connection === undefined ? describe.skip : describe;
suite("real PostgreSQL archived keeper submission recovery", () => {
  let db: Database;
  const signer = Keypair.random();
  const loaded = loadConfig({ env: completeEnv({ KEEPER_STELLAR_SECRET: signer.secret() }) });
  const config = {
    ...loaded,
    indexer: {
      ...loaded.indexer,
      stellar: { ...loaded.indexer.stellar!, chain: "stellar-testnet" as const },
    },
  };
  const chain = config.indexer.stellar;
  beforeAll(() => {
    db = Database.open(connection!, { applicationName: "hyperion-restore-298" });
  });
  afterAll(async () => {
    await db.query("DELETE FROM keeper_spending_audit WHERE signer=$1", [signer.publicKey()]);
    await db.query("DELETE FROM keeper_spending_window WHERE signer=$1", [signer.publicKey()]);
    await db.query("DELETE FROM keeper_checkpoint WHERE signer = $1", [signer.publicKey()]);
    await db.query("DELETE FROM keeper_signer_state WHERE chain_key=$1", [
      config.indexer.stellar.chain,
    ]);
    await db.close();
  });
  it("commits an uncertain restore hash across lock rollback, reconciles it, and submits the unchanged claim once", async () => {
    let restored = false,
      uncertain = true,
      sequence = 100;
    let simulations = 0;
    const broadcasts: { hash: string; type: string }[] = [];
    const success: rpc.Api.SimulateTransactionSuccessResponse = {
      _parsed: true,
      id: "fixture",
      latestLedger: 100,
      events: [],
      minResourceFee: "0",
      transactionData: new SorobanDataBuilder(),
      result: { auth: [], retval: xdr.ScVal.scvVoid() },
    };
    const client = {
      getLatestLedger: () => Promise.resolve({ sequence: 100 }),
      getNetwork: () => Promise.resolve({ passphrase: chain.networkPassphrase }),
      getAccountEntry: () => Promise.resolve({ balance: 100000000n }),
      getAccount: () => Promise.resolve(new Account(signer.publicKey(), String(sequence++))),
      simulateTransaction: () => {
        simulations++;
        return Promise.resolve(
          restored
            ? success
            : {
                ...success,
                restorePreamble: {
                  minResourceFee: "1000",
                  transactionData: new SorobanDataBuilder().setFootprint(
                    [],
                    [new Contract(chain.routerContractId).getFootprint()],
                  ),
                },
              },
        );
      },
      prepareTransaction: (transaction: Transaction) => Promise.resolve(transaction),
      sendTransaction: (transaction: Transaction) => {
        const hash = Buffer.from(transaction.hash()).toString("hex");
        broadcasts.push({ hash, type: transaction.operations[0]!.type });
        if (uncertain) return Promise.reject(new Error("mock lost broadcast response"));
        return Promise.resolve({ hash, status: "PENDING" });
      },
      getTransaction: () => {
        if (!uncertain) restored = true;
        return Promise.resolve({
          status: uncertain
            ? rpc.Api.GetTransactionStatus.NOT_FOUND
            : rpc.Api.GetTransactionStatus.SUCCESS,
        });
      },
    } as unknown as rpc.Server;
    const submit = () =>
      submitStellar(
        config,
        db,
        chain.chain,
        chain.routerContractId,
        "settle_claim",
        "settle_claim",
        (sender) => [
          new Address(sender).toScVal(),
          nativeToScVal(18446744073709551615n, { type: "u64" }),
        ],
        { client, confirmationAttempts: 1 },
      );
    await expect(submit()).rejects.toThrow("outcome is unknown");
    const saved = await db.query(
      "SELECT hash, phase, state FROM keeper_checkpoint WHERE signer = $1",
      [signer.publicKey()],
    );
    expect(saved.rows).toEqual([
      { hash: broadcasts[0]!.hash, phase: "restore", state: "submitted" },
    ]);
    expect(broadcasts[0]?.type).toBe("restoreFootprint");
    await expect(submit()).rejects.toThrow("saved checkpoint blocks");
    expect(broadcasts).toHaveLength(1);
    expect(simulations).toBe(1);
    uncertain = false;
    const confirmed = await submit();
    expect(broadcasts).toHaveLength(2);
    expect(broadcasts[1]).toMatchObject({ hash: confirmed, type: "invokeHostFunction" });
    const final = await db.query(
      "SELECT phase, state FROM keeper_checkpoint WHERE signer = $1 ORDER BY phase",
      [signer.publicKey()],
    );
    expect(final.rows).toEqual([
      { phase: "invoke", state: "confirmed" },
      { phase: "restore", state: "confirmed" },
    ]);
    expect(await submit()).toBe(confirmed);
    expect(broadcasts).toHaveLength(2);
  });
});
