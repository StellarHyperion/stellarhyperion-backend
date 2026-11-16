import {
  chainsFor,
  isStellarDeployment,
  ROUTE_KINDS,
  ROUTE_SLUGS,
  RouteKind,
  type ChainKey,
  type RouteSlug,
} from "@hyperion/protocol";
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  nativeToScVal,
  rpc,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import type { Logger } from "pino";
import type { AppConfig } from "../config/config.js";
import type {
  AdapterTtlCoverage,
  MaintainedAdapterRecord,
  MaintenanceInspector,
  MaintenanceResourceBounds,
  MeasuredSorobanResources,
  PlannedAdapterRecord,
  UncoveredAdapterRecord,
} from "./types.js";

export const DEFAULT_MAINTENANCE_RESOURCE_BOUNDS: MaintenanceResourceBounds = {
  maxCpuInstructions: 100_000_000,
  maxReadBytes: 200_000,
  maxWriteBytes: 131_072,
  maxResourceFeeStroops: 10_000_000n,
  maxFootprintKeys: 128,
};

export interface AdapterPeerTarget {
  readonly chain: ChainKey;
  readonly cctpDomain: number | null;
  readonly axelarName: string | null;
}

export interface AdapterMaintenanceTarget {
  readonly routeKind: RouteKind;
  readonly route: RouteSlug;
  readonly contractId: string;
  readonly tokens: readonly string[];
  readonly peers: readonly AdapterPeerTarget[];
}

export interface MatchedAdapterMethod {
  readonly methodName: string;
  readonly tokens: readonly string[];
  readonly peers: readonly ChainKey[];
  readonly buildArgs: (sender: string) => xdr.ScVal[];
}

const SUPPORTED_ADAPTER_METHODS = ["keep_alive", "extend_ttl"] as const;
const CALLER_INPUT_NAMES = new Set(["caller", "sender", "keeper", "operator"]);
const TOKEN_INPUT_NAMES = new Set(["tokens", "assets", "token_ids", "sacs"]);
const PEER_INPUT_NAMES = new Set([
  "peers",
  "domains",
  "peer_domains",
  "peer_chains",
  "chains",
  "destinations",
]);

export function resolveResourceBounds(
  overrides?: Partial<MaintenanceResourceBounds>,
): MaintenanceResourceBounds {
  return {
    maxCpuInstructions:
      overrides?.maxCpuInstructions ?? DEFAULT_MAINTENANCE_RESOURCE_BOUNDS.maxCpuInstructions,
    maxReadBytes: overrides?.maxReadBytes ?? DEFAULT_MAINTENANCE_RESOURCE_BOUNDS.maxReadBytes,
    maxWriteBytes: overrides?.maxWriteBytes ?? DEFAULT_MAINTENANCE_RESOURCE_BOUNDS.maxWriteBytes,
    maxResourceFeeStroops:
      overrides?.maxResourceFeeStroops ?? DEFAULT_MAINTENANCE_RESOURCE_BOUNDS.maxResourceFeeStroops,
    maxFootprintKeys:
      overrides?.maxFootprintKeys ?? DEFAULT_MAINTENANCE_RESOURCE_BOUNDS.maxFootprintKeys,
  };
}

export function extractSimulationResources(
  sim: rpc.Api.SimulateTransactionSuccessResponse,
): MeasuredSorobanResources {
  const txData = sim.transactionData.build();
  const cpuInstructions = txData.resources.instructions;
  const readBytes = txData.resources.diskReadBytes;
  const writeBytes = txData.resources.writeBytes;
  const readOnlyKeys = txData.resources.footprint.readOnly.length;
  const readWriteKeys = txData.resources.footprint.readWrite.length;
  const footprintKeys = readOnlyKeys + readWriteKeys;
  const minResourceFeeStroops = String(BigInt(sim.minResourceFee));
  return {
    cpuInstructions,
    readBytes,
    writeBytes,
    minResourceFeeStroops,
    readOnlyKeys,
    readWriteKeys,
    footprintKeys,
  };
}

