/**
 * Read-only operational diagnostics bundle generator and CLI entrypoint.
 *
 * Produces a deterministic, credential-free JSON snapshot of sanitized configuration, migrated
 * PostgreSQL schema state, persisted worker freshness, and cross-chain proof backlog so operators
 * can diagnose separate API and indexer deployments reproducibly without leaking secrets.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { isEvmDeployment, isStellarDeployment } from "@hyperion/protocol";

import { buildIndexer, configuredWatchedChains } from "../chains/runner.js";
import { loadConfig, type AppConfig, type LoadOptions } from "../config/config.js";
import { Database, type Queryable } from "../db/pool.js";
import { createBootLogger, createLogger } from "../logging/logger.js";
import {
  checkRedisHealth,
  type ReadinessReport,
  type ReadinessSource,
  type RedisPingable,
} from "../runtime/readiness.js";

const REQUIRED_SCHEMA_TABLES = [
  "admin_action",
  "inbound_delivery",
  "indexer_cursor",
  "outbound_transfer",
  "pending_claim",
  "rail_attestation",
  "route_health",
] as const;

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "cookie",
  "set-cookie",
]);

const CREDENTIAL_URI_REGEX = /\b(?:postgres(?:ql)?|rediss?|https?):\/\/[^\s"'<>]+/gi;
const BEARER_OR_BASIC_REGEX = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi;
const AUTH_HEADER_INLINE_REGEX =
  /\b(?:authorization|proxy-authorization|x-api-key|api-key)\s*[:=]\s*(?:(?:Bearer|Basic)\s+)?[^\s,;]+/gi;
const STELLAR_SECRET_REGEX = /\bS[A-Z2-7]{55}\b/g;
const EVM_PRIVATE_KEY_REGEX = /\b0x[0-9a-fA-F]{64}\b/g;
const SECRET_SEGMENT_REGEX = /^(?:[0-9a-fA-F]{16,}|[A-Za-z0-9_-]{20,})$/;

export type ProbeStatus = "ok" | "degraded" | "failed";

export interface NormalizedProbeFailure {
  readonly category:
    | "configuration_invalid"
    | "database_unreachable"
    | "database_timeout"
    | "database_permission"
    | "schema_incomplete"
    | "freshness_stale"
    | "dependency_degraded"
    | "probe_error";
  readonly code: string;
  readonly summary: string;
  readonly remediation: string;
}

export interface ProbeSection<T> {
  readonly status: ProbeStatus;
  readonly checkedAt: string;
  readonly failure: NormalizedProbeFailure | null;
  readonly data: T | null;
}

export interface DeploymentRouterRevision {
  readonly chain: string;
  readonly family: "stellar" | "evm";
  readonly router: string;
  readonly commit: string;
  readonly deployedHeight: string;
  readonly deployedTimestamp: string;
}

export interface DiagnosticsRevision {
  readonly serviceVersion: string;
  readonly network: string;
  readonly deploymentSchemaVersion: number;
  readonly deploymentGeneratedAt: string;
  readonly hasEvmRouter: boolean;
  readonly deployedRouters: readonly DeploymentRouterRevision[];
  readonly configDigest: string;
}

export interface SanitizedConfigSummary {
  readonly nodeEnv: string;
  readonly logLevel: string;
  readonly network: string;
  readonly http: { readonly host: string; readonly port: number };
  readonly indexer: {
    readonly enabled: boolean;
    readonly stellar: {
      readonly chain: string;
      readonly rpcOrigin: string;
      readonly routerContractId: string;
      readonly startLedger: number;
      readonly pageSize: number;
      readonly pollIntervalMs: number;
    } | null;
    readonly evm: readonly {
      readonly chain: string;
      readonly chainId: number;
      readonly rpcOrigins: readonly string[];
      readonly routerAddress: string;
      readonly startBlock: string;
      readonly confirmations: number;
      readonly reorgDepth: number;
      readonly logRange: number;
      readonly pollIntervalMs: number;
    }[];
  };
  readonly rails: {
    readonly enabled: boolean;
    readonly irisOrigin: string;
    readonly axelarOrigin: string;
    readonly pollIntervalMs: number;
    readonly batchSize: number;
    readonly recheckAfterMs: number;
    readonly maxCheckFailures: number;
  };
  readonly keeper: {
    readonly enabled: boolean;
    readonly pollIntervalMs: number;
    readonly concurrency: number;
    readonly signerMode: "configured" | "dry-run";
  };
  readonly sanitizedRequestHeaders: Readonly<Record<string, string>>;
}

export interface SchemaProbeData {
  readonly presentTables: readonly string[];
  readonly missingTables: readonly string[];
  readonly hasCursorBlockHashColumn: boolean;
  readonly appliedMigrations: readonly {
    readonly name: string;
    readonly runOn: string | null;
  }[];
}

export interface WorkerFreshnessProbeData {
  readonly indexerEnabledInProcess: boolean;
  readonly persistedCursors: readonly {
    readonly chain: string;
    readonly family: string;
    readonly contract: string;
    readonly position: string;
    readonly blockHash: string | null;
    readonly updatedAt: string;
    readonly ageMs: number;
  }[];
  readonly missingExpectedCursors: readonly string[];
  readonly readinessChecks: readonly {
    readonly name: string;
    readonly state: string;
    readonly detail: string;
  }[];
}

export interface ProofBacklogProbeData {
  readonly totalOutboundTransfers: number;
  readonly verifiedInboundDeliveries: number;
  /** Outbound transfers lacking canonical destination receipt/event delivery row. */
  readonly unverifiedOutboundCount: number;
  /** Provider-attested transfers still awaiting canonical destination receipt proof. */
  readonly attestedAwaitingDestinationProof: number;
  readonly railStatusBreakdown: Readonly<Record<string, number>>;
  readonly stuckRailTransfers: number;
  readonly unsettledClaimsCount: number;
  readonly oldestUnverifiedObservedAt: string | null;
}

