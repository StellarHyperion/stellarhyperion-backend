/**
 * The whole configuration, assembled once at startup and passed down by hand.
 *
 * No singleton, no module level mutable state, no `process.env` read anywhere below this file.
 * Everything that needs configuration takes it as an argument, which is what makes the watchers
 * testable without a process environment and what stops a second watcher in the same process
 * from quietly sharing the first one's cursor.
 *
 * Router addresses, token decimals and start heights come out of the deployment record the
 * contracts repo writes, validated by `parseDeploymentSet` from `@hyperion/protocol` rather than
 * cast. That is the point of the shared package: there is one description of where Hyperion is
 * deployed, one validator for it, and the backend is not allowed its own opinion.
 */
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import type { Chain, ChainKey, DeploymentSet, Hex, NetworkMode } from "@hyperion/protocol";
import {
  AddressKind,
  CHAINS,
  DeploymentFormatError,
  IRIS_API,
  RAIL_CONTRACTS,
  RouteKind,
  chainsFor,
  encodeStellarAddress,
  isChainKey,
  isEvmChain,
  isEvmDeployment,
  isStellarChain,
  isStellarDeployment,
  parseDeploymentSet,
  parseStellarAddress,
} from "@hyperion/protocol";

import type { EnumSpec, VarSpec } from "./env.js";
import { EnvReader } from "./env.js";

/**
 * Axelar's status API, per network.
 *
 * Named here and nowhere else because, unlike Circle's Iris, there is no entry for it in the
 * shared registry. If one is ever added there, this should be deleted rather than kept in step.
 */
const AXELARSCAN_API: Readonly<Record<NetworkMode, string>> = {
  mainnet: "https://api.gmp.axelarscan.io",
  testnet: "https://testnet.api.gmp.axelarscan.io",
};

export type NodeEnv = "development" | "test" | "production";
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/** Everything the Soroban watcher needs. One instance, because there is one Stellar per network. */
export interface StellarWatchConfig {
  readonly chain: ChainKey;
  readonly rpcUrl: string;
  readonly networkPassphrase: string;
  /** The router contract id, from the deployment record. */
  readonly routerContractId: string;
  /** The ledger the router was deployed in. Nothing before it can mention the router. */
  readonly startLedger: number;
  readonly pageSize: number;
  readonly pollIntervalMs: number;
}

/** Everything the EVM watcher needs, per chain. */
export interface EvmWatchConfig {
  readonly chain: ChainKey;
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly rpcUrls: readonly string[];
  readonly routerAddress: Hex;
  /** The block the router was deployed in, from the deployment record. */
  readonly startBlock: bigint;
  /** From the chain registry. How many blocks before a log is believed. */
  readonly confirmations: number;
  /** How far back to wind the cursor when a reorg is found below the confirmation depth. */
  readonly reorgDepth: number;
  readonly logRange: number;
  readonly pollIntervalMs: number;
}

export interface GmpAdmittedLane {
  readonly originChain: ChainKey;
  readonly destinationChain: ChainKey;
  readonly symbol: string;
  readonly originAxelarChain: string;
  readonly destinationAxelarChain: string;
  readonly originGateway: string;
  readonly destinationGateway: string;
  readonly originAdapter: string;
  readonly destinationReceiver: string;
  readonly destinationRouter: string;
  readonly originToken: string;
  readonly destinationToken: string;
  readonly originDecimals: number;
  readonly destinationDecimals: number;
}

/** Everything the rail status pollers need. One per rail that has a status API. */
export interface RailsConfig {
  readonly enabled: boolean;
  /** Circle's Iris, from the shared registry unless overridden. */
  readonly irisUrl: string;
  readonly axelarUrl: string;
  /** Admitted authenticated GMP lanes backed by deployed source adapters and destination receivers. */
  readonly gmpLanes?: readonly GmpAdmittedLane[];
  /** Non-live fixture provenance marker when the deployment file originates from a local rehearsal capture. */
  readonly fixtureProvenance?: string | null;
  readonly pollIntervalMs: number;
  readonly batchSize: number;
  readonly recheckAfterMs: number;
  readonly maxCheckFailures: number;
}

export interface IndexerConfig {
  readonly enabled: boolean;
  /** Null when the deployment record has no Stellar side for this network yet. */
  readonly stellar: StellarWatchConfig | null;
  readonly evm: readonly EvmWatchConfig[];
}

export interface KeeperConfig {
  readonly enabled: boolean;
  readonly pollIntervalMs: number;
  readonly concurrency: number;
  readonly stellarSecret: string | null;
}

export interface AppConfig {
  readonly nodeEnv: NodeEnv;
  readonly logLevel: LogLevel;
  readonly http: { readonly host: string; readonly port: number };
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly network: NetworkMode;
  readonly deploymentsFile: string;
  readonly deployments: DeploymentSet;
  readonly indexer: IndexerConfig;
  readonly rails: RailsConfig;
  readonly keeper: KeeperConfig;
  readonly shutdownTimeoutMs: number;
}

