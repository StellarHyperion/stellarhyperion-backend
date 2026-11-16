import type { xdr } from "@stellar/stellar-sdk";
import { BASE_FEE, Contract, Keypair, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import type { Logger } from "pino";
import type { AppConfig } from "../config/config.js";
import { sanitizeCheckpointError, UncertainBroadcastError } from "./checkpoints.js";
import type { KeeperIntendedOperation, TxCheckpointStorePort } from "./types.js";

export interface SubmitStellarOptions {
  readonly checkpointStore?: TxCheckpointStorePort | undefined;
  readonly operation?: KeeperIntendedOperation | undefined;
  readonly logger?: Logger | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly maxPollAttempts?: number | undefined;
}

async function reconcileSavedCheckpoint(
  client: rpc.Server,
  store: TxCheckpointStorePort,
  operation: KeeperIntendedOperation,
  logger?: Logger,
): Promise<string | null> {
  const existing = await store.getByOperationKey(operation.operationKey);
  if (!existing) {
    return null;
  }

  if (existing.state !== "signed_pending_broadcast" && existing.state !== "broadcast_unknown") {
    return null;
  }

  let statusResult: rpc.Api.GetTransactionResponse;
  try {
    statusResult = await client.getTransaction(existing.txHash);
  } catch (error) {
    const safeReason = sanitizeCheckpointError(error);
    await store.markBroadcastUnknown(operation.operationKey, existing.txHash, safeReason);
    logger?.warn(
      {
        operationKey: operation.operationKey,
        txHash: existing.txHash,
        jobKind: operation.jobKind,
        reason: safeReason,
      },
      "unable to verify saved keeper transaction hash; blocking retry to avoid duplicate submission",
    );
    throw new UncertainBroadcastError(
      operation.operationKey,
      existing.txHash,
      "broadcast_unknown",
      safeReason,
    );
  }

  if (statusResult.status === rpc.Api.GetTransactionStatus.SUCCESS) {
    await store.markConfirmed(operation.operationKey, existing.txHash);
    logger?.info(
      {
        operationKey: operation.operationKey,
        txHash: existing.txHash,
        jobKind: operation.jobKind,
      },
      "reconciled saved keeper checkpoint as confirmed without re-broadcasting",
    );
    return existing.txHash;
  }

  if (statusResult.status === rpc.Api.GetTransactionStatus.FAILED) {
    const reason = "Saved keeper transaction confirmed FAILED on chain during reconciliation.";
    await store.markFailed(operation.operationKey, existing.txHash, reason);
    logger?.info(
      {
        operationKey: operation.operationKey,
        txHash: existing.txHash,
        jobKind: operation.jobKind,
      },
      "saved keeper checkpoint failed on chain; proceeding with fresh submission",
    );
    return null;
  }

  const pendingReason =
    "Saved keeper transaction hash returned NOT_FOUND; outcome remains uncertain and blind retry is blocked.";
  await store.markBroadcastUnknown(operation.operationKey, existing.txHash, pendingReason);
  logger?.warn(
    {
      operationKey: operation.operationKey,
      txHash: existing.txHash,
      jobKind: operation.jobKind,
    },
    "saved keeper checkpoint remains unresolved; blocking blind retry",
  );
  throw new UncertainBroadcastError(
    operation.operationKey,
    existing.txHash,
    "broadcast_unknown",
    pendingReason,
  );
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

      const store = options?.checkpointStore;
      const intended = options?.operation;
      if (store && intended) {
        const reconciledHash = await reconcileSavedCheckpoint(
          client,
          store,
          intended,
          options.logger,
        );
        if (reconciledHash !== null) {
          return reconciledHash;
        }
      }

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

      const txHash = Buffer.from(prepared.hash()).toString("hex");
      if (store && intended) {
        await store.saveSignedBeforeBroadcast({
          ...intended,
          txHash,
          signerPublicKey: key.publicKey(),
          sequenceNumber: BigInt(prepared.sequence),
          feeStroops: BigInt(prepared.fee),
        });
        options.logger?.info(
          {
            operationKey: intended.operationKey,
            txHash,
            jobKind: intended.jobKind,
            signerPublicKey: key.publicKey(),
            sequenceNumber: prepared.sequence,
          },
          "persisted signed keeper checkpoint before broadcast",
        );
      }

      let submitted: rpc.Api.SendTransactionResponse;
      try {
        submitted = await client.sendTransaction(prepared);
      } catch (error) {
        const safeReason = sanitizeCheckpointError(error);
        if (store && intended) {
          await store.markBroadcastUnknown(intended.operationKey, txHash, safeReason);
          throw new UncertainBroadcastError(
            intended.operationKey,
            txHash,
            "broadcast_unknown",
            safeReason,
          );
        }
        throw new Error(safeReason);
      }

      const effectiveHash = submitted.hash || txHash;
      if (submitted.status === "ERROR") {
        const reason = "Keeper submission ERROR.";
        if (store && intended) {
          await store.markFailed(intended.operationKey, txHash, reason);
        }
        throw new Error(reason);
      }
      if (submitted.status === "TRY_AGAIN_LATER") {
        const reason = "Keeper submission TRY_AGAIN_LATER.";
        if (store && intended) {
          await store.markBroadcastUnknown(intended.operationKey, txHash, reason);
          throw new UncertainBroadcastError(
            intended.operationKey,
            txHash,
            "broadcast_unknown",
            reason,
          );
        }
        throw new Error(reason);
      }

      const pollIntervalMs = options?.pollIntervalMs ?? 2_000;
      const maxPollAttempts = options?.maxPollAttempts ?? 30;
      for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
        if (pollIntervalMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }
        let result: rpc.Api.GetTransactionResponse;
        try {
          result = await client.getTransaction(effectiveHash);
        } catch (error) {
          const safeReason = sanitizeCheckpointError(error);
          if (store && intended) {
            await store.markBroadcastUnknown(intended.operationKey, txHash, safeReason);
            throw new UncertainBroadcastError(
              intended.operationKey,
              txHash,
              "broadcast_unknown",
              safeReason,
            );
          }
          throw new Error(safeReason);
        }

        if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
          if (store && intended) {
            await store.markConfirmed(intended.operationKey, txHash);
          }
          return effectiveHash;
        }
        if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
          const reason = `Keeper transaction ${effectiveHash} failed on chain.`;
          if (store && intended) {
            await store.markFailed(intended.operationKey, txHash, reason);
          }
          throw new Error(reason);
        }
      }

      const pendingReason = `Keeper transaction ${effectiveHash} remains pending; check its outcome before retrying.`;
      if (store && intended) {
        await store.markBroadcastUnknown(intended.operationKey, txHash, pendingReason);
        throw new UncertainBroadcastError(
          intended.operationKey,
          txHash,
          "broadcast_unknown",
          pendingReason,
        );
      }
      throw new Error(pendingReason);
    });
  last = operation;
  return operation;
}