export interface DiagnosticsBundle {
  readonly bundleVersion: 1;
  readonly service: "hyperion-backend";
  readonly observedAt: string;
  readonly overallStatus: ProbeStatus;
  readonly revision: DiagnosticsRevision;
  readonly probes: {
    readonly configuration: ProbeSection<SanitizedConfigSummary>;
    readonly schema: ProbeSection<SchemaProbeData>;
    readonly workerFreshness: ProbeSection<WorkerFreshnessProbeData>;
    readonly proofBacklog: ProbeSection<ProofBacklogProbeData>;
  };
}

export interface GenerateDiagnosticsOptions {
  readonly config: AppConfig;
  readonly db: Queryable;
  readonly readiness?: readonly ReadinessSource[] | undefined;
  readonly redis?: RedisPingable | undefined;
  readonly requestHeaders?:
    Readonly<Record<string, string | readonly string[] | undefined>> | undefined;
  readonly now?: () => Date;
}

/**
 * Strip credentials, query strings, fragments, and API-key path tokens from an endpoint URL.
 */
export function sanitizePublicEndpointUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "[redacted-non-http-endpoint]";
    }
    const segments = parsed.pathname
      .split("/")
      .filter((part) => part.length > 0)
      .map((part) => (SECRET_SEGMENT_REGEX.test(part) ? "[redacted]" : part));
    const safePath = segments.length > 0 ? `/${segments.join("/")}` : "";
    return `${parsed.protocol}//${parsed.host}${safePath}`;
  } catch {
    return "[invalid-url]";
  }
}

/**
 * Scrub connection strings, authorization headers, and signer secrets from free-form text.
 */
export function sanitizeDiagnosticText(raw: string): string {
  return raw
    .replace(AUTH_HEADER_INLINE_REGEX, "[redacted-auth-header]")
    .replace(BEARER_OR_BASIC_REGEX, "[redacted-auth-token]")
    .replace(CREDENTIAL_URI_REGEX, (match) => {
      try {
        const u = new URL(match);
        if (u.protocol === "http:" || u.protocol === "https:") {
          if (u.username !== "" || u.password !== "") {
            return `${u.protocol}//[redacted]@${u.host}`;
          }
          return sanitizePublicEndpointUrl(match);
        }
        return `${u.protocol}//[redacted-connection-string]`;
      } catch {
        return "[redacted-uri]";
      }
    })
    .replace(STELLAR_SECRET_REGEX, "[redacted-stellar-secret]")
    .replace(EVM_PRIVATE_KEY_REGEX, "[redacted-hex-secret]");
}

