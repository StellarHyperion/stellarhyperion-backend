import { StrKey } from "@stellar/stellar-sdk";
import type { ChainKey, DeploymentSet, Hex, NetworkMode } from "@hyperion/protocol";
import {
  CHAINS,
  CHAIN_KEYS,
  IRIS_API,
  RAIL_CONTRACTS,
  RouteKind,
  evmChainsFor,
  isChainKey,
  isEvmChain,
  isEvmDeployment,
  isStellarDeployment,
  stellarChainFor,
} from "@hyperion/protocol";
import type { Logger } from "pino";
import { createPublicClient, http } from "viem";

import type { AppConfig } from "./config.js";
import type { EnvReader, VarSpec } from "./env.js";

export interface DestinationCctpContracts {
  readonly tokenMessengerV2: Hex;
  readonly messageTransmitterV2: Hex;
}

export interface DestinationAxelarContracts {
  readonly chainName: string;
  readonly interchainTokenService: Hex;
}

export interface DestinationProviderContracts {
  readonly cctp: DestinationCctpContracts | null;
  readonly axelar: DestinationAxelarContracts | null;
}

export interface DestinationVerificationLane {
  readonly chain: ChainKey;
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly rpcUrls: readonly string[];
  readonly routes: readonly RouteKind[];
  readonly hasHyperionRouter: boolean;
  readonly routerAddress: Hex | null;
  readonly providerContracts: DestinationProviderContracts;
}

export interface NetworkAdmissionConfig {
  readonly destinationOnlyMode: boolean;
  readonly lanes: readonly DestinationVerificationLane[];
  readonly verifyRpcOnStartup: boolean;
  readonly strictRpcConnectivity: boolean;
}

export interface AdmissionViolation {
  readonly fieldPath: string;
  readonly envVar?: string | undefined;
  readonly expected: string;
  readonly actual: string;
  readonly problem: string;
}

export class NetworkAdmissionError extends Error {
  readonly violations: readonly AdmissionViolation[];

  constructor(violations: readonly AdmissionViolation[]) {
    super(renderViolations(violations));
    this.name = "NetworkAdmissionError";
    this.violations = violations;
  }
}

function renderViolations(violations: readonly AdmissionViolation[]): string {
  const count =
    violations.length === 1
      ? "1 network admission check"
      : `${String(violations.length)} network admission checks`;
  const lines = violations.map((v) => {
    const source = v.envVar ? `${v.fieldPath} [${v.envVar}]` : v.fieldPath;
    return `  ${source}: ${v.problem} (expected ${v.expected}; found ${v.actual})`;
  });
  return [`Hyperion worker admission refused: ${count} failed.`, ...lines].join("\n");
}

const URL_IN_TEXT_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

/**
 * Formats an endpoint URL for safe operator diagnostics without exposing userinfo credentials,
 * provider path API keys (such as `/v2/<key>`) or query-string tokens.
 */
export function sanitizeEndpointForDiagnostic(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.host === "") return "[invalid-endpoint]";
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "[invalid-endpoint]";
  }
}

export function scrubDiagnosticSecrets(
  text: string,
  secrets: readonly (string | null | undefined)[] = [],
): string {
  let scrubbed = text.replace(URL_IN_TEXT_RE, (matched) => sanitizeEndpointForDiagnostic(matched));
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.trim().length > 0) {
      scrubbed = scrubbed.replaceAll(secret, "[REDACTED]");
    }
  }
  return scrubbed;
}

export function envSuffixForChain(chain: ChainKey): string {
  return chain.toUpperCase().replaceAll("-", "_");
}

function evmOverrideVarSpec(chain: ChainKey, plural: boolean): VarSpec {
  const suffix = envSuffixForChain(chain);
  return {
    name: plural ? `EVM_RPC_URLS_${suffix}` : `EVM_RPC_URL_${suffix}`,
    kind: "url",
    protocols: ["http", "https"],
    required: false,
    printable: false,
    purpose: `RPC endpoint override for ${CHAINS[chain].name}.`,
  };
}

function oppositeNetwork(network: NetworkMode): NetworkMode {
  return network === "mainnet" ? "testnet" : "mainnet";
}

