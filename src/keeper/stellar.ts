import type { xdr } from "@stellar/stellar-sdk";
import { BASE_FEE, Contract, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import type { AppConfig } from "../config/config.js";
import { activeKeeperSigner } from "./signers.js";
import { recordKeeperSubmission, updateKeeperSubmission } from "./outcomes.js";
import type { Queryable } from "../db/pool.js";

// One signer sequence at a time across scheduled Stellar jobs in this process.
let last: Promise<unknown> = Promise.resolve();
export function submitStellar(
  config: AppConfig,
  contract: string,
  method: string,
  args: (sender: string) => xdr.ScVal[],
  options: {
    readonly db?: Queryable;
    readonly jobName?: "ttl-bump" | "claim-settlement";
  } = {},
): Promise<string> {
  const operation = last
    .catch(() => undefined)
    .then(async () => {
      const chain = config.indexer.stellar;
      if (!chain || config.keeper.stellarSecrets.length === 0)
        throw new Error("A Stellar deployment and keeper signer are required.");
      const signer = activeKeeperSigner(config);
      const key = signer.key;
      const client = new rpc.Server(chain.rpcUrl, { timeout: 15_000 });
      if ((await client.getNetwork()).passphrase !== chain.networkPassphrase)
        throw new Error("Keeper RPC network mismatch.");
      const account = await client.getAccount(key.publicKey());
      const accountEntry = await client.getAccountEntry(key.publicKey());
      if (accountEntry.balance <= 0n)
        throw new Error(`Keeper signer ${key.publicKey()} is unfunded.`);
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
      const evidence =
        options.db !== undefined && options.jobName !== undefined
          ? await recordKeeperSubmission(options.db, {
              jobName: options.jobName,
              signerPublicKey: key.publicKey(),
              transactionHash: submitted.hash,
              stage: "submitted",
            })
          : 0;
      if (evidence !== 0 && options.db !== undefined)
        await updateKeeperSubmission(options.db, evidence, {
          stage: "pending",
          transactionHash: submitted.hash,
        });
      if (submitted.status === "ERROR" || submitted.status === "TRY_AGAIN_LATER")
        throw new Error(`Keeper submission ${submitted.status}.`);
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const result = await client.getTransaction(submitted.hash);
        if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
          if (evidence !== 0 && options.db !== undefined)
            await updateKeeperSubmission(options.db, evidence, {
              stage: "confirmed",
              transactionHash: submitted.hash,
            });
          return submitted.hash;
        }
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
