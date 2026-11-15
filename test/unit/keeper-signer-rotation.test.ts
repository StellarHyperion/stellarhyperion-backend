import { AddressKind, encodeStellarAddress } from "@hyperion/protocol";
import { Keypair, rpc, scValToNative, type Transaction } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../../src/config/config.js";
import { processClaimSettlement } from "../../src/keeper/jobs/claims.js";
import { processTtlBump } from "../../src/keeper/jobs/ttl.js";
import {
  KeeperSignerManager,
  computeAccountReserveStroops,
  computeSpendableStroops,
  sanitizeKeeperDiagnostic,
  type KeeperStellarAccountSnapshot,
  type KeeperStellarRpcClient,
} from "../../src/keeper/stellar.js";
import { KeeperWorker } from "../../src/keeper/worker.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";

function fundedSnapshot(
  accountId: string,
  overrides: Partial<KeeperStellarAccountSnapshot> = {},
): KeeperStellarAccountSnapshot {
  return {
    accountId,
    sequence: "100",
    balanceStroops: 250_000_000n,
    numSubEntries: 0,
    numSponsoring: 0,
    numSponsored: 0,
    sellingLiabilitiesStroops: 0n,
    ...overrides,
  };
}

interface FakeRpcState {
  passphrase: string;
  accounts: Map<string, KeeperStellarAccountSnapshot>;
  txStatuses: Map<string, rpc.Api.GetTransactionStatus>;
  preparedSenders: string[];
  preparedSequences: string[];
  signedByPublicKeys: string[];
  sentHashes: string[];
  nextSendStatus?: rpc.Api.SendTransactionStatus;
}

function buildFakeRpcClient(state: FakeRpcState): {
  client: KeeperStellarRpcClient;
  prepareSpy: ReturnType<typeof vi.fn>;
  sendSpy: ReturnType<typeof vi.fn>;
} {
  let txCounter = 0;

  const prepareSpy = vi.fn((tx: Transaction) => {
    state.preparedSenders.push(tx.source);
    state.preparedSequences.push(tx.sequence);
    return Promise.resolve(tx);
  });

  const sendSpy = vi.fn((tx: Transaction) => {
    for (const [pub] of state.accounts.entries()) {
      const kp = Keypair.fromPublicKey(pub);
      const hasSig = tx.signatures.some((sig) => kp.verify(tx.hash(), sig.signature.toXdrObject()));
      if (hasSig) {
        state.signedByPublicKeys.push(pub);
      }
    }
    txCounter += 1;
    const hash = `tx-hash-${String(txCounter)}`;
    state.sentHashes.push(hash);
    const status = state.nextSendStatus ?? "PENDING";
    if (!state.txStatuses.has(hash)) {
      state.txStatuses.set(hash, rpc.Api.GetTransactionStatus.SUCCESS);
    }
    const acct = state.accounts.get(tx.source);
    if (acct) {
      state.accounts.set(tx.source, {
        ...acct,
        sequence: String(BigInt(acct.sequence) + 1n),
      });
    }
    return Promise.resolve({ status, hash });
  });

  const client: KeeperStellarRpcClient = {
    getNetwork: () => Promise.resolve({ passphrase: state.passphrase }),
    getAccountSnapshot: (address: string) => Promise.resolve(state.accounts.get(address) ?? null),
    prepareTransaction: prepareSpy,
    sendTransaction: sendSpy,
    getTransaction: (hash: string) =>
      Promise.resolve({
        status: state.txStatuses.get(hash) ?? rpc.Api.GetTransactionStatus.NOT_FOUND,
      }),
  };

  return { client, prepareSpy, sendSpy };
}

class ClaimDb {
  readonly rows: {
    claim_id: string;
    recipient: string;
    amount: string;
    settled: boolean;
  }[];
  readonly queries: { sql: string; params: readonly unknown[] }[] = [];

  constructor(
    rows: {
      claim_id: string;
      recipient: string;
      amount: string;
      settled?: boolean;
    }[],
  ) {
    this.rows = rows.map((row) => ({ ...row, settled: row.settled ?? false }));
  }

  query(sql: string, params: readonly unknown[] = []) {
    this.queries.push({ sql, params });
    if (sql.includes("pending_claim")) {
      const unsettled = this.rows.filter((r) => !r.settled);
      return Promise.resolve({ rows: unsettled, rowCount: unsettled.length });
    }
    return Promise.resolve({ rows: [{ nonce: "7" }], rowCount: 1 });
  }