export function validateMeasuredResources(
  measured: MeasuredSorobanResources | null | undefined,
  bounds: MaintenanceResourceBounds,
):
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "unmeasured_resources" | "resource_bounds_exceeded";
      readonly detail: string;
    } {
  if (!measured) {
    return {
      ok: false,
      code: "unmeasured_resources",
      detail: "Simulation did not produce measured Soroban resource metrics.",
    };
  }
  const numericFields = [
    measured.cpuInstructions,
    measured.readBytes,
    measured.writeBytes,
    measured.readOnlyKeys,
    measured.readWriteKeys,
    measured.footprintKeys,
  ];
  if (
    numericFields.some((value) => !Number.isFinite(value) || !Number.isInteger(value) || value < 0)
  ) {
    return {
      ok: false,
      code: "unmeasured_resources",
      detail: "Measured Soroban resource metrics contain non-finite or negative values.",
    };
  }
  if (measured.footprintKeys !== measured.readOnlyKeys + measured.readWriteKeys) {
    return {
      ok: false,
      code: "unmeasured_resources",
      detail: "Measured footprint key total does not match readOnly plus readWrite key counts.",
    };
  }
  if (measured.footprintKeys <= 0) {
    return {
      ok: false,
      code: "unmeasured_resources",
      detail: "Measured Soroban footprint is empty; refusing maintenance without target keys.",
    };
  }
  let feeStroops: bigint;
  try {
    feeStroops = BigInt(measured.minResourceFeeStroops);
  } catch {
    return {
      ok: false,
      code: "unmeasured_resources",
      detail: "Measured minimum resource fee is not a valid integer string.",
    };
  }
  if (feeStroops < 0n) {
    return {
      ok: false,
      code: "unmeasured_resources",
      detail: "Measured minimum resource fee cannot be negative.",
    };
  }
  const violations: string[] = [];
  if (measured.cpuInstructions > bounds.maxCpuInstructions) {
    violations.push(`cpuInstructions ${measured.cpuInstructions} > ${bounds.maxCpuInstructions}`);
  }
  if (measured.readBytes > bounds.maxReadBytes) {
    violations.push(`readBytes ${measured.readBytes} > ${bounds.maxReadBytes}`);
  }
  if (measured.writeBytes > bounds.maxWriteBytes) {
    violations.push(`writeBytes ${measured.writeBytes} > ${bounds.maxWriteBytes}`);
  }
  if (feeStroops > bounds.maxResourceFeeStroops) {
    violations.push(
      `minResourceFeeStroops ${String(feeStroops)} > ${String(bounds.maxResourceFeeStroops)}`,
    );
  }
  if (measured.footprintKeys > bounds.maxFootprintKeys) {
    violations.push(`footprintKeys ${measured.footprintKeys} > ${bounds.maxFootprintKeys}`);
  }
  if (violations.length > 0) {
    return {
      ok: false,
      code: "resource_bounds_exceeded",
      detail: `Simulation resource bounds exceeded: ${violations.join(", ")}.`,
    };
  }
  return { ok: true };
}

export function discoverAdapterTargets(config: AppConfig): readonly AdapterMaintenanceTarget[] {
  const stellar = config.indexer.stellar;
  if (!stellar) return [];
  const deployment = config.deployments.networks[stellar.chain];
  if (!deployment || !isStellarDeployment(deployment)) return [];

  const candidatePeers = chainsFor(config.network).filter((peer) => peer.family !== "stellar");
  const deployedPeerKeys = new Set<ChainKey>();
  for (const [key, netDeployment] of Object.entries(config.deployments.networks)) {
    if (netDeployment.family !== "stellar") {
      deployedPeerKeys.add(key as ChainKey);
    }
  }
  const activePeers =
    deployedPeerKeys.size > 0
      ? candidatePeers.filter((peer) => deployedPeerKeys.has(peer.key))
      : candidatePeers;

  const targets: AdapterMaintenanceTarget[] = [];
  for (const routeKind of ROUTE_KINDS) {
    const contractId = deployment.adapters[routeKind];
    if (!contractId) continue;
    const tokens = Object.values(deployment.tokens)
      .filter((token) => token.routes.includes(routeKind))
      .map((token) => token.sacId)
      .sort();
    const peers = activePeers
      .filter((peer) => {
        if (routeKind === RouteKind.Cctp) return peer.cctpDomain !== null;
        if (routeKind === RouteKind.AxelarIts || routeKind === RouteKind.AxelarGmp) {
          return peer.axelarName !== null;
        }
        return true;
      })
      .map((peer) => ({
        chain: peer.key,
        cctpDomain: peer.cctpDomain,
        axelarName: peer.axelarName,
      }));
    targets.push({
      routeKind,
      route: ROUTE_SLUGS[routeKind],
      contractId,
      tokens,
      peers,
    });
  }
  return targets;
}

