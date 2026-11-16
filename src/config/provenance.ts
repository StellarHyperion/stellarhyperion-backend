import { createHash } from "node:crypto";

import type { ChainKey, DeploymentSet, NetworkMode } from "@hyperion/protocol";
import { CHAINS, isEvmDeployment, isStellarDeployment } from "@hyperion/protocol";

import type {
  EvmWatchConfig,
  IndexerConfig,
  KeeperConfig,
  LogLevel,
  NodeEnv,
  RailsConfig,
} from "./config.js";
import { envSuffixFor } from "./config.js";
import type { EnvReader } from "./env.js";

export type SettingSource = "default" | "env" | "deployment" | "registry";

export interface EffectiveSettingEntry {
  readonly key: string;
  readonly envVar: string | null;
  readonly source: SettingSource;
  readonly value: string | number | boolean | readonly string[] | null;
}

export interface SecretPresenceEntry {
  readonly name: "DATABASE_URL" | "REDIS_URL" | "KEEPER_STELLAR_SECRET";
  readonly configured: boolean;
  readonly source: "env" | "unset";
}

export type OverrideKind =
  "shadowed_env" | "deployment_override" | "inactive_subsystem_override" | "unused_chain_override";

export interface ConfigOverrideNotice {
  readonly kind: OverrideKind;
  readonly variable: string;
  readonly target: string;
  readonly detail: string;
}

export interface DeploymentChainSummary {
  readonly chain: ChainKey;
  readonly family: "stellar" | "evm";
  readonly router: string;
  readonly commit: string;
  readonly deployedHeight: string;
  readonly deployedTimestamp: string;
}

export interface DeploymentRevisionSummary {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly network: NetworkMode;
  readonly hasStellarRouter: boolean;
  readonly hasEvmRouter: boolean;
  readonly chains: readonly DeploymentChainSummary[];
}

export interface ConfigProvenanceReport {
  readonly effectiveDigest: string;
  readonly network: NetworkMode;
  readonly deploymentRevision: DeploymentRevisionSummary;
  readonly settings: readonly EffectiveSettingEntry[];
  readonly secrets: readonly SecretPresenceEntry[];
  readonly conflictingOverrides: readonly ConfigOverrideNotice[];
}

export interface ProvenanceBuildInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly reader: EnvReader;
  readonly nodeEnv: NodeEnv;
  readonly logLevel: LogLevel;
  readonly http: { readonly host: string; readonly port: number };
  readonly network: NetworkMode;
  readonly deployments: DeploymentSet;
  readonly indexer: IndexerConfig;
  readonly rails: RailsConfig;
  readonly keeper: KeeperConfig;
  readonly shutdownTimeoutMs: number;
  readonly hasDatabaseUrl: boolean;
  readonly hasRedisUrl: boolean;
}

const TOKEN_PATH_PREFIXES = new Set([
  "v1",
  "v2",
  "v3",
  "apikey",
  "api-key",
  "key",
  "token",
  "secret",
  "auth",
]);

/**
 * Normalizes an HTTP(S) endpoint URL for public reporting and digest computation while
 * unconditionally stripping userinfo credentials, query parameters, fragments, and path tokens.
 */
export function sanitizePublicEndpointUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const scheme = parsed.protocol.toLowerCase();
    const hostname = parsed.hostname.toLowerCase();
    const isDefaultPort =
      (scheme === "http:" && parsed.port === "80") ||
      (scheme === "https:" && parsed.port === "443") ||
      parsed.port === "";
    const authority = isDefaultPort ? hostname : `${hostname}:${parsed.port}`;

    const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);

    const scrubbedSegments: string[] = [];
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i] ?? "";
      const prev = i > 0 ? (segments[i - 1] ?? "").toLowerCase() : "";
      const looksLikeTokenAfterPrefix = TOKEN_PATH_PREFIXES.has(prev) && seg.length >= 6;
      const looksLikeOpaqueSecret = /^[A-Za-z0-9_-]{20,}$/.test(seg);
      if (looksLikeTokenAfterPrefix || looksLikeOpaqueSecret) {
        scrubbedSegments.push("[redacted]");
      } else {
        scrubbedSegments.push(seg);
      }
    }

    const normalizedPath = scrubbedSegments.length > 0 ? `/${scrubbedSegments.join("/")}` : "";
    return `${scheme}//${authority}${normalizedPath}`;
  } catch {
    return "[invalid-url]";
  }
}

