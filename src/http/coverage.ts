/**
 * History coverage and indexer freshness metadata for public list endpoints.
 *
 * Distinguishes genuinely empty indexed ranges from incomplete cursor windows and deployments
 * without an indexed Hyperion router, while ensuring API-only processes never claim live watcher
 * freshness without an active ready watcher attached in process.
 */
import { isChainKey, isStellarDeployment } from "@hyperion/protocol";

import type { AppConfig } from "../config/config.js";
import type { Database } from "../db/pool.js";
import { bigintOf, type Row, textOrNull, timestampOrNull } from "../db/rows.js";
import type { ReadinessReport, ReadinessSource } from "../runtime/readiness.js";

export type CoverageStatus = "complete" | "incomplete" | "unavailable";
export type HistoryState = "empty" | "complete" | "incomplete" | "unavailable";

export type CoverageGapKind =
  | "unindexed_deployment"
  | "no_configured_deployments"
  | "missing_cursor"
  | "cursor_behind_start"
  | "unscanned_prefix"
  | "contract_mismatch"
  | "watcher_degraded";

export interface CoverageGap {
  readonly chain: string | null;
  readonly kind: CoverageGapKind;
  readonly fromBlock: string | null;
  readonly toBlock: string | null;
  readonly detail: string;
}

export interface ScannedRange {
  readonly fromBlock: string;
  readonly throughBlock: string;
  readonly throughHash: string | null;
  readonly throughTimestamp: string | null;
}

export interface ChainFreshness {
  readonly mode: "live_watcher" | "stored_cursor" | "unindexed";
  readonly liveWatcherActive: boolean;
  readonly watcherState: "ready" | "degraded" | "down" | null;
  readonly watcherDetail: string | null;
  readonly lastUpdatedAt: string | null;
  readonly lastProcessedAt: string | null;
  readonly cursorAgeMs: number | null;
}

export interface ChainCoverage {
  readonly chain: string;
  readonly family: "stellar" | "evm" | null;
  readonly deployed: boolean;
  readonly router: string | null;
  readonly deployedAtBlock: string | null;
  readonly configuredStartBlock: string | null;
  readonly status: CoverageStatus;
  readonly scannedThrough: ScannedRange | null;
  readonly latestUpdateAt: string | null;
  readonly freshness: ChainFreshness;
  readonly knownGaps: readonly CoverageGap[];
}

export interface HistoryCoverage {
  readonly status: CoverageStatus;
  readonly scope: {
    readonly mode: "requested_chain" | "configured_deployments";
    readonly requestedChain: string | null;
    readonly chains: readonly string[];
  };
  readonly latestUpdateAt: string | null;
  readonly freshness: {
    readonly mode: "live_watcher" | "stored_cursor" | "unindexed";
    readonly liveWatcherActive: boolean;
    readonly evaluatedAt: string;
  };
  readonly chains: readonly ChainCoverage[];
  readonly knownGaps: readonly CoverageGap[];
}

export interface CoverageContext {
  readonly config: AppConfig;
  readonly db: Database;
  readonly readiness: readonly ReadinessSource[];
  readonly now?: (() => Date) | undefined;
}

interface StoredCursor {
  readonly chainKey: string;
  readonly family: string | null;
  readonly contract: string | null;
  readonly lastProcessed: bigint;
  readonly lastProcessedHash: string | null;
  readonly lastProcessedAt: Date | null;
  readonly updatedAt: Date | null;
}

const CURSOR_COVERAGE_SQL = `
  SELECT chain_key,
         family,
         contract,
         last_processed,
         last_processed_hash,
         last_processed_at,
         updated_at
    FROM indexer_cursor
`;

/**
 * Scrub credentials, query secrets, bearer tokens, and Stellar secret seeds from diagnostic strings
 * so public metadata never leaks sensitive connection or RPC details.
 */