function detectCrossNetworkUrlMismatch(
  rawUrl: string,
  expectedNetwork: NetworkMode,
  kind: "iris" | "axelar" | "stellar-rpc" | "evm-rpc",
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const other = oppositeNetwork(expectedNetwork);

  if (kind === "iris") {
    const otherDefaultHost = new URL(IRIS_API[other]).hostname.toLowerCase();
    if (host === otherDefaultHost) {
      return `points to ${other} Circle Iris host ${sanitizeEndpointForDiagnostic(rawUrl)}`;
    }
    if (
      expectedNetwork === "testnet" &&
      host.endsWith(".circle.com") &&
      !host.includes("sandbox")
    ) {
      return `points to non-sandbox Circle host ${sanitizeEndpointForDiagnostic(rawUrl)} while HYPERION_NETWORK=testnet`;
    }
    if (expectedNetwork === "mainnet" && (host.includes("sandbox") || host.includes("testnet"))) {
      return `points to sandbox/testnet host ${sanitizeEndpointForDiagnostic(rawUrl)} while HYPERION_NETWORK=mainnet`;
    }
    return null;
  }

  if (kind === "axelar") {
    if (
      expectedNetwork === "testnet" &&
      (host === "api.gmp.axelarscan.io" ||
        (host.endsWith("axelarscan.io") && !host.includes("testnet")))
    ) {
      return `points to mainnet Axelar GMP host ${sanitizeEndpointForDiagnostic(rawUrl)} while HYPERION_NETWORK=testnet`;
    }
    if (expectedNetwork === "mainnet" && host.includes("testnet")) {
      return `points to testnet Axelar GMP host ${sanitizeEndpointForDiagnostic(rawUrl)} while HYPERION_NETWORK=mainnet`;
    }
    return null;
  }

  if (kind === "stellar-rpc") {
    const otherStellar = stellarChainFor(other);
    const otherRpcHost = new URL(otherStellar.defaultRpcUrl).hostname.toLowerCase();
    const otherHorizonHost = new URL(otherStellar.defaultHorizonUrl).hostname.toLowerCase();
    if (host === otherRpcHost || host === otherHorizonHost) {
      return `points to ${other} Stellar endpoint ${sanitizeEndpointForDiagnostic(rawUrl)} while HYPERION_NETWORK=${expectedNetwork}`;
    }
    if (expectedNetwork === "testnet" && host.includes("mainnet") && !host.includes("testnet")) {
      return `points to mainnet Stellar host ${sanitizeEndpointForDiagnostic(rawUrl)} while HYPERION_NETWORK=testnet`;
    }
    if (expectedNetwork === "mainnet" && host.includes("testnet")) {
      return `points to testnet Stellar host ${sanitizeEndpointForDiagnostic(rawUrl)} while HYPERION_NETWORK=mainnet`;
    }
    return null;
  }

  // kind === "evm-rpc"
  const otherEvmDefaultHosts = new Set(
    evmChainsFor(other).map((c) => new URL(c.defaultRpcUrl).hostname.toLowerCase()),
  );
  if (otherEvmDefaultHosts.has(host)) {
    return `points to ${other} default EVM RPC ${sanitizeEndpointForDiagnostic(rawUrl)} while HYPERION_NETWORK=${expectedNetwork}`;
  }
  if (
    expectedNetwork === "testnet" &&
    (host.includes("mainnet") || host === "eth.llamarpc.com") &&
    !host.includes("testnet") &&
    !host.includes("sepolia")
  ) {
    return `points to mainnet EVM RPC host ${sanitizeEndpointForDiagnostic(rawUrl)} while HYPERION_NETWORK=testnet`;
  }
  if (expectedNetwork === "mainnet" && (host.includes("sepolia") || host.includes("testnet"))) {
    return `points to testnet EVM RPC host ${sanitizeEndpointForDiagnostic(rawUrl)} while HYPERION_NETWORK=mainnet`;
  }
  return null;
}