export function summarizeDeploymentRevision(
  network: NetworkMode,
  deployments: DeploymentSet,
): DeploymentRevisionSummary {
  const chains: DeploymentChainSummary[] = [];
  let hasStellarRouter = false;
  let hasEvmRouter = false;

  const sortedKeys = Object.keys(deployments.networks).sort((a, b) => a.localeCompare(b));
  for (const key of sortedKeys) {
    const chainKey = key as ChainKey;
    const entry = deployments.networks[chainKey];
    if (entry === undefined) continue;

    if (isStellarDeployment(entry)) {
      hasStellarRouter = true;
      chains.push({
        chain: chainKey,
        family: "stellar",
        router: entry.router,
        commit: entry.commit,
        deployedHeight: String(entry.deployedAt.ledger),
        deployedTimestamp: entry.deployedAt.timestamp,
      });
    } else if (isEvmDeployment(entry)) {
      hasEvmRouter = true;
      chains.push({
        chain: chainKey,
        family: "evm",
        router: entry.router,
        commit: entry.commit,
        deployedHeight: entry.deployedAt.blockNumber,
        deployedTimestamp: entry.deployedAt.timestamp,
      });
    }
  }

  return {
    schemaVersion: deployments.schemaVersion,
    generatedAt: deployments.generatedAt,
    network,
    hasStellarRouter,
    hasEvmRouter,
    chains,
  };
}

function sourceFromReader(reader: EnvReader, varName: string): "env" | "default" {
  return reader.originOf(varName) === "env" ? "env" : "default";
}