export function sanitizeCoverageDetail(detail: string): string {
  return detail
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, "$1[REDACTED]@")
    .replace(
      /([?&](?:api[_-]?key|apikey|token|secret|password|auth|access_token)=)[^&\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bS[A-Z2-7]{55}\b/g, "[REDACTED_STELLAR_SECRET]");
}

function parseStoredCursor(row: Row): StoredCursor | null {
  const chainKey = textOrNull(row, "chain_key");
  if (chainKey === null) return null;

  let lastProcessed: bigint | null = null;
  if (row.last_processed !== undefined && row.last_processed !== null) {
    lastProcessed = bigintOf(row, "last_processed");
  } else if (row.cursor_block !== undefined && row.cursor_block !== null) {
    lastProcessed = bigintOf(row, "cursor_block");
  }
  if (lastProcessed === null) return null;

  return {
    chainKey,
    family: textOrNull(row, "family"),
    contract: textOrNull(row, "contract"),
    lastProcessed,
    lastProcessedHash: textOrNull(row, "last_processed_hash") ?? textOrNull(row, "cursor_hash"),
    lastProcessedAt: timestampOrNull(row, "last_processed_at"),
    updatedAt: timestampOrNull(row, "updated_at"),
  };
}

async function readStoredCursors(
  db: Database,
  chains: readonly string[],
): Promise<ReadonlyMap<string, StoredCursor>> {
  if (chains.length === 0) return new Map();

  const { rows } = await db.query(`${CURSOR_COVERAGE_SQL} WHERE chain_key = ANY($1::text[])`, [
    chains,
  ]);
  const byChain = new Map<string, StoredCursor>();
  for (const row of rows) {
    const parsed = parseStoredCursor(row);
    if (parsed !== null && chains.includes(parsed.chainKey)) {
      byChain.set(parsed.chainKey, parsed);
    }
  }
  return byChain;
}

function isChainConfiguredForLiveWatch(config: AppConfig, chain: string): boolean {
  if (!config.indexer.enabled) return false;
  if (config.indexer.stellar?.chain === chain) return true;
  return config.indexer.evm.some((entry) => entry.chain === chain);
}

async function readLiveWatcherReports(
  config: AppConfig,
  readiness: readonly ReadinessSource[],
  chains: readonly string[],
): Promise<ReadonlyMap<string, ReadinessReport>> {
  const reports = new Map<string, ReadinessReport>();
  if (!config.indexer.enabled || readiness.length === 0 || chains.length === 0) {
    return reports;
  }

  const targetChains = new Set(
    chains.filter((chain) => isChainConfiguredForLiveWatch(config, chain)),
  );
  if (targetChains.size === 0) return reports;

  const settled = await Promise.all(
    readiness.map(async (source) => {
      try {
        return await source.readiness();
      } catch {
        return null;
      }
    }),
  );

  for (const report of settled) {
    if (report !== null && targetChains.has(report.name)) {
      reports.set(report.name, report);
    }
  }
  return reports;
}

function contractMatches(
  family: "stellar" | "evm",
  expectedRouter: string,
  actualContract: string,
): boolean {
  if (family === "evm") {
    return expectedRouter.toLowerCase() === actualContract.toLowerCase();
  }
  return expectedRouter === actualContract;
}

