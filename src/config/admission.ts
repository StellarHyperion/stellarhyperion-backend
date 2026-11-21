import { CHAINS, RAIL_CONTRACTS } from "@hyperion/protocol";
import { createPublicClient, http } from "viem";
import type { Address, Hex } from "viem";

import type { AppConfig, DestinationVerificationChain } from "./config.js";
import { NetworkAdmissionError } from "./env.js";
import type { ConfigFault } from "./env.js";
import { StellarRpc } from "../chains/stellar/rpc.js";

const ADMISSION_TIMEOUT_MS = 15_000;

export interface EvmAdmissionClient {
  getChainId(): Promise<number>;
  getBytecode(args: { readonly address: Address }): Promise<Hex | undefined>;
}

export interface StellarAdmissionClient {
  getNetwork(): Promise<{ readonly passphrase: string }>;
}

export interface NetworkAdmissionProviders {
  readonly evmClientForUrl?: (url: string) => EvmAdmissionClient;
  readonly stellarClientForUrl?: (url: string) => StellarAdmissionClient;
}

interface ProviderContract {
  readonly field: string;
  readonly address: string;
}

function defaultEvmClient(url: string): EvmAdmissionClient {
  const client = createPublicClient({
    transport: http(url, { timeout: ADMISSION_TIMEOUT_MS, retryCount: 0 }),
  });
  return {
    getChainId: () => client.getChainId(),
    getBytecode: ({ address }) => client.getCode({ address }),
  };
}

function defaultStellarClient(url: string): StellarAdmissionClient {
  const client = new StellarRpc(url, { timeoutMs: ADMISSION_TIMEOUT_MS });
  return { getNetwork: () => client.getNetwork() };
}

function isEvmAddress(address: string): address is Address {
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}

function hasCode(code: Hex | undefined): boolean {
  return typeof code === "string" && /^0x(?:[0-9a-f]{2})+$/i.test(code) && !/^0x0*$/i.test(code);
}

function fault(name: string, problem: string): ConfigFault {
  return {
    name,
    problem,
    purpose: "Verify the selected network and its provider contracts before workers start.",
  };
}

async function admitEvmEndpoint(
  url: string,
  path: string,
  expectedChainId: number,
  contracts: readonly ProviderContract[],
  clientForUrl: (url: string) => EvmAdmissionClient,
  faults: ConfigFault[],
): Promise<void> {
  let client: EvmAdmissionClient;
  let actualChainId: number;
  try {
    client = clientForUrl(url);
    actualChainId = await client.getChainId();
  } catch {
    faults.push(fault(`${path}.chainId`, "provider network identity could not be verified"));
    return;
  }
  if (actualChainId !== expectedChainId) {
    faults.push(
      fault(
        `${path}.chainId`,
        `provider reports chain ID ${actualChainId}; expected ${expectedChainId}`,
      ),
    );
    return;
  }

  await Promise.all(
    contracts.map(async (contract) => {
      if (!isEvmAddress(contract.address) || /^0x0{40}$/i.test(contract.address)) {
        faults.push(fault(`${path}.contracts.${contract.field}`, "contract address is invalid"));
        return;
      }
      try {
        if (!hasCode(await client.getBytecode({ address: contract.address }))) {
          faults.push(
            fault(`${path}.contracts.${contract.field}`, "provider reports no deployed contract"),
          );
        }
      } catch {
        faults.push(
          fault(`${path}.contracts.${contract.field}`, "provider contract could not be verified"),
        );
      }
    }),
  );
}