function isVecType(typeName: string): boolean {
  return typeName === "Vec" || typeName.startsWith("Vec<");
}

function encodePeersVector(
  inputName: string,
  inputType: string,
  target: AdapterMaintenanceTarget,
): { readonly values: xdr.ScVal[]; readonly chains: readonly ChainKey[] } | null {
  const normalizedName = inputName.toLowerCase();
  const wantsDomains =
    inputType === "Vec<U32>" ||
    normalizedName.includes("domain") ||
    (inputType === "Vec" && target.routeKind === RouteKind.Cctp && normalizedName === "peers");
  if (wantsDomains) {
    const domains: xdr.ScVal[] = [];
    const chains: ChainKey[] = [];
    for (const peer of target.peers) {
      if (peer.cctpDomain === null) return null;
      domains.push(nativeToScVal(peer.cctpDomain, { type: "u32" }));
      chains.push(peer.chain);
    }
    return { values: domains, chains };
  }
  if (inputType !== "Vec" && inputType !== "Vec<String>" && inputType !== "Vec<Symbol>") {
    return null;
  }
  const asSymbol = inputType === "Vec<Symbol>";
  const values: xdr.ScVal[] = [];
  const chains: ChainKey[] = [];
  for (const peer of target.peers) {
    const label =
      target.routeKind === RouteKind.AxelarIts || target.routeKind === RouteKind.AxelarGmp
        ? (peer.axelarName ?? peer.chain)
        : peer.chain;
    values.push(asSymbol ? xdr.ScVal.scvSymbol(label) : nativeToScVal(label, { type: "string" }));
    chains.push(peer.chain);
  }
  return { values, chains };
}

export function matchAdapterMaintenanceMethod(
  methods: readonly rpc.Api.ContractMethod[],
  target: AdapterMaintenanceTarget,
): MatchedAdapterMethod | null {
  for (const candidateName of SUPPORTED_ADAPTER_METHODS) {
    const method = methods.find((entry) => entry.name === candidateName);
    if (!method) continue;
    if (method.inputs.length === 0) {
      return {
        methodName: method.name,
        tokens: [],
        peers: [],
        buildArgs: () => [],
      };
    }

    const builders: ((sender: string) => xdr.ScVal)[] = [];
    let coveredTokens: readonly string[] = [];
    let coveredPeers: readonly ChainKey[] = [];
    let usedCaller = false;
    let usedTokens = false;
    let usedPeers = false;
    let compatible = true;

    for (const [index, input] of method.inputs.entries()) {
      const lowerName = input.name.toLowerCase();
      if (
        input.type === "Address" &&
        CALLER_INPUT_NAMES.has(lowerName) &&
        index === 0 &&
        !usedCaller
      ) {
        usedCaller = true;
        builders.push((sender) => new Address(sender).toScVal());
        continue;
      }
      if (
        (input.type === "Vec" || input.type === "Vec<Address>") &&
        TOKEN_INPUT_NAMES.has(lowerName) &&
        !usedTokens
      ) {
        usedTokens = true;
        coveredTokens = target.tokens;
        const tokenScVals = target.tokens.map((sacId) => new Address(sacId).toScVal());
        builders.push(() => xdr.ScVal.scvVec(tokenScVals));
        continue;
      }
      if (isVecType(input.type) && PEER_INPUT_NAMES.has(lowerName) && !usedPeers) {
        const encodedPeers = encodePeersVector(lowerName, input.type, target);
        if (!encodedPeers) {
          compatible = false;
          break;
        }
        usedPeers = true;
        coveredPeers = encodedPeers.chains;
        const peerScVals = encodedPeers.values;
        builders.push(() => xdr.ScVal.scvVec(peerScVals));
        continue;
      }
      compatible = false;
      break;
    }

    if (compatible) {
      return {
        methodName: method.name,
        tokens: coveredTokens,
        peers: coveredPeers,
        buildArgs: (sender) => builders.map((buildArg) => buildArg(sender)),
      };
    }
  }
  return null;
}

