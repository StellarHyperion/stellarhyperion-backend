import type { Account, Transaction, xdr } from "@stellar/stellar-sdk";
import { BASE_FEE, Contract, Keypair, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import type { Logger } from "pino";
import type { AppConfig } from "../config/config.js";
import {
  KeeperSpendingCapExceededError,
  sanitizeSpendDiagnostic,
  type KeeperSpendingTracker,
  type SpendReservationTicket,
} from "./spending.js";

export interface KeeperStellarRpcAdapter {
  getNetwork(): Promise<{ readonly passphrase: string }>;
  getLatestLedger?(): Promise<{ readonly sequence: number }>;
  getAccount(address: string): Promise<Account>;
  prepareTransaction(tx: Transaction): Promise<Transaction>;
  sendTransaction(tx: Transaction): Promise<{
    readonly status: rpc.Api.SendTransactionStatus;
    readonly hash: string;
  }>;
  getTransaction(hash: string): Promise<{
    readonly status: rpc.Api.GetTransactionStatus;
  }>;
}

export interface SubmitStellarOptions {
  readonly rpcClient?: KeeperStellarRpcAdapter;
  readonly spendingTracker?: KeeperSpendingTracker;
  readonly reservationTicket?: SpendReservationTicket;
  readonly now?: Date;
  readonly ledger?: number;
  readonly logger?: Logger;
  readonly pollAttempts?: number;
  readonly pollIntervalMs?: number;
}

export function resolveKeeperSignerPublicKey(config: AppConfig): string | null {
  const secret = config.keeper.stellarSecret;
  if (secret === null) return null;
  try {
    return Keypair.fromSecret(secret).publicKey();
  } catch {
    throw new Error("Invalid keeper Stellar signer configuration.");
  }
}

export function createStellarRpcAdapter(rpcUrl: string): KeeperStellarRpcAdapter {
  const client = new rpc.Server(rpcUrl, {
    timeout: 15_000,
    allowHttp: rpcUrl.startsWith("http:"),
  });
  return {
    getNetwork: () => client.getNetwork(),
    getLatestLedger: () => client.getLatestLedger(),
    getAccount: (address: string) => client.getAccount(address),
    prepareTransaction: (tx: Transaction) => client.prepareTransaction(tx),
    sendTransaction: (tx: Transaction) => client.sendTransaction(tx),
    getTransaction: (hash: string) => client.getTransaction(hash),
  };
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

      const client = options.rpcClient ?? createStellarRpcAdapter(chain.rpcUrl);
      const tracker = options.spendingTracker;
      let ticket = options.reservationTicket;

      if ((await client.getNetwork()).passphrase !== chain.networkPassphrase) {
        if (tracker && ticket) {
          tracker.releaseAbortedBeforeSign(ticket);
        }
        throw new Error("Keeper RPC network mismatch.");
      }

      let windowLedger = options.ledger;
      if (
        windowLedger === undefined &&
        config.keeper.spendingCap.windowLedgers !== null &&
        client.getLatestLedger
      ) {
        windowLedger = (await client.getLatestLedger()).sequence;
      }

      if (tracker && !ticket) {
        ticket = tracker.reserveFee({
          signerPublicKey: key.publicKey(),
          feeStroops: BigInt(BASE_FEE),
          operation: method,
          ...(options.now !== undefined ? { now: options.now } : {}),
          ...(windowLedger !== undefined ? { ledger: windowLedger } : {}),
          ...(options.logger !== undefined ? { logger: options.logger } : {}),
        });
      }

      let prepared: Transaction;
      try {
        const account = await client.getAccount(key.publicKey());
        const tx = new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase: chain.networkPassphrase,
        })
          .addOperation(new Contract(contract).call(method, ...args(key.publicKey())))
          .setTimeout(120)
          .build();
        prepared = await client.prepareTransaction(tx);
      } catch (error) {
        if (tracker && ticket) {
          // Charge base/attempt fee against spending cap so repeated simulation/prep failures cannot loop unboundedly.
          tracker.commitFailed(ticket, ticket.reservedFeeStroops, {
            ...(options.now !== undefined ? { now: options.now } : {}),
            ...(options.logger !== undefined ? { logger: options.logger } : {}),
          });
        }
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(sanitizeSpendDiagnostic(msg));
      }

      const preparedFeeStroops = BigInt(prepared.fee);
      if (tracker && ticket) {
        ticket = tracker.adjustReservedFee(ticket, preparedFeeStroops, {
          ...(options.now !== undefined ? { now: options.now } : {}),
          ...(options.logger !== undefined ? { logger: options.logger } : {}),
        });
      }

      // Sign only after spending cap verification succeeds.
      prepared.sign(key);

      try {
        const submitted = await client.sendTransaction(prepared);
        if (submitted.status === "ERROR" || submitted.status === "TRY_AGAIN_LATER") {
          throw new Error(`Keeper submission ${submitted.status}.`);
        }
        const pollAttempts = options.pollAttempts ?? 30;
        const pollIntervalMs = options.pollIntervalMs ?? 2000;
        for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
          if (pollIntervalMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
          }
          const result = await client.getTransaction(submitted.hash);
          if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
            if (tracker && ticket) {
              tracker.commitConfirmed(ticket, preparedFeeStroops, {
                ...(options.now !== undefined ? { now: options.now } : {}),
                ...(options.logger !== undefined ? { logger: options.logger } : {}),
              });
            }
            return submitted.hash;
          }
          if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
            throw new Error(`Keeper transaction ${submitted.hash} failed on chain.`);
          }
        }
        throw new Error(
          `Keeper transaction ${submitted.hash} remains pending; check its outcome before retrying.`,
        );
      } catch (error) {
        if (error instanceof KeeperSpendingCapExceededError) {
          throw error;
        }
        if (tracker && ticket) {
          tracker.commitFailed(ticket, preparedFeeStroops, {
            ...(options.now !== undefined ? { now: options.now } : {}),
            ...(options.logger !== undefined ? { logger: options.logger } : {}),
          });
        }
        throw error;
      }
    });
  last = operation;
  return operation;
}
