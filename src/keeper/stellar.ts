import type { Account, Transaction, xdr } from "@stellar/stellar-sdk";
import { BASE_FEE, Contract, Keypair, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import type { AppConfig } from "../config/config.js";
import type { KeeperOutcomeTracker, ReconcileDecision } from "./outcomes.js";
import type { KeeperJobName } from "./types.js";

export interface StellarSendResponse {
  readonly hash: string;
  readonly status: string;
}

export interface StellarGetTxResponse {
  readonly status: string;
}

export interface StellarKeeperRpcClient {
  getNetwork(): Promise<{ readonly passphrase: string }>;
  getAccount(publicKey: string): Promise<Account>;
  prepareTransaction(tx: Transaction): Promise<Transaction>;
  sendTransaction(tx: Transaction): Promise<StellarSendResponse>;
  getTransaction(hash: string): Promise<StellarGetTxResponse>;
}

export interface SubmitStellarOptions {
  readonly jobKind?: KeeperJobName | undefined;
  readonly outcomes?: KeeperOutcomeTracker | undefined;
  readonly rpcClient?: StellarKeeperRpcClient | undefined;
  readonly pollAttempts?: number | undefined;
  readonly pollIntervalMs?: number | undefined;
}

// One signer sequence at a time across scheduled Stellar jobs in this process.
let last: Promise<unknown> = Promise.resolve();

export function submitStellar(
  config: AppConfig,
  contract: string,
  method: string,
  args: (sender: string) => xdr.ScVal[],
  options: SubmitStellarOptions = {},
): Promise<string> {
  const jobKind: KeeperJobName =
    options.jobKind ?? (method === "settle_claim" ? "claim-settlement" : "ttl-bump");

  const operation = last
    .catch(() => undefined)
    .then(async () => {
      const chain = config.indexer.stellar;
      const secret = config.keeper.stellarSecret;
      if (!chain || !secret) {
        throw new Error("A Stellar deployment and keeper signer are required.");
      }

      const client: StellarKeeperRpcClient =
        options.rpcClient ?? new rpc.Server(chain.rpcUrl, { timeout: 15_000 });

      let submittedHash: string | null = null;
      try {
        const key = Keypair.fromSecret(secret);
        if ((await client.getNetwork()).passphrase !== chain.networkPassphrase) {
          throw new Error("Keeper RPC network mismatch.");
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
        const submitted = await client.sendTransaction(prepared);
        if (submitted.status === "ERROR" || submitted.status === "TRY_AGAIN_LATER") {
          throw new Error(`Keeper submission ${submitted.status}.`);
        }

        submittedHash = submitted.hash;
        if (options.outcomes !== undefined) {
          await options.outcomes.recordSubmitted({
            txHash: submitted.hash,
            chainKey: chain.chain,
            jobKind,
            contractId: contract,
            method,
          });
        }
      } catch (error) {
        if (submittedHash === null && options.outcomes !== undefined) {
          await options.outcomes.recordPreBroadcastFailure(jobKind);
        }
        throw error;
      }

      const maxAttempts = options.pollAttempts ?? 30;
      const intervalMs = options.pollIntervalMs ?? 2000;

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (intervalMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
        const result = await client.getTransaction(submittedHash);
        if (result.status === (rpc.Api.GetTransactionStatus.SUCCESS as string)) {
          if (options.outcomes !== undefined) {
            await options.outcomes.recordConfirmed(submittedHash, jobKind);
          }
          return submittedHash;
        }
        if (result.status === (rpc.Api.GetTransactionStatus.FAILED as string)) {
          const failureMessage = `Keeper transaction ${submittedHash} failed on chain.`;
          if (options.outcomes !== undefined) {
            await options.outcomes.recordSubmissionFailed(submittedHash, jobKind, failureMessage);
          }
          throw new Error(failureMessage);
        }
      }

      const pendingNote = `Keeper transaction ${submittedHash} remains pending; check its outcome before retrying.`;
      if (options.outcomes !== undefined) {
        await options.outcomes.touchPendingNote(submittedHash, pendingNote);
      }
      throw new Error(pendingNote);
    });

  last = operation;
  return operation;
}

export async function reconcilePendingStellarSubmissions(
  config: AppConfig,
  outcomes: KeeperOutcomeTracker,
  rpcClient?: StellarKeeperRpcClient,
): Promise<{ confirmed: number; failed: number; remainingPending: number }> {
  const chain = config.indexer.stellar;
  if (!chain) {
    const remainingPending = await outcomes.refreshPendingCount();
    return { confirmed: 0, failed: 0, remainingPending };
  }

  const client: StellarKeeperRpcClient =
    rpcClient ?? new rpc.Server(chain.rpcUrl, { timeout: 15_000 });

  return outcomes.reconcilePending(async (ref): Promise<ReconcileDecision> => {
    const result = await client.getTransaction(ref.txHash);
    if (result.status === (rpc.Api.GetTransactionStatus.SUCCESS as string)) {
      return { status: "confirmed" };
    }
    if (result.status === (rpc.Api.GetTransactionStatus.FAILED as string)) {
      return {
        status: "failed",
        reason: `Keeper transaction ${ref.txHash} failed on chain during recovery check.`,
      };
    }
    return { status: "pending" };
  });
}
