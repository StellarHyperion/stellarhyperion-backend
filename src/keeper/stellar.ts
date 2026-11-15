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
import type { ReadinessReport } from "../runtime/readiness.js";
import type {
  KeeperRotationPhase,
  KeeperSignerAccountDiagnostic,
  KeeperSignerReadinessSnapshot,
} from "./types.js";

export const STELLAR_BASE_RESERVE_STROOPS = 5_000_000n;

const SECRET_SEED_PATTERN = /\bS[A-Z2-7]{55}\b/g;
const URL_CREDENTIAL_PATTERN = /([a-z][a-z0-9+.-]*:\/\/[^:/@\s]+:)([^@\s]+)(@)/gi;

export function sanitizeKeeperDiagnostic(text: string): string {
  return text
    .replace(SECRET_SEED_PATTERN, "[REDACTED_STELLAR_SECRET]")
    .replace(URL_CREDENTIAL_PATTERN, "$1[REDACTED]$3");
}

export interface KeeperStellarAccountSnapshot {
  readonly accountId: string;
  readonly sequence: string;
  readonly balanceStroops: bigint;
  readonly numSubEntries: number;
  readonly numSponsoring: number;
  readonly numSponsored: number;
  readonly sellingLiabilitiesStroops: bigint;
}

export interface KeeperStellarRpcClient {
  getNetwork(): Promise<{ readonly passphrase: string }>;
  getAccountSnapshot(address: string): Promise<KeeperStellarAccountSnapshot | null>;
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
  readonly rpcClient?: KeeperStellarRpcClient;
  readonly pollAttempts?: number;
  readonly pollIntervalMs?: number;
  readonly signerManager?: KeeperSignerManager;
}

export function computeAccountReserveStroops(snapshot: KeeperStellarAccountSnapshot): bigint {
  const rawEntries = 2 + snapshot.numSubEntries + snapshot.numSponsoring - snapshot.numSponsored;
  const reserveUnits = rawEntries > 0 ? BigInt(rawEntries) : 0n;
  return reserveUnits * STELLAR_BASE_RESERVE_STROOPS + snapshot.sellingLiabilitiesStroops;
}

export function computeSpendableStroops(snapshot: KeeperStellarAccountSnapshot): bigint {
  const reserve = computeAccountReserveStroops(snapshot);
  return snapshot.balanceStroops > reserve ? snapshot.balanceStroops - reserve : 0n;
}

export function createDefaultStellarRpcClient(rpcUrl: string): KeeperStellarRpcClient {
  const client = new rpc.Server(rpcUrl, {
    timeout: 15_000,
    allowHttp: rpcUrl.startsWith("http:"),
  });

  return {
    getNetwork: () => client.getNetwork(),
    async getAccountSnapshot(address: string): Promise<KeeperStellarAccountSnapshot | null> {
      let entry: xdr.AccountEntry;
      try {
        entry = await client.getAccountEntry(address);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.toLowerCase().includes("account not found")) {
          return null;
        }
        throw new Error(sanitizeKeeperDiagnostic(msg));
      }

      let sellingLiabilitiesStroops = 0n;
      let numSponsoring = 0;
      let numSponsored = 0;
      if (entry.ext.type === "v1") {
        sellingLiabilitiesStroops = entry.ext.v1.liabilities.selling;
        if (entry.ext.v1.ext.type === "v2") {
          numSponsoring = entry.ext.v1.ext.v2.numSponsoring;
          numSponsored = entry.ext.v1.ext.v2.numSponsored;
        }
      }

      return {
        accountId: address,
        sequence: entry.seqNum.toString(),
        balanceStroops: entry.balance,
        numSubEntries: entry.numSubEntries,
        numSponsoring,
        numSponsored,
        sellingLiabilitiesStroops,
      };
    },
    prepareTransaction: (tx: Transaction) => client.prepareTransaction(tx),
    sendTransaction: (tx: Transaction) => client.sendTransaction(tx),
    getTransaction: (hash: string) => client.getTransaction(hash),
  };
}

