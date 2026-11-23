import { hash, Keypair, rpc } from "@stellar/stellar-sdk";
import type { AppConfig } from "../config/config.js";
import type { Queryable, Transactional } from "../db/pool.js";
import { acquireLease, assertLeaseHeld, releaseLease } from "../db/lease.js";

export interface KeeperSigner {
  readonly key: Keypair;
  readonly publicKey: string;
}

export function keeperSignerLeaseParams(config: AppConfig, ownerId: string) {
  const chain = config.indexer.stellar;
  if (!chain) throw new Error("A Stellar deployment is required for keeper signing.");
  if (!/^[A-Za-z0-9_.:-]{1,165}:[0-9a-f-]{36}$/.test(ownerId))
    throw new Error("Keeper signer lease owner identity is invalid.");
  return {
    // Stellar sequence numbers belong to an account on a network, regardless of which
    // router or chain label a replica operates. Use Stellar's canonical public network ID.
    chainKey: `keeper-signers:${Buffer.from(hash(Buffer.from(chain.networkPassphrase, "utf8"))).toString("hex")}`,
    contract: activeKeeperSigner(config).publicKey,
    ownerId,
    ttlMs: config.indexerLeaseTtlMs,
  } as const;
}

export function keeperSubmissionLock(config: AppConfig): string {
  const lease = keeperSignerLeaseParams(config, "submission:00000000-0000-4000-8000-000000000000");
  return `${lease.chainKey}:${lease.contract}`;
}

export async function acquireKeeperSignerLease(
  db: Queryable,
  config: AppConfig,
  ownerId: string,
): Promise<void> {
  const lease = await acquireLease(db, keeperSignerLeaseParams(config, ownerId));
  if (lease === null) throw new Error("Keeper signer lease is held by another replica.");
}

export async function assertKeeperSignerLease(
  db: Queryable,
  config: AppConfig,
  ownerId: string,
): Promise<void> {
  await assertLeaseHeld(db, keeperSignerLeaseParams(config, ownerId));
}

