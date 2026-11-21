import { resolve } from "node:path";

import { CHAINS, isChainKey } from "@hyperion/protocol";
import { describe, expect, it } from "vitest";

import { admitNetworkEnvironment } from "../../src/config/admission.js";
import {
  isDestinationVerificationChain,
  loadConfig,
  type DestinationVerificationChain,
} from "../../src/config/config.js";
import { NetworkAdmissionError } from "../../src/config/env.js";
import { completeEnv } from "../helpers.js";

function destinationChainId(chain: DestinationVerificationChain): number {
  const chainConfig = CHAINS[chain];
  if (!("chainId" in chainConfig)) throw new Error(`${chain} must be an EVM chain.`);
  return chainConfig.chainId;
}

function activeTestnetConfig(overrides: Readonly<Record<string, string | undefined>> = {}) {
  return loadConfig({
    env: completeEnv({
      HYPERION_DEPLOYMENTS_FILE: resolve(process.cwd(), "deployments", "testnet.json"),
      INDEXER_ENABLED: "false",
      KEEPER_ENABLED: "false",
      ...overrides,
    }),
  });
}

describe("network environment admission", () => {
  it("checks source EVM chain IDs and router bytecode before workers start", async () => {
    const config = loadConfig({
      env: completeEnv({ RAILS_ENABLED: "false", KEEPER_ENABLED: "false" }),
    });
    const chainIdByUrl = new Map(
      config.indexer.evm.flatMap((watch) =>
        watch.rpcUrls.map((url) => [url, watch.chainId] as const),
      ),
    );
    const checkedAddresses: string[] = [];

    expect(config.indexer.evm.length).toBeGreaterThan(0);

    await admitNetworkEnvironment(config, {
      evmClientForUrl: (url) => ({
        getChainId: () => Promise.resolve(chainIdByUrl.get(url) ?? 0),
        getBytecode: ({ address }) => {
          checkedAddresses.push(address);
          return Promise.resolve("0x6000");
        },
      }),
      stellarClientForUrl: () => ({
        getNetwork: () =>
          Promise.resolve({ passphrase: config.indexer.stellar?.networkPassphrase ?? "" }),
      }),
    });

    expect(checkedAddresses).toContain(config.indexer.evm[0]?.routerAddress);
  });

  it("checks active destination providers without requiring a Hyperion EVM router", async () => {
    const config = activeTestnetConfig();
    const chainByUrl = new Map<string, number>();
    for (const [chain, urls] of Object.entries(config.destinationVerification.evmRpcUrls)) {
      if (!isChainKey(chain) || !isDestinationVerificationChain(chain)) continue;
      for (const url of urls) chainByUrl.set(url, destinationChainId(chain));
    }
    const checkedUrls = new Set<string>();

    expect(config.indexer.evm).toEqual([]);
    expect(config.activeProviderLanes.length).toBeGreaterThan(0);

    await admitNetworkEnvironment(config, {
      evmClientForUrl: (url) => ({
        getChainId: () => Promise.resolve(chainByUrl.get(url) ?? 0),
        getBytecode: () => {
          checkedUrls.add(url);
          return Promise.resolve("0x6000");
        },
      }),
    });

    const activeProviderUrls = new Set(
      config.activeProviderLanes.flatMap(
        (lane) => config.destinationVerification.evmRpcUrls[lane.destination],
      ),
    );
    expect(checkedUrls).toEqual(activeProviderUrls);
  });

  it("requires bytecode for active provider contracts", async () => {
    const config = activeTestnetConfig();

    await expect(
      admitNetworkEnvironment(config, {
        evmClientForUrl: (url) => {
          const chain = Object.entries(config.destinationVerification.evmRpcUrls).find(([, urls]) =>
            urls.includes(url),
          )?.[0];
          const chainId =
            chain !== undefined && isChainKey(chain) && isDestinationVerificationChain(chain)
              ? destinationChainId(chain)
              : 0;
          return {
            getChainId: () => Promise.resolve(chainId),
            getBytecode: () => Promise.resolve(undefined),
          };
        },
      }),
    ).rejects.toThrow("provider reports no deployed contract");
  });

  it("reports an RPC chain mismatch by field path without echoing URL credentials", async () => {
    const config = activeTestnetConfig({
      EVM_DELIVERY_RPC_URLS_SEPOLIA: "https://rpc.example.invalid/path?apiKey=do-not-log",
    });
    const chainByUrl = new Map<string, number>();
    for (const [chain, urls] of Object.entries(config.destinationVerification.evmRpcUrls)) {
      if (!isChainKey(chain) || !isDestinationVerificationChain(chain)) continue;
      for (const url of urls) chainByUrl.set(url, destinationChainId(chain));
    }
    const sepoliaUrl = config.destinationVerification.evmRpcUrls.sepolia[0];
    if (sepoliaUrl === undefined) throw new Error("Missing Sepolia provider.");
    chainByUrl.set(sepoliaUrl, 1);

    let admissionError: NetworkAdmissionError | undefined;
    try {
      await admitNetworkEnvironment(config, {
        evmClientForUrl: (url) => ({
          getChainId: () => Promise.resolve(chainByUrl.get(url) ?? 0),
          getBytecode: () => Promise.resolve("0x6000"),
        }),
      });
    } catch (error) {
      if (!(error instanceof NetworkAdmissionError)) throw error;
      admissionError = error;
    }

    expect(admissionError).toBeInstanceOf(NetworkAdmissionError);
    expect(admissionError?.message).toContain(
      "destinationVerification.evmRpcUrls.sepolia[0].chainId",
    );
    expect(admissionError?.message).not.toContain("do-not-log");
  });

  it("rejects a live Stellar passphrase mismatch without exposing the endpoint", async () => {
    const config = activeTestnetConfig({
      INDEXER_ENABLED: "true",
      RAILS_ENABLED: "false",
      STELLAR_RPC_URL: "https://stellar.example.invalid/rpc?token=do-not-log",
    });

    let admissionError: NetworkAdmissionError | undefined;
    try {
      await admitNetworkEnvironment(config, {
        stellarClientForUrl: () => ({
          getNetwork: () => Promise.resolve({ passphrase: "a different network" }),
        }),
      });
    } catch (error) {
      if (!(error instanceof NetworkAdmissionError)) throw error;
      admissionError = error;
    }

    expect(admissionError).toBeInstanceOf(NetworkAdmissionError);
    expect(admissionError?.message).toContain("indexer.stellar.networkPassphrase");
    expect(admissionError?.message).not.toContain("do-not-log");
  });
});