export function verifyRouterMaintenanceMethod(methods: readonly rpc.Api.ContractMethod[]): boolean {
  const keepAlive = methods.find((entry) => entry.name === "keep_alive");
  if (keepAlive?.inputs.length !== 4) return false;
  return keepAlive.inputs.every((input) => isVecType(input.type));
}

export function createRpcMaintenanceInspector(config: AppConfig): MaintenanceInspector {
  const chain = config.indexer.stellar;
  if (!chain) {
    throw new Error("A Stellar deployment is required to create an RPC maintenance inspector.");
  }
  const deployment = config.deployments.networks[chain.chain];
  const fallbackSource =
    deployment && isStellarDeployment(deployment) ? deployment.admin : undefined;
  const client = new rpc.Server(chain.rpcUrl, { timeout: 15_000 });

  return {
    async getContractMethods(contractId: string): Promise<readonly rpc.Api.ContractMethod[]> {
      return client.getContractMethods(contractId, chain.networkPassphrase);
    },
    async measureCall(
      contractId: string,
      method: string,
      args: (sender: string) => xdr.ScVal[],
    ): Promise<MeasuredSorobanResources> {
      if ((await client.getNetwork()).passphrase !== chain.networkPassphrase) {
        throw new Error("Keeper RPC network mismatch.");
      }
      const sourcePublicKey = config.keeper.stellarSecret
        ? Keypair.fromSecret(config.keeper.stellarSecret).publicKey()
        : fallbackSource;
      if (!sourcePublicKey) {
        throw new Error("No Stellar public account available to simulate maintenance.");
      }
      let account: Account;
      try {
        account = await client.getAccount(sourcePublicKey);
      } catch {
        account = new Account(sourcePublicKey, "0");
      }
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: chain.networkPassphrase,
      })
        .addOperation(new Contract(contractId).call(method, ...args(sourcePublicKey)))
        .setTimeout(120)
        .build();
      const sim = await client.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) {
        throw new Error(`Simulation failed for ${contractId}.${method}: ${sim.error}`);
      }
      if (rpc.Api.isSimulationRestore(sim)) {
        throw new Error(
          `Simulation for ${contractId}.${method} requires ledger entry restoration before upkeep.`,
        );
      }
      return extractSimulationResources(sim);
    },
  };
}

export interface AdapterExecutionInput {
  readonly targets: readonly AdapterMaintenanceTarget[];
  readonly inspector?: MaintenanceInspector | undefined;
  readonly bounds: MaintenanceResourceBounds;
  readonly dryRun: boolean;
  readonly includeAdapters: boolean;
  readonly logger: Logger;
  readonly submitAdapterCall: (
    contractId: string,
    method: string,
    args: (sender: string) => xdr.ScVal[],
  ) => Promise<string>;
}