export interface StaticAdmissionPlanInput {
  readonly reader: EnvReader;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly network: NetworkMode;
  readonly rawDeploymentsJson: unknown;
  readonly deployments: DeploymentSet;
  readonly deploymentsSpec: VarSpec;
  readonly irisSpec: VarSpec;
  readonly irisUrl: string;
  readonly axelarSpec: VarSpec;
  readonly axelarUrl: string;
  readonly stellarRpcSpec: VarSpec;
  readonly stellarRpcUrl: string | null;
  readonly keeperSecretSpec: VarSpec;
  readonly keeperStellarSecret: string | null;
  readonly verifyRpcOnStartup: boolean;
  readonly strictRpcConnectivity: boolean;
}

function resolveProviderContracts(
  chainKey: ChainKey,
  routes: readonly RouteKind[],
): DestinationProviderContracts {
  const entry = RAIL_CONTRACTS[chainKey];
  const cctp = entry?.cctp ?? null;
  const axelar = entry?.axelar ?? null;
  const wantsCctp = routes.includes(RouteKind.Cctp);
  const wantsAxelar = routes.includes(RouteKind.AxelarIts);

  return {
    cctp:
      wantsCctp && cctp !== null
        ? {
            tokenMessengerV2: cctp.tokenMessengerV2,
            messageTransmitterV2: cctp.messageTransmitterV2,
          }
        : null,
    axelar:
      wantsAxelar && axelar !== null
        ? {
            chainName: axelar.chainName,
            interchainTokenService: axelar.interchainTokenService as Hex,
          }
        : null,
  };
}

function inspectRawDeploymentMetadata(
  reader: EnvReader,
  deploymentsSpec: VarSpec,
  network: NetworkMode,
  rawJson: unknown,
): ReadonlyMap<ChainKey, Set<RouteKind>> {
  const explicitRoutesByChain = new Map<ChainKey, Set<RouteKind>>();
  if (typeof rawJson !== "object" || rawJson === null) {
    return explicitRoutesByChain;
  }
  const networksObj = (rawJson as { networks?: unknown }).networks;
  if (typeof networksObj !== "object" || networksObj === null) {
    return explicitRoutesByChain;
  }

  for (const [sourceKey, rawEntry] of Object.entries(networksObj as Record<string, unknown>)) {
    if (typeof rawEntry !== "object" || rawEntry === null) continue;
    const entry = rawEntry as Record<string, unknown>;

    if (entry.peerChain !== undefined) {
      if (typeof entry.peerChain !== "string" || !isChainKey(entry.peerChain)) {
        const desc = typeof entry.peerChain === "string" ? entry.peerChain : typeof entry.peerChain;
        reader.reject(
          deploymentsSpec,
          `names unknown peerChain "${desc}"`,
          `$.deployments.networks.${sourceKey}.peerChain`,
        );
      } else if (CHAINS[entry.peerChain].network !== network) {
        reader.reject(
          deploymentsSpec,
          `sets peerChain "${entry.peerChain}" (${CHAINS[entry.peerChain].network}) while HYPERION_NETWORK is ${network}`,
          `$.deployments.networks.${sourceKey}.peerChain`,
        );
      } else if (isEvmChain(CHAINS[entry.peerChain])) {
        const set = explicitRoutesByChain.get(entry.peerChain) ?? new Set<RouteKind>();
        set.add(RouteKind.AxelarIts);
        explicitRoutesByChain.set(entry.peerChain, set);
      }
    }

    const activation = entry.activation;
    if (typeof activation === "object" && activation !== null) {
      const cctp = (activation as { cctp?: unknown }).cctp;
      if (typeof cctp === "object" && cctp !== null) {
        const destinations = (cctp as { destinations?: unknown }).destinations;
        if (Array.isArray(destinations)) {
          destinations.forEach((dest: unknown, idx: number) => {
            const path = `$.deployments.networks.${sourceKey}.activation.cctp.destinations[${String(idx)}]`;
            if (typeof dest !== "string" || !isChainKey(dest)) {
              const desc = typeof dest === "string" ? dest : typeof dest;
              reader.reject(deploymentsSpec, `names unknown CCTP destination "${desc}"`, path);
              return;
            }
            if (CHAINS[dest].network !== network) {
              reader.reject(
                deploymentsSpec,
                `names CCTP destination "${dest}" (${CHAINS[dest].network}) while HYPERION_NETWORK is ${network}`,
                path,
              );
              return;
            }
            if (isEvmChain(CHAINS[dest])) {
              const set = explicitRoutesByChain.get(dest) ?? new Set<RouteKind>();
              set.add(RouteKind.Cctp);
              explicitRoutesByChain.set(dest, set);
            }
          });
        }
      }
    }
  }

  return explicitRoutesByChain;
}

