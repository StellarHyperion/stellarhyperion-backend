import { AddressKind, encodeStellarAddress } from "@hyperion/protocol";
import type { Transaction, xdr } from "@stellar/stellar-sdk";
import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";
import type { AppConfig } from "../config/config.js";
import type {
  KeeperClaimPreview,
  KeeperDryRunPlan,
  KeeperOperationPreview,
  KeeperSimulatedFeeEstimate,
} from "./types.js";

/**
 * Neutral all-zero public Stellar account strkey used strictly for unsigned dry-run
 * operation construction and simulation so dry-run outputs never touch or reveal any
 * configured keeper signer identity.
 */
export const PUBLIC_UNSIGNED_SIMULATION_ADDRESS = encodeStellarAddress(
  AddressKind.Account,
  new Uint8Array(32),
);

const SECRET_SEED_PATTERN = /\bS[A-Z2-7]{55}\b/g;
const URL_CREDENTIAL_PATTERN = /([a-z][a-z0-9+.-]*:\/\/[^:/@\s]+:)([^@\s]+)(@)/gi;

export function sanitizePublicPreviewText(text: string): string {
  return text
    .replace(SECRET_SEED_PATTERN, "[REDACTED_STELLAR_SECRET]")
    .replace(URL_CREDENTIAL_PATTERN, "$1[REDACTED]$3");
}

export interface OnChainClaimSnapshot {
  readonly claimId: string;
  readonly recipient: string;
  readonly token: string | null;
  readonly amount: string;
  readonly route: number | null;
}

export interface KeeperSimulationClient {
  simulateTransaction(tx: Transaction): Promise<rpc.Api.SimulateTransactionResponse>;
  readOnChainClaim?(
    routerContractId: string,
    claimId: bigint,
  ): Promise<OnChainClaimSnapshot | null>;
}

export function createSimulationClient(rpcUrl: string): KeeperSimulationClient {
  const client = new rpc.Server(rpcUrl, {
    timeout: 15_000,
    allowHttp: rpcUrl.startsWith("http:"),
  });
  return {
    simulateTransaction: (tx: Transaction) => client.simulateTransaction(tx),
  };
}

export interface BuildOperationPreviewInput {
  readonly chain: string;
  readonly networkPassphrase: string;
  readonly rpcUrl: string;
  readonly contract: string;
  readonly method: "keep_alive" | "settle_claim";
  readonly args: (unsignedCaller: string) => xdr.ScVal[];
  readonly targetKeys: readonly string[];
  readonly argsSummary: Readonly<Record<string, unknown>>;
  readonly claimPreview?: KeeperClaimPreview;
  readonly simulationClient?: KeeperSimulationClient;
  readonly simulateViaRpc?: boolean;
}

export async function previewStellarOperation(
  input: BuildOperationPreviewInput,
): Promise<KeeperOperationPreview> {
  const neutralAccount = new Account(PUBLIC_UNSIGNED_SIMULATION_ADDRESS, "0");
  const operation = new Contract(input.contract).call(
    input.method,
    ...input.args(PUBLIC_UNSIGNED_SIMULATION_ADDRESS),
  );
  const unsignedTx = new TransactionBuilder(neutralAccount, {
    fee: BASE_FEE,
    networkPassphrase: input.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(120)
    .build();

  const operationXdr = operation.toXdr("base64");
  const simClient =
    input.simulationClient ??
    (input.simulateViaRpc === true ? createSimulationClient(input.rpcUrl) : undefined);

  let feeEstimate: KeeperSimulatedFeeEstimate = {
    baseFeeStroops: BASE_FEE,
    minResourceFeeStroops: "0",
    totalEstimatedFeeStroops: BASE_FEE,
    simulated: false,
    latestLedger: null,
    restoreRequired: false,
    simulationError: null,
  };

  if (simClient !== undefined) {
    try {
      const sim = await simClient.simulateTransaction(unsignedTx);
      if (rpc.Api.isSimulationError(sim)) {
        feeEstimate = {
          baseFeeStroops: BASE_FEE,
          minResourceFeeStroops: "0",
          totalEstimatedFeeStroops: BASE_FEE,
          simulated: true,
          latestLedger: sim.latestLedger,
          restoreRequired: false,
          simulationError: sanitizePublicPreviewText(sim.error),
        };
      } else if (rpc.Api.isSimulationRestore(sim)) {
        const resourceFee = BigInt(sim.minResourceFee) + BigInt(sim.restorePreamble.minResourceFee);
        const total = BigInt(BASE_FEE) + resourceFee;
        feeEstimate = {
          baseFeeStroops: BASE_FEE,
          minResourceFeeStroops: String(resourceFee),
          totalEstimatedFeeStroops: String(total),
          simulated: true,
          latestLedger: sim.latestLedger,
          restoreRequired: true,
          simulationError: null,
        };
      } else {
        const resourceFee = BigInt(sim.minResourceFee);
        const total = BigInt(BASE_FEE) + resourceFee;
        feeEstimate = {
          baseFeeStroops: BASE_FEE,
          minResourceFeeStroops: String(resourceFee),
          totalEstimatedFeeStroops: String(total),
          simulated: true,
          latestLedger: sim.latestLedger,
          restoreRequired: false,
          simulationError: null,
        };
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      feeEstimate = {
        baseFeeStroops: BASE_FEE,
        minResourceFeeStroops: "0",
        totalEstimatedFeeStroops: BASE_FEE,
        simulated: true,
        latestLedger: null,
        restoreRequired: false,
        simulationError: sanitizePublicPreviewText(msg),
      };
    }
  }

  return {
    chain: input.chain,
    contract: input.contract,
    method: input.method,
    unsigned: true,
    signed: false,
    broadcast: false,
    targetKeys: [...input.targetKeys],
    argsSummary: input.argsSummary,
    operationXdr,
    feeEstimate,
    ...(input.claimPreview !== undefined ? { claimPreview: input.claimPreview } : {}),
  };
}

export function assembleDryRunPlan(
  operations: readonly KeeperOperationPreview[],
): KeeperDryRunPlan {
  let totalFee = 0n;
  for (const op of operations) {
    totalFee += BigInt(op.feeEstimate.totalEstimatedFeeStroops);
  }
  return {
    mode: "dry-run",
    unsigned: true,
    signed: false,
    broadcast: false,
    totalEstimatedFeeStroops: String(totalFee),
    operations: [...operations],
  };
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