function buildChainCoverage(
  chain: string,
  config: AppConfig,
  cursor: StoredCursor | undefined,
  watcherReport: ReadinessReport | undefined,
  now: Date,
): ChainCoverage {
  const deployment = isChainKey(chain) ? config.deployments.networks[chain] : undefined;

  if (deployment === undefined) {
    const gap: CoverageGap = {
      chain,
      kind: "unindexed_deployment",
      fromBlock: null,
      toBlock: null,
      detail: `no Hyperion router is deployed or indexed for chain ${chain} in the ${config.network} deployment set`,
    };
    return {
      chain,
      family: null,
      deployed: false,
      router: null,
      deployedAtBlock: null,
      configuredStartBlock: null,
      status: "unavailable",
      scannedThrough: null,
      latestUpdateAt: null,
      freshness: {
        mode: "unindexed",
        liveWatcherActive: false,
        watcherState: null,
        watcherDetail: null,
        lastUpdatedAt: null,
        lastProcessedAt: null,
        cursorAgeMs: null,
      },
      knownGaps: [gap],
    };
  }

  let family: "stellar" | "evm";
  let deployedAtBlock: bigint;
  let configuredStartBlock: bigint;
  const router = deployment.router;

  if (isStellarDeployment(deployment)) {
    family = "stellar";
    deployedAtBlock = BigInt(deployment.deployedAt.ledger);
    configuredStartBlock = BigInt(
      config.indexer.stellar?.chain === chain
        ? config.indexer.stellar.startLedger
        : deployment.deployedAt.ledger,
    );
  } else {
    family = "evm";
    deployedAtBlock = BigInt(deployment.deployedAt.blockNumber);
    const evmWatch = config.indexer.evm.find((entry) => entry.chain === chain);
    configuredStartBlock = evmWatch
      ? evmWatch.startBlock
      : BigInt(deployment.deployedAt.blockNumber);
  }

  const knownGaps: CoverageGap[] = [];

  if (configuredStartBlock > deployedAtBlock) {
    knownGaps.push({
      chain,
      kind: "unscanned_prefix",
      fromBlock: deployedAtBlock.toString(),
      toBlock: (configuredStartBlock - 1n).toString(),
      detail: `configured start position ${configuredStartBlock.toString()} skips blocks after deployment height ${deployedAtBlock.toString()}`,
    });
  }

  if (cursor === undefined) {
    knownGaps.push({
      chain,
      kind: "missing_cursor",
      fromBlock: configuredStartBlock.toString(),
      toBlock: null,
      detail: `no indexer cursor has been recorded yet for ${chain}`,
    });
  } else {
    if (cursor.contract !== null && !contractMatches(family, router, cursor.contract)) {
      knownGaps.push({
        chain,
        kind: "contract_mismatch",
        fromBlock: configuredStartBlock.toString(),
        toBlock: cursor.lastProcessed.toString(),
        detail: `stored cursor tracks contract ${cursor.contract} instead of configured router ${router}`,
      });
    }
    if (cursor.lastProcessed < configuredStartBlock) {
      knownGaps.push({
        chain,
        kind: "cursor_behind_start",
        fromBlock: cursor.lastProcessed.toString(),
        toBlock: configuredStartBlock.toString(),
        detail: `stored cursor at ${cursor.lastProcessed.toString()} has not reached start position ${configuredStartBlock.toString()}`,
      });
    }
  }

  const sanitizedWatcherDetail =
    watcherReport !== undefined ? sanitizeCoverageDetail(watcherReport.detail) : null;

  if (watcherReport !== undefined && watcherReport.state !== "ready") {
    knownGaps.push({
      chain,
      kind: "watcher_degraded",
      fromBlock:
        cursor !== undefined ? cursor.lastProcessed.toString() : configuredStartBlock.toString(),
      toBlock: null,
      detail: sanitizeCoverageDetail(watcherReport.detail),
    });
  }

  const liveWatcherActive = watcherReport?.state === "ready";
  const lastUpdatedAt = cursor?.updatedAt ? cursor.updatedAt.toISOString() : null;
  const lastProcessedAt = cursor?.lastProcessedAt ? cursor.lastProcessedAt.toISOString() : null;
  const cursorAgeMs =
    cursor?.updatedAt !== undefined && cursor.updatedAt !== null
      ? Math.max(0, now.getTime() - cursor.updatedAt.getTime())
      : null;

  const scannedThrough: ScannedRange | null =
    cursor !== undefined
      ? {
          fromBlock: configuredStartBlock.toString(),
          throughBlock: cursor.lastProcessed.toString(),
          throughHash: cursor.lastProcessedHash,
          throughTimestamp: lastProcessedAt,
        }
      : null;

  return {
    chain,
    family,
    deployed: true,
    router,
    deployedAtBlock: deployedAtBlock.toString(),
    configuredStartBlock: configuredStartBlock.toString(),
    status: knownGaps.length === 0 ? "complete" : "incomplete",
    scannedThrough,
    latestUpdateAt: lastUpdatedAt,
    freshness: {
      mode: liveWatcherActive ? "live_watcher" : "stored_cursor",
      liveWatcherActive,
      watcherState: watcherReport?.state ?? null,
      watcherDetail: sanitizedWatcherDetail,
      lastUpdatedAt,
      lastProcessedAt,
      cursorAgeMs,
    },
    knownGaps,
  };
}

