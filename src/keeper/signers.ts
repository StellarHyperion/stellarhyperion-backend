import { Keypair, rpc } from "@stellar/stellar-sdk";
import type { AppConfig } from "../config/config.js";

export interface KeeperSigner {
  readonly key: Keypair;
  readonly publicKey: string;
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
  const signer = signers.find((candidate) => candidate.publicKey === selected) ?? signers[0];
  if (signer === undefined) throw new Error("No keeper signer is configured.");
  return signer;
}

export async function validateKeeperSigner(
  config: AppConfig,
  signer: KeeperSigner,
): Promise<{ readonly publicKey: string; readonly balance: string }> {
  const chain = config.indexer.stellar;
  if (chain === null) throw new Error("A Stellar deployment is required for keeper signing.");
  const client = new rpc.Server(chain.rpcUrl, { timeout: 15_000 });
  if ((await client.getNetwork()).passphrase !== chain.networkPassphrase) {
    throw new Error(`Keeper signer ${signer.publicKey} is pointed at the wrong Stellar network.`);
  }
  const account = await client.getAccountEntry(signer.publicKey);
  const balance = account.balance.toString();
  if (BigInt(balance) <= 0n) throw new Error(`Keeper signer ${signer.publicKey} is unfunded.`);
  return { publicKey: signer.publicKey, balance };
}