/** Injected so the unit suite can hand over a record without touching a disk or a process. */
export interface LoadOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly readFile?: (path: string) => string;
  /** Relative paths in `HYPERION_DEPLOYMENTS_FILE` resolve against this. */
  readonly cwd?: string;
}

const NODE_ENV: EnumSpec<NodeEnv> = {
  name: "NODE_ENV",
  kind: "enum",
  required: false,
  fallback: "development",
  choices: ["development", "production", "test"],
  printable: true,
  purpose: "Changes log formatting and nothing else. Behaviour is identical across all three.",
};

const LOG_LEVEL: EnumSpec<LogLevel> = {
  name: "LOG_LEVEL",
  kind: "enum",
  required: false,
  fallback: "info",
  choices: ["trace", "debug", "info", "warn", "error", "fatal"],
  printable: true,
  purpose: "The floor for pino. debug prints every RPC page the watchers read.",
};

const HTTP_HOST: VarSpec = {
  name: "HTTP_HOST",
  kind: "string",
  required: false,
  fallback: "127.0.0.1",
  printable: true,
  purpose: "What the API binds to. Loopback by default, 0.0.0.0 inside a container.",
};

const HTTP_PORT: VarSpec = {
  name: "HTTP_PORT",
  kind: "integer",
  required: false,
  fallback: "8080",
  min: 1,
  max: 65_535,
  printable: true,
  purpose: "The port the API listens on.",
};

const DATABASE_URL: VarSpec = {
  name: "DATABASE_URL",
  kind: "url",
  protocols: ["postgres", "postgresql"],
  required: true,
  printable: false,
  purpose: "Postgres connection string. docker compose publishes one on 127.0.0.1:5433.",
};

const REDIS_URL: VarSpec = {
  name: "REDIS_URL",
  kind: "url",
  protocols: ["redis", "rediss"],
  required: true,
  printable: false,
  purpose: "Redis connection for enabled keeper queues.",
};

const HYPERION_NETWORK: EnumSpec<NetworkMode> = {
  name: "HYPERION_NETWORK",
  kind: "enum",
  required: true,
  choices: ["mainnet", "testnet"],
  printable: true,
  purpose:
    "Which half of the chain registry is in play. A deployment record naming a chain from the other half is refused rather than watched.",
};

const DEPLOYMENTS_FILE: VarSpec = {
  name: "HYPERION_DEPLOYMENTS_FILE",
  kind: "string",
  required: true,
  printable: true,
  purpose:
    "Path to the deployment record the contracts repo writes. Router addresses and start heights come from it, so the watchers never guess where to begin.",
};

const INDEXER_ENABLED: VarSpec = {
  name: "INDEXER_ENABLED",
  kind: "boolean",
  required: false,
  fallback: "true",
  printable: true,
  purpose: "False runs the API without the watchers, which is what a second replica wants.",
};

const RAILS_ENABLED: VarSpec = {
  name: "RAILS_ENABLED",
  kind: "boolean",
  required: false,
  fallback: "true",
  printable: true,
  purpose:
    "False runs the watchers without the rail status pollers. The chains still answer; the part of a transfer that lives only in a rail's API stops being refreshed.",
};

const IRIS_API_URL: VarSpec = {
  name: "IRIS_API_URL",
  kind: "url",
  protocols: ["http", "https"],
  required: false,
  printable: true,
  purpose:
    "Circle's attestation API. Defaults to the chain registry's entry for this network, which is the sandbox on testnet.",
};

const AXELAR_API_URL: VarSpec = {
  name: "AXELAR_API_URL",
  kind: "url",
  protocols: ["http", "https"],
  required: false,
  printable: true,
  purpose:
    "Axelar's GMP status API. Defaults to axelarscan for this network. Unlike Iris there is no entry for it in the shared registry, so this is the only place it is named.",
};

const RAIL_POLL_INTERVAL_MS: VarSpec = {
  name: "RAIL_POLL_INTERVAL_MS",
  kind: "integer",
  required: false,
  fallback: "15000",
  min: 1_000,
  printable: true,
  purpose:
    "How often each rail is asked about the transfers waiting on it. Attestations take tens of seconds at best, so polling faster mostly asks for the same answer.",
};

const RAIL_BATCH_SIZE: VarSpec = {
  name: "RAIL_BATCH_SIZE",
  kind: "integer",
  required: false,
  fallback: "20",
  min: 1,
  max: 200,
  printable: true,
  purpose:
    "Transfers looked up per pass. Circle blocks every request for five minutes past forty a second, so this stays well under it even at the fastest interval.",
};

const RAIL_RECHECK_AFTER_MS: VarSpec = {
  name: "RAIL_RECHECK_AFTER_MS",
  kind: "integer",
  required: false,
  fallback: "10000",
  min: 0,
  printable: true,
  purpose:
    "The soonest a transfer is asked about again. Without it one stuck transfer at the front of the queue is re-checked every pass and the rest never get a turn.",
};