export function planAndValidateNetworkAdmission(
  input: StaticAdmissionPlanInput,
): NetworkAdmissionConfig {
  const { reader, network, deployments } = input;

  // 1. Refuse cross-network EVM_RPC_URL_<CHAIN> / EVM_RPC_URLS_<CHAIN> overrides so mainnet and
  //    testnet environment settings can never be mixed implicitly.
  for (const key of CHAIN_KEYS) {
    if (key === "local") continue;
    const chain = CHAINS[key];
    if (!isEvmChain(chain) || chain.network === network) continue;

    for (const plural of [false, true]) {
      const spec = evmOverrideVarSpec(key, plural);
      if (reader.has(spec.name)) {
        reader.reject(
          spec,
          `sets ${chain.network} chain override for "${key}" while HYPERION_NETWORK is ${network}`,
          `$.env.${spec.name}`,
        );
      }
    }
  }

  // 2. Validate Rail API URLs against cross-network mixing.
  if (input.irisUrl !== "") {
    const mismatch = detectCrossNetworkUrlMismatch(input.irisUrl, network, "iris");
    if (mismatch !== null) {
      reader.reject(input.irisSpec, mismatch, "$.rails.irisUrl");
    }
  }
  if (input.axelarUrl !== "") {
    const mismatch = detectCrossNetworkUrlMismatch(input.axelarUrl, network, "axelar");
    if (mismatch !== null) {
      reader.reject(input.axelarSpec, mismatch, "$.rails.axelarUrl");
    }
  }

  // 3. Validate Stellar RPC URL against cross-network mixing.
  if (input.stellarRpcUrl !== null && input.stellarRpcUrl !== "") {
    const mismatch = detectCrossNetworkUrlMismatch(input.stellarRpcUrl, network, "stellar-rpc");
    if (mismatch !== null) {
      reader.reject(input.stellarRpcSpec, mismatch, "$.indexer.stellar.rpcUrl");
    }
  }

  // 4. Validate keeper secret format without ever echoing the secret seed.
  if (input.keeperStellarSecret !== null) {
    if (!StrKey.isValidEd25519SecretSeed(input.keeperStellarSecret)) {
      reader.reject(
        input.keeperSecretSpec,
        "is not a valid Stellar Ed25519 secret seed strkey",
        "$.keeper.stellarSecret",
      );
    }
  }

  // 5. Inspect deployment metadata and assemble destination EVM verification lanes.
  //    Destination-only verification explicitly supports deployments with a Stellar source router
  //    and zero EVM Hyperion routers.
  const explicitRoutesByChain = inspectRawDeploymentMetadata(
    reader,
    input.deploymentsSpec,
    network,
    input.rawDeploymentsJson,
  );

  const stellarKey = stellarChainFor(network).key;
  const stellarDeployment = deployments.networks[stellarKey];
  const stellarRoutes: RouteKind[] = [];
  if (stellarDeployment && isStellarDeployment(stellarDeployment)) {
    if (stellarDeployment.adapters[RouteKind.Cctp] !== undefined) {
      stellarRoutes.push(RouteKind.Cctp);
    }
    if (stellarDeployment.adapters[RouteKind.AxelarIts] !== undefined) {
      stellarRoutes.push(RouteKind.AxelarIts);
    }
  }

  const candidateRoutesByChain = new Map<ChainKey, Set<RouteKind>>();
  for (const [chainKey, routes] of explicitRoutesByChain.entries()) {
    candidateRoutesByChain.set(chainKey, new Set(routes));
  }

  // Include deployed EVM routers on this network and any same-network EVM chains with explicit RPC overrides
  // or supported routes when explicit activation lists are absent.
  for (const evmChain of evmChainsFor(network)) {
    const singleSpec = evmOverrideVarSpec(evmChain.key, false);
    const pluralSpec = evmOverrideVarSpec(evmChain.key, true);
    const hasOverride = reader.has(singleSpec.name) || reader.has(pluralSpec.name);
    const deployed = deployments.networks[evmChain.key];
    const hasExplicitMetadata = explicitRoutesByChain.size > 0;

    const rc = RAIL_CONTRACTS[evmChain.key];
    const supportsCctp = (rc?.cctp ?? null) !== null;
    const supportsAxelar = (rc?.axelar ?? null) !== null;

    if (deployed && isEvmDeployment(deployed)) {
      const set = candidateRoutesByChain.get(evmChain.key) ?? new Set<RouteKind>();
      if (deployed.adapters[RouteKind.Cctp] !== undefined) set.add(RouteKind.Cctp);
      if (deployed.adapters[RouteKind.AxelarIts] !== undefined) set.add(RouteKind.AxelarIts);
      for (const r of stellarRoutes) {
        if (r === RouteKind.Cctp && supportsCctp) set.add(r);
        if (r === RouteKind.AxelarIts && supportsAxelar) set.add(r);
      }
      candidateRoutesByChain.set(evmChain.key, set);
      continue;
    }

    if (!hasExplicitMetadata && stellarRoutes.length > 0) {
      const set = candidateRoutesByChain.get(evmChain.key) ?? new Set<RouteKind>();
      for (const r of stellarRoutes) {
        if (r === RouteKind.Cctp && supportsCctp) set.add(r);
        if (r === RouteKind.AxelarIts && supportsAxelar) set.add(r);
      }
      if (set.size > 0) {
        candidateRoutesByChain.set(evmChain.key, set);
      }
    } else if (hasOverride) {
      const set = candidateRoutesByChain.get(evmChain.key) ?? new Set<RouteKind>();
      for (const r of stellarRoutes) {
        if (r === RouteKind.Cctp && supportsCctp) set.add(r);
        if (r === RouteKind.AxelarIts && supportsAxelar) set.add(r);
      }
      candidateRoutesByChain.set(evmChain.key, set);
    }
  }

  const lanes: DestinationVerificationLane[] = [];
  let evmRouterCount = 0;

  for (const evmChain of evmChainsFor(network)) {
    const routeSet = candidateRoutesByChain.get(evmChain.key);
    if (!routeSet) continue;

    const deployed = deployments.networks[evmChain.key];
    const hasHyperionRouter = deployed !== undefined && isEvmDeployment(deployed);
    if (hasHyperionRouter) evmRouterCount += 1;

    const singleSpec = evmOverrideVarSpec(evmChain.key, false);
    const pluralSpec = evmOverrideVarSpec(evmChain.key, true);
    let rpcUrls: readonly string[];
    let usedSpec: VarSpec = singleSpec;
    if (reader.has(pluralSpec.name)) {
      usedSpec = pluralSpec;
      rpcUrls = reader.urls(pluralSpec);
    } else if (reader.has(singleSpec.name)) {
      usedSpec = singleSpec;
      rpcUrls = reader.urls(singleSpec);
    } else {
      rpcUrls = [evmChain.defaultRpcUrl];
    }

    rpcUrls.forEach((url, idx) => {
      const mismatch = detectCrossNetworkUrlMismatch(url, network, "evm-rpc");
      if (mismatch !== null) {
        const fieldPath = hasHyperionRouter
          ? `$.indexer.evm[chain=${evmChain.key}].rpcUrls[${String(idx)}]`
          : `$.verification.lanes[chain=${evmChain.key}].rpcUrls[${String(idx)}]`;
        reader.reject(usedSpec, mismatch, fieldPath);
      }
    });

    const routes = [...routeSet].sort((a, b) => a - b);
    const providerContracts = resolveProviderContracts(evmChain.key, routes);

    if (routes.includes(RouteKind.Cctp) && providerContracts.cctp === null) {
      reader.reject(
        input.deploymentsSpec,
        `enables CCTP verification on "${evmChain.key}", which has no CCTP provider contracts in registry`,
        `$.verification.lanes[chain=${evmChain.key}].providerContracts.cctp`,
      );
    }
    if (routes.includes(RouteKind.AxelarIts) && providerContracts.axelar === null) {
      reader.reject(
        input.deploymentsSpec,
        `enables Axelar ITS verification on "${evmChain.key}", which has no Axelar ITS provider contract in registry`,
        `$.verification.lanes[chain=${evmChain.key}].providerContracts.axelar`,
      );
    }

    lanes.push({
      chain: evmChain.key,
      chainId: evmChain.chainId,
      rpcUrl: rpcUrls[0] ?? evmChain.defaultRpcUrl,
      rpcUrls,
      routes,
      hasHyperionRouter,
      routerAddress: hasHyperionRouter ? deployed.router : null,
      providerContracts,
    });
  }

  lanes.sort((a, b) => a.chain.localeCompare(b.chain));

  return {
    destinationOnlyMode: evmRouterCount === 0 && lanes.length > 0,
    lanes,
    verifyRpcOnStartup: input.verifyRpcOnStartup,
    strictRpcConnectivity: input.strictRpcConnectivity,
  };
}

