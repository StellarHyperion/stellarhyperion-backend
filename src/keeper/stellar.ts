import type { xdr } from "@stellar/stellar-sdk";
import {
  BASE_FEE,
  Contract,
  Keypair,
  Operation,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";
import type { AppConfig } from "../config/config.js";
import {
  extractRestorePreamble,
  InMemoryRestoreCheckpointStore,
  reconcilePendingRestore,
  UncertainRestoreError,
} from "./restore.js";
import type { KeeperJobName, RestoreCheckpointStore } from "./types.js";

export interface RestoredFootprintEvent {
  readonly restoreTxHash: string;
  readonly footprintKeys: readonly string[];
  readonly recoveredFromCheckpoint: boolean;
}

export interface SubmitStellarOptions {
  readonly scopeKey?: string | undefined;
  readonly jobKind?: KeeperJobName | undefined;
  readonly claimId?: bigint | null | undefined;
  readonly recipientSnapshot?: string | null | undefined;
  readonly amountSnapshot?: string | null | undefined;
  readonly restoreStore?: RestoreCheckpointStore | undefined;
  readonly onRestoreConfirmed?: ((event: RestoredFootprintEvent) => void) | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly maxPollAttempts?: number | undefined;
}

const defaultProcessRestoreStore = new InMemoryRestoreCheckpointStore();

async function pollRestoreTransaction(
  client: rpc.Server,
  scopeKey: string,
  restoreTxHash: string,
  store: RestoreCheckpointStore,
  pollIntervalMs: number,
  maxPollAttempts: number,
): Promise<void> {
  for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
    if (pollIntervalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    let result: rpc.Api.GetTransactionResponse;
    try {
      result = await client.getTransaction(restoreTxHash);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await store.markStatus(scopeKey, restoreTxHash, "uncertain", message);
      throw new UncertainRestoreError(scopeKey, restoreTxHash, message);
    }
    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      await store.markStatus(scopeKey, restoreTxHash, "confirmed", null);
      return;
    }
    if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
      await store.markStatus(
        scopeKey,
        restoreTxHash,
        "failed",
        `Restore transaction ${restoreTxHash} failed on chain.`,
      );
      throw new Error(`Keeper restore transaction ${restoreTxHash} failed on chain.`);
    }
  }
  await store.markStatus(
    scopeKey,
    restoreTxHash,
    "uncertain",
    "Polling timed out before confirmation.",
  );
  throw new UncertainRestoreError(scopeKey, restoreTxHash, "polling timed out");
}