const RAIL_MAX_CHECK_FAILURES: VarSpec = {
  name: "RAIL_MAX_CHECK_FAILURES",
  kind: "integer",
  required: false,
  fallback: "10",
  min: 1,
  printable: true,
  purpose:
    "Consecutive failures before the queue stops offering a transfer. Per transfer, not per rail: one unanswerable transfer must not back off the whole rail.",
};

const KEEPER_ENABLED: VarSpec = {
  name: "KEEPER_ENABLED",
  kind: "boolean",
  required: false,
  fallback: "true",
  printable: true,
  purpose: "Runs the BullMQ keeper jobs: TTL bumps and claim settlement.",
};

const KEEPER_POLL_INTERVAL_MS: VarSpec = {
  name: "KEEPER_POLL_INTERVAL_MS",
  kind: "integer",
  required: false,
  fallback: "30000",
  min: 5000,
  printable: true,
  purpose: "How often the keeper checks for state to push forward.",
};

const KEEPER_CONCURRENCY: VarSpec = {
  name: "KEEPER_CONCURRENCY",
  kind: "integer",
  required: false,
  fallback: "2",
  min: 1,
  max: 10,
  printable: true,
  purpose: "Max concurrent jobs the keeper runs.",
};

const KEEPER_STELLAR_SECRET: VarSpec = {
  name: "KEEPER_STELLAR_SECRET",
  kind: "string",
  required: false,
  printable: false,
  purpose:
    "Secret key for submitting Stellar keep_alive and claim transactions. Optional; runs dry-run when absent.",
};

const SHUTDOWN_TIMEOUT_MS: VarSpec = {
  name: "SHUTDOWN_TIMEOUT_MS",
  kind: "integer",
  required: false,
  fallback: "10000",
  min: 100,
  printable: true,
  purpose: "How long shutdown waits for in-flight work before it stops waiting.",
};

const STELLAR_RPC_URL: VarSpec = {
  name: "STELLAR_RPC_URL",
  kind: "url",
  protocols: ["http", "https"],
  required: false,
  printable: true,
  purpose:
    "Soroban RPC. Defaults to the chain registry endpoint, which is public and will rate limit you under real load.",
};

const STELLAR_START_LEDGER: VarSpec = {
  name: "STELLAR_START_LEDGER",
  kind: "integer",
  required: false,
  min: 1,
  printable: true,
  purpose:
    "Overrides the start ledger for a fresh Stellar cursor. The deployment record's deployedAt.ledger is written when the deploy script finishes, which on the live testnet record is later than the router's own first event, so an operator needs a way to wind the start back without redeploying. Ignored once a cursor exists.",
};

const STELLAR_EVENT_PAGE_SIZE: VarSpec = {
  name: "STELLAR_EVENT_PAGE_SIZE",
  kind: "integer",
  required: false,
  fallback: "200",
  min: 1,
  max: 10_000,
  printable: true,
  purpose: "Events per getEvents page. One page is one database transaction.",
};

const STELLAR_POLL_INTERVAL_MS: VarSpec = {
  name: "STELLAR_POLL_INTERVAL_MS",
  kind: "integer",
  required: false,
  fallback: "5000",
  min: 250,
  printable: true,
  purpose: "Ledgers close in about five seconds, so polling faster mostly asks for nothing.",
};

const EVM_POLL_INTERVAL_MS: VarSpec = {
  name: "EVM_POLL_INTERVAL_MS",
  kind: "integer",
  required: false,
  fallback: "4000",
  min: 250,
  printable: true,
  purpose: "How often each EVM chain is polled for new logs.",
};

const EVM_LOG_RANGE: VarSpec = {
  name: "EVM_LOG_RANGE",
  kind: "integer",
  required: false,
  fallback: "2000",
  min: 1,
  printable: true,
  purpose: "Blocks per getLogs call. Public endpoints reject wide ranges.",
};

const EVM_REORG_DEPTH: VarSpec = {
  name: "EVM_REORG_DEPTH_BLOCKS",
  kind: "integer",
  required: false,
  min: 1,
  printable: true,
  purpose:
    "How far back the cursor winds when a reorg is found below the confirmation depth. Not a re-read on every pass: ordinary passes trust the cursor, because nothing past the confirmation line is indexed in the first place. Defaults per chain to that chain's own confirmations from the registry.",
};

/** `base-sepolia` becomes `BASE_SEPOLIA`, which is what an override variable is named after. */
export function envSuffixFor(chain: ChainKey): string {
  return chain.toUpperCase().replaceAll("-", "_");
}

function rpcOverrideSpec(chain: ChainKey): VarSpec {
  return {
    name: `EVM_RPC_URL_${envSuffixFor(chain)}`,
    kind: "url",
    // A node address typed without a scheme, "sepolia-node:8545", parses as a URL whose protocol
    // is "sepolia-node:". Saying which schemes are acceptable is what catches it here instead of
    // inside viem on the first request.
    protocols: ["http", "https"],
    required: false,
    printable: true,
    purpose: `RPC endpoint for ${CHAINS[chain].name}. Defaults to the chain registry entry.`,
  };
}

