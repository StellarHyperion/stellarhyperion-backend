import type { xdr } from "@stellar/stellar-sdk";
import { BASE_FEE, Contract, Keypair, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import type { AppConfig } from "../config/config.js";

// One signer sequence at a time across scheduled Stellar jobs in this process.
let last: Promise<unknown> = Promise.resolve();
export function submitStellar(
  config: AppConfig,
  contract: string,
  method: string,
  args: (sender: string) => xdr.ScVal[],
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
      const prepared = await client.prepareTransaction(tx);
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