function parseSignerSecret(secret: string, role: "primary" | "staged"): Keypair {
  try {
    return Keypair.fromSecret(secret);
  } catch {
    throw new Error(`Invalid keeper ${role} Stellar signer configuration.`);
  }
}

interface PendingSubmissionEntry {
  readonly txHash: string;
  readonly signerPublicKey: string;
}

export interface KeeperSignerManagerOptions {
  readonly rpcClientFactory?: (rpcUrl: string) => KeeperStellarRpcClient;
  readonly pollAttempts?: number;
  readonly pollIntervalMs?: number;
}

export class KeeperSignerManager {
  private readonly rpcClientFactory: (rpcUrl: string) => KeeperStellarRpcClient;
  private readonly defaultPollAttempts: number;
  private readonly defaultPollIntervalMs: number;
  private queueTail: Promise<unknown> = Promise.resolve();
  private rotatedToPublicKey: string | null = null;
  private readonly pendingByHash = new Map<string, PendingSubmissionEntry>();
  private cachedSnapshot: KeeperSignerReadinessSnapshot;

  constructor(config: AppConfig, options: KeeperSignerManagerOptions = {}) {
    this.rpcClientFactory = options.rpcClientFactory ?? createDefaultStellarRpcClient;
    this.defaultPollAttempts = options.pollAttempts ?? 30;
    this.defaultPollIntervalMs = options.pollIntervalMs ?? 2000;
    this.cachedSnapshot = this.initialSnapshot(config);
  }

  private initialSnapshot(config: AppConfig): KeeperSignerReadinessSnapshot {
    const primary =
      config.keeper.stellarSecret !== null
        ? parseSignerSecret(config.keeper.stellarSecret, "primary").publicKey()
        : null;
    const next =
      config.keeper.nextStellarSecret !== null
        ? parseSignerSecret(config.keeper.nextStellarSecret, "staged").publicKey()
        : null;

    if (primary === null && next === null) {
      return {
        phase: "unconfigured",
        activeSigner: null,
        stagedSigner: null,
        pendingTxHashes: [],
        readyToSign: false,
        detail: "no Stellar signer configured; keeper operates in dry-run mode",
        activeAccount: null,
        stagedAccount: null,
      };
    }

    const active = primary ?? next;
    const staged = primary !== null && next !== null && next !== primary ? next : null;
    return {
      phase: "primary",
      activeSigner: active,
      stagedSigner: staged,
      pendingTxHashes: [],
      readyToSign: false,
      detail: `signer ${active ?? "none"} awaiting initial balance and network verification`,
      activeAccount: null,
      stagedAccount: null,
    };
  }

  snapshot(): KeeperSignerReadinessSnapshot {
    return this.cachedSnapshot;
  }

  readinessReport(): ReadinessReport {
    const snap = this.cachedSnapshot;
    if (snap.phase === "unconfigured") {
      return {
        name: "keeper",
        state: "ready",
        detail: sanitizeKeeperDiagnostic(snap.detail),
      };
    }
    return {
      name: "keeper",
      state: snap.readyToSign && snap.phase !== "awaiting_next_readiness" ? "ready" : "degraded",
      detail: sanitizeKeeperDiagnostic(snap.detail),
    };
  }

  recordPendingSubmission(signerPublicKey: string, txHash: string): void {
    this.pendingByHash.set(txHash, { txHash, signerPublicKey });
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queueTail.catch(() => undefined).then(work);
    this.queueTail = next;
    return next;
  }

