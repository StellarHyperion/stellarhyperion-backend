import { AddressKind, encodeStellarAddress } from "@hyperion/protocol";
import {
  Keypair,
  SorobanDataBuilder,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../../src/config/config.js";
import { processClaimSettlement } from "../../src/keeper/jobs/claims.js";
import { processTtlBump } from "../../src/keeper/jobs/ttl.js";
import type * as KeeperStellarModule from "../../src/keeper/stellar.js";
import {
  PUBLIC_UNSIGNED_SIMULATION_ADDRESS,
  submitStellar,
  type KeeperSimulationClient,
} from "../../src/keeper/stellar.js";
import { KeeperWorker } from "../../src/keeper/worker.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

vi.mock("../../src/keeper/stellar.js", async (importOriginal) => {
  const actual = await importOriginal<typeof KeeperStellarModule>();
  return {
    ...actual,
    submitStellar: vi.fn(),
  };
});

class PreviewDb {
  readonly claimRows: Record<string, unknown>[];
  readonly transferRows: Record<string, unknown>[];
  readonly queries: string[] = [];

  constructor(
    claimRows: Record<string, unknown>[],
    transferRows: Record<string, unknown>[] = [{ nonce: "42" }],
  ) {
    this.claimRows = claimRows;
    this.transferRows = transferRows;
  }

  query(sql: string) {
    this.queries.push(sql);
    if (sql.includes("pending_claim")) {
      return Promise.resolve({ rows: this.claimRows, rowCount: this.claimRows.length });
    }
    return Promise.resolve({ rows: this.transferRows, rowCount: this.transferRows.length });
  }

  transaction<T>(work: (db: PreviewDb) => Promise<T>): Promise<T> {
    return work(this);
  }
}

beforeEach(() => {
  vi.mocked(submitStellar).mockReset();
});

describe("keeper dry-run plans with exact public operation previews", () => {
  it("never broadcasts, reports zero confirmed changes, and returns simulated fees and target keys", async () => {
    const signer = Keypair.random();
    // Even with KEEPER_STELLAR_SECRET configured, payload.dryRun === true must never broadcast or sign!
    const config = loadConfig({
      env: completeEnv({ KEEPER_STELLAR_SECRET: signer.secret() }),
    });
    const routerId = config.indexer.stellar?.routerContractId ?? "";
    const simulatedTxs: Transaction[] = [];

    const simulationClient: KeeperSimulationClient = {
      simulateTransaction: (tx: Transaction) => {
        simulatedTxs.push(tx);
        return Promise.resolve({
          id: "sim-1",
          latestLedger: 1_500_123,
          events: [],
          _parsed: true,
          transactionData: new SorobanDataBuilder(),
          minResourceFee: "48500",
        });
      },
    };

    const accountRecipient = encodeStellarAddress(
      AddressKind.Account,
      new Uint8Array(32).fill(0x33),
    );
    const db = new PreviewDb(
      [{ claim_id: "7", recipient: accountRecipient, amount: "250000000", route: 0 }],
      [{ nonce: "19" }, { nonce: "20" }],
    );
    const { logger } = capturingLogger();

    const ttlRes = await processTtlBump({ config, db, logger, simulationClient }, { dryRun: true });

    expect(ttlRes.dryRun).toBe(true);
    expect(ttlRes.bumpedTokens).toBe(0);
    expect(ttlRes.bumpedClaims).toBe(0);
    expect(ttlRes.bumpedTransfers).toBe(0);
    expect(submitStellar).not.toHaveBeenCalled();

    expect(ttlRes.plan).toBeDefined();
    expect(ttlRes.plan?.mode).toBe("dry-run");
    expect(ttlRes.plan?.unsigned).toBe(true);
    expect(ttlRes.plan?.signed).toBe(false);
    expect(ttlRes.plan?.broadcast).toBe(false);
    // 100 base fee + 48500 resource fee = 48600 stroops
    expect(ttlRes.plan?.totalEstimatedFeeStroops).toBe("48600");

    const op = ttlRes.plan?.operations[0];
    expect(op?.contract).toBe(routerId);
    expect(op?.method).toBe("keep_alive");
    expect(op?.unsigned).toBe(true);
    expect(op?.signed).toBe(false);
    expect(op?.broadcast).toBe(false);
    expect(op?.targetKeys).toContain(`router:${routerId}`);
    expect(op?.targetKeys).toContain("claim:7");
    expect(op?.targetKeys).toContain("transfer:19");
    expect(op?.targetKeys).toContain("transfer:20");

    // Verify the simulated Stellar transaction itself had zero signatures and used the neutral unsigned caller
    expect(simulatedTxs).toHaveLength(1);
    expect(simulatedTxs[0]?.signatures).toHaveLength(0);
    expect(simulatedTxs[0]?.source).toBe(PUBLIC_UNSIGNED_SIMULATION_ADDRESS);

    // Decode operationXdr to prove it is a valid unsigned Soroban contract invocation
    const decodedOp = xdr.Operation.fromXdr(op?.operationXdr ?? "", "base64");
    expect(decodedOp.body.type).toBe("invokeHostFunction");
  });

  it("preserves exact on-chain claim recipient and full-width integer-string amount in dry-run claim plans", async () => {
    const accountRecipient = encodeStellarAddress(
      AddressKind.Account,
      new Uint8Array(32).fill(0x44),
    );
    const muxedRecipient = encodeStellarAddress(
      AddressKind.MuxedAccount,
      new Uint8Array(32).fill(0x55),
      9_876_543_210n,
    );
    const usdcToken = encodeStellarAddress(AddressKind.Contract, new Uint8Array(32).fill(0x66));
    // Full-width uint256 integer-string amount beyond JS safe float precision
    const hugeIntegerAmount = "115792089237316195423570985008687907853269984665640564039457";

    const simulationClient: KeeperSimulationClient = {
      simulateTransaction: () =>
        Promise.resolve({
          id: "sim-claim",
          latestLedger: 1_500_200,
          events: [],
          _parsed: true,
          transactionData: new SorobanDataBuilder(),
          minResourceFee: "31200",
        }),
      readOnChainClaim: (_router, claimId) => {
        if (claimId === 101n) {
          return Promise.resolve({
            claimId: "101",
            recipient: muxedRecipient,
            token: usdcToken,
            amount: hugeIntegerAmount,
            route: 0,
          });
        }
        return Promise.resolve(null);
      },
    };

    const config = loadConfig({ env: completeEnv() });
    const db = new PreviewDb([
      {
        claim_id: "100",
        recipient: accountRecipient,
        token: usdcToken,
        amount: "5000000000000000000",
        route: 1,
      },
      {
        claim_id: "101",
        recipient: muxedRecipient,
        token: usdcToken,
        amount: hugeIntegerAmount,
        route: 0,
      },
    ]);
    const { logger } = capturingLogger();

    const claimRes = await processClaimSettlement(
      { config, db, logger, simulationClient },
      { limit: 10 },
    );

    expect(claimRes.dryRun).toBe(true);
    expect(claimRes.settled).toBe(0);
    expect(claimRes.attempted).toBe(0);
    expect(claimRes.pending).toBe(2);
    expect(submitStellar).not.toHaveBeenCalled();

    // 2 operations * (100 + 31200) = 62600 stroops
    expect(claimRes.plan?.totalEstimatedFeeStroops).toBe("62600");
    expect(claimRes.plan?.operations).toHaveLength(2);

    const preview0 = claimRes.plan?.operations[0];
    const preview1 = claimRes.plan?.operations[1];

    expect(preview0?.claimPreview).toEqual({
      claimId: "100",
      recipient: accountRecipient,
      token: usdcToken,
      amount: "5000000000000000000",
      route: 1,
    });
    expect(preview1?.claimPreview).toEqual({
      claimId: "101",
      recipient: muxedRecipient,
      token: usdcToken,
      amount: hugeIntegerAmount,
      route: 0,
    });

    // Verify operationXdr encodes neutral caller + exact claim_id
    const op1Xdr = xdr.Operation.fromXdr(preview1?.operationXdr ?? "", "base64");
    expect(op1Xdr.body.type).toBe("invokeHostFunction");
    if (
      op1Xdr.body.type === "invokeHostFunction" &&
      op1Xdr.body.value.hostFunction.type === "hostFunctionTypeInvokeContract"
    ) {
      const invokeArgs = op1Xdr.body.value.hostFunction.invokeContract.args;
      const arg0 = invokeArgs[0];
      const arg1 = invokeArgs[1];
      expect(arg0).toBeDefined();
      expect(arg1).toBeDefined();
      if (arg0 !== undefined && arg1 !== undefined) {
        expect(String(scValToNative(arg0))).toBe(PUBLIC_UNSIGNED_SIMULATION_ADDRESS);
        expect(BigInt(scValToNative(arg1) as bigint | number | string)).toBe(101n);
      }
    }
    expect(db.queries.some((sql) => /INSERT|UPDATE|DELETE/i.test(sql))).toBe(false);
  });

  it("strips signer material, configured keypairs, and secret configuration from all dry-run outputs", async () => {
    const secretKeypair = Keypair.random();
    const secretSeed = secretKeypair.secret();
    const configuredSignerPublic = secretKeypair.publicKey();

    const config = loadConfig({
      env: completeEnv({
        KEEPER_STELLAR_SECRET: secretSeed,
        DATABASE_URL: "postgres://hyperion:db-secret-token@127.0.0.1:5433/hyperion",
        REDIS_URL: "redis://default:redis-secret-token@127.0.0.1:6380",
      }),
    });

    const simulationClient: KeeperSimulationClient = {
      simulateTransaction: () =>
        Promise.resolve({
          id: "sim-err",
          latestLedger: 1_500_300,
          events: [],
          _parsed: true,
          error: `simulation diagnostic mentioning ${secretSeed} and redis://u:redis-secret-token@host:6379`,
        }),
    };

    const { logger, lines } = capturingLogger();
    const worker = new KeeperWorker(
      config,
      new PreviewDb([
        {
          claim_id: "5",
          recipient: encodeStellarAddress(AddressKind.Account, new Uint8Array(32).fill(0x77)),
          amount: "1000",
        },
      ]),
      logger,
      simulationClient,
    );

    const ttlPreview = await worker.previewJob("ttl-bump");
    const claimPreview = await worker.previewJob("claim-settlement");

    const serialized = JSON.stringify({ ttlPreview, claimPreview, lines });
    expect(serialized).not.toContain(secretSeed);
    expect(serialized).not.toContain(configuredSignerPublic);
    expect(serialized).not.toContain("db-secret-token");
    expect(serialized).not.toContain("redis-secret-token");
  });
});