/**
 * Drop authorization, API key, and cookie headers completely and scrub any remaining header values.
 */
export function sanitizeDiagnosticHeaders(
  headers?: Readonly<Record<string, string | readonly string[] | undefined>>,
): Readonly<Record<string, string>> {
  if (headers === undefined) return {};
  const result: Record<string, string> = {};
  for (const key of Object.keys(headers).sort()) {
    if (SENSITIVE_HEADER_NAMES.has(key.toLowerCase())) {
      continue;
    }
    const rawValue = headers[key];
    if (rawValue === undefined) continue;
    const joined = Array.isArray(rawValue) ? rawValue.join(", ") : String(rawValue);
    result[key.toLowerCase()] = sanitizeDiagnosticText(joined);
  }
  return result;
}

export function buildDiagnosticsRevision(config: AppConfig): DiagnosticsRevision {
  const deployedRouters: DeploymentRouterRevision[] = [];
  for (const chainKey of Object.keys(config.deployments.networks).sort()) {
    const entry = config.deployments.networks[chainKey as keyof typeof config.deployments.networks];
    if (entry === undefined) continue;
    if (isStellarDeployment(entry)) {
      deployedRouters.push({
        chain: chainKey,
        family: "stellar",
        router: entry.router,
        commit: entry.commit,
        deployedHeight: String(entry.deployedAt.ledger),
        deployedTimestamp: entry.deployedAt.timestamp,
      });
    } else if (isEvmDeployment(entry)) {
      deployedRouters.push({
        chain: chainKey,
        family: "evm",
        router: entry.router,
        commit: entry.commit,
        deployedHeight: entry.deployedAt.blockNumber,
        deployedTimestamp: entry.deployedAt.timestamp,
      });
    }
  }

  const sanitizedConfig = buildSanitizedConfigSummary(config);
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        deploymentGeneratedAt: config.deployments.generatedAt,
        deployedRouters,
        config: sanitizedConfig,
      }),
    )
    .digest("hex")
    .slice(0, 16);

  return {
    serviceVersion: "0.1.0",
    network: config.network,
    deploymentSchemaVersion: config.deployments.schemaVersion,
    deploymentGeneratedAt: config.deployments.generatedAt,
    hasEvmRouter: config.indexer.evm.length > 0,
    deployedRouters,
    configDigest: digest,
  };
}

export function buildSanitizedConfigSummary(
  config: AppConfig,
  requestHeaders?: Readonly<Record<string, string | readonly string[] | undefined>>,
): SanitizedConfigSummary {
  return {
    nodeEnv: config.nodeEnv,
    logLevel: config.logLevel,
    network: config.network,
    http: { host: config.http.host, port: config.http.port },
    indexer: {
      enabled: config.indexer.enabled,
      stellar:
        config.indexer.stellar === null
          ? null
          : {
              chain: config.indexer.stellar.chain,
              rpcOrigin: sanitizePublicEndpointUrl(config.indexer.stellar.rpcUrl),
              routerContractId: config.indexer.stellar.routerContractId,
              startLedger: config.indexer.stellar.startLedger,
              pageSize: config.indexer.stellar.pageSize,
              pollIntervalMs: config.indexer.stellar.pollIntervalMs,
            },
      evm: config.indexer.evm.map((chain) => ({
        chain: chain.chain,
        chainId: chain.chainId,
        rpcOrigins: chain.rpcUrls.map((url) => sanitizePublicEndpointUrl(url)),
        routerAddress: chain.routerAddress,
        startBlock: chain.startBlock.toString(),
        confirmations: chain.confirmations,
        reorgDepth: chain.reorgDepth,
        logRange: chain.logRange,
        pollIntervalMs: chain.pollIntervalMs,
      })),
    },
    rails: {
      enabled: config.rails.enabled,
      irisOrigin: sanitizePublicEndpointUrl(config.rails.irisUrl),
      axelarOrigin: sanitizePublicEndpointUrl(config.rails.axelarUrl),
      pollIntervalMs: config.rails.pollIntervalMs,
      batchSize: config.rails.batchSize,
      recheckAfterMs: config.rails.recheckAfterMs,
      maxCheckFailures: config.rails.maxCheckFailures,
    },
    keeper: {
      enabled: config.keeper.enabled,
      pollIntervalMs: config.keeper.pollIntervalMs,
      concurrency: config.keeper.concurrency,
      signerMode: config.keeper.stellarSecret !== null ? "configured" : "dry-run",
    },
    sanitizedRequestHeaders: sanitizeDiagnosticHeaders(requestHeaders),
  };
}