  private resolveKeypairs(config: AppConfig): {
    readonly primary: Keypair | null;
    readonly staged: Keypair | null;
  } {
    const primary =
      config.keeper.stellarSecret !== null
        ? parseSignerSecret(config.keeper.stellarSecret, "primary")
        : null;
    const stagedRaw =
      config.keeper.nextStellarSecret !== null
        ? parseSignerSecret(config.keeper.nextStellarSecret, "staged")
        : null;
    const staged =
      stagedRaw !== null && stagedRaw.publicKey() !== primary?.publicKey() ? stagedRaw : null;
    return { primary, staged };
  }

  private async inspectSignerAccount(
    client: KeeperStellarRpcClient,
    publicKey: string,
    minBalanceStroops: bigint,
    networkMatched: boolean,
  ): Promise<{
    readonly diagnostic: KeeperSignerAccountDiagnostic;
    readonly snapshot: KeeperStellarAccountSnapshot | null;
  }> {
    if (!networkMatched) {
      return {
        snapshot: null,
        diagnostic: {
          publicKey,
          funded: false,
          networkMatched: false,
          balanceStroops: "0",
          reserveStroops: "0",
          spendableStroops: "0",
          minBalanceStroops: String(minBalanceStroops),
          ready: false,
          reason: "RPC network passphrase does not match configured Stellar deployment",
        },
      };
    }

    const accountSnap = await client.getAccountSnapshot(publicKey);
    if (accountSnap === null) {
      return {
        snapshot: null,
        diagnostic: {
          publicKey,
          funded: false,
          networkMatched: true,
          balanceStroops: "0",
          reserveStroops: "0",
          spendableStroops: "0",
          minBalanceStroops: String(minBalanceStroops),
          ready: false,
          reason: `account ${publicKey} does not exist on the configured Stellar network`,
        },
      };
    }

    const reserveStroops = computeAccountReserveStroops(accountSnap);
    const spendableStroops = computeSpendableStroops(accountSnap);
    const funded = spendableStroops >= minBalanceStroops;
    return {
      snapshot: accountSnap,
      diagnostic: {
        publicKey,
        funded,
        networkMatched: true,
        balanceStroops: String(accountSnap.balanceStroops),
        reserveStroops: String(reserveStroops),
        spendableStroops: String(spendableStroops),
        minBalanceStroops: String(minBalanceStroops),
        ready: funded,
        reason: funded
          ? null
          : `spendable balance ${String(spendableStroops)} stroops is below required ${String(minBalanceStroops)} stroops`,
      },
    };
  }

  private async reconcilePendingHashes(
    client: KeeperStellarRpcClient,
    signerPublicKey?: string,
  ): Promise<readonly string[]> {
    const unresolved: string[] = [];
    for (const [hash, entry] of this.pendingByHash.entries()) {
      if (signerPublicKey !== undefined && entry.signerPublicKey !== signerPublicKey) {
        unresolved.push(hash);
        continue;
      }
      const tx = await client.getTransaction(hash);
      if (
        tx.status === rpc.Api.GetTransactionStatus.SUCCESS ||
        tx.status === rpc.Api.GetTransactionStatus.FAILED
      ) {
        this.pendingByHash.delete(hash);
      } else {
        unresolved.push(hash);
      }
    }
    return unresolved;
  }

  async refreshReadiness(
    config: AppConfig,
    rpcClientOverride?: KeeperStellarRpcClient,
  ): Promise<KeeperSignerReadinessSnapshot> {
    return this.serialize(() => this.evaluateSignersUnlocked(config, rpcClientOverride));
  }

