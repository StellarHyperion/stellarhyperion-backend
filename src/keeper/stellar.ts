import type { xdr } from "@stellar/stellar-sdk";
import { BASE_FEE, Contract, Keypair, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import type { AppConfig } from "../config/config.js";
import type { Queryable } from "../db/pool.js";

export type KeeperOperation = "keep_alive" | "settle_claim";

// One signer sequence at a time across scheduled Stellar jobs in this process.
let last: Promise<unknown> = Promise.resolve();

export async function submitStellar(
  config: AppConfig,
  db: Queryable,
  chainKey: string,
  contract: string,
  operation: KeeperOperation,
  method: string,
  args: (sender: string) => xdr.ScVal[],
): Promise<string> {
  const operationId = last
    .catch(() => undefined)
    .then(async () => {
      const chain = config.indexer.stellar;
      const secret = config.keeper.stellarSecret;
      if (!chain || !secret)
        throw new Error("A Stellar deployment and keeper signer are required.");
      const key = Keypair.fromSecret(secret);
      const client = new rpc.Server(chain.rpcUrl, { timeout: 15_000 });
      if ((await client.getNetwork()).passphrase !== chain.networkPassphrase)
        throw new Error("Keeper RPC network mismatch.");
      const account = await client.getAccount(key.publicKey());
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: chain.networkPassphrase,
      })
        .addOperation(new Contract(contract).call(method, ...args(key.publicKey())))
        .setTimeout(120)
        .build();
      const prepared = await client.prepareTransaction(tx);
      prepared.sign(key);

      // Persist the signed hash and intended operation durably before network submission so an
      // unknown broadcast outcome can be reconciled by the saved hash before retrying.
      const hash = String(prepared.hash());
      await db.query(
        `INSERT INTO keeper_checkpoint (hash, operation, chain_key, contract, state, detail)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (hash) DO UPDATE
         SET operation = $2, chain_key = $3, contract = $4, state = $5, detail = $6`,
        [hash, operation, chainKey, contract, "submitted", "signed and awaiting broadcast"],
      );

      const submitted = await client.sendTransaction(prepared);
      if (submitted.status === "ERROR" || submitted.status === "TRY_AGAIN_LATER") {
        await db.query(
          `UPDATE keeper_checkpoint SET state = 'failed', detail = $1 WHERE hash = $2`,
          [`submission ${submitted.status}`, hash],
        );
        throw new Error(`Keeper submission ${submitted.status}.`);
      }
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const result = await client.getTransaction(submitted.hash);
        if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
          await db.query(
            `UPDATE keeper_checkpoint SET state = 'confirmed', confirmed_at = now() WHERE hash = $1`,
            [hash],
          );
          return submitted.hash;
        }
        if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
          await db.query(
            `UPDATE keeper_checkpoint SET state = 'failed', detail = $1 WHERE hash = $2`,
            ["transaction failed on chain", hash],
          );
          throw new Error(`Keeper transaction ${submitted.hash} failed on chain.`);
        }
      }
      await db.query(
        `UPDATE keeper_checkpoint SET state = 'failed', detail = $1 WHERE hash = $2`,
        ["transaction remains pending", hash],
      );
      throw new Error(
        `Keeper transaction ${submitted.hash} remains pending; check its outcome before retrying.`,
      );
    });
  last = operationId;
  return operationId;
}
