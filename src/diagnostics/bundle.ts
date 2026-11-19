/**
 * Sanitized read-only operational diagnostics bundle (#113).
 *
 * Collects configuration, schema/migration state, durable worker freshness,
 * freshness SLO evaluation, destination proof backlog, and database pool/query
 * telemetry without executing any mutating SQL or exposing credentials.
 */
import type { AppConfig } from "../config/config.js";
import type { Queryable } from "../db/pool.js";
import type { DbTelemetrySnapshot } from "../db/telemetry.js";
import { readWorkerHeartbeats, evaluateHeartbeatFreshness } from "../runtime/readiness.js";
import { sanitizeDiagnosticText } from "../logging/logger.js";
import { classifySqlWorkload } from "../db/telemetry.js";
import { integer, text, textOrNull, timestampOrNull } from "../db/rows.js";
import { evaluateFreshnessSlo, type FreshnessSloReport } from "../runtime/freshness.js";

const SENSITIVE_KEY_RE =
  /password|secret|authorization|signer|private.?key|api.?key|token|seed|mnemonic|cookie|connection.?string/i;

const CORE_TABLES = [
  "outbound_transfer",
  "inbound_delivery",
  "pending_claim",
  "rail_attestation",
  "indexer_cursor",
  "indexer_worker_heartbeat",
  "indexed_history_digest",
  "indexer_lease",
  "stellar_history_gap",
  "stellar_backfill_cursor",
  "route_health",
] as const;

export interface DiagnosticsDb extends Queryable {
  telemetrySnapshot?(): DbTelemetrySnapshot;
}

export interface GenerateDiagnosticsOptions {
  readonly config: AppConfig;
  readonly db: DiagnosticsDb;
  readonly now?: Date;
  readonly revision?: string;
}

export interface DiagnosticsBundle {
  readonly metadata: {
    readonly generatedAt: string;
    readonly service: "hyperion-backend";
    readonly network: AppConfig["network"];
    readonly deploymentMode: AppConfig["deploymentMode"];
    readonly readOnly: true;
    readonly revision: string | null;
  };
  readonly probes: readonly {
    readonly workload: string;
    readonly table: string | null;
    readonly status: "ok" | "failed";
    readonly code: string | null;
    readonly detail: string;
  }[];
  readonly config: Record<string, unknown>;
  readonly schema: {
    readonly migrationsAvailable: boolean;
    readonly migrations: readonly { readonly name: string; readonly runOn: string | null }[];
    readonly tableCounts: Readonly<Record<string, number | null>>;
  };
  readonly workerFreshness: {
    readonly heartbeats: readonly Record<string, unknown>[];
    readonly cursors: readonly Record<string, unknown>[];
    readonly leases: readonly Record<string, unknown>[];
    readonly historyGaps: {
      readonly counts: {
        readonly open: number;
        readonly reconciling: number;
        readonly reconciled: number;
      };
      readonly active: readonly Record<string, unknown>[];
    };
    readonly backfillCursors: readonly Record<string, unknown>[];
    readonly freshnessSlo: FreshnessSloReport;
  };
  readonly proofBacklog: {
    readonly lanes: FreshnessSloReport["lanes"];
    readonly railAttestations: Readonly<Record<string, number>>;
    readonly claims: {
      readonly total: number;
      readonly settled: number;
      readonly unsettled: number;
    };
  };
  readonly databaseTelemetry: DbTelemetrySnapshot | null;
}

/** RPC paths and query strings can contain tokens; keep only credential-free origins. */
export function sanitizeUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.origin
      : "[redacted-url]";
  } catch {
    return "[redacted-url]";
  }
}

export function sanitizeDiagnosticsValue<T>(value: T, depth = 0): T {
  if (depth > 8) return null as T;
  if (typeof value === "string")
    return sanitizeDiagnosticText(value).replace(/\bS[A-Z2-7]{55}\b/g, "[redacted signer]") as T;
  if (typeof value === "bigint") {
    return value.toString() as unknown as T;
  }
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    return items
      .slice(0, 128)
      .map((item) => sanitizeDiagnosticsValue(item, depth + 1)) as unknown as T;
  }
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 64)) {
      if (SENSITIVE_KEY_RE.test(k)) {
        out[k] = "[redacted]";
      } else {
        out[k] = sanitizeDiagnosticsValue(v, depth + 1);
      }
    }
    return out as T;
  }
  return value;
}

