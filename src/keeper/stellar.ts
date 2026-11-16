import type { xdr } from "@stellar/stellar-sdk";
import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";
import type { Logger } from "pino";
import type { AppConfig } from "../config/config.js";
import { PendingInFlightSequenceError } from "./leases.js";
import type { SignerLeaseHandle, SignerLeaseStorePort } from "./types.js";

export interface SubmitStellarOptions {
  readonly leaseStore?: SignerLeaseStorePort | undefined;
  readonly holderId?: string | undefined;
  readonly leaseTtlMs?: number | undefined;
  readonly clock?: (() => number) | undefined;
  readonly logger?: Logger | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly maxPollAttempts?: number | undefined;
}

async function reconcileTakenOverLease(
  client: rpc.Server,
  leaseStore: SignerLeaseStorePort,
  lease: SignerLeaseHandle,
  onChainSequence: bigint,
  nowFn: () => number,
  logger?: Logger,
): Promise<void> {
  if (lease.inFlightTxHash !== null) {
    const probe = await client.getTransaction(lease.inFlightTxHash);
    if (probe.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      await leaseStore.reconcileRecoveredState({
        signerPublicKey: lease.signerPublicKey,
        holderId: lease.holderId,
        fenceToken: lease.fenceToken,
        onChainSequence,
        settledInFlightSequence: lease.lastReservedSequence,
        clearUnbroadcastReservation: false,
        nowMs: nowFn(),
      });
      logger?.info(
        {
          signerPublicKey: lease.signerPublicKey,
          holderId: lease.holderId,
          fenceToken: String(lease.fenceToken),
          inFlightTxHash: lease.inFlightTxHash,
        },
        "reconciled confirmed in-flight signer transaction after lease recovery",
      );
      return;
    }

    if (probe.status === rpc.Api.GetTransactionStatus.FAILED) {
      await leaseStore.reconcileRecoveredState({
        signerPublicKey: lease.signerPublicKey,
        holderId: lease.holderId,
        fenceToken: lease.fenceToken,
        onChainSequence,
        clearUnbroadcastReservation: true,
        nowMs: nowFn(),
      });
      logger?.info(
        {
          signerPublicKey: lease.signerPublicKey,
          holderId: lease.holderId,
          fenceToken: String(lease.fenceToken),
          inFlightTxHash: lease.inFlightTxHash,
        },
        "cleared failed in-flight signer transaction after lease recovery",
      );
      return;
    }

    if (lease.lastReservedSequence !== null && onChainSequence >= lease.lastReservedSequence) {
      await leaseStore.reconcileRecoveredState({
        signerPublicKey: lease.signerPublicKey,
        holderId: lease.holderId,
        fenceToken: lease.fenceToken,
        onChainSequence,
        clearUnbroadcastReservation: false,
        nowMs: nowFn(),
      });
      return;
    }

    throw new PendingInFlightSequenceError(
      lease.signerPublicKey,
      lease.lastReservedSequence ?? onChainSequence + 1n,
      onChainSequence,
      lease.inFlightTxHash,
    );
  }

  if (lease.tookOverExpiredLease && lease.lastReservedSequence !== null) {
    await leaseStore.reconcileRecoveredState({
      signerPublicKey: lease.signerPublicKey,
      holderId: lease.holderId,
      fenceToken: lease.fenceToken,
      onChainSequence,
      clearUnbroadcastReservation: true,
      nowMs: nowFn(),
    });
    logger?.info(
      {
        signerPublicKey: lease.signerPublicKey,
        holderId: lease.holderId,
        fenceToken: String(lease.fenceToken),
        onChainSequence: String(onChainSequence),
      },
      "reconciled unbroadcast sequence reservation from expired signer lease",
    );
  }
}