function rpcUrlsOverrideSpec(chain: ChainKey): VarSpec {
  return {
    name: `EVM_RPC_URLS_${envSuffixFor(chain)}`,
    kind: "url",
    protocols: ["http", "https"],
    required: false,
    printable: true,
    purpose: `RPC endpoints for ${CHAINS[chain].name}, comma-separated. Defaults to EVM_RPC_URL_${envSuffixFor(chain)} or the chain registry entry.`,
  };
}

/**
 * Read the environment and the deployment record, or explain why not.
 *
 * Throws `ConfigError` listing every variable that needs attention. Deliberately the only place
 * in the process that reads `process.env`.
 */
export function loadConfig(options: LoadOptions = {}): AppConfig {
  const env = options.env ?? process.env;
  const read = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const cwd = options.cwd ?? process.cwd();
  const reader = new EnvReader(env);

  const nodeEnv = reader.choice(NODE_ENV);
  const logLevel = reader.choice(LOG_LEVEL);
  const host = reader.string(HTTP_HOST);
  const port = reader.integer(HTTP_PORT);
  const databaseUrl = reader.url(DATABASE_URL);
  const keeperEnabled = reader.boolean(KEEPER_ENABLED);
  const redisUrl = reader.url({ ...REDIS_URL, required: keeperEnabled });
  const network = reader.choice(HYPERION_NETWORK);
  const deploymentsPath = reader.string(DEPLOYMENTS_FILE);
  const indexerEnabled = reader.boolean(INDEXER_ENABLED);
  const shutdownTimeoutMs = reader.integer(SHUTDOWN_TIMEOUT_MS);

  const railsEnabled = reader.boolean(RAILS_ENABLED);
  const irisOverride = reader.url(IRIS_API_URL);
  const axelarOverride = reader.url(AXELAR_API_URL);
  const railPollIntervalMs = reader.integer(RAIL_POLL_INTERVAL_MS);
  const railBatchSize = reader.integer(RAIL_BATCH_SIZE);
  const railRecheckAfterMs = reader.integer(RAIL_RECHECK_AFTER_MS);
  const railMaxCheckFailures = reader.integer(RAIL_MAX_CHECK_FAILURES);

  const keeperPollIntervalMs = reader.integer(KEEPER_POLL_INTERVAL_MS);
  const keeperConcurrency = reader.integer(KEEPER_CONCURRENCY);
  const keeperStellarSecret = reader.has(KEEPER_STELLAR_SECRET.name)
    ? reader.string(KEEPER_STELLAR_SECRET)
    : null;
  const stellarRpcOverride = reader.url(STELLAR_RPC_URL);
  const startLedgerOverride = reader.has(STELLAR_START_LEDGER.name)
    ? reader.integer(STELLAR_START_LEDGER)
    : null;
  const pageSize = reader.integer(STELLAR_EVENT_PAGE_SIZE);
  const stellarPollIntervalMs = reader.integer(STELLAR_POLL_INTERVAL_MS);
  const evmPollIntervalMs = reader.integer(EVM_POLL_INTERVAL_MS);
  const logRange = reader.integer(EVM_LOG_RANGE);
  const reorgDepthOverride = reader.has(EVM_REORG_DEPTH.name)
    ? reader.integer(EVM_REORG_DEPTH)
    : null;

  const absoluteDeployments = deploymentsPath === "" ? "" : resolvePath(cwd, deploymentsPath);
  const loaded = readDeployments(reader, read, absoluteDeployments);
  const deployments = loaded.set;
  const indexer = planIndexer(reader, {
    network,
    deployments,
    enabled: indexerEnabled,
    stellarRpcOverride,
    startLedgerOverride,
    pageSize,
    stellarPollIntervalMs,
    evmPollIntervalMs,
    logRange,
    reorgDepthOverride,
    env,
  });
  const gmpLanes = validateAndPlanGmpLanes(
    reader,
    network,
    deployments,
    loaded.gmpReceivers,
    loaded.fixtureProvenance,
  );

  // One throw, after everything has had a chance to complain.
  reader.finish();

  return {
    nodeEnv,
    logLevel,
    http: { host, port },
    databaseUrl,
    redisUrl,
    network,
    deploymentsFile: absoluteDeployments,
    deployments,
    indexer,
    rails: {
      enabled: railsEnabled,
      irisUrl: irisOverride === "" ? IRIS_API[network] : irisOverride,
      axelarUrl: axelarOverride === "" ? AXELARSCAN_API[network] : axelarOverride,
      gmpLanes,
      fixtureProvenance: loaded.fixtureProvenance,
      pollIntervalMs: railPollIntervalMs,
      batchSize: railBatchSize,
      recheckAfterMs: railRecheckAfterMs,
      maxCheckFailures: railMaxCheckFailures,
    },
    keeper: {
      enabled: keeperEnabled,
      pollIntervalMs: keeperPollIntervalMs,
      concurrency: keeperConcurrency,
      stellarSecret: keeperStellarSecret,
    },
    shutdownTimeoutMs,
  };
}