  transaction<T>(work: (db: ClaimDb) => Promise<T>): Promise<T> {
    return work(this);
  }
}

describe("keeper signer rotation and balance readiness", () => {
  it("computes account reserve and spendable stroops including subentries, sponsorship, and selling liabilities", () => {
    const snap = fundedSnapshot(Keypair.random().publicKey(), {
      balanceStroops: 80_000_000n,
      numSubEntries: 4,
      numSponsoring: 2,
      numSponsored: 1,
      sellingLiabilitiesStroops: 15_000_000n,
    });
    // (2 + 4 + 2 - 1) * 5_000_000 + 15_000_000 = 35_000_000 + 15_000_000 = 50_000_000
    expect(computeAccountReserveStroops(snap)).toBe(50_000_000n);
    expect(computeSpendableStroops(snap)).toBe(30_000_000n);
  });

  it("reconciles old pending submissions before switching active sequence ownership", async () => {
    const oldSigner = Keypair.random();
    const nextSigner = Keypair.random();
    const state: FakeRpcState = {
      passphrase: TESTNET_PASSPHRASE,
      accounts: new Map([
        [oldSigner.publicKey(), fundedSnapshot(oldSigner.publicKey(), { sequence: "41" })],
        [nextSigner.publicKey(), fundedSnapshot(nextSigner.publicKey(), { sequence: "900" })],
      ]),
      txStatuses: new Map(),
      preparedSenders: [],
      preparedSequences: [],
      signedByPublicKeys: [],
      sentHashes: [],
    };
    const { client, prepareSpy } = buildFakeRpcClient(state);

    const primaryOnlyConfig = loadConfig({
      env: completeEnv({ KEEPER_STELLAR_SECRET: oldSigner.secret() }),
    });
    const manager = new KeeperSignerManager(primaryOnlyConfig, {
      rpcClientFactory: () => client,
      pollAttempts: 1,
      pollIntervalMs: 0,
    });

    // Simulate a prior submission from oldSigner that is still pending in the mempool.
    state.txStatuses.set("tx-hash-1", rpc.Api.GetTransactionStatus.NOT_FOUND);
    const db = new ClaimDb([]);
    const { logger } = capturingLogger();
    await expect(
      processTtlBump({ config: primaryOnlyConfig, db, logger, signerManager: manager }),
    ).rejects.toThrow("remains pending");

    expect(state.signedByPublicKeys).toEqual([oldSigner.publicKey()]);

    // Stage replacement signer while tx-hash-1 is still NOT_FOUND on chain.
    const rotatingConfig = loadConfig({
      env: completeEnv({
        KEEPER_STELLAR_SECRET: oldSigner.secret(),
        KEEPER_NEXT_STELLAR_SECRET: nextSigner.secret(),
      }),
    });

    const drainingSnap = await manager.refreshReadiness(rotatingConfig);
    expect(drainingSnap.phase).toBe("draining_pending");
    expect(drainingSnap.activeSigner).toBe(oldSigner.publicKey());
    expect(drainingSnap.stagedSigner).toBe(nextSigner.publicKey());
    expect(drainingSnap.pendingTxHashes).toEqual(["tx-hash-1"]);
    expect(drainingSnap.readyToSign).toBe(false);
    expect(manager.readinessReport().state).toBe("degraded");

    // Attempting maintenance while old submission is still unresolved must block without preparing/signing.
    const preparedBeforeBlocked = prepareSpy.mock.calls.length;
    await expect(
      processTtlBump({ config: rotatingConfig, db, logger, signerManager: manager }),
    ).rejects.toThrow("pending transaction reconciliation");
    expect(prepareSpy.mock.calls.length).toBe(preparedBeforeBlocked);

    // Once the old pending tx reaches finality on chain, rotation completes to nextSigner's sequence.
    state.txStatuses.set("tx-hash-1", rpc.Api.GetTransactionStatus.SUCCESS);
    const rotatedSnap = await manager.refreshReadiness(rotatingConfig);
    expect(rotatedSnap.phase).toBe("rotated");
    expect(rotatedSnap.activeSigner).toBe(nextSigner.publicKey());
    expect(rotatedSnap.stagedSigner).toBeNull();
    expect(rotatedSnap.pendingTxHashes).toEqual([]);
    expect(rotatedSnap.readyToSign).toBe(true);
    expect(manager.readinessReport().state).toBe("ready");

    const ttlRes = await processTtlBump({
      config: rotatingConfig,
      db,
      logger,
      signerManager: manager,
    });
    expect(ttlRes.dryRun).toBe(false);
    expect(ttlRes.signerPublicKey).toBe(nextSigner.publicKey());
    expect(state.signedByPublicKeys.at(-1)).toBe(nextSigner.publicKey());
    // Sequence ownership came from nextSigner's account (900 -> 901), not oldSigner's sequence!
    expect(state.preparedSequences.at(-1)).toBe("901");
  });

  it("blocks unfunded, missing, or wrong-network accounts from signing maintenance", async () => {
    const unfundedSigner = Keypair.random();
    const missingSigner = Keypair.random();
    const fundedSigner = Keypair.random();

    // 1. Missing account on chain
    const missingState: FakeRpcState = {
      passphrase: TESTNET_PASSPHRASE,
      accounts: new Map(),
      txStatuses: new Map(),
      preparedSenders: [],
      preparedSequences: [],
      signedByPublicKeys: [],
      sentHashes: [],
    };
    const missingRpc = buildFakeRpcClient(missingState);
    const missingConfig = loadConfig({
      env: completeEnv({ KEEPER_STELLAR_SECRET: missingSigner.secret() }),
    });
    const missingMgr = new KeeperSignerManager(missingConfig, {
      rpcClientFactory: () => missingRpc.client,
      pollAttempts: 1,
      pollIntervalMs: 0,
    });
    const { logger } = capturingLogger();
    await expect(
      processTtlBump({
        config: missingConfig,
        db: new ClaimDb([]),
        logger,
        signerManager: missingMgr,
      }),
    ).rejects.toThrow("does not exist on the configured Stellar network");
    expect(missingRpc.prepareSpy).not.toHaveBeenCalled();
    expect(missingRpc.sendSpy).not.toHaveBeenCalled();
    expect(missingMgr.readinessReport().state).toBe("degraded");

    // 2. Account exists on chain, but spendable balance above base reserve is below minBalanceStroops
    const lowBalanceState: FakeRpcState = {
      passphrase: TESTNET_PASSPHRASE,
      accounts: new Map([
        [
          unfundedSigner.publicKey(),
          // 12_000_000 total - 10_000_000 base reserve = 2_000_000 spendable < 50_000_000 required
          fundedSnapshot(unfundedSigner.publicKey(), { balanceStroops: 12_000_000n }),
        ],
      ]),
      txStatuses: new Map(),
      preparedSenders: [],
      preparedSequences: [],
      signedByPublicKeys: [],
      sentHashes: [],
    };
    const lowBalanceRpc = buildFakeRpcClient(lowBalanceState);
    const lowBalanceConfig = loadConfig({
      env: completeEnv({
        KEEPER_STELLAR_SECRET: unfundedSigner.secret(),
        KEEPER_MIN_BALANCE_STROOPS: "50000000",
      }),
    });
    const lowBalanceMgr = new KeeperSignerManager(lowBalanceConfig, {
      rpcClientFactory: () => lowBalanceRpc.client,
      pollAttempts: 1,
      pollIntervalMs: 0,
    });
    await expect(
      processTtlBump({
        config: lowBalanceConfig,
        db: new ClaimDb([]),
        logger,
        signerManager: lowBalanceMgr,
      }),
    ).rejects.toThrow("spendable balance 2000000 stroops is below required 50000000 stroops");
    expect(lowBalanceRpc.prepareSpy).not.toHaveBeenCalled();
    expect(lowBalanceRpc.sendSpy).not.toHaveBeenCalled();
    expect(lowBalanceMgr.readinessReport().state).toBe("degraded");

    // 3. Wrong-network RPC passphrase blocks funded signer before preparing/signing
    const wrongNetState: FakeRpcState = {
      passphrase: MAINNET_PASSPHRASE,
      accounts: new Map([[fundedSigner.publicKey(), fundedSnapshot(fundedSigner.publicKey())]]),
      txStatuses: new Map(),
      preparedSenders: [],
      preparedSequences: [],
      signedByPublicKeys: [],
      sentHashes: [],
    };
    const wrongNetRpc = buildFakeRpcClient(wrongNetState);
    const wrongNetConfig = loadConfig({
      env: completeEnv({ KEEPER_STELLAR_SECRET: fundedSigner.secret() }),
    });
    const wrongNetMgr = new KeeperSignerManager(wrongNetConfig, {
      rpcClientFactory: () => wrongNetRpc.client,
      pollAttempts: 1,
      pollIntervalMs: 0,
    });
    await expect(
      processTtlBump({
        config: wrongNetConfig,
        db: new ClaimDb([]),
        logger,
        signerManager: wrongNetMgr,
      }),
    ).rejects.toThrow("Keeper RPC network mismatch");
    expect(wrongNetRpc.prepareSpy).not.toHaveBeenCalled();
    expect(wrongNetRpc.sendSpy).not.toHaveBeenCalled();
    expect(wrongNetMgr.readinessReport().state).toBe("degraded");
  });

  it("refuses to rotate onto an unfunded replacement signer and degrades readiness until funded", async () => {
    const primarySigner = Keypair.random();
    const unfundedStagedSigner = Keypair.random();
    const state: FakeRpcState = {
      passphrase: TESTNET_PASSPHRASE,
      accounts: new Map([
        [primarySigner.publicKey(), fundedSnapshot(primarySigner.publicKey(), { sequence: "10" })],
      ]),
      txStatuses: new Map(),
      preparedSenders: [],
      preparedSequences: [],
      signedByPublicKeys: [],
      sentHashes: [],
    };
    const { client } = buildFakeRpcClient(state);

    const config = loadConfig({
      env: completeEnv({
        KEEPER_STELLAR_SECRET: primarySigner.secret(),
        KEEPER_NEXT_STELLAR_SECRET: unfundedStagedSigner.secret(),
      }),
    });
    const manager = new KeeperSignerManager(config, {
      rpcClientFactory: () => client,
      pollAttempts: 1,
      pollIntervalMs: 0,
    });

    const snap = await manager.refreshReadiness(config);
    expect(snap.phase).toBe("awaiting_next_readiness");
    expect(snap.activeSigner).toBe(primarySigner.publicKey());
    expect(snap.stagedSigner).toBe(unfundedStagedSigner.publicKey());
    expect(snap.stagedAccount?.ready).toBe(false);
    // Readiness reports degraded so operators notice the unfunded replacement before retiring primary.
    expect(manager.readinessReport().state).toBe("degraded");
  });

  it("preserves router claim payout recipients across signer rotation", async () => {
    const signerA = Keypair.random();
    const signerB = Keypair.random();
    const accountRecipient = encodeStellarAddress(
      AddressKind.Account,
      new Uint8Array(32).fill(0x11),
    );
    const muxedRecipient = encodeStellarAddress(
      AddressKind.MuxedAccount,
      new Uint8Array(32).fill(0x22),
      1000n,
    );

    const capturedInvocations: { caller: string; claimId: bigint; argCount: number }[] = [];
    const state: FakeRpcState = {
      passphrase: TESTNET_PASSPHRASE,
      accounts: new Map([
        [signerA.publicKey(), fundedSnapshot(signerA.publicKey(), { sequence: "50" })],
        [signerB.publicKey(), fundedSnapshot(signerB.publicKey(), { sequence: "70" })],
      ]),
      txStatuses: new Map(),
      preparedSenders: [],
      preparedSequences: [],
      signedByPublicKeys: [],
      sentHashes: [],
    };
    const { client } = buildFakeRpcClient(state);
    const origPrepare = client.prepareTransaction.bind(client);
    const inspectingClient: KeeperStellarRpcClient = {
      ...client,
      prepareTransaction: async (tx) => {
        const op = tx.operations[0];
        if (
          op?.type === "invokeHostFunction" &&
          op.func.type === "hostFunctionTypeInvokeContract"
        ) {
          const invokeArgs = op.func.invokeContract.args;
          const arg0 = invokeArgs[0];
          const arg1 = invokeArgs[1];
          if (arg0 !== undefined && arg1 !== undefined) {
            capturedInvocations.push({
              caller: String(scValToNative(arg0)),
              claimId: BigInt(scValToNative(arg1) as bigint | number | string),
              argCount: invokeArgs.length,
            });
          }
        }
        return origPrepare(tx);
      },
    };

    const { logger } = capturingLogger();

    // Settle claim #1 under signerA
    const dbPhase1 = new ClaimDb([
      { claim_id: "1", recipient: accountRecipient, amount: "1000000000000000000" },
    ]);
    const configA = loadConfig({
      env: completeEnv({ KEEPER_STELLAR_SECRET: signerA.secret() }),
    });
    const manager = new KeeperSignerManager(configA, {
      rpcClientFactory: () => inspectingClient,
      pollAttempts: 1,
      pollIntervalMs: 0,
    });

    const resA = await processClaimSettlement({
      config: configA,
      db: dbPhase1,
      logger,
      signerManager: manager,
    });
    expect(resA.settled).toBe(1);
    expect(resA.settledClaims).toEqual([
      {
        claimId: "1",
        recipient: accountRecipient,
        settledBy: signerA.publicKey(),
        txHash: "tx-hash-1",
      },
    ]);

    // Rotate to signerB and settle claim #2 (muxed recipient)
    const dbPhase2 = new ClaimDb([
      { claim_id: "2", recipient: muxedRecipient, amount: "999999999999999999999" },
    ]);
    const configB = loadConfig({
      env: completeEnv({
        KEEPER_STELLAR_SECRET: signerA.secret(),
        KEEPER_NEXT_STELLAR_SECRET: signerB.secret(),
      }),
    });

    const resB = await processClaimSettlement({
      config: configB,
      db: dbPhase2,
      logger,
      signerManager: manager,
    });
    expect(resB.settled).toBe(1);
    expect(resB.settledClaims).toEqual([
      {
        claimId: "2",
        recipient: muxedRecipient,
        settledBy: signerB.publicKey(),
        txHash: "tx-hash-2",
      },
    ]);

    // Verify router settle_claim receives strictly (caller, claim_id) and never alters claim recipients.
    expect(capturedInvocations).toEqual([
      { caller: signerA.publicKey(), claimId: 1n, argCount: 2 },
      { caller: signerB.publicKey(), claimId: 2n, argCount: 2 },
    ]);
    expect(dbPhase1.rows[0]?.recipient).toBe(accountRecipient);
    expect(dbPhase2.rows[0]?.recipient).toBe(muxedRecipient);
    expect(
      [...dbPhase1.queries, ...dbPhase2.queries].some((q) => /UPDATE|INSERT|DELETE/i.test(q.sql)),
    ).toBe(false);
  });

  it("never exposes secret seeds or Redis credentials in readiness diagnostics, errors, or logs", async () => {
    const primary = Keypair.random();
    const staged = Keypair.random();
    const primarySecret = primary.secret();
    const stagedSecret = staged.secret();

    const state: FakeRpcState = {
      passphrase: TESTNET_PASSPHRASE,
      accounts: new Map([
        [primary.publicKey(), fundedSnapshot(primary.publicKey())],
        [staged.publicKey(), fundedSnapshot(staged.publicKey())],
      ]),
      txStatuses: new Map(),
      preparedSenders: [],
      preparedSequences: [],
      signedByPublicKeys: [],
      sentHashes: [],
    };
    const { client } = buildFakeRpcClient(state);

    const config = loadConfig({
      env: completeEnv({
        KEEPER_STELLAR_SECRET: primarySecret,
        KEEPER_NEXT_STELLAR_SECRET: stagedSecret,
        REDIS_URL: "redis://default:super-secret-redis-pass@127.0.0.1:6380",
      }),
    });

    const { logger, lines } = capturingLogger();
    const worker = new KeeperWorker(config, new ClaimDb([]), logger, {
      rpcClientFactory: () => client,
      pollAttempts: 1,
      pollIntervalMs: 0,
    });

    const diag = await worker.refreshSignerReadiness();
    const readiness = worker.readiness();
    const serialized = JSON.stringify({ diag, readiness, lines });

    expect(serialized).not.toContain(primarySecret);
    expect(serialized).not.toContain(stagedSecret);
    expect(serialized).not.toContain("super-secret-redis-pass");
    expect(diag.activeSigner).toBe(staged.publicKey());

    const scrubbed = sanitizeKeeperDiagnostic(
      `failed for ${primarySecret} on redis://user:my-secret-pw@redis.internal:6379`,
    );
    expect(scrubbed).not.toContain(primarySecret);
    expect(scrubbed).not.toContain("my-secret-pw");
    expect(scrubbed).toContain("[REDACTED_STELLAR_SECRET]");
  });
});