export function normalizeProbeError(error: unknown): NormalizedProbeFailure {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const sanitized = sanitizeDiagnosticText(rawMessage);
  const pgCode =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";

  if (pgCode === "57014" || /timeout|timed out/i.test(sanitized)) {
    return {
      category: "database_timeout",
      code: pgCode || "QUERY_TIMEOUT",
      summary: sanitized,
      remediation:
        "Inspect PostgreSQL statement_timeout, pool saturation, and network latency between this host and PostgreSQL.",
    };
  }
  if (pgCode === "42501" || /permission denied/i.test(sanitized)) {
    return {
      category: "database_permission",
      code: pgCode || "PERMISSION_DENIED",
      summary: sanitized,
      remediation:
        "Grant SELECT privileges on public Hyperion tables and information_schema to the configured database role.",
    };
  }
  if (
    pgCode === "ECONNREFUSED" ||
    pgCode === "ENOTFOUND" ||
    pgCode.startsWith("08") ||
    pgCode.startsWith("28") ||
    /ECONNREFUSED|ENOTFOUND|connect|authentication/i.test(sanitized)
  ) {
    return {
      category: "database_unreachable",
      code: pgCode || "DB_UNREACHABLE",
      summary: sanitized,
      remediation:
        "Verify DATABASE_URL network reachability, TLS settings, and managed PostgreSQL availability.",
    };
  }
  if (pgCode === "42P01") {
    return {
      category: "schema_incomplete",
      code: "42P01",
      summary: sanitized,
      remediation:
        "Run `npm run migrate:up` against the target database before starting API or indexer workloads.",
    };
  }
  return {
    category: "probe_error",
    code: pgCode || "PROBE_FAILED",
    summary: sanitized,
    remediation: "Inspect structured service logs for the matching observedAt timestamp.",
  };
}

function isUndefinedTableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "42P01"
  );
}

function scalarString(value: unknown, fallback = "0"): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return fallback;
}