const EMPTY_SET: DeploymentSet = { schemaVersion: 1, generatedAt: "", networks: {} };

interface GmpReceiverRecord {
  readonly receiver: string | null;
  readonly enabled: boolean;
}

interface LoadedDeployments {
  readonly set: DeploymentSet;
  readonly gmpReceivers: Readonly<Partial<Record<ChainKey, GmpReceiverRecord>>>;
  readonly fixtureProvenance: string | null;
}

function readDeployments(
  reader: EnvReader,
  read: (path: string) => string,
  path: string,
): LoadedDeployments {
  if (path === "") return { set: EMPTY_SET, gmpReceivers: {}, fixtureProvenance: null };

  let text: string;
  try {
    text = read(path);
  } catch {
    // The path is in the message on purpose. A relative path resolved against the wrong working
    // directory is the single most common way this fails, and the resolved absolute path is the
    // thing that makes it obvious.
    reader.reject(DEPLOYMENTS_FILE, `cannot be read at ${path}`);
    return { set: EMPTY_SET, gmpReceivers: {}, fixtureProvenance: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    reader.reject(DEPLOYMENTS_FILE, `is not valid JSON: ${messageOf(error)}`);
    return { set: EMPTY_SET, gmpReceivers: {}, fixtureProvenance: null };
  }

  let set: DeploymentSet;
  try {
    // Validated rather than cast. An address with a transposed character parses fine as a string
    // and turns into a watcher reading an empty contract for a week without complaining.
    set = parseDeploymentSet(parsed);
  } catch (error) {
    const detail =
      error instanceof DeploymentFormatError
        ? error.message
        : `is not a deployment set: ${messageOf(error)}`;
    reader.reject(DEPLOYMENTS_FILE, detail);
    return { set: EMPTY_SET, gmpReceivers: {}, fixtureProvenance: null };
  }

  const { gmpReceivers, fixtureProvenance } = extractGmpMetadata(reader, parsed, set);
  return { set, gmpReceivers, fixtureProvenance };
}

interface PlanInput {
  readonly network: NetworkMode;
  readonly deployments: DeploymentSet;
  readonly enabled: boolean;
  readonly stellarRpcOverride: string;
  readonly startLedgerOverride: number | null;
  readonly pageSize: number;
  readonly stellarPollIntervalMs: number;
  readonly evmPollIntervalMs: number;
  readonly logRange: number;
  readonly reorgDepthOverride: number | null;
  readonly env: Readonly<Record<string, string | undefined>>;
}

function planIndexer(reader: EnvReader, input: PlanInput): IndexerConfig {
  // Stand down if either input this depends on already failed. A missing HYPERION_NETWORK makes
  // `choice` fall back to the first mode, which makes every chain in a testnet record look like it
  // belongs to the wrong network, and the result was two faults blaming
  // HYPERION_DEPLOYMENTS_FILE for a file that was fine. A cascading fault is worse than a silent
  // one: it sends somebody to edit the wrong thing, confidently.
  if (reader.failed(HYPERION_NETWORK) || reader.failed(DEPLOYMENTS_FILE)) {
    return { enabled: input.enabled, stellar: null, evm: [] };
  }

  const allowed = new Set(chainsFor(input.network).map((entry: Chain) => entry.key));
  let stellar: StellarWatchConfig | null = null;
  const evm: EvmWatchConfig[] = [];

  // Gathered first and reported once. Refused rather than ignored, because a testnet record
  // quietly watched by a mainnet process is how an operator ends up confident about numbers that
  // describe the wrong network. One fault naming every wrong chain beats one fault per chain:
  // there is a single thing to fix, which is the record or the network variable, not three.
  const wrongNetwork = Object.keys(input.deployments.networks).filter(
    (key) => !allowed.has(key as ChainKey),
  );
  if (wrongNetwork.length > 0) {
    reader.reject(
      DEPLOYMENTS_FILE,
      `names ${wrongNetwork.join(", ")}, which is not a ${input.network} chain. Split the record or change HYPERION_NETWORK.`,
    );
  }

  for (const [key, deployment] of Object.entries(input.deployments.networks)) {
    const chainKey = key as ChainKey;
    // The validator only ever assigns a defined deployment, so the entry is present whenever the
    // key is. Anything in the record naming a chain for another network was already reported.
    if (!allowed.has(chainKey)) continue;

    const chain = CHAINS[chainKey];
    if (isStellarDeployment(deployment) && isStellarChain(chain)) {
      if (stellar !== null) {
        reader.reject(
          DEPLOYMENTS_FILE,
          "holds two Stellar deployments, and there is one Stellar per network",
        );
        continue;
      }
      if (deployment.networkPassphrase !== chain.networkPassphrase) {
        // A passphrase mismatch means the record was written against a different network than it
        // claims, and a signature from one is worthless on the other.
        reader.reject(
          DEPLOYMENTS_FILE,
          `has a network passphrase for ${chainKey} that does not match the chain registry`,
        );
        continue;
      }
      stellar = {
        chain: chainKey,
        rpcUrl: input.stellarRpcOverride === "" ? chain.defaultRpcUrl : input.stellarRpcOverride,
        networkPassphrase: chain.networkPassphrase,
        routerContractId: deployment.router,
        startLedger: input.startLedgerOverride ?? deployment.deployedAt.ledger,
        pageSize: input.pageSize,
        pollIntervalMs: input.stellarPollIntervalMs,
      };
      continue;
    }

    if (isEvmDeployment(deployment) && isEvmChain(chain)) {
      if (deployment.chainId !== chain.chainId) {
        reader.reject(
          DEPLOYMENTS_FILE,
          `says ${chainKey} is chain id ${deployment.chainId}, and the chain registry says ${chain.chainId}`,
        );
        continue;
      }
      const override = rpcOverrideSpec(chainKey);
      const urlsOverride = rpcUrlsOverrideSpec(chainKey);
      let rpcUrls: readonly string[];
      if (reader.has(urlsOverride.name)) {
        rpcUrls = reader.urls(urlsOverride);
      } else if (reader.has(override.name)) {
        rpcUrls = reader.urls(override);
      } else {
        rpcUrls = [chain.defaultRpcUrl];
      }
      const rpcUrl = rpcUrls[0] ?? chain.defaultRpcUrl;
      evm.push({
        chain: chainKey,
        chainId: chain.chainId,
        rpcUrl,
        rpcUrls,
        routerAddress: deployment.router,
        startBlock: BigInt(deployment.deployedAt.blockNumber),
        confirmations: chain.confirmations,
        // The chain's own confirmations is the right default per chain: one on Arc, where
        // Malachite finality is genuinely final, and twelve on Ethereum, where it is not.
        reorgDepth: input.reorgDepthOverride ?? chain.confirmations,
        logRange: input.logRange,
        pollIntervalMs: input.evmPollIntervalMs,
      });
      continue;
    }

    reader.reject(
      DEPLOYMENTS_FILE,
      `describes ${chainKey} as a ${deployment.family} deployment, and the chain registry says it is ${chain.family}`,
    );
  }

  // Stable order so logs and the ready check read the same way on every boot.
  evm.sort((a, b) => a.chain.localeCompare(b.chain));
  return { enabled: input.enabled, stellar, evm };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const LOCAL_FIXTURE_KEYWORDS = ["local", "anvil", "hardhat", "fixture", "mock", "synthetic"];

export function isNonLiveFixtureProvenance(value: unknown): boolean {
  if (typeof value !== "string" || value.trim() === "") return false;
  const lower = value.toLowerCase();
  return LOCAL_FIXTURE_KEYWORDS.some((word) => lower.includes(word));
}

function isValidContractForChain(chain: Chain, value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (isEvmChain(chain)) {
    return /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/.test(value);
  }
  if (isStellarChain(chain)) {
    try {
      const parsed = parseStellarAddress(value);
      return (
        parsed.kind === AddressKind.Contract &&
        encodeStellarAddress(parsed.kind, parsed.key, parsed.muxedId) === value
      );
    } catch {
      return false;
    }
  }
  return false;
}

function extractGmpMetadata(
  reader: EnvReader,
  rawJson: unknown,
  set: DeploymentSet,
): {
  readonly gmpReceivers: Readonly<Partial<Record<ChainKey, GmpReceiverRecord>>>;
  readonly fixtureProvenance: string | null;
} {
  const gmpReceivers: Partial<Record<ChainKey, GmpReceiverRecord>> = {};
  if (typeof rawJson !== "object" || rawJson === null || Array.isArray(rawJson)) {
    return { gmpReceivers, fixtureProvenance: null };
  }
  const top = rawJson as Record<string, unknown>;
  const rawProvenance =
    typeof top.provenance === "string"
      ? top.provenance
      : typeof top.capturedFrom === "string"
        ? top.capturedFrom
        : null;
  const fixtureProvenance = isNonLiveFixtureProvenance(rawProvenance) ? rawProvenance : null;

  const rawNetworks = top.networks;
  if (typeof rawNetworks !== "object" || rawNetworks === null || Array.isArray(rawNetworks)) {
    return { gmpReceivers, fixtureProvenance };
  }

  for (const key of Object.keys(set.networks)) {
    if (!isChainKey(key)) continue;
    const chain = CHAINS[key];
    const rawEntry = (rawNetworks as Record<string, unknown>)[key];
    if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) continue;
    const rawReceiver = (rawEntry as Record<string, unknown>).gmpReceiver;
    if (rawReceiver === undefined || rawReceiver === null) continue;
    if (typeof rawReceiver !== "object" || Array.isArray(rawReceiver)) {
      reader.reject(DEPLOYMENTS_FILE, `networks.${key}.gmpReceiver must be an object when present`);
      continue;
    }
    const fields = rawReceiver as Record<string, unknown>;
    const enabled = fields.enabled === undefined ? true : Boolean(fields.enabled);
    if (fields.enabled !== undefined && typeof fields.enabled !== "boolean") {
      reader.reject(DEPLOYMENTS_FILE, `networks.${key}.gmpReceiver.enabled must be a boolean`);
      continue;
    }
    if (!enabled) {
      gmpReceivers[key] = { receiver: null, enabled: false };
      continue;
    }
    if (!isValidContractForChain(chain, fields.receiver)) {
      reader.reject(
        DEPLOYMENTS_FILE,
        `networks.${key}.gmpReceiver.receiver must be a valid non-zero ${chain.family} contract address`,
      );
      continue;
    }
    gmpReceivers[key] = { receiver: fields.receiver, enabled: true };
  }

  return { gmpReceivers, fixtureProvenance };
}

function tokenOnDeployment(
  deployment: DeploymentSet["networks"][ChainKey],
  symbol: string,
): {
  readonly address: string;
  readonly decimals: number;
  readonly routes: readonly number[];
} | null {
  if (deployment === undefined) return null;
  if (isStellarDeployment(deployment)) {
    const token = deployment.tokens[symbol];
    if (token === undefined) return null;
    return { address: token.sacId, decimals: token.decimals, routes: token.routes };
  }
  if (isEvmDeployment(deployment)) {
    const token = deployment.tokens[symbol];
    if (token === undefined) return null;
    return { address: token.address, decimals: token.decimals, routes: token.routes };
  }
  return null;
}

function symbolsOnDeployment(deployment: DeploymentSet["networks"][ChainKey]): readonly string[] {
  if (deployment === undefined) return [];
  return Object.keys(deployment.tokens);
}

function receiverForChain(
  chain: ChainKey,
  deployment: DeploymentSet["networks"][ChainKey],
  gmpReceivers: Readonly<Partial<Record<ChainKey, GmpReceiverRecord>>>,
): string | null {
  const explicit = gmpReceivers[chain];
  if (explicit !== undefined) {
    return explicit.enabled ? explicit.receiver : null;
  }
  return deployment?.adapters[RouteKind.AxelarGmp] ?? null;
}

function validateAndPlanGmpLanes(
  reader: EnvReader,
  network: NetworkMode,
  deployments: DeploymentSet,
  gmpReceivers: Readonly<Partial<Record<ChainKey, GmpReceiverRecord>>>,
  fixtureProvenance: string | null,
): readonly GmpAdmittedLane[] {
  if (reader.failed(HYPERION_NETWORK) || reader.failed(DEPLOYMENTS_FILE)) {
    return [];
  }

  const allowed = new Set(chainsFor(network).map((entry) => entry.key));
  const configuredChains = Object.keys(deployments.networks).filter(
    (key): key is ChainKey => isChainKey(key) && allowed.has(key),
  );

  // Check every network that mentions `axelar-gmp` for missing adapter, gateway, or deployed receiver support.
  for (const chainKey of configuredChains) {
    const deployment = deployments.networks[chainKey];
    if (deployment === undefined) continue;
    const adapter = deployment.adapters[RouteKind.AxelarGmp];
    const gmpSymbols = symbolsOnDeployment(deployment).filter((symbol) => {
      const tok = tokenOnDeployment(deployment, symbol);
      return tok?.routes.includes(RouteKind.AxelarGmp) === true;
    });
    const usesGmp = adapter !== undefined || gmpSymbols.length > 0;
    if (!usesGmp) continue;

    if (chainKey === "local" || fixtureProvenance !== null) {
      reader.reject(
        DEPLOYMENTS_FILE,
        `cannot admit Axelar GMP on ${chainKey} from local rehearsal or synthetic fixture metadata`,
      );
      return [];
    }

    const axelar = RAIL_CONTRACTS[chainKey]?.axelar;
    if (!axelar?.gateway || !axelar.chainName) {
      reader.reject(
        DEPLOYMENTS_FILE,
        `enables axelar-gmp on ${chainKey}, which has no deployed Axelar gateway in the protocol registry`,
      );
      return [];
    }

    if (adapter === undefined || !isValidContractForChain(CHAINS[chainKey], adapter)) {
      reader.reject(
        DEPLOYMENTS_FILE,
        `enables axelar-gmp on ${chainKey} without a valid deployed axelar-gmp adapter`,
      );
      return [];
    }

    const localReceiver = receiverForChain(chainKey, deployment, gmpReceivers);
    if (localReceiver === null) {
      reader.reject(
        DEPLOYMENTS_FILE,
        `enables axelar-gmp on ${chainKey} while its deployed GMP receiver support is disabled or missing`,
      );
      return [];
    }

    for (const symbol of gmpSymbols) {
      const hasDeployedPeerReceiver = configuredChains.some((peerKey) => {
        if (peerKey === chainKey || peerKey === "local") return false;
        const peerDep = deployments.networks[peerKey];
        const peerTok = tokenOnDeployment(peerDep, symbol);
        const peerGateway = RAIL_CONTRACTS[peerKey]?.axelar?.gateway;
        const peerReceiver = receiverForChain(peerKey, peerDep, gmpReceivers);
        return (
          peerDep !== undefined &&
          peerTok?.routes.includes(RouteKind.AxelarGmp) === true &&
          Boolean(peerGateway) &&
          peerReceiver !== null
        );
      });
      if (!hasDeployedPeerReceiver) {
        reader.reject(
          DEPLOYMENTS_FILE,
          `enables axelar-gmp for ${symbol} on ${chainKey} without a deployed peer GMP receiver in the deployment set`,
        );
        return [];
      }
    }
  }

  const lanes: GmpAdmittedLane[] = [];
  for (const originChain of configuredChains) {
    for (const destinationChain of configuredChains) {
      if (originChain === destinationChain) continue;
      if (originChain === "local" || destinationChain === "local") continue;
      const originDep = deployments.networks[originChain];
      const destDep = deployments.networks[destinationChain];
      const originAxelar = RAIL_CONTRACTS[originChain]?.axelar;
      const destAxelar = RAIL_CONTRACTS[destinationChain]?.axelar;
      const originAdapter = originDep?.adapters[RouteKind.AxelarGmp];
      const destReceiver = receiverForChain(destinationChain, destDep, gmpReceivers);

      if (
        originDep === undefined ||
        destDep === undefined ||
        !originAxelar?.gateway ||
        !destAxelar?.gateway ||
        originAdapter === undefined ||
        destReceiver === null
      ) {
        continue;
      }

      for (const symbol of symbolsOnDeployment(originDep)) {
        const originTok = tokenOnDeployment(originDep, symbol);
        const destTok = tokenOnDeployment(destDep, symbol);
        if (
          originTok === null ||
          destTok === null ||
          !originTok.routes.includes(RouteKind.AxelarGmp) ||
          !destTok.routes.includes(RouteKind.AxelarGmp)
        ) {
          continue;
        }
        lanes.push({
          originChain,
          destinationChain,
          symbol,
          originAxelarChain: originAxelar.chainName,
          destinationAxelarChain: destAxelar.chainName,
          originGateway: originAxelar.gateway,
          destinationGateway: destAxelar.gateway,
          originAdapter,
          destinationReceiver: destReceiver,
          destinationRouter: destDep.router,
          originToken: originTok.address,
          destinationToken: destTok.address,
          originDecimals: originTok.decimals,
          destinationDecimals: destTok.decimals,
        });
      }
    }
  }

  return lanes;
}

export type GmpLaneAdmission =
  | { readonly admitted: true; readonly lane: GmpAdmittedLane }
  | { readonly admitted: false; readonly reason: string };

/**
 * Admit an authenticated Axelar GMP lane only when both endpoints are live network chains with
 * deployed Axelar gateways, source GMP adapters, and destination GMP receivers.
 */
export function admitGmpLane(
  config: Pick<AppConfig, "network" | "deployments" | "rails">,
  originChain: string,
  destinationChain: string,
  symbol = "USDC",
): GmpLaneAdmission {
  if (config.rails.fixtureProvenance) {
    return { admitted: false, reason: "local_or_fixture_provenance" };
  }
  if (!isChainKey(originChain) || !isChainKey(destinationChain)) {
    return { admitted: false, reason: "unknown_chain_key" };
  }
  if (originChain === "local" || destinationChain === "local") {
    return { admitted: false, reason: "local_chain_prohibited" };
  }
  if (originChain === destinationChain) {
    return { admitted: false, reason: "same_chain_lane" };
  }
  const allowed = new Set(chainsFor(config.network).map((entry) => entry.key));
  if (!allowed.has(originChain) || !allowed.has(destinationChain)) {
    return { admitted: false, reason: "wrong_network_mode" };
  }
  if (
    !RAIL_CONTRACTS[originChain]?.axelar?.gateway ||
    !RAIL_CONTRACTS[destinationChain]?.axelar?.gateway
  ) {
    return { admitted: false, reason: "missing_axelar_gateway" };
  }
  const originDep = config.deployments.networks[originChain];
  const destDep = config.deployments.networks[destinationChain];
  if (originDep === undefined || destDep === undefined) {
    return { admitted: false, reason: "missing_deployment_record" };
  }
  if (originDep.adapters[RouteKind.AxelarGmp] === undefined) {
    return { admitted: false, reason: "missing_source_gmp_adapter" };
  }
  if (destDep.adapters[RouteKind.AxelarGmp] === undefined) {
    return { admitted: false, reason: "missing_deployed_receiver" };
  }
  const matched = (config.rails.gmpLanes ?? []).find(
    (entry) =>
      entry.originChain === originChain &&
      entry.destinationChain === destinationChain &&
      entry.symbol === symbol,
  );
  if (matched === undefined) {
    return { admitted: false, reason: "missing_deployed_receiver" };
  }
  return { admitted: true, lane: matched };
}