// One signer sequence at a time across scheduled Stellar jobs in this process.
let last: Promise<unknown> = Promise.resolve();
export function submitStellar(
  config: AppConfig,
  contract: string,
  method: string,
  args: (sender: string) => xdr.ScVal[],
  options?: SubmitStellarOptions,
): Promise<string> {
  const operation = last
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

      const pollIntervalMs = options?.pollIntervalMs ?? 2_000;
      const maxPollAttempts = options?.maxPollAttempts ?? 30;
      const store = options?.restoreStore ?? defaultProcessRestoreStore;
      const jobKind: KeeperJobName =
        options?.jobKind ?? (method === "settle_claim" ? "claim-settlement" : "ttl-bump");
      const scopeKey = options?.scopeKey ?? `${jobKind}:${chain.chain}:${contract}:${method}`;

      const reconciled = await reconcilePendingRestore(store, scopeKey, (hash) =>
        client.getTransaction(hash),
      );
      if (reconciled.action === "confirmed_prior" && reconciled.confirmedTxHash !== null) {
        options?.onRestoreConfirmed?.({
          restoreTxHash: reconciled.confirmedTxHash,
          footprintKeys: reconciled.record?.footprintKeys ?? [],
          recoveredFromCheckpoint: true,
        });
      }

      const buildTrialTx = async () => {
        const account = await client.getAccount(key.publicKey());
        return new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase: chain.networkPassphrase,
        })
          .addOperation(new Contract(contract).call(method, ...args(key.publicKey())))
          .setTimeout(120)
          .build();
      };

      let trialTx = await buildTrialTx();
      let sim = await client.simulateTransaction(trialTx);

      if (rpc.Api.isSimulationRestore(sim)) {
        const preamble = extractRestorePreamble(sim);
        const restoreAccount = await client.getAccount(key.publicKey());
        const restoreFee = String(BigInt(BASE_FEE) + BigInt(preamble.minResourceFee));
        const restoreTx = new TransactionBuilder(restoreAccount, {
          fee: restoreFee,
          networkPassphrase: chain.networkPassphrase,
        })
          .addOperation(Operation.restoreFootprint({}))
          .setSorobanData(preamble.sorobanData)
          .setTimeout(120)
          .build();
        restoreTx.sign(key);
        const restoreTxHash = Buffer.from(restoreTx.hash()).toString("hex");

        await store.savePending({
          scopeKey,
          chain: chain.chain,
          jobKind,
          claimId: options?.claimId ?? null,
          restoreTxHash,
          footprintKeys: preamble.footprintKeys,
          minResourceFee: preamble.minResourceFee,
          recipientSnapshot: options?.recipientSnapshot ?? null,
          amountSnapshot: options?.amountSnapshot ?? null,
        });

        let restoreSubmitted: rpc.Api.SendTransactionResponse;
        try {
          restoreSubmitted = await client.sendTransaction(restoreTx);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await store.markStatus(scopeKey, restoreTxHash, "uncertain", message);
          throw new UncertainRestoreError(scopeKey, restoreTxHash, message);
        }

        if (restoreSubmitted.status === "ERROR") {
          await store.markStatus(
            scopeKey,
            restoreTxHash,
            "failed",
            `Restore submission returned ${restoreSubmitted.status}.`,
          );
          throw new Error(`Keeper restore submission ${restoreSubmitted.status}.`);
        }
        if (restoreSubmitted.status === "TRY_AGAIN_LATER") {
          await store.markStatus(
            scopeKey,
            restoreTxHash,
            "uncertain",
            `Restore submission returned ${restoreSubmitted.status}.`,
          );
          throw new UncertainRestoreError(
            scopeKey,
            restoreTxHash,
            `submission ${restoreSubmitted.status}`,
          );
        }

        await pollRestoreTransaction(
          client,
          scopeKey,
          restoreSubmitted.hash,
          store,
          pollIntervalMs,
          maxPollAttempts,
        );
        options?.onRestoreConfirmed?.({
          restoreTxHash: restoreSubmitted.hash,
          footprintKeys: preamble.footprintKeys,
          recoveredFromCheckpoint: false,
        });

        trialTx = await buildTrialTx();
        sim = await client.simulateTransaction(trialTx);
      }

      if (rpc.Api.isSimulationError(sim)) {
        throw new Error(`Keeper simulation failed for ${contract}.${method}: ${sim.error}`);
      }
      if (rpc.Api.isSimulationRestore(sim)) {
        throw new Error(
          `Keeper simulation for ${contract}.${method} still requires archived entry restoration after restore.`,
        );
      }

      const prepared = rpc.assembleTransaction(trialTx, sim).build();
      prepared.sign(key);
      const submitted = await client.sendTransaction(prepared);
      if (submitted.status === "ERROR" || submitted.status === "TRY_AGAIN_LATER")
        throw new Error(`Keeper submission ${submitted.status}.`);
      for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
        if (pollIntervalMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }
        const result = await client.getTransaction(submitted.hash);
        if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) return submitted.hash;
        if (result.status === rpc.Api.GetTransactionStatus.FAILED)
          throw new Error(`Keeper transaction ${submitted.hash} failed on chain.`);
      }
      throw new Error(
        `Keeper transaction ${submitted.hash} remains pending; check its outcome before retrying.`,
      );
    });
  last = operation;
  return operation;
}