function destinationContracts(
  chain: DestinationVerificationChain,
  activeRoutes: ReadonlySet<"cctp" | "axelar-its">,
  faults: ConfigFault[],
): ProviderContract[] {
  const contracts = RAIL_CONTRACTS[chain];
  const cctpContracts = contracts?.cctp;
  const axelarContracts = contracts?.axelar;
  const result: ProviderContract[] = [];

  if (activeRoutes.has("cctp")) {
    if (cctpContracts === null || cctpContracts === undefined) {
      faults.push(
        fault(`providerContracts.${chain}.cctp`, "required provider contracts are not configured"),
      );
    } else {
      result.push(
        {
          field: "cctp.messageTransmitterV2",
          address: cctpContracts.messageTransmitterV2,
        },
        { field: "cctp.tokenMessengerV2", address: cctpContracts.tokenMessengerV2 },
      );
    }
  }

  if (activeRoutes.has("axelar-its")) {
    const its = axelarContracts?.interchainTokenService;
    if (its === undefined) {
      faults.push(
        fault(
          `providerContracts.${chain}.axelar.interchainTokenService`,
          "required provider contract is not configured",
        ),
      );
    } else {
      result.push({ field: "axelar.interchainTokenService", address: its });
    }
  }

  return result;
}

/**
 * Verify live provider identity and required contract presence before constructing workers.
 * Destination proof providers are selected from active source adapters, not EVM router entries.
 */
export async function admitNetworkEnvironment(
  config: AppConfig,
  providers: NetworkAdmissionProviders = {},
): Promise<void> {
  const evmClientForUrl = providers.evmClientForUrl ?? defaultEvmClient;
  const stellarClientForUrl = providers.stellarClientForUrl ?? defaultStellarClient;
  const faults: ConfigFault[] = [];
  const checks: Promise<void>[] = [];

  if ((config.indexer.enabled || config.keeper.enabled) && config.indexer.stellar !== null) {
    const stellar = config.indexer.stellar;
    const endpoints = [{ url: stellar.rpcUrl, path: "indexer.stellar.rpcUrl" }];
    if (config.indexer.enabled && stellar.historicalRpcUrl) {
      endpoints.push({
        url: stellar.historicalRpcUrl,
        path: "indexer.stellar.historicalRpcUrl",
      });
    }
    for (const endpoint of endpoints) {
      checks.push(
        (async () => {
          try {
            const network = await stellarClientForUrl(endpoint.url).getNetwork();
            if (network.passphrase !== stellar.networkPassphrase) {
              faults.push(
                fault(
                  endpoint.path === "indexer.stellar.rpcUrl"
                    ? "indexer.stellar.networkPassphrase"
                    : `${endpoint.path}.networkPassphrase`,
                  "provider passphrase does not match the selected deployment network",
                ),
              );
            }
          } catch {
            faults.push(fault(endpoint.path, "provider network identity could not be verified"));
          }
        })(),
      );
    }
  }

  if (config.indexer.enabled) {
    for (const watch of config.indexer.evm) {
      for (const [index, url] of watch.rpcUrls.entries()) {
        checks.push(
          admitEvmEndpoint(
            url,
            `indexer.evm.${watch.chain}.rpcUrls[${String(index)}]`,
            watch.chainId,
            [{ field: "router", address: watch.routerAddress }],
            evmClientForUrl,
            faults,
          ),
        );
      }
    }
  }

  if (config.rails.enabled) {
    const activeRoutesByDestination = new Map<
      DestinationVerificationChain,
      Set<"cctp" | "axelar-its">
    >();
    for (const lane of config.activeProviderLanes) {
      const routes =
        activeRoutesByDestination.get(lane.destination) ?? new Set<"cctp" | "axelar-its">();
      routes.add(lane.route);
      activeRoutesByDestination.set(lane.destination, routes);
    }

    for (const [chain, activeRoutes] of activeRoutesByDestination) {
      const chainConfig = CHAINS[chain];
      if (chainConfig.network !== config.network || !("chainId" in chainConfig)) continue;
      const contracts = destinationContracts(chain, activeRoutes, faults);
      for (const [index, url] of config.destinationVerification.evmRpcUrls[chain].entries()) {
        checks.push(
          admitEvmEndpoint(
            url,
            `destinationVerification.evmRpcUrls.${chain}[${String(index)}]`,
            chainConfig.chainId,
            contracts,
            evmClientForUrl,
            faults,
          ),
        );
      }
    }
  }

  await Promise.all(checks);
  if (faults.length > 0) {
    faults.sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.problem.localeCompare(right.problem),
    );
    throw new NetworkAdmissionError(faults);
  }
}