export function destinationRpcUrlFor(config: AppConfig, chainKey: ChainKey): string {
  const lane = config.admission.lanes.find((entry) => entry.chain === chainKey);
  if (lane) return lane.rpcUrl;
  const watched = config.indexer.evm.find((entry) => entry.chain === chainKey);
  if (watched) return watched.rpcUrl;
  const chain = CHAINS[chainKey];
  if (isEvmChain(chain)) return chain.defaultRpcUrl;
  return "";
}

export interface NetworkAdmissionProbeDriver {
  getStellarNetworkPassphrase(rpcUrl: string, signal: AbortSignal): Promise<string>;
  getEvmChainId(rpcUrl: string, signal: AbortSignal): Promise<number>;
  hasEvmContractCode(rpcUrl: string, address: Hex, signal: AbortSignal): Promise<boolean>;
}

export function createLiveNetworkAdmissionProbes(timeoutMs = 10_000): NetworkAdmissionProbeDriver {
  return {
    async getStellarNetworkPassphrase(rpcUrl: string, signal: AbortSignal): Promise<string> {
      const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getNetwork" }),
        signal: combined,
      });
      if (!response.ok) {
        throw new Error(
          `Soroban getNetwork returned HTTP ${String(response.status)} from ${sanitizeEndpointForDiagnostic(rpcUrl)}`,
        );
      }
      const payload = (await response.json()) as {
        result?: { passphrase?: unknown };
        error?: { message?: unknown };
      };
      if (typeof payload.result?.passphrase !== "string") {
        throw new Error(
          `Soroban getNetwork returned no passphrase from ${sanitizeEndpointForDiagnostic(rpcUrl)}`,
        );
      }
      return payload.result.passphrase;
    },

    async getEvmChainId(rpcUrl: string, signal: AbortSignal): Promise<number> {
      const client = createPublicClient({
        transport: http(rpcUrl, {
          timeout: timeoutMs,
          retryCount: 0,
          fetchOptions: { signal },
        }),
      });
      return client.getChainId();
    },

    async hasEvmContractCode(rpcUrl: string, address: Hex, signal: AbortSignal): Promise<boolean> {
      const client = createPublicClient({
        transport: http(rpcUrl, {
          timeout: timeoutMs,
          retryCount: 0,
          fetchOptions: { signal },
        }),
      });
      const code = await client.getCode({ address });
      return typeof code === "string" && code !== "0x" && code.length > 2;
    },
  };
}

