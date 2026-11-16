import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { Keypair } from "@stellar/stellar-sdk";
import type { Hex } from "@hyperion/protocol";
import { describe, expect, it } from "vitest";

import {
  NetworkAdmissionError,
  destinationRpcUrlFor,
  sanitizeEndpointForDiagnostic,
  verifyWorkerNetworkAdmission,
  type NetworkAdmissionProbeDriver,
} from "../../src/config/admission.js";
import { loadConfig } from "../../src/config/config.js";
import { ConfigError } from "../../src/config/env.js";
import { completeEnv } from "../helpers.js";

const CHECKED_IN_TESTNET_DEPLOYMENTS = resolvePath(process.cwd(), "deployments/testnet.json");

describe("network environment admission checks", () => {
  it("admits destination-only verification on deployments/testnet.json with zero EVM routers", async () => {
    const validKeeperSecret = Keypair.random().secret();
    const config = loadConfig({
      env: completeEnv({
        HYPERION_DEPLOYMENTS_FILE: CHECKED_IN_TESTNET_DEPLOYMENTS,
        KEEPER_ENABLED: "false",
        KEEPER_STELLAR_SECRET: validKeeperSecret,
        EVM_RPC_URL_SEPOLIA: "https://rpc-sepolia.internal.invalid/v2/SUPER_SECRET_PATH_TOKEN_1",
        EVM_RPC_URL_BASE_SEPOLIA: "https://rpc-base-sepolia.internal.invalid/v2/SECRET_TOKEN_2",
      }),
    });

    // Active deployment has no Hyperion EVM router, yet destination verification lanes are configured.
    expect(config.indexer.evm).toEqual([]);
    expect(config.admission.destinationOnlyMode).toBe(true);
    expect(config.admission.lanes.map((lane) => lane.chain)).toEqual([
      "arc-testnet",
      "base-sepolia",
      "sepolia",
    ]);
    for (const lane of config.admission.lanes) {
      expect(lane.hasHyperionRouter).toBe(false);
      expect(lane.routerAddress).toBeNull();
      expect(lane.providerContracts.cctp).not.toBeNull();
    }
    expect(
      config.admission.lanes.find((lane) => lane.chain === "sepolia")?.providerContracts.axelar,
    ).not.toBeNull();
    expect(destinationRpcUrlFor(config, "sepolia")).toBe(
      "https://rpc-sepolia.internal.invalid/v2/SUPER_SECRET_PATH_TOKEN_1",
    );

    const probes: NetworkAdmissionProbeDriver = {
      getStellarNetworkPassphrase: () => Promise.resolve("Test SDF Network ; September 2015"),
      getEvmChainId: (rpcUrl) => {
        if (rpcUrl.includes("rpc-sepolia")) return Promise.resolve(11_155_111);
        if (rpcUrl.includes("rpc-base-sepolia")) return Promise.resolve(84_532);
        return Promise.resolve(5_042_002);
      },
      hasEvmContractCode: () => Promise.resolve(true),
    };

    const result = await verifyWorkerNetworkAdmission(config, {
      probes,
      strictConnectivity: true,
    });
    expect(result.admitted).toBe(true);
    expect(result.destinationOnlyMode).toBe(true);
    expect(result.checkedEvmRouters).toEqual([]);
    expect(result.checkedDestinationLanes).toEqual(["arc-testnet", "base-sepolia", "sepolia"]);
  });

  it("rejects implicit mainnet/testnet mixing across rail URLs, Stellar RPC and cross-network EVM overrides without leaking secrets", () => {
    const dbPassword = "db-ultra-secret-password-991";
    const redisPassword = "redis-ultra-secret-password-992";
    const alchemyApiKey = "alc_live_987654321_DO_NOT_LEAK";
    const badKeeperSeed = "S_NOT_A_VALID_SEED_SECRET_VALUE_445566";

    try {
      loadConfig({
        env: completeEnv({
          DATABASE_URL: `postgres://hyperion:${dbPassword}@127.0.0.1:5433/hyperion`,
          REDIS_URL: `redis://:${redisPassword}@127.0.0.1:6380`,
          HYPERION_NETWORK: "testnet",
          HYPERION_DEPLOYMENTS_FILE: CHECKED_IN_TESTNET_DEPLOYMENTS,
          IRIS_API_URL: `https://iris-api.circle.com/v2/messages?apiKey=${alchemyApiKey}`,
          AXELAR_API_URL: `https://api.gmp.axelarscan.io/?token=${alchemyApiKey}`,
          STELLAR_RPC_URL: `https://user:${alchemyApiKey}@mainnet.sorobanrpc.com/secret-path`,
          EVM_RPC_URL_ETHEREUM: `https://eth-mainnet.g.alchemy.com/v2/${alchemyApiKey}`,
          EVM_RPC_URL_SEPOLIA: `https://eth-mainnet.g.alchemy.com/v2/${alchemyApiKey}`,
          KEEPER_STELLAR_SECRET: badKeeperSeed,
        }),
      });
      throw new Error("expected loadConfig to fail network isolation checks");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const configErr = error as ConfigError;
      const byField = new Map(configErr.faults.map((f) => [f.name, f.fieldPath]));

      expect(byField.get("IRIS_API_URL")).toBe("$.rails.irisUrl");
      expect(byField.get("AXELAR_API_URL")).toBe("$.rails.axelarUrl");
      expect(byField.get("STELLAR_RPC_URL")).toBe("$.indexer.stellar.rpcUrl");
      expect(byField.get("EVM_RPC_URL_ETHEREUM")).toBe("$.env.EVM_RPC_URL_ETHEREUM");
      expect(byField.get("EVM_RPC_URL_SEPOLIA")).toBe(
        "$.verification.lanes[chain=sepolia].rpcUrls[0]",
      );
      expect(byField.get("KEEPER_STELLAR_SECRET")).toBe("$.keeper.stellarSecret");

      expect(configErr.message).not.toContain(dbPassword);
      expect(configErr.message).not.toContain(redisPassword);
      expect(configErr.message).not.toContain(alchemyApiKey);
      expect(configErr.message).not.toContain(badKeeperSeed);
      expect(configErr.message).not.toContain("secret-path");
    }
  });

  it("rejects cross-network peerChain and activation destination metadata in deployment records", () => {
    const mixedDeployment = readFileSync(CHECKED_IN_TESTNET_DEPLOYMENTS, "utf8").replace(
      '"peerChain": "sepolia"',
      '"peerChain": "ethereum"',
    );

    try {
      loadConfig({
        env: completeEnv({
          HYPERION_NETWORK: "testnet",
          HYPERION_DEPLOYMENTS_FILE: CHECKED_IN_TESTNET_DEPLOYMENTS,
        }),
        readFile: () => mixedDeployment,
      });
      throw new Error("expected mixed peerChain deployment to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const configErr = error as ConfigError;
      expect(configErr.faults[0]?.fieldPath).toBe(
        "$.deployments.networks.stellar-testnet.peerChain",
      );
      expect(configErr.message).toContain("$.deployments.networks.stellar-testnet.peerChain");
    }
  });

  it("compares live Stellar passphrase, destination chain IDs and provider contracts before worker startup without leaking RPC credentials", async () => {
    const rpcKey = "qn_secret_token_xyz_778899";
    const keeperSeed = Keypair.random().secret();
    const config = loadConfig({
      env: completeEnv({
        HYPERION_DEPLOYMENTS_FILE: CHECKED_IN_TESTNET_DEPLOYMENTS,
        KEEPER_ENABLED: "false",
        KEEPER_STELLAR_SECRET: keeperSeed,
        STELLAR_RPC_URL: `https://soroban-node.internal.invalid/v1/${rpcKey}?auth=${rpcKey}`,
        EVM_RPC_URL_SEPOLIA: `https://sepolia-node.internal.invalid/v2/${rpcKey}`,
        EVM_RPC_URL_BASE_SEPOLIA: `https://base-sepolia-node.internal.invalid/v2/${rpcKey}`,
      }),
    });

    const missingContract: Hex = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA";
    const probes: NetworkAdmissionProbeDriver = {
      // Simulate Soroban RPC accidentally connected to Stellar Public Mainnet!
      getStellarNetworkPassphrase: () =>
        Promise.resolve("Public Global Stellar Network ; September 2015"),
      // Simulate Sepolia RPC accidentally connected to Ethereum Mainnet (chainId 1)!
      getEvmChainId: (rpcUrl) => {
        if (rpcUrl.includes("base-sepolia-node")) return Promise.resolve(84_532);
        if (rpcUrl.includes("sepolia-node")) return Promise.resolve(1);
        return Promise.resolve(5_042_002);
      },
      // Simulate missing CCTP TokenMessengerV2 bytecode on base-sepolia!
      hasEvmContractCode: (rpcUrl, address) => {
        if (
          rpcUrl.includes("base-sepolia-node") &&
          address.toLowerCase() === missingContract.toLowerCase()
        ) {
          return Promise.resolve(false);
        }
        return Promise.resolve(true);
      },
    };

    await expect(
      verifyWorkerNetworkAdmission(config, { probes, strictConnectivity: true }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(NetworkAdmissionError);
      const admissionErr = err as NetworkAdmissionError;
      const paths = admissionErr.violations.map((v) => v.fieldPath);

      expect(paths).toContain("$.indexer.stellar.networkPassphrase");
      expect(paths).toContain("$.verification.lanes[chain=sepolia].chainId");
      expect(paths).toContain(
        "$.verification.lanes[chain=base-sepolia].providerContracts.cctp.tokenMessengerV2",
      );

      expect(admissionErr.message).not.toContain(rpcKey);
      expect(admissionErr.message).not.toContain(keeperSeed);
      expect(admissionErr.message).not.toContain("not-a-real-password");
      return true;
    });

    expect(
      sanitizeEndpointForDiagnostic(`https://user:${rpcKey}@rpc.example.invalid/v2/${rpcKey}?k=1`),
    ).toBe("https://rpc.example.invalid");
  });
});