function detectConflictingOverrides(input: ProvenanceBuildInput): ConfigOverrideNotice[] {
  const notices: ConfigOverrideNotice[] = [];
  const { env, reader, deployments, indexer, rails, keeper } = input;

  const deployedEvmChains = new Set<string>(indexer.evm.map((item) => item.chain));
  const suffixToChain = new Map<string, ChainKey>();
  for (const key of Object.keys(CHAINS) as ChainKey[]) {
    suffixToChain.set(envSuffixFor(key), key);
  }

  // 1. Shadowed per-chain RPC overrides and unused chain RPC overrides.
  const envKeys = Object.keys(env).sort((a, b) => a.localeCompare(b));
  for (const envKey of envKeys) {
    if (!reader.has(envKey)) continue;

    if (envKey.startsWith("EVM_RPC_URL_")) {
      const suffix = envKey.slice("EVM_RPC_URL_".length);
      const chain = suffixToChain.get(suffix);
      const pluralKey = `EVM_RPC_URLS_${suffix}`;
      if (chain !== undefined && deployedEvmChains.has(chain) && reader.has(pluralKey)) {
        notices.push({
          kind: "shadowed_env",
          variable: envKey,
          target: `indexer.evm.${chain}.rpcUrls`,
          detail: `Shadowed by ${pluralKey}, which takes precedence when both are set.`,
        });
      }
      if (chain === undefined || !deployedEvmChains.has(chain)) {
        notices.push({
          kind: "unused_chain_override",
          variable: envKey,
          target: "indexer.evm",
          detail:
            chain !== undefined
              ? `Set in environment, but active deployment record has no EVM router for ${chain}.`
              : "Set in environment, but does not match any deployed EVM router chain.",
        });
      }
    } else if (envKey.startsWith("EVM_RPC_URLS_")) {
      const suffix = envKey.slice("EVM_RPC_URLS_".length);
      const chain = suffixToChain.get(suffix);
      if (chain === undefined || !deployedEvmChains.has(chain)) {
        notices.push({
          kind: "unused_chain_override",
          variable: envKey,
          target: "indexer.evm",
          detail:
            chain !== undefined
              ? `Set in environment, but active deployment record has no EVM router for ${chain}.`
              : "Set in environment, but does not match any deployed EVM router chain.",
        });
      }
    }
  }

  // 2. Environment overrides superseding deployment record / registry metadata.
  if (indexer.stellar !== null && reader.has("STELLAR_START_LEDGER")) {
    const stellarDeployment = deployments.networks[indexer.stellar.chain];
    const deployedLedger =
      stellarDeployment !== undefined && isStellarDeployment(stellarDeployment)
        ? stellarDeployment.deployedAt.ledger
        : null;
    if (deployedLedger !== null && deployedLedger !== indexer.stellar.startLedger) {
      notices.push({
        kind: "deployment_override",
        variable: "STELLAR_START_LEDGER",
        target: "indexer.stellar.startLedger",
        detail: `Overrides deployment record ledger ${deployedLedger} with ${indexer.stellar.startLedger}.`,
      });
    }
  }

  if (indexer.evm.length > 0 && reader.has("EVM_REORG_DEPTH_BLOCKS")) {
    for (const evmChain of indexer.evm) {
      const registryConfirmations = evmChain.confirmations;
      if (evmChain.reorgDepth !== registryConfirmations) {
        notices.push({
          kind: "deployment_override",
          variable: "EVM_REORG_DEPTH_BLOCKS",
          target: `indexer.evm.${evmChain.chain}.reorgDepth`,
          detail: `Overrides chain registry confirmation depth ${registryConfirmations} with ${evmChain.reorgDepth}.`,
        });
      }
    }
  }

  // 3. Overrides supplied for disabled subsystems.
  if (!indexer.enabled) {
    const indexerVars = [
      "STELLAR_RPC_URL",
      "STELLAR_START_LEDGER",
      "STELLAR_EVENT_PAGE_SIZE",
      "STELLAR_POLL_INTERVAL_MS",
      "EVM_POLL_INTERVAL_MS",
      "EVM_LOG_RANGE",
      "EVM_REORG_DEPTH_BLOCKS",
      ...envKeys.filter((key) => key.startsWith("EVM_RPC_URL_") || key.startsWith("EVM_RPC_URLS_")),
    ];
    for (const variable of indexerVars) {
      if (reader.has(variable)) {
        notices.push({
          kind: "inactive_subsystem_override",
          variable,
          target: "indexer",
          detail: "Set in environment while INDEXER_ENABLED is false.",
        });
      }
    }
  }

  if (!rails.enabled) {
    const railVars = [
      "IRIS_API_URL",
      "AXELAR_API_URL",
      "RAIL_POLL_INTERVAL_MS",
      "RAIL_BATCH_SIZE",
      "RAIL_RECHECK_AFTER_MS",
      "RAIL_MAX_CHECK_FAILURES",
    ];
    for (const variable of railVars) {
      if (reader.has(variable)) {
        notices.push({
          kind: "inactive_subsystem_override",
          variable,
          target: "rails",
          detail: "Set in environment while RAILS_ENABLED is false.",
        });
      }
    }
  }

  if (!keeper.enabled) {
    const keeperVars = ["KEEPER_POLL_INTERVAL_MS", "KEEPER_CONCURRENCY", "KEEPER_STELLAR_SECRET"];
    for (const variable of keeperVars) {
      if (reader.has(variable)) {
        notices.push({
          kind: "inactive_subsystem_override",
          variable,
          target: "keeper",
          detail: "Set in environment while KEEPER_ENABLED is false.",
        });
      }
    }
  }

  return notices;
}

function buildEvmChainSettings(
  reader: EnvReader,
  evmConfig: EvmWatchConfig,
): EffectiveSettingEntry[] {
  const suffix = envSuffixFor(evmConfig.chain);
  const urlsVar = `EVM_RPC_URLS_${suffix}`;
  const urlVar = `EVM_RPC_URL_${suffix}`;
  const sanitizedUrls = evmConfig.rpcUrls.map((item) => sanitizePublicEndpointUrl(item));
  const rpcSource: SettingSource = reader.has(urlsVar) || reader.has(urlVar) ? "env" : "registry";
  const rpcEnvVar = reader.has(urlsVar) ? urlsVar : reader.has(urlVar) ? urlVar : null;

  return [
    {
      key: `indexer.evm.${evmConfig.chain}.routerAddress`,
      envVar: "HYPERION_DEPLOYMENTS_FILE",
      source: "deployment",
      value: evmConfig.routerAddress,
    },
    {
      key: `indexer.evm.${evmConfig.chain}.startBlock`,
      envVar: "HYPERION_DEPLOYMENTS_FILE",
      source: "deployment",
      value: evmConfig.startBlock.toString(),
    },
    {
      key: `indexer.evm.${evmConfig.chain}.confirmations`,
      envVar: null,
      source: "registry",
      value: evmConfig.confirmations,
    },
    {
      key: `indexer.evm.${evmConfig.chain}.reorgDepth`,
      envVar: reader.has("EVM_REORG_DEPTH_BLOCKS") ? "EVM_REORG_DEPTH_BLOCKS" : null,
      source: reader.has("EVM_REORG_DEPTH_BLOCKS") ? "env" : "registry",
      value: evmConfig.reorgDepth,
    },
    {
      key: `indexer.evm.${evmConfig.chain}.rpcUrls`,
      envVar: rpcEnvVar,
      source: rpcSource,
      value: sanitizedUrls,
    },
    {
      key: `indexer.evm.${evmConfig.chain}.logRange`,
      envVar: "EVM_LOG_RANGE",
      source: sourceFromReader(reader, "EVM_LOG_RANGE"),
      value: evmConfig.logRange,
    },
    {
      key: `indexer.evm.${evmConfig.chain}.pollIntervalMs`,
      envVar: "EVM_POLL_INTERVAL_MS",
      source: sourceFromReader(reader, "EVM_POLL_INTERVAL_MS"),
      value: evmConfig.pollIntervalMs,
    },
  ];
}