export interface VerifyWorkerAdmissionOptions {
  readonly probes?: NetworkAdmissionProbeDriver | undefined;
  readonly logger?: Logger | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly strictConnectivity?: boolean | undefined;
}

export interface WorkerNetworkAdmissionResult {
  readonly admitted: true;
  readonly network: NetworkMode;
  readonly destinationOnlyMode: boolean;
  readonly checkedStellarChain: ChainKey | null;
  readonly checkedEvmRouters: readonly ChainKey[];
  readonly checkedDestinationLanes: readonly ChainKey[];
  readonly transientProbeWarnings: readonly string[];
}

export async function verifyWorkerNetworkAdmission(
  config: AppConfig,
  options: VerifyWorkerAdmissionOptions = {},
): Promise<WorkerNetworkAdmissionResult> {
  const signal = options.signal ?? AbortSignal.timeout(15_000);
  const probes = options.probes ?? createLiveNetworkAdmissionProbes();
  const strictConnectivity = options.strictConnectivity ?? config.admission.strictRpcConnectivity;
  const secrets = [config.databaseUrl, config.redisUrl, config.keeper.stellarSecret];
  const violations: AdmissionViolation[] = [];
  const transientProbeWarnings: string[] = [];

  const handleProbeError = (
    fieldPath: string,
    envVar: string | undefined,
    expected: string,
    error: unknown,
  ): void => {
    const rawMsg = error instanceof Error ? error.message : String(error);
    const safeMsg = scrubDiagnosticSecrets(rawMsg, secrets);
    if (strictConnectivity) {
      violations.push({
        fieldPath,
        envVar,
        expected,
        actual: "unreachable",
        problem: `RPC admission probe failed: ${safeMsg}`,
      });
    } else {
      const warning = `${fieldPath}: transient probe failure (${safeMsg})`;
      transientProbeWarnings.push(warning);
      options.logger?.warn({ fieldPath, envVar }, warning);
    }
  };

  // 1. Verify Stellar network passphrase against live Soroban RPC when Stellar watcher is configured.
  let checkedStellarChain: ChainKey | null = null;
  if (config.indexer.enabled && config.indexer.stellar !== null) {
    const stellar = config.indexer.stellar;
    checkedStellarChain = stellar.chain;
    const expectedChain = stellarChainFor(config.network);
    if (stellar.networkPassphrase !== expectedChain.networkPassphrase) {
      violations.push({
        fieldPath: "$.indexer.stellar.networkPassphrase",
        envVar: "HYPERION_DEPLOYMENTS_FILE",
        expected: expectedChain.networkPassphrase,
        actual: stellar.networkPassphrase,
        problem: `Stellar passphrase does not match HYPERION_NETWORK=${config.network}`,
      });
    } else {
      try {
        const remotePassphrase = await probes.getStellarNetworkPassphrase(stellar.rpcUrl, signal);
        if (remotePassphrase !== stellar.networkPassphrase) {
          violations.push({
            fieldPath: "$.indexer.stellar.networkPassphrase",
            envVar: "STELLAR_RPC_URL",
            expected: stellar.networkPassphrase,
            actual: scrubDiagnosticSecrets(remotePassphrase, secrets),
            problem: `Soroban RPC at ${sanitizeEndpointForDiagnostic(stellar.rpcUrl)} reported passphrase for a different Stellar network`,
          });
        }
      } catch (error) {
        handleProbeError(
          "$.indexer.stellar.rpcUrl",
          "STELLAR_RPC_URL",
          `reachable ${config.network} Soroban RPC`,
          error,
        );
      }
    }
  }

  // 2. Verify watched EVM routers (when present; destination-only mode has zero EVM routers).
  const checkedEvmRouters: ChainKey[] = [];
  if (config.indexer.enabled) {
    for (const evmWatch of config.indexer.evm) {
      checkedEvmRouters.push(evmWatch.chain);
      const envVar = `EVM_RPC_URL_${envSuffixForChain(evmWatch.chain)}`;
      try {
        const remoteChainId = await probes.getEvmChainId(evmWatch.rpcUrl, signal);
        if (remoteChainId !== evmWatch.chainId) {
          violations.push({
            fieldPath: `$.indexer.evm[chain=${evmWatch.chain}].chainId`,
            envVar,
            expected: String(evmWatch.chainId),
            actual: String(remoteChainId),
            problem: `EVM RPC at ${sanitizeEndpointForDiagnostic(evmWatch.rpcUrl)} reported wrong chainId for ${evmWatch.chain}`,
          });
          continue;
        }
        const hasRouter = await probes.hasEvmContractCode(
          evmWatch.rpcUrl,
          evmWatch.routerAddress,
          signal,
        );
        if (!hasRouter) {
          violations.push({
            fieldPath: `$.deployments.networks.${evmWatch.chain}.router`,
            envVar: "HYPERION_DEPLOYMENTS_FILE",
            expected: `deployed bytecode at ${evmWatch.routerAddress}`,
            actual: "0x (empty code)",
            problem: `configured EVM Hyperion router has no bytecode on ${evmWatch.chain} (${sanitizeEndpointForDiagnostic(evmWatch.rpcUrl)})`,
          });
        }
      } catch (error) {
        handleProbeError(
          `$.indexer.evm[chain=${evmWatch.chain}].rpcUrl`,
          envVar,
          `chainId ${String(evmWatch.chainId)}`,
          error,
        );
      }
    }
  }

  // 3. Verify destination-only (and hybrid) EVM verification lanes: chainId + provider contracts,
  //    explicitly requiring NO EVM Hyperion router when `lane.hasHyperionRouter` is false.
  const checkedDestinationLanes: ChainKey[] = [];
  if (config.rails.enabled) {
    for (const lane of config.admission.lanes) {
      checkedDestinationLanes.push(lane.chain);
      const envVar = `EVM_RPC_URL_${envSuffixForChain(lane.chain)}`;
      try {
        const remoteChainId = await probes.getEvmChainId(lane.rpcUrl, signal);
        if (remoteChainId !== lane.chainId) {
          violations.push({
            fieldPath: `$.verification.lanes[chain=${lane.chain}].chainId`,
            envVar,
            expected: String(lane.chainId),
            actual: String(remoteChainId),
            problem: `destination verification RPC at ${sanitizeEndpointForDiagnostic(lane.rpcUrl)} reported wrong chainId for ${lane.chain}`,
          });
          continue;
        }

        if (lane.providerContracts.cctp !== null) {
          const cctp = lane.providerContracts.cctp;
          const hasMessenger = await probes.hasEvmContractCode(
            lane.rpcUrl,
            cctp.tokenMessengerV2,
            signal,
          );
          if (!hasMessenger) {
            violations.push({
              fieldPath: `$.verification.lanes[chain=${lane.chain}].providerContracts.cctp.tokenMessengerV2`,
              envVar,
              expected: `deployed bytecode at ${cctp.tokenMessengerV2}`,
              actual: "0x (empty code)",
              problem: `CCTP TokenMessengerV2 provider contract missing on ${lane.chain}`,
            });
          }
          const hasTransmitter = await probes.hasEvmContractCode(
            lane.rpcUrl,
            cctp.messageTransmitterV2,
            signal,
          );
          if (!hasTransmitter) {
            violations.push({
              fieldPath: `$.verification.lanes[chain=${lane.chain}].providerContracts.cctp.messageTransmitterV2`,
              envVar,
              expected: `deployed bytecode at ${cctp.messageTransmitterV2}`,
              actual: "0x (empty code)",
              problem: `CCTP MessageTransmitterV2 provider contract missing on ${lane.chain}`,
            });
          }
        }

        if (lane.providerContracts.axelar !== null) {
          const axelar = lane.providerContracts.axelar;
          const hasIts = await probes.hasEvmContractCode(
            lane.rpcUrl,
            axelar.interchainTokenService,
            signal,
          );
          if (!hasIts) {
            violations.push({
              fieldPath: `$.verification.lanes[chain=${lane.chain}].providerContracts.axelar.interchainTokenService`,
              envVar,
              expected: `deployed bytecode at ${axelar.interchainTokenService}`,
              actual: "0x (empty code)",
              problem: `Axelar InterchainTokenService provider contract missing on ${lane.chain}`,
            });
          }
        }
      } catch (error) {
        handleProbeError(
          `$.verification.lanes[chain=${lane.chain}].rpcUrl`,
          envVar,
          `chainId ${String(lane.chainId)}`,
          error,
        );
      }
    }
  }

  if (violations.length > 0) {
    throw new NetworkAdmissionError(violations);
  }

  return {
    admitted: true,
    network: config.network,
    destinationOnlyMode: config.admission.destinationOnlyMode,
    checkedStellarChain,
    checkedEvmRouters,
    checkedDestinationLanes,
    transientProbeWarnings,
  };
}
