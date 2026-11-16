import { AddressKind, encodeStellarAddress } from "@hyperion/protocol";
import { Keypair, SorobanDataBuilder, StrKey, rpc, xdr } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/config.js";
import { createRpcClaimStateInspector, planClaimBatches } from "../../src/keeper/claim-batching.js";
import { processClaimSettlement } from "../../src/keeper/jobs/claims.js";
import { submitStellar } from "../../src/keeper/stellar.js";
import type {
  CandidateClaimRecord,
  ClaimStateInspector,
  OnChainClaimDisposition,
} from "../../src/keeper/types.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

vi.mock("../../src/keeper/stellar.js", () => ({ submitStellar: vi.fn() }));

interface SeedClaimRow {
  readonly claim_id: string;
  readonly recipient: string;
  readonly token: string;
  readonly amount: string;
}

class ClaimDb {
  calls: { sql: string; params: readonly unknown[] }[] = [];
  constructor(private readonly rows: readonly SeedClaimRow[]) {}

  query(sql: string, params: readonly unknown[] = []) {
    this.calls.push({ sql, params });
    return Promise.resolve({
      rows: this.rows as unknown as readonly Record<string, unknown>[],
      rowCount: this.rows.length,
    });
  }

  transaction<T>(work: (db: ClaimDb) => Promise<T>) {
    return work(this);
  }
}

const USDC_SAC = "CD5IB466XCQIUDYWV22PUMJTF6EE3KPXBDGLLBSKAPNE6QPXVUZLXJGA";