export function buildConfigProvenanceReport(input: ProvenanceBuildInput): ConfigProvenanceReport {
  const { reader } = input;
  const deploymentRevision = summarizeDeploymentRevision(input.network, input.deployments);

  const settings: EffectiveSettingEntry[] = [
    {
      key: "nodeEnv",
      envVar: "NODE_ENV",
      source: sourceFromReader(reader, "NODE_ENV"),
      value: input.nodeEnv,
    },
    {
      key: "logLevel",
      envVar: "LOG_LEVEL",
      source: sourceFromReader(reader, "LOG_LEVEL"),
      value: input.logLevel,
    },
    {
      key: "http.host",
      envVar: "HTTP_HOST",
      source: sourceFromReader(reader, "HTTP_HOST"),
      value: input.http.host,
    },
    {
      key: "http.port",
      envVar: "HTTP_PORT",
      source: sourceFromReader(reader, "HTTP_PORT"),
      value: input.http.port,
    },
    {
      key: "network",
      envVar: "HYPERION_NETWORK",
      source: sourceFromReader(reader, "HYPERION_NETWORK"),
      value: input.network,
    },
    {
      key: "shutdownTimeoutMs",
      envVar: "SHUTDOWN_TIMEOUT_MS",
      source: sourceFromReader(reader, "SHUTDOWN_TIMEOUT_MS"),
      value: input.shutdownTimeoutMs,
    },
    {
      key: "indexer.enabled",
      envVar: "INDEXER_ENABLED",
      source: sourceFromReader(reader, "INDEXER_ENABLED"),
      value: input.indexer.enabled,
    },
  ];

  if (input.indexer.stellar !== null) {
    const stellar = input.indexer.stellar;
    settings.push(
      {
        key: "indexer.stellar.chain",
        envVar: "HYPERION_DEPLOYMENTS_FILE",
        source: "deployment",
        value: stellar.chain,
      },
      {
        key: "indexer.stellar.routerContractId",
        envVar: "HYPERION_DEPLOYMENTS_FILE",
        source: "deployment",
        value: stellar.routerContractId,
      },
      {
        key: "indexer.stellar.rpcUrl",
        envVar: reader.has("STELLAR_RPC_URL") ? "STELLAR_RPC_URL" : null,
        source: reader.has("STELLAR_RPC_URL") ? "env" : "registry",
        value: sanitizePublicEndpointUrl(stellar.rpcUrl),
      },
      {
        key: "indexer.stellar.startLedger",
        envVar: reader.has("STELLAR_START_LEDGER")
          ? "STELLAR_START_LEDGER"
          : "HYPERION_DEPLOYMENTS_FILE",
        source: reader.has("STELLAR_START_LEDGER") ? "env" : "deployment",
        value: stellar.startLedger,
      },
      {
        key: "indexer.stellar.pageSize",
        envVar: "STELLAR_EVENT_PAGE_SIZE",
        source: sourceFromReader(reader, "STELLAR_EVENT_PAGE_SIZE"),
        value: stellar.pageSize,
      },
      {
        key: "indexer.stellar.pollIntervalMs",
        envVar: "STELLAR_POLL_INTERVAL_MS",
        source: sourceFromReader(reader, "STELLAR_POLL_INTERVAL_MS"),
        value: stellar.pollIntervalMs,
      },
    );
  }

  for (const evmChain of input.indexer.evm) {
    settings.push(...buildEvmChainSettings(reader, evmChain));
  }

  settings.push(
    {
      key: "rails.enabled",
      envVar: "RAILS_ENABLED",
      source: sourceFromReader(reader, "RAILS_ENABLED"),
      value: input.rails.enabled,
    },
    {
      key: "rails.irisUrl",
      envVar: reader.has("IRIS_API_URL") ? "IRIS_API_URL" : null,
      source: reader.has("IRIS_API_URL") ? "env" : "registry",
      value: sanitizePublicEndpointUrl(input.rails.irisUrl),
    },
    {
      key: "rails.axelarUrl",
      envVar: reader.has("AXELAR_API_URL") ? "AXELAR_API_URL" : null,
      source: reader.has("AXELAR_API_URL") ? "env" : "default",
      value: sanitizePublicEndpointUrl(input.rails.axelarUrl),
    },
    {
      key: "rails.pollIntervalMs",
      envVar: "RAIL_POLL_INTERVAL_MS",
      source: sourceFromReader(reader, "RAIL_POLL_INTERVAL_MS"),
      value: input.rails.pollIntervalMs,
    },
    {
      key: "rails.batchSize",
      envVar: "RAIL_BATCH_SIZE",
      source: sourceFromReader(reader, "RAIL_BATCH_SIZE"),
      value: input.rails.batchSize,
    },
    {
      key: "rails.recheckAfterMs",
      envVar: "RAIL_RECHECK_AFTER_MS",
      source: sourceFromReader(reader, "RAIL_RECHECK_AFTER_MS"),
      value: input.rails.recheckAfterMs,
    },
    {
      key: "rails.maxCheckFailures",
      envVar: "RAIL_MAX_CHECK_FAILURES",
      source: sourceFromReader(reader, "RAIL_MAX_CHECK_FAILURES"),
      value: input.rails.maxCheckFailures,
    },
    {
      key: "keeper.enabled",
      envVar: "KEEPER_ENABLED",
      source: sourceFromReader(reader, "KEEPER_ENABLED"),
      value: input.keeper.enabled,
    },
    {
      key: "keeper.pollIntervalMs",
      envVar: "KEEPER_POLL_INTERVAL_MS",
      source: sourceFromReader(reader, "KEEPER_POLL_INTERVAL_MS"),
      value: input.keeper.pollIntervalMs,
    },
    {
      key: "keeper.concurrency",
      envVar: "KEEPER_CONCURRENCY",
      source: sourceFromReader(reader, "KEEPER_CONCURRENCY"),
      value: input.keeper.concurrency,
    },
    {
      key: "keeper.executionMode",
      envVar: reader.has("KEEPER_STELLAR_SECRET") ? "KEEPER_STELLAR_SECRET" : null,
      source: reader.has("KEEPER_STELLAR_SECRET") ? "env" : "default",
      value: input.keeper.stellarSecret === null ? "dry-run" : "signer",
    },
  );

  const secrets: SecretPresenceEntry[] = [
    {
      name: "DATABASE_URL",
      configured: input.hasDatabaseUrl,
      source: reader.has("DATABASE_URL") ? "env" : "unset",
    },
    {
      name: "REDIS_URL",
      configured: input.hasRedisUrl,
      source: reader.has("REDIS_URL") ? "env" : "unset",
    },
    {
      name: "KEEPER_STELLAR_SECRET",
      configured: input.keeper.stellarSecret !== null,
      source: reader.has("KEEPER_STELLAR_SECRET") ? "env" : "unset",
    },
  ];

  const conflictingOverrides = detectConflictingOverrides(input);

  // Canonical effective state excludes provenance sources, host file paths, and raw secrets so
  // equivalent effective configurations produce the identical public digest.
  const effectiveMap: Record<string, unknown> = {};
  const sortedSettings = [...settings].sort((a, b) => a.key.localeCompare(b.key));
  for (const entry of sortedSettings) {
    effectiveMap[entry.key] = entry.value;
  }

  const canonicalPayload = JSON.stringify({
    deploymentRevision,
    effectiveSettings: effectiveMap,
  });
  const effectiveDigest = `sha256:${createHash("sha256").update(canonicalPayload).digest("hex")}`;

  return {
    effectiveDigest,
    network: input.network,
    deploymentRevision,
    settings,
    secrets,
    conflictingOverrides,
  };
}
