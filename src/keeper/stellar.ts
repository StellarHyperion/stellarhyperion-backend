import type { xdr } from "@stellar/stellar-sdk";
import { BASE_FEE, Contract, Keypair, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import type { AppConfig } from "../config/config.js";
import {
  extractSimulationResources,
  resolveResourceBounds,
  validateMeasuredResources,
} from "./adapters.js";
import type { MaintenanceResourceBounds } from "./types.js";

export interface SubmitStellarOptions {
  readonly resourceBounds?: Partial<MaintenanceResourceBounds> | undefined;
  readonly requireCallableMethod?: boolean | undefined;
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
      if (options?.requireCallableMethod) {
        const methods = await client.getContractMethods(contract, chain.networkPassphrase);
        if (!methods.some((declared) => declared.name === method)) {
          throw new Error(`Contract ${contract} does not expose callable method ${method}.`);
        }
      }
      const account = await client.getAccount(key.publicKey());
      const builtArgs = args(key.publicKey());
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: chain.networkPassphrase,
      })
        .addOperation(new Contract(contract).call(method, ...builtArgs))
        .setTimeout(120)
        .build();
      const sim = await client.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) {
        throw new Error(`Keeper simulation failed for ${contract}.${method}: ${sim.error}`);
      }
      if (rpc.Api.isSimulationRestore(sim)) {
        throw new Error(
          `Keeper simulation for ${contract}.${method} requires archived entry restoration before submission.`,
        );
      }
      const measured = extractSimulationResources(sim);
      const bounds = resolveResourceBounds(options?.resourceBounds);
      const validation = validateMeasuredResources(measured, bounds);
      if (!validation.ok) {
        throw new Error(
          `Keeper resource bounds rejected ${contract}.${method}: ${validation.detail}`,
        );
      }
      const prepared = rpc.assembleTransaction(tx, sim).build();
      prepared.sign(key);
      const submitted = await client.sendTransaction(prepared);
      if (submitted.status === "ERROR" || submitted.status === "TRY_AGAIN_LATER")
        throw new Error(`Keeper submission ${submitted.status}.`);
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
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