export async function releaseKeeperSignerLease(
  db: Queryable,
  config: AppConfig,
  ownerId: string,
): Promise<void> {
  await releaseLease(db, keeperSignerLeaseParams(config, ownerId));
}
export function configuredKeeperSigners(config: AppConfig): readonly KeeperSigner[] {
  return config.keeper.stellarSecrets.map((secret) => {
    const key = Keypair.fromSecret(secret);
    return { key, publicKey: key.publicKey() };
  });
}
export function activeKeeperSigner(config: AppConfig): KeeperSigner {
  const signers = configuredKeeperSigners(config);
  const selected = config.keeper.activeSigner;
  const signer =
    selected === null ? signers[0] : signers.find((candidate) => candidate.publicKey === selected);
  if (signer === undefined) throw new Error("The active keeper signer must be configured.");
  return signer;
}
export function keeperSignerLock(config: AppConfig): string {
  const chain = config.indexer.stellar;
  if (!chain) throw new Error("A Stellar deployment is required for keeper signing.");
  return "keeper-ownership:" + chain.networkPassphrase + ":" + chain.chain;
}
export async function validateKeeperSigner(
  config: AppConfig,
  signer: KeeperSigner,
  suppliedClient?: rpc.Server,
): Promise<{ readonly publicKey: string; readonly balance: string }> {
  const chain = config.indexer.stellar;
  if (!chain) throw new Error("A Stellar deployment is required for keeper signing.");
  const client = suppliedClient ?? new rpc.Server(chain.rpcUrl, { timeout: 15000 });
  try {
    if ((await client.getNetwork()).passphrase !== chain.networkPassphrase)
      throw new Error("network mismatch");
  } catch {
    throw new Error("Keeper RPC network could not be verified.");
  }
  let balance: string;
  try {
    balance = (await client.getAccountEntry(signer.publicKey)).balance.toString();
  } catch {
    throw new Error("Keeper signer account is missing or its balance is unavailable.");
  }
  if (!/^\d+$/.test(balance) || BigInt(balance) <= 0n)
    throw new Error("Keeper signer is unfunded.");
  return { publicKey: signer.publicKey, balance };
}
/** Called under the shared chain ownership lock before every new envelope is prepared. */
export async function assertKeeperSignerOwnership(
  db: Queryable,
  config: AppConfig,
  signer: KeeperSigner,
): Promise<void> {
  const chain = config.indexer.stellar;
  if (!chain) throw new Error("A Stellar deployment is required for keeper signing.");
  await db.query(
    `INSERT INTO keeper_signer_state(chain_key,network_passphrase,active_signer)
    SELECT $1,$2,$3 WHERE NOT EXISTS(SELECT 1 FROM keeper_checkpoint WHERE chain_key=$1 AND signer<>$3 AND state='submitted')
    ON CONFLICT(chain_key) DO NOTHING`,
    [chain.chain, chain.networkPassphrase, signer.publicKey],
  );
  const row = (
    await db.query(
      "SELECT active_signer,network_passphrase FROM keeper_signer_state WHERE chain_key=$1",
      [chain.chain],
    )
  ).rows[0];
  if (row?.active_signer !== signer.publicKey || row.network_passphrase !== chain.networkPassphrase)
    throw new Error("Keeper signer ownership changed; restart with the active funded signer.");
}
/** Startup is the explicit rotation boundary. Reconcile every old public checkpoint first. */
export async function activateKeeperSigner(
  db: Transactional,
  config: AppConfig,
  suppliedClient?: rpc.Server,
): Promise<{ publicKey: string; balance: string }> {
  const chain = config.indexer.stellar;
  if (!chain) throw new Error("A Stellar deployment is required for keeper signing.");
  const signer = activeKeeperSigner(config);
  const client = suppliedClient ?? new rpc.Server(chain.rpcUrl, { timeout: 15000 });
  const readiness = await validateKeeperSigner(config, signer, client);
  return db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      keeperSignerLock(config),
    ]);
    const pending = (
      await tx.query(
        "SELECT hash FROM keeper_checkpoint WHERE chain_key=$1 AND state='submitted' ORDER BY created_at,hash LIMIT 101",
        [chain.chain],
      )
    ).rows;
    if (pending.length > 100) throw new Error("Keeper rotation exceeds its reconciliation budget.");
    for (const entry of pending) {
      const hash = String(entry.hash);
      let result;
      try {
        result = await client.getTransaction(hash);
      } catch {
        throw new Error("Old keeper submission is unknown; rotation remains blocked.");
      }
      const state =
        result.status === rpc.Api.GetTransactionStatus.SUCCESS
          ? "confirmed"
          : result.status === rpc.Api.GetTransactionStatus.FAILED
            ? "failed"
            : null;
      if (state === null)
        throw new Error("Old keeper submission is pending; rotation remains blocked.");
      await tx.query(
        `UPDATE keeper_checkpoint SET state=$2,confirmed_at=CASE WHEN $2='confirmed' THEN now() ELSE NULL END,
        detail='reconciled before signer rotation' WHERE hash=$1 AND state='submitted'`,
        [hash, state],
      );
      await tx.query(
        "UPDATE keeper_submission SET stage=$2,error_detail=NULL,updated_at=now() WHERE transaction_hash=$1 AND stage IN ('submitted','pending')",
        [hash, state],
      );
    }
    const unexplained = (
      await tx.query(`SELECT 1 FROM keeper_submission s LEFT JOIN keeper_checkpoint c ON c.hash=s.transaction_hash
      WHERE s.stage IN ('submitted','pending') AND c.hash IS NULL LIMIT 1`)
    ).rows;
    if (unexplained.length)
      throw new Error("Unresolved keeper evidence requires reconciliation before rotation.");
    await tx.query(
      `INSERT INTO keeper_signer_state(chain_key,network_passphrase,active_signer) VALUES($1,$2,$3)
      ON CONFLICT(chain_key) DO UPDATE SET network_passphrase=excluded.network_passphrase,active_signer=excluded.active_signer,updated_at=now()`,
      [chain.chain, chain.networkPassphrase, signer.publicKey],
    );
    return readiness;
  });
}
