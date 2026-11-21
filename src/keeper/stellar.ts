import { createHash } from "node:crypto";
import type { Transaction, xdr } from "@stellar/stellar-sdk";
import { BASE_FEE, Contract, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import type { AppConfig } from "../config/config.js";
import type { Queryable, Transactional } from "../db/pool.js";
import {
  activeKeeperSigner,
  assertKeeperSignerOwnership,
  keeperSignerLock,
  validateKeeperSigner,
} from "./signers.js";
import { recordKeeperSubmission, updateKeeperSubmission } from "./outcomes.js";
import { prepareWithRestore } from "./restore.js";
import {
  KeeperMaintenancePausedError,
  KeeperSpendingCapReachedError,
  reserveKeeperSpending,
} from "./spending.js";

export type KeeperOperation = "keep_alive" | "settle_claim";
export interface StellarSubmissionOptions {
  readonly client?: rpc.Server;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly confirmationAttempts?: number;
  readonly db?: Queryable;
  readonly jobName?: "ttl-bump" | "claim-settlement";
  readonly prepareWithRestore?: (
    client: rpc.Server,
    build: () => Promise<Transaction>,
    submitPrepared: (prepared: Transaction, phase: "restore") => Promise<string>,
  ) => Promise<Transaction>;
}

/** Reconcile every unresolved public hash before an operator retries a failed BullMQ job. */
export async function reconcileKeeperCheckpointsBeforeRetry(
  config: AppConfig,
  db: Transactional,
  suppliedClient?: rpc.Server,
): Promise<void> {
  const chain = config.indexer.stellar;
  if (!chain) throw new Error("A Stellar deployment is required for keeper recovery.");
  const client = suppliedClient ?? new rpc.Server(chain.rpcUrl, { timeout: 15_000 });

  let network;
  try {
    network = await client.getNetwork();
  } catch {
    throw new Error("Keeper RPC network could not be verified before job recovery.");
  }
  if (network.passphrase !== chain.networkPassphrase)
    throw new Error("Keeper RPC network mismatch; failed job recovery is blocked.");

  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      keeperSignerLock(config),
    ]);
    const { rows } = await tx.query(
      "SELECT hash FROM keeper_checkpoint WHERE chain_key=$1 AND state='submitted' ORDER BY created_at,hash LIMIT 101",
      [chain.chain],
    );
    if (rows.length > 100)
      throw new Error("Keeper recovery exceeds its public transaction reconciliation budget.");

    for (const row of rows) {
      const hash = String(row.hash);
      if (!/^[0-9a-f]{64}$/.test(hash))
        throw new Error("Keeper checkpoint contains an invalid public hash.");
      let result;
      try {
        result = await client.getTransaction(hash);
      } catch {
        throw new Error(
          "Keeper transaction outcome is unknown; failed job recovery must wait for reconciliation.",
        );
      }
      const state =
        result.status === rpc.Api.GetTransactionStatus.SUCCESS
          ? "confirmed"
          : result.status === rpc.Api.GetTransactionStatus.FAILED
            ? "failed"
            : null;
      if (state === null)
        throw new Error(
          "Keeper transaction outcome is not terminal; failed job recovery is blocked.",
        );
      await tx.query(
        `UPDATE keeper_checkpoint SET state=$2,
          confirmed_at=CASE WHEN $2='confirmed' THEN now() ELSE NULL END,
          detail='reconciled before reviewed job recovery'
          WHERE hash=$1 AND state='submitted'`,
        [hash, state],
      );
      await tx.query(
        "UPDATE keeper_submission SET stage=$2,error_detail=NULL,updated_at=now() WHERE transaction_hash=$1 AND stage IN ('submitted','pending')",
        [hash, state],
      );
    }
    const unexplained = await tx.query(
      `SELECT 1 FROM keeper_submission s LEFT JOIN keeper_checkpoint c
        ON c.hash=s.transaction_hash
       WHERE s.stage IN ('submitted','pending') AND c.hash IS NULL LIMIT 1`,
    );
    if (unexplained.rows.length)
      throw new Error("Unresolved keeper submission evidence blocks failed job recovery.");
  });
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
  if (
    !chain ||
    config.keeper.stellarSecrets.length === 0 ||
    chainKey !== chain.chain ||
    contract !== chain.routerContractId
  )
    return Promise.reject(
      new Error("A configured Stellar keeper deployment and signer are required."),
    );
  if (method !== operation)
    return Promise.reject(
      new Error("Keeper operation must match its supported maintenance method."),
    );
  const selectedSigner = activeKeeperSigner(config);
  const key = selectedSigner.key;
  const signer = key.publicKey();
  const values = args(signer);
  const intent = createHash("sha256")
    .update(
      JSON.stringify([
        chainKey,
        contract,
        method,
        ...values.map((value) => Buffer.from(value.toXdr()).toString("base64")),
      ]),
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
      keeperSignerLock(config),
    ]);
    if (config.keeper.paused) {
      const spending = await reserveKeeperSpending(config, db, chainKey, signer, 0n, client);
      throw new KeeperMaintenancePausedError(spending.detail);
    }
    await validateKeeperSigner(config, selectedSigner, client);
    await assertKeeperSignerOwnership(lock, config, selectedSigner);

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
          await db.query(
            "UPDATE keeper_submission SET stage='confirmed',error_detail=NULL,updated_at=now() WHERE transaction_hash=$1 AND stage IN ('submitted','pending')",
            [hash],
          );
          return "confirmed";
        }
        if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
          await db.query(
            "UPDATE keeper_checkpoint SET state = 'failed', detail = 'failed on chain' WHERE hash = $1 AND state = 'submitted'",
            [hash],
          );
          await db.query(
            "UPDATE keeper_submission SET stage='failed',error_detail='failed on chain',updated_at=now() WHERE transaction_hash=$1 AND stage IN ('submitted','pending')",
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
    // Confirmed claim settlement waits for indexing; recurring keep_alive must renew TTL again.
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
      const spending = await reserveKeeperSpending(
        config,
        db,
        chainKey,
        signer,
        BigInt(prepared.fee),
        client,
      );
      if (!spending.allowed) {
        if (spending.paused) throw new KeeperMaintenancePausedError(spending.detail);
        throw new KeeperSpendingCapReachedError(spending.detail);
      }
      prepared.sign(key);
      const hash = Buffer.from(prepared.hash()).toString("hex");
      await db.query(
        `INSERT INTO keeper_checkpoint(hash,operation,chain_key,contract,signer,intent_key,phase,state,detail)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'submitted','signed; outcome unconfirmed')`,
        [hash, operation, chainKey, contract, signer, intent, phase],
      );
      const submissionId =
        options.db !== undefined && options.jobName !== undefined
          ? await recordKeeperSubmission(options.db, {
              jobName: options.jobName,
              signerPublicKey: signer,
              transactionHash: hash,
              stage: "submitted",
            })
          : null;
      let submitted;
      try {
        submitted = await client.sendTransaction(prepared);
      } catch {
        if (submissionId !== null && options.db !== undefined)
          await updateKeeperSubmission(options.db, submissionId, { stage: "pending" });
        throw new Error(
          "Keeper broadcast outcome is unknown; reconcile the saved public hash before retry.",
        );
      }
      if (submissionId !== null && options.db !== undefined)
        await updateKeeperSubmission(options.db, submissionId, { stage: "pending" });
      if (submitted.hash !== hash)
        throw new Error(
          "Keeper RPC returned a different transaction hash; saved outcome requires reconciliation.",
        );
      if (submitted.status === "ERROR") {
        if (submissionId !== null && options.db !== undefined)
          await updateKeeperSubmission(options.db, submissionId, {
            stage: "failed",
            errorDetail: "RPC rejected submission",
          });
        await db.query(
          "UPDATE keeper_checkpoint SET state = 'failed', detail = 'RPC rejected submission' WHERE hash = $1 AND state = 'submitted'",
          [hash],
        );
        throw new Error("Keeper submission rejected by RPC.");
      }
      // TRY_AGAIN_LATER is ambiguous: keep the committed checkpoint and never prepare a second
      // envelope until getTransaction proves a terminal result for this exact signed hash.
      if ((await reconcile(hash)) === "failed") {
        if (submissionId !== null && options.db !== undefined)
          await updateKeeperSubmission(options.db, submissionId, {
            stage: "failed",
            errorDetail: "transaction failed on chain",
          });
        throw new Error("Keeper transaction failed on chain.");
      }
      if (submissionId !== null && options.db !== undefined)
        await updateKeeperSubmission(options.db, submissionId, { stage: "confirmed" });
      return hash;
    };
    const prepare = options.prepareWithRestore ?? prepareWithRestore;
    let prepared: Transaction;
    try {
      prepared = await prepare(client, build, (transaction, phase) =>
        submitPrepared(transaction, phase),
      );
    } catch (error) {
      if (
        error instanceof KeeperMaintenancePausedError ||
        error instanceof KeeperSpendingCapReachedError
      )
        throw error;
      const unresolved = await db.query(
        "SELECT hash FROM keeper_checkpoint WHERE chain_key=$1 AND signer=$2 AND state='submitted' LIMIT 1",
        [chainKey, signer],
      );
      if (!unresolved.rows.length && options.db !== undefined && options.jobName !== undefined)
        await recordKeeperSubmission(options.db, {
          jobName: options.jobName,
          signerPublicKey: signer,
          stage: "failed",
          errorDetail: "maintenance simulation or restore failed",
        });
      throw new Error(
        "Keeper preparation outcome is unknown or failed; reconcile any saved hash before retry.",
      );
    }
    return submitPrepared(prepared, "invoke");
  });
}