describe("Keeper claim settlement batching and confirmed per-item accounting", () => {
  beforeEach(() => {
    vi.mocked(submitStellar).mockReset();
    vi.restoreAllMocks();
  });

  it("reports already-settled and missing on-chain claims individually without fabricating keeper settlements", async () => {
    const signer = Keypair.random();
    const config = loadConfig({
      env: completeEnv({ KEEPER_STELLAR_SECRET: signer.secret() }),
    });
    const r1 = encodeStellarAddress(AddressKind.Account, new Uint8Array(32).fill(0x11));
    const r2 = encodeStellarAddress(AddressKind.Account, new Uint8Array(32).fill(0x12));
    const r3 = encodeStellarAddress(AddressKind.Account, new Uint8Array(32).fill(0x13));

    const db = new ClaimDb([
      { claim_id: "10", recipient: r1, token: USDC_SAC, amount: "10000000" },
      { claim_id: "11", recipient: r2, token: USDC_SAC, amount: "20000000" },
      { claim_id: "12", recipient: r3, token: USDC_SAC, amount: "30000000" },
    ]);

    const inspector: ClaimStateInspector = {
      inspectClaim(candidate): Promise<OnChainClaimDisposition> {
        if (candidate.claimId === 10n) {
          return Promise.resolve({
            status: "already_settled_on_chain",
            detail: "Claim 10 was already settled by recipient.",
          });
        }
        if (candidate.claimId === 11n) {
          return Promise.resolve({
            status: "missing_on_chain",
            detail: "Claim 11 does not exist in router storage.",
          });
        }
        return Promise.resolve({
          status: "claimable",
          recipient: candidate.recipient,
          amount: candidate.amount,
          resources: {
            cpuInstructions: 2_000_000,
            readBytes: 4_096,
            writeBytes: 2_048,
            minResourceFeeStroops: "42000",
          },
        });
      },
    };

    vi.mocked(submitStellar).mockResolvedValueOnce("tx-claim-12");
    const { logger } = capturingLogger();
    const result = await processClaimSettlement({
      config,
      db,
      logger,
      claimInspector: inspector,
    });

    // Only claim 12 was submitted and confirmed by the keeper.
    expect(vi.mocked(submitStellar)).toHaveBeenCalledTimes(1);
    expect(result.settled).toBe(1);
    expect(result.attempted).toBe(1);
    expect(result.pending).toBe(2);
    expect(result.items).toEqual([
      expect.objectContaining({
        claimId: "10",
        outcome: "already_settled_on_chain",
        confirmed: false,
        txHash: null,
      }),
      expect.objectContaining({
        claimId: "11",
        outcome: "missing_on_chain",
        confirmed: false,
        txHash: null,
      }),
      expect.objectContaining({
        claimId: "12",
        outcome: "confirmed_settled",
        confirmed: true,
        txHash: "tx-claim-12",
      }),
    ]);
  });

  it("preserves parked liabilities and muxed payout intent when recipients are frozen on chain", async () => {
    const signer = Keypair.random();
    const config = loadConfig({
      env: completeEnv({ KEEPER_STELLAR_SECRET: signer.secret() }),
    });
    const chain = config.indexer.stellar;
    if (!chain) throw new Error("Expected Stellar config");

    const frozenMuxed = encodeStellarAddress(
      AddressKind.MuxedAccount,
      new Uint8Array(32).fill(0x55),
      424242n,
    );
    const readyAccount = encodeStellarAddress(AddressKind.Account, new Uint8Array(32).fill(0x66));
    const exactFrozenAmount = "123456789012345678901234567890";

    const db = new ClaimDb([
      { claim_id: "21", recipient: frozenMuxed, token: USDC_SAC, amount: exactFrozenAmount },
      { claim_id: "22", recipient: readyAccount, token: USDC_SAC, amount: "5000000" },
    ]);

    vi.spyOn(rpc.Server.prototype, "getNetwork").mockResolvedValue({
      passphrase: chain.networkPassphrase,
      protocolVersion: "22",
    });
    vi.spyOn(rpc.Server.prototype, "getAssetBalance").mockImplementation((address) => {
      const addrText = typeof address === "string" ? address : address.toString();
      const frozenBase = encodeStellarAddress(AddressKind.Account, new Uint8Array(32).fill(0x55));
      if (addrText === frozenBase) {
        return Promise.resolve({
          latestLedger: 5_000_000,
          balanceEntry: {
            amount: "1000",
            authorized: false,
            clawback: false,
            authorizedToMaintainLiabilities: true,
          },
        });
      }
      return Promise.resolve({
        latestLedger: 5_000_000,
        balanceEntry: {
          amount: "0",
          authorized: true,
          clawback: false,
          authorizedToMaintainLiabilities: true,
        },
      });
    });
    vi.spyOn(rpc.Server.prototype, "getAccount").mockRejectedValue(new Error("offline account"));
    const ledgerKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: xdr.ScAddress.scAddressTypeContract(
          new xdr.ContractId(StrKey.decodeContract(chain.routerContractId)),
        ),
        key: xdr.ScVal.scvU64(22n),
        durability: xdr.ContractDataDurability.persistent,
      }),
    );
    vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockResolvedValue({
      id: "sim-22",
      latestLedger: 5_000_000,
      events: [],
      _parsed: true,
      minResourceFee: "30000",
      transactionData: new SorobanDataBuilder()
        .setFootprint([], [ledgerKey])
        .setResources(1_500_000, 4_096, 2_048)
        .setResourceFee("30000"),
      result: { auth: [], retval: xdr.ScVal.scvVoid() },
    });
    vi.spyOn(rpc.Server.prototype, "getContractMethods").mockResolvedValue([]);

    const rpcInspector = createRpcClaimStateInspector(config);
    vi.mocked(submitStellar).mockResolvedValueOnce("tx-claim-22");

    const { logger } = capturingLogger();
    const result = await processClaimSettlement({
      config,
      db,
      logger,
      claimInspector: rpcInspector,
    });

    expect(vi.mocked(submitStellar)).toHaveBeenCalledTimes(1);
    expect(result.settled).toBe(1);
    expect(result.pending).toBe(1);
    expect(db.calls.some((call) => /INSERT|UPDATE|DELETE/.test(call.sql))).toBe(false);

    const frozenItem = result.items?.find((item) => item.claimId === "21");
    expect(frozenItem).toEqual(
      expect.objectContaining({
        claimId: "21",
        outcome: "frozen_recipient",
        confirmed: false,
        txHash: null,
        recipient: frozenMuxed,
        amount: exactFrozenAmount,
      }),
    );
  });

  it("partitions claims into resource-bounded batches and verifies per-item settlement in vector mode", async () => {
    const signer = Keypair.random();
    const config = loadConfig({
      env: completeEnv({ KEEPER_STELLAR_SECRET: signer.secret() }),
    });
    const recipient = encodeStellarAddress(AddressKind.Account, new Uint8Array(32).fill(0x77));

    const candidates: CandidateClaimRecord[] = [31n, 32n, 33n, 34n, 35n, 36n].map((claimId) => ({
      claimId,
      recipient,
      token: USDC_SAC,
      amount: "1000000",
    }));

    // Unit check: 35M CPU per claim under 75M maxBatchCpuInstructions packs at most 2 claims per batch!
    const plan = planClaimBatches(
      candidates.map((candidate) => ({
        candidate,
        resources: {
          cpuInstructions: candidate.claimId === 36n ? 90_000_000 : 35_000_000,
          readBytes: 8_000,
          writeBytes: 4_000,
          minResourceFeeStroops: "100000",
        },
      })),
      {
        maxBatchItems: 10,
        maxBatchCpuInstructions: 75_000_000,
        maxBatchReadBytes: 100_000,
        maxBatchWriteBytes: 100_000,
        maxBatchFeeStroops: 1_000_000n,
        maxBatchesPerRun: 2,
      },
    );

    expect(plan.summaries.map((batch) => batch.claimIds)).toEqual([
      ["31", "32"],
      ["33", "34"],
    ]);
    // Claim 35 deferred by maxBatchesPerRun=2; Claim 36 rejected because 90M CPU > 75M ceiling.
    expect(plan.rejectedItems).toEqual([
      expect.objectContaining({ claimId: "35", outcome: "deferred_by_batch_limit" }),
      expect.objectContaining({ claimId: "36", outcome: "exceeds_resource_limit" }),
    ]);

    // End-to-end vector batch mode with post-batch per-item confirmation check:
    const db = new ClaimDb(
      [31n, 32n, 33n].map((id) => ({
        claim_id: String(id),
        recipient,
        token: USDC_SAC,
        amount: "1000000",
      })),
    );
    const vectorInspector: ClaimStateInspector = {
      inspectClaim(candidate) {
        return Promise.resolve({
          status: "claimable",
          recipient: candidate.recipient,
          amount: candidate.amount,
          resources: {
            cpuInstructions: 35_000_000,
            readBytes: 8_000,
            writeBytes: 4_000,
            minResourceFeeStroops: "100000",
          },
        });
      },
      supportsVectorSettlement() {
        return Promise.resolve(true);
      },
      verifyPostBatchClaimSettled(claimId) {
        // Suppose claim 32 did not actually settle on-chain during vector execution!
        return Promise.resolve(claimId !== 32n);
      },
    };

    vi.mocked(submitStellar)
      .mockResolvedValueOnce("vector-batch-0-tx")
      .mockResolvedValueOnce("single-batch-1-tx");

    const { logger } = capturingLogger();
    const result = await processClaimSettlement(
      {
        config,
        db,
        logger,
        claimInspector: vectorInspector,
      },
      {
        batchLimits: {
          maxBatchCpuInstructions: 75_000_000,
          maxBatchesPerRun: 2,
        },
      },
    );

    expect(result.batches?.map((b) => b.claimIds)).toEqual([["31", "32"], ["33"]]);
    // Claim 31 (vector confirmed) + Claim 33 (single confirmed) = 2 settled; Claim 32 unconfirmed!
    expect(result.settled).toBe(2);
    expect(result.attempted).toBe(3);
    expect(result.pending).toBe(1);
    expect(result.items?.find((i) => i.claimId === "32")?.confirmed).toBe(false);
  });
});