async function executeLeasedOrDirectSubmission(
  config: AppConfig,
  contract: string,
  method: string,
  args: (sender: string) => xdr.ScVal[],
  options?: SubmitStellarOptions,
): Promise<string> {
  const chain = config.indexer.stellar;
  const secret = config.keeper.stellarSecret;
  if (!chain || !secret) {
    throw new Error("A Stellar deployment and keeper signer are required.");
  }

  const key = Keypair.fromSecret(secret);
  const signerPublicKey = key.publicKey();
  const client = new rpc.Server(chain.rpcUrl, { timeout: 15_000 });
  if ((await client.getNetwork()).passphrase !== chain.networkPassphrase) {
    throw new Error("Keeper RPC network mismatch.");
  }

  const leaseStore = options?.leaseStore;
  const holderId = options?.holderId ?? config.keeper.instanceId;
  const leaseTtlMs = options?.leaseTtlMs ?? config.keeper.leaseTtlMs;
  const nowFn = options?.clock ?? (() => Date.now());

  let lease: SignerLeaseHandle | null = null;
  let reservedSequence: bigint | null = null;
  let account: Account;

  if (leaseStore) {
    lease = await leaseStore.acquireOrRenew({
      signerPublicKey,
      chain: chain.chain,
      holderId,
      leaseTtlMs,
      nowMs: nowFn(),
    });

    const onChainAccount = await client.getAccount(signerPublicKey);
    const onChainSequence = BigInt(onChainAccount.sequenceNumber());

    await reconcileTakenOverLease(
      client,
      leaseStore,
      lease,
      onChainSequence,
      nowFn,
      options.logger,
    );

    const reservation = await leaseStore.reserveNextSequence({
      signerPublicKey,
      holderId,
      fenceToken: lease.fenceToken,
      onChainSequence,
      leaseTtlMs,
      nowMs: nowFn(),
    });
    reservedSequence = reservation.nextSequence;
    account = new Account(signerPublicKey, String(reservation.accountStartingSequence));
  } else {
    account = await client.getAccount(signerPublicKey);
  }

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: chain.networkPassphrase,
  })
    .addOperation(new Contract(contract).call(method, ...args(signerPublicKey)))
    .setTimeout(120)
    .build();

  let prepared: ReturnType<typeof TransactionBuilder.prototype.build>;
  try {
    prepared = await client.prepareTransaction(tx);
  } catch (error) {
    if (leaseStore && lease && reservedSequence !== null) {
      await leaseStore.recordSequenceOutcome({
        signerPublicKey,
        holderId,
        fenceToken: lease.fenceToken,
        sequenceNumber: reservedSequence,
        outcome: "aborted_or_failed",
        nowMs: nowFn(),
      });
    }
    throw error;
  }

  prepared.sign(key);
  const txHash = Buffer.from(prepared.hash()).toString("hex");

  // Re-verify distributed ownership and monotonic fence token IMMEDIATELY BEFORE broadcasting!
  if (leaseStore && lease && reservedSequence !== null) {
    await leaseStore.assertFenceBeforeBroadcast({
      signerPublicKey,
      holderId,
      fenceToken: lease.fenceToken,
      sequenceNumber: reservedSequence,
      txHash,
      nowMs: nowFn(),
    });
  }

  const submitted = await client.sendTransaction(prepared);
  if (submitted.status === "ERROR" || submitted.status === "TRY_AGAIN_LATER") {
    if (leaseStore && lease && reservedSequence !== null && submitted.status === "ERROR") {
      await leaseStore.recordSequenceOutcome({
        signerPublicKey,
        holderId,
        fenceToken: lease.fenceToken,
        sequenceNumber: reservedSequence,
        outcome: "aborted_or_failed",
        nowMs: nowFn(),
      });
    }
    throw new Error(`Keeper submission ${submitted.status}.`);
  }

  const effectiveHash = submitted.hash || txHash;
  const pollIntervalMs = options?.pollIntervalMs ?? 2_000;
  const maxPollAttempts = options?.maxPollAttempts ?? 30;
  for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
    if (pollIntervalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    const result = await client.getTransaction(effectiveHash);
    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      if (leaseStore && lease && reservedSequence !== null) {
        await leaseStore.recordSequenceOutcome({
          signerPublicKey,
          holderId,
          fenceToken: lease.fenceToken,
          sequenceNumber: reservedSequence,
          outcome: "confirmed",
          nowMs: nowFn(),
        });
      }
      return effectiveHash;
    }
    if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
      if (leaseStore && lease && reservedSequence !== null) {
        await leaseStore.recordSequenceOutcome({
          signerPublicKey,
          holderId,
          fenceToken: lease.fenceToken,
          sequenceNumber: reservedSequence,
          outcome: "aborted_or_failed",
          nowMs: nowFn(),
        });
      }
      throw new Error(`Keeper transaction ${effectiveHash} failed on chain.`);
    }
  }
  throw new Error(
    `Keeper transaction ${effectiveHash} remains pending; check its outcome before retrying.`,
  );
}

// Serialize jobs per local replica holderId while allowing distinct replicas to contend
// directly on the distributed signer lease store.
const holderQueues = new Map<string, Promise<unknown>>();
export function submitStellar(
  config: AppConfig,
  contract: string,
  method: string,
  args: (sender: string) => xdr.ScVal[],
  options?: SubmitStellarOptions,
): Promise<string> {
  const queueKey = options?.leaseStore
    ? (options.holderId ?? config.keeper.instanceId)
    : "__process_default__";
  const previous = holderQueues.get(queueKey) ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(() => executeLeasedOrDirectSubmission(config, contract, method, args, options));
  holderQueues.set(queueKey, operation);
  return operation;
}
