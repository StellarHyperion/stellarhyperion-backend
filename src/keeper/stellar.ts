import type { xdr } from "@stellar/stellar-sdk";
import { BASE_FEE, Contract, Keypair, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import type { AppConfig } from "../config/config.js";

const SECRET_SEED_PATTERN = /\bS[A-Z2-7]{55}\b/g;
const URL_CREDENTIAL_PATTERN = /([a-z][a-z0-9+.-]*:\/\/[^:/@\s]+:)([^@\s]+)(@)/gi;

export function sanitizeKeeperText(text: string): string {
  return text
    .replace(SECRET_SEED_PATTERN, "[REDACTED_STELLAR_SECRET]")
    .replace(URL_CREDENTIAL_PATTERN, "$1[REDACTED]$3");
}

export class KeeperUncertainSubmissionError extends Error {
  readonly txHash: string;
  readonly contract: string;
  readonly method: string;

  constructor(txHash: string, contract: string, method: string) {
    super(`Keeper transaction ${txHash} remains pending; check its outcome before retrying.`);
    this.name = "KeeperUncertainSubmissionError";
    this.txHash = txHash;
    this.contract = contract;
    this.method = method;
  }
}

export type ReconciledTxStatus = "confirmed" | "failed" | "pending";

export interface KeeperTxReconciliation {
  readonly txHash: string;
  readonly status: ReconciledTxStatus;
}

export interface KeeperTxLookupClient {
  getNetwork(): Promise<{ readonly passphrase: string }>;
  getTransaction(hash: string): Promise<{
    readonly status: rpc.Api.GetTransactionStatus;
  }>;
}

export function createTxLookupClient(rpcUrl: string): KeeperTxLookupClient {
  const client = new rpc.Server(rpcUrl, {
    timeout: 15_000,
    allowHttp: rpcUrl.startsWith("http:"),
  });
  return {
    getNetwork: () => client.getNetwork(),
    getTransaction: (hash: string) => client.getTransaction(hash),
  };
}

export async function reconcileStellarTransaction(
  config: AppConfig,
  txHash: string,
  lookupClient?: KeeperTxLookupClient,
): Promise<KeeperTxReconciliation> {
  const chain = config.indexer.stellar;
  if (!chain) {
    throw new Error("No Stellar deployment configured for transaction reconciliation.");
  }
  const client = lookupClient ?? createTxLookupClient(chain.rpcUrl);
  const network = await client.getNetwork();
  if (network.passphrase !== chain.networkPassphrase) {
    throw new Error("Keeper RPC network mismatch during transaction reconciliation.");
  }
  const res = await client.getTransaction(txHash);
  if (res.status === rpc.Api.GetTransactionStatus.SUCCESS) {
    return { txHash, status: "confirmed" };
  }
  if (res.status === rpc.Api.GetTransactionStatus.FAILED) {
    return { txHash, status: "failed" };
  }
  return { txHash, status: "pending" };
}

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
      let key: Keypair;
      try {
        key = Keypair.fromSecret(secret);
      } catch {
        throw new Error("Invalid keeper Stellar signer configuration.");
      }
      const client = new rpc.Server(chain.rpcUrl, {
        timeout: 15_000,
        allowHttp: chain.rpcUrl.startsWith("http:"),
      });
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
      throw new KeeperUncertainSubmissionError(submitted.hash, contract, method);
    });
  last = operation;
  return operation;
}