  private async evaluateSignersUnlocked(
    config: AppConfig,
    rpcClientOverride?: KeeperStellarRpcClient,
  ): Promise<KeeperSignerReadinessSnapshot> {
    const chain = config.indexer.stellar;
    const { primary, staged } = this.resolveKeypairs(config);

    if (primary === null && staged === null) {
      const snap: KeeperSignerReadinessSnapshot = {
        phase: "unconfigured",
        activeSigner: null,
        stagedSigner: null,
        pendingTxHashes: [],
        readyToSign: false,
        detail: "no Stellar signer configured; keeper operates in dry-run mode",
        activeAccount: null,
        stagedAccount: null,
      };
      this.cachedSnapshot = snap;
      return snap;
    }

    if (chain === null) {
      const candidate = (primary ?? staged)?.publicKey() ?? null;
      const snap: KeeperSignerReadinessSnapshot = {
        phase: "primary",
        activeSigner: candidate,
        stagedSigner: staged !== null && primary !== null ? staged.publicKey() : null,
        pendingTxHashes: [...this.pendingByHash.keys()],
        readyToSign: false,
        detail: "no Stellar deployment configured for keeper signer verification",
        activeAccount: null,
        stagedAccount: null,
      };
      this.cachedSnapshot = snap;
      return snap;
    }

    const client = rpcClientOverride ?? this.rpcClientFactory(chain.rpcUrl);
    const network = await client.getNetwork();
    const networkMatched = network.passphrase === chain.networkPassphrase;

    if (!networkMatched) {
      const candidateKey =
        this.rotatedToPublicKey !== null && staged?.publicKey() === this.rotatedToPublicKey
          ? staged.publicKey()
          : ((primary ?? staged)?.publicKey() ?? null);
      const activeDiag =
        candidateKey !== null
          ? (
              await this.inspectSignerAccount(
                client,
                candidateKey,
                config.keeper.minBalanceStroops,
                false,
              )
            ).diagnostic
          : null;
      const stagedDiag =
        staged !== null && staged.publicKey() !== candidateKey
          ? (
              await this.inspectSignerAccount(
                client,
                staged.publicKey(),
                config.keeper.minBalanceStroops,
                false,
              )
            ).diagnostic
          : null;
      const snap: KeeperSignerReadinessSnapshot = {
        phase: this.rotatedToPublicKey !== null ? "rotated" : "primary",
        activeSigner: candidateKey,
        stagedSigner: stagedDiag?.publicKey ?? null,
        pendingTxHashes: [...this.pendingByHash.keys()],
        readyToSign: false,
        detail: `RPC network passphrase mismatch on ${chain.chain}; signing blocked`,
        activeAccount: activeDiag,
        stagedAccount: stagedDiag,
      };
      this.cachedSnapshot = snap;
      return snap;
    }

    // Reconcile all tracked pending submissions before deciding sequence ownership.
    const unresolvedAll = await this.reconcilePendingHashes(client);
    const minStroops = config.keeper.minBalanceStroops;

    // Case 1: Only one signer configured (either primary alone, or staged promoted as sole key).
    if (primary === null || staged === null) {
      const single = primary ?? staged;
      if (single === null) {
        return this.cachedSnapshot;
      }
      const singleKey = single.publicKey();
      const { diagnostic } = await this.inspectSignerAccount(client, singleKey, minStroops, true);
      const pendingForActive = unresolvedAll.filter(
        (hash) => this.pendingByHash.get(hash)?.signerPublicKey === singleKey,
      );
      const ready = diagnostic.ready && pendingForActive.length === 0;
      const phase: KeeperRotationPhase =
        this.rotatedToPublicKey === singleKey ? "rotated" : "primary";
      const detail =
        pendingForActive.length > 0
          ? `reconciling ${String(pendingForActive.length)} pending submission(s) for signer ${singleKey}`
          : diagnostic.ready
            ? `signer ${singleKey} ready (${diagnostic.spendableStroops} spendable stroops)`
            : `signer ${singleKey} not ready: ${diagnostic.reason ?? "unfunded"}`;
      const snap: KeeperSignerReadinessSnapshot = {
        phase,
        activeSigner: singleKey,
        stagedSigner: null,
        pendingTxHashes: unresolvedAll,
        readyToSign: ready,
        detail,
        activeAccount: diagnostic,
        stagedAccount: null,
      };
      this.cachedSnapshot = snap;
      return snap;
    }

    // Case 2: Both primary (retiring) and staged (replacement) signers are configured.
    const primaryKey = primary.publicKey();
    const stagedKey = staged.publicKey();

    if (this.rotatedToPublicKey !== stagedKey) {
      const primaryPending = unresolvedAll.filter(
        (hash) => this.pendingByHash.get(hash)?.signerPublicKey === primaryKey,
      );
      const primaryCheck = await this.inspectSignerAccount(client, primaryKey, minStroops, true);
      const stagedCheck = await this.inspectSignerAccount(client, stagedKey, minStroops, true);

      if (primaryPending.length > 0) {
        const snap: KeeperSignerReadinessSnapshot = {
          phase: "draining_pending",
          activeSigner: primaryKey,
          stagedSigner: stagedKey,
          pendingTxHashes: unresolvedAll,
          readyToSign: false,
          detail: `draining ${String(primaryPending.length)} pending submission(s) from retiring signer ${primaryKey} before rotating to ${stagedKey}`,
          activeAccount: primaryCheck.diagnostic,
          stagedAccount: stagedCheck.diagnostic,
        };
        this.cachedSnapshot = snap;
        return snap;
      }

      if (!stagedCheck.diagnostic.ready) {
        const snap: KeeperSignerReadinessSnapshot = {
          phase: "awaiting_next_readiness",
          activeSigner: primaryKey,
          stagedSigner: stagedKey,
          pendingTxHashes: unresolvedAll,
          readyToSign: primaryCheck.diagnostic.ready,
          detail: `staged replacement signer ${stagedKey} blocked from rotation: ${stagedCheck.diagnostic.reason ?? "unfunded"}`,
          activeAccount: primaryCheck.diagnostic,
          stagedAccount: stagedCheck.diagnostic,
        };
        this.cachedSnapshot = snap;
        return snap;
      }

      // All old pending submissions are reconciled and replacement account is funded on matching network.
      this.rotatedToPublicKey = stagedKey;
    }

    const rotatedCheck = await this.inspectSignerAccount(client, stagedKey, minStroops, true);
    const rotatedPending = unresolvedAll.filter(
      (hash) => this.pendingByHash.get(hash)?.signerPublicKey === stagedKey,
    );
    const ready = rotatedCheck.diagnostic.ready && rotatedPending.length === 0;
    const snap: KeeperSignerReadinessSnapshot = {
      phase: "rotated",
      activeSigner: stagedKey,
      stagedSigner: null,
      pendingTxHashes: unresolvedAll,
      readyToSign: ready,
      detail: ready
        ? `rotated active sequence ownership to funded signer ${stagedKey} (${rotatedCheck.diagnostic.spendableStroops} spendable stroops)`
        : `rotated signer ${stagedKey} temporarily blocked: ${rotatedCheck.diagnostic.reason ?? "pending submission reconciliation"}`,
      activeAccount: rotatedCheck.diagnostic,
      stagedAccount: null,
    };
    this.cachedSnapshot = snap;
    return snap;
  }