export async function resolveHistoryCoverage(
  ctx: CoverageContext,
  requestedChain?: string,
): Promise<HistoryCoverage> {
  const now = ctx.now ? ctx.now() : new Date();
  const trimmedRequested = requestedChain?.trim() ? requestedChain.trim() : null;

  const targetChains =
    trimmedRequested !== null
      ? [trimmedRequested]
      : Object.keys(ctx.config.deployments.networks).sort((a, b) => a.localeCompare(b));

  if (targetChains.length === 0) {
    const gap: CoverageGap = {
      chain: null,
      kind: "no_configured_deployments",
      fromBlock: null,
      toBlock: null,
      detail: `no Hyperion router deployments are configured for network ${ctx.config.network}`,
    };
    return {
      status: "unavailable",
      scope: {
        mode: "configured_deployments",
        requestedChain: null,
        chains: [],
      },
      latestUpdateAt: null,
      freshness: {
        mode: "unindexed",
        liveWatcherActive: false,
        evaluatedAt: now.toISOString(),
      },
      chains: [],
      knownGaps: [gap],
    };
  }

  const [cursorsByChain, watcherReports] = await Promise.all([
    readStoredCursors(ctx.db, targetChains),
    readLiveWatcherReports(ctx.config, ctx.readiness, targetChains),
  ]);

  const chainEntries = targetChains.map((chain) =>
    buildChainCoverage(
      chain,
      ctx.config,
      cursorsByChain.get(chain),
      watcherReports.get(chain),
      now,
    ),
  );

  const knownGaps = chainEntries.flatMap((entry) => entry.knownGaps);

  let status: CoverageStatus;
  if (chainEntries.every((entry) => entry.status === "unavailable")) {
    status = "unavailable";
  } else if (chainEntries.every((entry) => entry.status === "complete")) {
    status = "complete";
  } else {
    status = "incomplete";
  }

  let latestUpdateDate: Date | null = null;
  for (const entry of chainEntries) {
    if (entry.latestUpdateAt !== null) {
      const parsed = new Date(entry.latestUpdateAt);
      if (latestUpdateDate === null || parsed.getTime() > latestUpdateDate.getTime()) {
        latestUpdateDate = parsed;
      }
    }
  }

  const deployedEntries = chainEntries.filter((entry) => entry.deployed);
  const allDeployedLive =
    deployedEntries.length > 0 &&
    deployedEntries.every((entry) => entry.freshness.liveWatcherActive);
  const freshnessMode: "live_watcher" | "stored_cursor" | "unindexed" =
    deployedEntries.length === 0 ? "unindexed" : allDeployedLive ? "live_watcher" : "stored_cursor";

  return {
    status,
    scope: {
      mode: trimmedRequested !== null ? "requested_chain" : "configured_deployments",
      requestedChain: trimmedRequested,
      chains: targetChains,
    },
    latestUpdateAt: latestUpdateDate !== null ? latestUpdateDate.toISOString() : null,
    freshness: {
      mode: freshnessMode,
      liveWatcherActive: allDeployedLive,
      evaluatedAt: now.toISOString(),
    },
    chains: chainEntries,
    knownGaps,
  };
}

export function deriveHistoryState(itemCount: number, coverage: HistoryCoverage): HistoryState {
  if (coverage.status === "unavailable") return "unavailable";
  if (coverage.status === "incomplete") return "incomplete";
  return itemCount === 0 ? "empty" : "complete";
}