async function probeSchema(
  db: Queryable,
  checkedAt: string,
): Promise<ProbeSection<SchemaProbeData>> {
  try {
    const tablesRes = await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name ASC",
    );
    const presentSet = new Set<string>();
    for (const row of tablesRes.rows) {
      if (typeof row.table_name === "string") {
        presentSet.add(row.table_name);
      }
    }
    const presentTables = [...presentSet].sort();
    const missingTables = REQUIRED_SCHEMA_TABLES.filter((name) => !presentSet.has(name));

    const colRes = await db.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'indexer_cursor'
          AND column_name = 'last_processed_hash'`,
    );
    const hasCursorBlockHashColumn = colRes.rows.some(
      (row) => row.column_name === "last_processed_hash",
    );

    const appliedMigrations: { readonly name: string; readonly runOn: string | null }[] = [];
    if (presentSet.has("pgmigrations")) {
      try {
        const migRes = await db.query("SELECT name, run_on FROM pgmigrations ORDER BY id ASC");
        for (const row of migRes.rows) {
          if (typeof row.name === "string") {
            appliedMigrations.push({
              name: row.name,
              runOn:
                row.run_on !== null && row.run_on !== undefined
                  ? new Date(row.run_on as string | number | Date).toISOString()
                  : null,
            });
          }
        }
      } catch (err) {
        if (!isUndefinedTableError(err)) throw err;
      }
    }

    if (missingTables.length > 0 || !hasCursorBlockHashColumn) {
      return {
        status: "degraded",
        checkedAt,
        failure: {
          category: "schema_incomplete",
          code: "MISSING_SCHEMA_OBJECTS",
          summary:
            missingTables.length > 0
              ? `missing required tables: ${missingTables.join(", ")}`
              : "missing column indexer_cursor.last_processed_hash",
          remediation: "Apply pending SQL migrations with `npm run migrate:up`.",
        },
        data: {
          presentTables,
          missingTables,
          hasCursorBlockHashColumn,
          appliedMigrations,
        },
      };
    }

    return {
      status: "ok",
      checkedAt,
      failure: null,
      data: {
        presentTables,
        missingTables: [],
        hasCursorBlockHashColumn,
        appliedMigrations,
      },
    };
  } catch (error) {
    return {
      status: "failed",
      checkedAt,
      failure: normalizeProbeError(error),
      data: null,
    };
  }
}

async function probeWorkerFreshness(
  options: GenerateDiagnosticsOptions,
  now: Date,
): Promise<ProbeSection<WorkerFreshnessProbeData>> {
  const checkedAt = now.toISOString();
  const expectedChains = configuredWatchedChains(options.config);

  try {
    const cursorRes = await options.db.query(
      `SELECT chain_key, family, contract, last_processed, last_processed_hash, updated_at
         FROM indexer_cursor
        ORDER BY chain_key ASC`,
    );

    const seenChains = new Set<string>();
    const persistedCursors: {
      readonly chain: string;
      readonly family: string;
      readonly contract: string;
      readonly position: string;
      readonly blockHash: string | null;
      readonly updatedAt: string;
      readonly ageMs: number;
    }[] = [];

    for (const row of cursorRes.rows) {
      if (typeof row.chain_key !== "string") continue;
      seenChains.add(row.chain_key);
      const updatedDate = new Date(row.updated_at as string | number | Date);
      const ageMs = Math.max(0, now.getTime() - updatedDate.getTime());
      persistedCursors.push({
        chain: row.chain_key,
        family: typeof row.family === "string" ? row.family : "unknown",
        contract: typeof row.contract === "string" ? row.contract : "unknown",
        position: scalarString(row.last_processed),
        blockHash: typeof row.last_processed_hash === "string" ? row.last_processed_hash : null,
        updatedAt: updatedDate.toISOString(),
        ageMs,
      });
    }

    const missingExpectedCursors = expectedChains.filter((chain) => !seenChains.has(chain));

    const readinessChecks: {
      readonly name: string;
      readonly state: string;
      readonly detail: string;
    }[] = [];
    if (options.redis !== undefined) {
      const redisReport: ReadinessReport = await checkRedisHealth(options.redis);
      readinessChecks.push({
        name: redisReport.name,
        state: redisReport.state,
        detail: sanitizeDiagnosticText(redisReport.detail),
      });
    }
    for (const source of options.readiness ?? []) {
      try {
        const report = await source.readiness();
        readinessChecks.push({
          name: report.name,
          state: report.state,
          detail: sanitizeDiagnosticText(report.detail),
        });
      } catch (err) {
        const norm = normalizeProbeError(err);
        readinessChecks.push({
          name: "readiness-source",
          state: "down",
          detail: norm.summary,
        });
      }
    }

    const hasDownCheck = readinessChecks.some((c) => c.state === "down");
    const hasDegradedCheck = readinessChecks.some((c) => c.state === "degraded");

    if (missingExpectedCursors.length > 0 || hasDownCheck || hasDegradedCheck) {
      return {
        status: hasDownCheck ? "failed" : "degraded",
        checkedAt,
        failure: {
          category: missingExpectedCursors.length > 0 ? "freshness_stale" : "dependency_degraded",
          code: missingExpectedCursors.length > 0 ? "MISSING_CURSOR" : "READINESS_NOT_READY",
          summary:
            missingExpectedCursors.length > 0
              ? `no persisted cursor recorded yet for: ${missingExpectedCursors.join(", ")}`
              : "one or more worker readiness checks reported non-ready state",
          remediation:
            "Verify the scheduled or continuous indexer process has completed at least one scan window against this database.",
        },
        data: {
          indexerEnabledInProcess: options.config.indexer.enabled,
          persistedCursors,
          missingExpectedCursors,
          readinessChecks,
        },
      };
    }

    return {
      status: "ok",
      checkedAt,
      failure: null,
      data: {
        indexerEnabledInProcess: options.config.indexer.enabled,
        persistedCursors,
        missingExpectedCursors: [],
        readinessChecks,
      },
    };
  } catch (error) {
    return {
      status: "failed",
      checkedAt,
      failure: normalizeProbeError(error),
      data: null,
    };
  }
}

async function probeProofBacklog(
  options: GenerateDiagnosticsOptions,
  checkedAt: string,
): Promise<ProbeSection<ProofBacklogProbeData>> {
  try {
    const outRes = await options.db.query("SELECT count(*)::int AS count FROM outbound_transfer");
    const totalOutboundTransfers = Number(outRes.rows[0]?.count ?? 0);

    const inRes = await options.db.query("SELECT count(*)::int AS count FROM inbound_delivery");
    const verifiedInboundDeliveries = Number(inRes.rows[0]?.count ?? 0);

    const unverifiedRes = await options.db.query(
      `SELECT count(*)::int AS unverified_count,
              min(o.observed_at) AS oldest_observed_at
         FROM outbound_transfer o
        WHERE NOT EXISTS (
          SELECT 1
            FROM inbound_delivery i
           WHERE i.source_chain = o.origin_chain
             AND i.source_nonce = o.nonce
        )`,
    );
    const unverifiedRow = unverifiedRes.rows[0];
    const unverifiedOutboundCount =
      unverifiedRow?.unverified_count !== undefined
        ? Number(unverifiedRow.unverified_count)
        : Math.max(0, totalOutboundTransfers - verifiedInboundDeliveries);
    const oldestUnverifiedObservedAt =
      unverifiedRow?.oldest_observed_at !== null && unverifiedRow?.oldest_observed_at !== undefined
        ? new Date(unverifiedRow.oldest_observed_at as string | number | Date).toISOString()
        : null;

    const railRes = await options.db.query(
      "SELECT status, count(*)::int AS count FROM rail_attestation GROUP BY status",
    );
    const railStatusBreakdown: Record<string, number> = {};
    for (const row of railRes.rows) {
      if (typeof row.status === "string") {
        railStatusBreakdown[row.status] = Number(row.count ?? 0);
      }
    }

    const stuckRes = await options.db.query(
      "SELECT count(*)::int AS stuck_count FROM rail_attestation WHERE check_failures >= $1 AND status NOT IN ('delivered', 'failed', 'expired')",
      [options.config.rails.maxCheckFailures],
    );
    const stuckRailTransfers = Number(stuckRes.rows[0]?.stuck_count ?? 0);

    const claimsRes = await options.db.query(
      "SELECT count(*)::int AS unsettled FROM pending_claim WHERE settled = false",
    );
    const unsettledClaimsCount = Number(claimsRes.rows[0]?.unsettled ?? 0);

    const attestedAwaitingDestinationProof = railStatusBreakdown.attested ?? 0;

    if (stuckRailTransfers > 0) {
      return {
        status: "degraded",
        checkedAt,
        failure: {
          category: "dependency_degraded",
          code: "STUCK_RAIL_TRANSFERS",
          summary: `${String(stuckRailTransfers)} transfer(s) reached maxCheckFailures (${String(options.config.rails.maxCheckFailures)}) without destination proof`,
          remediation:
            "Inspect rail_attestation.last_error and verify destination RPC reachability; provider status alone never establishes delivery.",
        },
        data: {
          totalOutboundTransfers,
          verifiedInboundDeliveries,
          unverifiedOutboundCount,
          attestedAwaitingDestinationProof,
          railStatusBreakdown,
          stuckRailTransfers,
          unsettledClaimsCount,
          oldestUnverifiedObservedAt,
        },
      };
    }

    return {
      status: "ok",
      checkedAt,
      failure: null,
      data: {
        totalOutboundTransfers,
        verifiedInboundDeliveries,
        unverifiedOutboundCount,
        attestedAwaitingDestinationProof,
        railStatusBreakdown,
        stuckRailTransfers,
        unsettledClaimsCount,
        oldestUnverifiedObservedAt,
      },
    };
  } catch (error) {
    return {
      status: "failed",
      checkedAt,
      failure: normalizeProbeError(error),
      data: null,
    };
  }
}

function combineProbeStatuses(statuses: readonly ProbeStatus[]): ProbeStatus {
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("degraded")) return "degraded";
  return "ok";
}

/**
 * Generate a complete, credential-free operational diagnostics bundle.
 */
export async function generateDiagnosticsBundle(
  options: GenerateDiagnosticsOptions,
): Promise<DiagnosticsBundle> {
  const now = options.now?.() ?? new Date();
  const observedAt = now.toISOString();
  const revision = buildDiagnosticsRevision(options.config);

  const configuration: ProbeSection<SanitizedConfigSummary> = {
    status: "ok",
    checkedAt: observedAt,
    failure: null,
    data: buildSanitizedConfigSummary(options.config, options.requestHeaders),
  };

  const schema = await probeSchema(options.db, observedAt);
  const workerFreshness = await probeWorkerFreshness(options, now);
  const proofBacklog = await probeProofBacklog(options, observedAt);

  const overallStatus = combineProbeStatuses([
    configuration.status,
    schema.status,
    workerFreshness.status,
    proofBacklog.status,
  ]);

  return {
    bundleVersion: 1,
    service: "hyperion-backend",
    observedAt,
    overallStatus,
    revision,
    probes: {
      configuration,
      schema,
      workerFreshness,
      proofBacklog,
    },
  };
}

export interface RunDiagnosticsCliOptions extends LoadOptions {
  readonly argv?: readonly string[];
  readonly openDb?: (connectionString: string) => Database;
  readonly now?: () => Date;
  readonly writeStdout?: (text: string) => void;
}

/**
 * CLI runner that even captures startup `ConfigError` failures into a valid normalized JSON bundle
 * without printing secret values.
 */
export async function runDiagnosticsCommand(
  options: RunDiagnosticsCliOptions = {},
): Promise<{ readonly exitCode: number; readonly bundle: Record<string, unknown> }> {
  const now = options.now?.() ?? new Date();
  const observedAt = now.toISOString();
  const argv = options.argv ?? process.argv.slice(2);
  let outputFile: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const nextArg = argv[i + 1];
    if (argv[i] === "--output" && typeof nextArg === "string") {
      outputFile = resolvePath(options.cwd ?? process.cwd(), nextArg);
      i += 1;
    }
  }

  let config: AppConfig;
  try {
    config = loadConfig(options);
  } catch (error) {
    const bootLog = createBootLogger(options.env?.LOG_LEVEL ?? process.env.LOG_LEVEL ?? "info");
    const sanitizedSummary = sanitizeDiagnosticText(
      error instanceof Error ? error.message : String(error),
    );
    bootLog.error({ reason: sanitizedSummary }, "diagnostics configuration validation failed");
    const failedBundle: Record<string, unknown> = {
      bundleVersion: 1,
      service: "hyperion-backend",
      observedAt,
      overallStatus: "failed",
      revision: null,
      probes: {
        configuration: {
          status: "failed",
          checkedAt: observedAt,
          failure: {
            category: "configuration_invalid",
            code: "CONFIG_ERROR",
            summary: sanitizedSummary,
            remediation:
              "Supply valid required environment variables and deployment metadata file.",
          },
          data: null,
        },
      },
    };
    const serialized = `${JSON.stringify(failedBundle, null, 2)}\n`;
    if (outputFile !== null) {
      writeFileSync(outputFile, serialized, "utf8");
    } else {
      (options.writeStdout ?? ((s: string) => process.stdout.write(s)))(serialized);
    }
    return { exitCode: 1, bundle: failedBundle };
  }

  const logger = createLogger(config);
  const openDatabase =
    options.openDb ??
    ((conn: string) => Database.open(conn, { applicationName: "hyperion-diagnostics" }));
  const db = openDatabase(config.databaseUrl);

  try {
    const indexer = buildIndexer({ config, logger, db });
    const bundle = await generateDiagnosticsBundle({
      config,
      db,
      readiness: indexer.readiness,
      now: () => now,
    });
    const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
    if (outputFile !== null) {
      writeFileSync(outputFile, serialized, "utf8");
    } else {
      (options.writeStdout ?? ((s: string) => process.stdout.write(s)))(serialized);
    }
    return {
      exitCode: bundle.overallStatus === "failed" ? 1 : 0,
      bundle: bundle as unknown as Record<string, unknown>,
    };
  } finally {
    await db.close();
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolvePath(process.argv[1]) === resolvePath(currentFile)) {
  void runDiagnosticsCommand().then(({ exitCode }) => {
    process.exitCode = exitCode;
  });
}