function scalarText(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return null;
}

export function sanitizeDiagnosticsConfig(config: AppConfig): Record<string, unknown> {
  return {
    nodeEnv: config.nodeEnv,
    logLevel: config.logLevel,
    network: config.network,
    deploymentMode: config.deploymentMode,
    http: config.http,
    deploymentsFile: config.deploymentsFile,
    hasDatabaseUrl: config.databaseUrl.length > 0,
    hasRedisUrl: config.redisUrl.length > 0,
    readinessPolicy: config.readinessPolicy,
    freshnessSlo: config.freshnessSlo,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
    indexer: {
      enabled: config.indexer.enabled,
      stellar:
        config.indexer.stellar === null
          ? null
          : {
              chain: config.indexer.stellar.chain,
              rpcUrl: sanitizeUrl(config.indexer.stellar.rpcUrl),
              historicalRpcUrl: config.indexer.stellar.historicalRpcUrl
                ? sanitizeUrl(config.indexer.stellar.historicalRpcUrl)
                : null,
              routerContractId: config.indexer.stellar.routerContractId,
              startLedger: config.indexer.stellar.startLedger,
              pageSize: config.indexer.stellar.pageSize,
              pollIntervalMs: config.indexer.stellar.pollIntervalMs,
            },
      evm: config.indexer.evm.map((chain) => ({
        chain: chain.chain,
        chainId: chain.chainId,
        rpcUrls: chain.rpcUrls.map(sanitizeUrl),
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
      irisUrl: sanitizeUrl(config.rails.irisUrl),
      axelarUrl: sanitizeUrl(config.rails.axelarUrl),
      pollIntervalMs: config.rails.pollIntervalMs,
      batchSize: config.rails.batchSize,
      recheckAfterMs: config.rails.recheckAfterMs,
      maxCheckFailures: config.rails.maxCheckFailures,
    },
    keeper: {
      enabled: config.keeper.enabled,
      pollIntervalMs: config.keeper.pollIntervalMs,
      concurrency: config.keeper.concurrency,
      hasStellarSecret: config.keeper.stellarSecret !== null,
    },
  };
}

export async function generateDiagnosticsBundle(
  options: GenerateDiagnosticsOptions,
): Promise<DiagnosticsBundle> {
  const { config } = options;
  const probes: {
    workload: string;
    table: string | null;
    status: "ok" | "failed";
    code: string | null;
    detail: string;
  }[] = [];
  const db: DiagnosticsDb = {
    query: async (sql, params) => {
      const workload = classifySqlWorkload(sql);
      const table = /\bFROM\s+([a-z_]+)/i.exec(sql)?.[1] ?? null;
      try {
        const result = await options.db.query(sql, params);
        probes.push({ workload, table, status: "ok", code: null, detail: "read completed" });
        return result;
      } catch (error) {
        const rawCode =
          typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
        const code = /^[A-Z0-9]{5}$/.test(rawCode) ? rawCode : null;
        const detail =
          code === "42P01"
            ? "table unavailable; apply repository migrations"
            : code === "42703"
              ? "schema mismatch; check deployed code and migrations"
              : code === "57014"
                ? "database read timed out; check workload and saturation"
                : code?.startsWith("28")
                  ? "database authentication failed; verify configured credentials"
                  : "database read failed; verify connectivity and schema";
        probes.push({ workload, table, status: "failed", code, detail });
        throw error;
      }
    },
  };
  const now = options.now ?? new Date();

  const [
    schema,
    cursors,
    leases,
    historyGaps,
    backfillCursors,
    freshnessSlo,
    railAttestations,
    claims,
    heartbeats,
  ] = await Promise.all([
    readSchemaStatus(db),
    readCursors(db),
    readLeases(db),
    readHistoryGaps(db),
    readBackfillCursors(db),
    evaluateFreshnessSlo(db, config, now).catch(() => ({
      evaluatedAt: now.toISOString(),
      status: "unknown" as const,
      met: false,
      breaches: [],
      sources: [],
      lanes: [],
    })),
    readRailAttestations(db),
    readClaims(db),
    readWorkerHeartbeats(db)
      .then((records) =>
        records.map((hb) => ({
          name: hb.workerName,
          kind: hb.workerKind,
          chain: hb.chainKey,
          state: evaluateHeartbeatFreshness(hb, now).report.state,
          detail: evaluateHeartbeatFreshness(hb, now).report.detail,
          lastHeartbeatAt: hb.lastHeartbeatAt.toISOString(),
          lastCompletedAt: hb.lastCompletedAt?.toISOString() ?? null,
          cursorBlock: hb.lastCursorBlock,
          lastError: hb.lastError,
        })),
      )
      .catch(() => []),
  ]);

  const bundle: DiagnosticsBundle = {
    metadata: {
      generatedAt: now.toISOString(),
      service: "hyperion-backend",
      network: config.network,
      deploymentMode: config.deploymentMode,
      readOnly: true,
      revision:
        options.revision && /^[a-f0-9]{7,64}$/i.test(options.revision) ? options.revision : null,
    },
    probes,
    config: sanitizeDiagnosticsConfig(config),
    schema,
    workerFreshness: {
      heartbeats,
      cursors,
      leases,
      historyGaps,
      backfillCursors,
      freshnessSlo,
    },
    proofBacklog: {
      lanes: freshnessSlo.lanes,
      railAttestations,
      claims,
    },
    databaseTelemetry:
      typeof options.db.telemetrySnapshot === "function" ? options.db.telemetrySnapshot() : null,
  };

  return sanitizeDiagnosticsValue(bundle);
}

async function readSchemaStatus(db: Queryable): Promise<DiagnosticsBundle["schema"]> {
  let migrationsAvailable = true;
  let migrations: { name: string; runOn: string | null }[] = [];

  try {
    const res = await db.query("SELECT name, run_on FROM pgmigrations ORDER BY id DESC LIMIT 25");
    migrations = res.rows
      .filter((row) => typeof row.name === "string")
      .map((row) => {
        const runOn = timestampOrNull(row, "run_on");
        return {
          name: text(row, "name"),
          runOn: runOn !== null ? runOn.toISOString() : null,
        };
      });
  } catch {
    migrationsAvailable = false;
  }

  const tableCounts: Record<string, number | null> = {};
  for (const table of CORE_TABLES) {
    try {
      const res = await db.query(`SELECT count(*)::int AS count FROM ${table}`);
      tableCounts[table] = res.rows[0] ? integer(res.rows[0], "count") : 0;
    } catch {
      tableCounts[table] = null;
    }
  }

  return { migrationsAvailable, migrations, tableCounts };
}

async function readCursors(db: Queryable): Promise<readonly Record<string, unknown>[]> {
  try {
    const res = await db.query(
      "SELECT chain_key, last_processed AS cursor_block, last_processed_hash AS cursor_hash, revision, updated_at FROM indexer_cursor ORDER BY chain_key",
    );
    return res.rows
      .filter((row) => typeof row.chain_key === "string")
      .map((row) => {
        const updatedAt = timestampOrNull(row, "updated_at");
        const blockRaw = row.cursor_block ?? row.last_processed;
        return {
          chain: text(row, "chain_key"),
          block: scalarText(blockRaw) ?? "0",
          hash: textOrNull(row, "cursor_hash"),
          revision: scalarText(row.revision),
          updatedAt: updatedAt !== null ? updatedAt.toISOString() : null,
        };
      });
  } catch {
    return [];
  }
}

async function readLeases(db: Queryable): Promise<readonly Record<string, unknown>[]> {
  try {
    const res = await db.query(
      "SELECT chain_key, contract, owner_id, lease_until, updated_at FROM indexer_lease ORDER BY chain_key, contract",
    );
    return res.rows
      .filter((row) => typeof row.chain_key === "string")
      .map((row) => {
        const leaseUntil = timestampOrNull(row, "lease_until");
        const updatedAt = timestampOrNull(row, "updated_at");
        return {
          chain: text(row, "chain_key"),
          contract: text(row, "contract"),
          ownerId: text(row, "owner_id"),
          leaseUntil: leaseUntil !== null ? leaseUntil.toISOString() : null,
          updatedAt: updatedAt !== null ? updatedAt.toISOString() : null,
        };
      });
  } catch {
    return [];
  }
}

async function readHistoryGaps(
  db: Queryable,
): Promise<DiagnosticsBundle["workerFreshness"]["historyGaps"]> {
  const counts = { open: 0, reconciling: 0, reconciled: 0 };
  try {
    const countRes = await db.query(
      "SELECT status, count(*)::int AS count FROM stellar_history_gap GROUP BY status",
    );
    for (const row of countRes.rows) {
      if (typeof row.status !== "string") continue;
      const status = text(row, "status");
      const count = integer(row, "count");
      if (status === "open" || status === "reconciling" || status === "reconciled") {
        counts[status] = count;
      }
    }
  } catch {
    // Table may not exist on older schemas.
  }

  let active: Record<string, unknown>[] = [];
  try {
    const activeRes = await db.query(
      `SELECT chain_key, contract, start_ledger, end_ledger, status, replayed_through, reason, detected_at
         FROM stellar_history_gap
        WHERE status IN ('open', 'reconciling')
        ORDER BY detected_at ASC
        LIMIT 20`,
    );
    active = activeRes.rows
      .filter((row) => typeof row.chain_key === "string")
      .map((row) => {
        const detectedAt = timestampOrNull(row, "detected_at");
        return {
          chain: text(row, "chain_key"),
          contract: text(row, "contract"),
          startLedger: scalarText(row.start_ledger) ?? "",
          endLedger: scalarText(row.end_ledger) ?? "",
          status: text(row, "status"),
          replayedThrough: scalarText(row.replayed_through),
          reason: text(row, "reason"),
          detectedAt: detectedAt !== null ? detectedAt.toISOString() : null,
        };
      });
  } catch {
    active = [];
  }

  return { counts, active };
}

async function readBackfillCursors(db: Queryable): Promise<readonly Record<string, unknown>[]> {
  try {
    const res = await db.query(
      `SELECT chain_key, contract, job_key, start_ledger, end_ledger, next_ledger, status, updated_at
         FROM stellar_backfill_cursor
        ORDER BY chain_key, job_key`,
    );
    return res.rows
      .filter((row) => typeof row.chain_key === "string")
      .map((row) => {
        const updatedAt = timestampOrNull(row, "updated_at");
        return {
          chain: text(row, "chain_key"),
          contract: text(row, "contract"),
          jobKey: text(row, "job_key"),
          startLedger: scalarText(row.start_ledger) ?? "",
          endLedger: scalarText(row.end_ledger) ?? "",
          nextLedger: scalarText(row.next_ledger) ?? "",
          status: text(row, "status"),
          updatedAt: updatedAt !== null ? updatedAt.toISOString() : null,
        };
      });
  } catch {
    return [];
  }
}

async function readRailAttestations(db: Queryable): Promise<Readonly<Record<string, number>>> {
  const counts: Record<string, number> = {};
  try {
    const res = await db.query(
      "SELECT status, count(*)::int AS count FROM rail_attestation GROUP BY status",
    );
    for (const row of res.rows) {
      if (typeof row.status !== "string") continue;
      counts[text(row, "status")] = integer(row, "count");
    }
  } catch {
    // Ignore if unavailable
  }
  return counts;
}

async function readClaims(
  db: Queryable,
): Promise<{ readonly total: number; readonly settled: number; readonly unsettled: number }> {
  try {
    const res = await db.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE settled = true)::int AS settled,
              count(*) FILTER (WHERE settled = false)::int AS unsettled
         FROM pending_claim`,
    );
    const row = res.rows[0];
    if (!row) return { total: 0, settled: 0, unsettled: 0 };
    return {
      total: integer(row, "total"),
      settled: integer(row, "settled"),
      unsettled: integer(row, "unsettled"),
    };
  } catch {
    return { total: 0, settled: 0, unsettled: 0 };
  }
}
