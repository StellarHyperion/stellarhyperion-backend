import { createHash } from "node:crypto";
import type { Transaction, xdr } from "@stellar/stellar-sdk";
import { BASE_FEE, Contract, Keypair, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import type { AppConfig } from "../config/config.js";
import type { Transactional } from "../db/pool.js";

export type KeeperOperation = "keep_alive" | "settle_claim";
export interface StellarSubmissionOptions {
  readonly client?: rpc.Server;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly confirmationAttempts?: number;
  readonly prepareWithRestore?: (
    client: rpc.Server,
    build: () => Promise<Transaction>,
    submitPrepared: (prepared: Transaction, phase: "restore") => Promise<string>,
  ) => Promise<Transaction>;
}

/** A signer lock lives on one dedicated transaction connection. Checkpoints use db.query on
 * another connection, so the public hash is COMMITTED before broadcast and survives rollback,
 * lost responses and process crashes. Every unknown hash blocks fresh envelopes for that signer. */
export function submitStellar(
  config: AppConfig,
  db: Transactional,
  chainKey: string,
  contract: string,
  operation: KeeperOperation,
  method: string,
  args: (sender: string) => xdr.ScVal[],
  options: StellarSubmissionOptions = {},
): Promise<string> {
  const pool = db as Transactional & { poolSnapshot?: () => { maxConnections: number } };
  if (pool.poolSnapshot && pool.poolSnapshot().maxConnections < 2)
    return Promise.reject(
      new Error("Keeper durable signing requires at least two database connections."),
    );
  const chain = config.indexer.stellar;
  const secret = config.keeper.stellarSecret;
  if (!chain || !secret || chainKey !== chain.chain || contract !== chain.routerContractId)
    return Promise.reject(
      new Error("A configured Stellar keeper deployment and signer are required."),
    );
  if (method !== operation)
    return Promise.reject(
      new Error("Keeper operation must match its supported maintenance method."),
    );
  const key = Keypair.fromSecret(secret);
  const signer = key.publicKey();
  const values = args(signer);
  const intent = createHash("sha256")
    .update(
      JSON.stringify([chainKey, contract, method, ...values.map((value) => value.toXDR("base64"))]),
    )
    .digest("hex");
  const client = options.client ?? new rpc.Server(chain.rpcUrl, { timeout: 15_000 });
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attempts = options.confirmationAttempts ?? 30;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 30)
    return Promise.reject(new Error("Invalid keeper confirmation budget."));

  return db.transaction(async (lock) => {
    await lock.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      "keeper-signer:" + chain.networkPassphrase + ":" + signer,
    ]);
    if ((await client.getNetwork()).passphrase !== chain.networkPassphrase)
      throw new Error("Keeper RPC network mismatch.");

    const reconcile = async (hash: string): Promise<"confirmed" | "failed"> => {
      if (!/^[0-9a-f]{64}$/.test(hash))
        throw new Error("Keeper checkpoint contains an invalid public hash.");
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        let result;
        try {
          result = await client.getTransaction(hash);
        } catch {
          throw new Error(
            "Keeper transaction outcome is unknown; saved checkpoint must be reconciled before retry.",
          );
        }
        if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
          await db.query(
            "UPDATE keeper_checkpoint SET state = 'confirmed', confirmed_at = now(), detail = 'confirmed on chain' WHERE hash = $1 AND state = 'submitted'",
            [hash],
          );
          return "confirmed";
        }
        if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
          await db.query(
            "UPDATE keeper_checkpoint SET state = 'failed', detail = 'failed on chain' WHERE hash = $1 AND state = 'submitted'",
            [hash],
          );
          return "failed";
        }
        if (attempt + 1 < attempts) await sleep(2000);
      }
      throw new Error(
        "Keeper transaction outcome remains unknown; its saved checkpoint blocks new submission.",
      );
    };

    const { rows } = await db.query(
      "SELECT hash, intent_key, phase FROM keeper_checkpoint WHERE chain_key = $1 AND signer = $2 AND state = 'submitted' ORDER BY created_at, hash LIMIT 2",
      [chainKey, signer],
    );
    if (rows.length > 1)
      throw new Error("Multiple unresolved signer checkpoints require reconciliation.");
    const pending = rows[0];
    if (pending) {
      const outcome = await reconcile(String(pending.hash));
      if (outcome === "confirmed" && pending.intent_key === intent && pending.phase === "invoke")
        return String(pending.hash);
      if (outcome === "failed" && pending.intent_key === intent)
        throw new Error("Previous keeper transaction failed on chain.");
    }
    // A confirmed same intent must not be signed again while chain indexing is catching up.
    const known = await db.query(
      "SELECT hash FROM keeper_checkpoint WHERE chain_key = $1 AND signer = $2 AND intent_key = $3 AND phase = 'invoke' AND state = 'confirmed' ORDER BY created_at DESC LIMIT 1",
      [chainKey, signer, intent],
    );
    if (known.rows[0] && operation === "settle_claim") return String(known.rows[0].hash);

    const build = async (): Promise<Transaction> => {
      const account = await client.getAccount(signer);
      return new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: chain.networkPassphrase,
      })
        .addOperation(new Contract(contract).call(method, ...values))
        .setTimeout(120)
        .build();
    };
    const submitPrepared = async (
      prepared: Transaction,
      phase: "restore" | "invoke",
    ): Promise<string> => {
      prepared.sign(key);
      const hash = Buffer.from(prepared.hash()).toString("hex");
      await db.query(
        `INSERT INTO keeper_checkpoint(hash,operation,chain_key,contract,signer,intent_key,phase,state,detail)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'submitted','signed; outcome unconfirmed')`,
        [hash, operation, chainKey, contract, signer, intent, phase],
      );
      let submitted;
      try {
        submitted = await client.sendTransaction(prepared);
      } catch {
        throw new Error(
          "Keeper broadcast outcome is unknown; reconcile the saved public hash before retry.",
        );
      }
      if (submitted.hash !== hash)
        throw new Error(
          "Keeper RPC returned a different transaction hash; saved outcome requires reconciliation.",
        );
      if (submitted.status === "ERROR") {
        await db.query(
          "UPDATE keeper_checkpoint SET state = 'failed', detail = 'RPC rejected submission' WHERE hash = $1 AND state = 'submitted'",
          [hash],
        );
        throw new Error("Keeper submission rejected by RPC.");
      }
      // TRY_AGAIN_LATER is ambiguous: keep the committed checkpoint and never prepare a second
      // envelope until getTransaction proves a terminal result for this exact signed hash.
      if ((await reconcile(hash)) === "failed")
        throw new Error("Keeper transaction failed on chain.");
      return hash;
    };
    const prepared = options.prepareWithRestore
      ? await options.prepareWithRestore(client, build, (transaction, phase) =>
          submitPrepared(transaction, phase),
        )
      : await client.prepareTransaction(await build());
    return submitPrepared(prepared, "invoke");
  });
}
