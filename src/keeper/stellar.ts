import type { xdr } from "@stellar/stellar-sdk";
import { BASE_FEE, Contract, Keypair, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import type { AppConfig } from "../config/config.js";
import {
  extractSimulatedCostProfile,
  KeeperBudgetExceededError,
  KeeperBudgetTracker,
} from "./budgets.js";
import type { JobBudgetSessionPort } from "./types.js";

export interface SubmitStellarOptions {
  readonly budgetSession?: JobBudgetSessionPort | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly maxPollAttempts?: number | undefined;
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

      const account = await client.getAccount(key.publicKey());
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: chain.networkPassphrase,
      })
        .addOperation(new Contract(contract).call(method, ...args(key.publicKey())))
        .setTimeout(120)
        .build();

      const sim = await client.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) {
        throw new Error(`Keeper simulation failed for ${contract}.${method}: ${sim.error}`);
      }

      const session =
        options?.budgetSession ?? new KeeperBudgetTracker(config.keeper.budgets).createJobSession();
      const costProfile = extractSimulatedCostProfile(sim, BigInt(BASE_FEE));
      const evaluation = session.evaluateBeforeSign(contract, method, costProfile);
      if (!evaluation.allowed) {
        throw new KeeperBudgetExceededError(evaluation.diagnostic);
      }

      const prepared = rpc.assembleTransaction(tx, sim).build();
      const submittedFeeStroops = BigInt(prepared.fee);
      prepared.sign(key);
      const txHash = Buffer.from(prepared.hash()).toString("hex");

      let submitted: rpc.Api.SendTransactionResponse;
      try {
        submitted = await client.sendTransaction(prepared);
      } catch (error) {
        // Network outcome after broadcast attempt is uncertain; count toward submitted spending.
        session.recordSubmitted(txHash, submittedFeeStroops);
        throw error;
      }

      if (submitted.status === "ERROR" || submitted.status === "TRY_AGAIN_LATER") {
        throw new Error(`Keeper submission ${submitted.status}.`);
      }

      session.recordSubmitted(submitted.hash, submittedFeeStroops);

      const pollIntervalMs = options?.pollIntervalMs ?? 2_000;
      const maxPollAttempts = options?.maxPollAttempts ?? 30;
      for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
        if (pollIntervalMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }
        const result = await client.getTransaction(submitted.hash);
        if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
          session.recordConfirmed(submitted.hash, submittedFeeStroops);
          return submitted.hash;
        }
        if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
          session.recordFailedAfterSubmit(submitted.hash, submittedFeeStroops);
          throw new Error(`Keeper transaction ${submitted.hash} failed on chain.`);
        }
      }
      throw new Error(
        `Keeper transaction ${submitted.hash} remains pending; check its outcome before retrying.`,
      );
    });
  last = operation;
  return operation;
}