  async submit(
    config: AppConfig,
    contract: string,
    method: string,
    args: (sender: string) => xdr.ScVal[],
    options: Omit<SubmitStellarOptions, "signerManager"> = {},
  ): Promise<string> {
    return this.serialize(async () => {
      const chain = config.indexer.stellar;
      const { primary, staged } = this.resolveKeypairs(config);
      if (chain === null || (primary === null && staged === null)) {
        throw new Error("A Stellar deployment and keeper signer are required.");
      }

      const client = options.rpcClient ?? this.rpcClientFactory(chain.rpcUrl);
      const snap = await this.evaluateSignersUnlocked(config, client);

      if (snap.activeAccount !== null && !snap.activeAccount.networkMatched) {
        throw new Error("Keeper RPC network mismatch.");
      }

      if (snap.phase === "draining_pending") {
        throw new Error(
          `Keeper rotation waiting on pending transaction reconciliation (${snap.pendingTxHashes.join(", ")}) before new sequence submission.`,
        );
      }

      const activeKeypair =
        staged !== null && snap.activeSigner === staged.publicKey() ? staged : (primary ?? staged);
      if (activeKeypair === null) {
        throw new Error("A Stellar deployment and keeper signer are required.");
      }

      if (!snap.activeAccount?.ready) {
        const reason = snap.activeAccount?.reason ?? "account readiness check failed";
        throw new Error(
          `Keeper signer ${activeKeypair.publicKey()} cannot sign maintenance: ${reason}.`,
        );
      }

      const signerPending = snap.pendingTxHashes.filter(
        (hash) => this.pendingByHash.get(hash)?.signerPublicKey === activeKeypair.publicKey(),
      );
      if (signerPending.length > 0) {
        throw new Error(
          `Keeper signer ${activeKeypair.publicKey()} has unresolved pending submission (${signerPending.join(", ")}); reconcile before retrying.`,
        );
      }

      const freshAccount = await client.getAccountSnapshot(activeKeypair.publicKey());
      if (freshAccount === null) {
        throw new Error(
          `Keeper signer ${activeKeypair.publicKey()} does not exist on ${chain.chain}.`,
        );
      }
      const spendable = computeSpendableStroops(freshAccount);
      if (spendable < config.keeper.minBalanceStroops) {
        throw new Error(
          `Keeper signer ${activeKeypair.publicKey()} has insufficient spendable balance (${String(spendable)} < ${String(config.keeper.minBalanceStroops)} stroops).`,
        );
      }

      const account = new Account(freshAccount.accountId, freshAccount.sequence);
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: chain.networkPassphrase,
      })
        .addOperation(new Contract(contract).call(method, ...args(activeKeypair.publicKey())))
        .setTimeout(120)
        .build();

      const prepared = await client.prepareTransaction(tx);
      prepared.sign(activeKeypair);
      const submitted = await client.sendTransaction(prepared);
      if (submitted.status === "ERROR" || submitted.status === "TRY_AGAIN_LATER") {
        throw new Error(`Keeper submission ${submitted.status}.`);
      }

      this.pendingByHash.set(submitted.hash, {
        txHash: submitted.hash,
        signerPublicKey: activeKeypair.publicKey(),
      });

      const pollAttempts = options.pollAttempts ?? this.defaultPollAttempts;
      const pollIntervalMs = options.pollIntervalMs ?? this.defaultPollIntervalMs;
      for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
        if (pollIntervalMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }
        const result = await client.getTransaction(submitted.hash);
        if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
          this.pendingByHash.delete(submitted.hash);
          return submitted.hash;
        }
        if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
          this.pendingByHash.delete(submitted.hash);
          throw new Error(`Keeper transaction ${submitted.hash} failed on chain.`);
        }
      }

      throw new Error(
        `Keeper transaction ${submitted.hash} remains pending; check its outcome before retrying.`,
      );
    });
  }
}

let defaultManager: KeeperSignerManager | null = null;

function getDefaultManager(config: AppConfig): KeeperSignerManager {
  defaultManager ??= new KeeperSignerManager(config);
  return defaultManager;
}

export function resetDefaultKeeperSignerManager(): void {
  defaultManager = null;
}

export function hasConfiguredKeeperSigner(config: AppConfig): boolean {
  return config.keeper.stellarSecret !== null || config.keeper.nextStellarSecret !== null;
}

export function submitStellar(
  config: AppConfig,
  contract: string,
  method: string,
  args: (sender: string) => xdr.ScVal[],
  options: SubmitStellarOptions = {},
): Promise<string> {
  const manager = options.signerManager ?? getDefaultManager(config);
  return manager.submit(config, contract, method, args, {
    ...(options.rpcClient !== undefined ? { rpcClient: options.rpcClient } : {}),
    ...(options.pollAttempts !== undefined ? { pollAttempts: options.pollAttempts } : {}),
    ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
  });
}
