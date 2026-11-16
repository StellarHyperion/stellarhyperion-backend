import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AddressKind, encodeStellarAddress } from "@hyperion/protocol";
import { Keypair, scValToNative, type rpc } from "@stellar/stellar-sdk";
import { loadConfig } from "../../src/config/config.js";
import {
  discoverAdapterTargets,
  matchAdapterMaintenanceMethod,
  validateMeasuredResources,
} from "../../src/keeper/adapters.js";
import { processClaimSettlement } from "../../src/keeper/jobs/claims.js";
import { processTtlBump } from "../../src/keeper/jobs/ttl.js";
import { submitStellar } from "../../src/keeper/stellar.js";
import type { MaintenanceInspector, MeasuredSorobanResources } from "../../src/keeper/types.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

vi.mock("../../src/keeper/stellar.js", () => ({ submitStellar: vi.fn() }));

const LIVE_DEPLOYMENTS_PATH = fileURLToPath(
  new URL("../../deployments/testnet.json", import.meta.url),
);

class FakeDb {
  query(sql: string) {
    return Promise.resolve({
      rows: sql.includes("pending_claim")
        ? [{ claim_id: "11" }, { claim_id: "12" }]
        : [{ nonce: "77" }],
      rowCount: 2,
    });
  }
  transaction<T>(work: (db: FakeDb) => Promise<T>) {
    return work(this);
  }
}

function measured(overrides: Partial<MeasuredSorobanResources> = {}): MeasuredSorobanResources {
  const readOnlyKeys = overrides.readOnlyKeys ?? 3;
  const readWriteKeys = overrides.readWriteKeys ?? 2;
  return {
    cpuInstructions: overrides.cpuInstructions ?? 1_500_000,
    readBytes: overrides.readBytes ?? 8_192,
    writeBytes: overrides.writeBytes ?? 2_048,
    minResourceFeeStroops: overrides.minResourceFeeStroops ?? "45000",
    readOnlyKeys,
    readWriteKeys,
    footprintKeys: overrides.footprintKeys ?? readOnlyKeys + readWriteKeys,
  };
}

const ROUTER_METHODS: readonly rpc.Api.ContractMethod[] = [
  {
    name: "keep_alive",
    inputs: [
      { name: "tokens", type: "Vec" },
      { name: "routes", type: "Vec" },
      { name: "claims", type: "Vec" },
      { name: "transfers", type: "Vec" },
    ],
    outputs: [],
  },
  {
    name: "settle_claim",
    inputs: [
      { name: "caller", type: "Address" },
      { name: "claim_id", type: "U64" },
    ],
    outputs: [],
  },
];