export async function planAndExecuteAdapterMaintenance(
  input: AdapterExecutionInput,
): Promise<AdapterTtlCoverage> {
  const { targets, inspector, bounds, dryRun, includeAdapters, logger, submitAdapterCall } = input;
  if (targets.length === 0) {
    return {
      configuredCount: 0,
      maintainedCount: 0,
      uncoveredCount: 0,
      maintainedAdapters: [],
      uncoveredAdapters: [],
      plannedAdapters: [],
    };
  }

  const maintainedAdapters: MaintainedAdapterRecord[] = [];
  const uncoveredAdapters: UncoveredAdapterRecord[] = [];
  const plannedAdapters: PlannedAdapterRecord[] = [];

  if (!includeAdapters || !inspector) {
    for (const target of targets) {
      uncoveredAdapters.push({
        route: target.route,
        contractId: target.contractId,
        reason: "unverified_contract_interface",
        detail: includeAdapters
          ? "No contract maintenance inspector configured; adapter contract interface was not verified."
          : "Adapter maintenance inspection disabled for this run.",
      });
    }
    return {
      configuredCount: targets.length,
      maintainedCount: 0,
      uncoveredCount: uncoveredAdapters.length,
      maintainedAdapters,
      uncoveredAdapters,
      plannedAdapters,
    };
  }

  for (const target of targets) {
    let methods: readonly rpc.Api.ContractMethod[];
    try {
      methods = await inspector.getContractMethods(target.contractId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        { route: target.route, contractId: target.contractId, err: error },
        "failed to inspect adapter contract methods",
      );
      uncoveredAdapters.push({
        route: target.route,
        contractId: target.contractId,
        reason: "contract_inspection_failed",
        detail: `Contract spec lookup failed: ${message}`,
      });
      continue;
    }

    const matched = matchAdapterMaintenanceMethod(methods, target);
    if (!matched) {
      uncoveredAdapters.push({
        route: target.route,
        contractId: target.contractId,
        reason: "unsupported_maintenance_entrypoint",
        detail: `Adapter contract exposes [${methods.map((m) => m.name).join(", ")}], none matching a supported maintenance entrypoint.`,
      });
      continue;
    }

    let measured: MeasuredSorobanResources;
    try {
      measured = await inspector.measureCall(
        target.contractId,
        matched.methodName,
        matched.buildArgs,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        {
          route: target.route,
          contractId: target.contractId,
          method: matched.methodName,
          err: error,
        },
        "adapter maintenance simulation failed",
      );
      uncoveredAdapters.push({
        route: target.route,
        contractId: target.contractId,
        reason: "simulation_failed",
        detail: message,
      });
      continue;
    }

    const validation = validateMeasuredResources(measured, bounds);
    if (!validation.ok) {
      logger.warn(
        {
          route: target.route,
          contractId: target.contractId,
          method: matched.methodName,
          detail: validation.detail,
        },
        "adapter maintenance rejected by resource bounds check",
      );
      uncoveredAdapters.push({
        route: target.route,
        contractId: target.contractId,
        reason: validation.code,
        detail: validation.detail,
      });
      continue;
    }

    if (dryRun) {
      plannedAdapters.push({
        route: target.route,
        contractId: target.contractId,
        method: matched.methodName,
        tokens: matched.tokens,
        peers: matched.peers,
        footprintKeys: measured.footprintKeys,
        measuredResources: measured,
      });
      continue;
    }

    try {
      const txHash = await submitAdapterCall(
        target.contractId,
        matched.methodName,
        matched.buildArgs,
      );
      logger.info(
        {
          route: target.route,
          contractId: target.contractId,
          method: matched.methodName,
          footprintKeys: measured.footprintKeys,
          hash: txHash,
        },
        "adapter maintenance confirmed",
      );
      maintainedAdapters.push({
        route: target.route,
        contractId: target.contractId,
        method: matched.methodName,
        tokens: matched.tokens,
        peers: matched.peers,
        footprintKeys: measured.footprintKeys,
        readOnlyKeys: measured.readOnlyKeys,
        readWriteKeys: measured.readWriteKeys,
        measuredResources: measured,
        txHash,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        {
          route: target.route,
          contractId: target.contractId,
          method: matched.methodName,
          err: error,
        },
        "adapter maintenance submission failed",
      );
      uncoveredAdapters.push({
        route: target.route,
        contractId: target.contractId,
        reason: "submission_failed",
        detail: message,
      });
    }
  }

  return {
    configuredCount: targets.length,
    maintainedCount: maintainedAdapters.length,
    uncoveredCount: uncoveredAdapters.length,
    maintainedAdapters,
    uncoveredAdapters,
    plannedAdapters,
  };
}
