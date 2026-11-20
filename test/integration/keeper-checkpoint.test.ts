import { Account, Keypair, SorobanDataBuilder, rpc, xdr } from "@stellar/stellar-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database } from "../../src/db/pool.js";
import { checkSchemaCompatibility } from "../../src/db/schema.js";
import { loadConfig } from "../../src/config/config.js";
import { submitStellar } from "../../src/keeper/stellar.js";
import { completeEnv } from "../helpers.js";
const connection = process.env.TEST_DATABASE_URL;
(connection ? describe : describe.skip)(
  "keeper committed checkpoint recovery on PostgreSQL",
  () => {
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
    beforeAll(() => {
      db = Database.open(connection ?? "", { maxConnections: 3 });
    });
    afterAll(async () => {
      await db.query("DELETE FROM keeper_checkpoint WHERE signer=$1", [signer.publicKey()]);
      await db.query("DELETE FROM keeper_signer_state WHERE chain_key=$1", [
        config.indexer.stellar.chain,
      ]);
      await db.close();
    });
    it("admits the complete shipped schema without applying migrations at startup", async () => {
      await checkSchemaCompatibility(db, config.schemaVersion);
    });
    it("retains a checkpoint across signer-lock rollback and refuses a second envelope until its public hash is terminal", async () => {
      let unknown = true;
      let broadcasts = 0;
      let preparations = 0;
      const client = {
        getNetwork: () => Promise.resolve({ passphrase: config.indexer.stellar.networkPassphrase }),
        getAccountEntry: () => Promise.resolve({ balance: 100000000n }),
        getAccount: () => Promise.resolve(new Account(signer.publicKey(), "1")),
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
        sendTransaction: async (transaction: { hash(): Uint8Array }) => {
          broadcasts++;
          const hash = Buffer.from(transaction.hash()).toString("hex");
          const { rows } = await db.query(
            "SELECT hash,state FROM keeper_checkpoint WHERE signer=$1",
            [signer.publicKey()],
          );
          expect(rows).toEqual([{ hash, state: "submitted" }]);
          throw new Error("simulated lost broadcast response");
        },
        getTransaction: () =>
          Promise.resolve({
            status: unknown
              ? rpc.Api.GetTransactionStatus.NOT_FOUND
              : rpc.Api.GetTransactionStatus.SUCCESS,
          }),
      } as unknown as rpc.Server;
      const submit = () =>
        submitStellar(
          config,
          db,
          config.indexer.stellar.chain,
          config.indexer.stellar.routerContractId,
          "settle_claim",
          "settle_claim",
          () => [],
          { client, confirmationAttempts: 1 },
        );
      await expect(submit()).rejects.toThrow("broadcast outcome is unknown");
      await expect(submit()).rejects.toThrow("saved checkpoint blocks");
      expect({ broadcasts, preparations }).toEqual({ broadcasts: 1, preparations: 1 });
      unknown = false;
      const recovered = await submit();
      expect(recovered).toMatch(/^[0-9a-f]{64}$/);
      expect({ broadcasts, preparations }).toEqual({ broadcasts: 1, preparations: 1 });
      expect(
        (await db.query("SELECT state FROM keeper_checkpoint WHERE hash=$1", [recovered])).rows[0]
          ?.state,
      ).toBe("confirmed");
      await submit();
      expect(broadcasts).toBe(1);
      const lock = await db.transaction((tx) =>
        tx.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS held", [
          "keeper-ownership:" +
            config.indexer.stellar.networkPassphrase +
            ":" +
            config.indexer.stellar.chain,
        ]),
      );
      expect(lock.rows[0]?.held).toBe(true);
    });
  },
);