describe("Keeper adapter TTL coverage planning", () => {
  beforeEach(() => {
    vi.mocked(submitStellar).mockReset();
  });

  it("discovers configured Stellar adapters, token SACs and peer chains from deployments", () => {
    const config = loadConfig({
      env: completeEnv({ HYPERION_DEPLOYMENTS_FILE: LIVE_DEPLOYMENTS_PATH }),
    });
    const targets = discoverAdapterTargets(config);
    expect(targets.map((target) => target.route)).toEqual(["cctp", "axelar-its"]);

    const cctpTarget = targets.find((target) => target.route === "cctp");
    const axelarTarget = targets.find((target) => target.route === "axelar-its");
    expect(cctpTarget?.tokens).toEqual([
      "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    ]);
    expect(cctpTarget?.peers.map((peer) => peer.chain)).toEqual([
      "sepolia",
      "base-sepolia",
      "arc-testnet",
    ]);
    expect(axelarTarget?.peers.some((peer) => peer.axelarName !== null)).toBe(true);
  });

  it("reports unsupported adapters as uncovered rather than maintained while recording router and adapter coverage separately", async () => {
    const secret = Keypair.random().secret();
    const config = loadConfig({
      env: completeEnv({
        HYPERION_DEPLOYMENTS_FILE: LIVE_DEPLOYMENTS_PATH,
        KEEPER_STELLAR_SECRET: secret,
      }),
    });
    const targets = discoverAdapterTargets(config);
    const cctpAdapter = targets.find((target) => target.route === "cctp");
    const axelarAdapter = targets.find((target) => target.route === "axelar-its");
    expect(cctpAdapter).toBeDefined();
    expect(axelarAdapter).toBeDefined();

    const inspector: MaintenanceInspector = {
      getContractMethods(contractId) {
        if (contractId === config.indexer.stellar?.routerContractId) {
          return Promise.resolve(ROUTER_METHODS);
        }
        if (contractId === cctpAdapter?.contractId) {
          return Promise.resolve([
            {
              name: "keep_alive",
              inputs: [
                { name: "tokens", type: "Vec" },
                { name: "domains", type: "Vec" },
              ],
              outputs: [],
            },
          ]);
        }
        // Axelar adapter has no maintenance method deployed yet.
        return Promise.resolve([
          {
            name: "send_token",
            inputs: [{ name: "amount", type: "I128" }],
            outputs: [],
          },
        ]);
      },
      measureCall(contractId) {
        if (contractId === config.indexer.stellar?.routerContractId) {
          return Promise.resolve(measured({ readOnlyKeys: 4, readWriteKeys: 5 }));
        }
        return Promise.resolve(measured({ readOnlyKeys: 2, readWriteKeys: 3 }));
      },
    };

    vi.mocked(submitStellar)
      .mockResolvedValueOnce("router-tx-hash")
      .mockResolvedValueOnce("cctp-adapter-tx-hash");

    const { logger } = capturingLogger();
    const result = await processTtlBump({
      config,
      db: new FakeDb(),
      logger,
      maintenanceInspector: inspector,
    });

    expect(result.dryRun).toBe(false);
    // Router counts remain strictly router items and do not absorb adapter keys.
    expect(result.bumpedTokens).toBe(1);
    expect(result.bumpedClaims).toBe(2);
    expect(result.bumpedTransfers).toBe(1);
    expect(result.routerCoverage).toMatchObject({
      contractId: config.indexer.stellar?.routerContractId,
      bumpedTokens: 1,
      bumpedClaims: 2,
      bumpedTransfers: 1,
      footprintKeys: 9,
      txHash: "router-tx-hash",
    });

    // Adapter coverage is tracked separately: 1 maintained (CCTP), 1 uncovered (Axelar ITS).
    expect(result.adapterCoverage.configuredCount).toBe(2);
    expect(result.adapterCoverage.maintainedCount).toBe(1);
    expect(result.adapterCoverage.uncoveredCount).toBe(1);
    expect(result.adapterCoverage.maintainedAdapters).toEqual([
      expect.objectContaining({
        route: "cctp",
        contractId: cctpAdapter?.contractId,
        method: "keep_alive",
        tokens: ["CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"],
        peers: ["sepolia", "base-sepolia", "arc-testnet"],
        footprintKeys: 5,
        readOnlyKeys: 2,
        readWriteKeys: 3,
        txHash: "cctp-adapter-tx-hash",
      }),
    ]);
    expect(result.adapterCoverage.uncoveredAdapters).toEqual([
      expect.objectContaining({
        route: "axelar-its",
        contractId: axelarAdapter?.contractId,
        reason: "unsupported_maintenance_entrypoint",
      }),
    ]);

    // Verify encoded CCTP adapter args carry the exact token SAC and Circle domain numbers.
    const adapterCallArgsFn = vi.mocked(submitStellar).mock.calls[1]?.[3];
    const encodedArgs = adapterCallArgsFn ? adapterCallArgsFn("ignored") : [];
    expect(encodedArgs).toHaveLength(2);
    const [firstArg, secondArg] = encodedArgs;
    if (!firstArg || !secondArg) {
      throw new Error("Expected two encoded ScVal arguments for CCTP adapter keep_alive.");
    }
    const decodedTokens = scValToNative(firstArg) as string[];
    const decodedDomains = scValToNative(secondArg) as number[];
    expect(decodedTokens).toEqual(["CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"]);
    expect(decodedDomains).toEqual([0, 6, 26]);
  });

  it("rejects adapter upkeep when measured resources exceed bounds or footprint is unmeasured", async () => {
    const secret = Keypair.random().secret();
    const config = loadConfig({
      env: completeEnv({
        HYPERION_DEPLOYMENTS_FILE: LIVE_DEPLOYMENTS_PATH,
        KEEPER_STELLAR_SECRET: secret,
      }),
    });
    const targets = discoverAdapterTargets(config);
    const cctpAdapter = targets.find((target) => target.route === "cctp");

    const inspector: MaintenanceInspector = {
      getContractMethods(contractId) {
        if (contractId === config.indexer.stellar?.routerContractId) {
          return Promise.resolve(ROUTER_METHODS);
        }
        return Promise.resolve([
          {
            name: "extend_ttl",
            inputs: [
              { name: "caller", type: "Address" },
              { name: "tokens", type: "Vec" },
              { name: "peer_chains", type: "Vec" },
            ],
            outputs: [],
          },
        ]);
      },
      measureCall(contractId) {
        if (contractId === config.indexer.stellar?.routerContractId) {
          return Promise.resolve(measured({ cpuInstructions: 2_000_000 }));
        }
        if (contractId === cctpAdapter?.contractId) {
          // Exceeds configured maxResourceFeeStroops.
          return Promise.resolve(measured({ minResourceFeeStroops: "99000000" }));
        }
        // Empty footprint must be rejected as unmeasured.
        return Promise.resolve(measured({ readOnlyKeys: 0, readWriteKeys: 0, footprintKeys: 0 }));
      },
    };

    vi.mocked(submitStellar).mockResolvedValue("router-only-hash");
    const { logger } = capturingLogger();
    const result = await processTtlBump(
      { config, db: new FakeDb(), logger, maintenanceInspector: inspector },
      { resourceBounds: { maxResourceFeeStroops: 1_000_000n } },
    );

    expect(vi.mocked(submitStellar)).toHaveBeenCalledTimes(1);
    expect(result.adapterCoverage.maintainedCount).toBe(0);
    expect(result.adapterCoverage.uncoveredCount).toBe(2);
    expect(result.adapterCoverage.uncoveredAdapters.map((item) => item.reason)).toEqual([
      "resource_bounds_exceeded",
      "unmeasured_resources",
    ]);
  });

  it("blocks router and claim jobs when contracts lack callable methods or exceed resource bounds", async () => {
    const secret = Keypair.random().secret();
    const config = loadConfig({
      env: completeEnv({ KEEPER_STELLAR_SECRET: secret }),
    });
    const { logger } = capturingLogger();

    const missingRouterMethodInspector: MaintenanceInspector = {
      getContractMethods() {
        return Promise.resolve([{ name: "unrelated_fn", inputs: [], outputs: [] }]);
      },
      measureCall() {
        return Promise.resolve(measured());
      },
    };

    await expect(
      processTtlBump({
        config,
        db: new FakeDb(),
        logger,
        maintenanceInspector: missingRouterMethodInspector,
      }),
    ).rejects.toThrow("does not expose a compatible keep_alive entrypoint");
    expect(submitStellar).not.toHaveBeenCalled();

    await expect(
      processClaimSettlement({
        config,
        db: new FakeDb(),
        logger,
        maintenanceInspector: missingRouterMethodInspector,
      }),
    ).rejects.toThrow("does not expose a callable settle_claim entrypoint");
    expect(submitStellar).not.toHaveBeenCalled();

    const expensiveClaimInspector: MaintenanceInspector = {
      getContractMethods() {
        return Promise.resolve(ROUTER_METHODS);
      },
      measureCall() {
        return Promise.resolve(measured({ cpuInstructions: 90_000_000 }));
      },
    };

    const claimResult = await processClaimSettlement(
      {
        config,
        db: new FakeDb(),
        logger,
        maintenanceInspector: expensiveClaimInspector,
      },
      { resourceBounds: { maxCpuInstructions: 10_000_000 } },
    );
    expect(claimResult.settled).toBe(0);
    expect(claimResult.pending).toBe(2);
    expect(submitStellar).not.toHaveBeenCalled();
  });

  it("produces unsigned dry-run adapter plans with zero maintained counts and rejects incompatible signatures", async () => {
    const config = loadConfig({
      env: completeEnv({ HYPERION_DEPLOYMENTS_FILE: LIVE_DEPLOYMENTS_PATH }),
    });
    const targets = discoverAdapterTargets(config);
    const axelarTarget = targets.find((target) => target.route === "axelar-its");
    expect(axelarTarget).toBeDefined();

    // Incompatible method taking arbitrary Address parameter must not match.
    const badMatch = axelarTarget
      ? matchAdapterMaintenanceMethod(
          [{ name: "keep_alive", inputs: [{ name: "new_admin", type: "Address" }], outputs: [] }],
          axelarTarget,
        )
      : null;
    expect(badMatch).toBeNull();

    // Valid caller + tokens + peers signature matches and encodes caller strkey cleanly.
    const sender = encodeStellarAddress(AddressKind.Account, new Uint8Array(32).fill(0x11));
    const goodMatch = axelarTarget
      ? matchAdapterMaintenanceMethod(
          [
            {
              name: "extend_ttl",
              inputs: [
                { name: "caller", type: "Address" },
                { name: "tokens", type: "Vec<Address>" },
                { name: "peers", type: "Vec<String>" },
              ],
              outputs: [],
            },
          ],
          axelarTarget,
        )
      : null;
    expect(goodMatch?.methodName).toBe("extend_ttl");
    expect(goodMatch?.buildArgs(sender)).toHaveLength(3);

    const inspector: MaintenanceInspector = {
      getContractMethods(contractId) {
        if (contractId === config.indexer.stellar?.routerContractId) {
          return Promise.resolve(ROUTER_METHODS);
        }
        return Promise.resolve([
          {
            name: "extend_ttl",
            inputs: [
              { name: "tokens", type: "Vec" },
              { name: "peers", type: "Vec" },
            ],
            outputs: [],
          },
        ]);
      },
      measureCall() {
        return Promise.resolve(measured({ readOnlyKeys: 2, readWriteKeys: 2 }));
      },
    };

    const { logger } = capturingLogger();
    const dryRunResult = await processTtlBump({
      config,
      db: new FakeDb(),
      logger,
      maintenanceInspector: inspector,
    });
    expect(dryRunResult.dryRun).toBe(true);
    expect(dryRunResult.bumpedTokens).toBe(0);
    expect(dryRunResult.adapterCoverage.maintainedCount).toBe(0);
    expect(dryRunResult.adapterCoverage.plannedAdapters).toHaveLength(2);
    expect(submitStellar).not.toHaveBeenCalled();

    const negativeCheck = validateMeasuredResources(measured({ cpuInstructions: -1 }), {
      maxCpuInstructions: 1000,
      maxReadBytes: 1000,
      maxWriteBytes: 1000,
      maxResourceFeeStroops: 1000n,
      maxFootprintKeys: 10,
    });
    expect(negativeCheck.ok).toBe(false);
  });
});
