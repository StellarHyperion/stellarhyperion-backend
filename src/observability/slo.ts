/**
 * Persisted per-lane freshness and destination-proof backlog SLO evaluation.
 *
 * Designed so an API-only replica (`INDEXER_ENABLED=false`, `RAILS_ENABLED=false`) and a separate
 * scheduled or continuous indexer process reach the exact same verdict from PostgreSQL state alone.
 *
 * Two invariants govern every calculation here:
 *
 * 1. A rail provider status (`pending`, `attested`, `complete`, `executed`, or even `delivered` in
 *    `rail_attestation`) never establishes destination delivery on its own. Only a verified
 *    canonical arrival row in `inbound_delivery` settles destination-proof backlog.
 * 2. Intentionally disabled watchers or rail pollers (via `watcher_runtime_state` or
 *    `SLO_DISABLED_WATCHERS`) are reported as `disabled` rather than `breached`, while stalled
 *    enabled watchers breach and name the exact lane and missing progress stage.
 */
import type { ChainKey, RouteKind, RouteSlug } from "@hyperion/protocol";
import {
  RAIL_CONTRACTS,
  ROUTE_KINDS,
  ROUTE_SLUGS,
  RouteKind as RouteKindEnum,
  adapterFor,
  chainsFor,
  deployedChains,
  deploymentFor,
  evmChainsFor,
  isChainKey,
  isEvmDeployment,
  isRouteKind,
  isStellarDeployment,
  stellarChainFor,
  tryRouteFromSlug,
} from "@hyperion/protocol";

import type { AppConfig, LaneSloTargets } from "../config/config.js";
import type { Queryable } from "../db/pool.js";

export type SloProgressStage = "source_scan" | "attestation_poll" | "destination_proof";
export type LaneSloStatus = "healthy" | "breached" | "disabled";
export type OverallSloStatus = "healthy" | "breached" | "disabled";
export type WatcherComponentKind = "chain_watcher" | "rail_poller";

export interface LaneDescriptor {
  readonly laneKey: string;
  readonly originChain: ChainKey;
  readonly destinationChain: ChainKey;
  readonly route: RouteKind;
  readonly routeSlug: RouteSlug;
}

export interface LaneSloBreach {
  readonly laneKey: string;
  readonly originChain: ChainKey;
  readonly destinationChain: ChainKey;
  readonly route: RouteKind;
  readonly routeSlug: RouteSlug;
  readonly missingStage: SloProgressStage;
  readonly breachedStages: readonly SloProgressStage[];
  readonly detail: string;
}

export interface LaneSloEvaluation {
  readonly laneKey: string;
  readonly originChain: ChainKey;
  readonly destinationChain: ChainKey;
  readonly route: RouteKind;
  readonly routeSlug: RouteSlug;
  readonly status: LaneSloStatus;
  readonly missingStage: SloProgressStage | null;
  readonly breachedStages: readonly SloProgressStage[];
  readonly disabledBy: string | null;
  readonly targets: LaneSloTargets;
  readonly sourceScanLagSeconds: number | null;
  readonly sourceCursorUpdatedAt: string | null;
  readonly maxAttestationPollLagSeconds: number | null;
  readonly oldestUndeliveredAgeSeconds: number | null;
  readonly proofBacklogCount: number;
  readonly detail: string;
}

export interface FreshnessSloReport {
  readonly status: OverallSloStatus;
  readonly evaluatedAt: string;
  readonly lanes: readonly LaneSloEvaluation[];
  readonly breaches: readonly LaneSloBreach[];
}

export interface EvaluateFreshnessSloOptions {
  readonly now?: Date | undefined;
  readonly startedAt?: Date | undefined;
}

interface WatcherRuntimeRow {
  readonly componentKey: string;
  readonly componentKind: WatcherComponentKind;
  readonly enabled: boolean;
  readonly registeredAt: Date;
  readonly updatedAt: Date;
}

interface LaneTransferStats {
  readonly originChain: ChainKey;
  readonly destinationChain: ChainKey;
  readonly route: RouteKind;
  readonly totalTransfers: number;
  readonly undeliveredCount: number;
  readonly oldestUndeliveredAt: Date | null;
  readonly oldestAttestationCheckAt: Date | null;
}

export function formatLaneKey(
  originChain: ChainKey,
  destinationChain: ChainKey,
  route: RouteKind,
): string {
  return `${originChain}->${destinationChain}:${ROUTE_SLUGS[route]}`;
}

export function resolveLaneTargets(config: AppConfig, laneKey: string): LaneSloTargets {
  const override = config.slo.laneOverrides[laneKey];
  if (!override) return config.slo.defaults;
  return {
    maxSourceScanLagSeconds:
      override.maxSourceScanLagSeconds ?? config.slo.defaults.maxSourceScanLagSeconds,
    maxAttestationPollLagSeconds:
      override.maxAttestationPollLagSeconds ?? config.slo.defaults.maxAttestationPollLagSeconds,
    maxDestinationProofLagSeconds:
      override.maxDestinationProofLagSeconds ?? config.slo.defaults.maxDestinationProofLagSeconds,
    maxProofBacklog: override.maxProofBacklog ?? config.slo.defaults.maxProofBacklog,
  };
}

export async function setWatcherRuntimeState(
  db: Queryable,
  entry: {
    readonly componentKey: string;
    readonly componentKind: WatcherComponentKind;
    readonly enabled: boolean;
    readonly at?: Date | undefined;
  },
): Promise<void> {
  const at = entry.at ?? new Date();
  try {
    await db.query(
      `INSERT INTO watcher_runtime_state
         (component_key, component_kind, enabled, registered_at, updated_at)
       VALUES ($1, $2, $3, $4, $4)
       ON CONFLICT (component_key) DO UPDATE SET
         component_kind = EXCLUDED.component_kind,
         enabled = EXCLUDED.enabled,
         registered_at = CASE
           WHEN watcher_runtime_state.enabled = false AND EXCLUDED.enabled = true
             THEN EXCLUDED.registered_at
           ELSE watcher_runtime_state.registered_at
         END,
         updated_at = EXCLUDED.updated_at`,
      [entry.componentKey, entry.componentKind, entry.enabled, at],
    );
  } catch (error) {
    if (isUndefinedTableError(error)) return;
    throw error;
  }
}

/**
 * Persist the worker process's active versus intentionally disabled watchers and rail pollers.
 *
 * Called by worker deployments so separate API-only replicas can inspect `watcher_runtime_state`
 * without guessing from local environment flags.
 */
export async function syncWatcherRuntimeState(
  db: Queryable,
  config: AppConfig,
  now: Date = new Date(),
): Promise<void> {
  const disabledSet = new Set(config.slo.disabledWatchers);

  for (const chainKey of deployedChains(config.deployments)) {
    const enabled =
      config.indexer.enabled && !disabledSet.has("indexer") && !disabledSet.has(chainKey);
    await setWatcherRuntimeState(db, {
      componentKey: chainKey,
      componentKind: "chain_watcher",
      enabled,
      at: now,
    });
  }

  for (const railKey of ["rail:cctp", "rail:axelar-its"] as const) {
    const alsoDisabled = railKey === "rail:axelar-its" && disabledSet.has("rail:axelar");
    const enabled =
      config.indexer.enabled &&
      config.rails.enabled &&
      !disabledSet.has("rails") &&
      !disabledSet.has(railKey) &&
      !alsoDisabled;
    await setWatcherRuntimeState(db, {
      componentKey: railKey,
      componentKind: "rail_poller",
      enabled,
      at: now,
    });
  }
}

export async function evaluateFreshnessSlo(
  db: Queryable,
  config: AppConfig,
  options: EvaluateFreshnessSloOptions = {},
): Promise<FreshnessSloReport> {
  const now = options.now ?? new Date();
  const startedAt = options.startedAt ?? now;

  if (!config.slo.enabled) {
    return {
      status: "disabled",
      evaluatedAt: now.toISOString(),
      lanes: [],
      breaches: [],
    };
  }

  const runtimeState = await readWatcherRuntimeState(db);
  const cursors = await readCursors(db);
  const transferStats = await readLaneTransferStats(db);

  const statsByLane = new Map<string, LaneTransferStats>();
  const chainsWithTransfers = new Set<ChainKey>();
  for (const stat of transferStats) {
    const key = formatLaneKey(stat.originChain, stat.destinationChain, stat.route);
    statsByLane.set(key, stat);
    if (stat.totalTransfers > 0) {
      chainsWithTransfers.add(stat.originChain);
    }
  }

  const lanes = deriveLanes(config, transferStats);
  const evaluations: LaneSloEvaluation[] = [];
  const breaches: LaneSloBreach[] = [];

  for (const lane of lanes) {
    const evaluation = evaluateSingleLane({
      lane,
      config,
      now,
      startedAt,
      runtimeState,
      cursors,
      chainsWithTransfers,
      stats: statsByLane.get(lane.laneKey) ?? null,
    });
    evaluations.push(evaluation);
    if (evaluation.status === "breached" && evaluation.missingStage !== null) {
      breaches.push({
        laneKey: evaluation.laneKey,
        originChain: evaluation.originChain,
        destinationChain: evaluation.destinationChain,
        route: evaluation.route,
        routeSlug: evaluation.routeSlug,
        missingStage: evaluation.missingStage,
        breachedStages: evaluation.breachedStages,
        detail: evaluation.detail,
      });
    }
  }

  let status: OverallSloStatus = "healthy";
  if (breaches.length > 0) {
    status = "breached";
  } else if (evaluations.length > 0 && evaluations.every((item) => item.status === "disabled")) {
    status = "disabled";
  }

  return {
    status,
    evaluatedAt: now.toISOString(),
    lanes: evaluations,
    breaches,
  };
}

function evaluateSingleLane(input: {
  readonly lane: LaneDescriptor;
  readonly config: AppConfig;
  readonly now: Date;
  readonly startedAt: Date;
  readonly runtimeState: ReadonlyMap<string, WatcherRuntimeRow>;
  readonly cursors: ReadonlyMap<ChainKey, Date>;
  readonly chainsWithTransfers: ReadonlySet<ChainKey>;
  readonly stats: LaneTransferStats | null;
}): LaneSloEvaluation {
  const { lane, config, now, startedAt, runtimeState, cursors, chainsWithTransfers, stats } = input;
  const targets = resolveLaneTargets(config, lane.laneKey);

  const sourceResolution = resolveSourceWatcherState({
    originChain: lane.originChain,
    config,
    startedAt,
    runtimeState,
    hasPersistedEvidence:
      cursors.has(lane.originChain) || chainsWithTransfers.has(lane.originChain),
  });

  const railResolution = resolveRailAndDestinationState({
    destinationChain: lane.destinationChain,
    route: lane.route,
    routeSlug: lane.routeSlug,
    config,
    runtimeState,
    sourceEnabled: sourceResolution.enabled,
    hasLaneTransfers: (stats?.totalTransfers ?? 0) > 0,
  });

  const cursorUpdatedAt = cursors.get(lane.originChain) ?? null;
  let sourceScanLagSeconds: number | null = null;
  if (cursorUpdatedAt !== null) {
    sourceScanLagSeconds = elapsedSeconds(cursorUpdatedAt, now);
  } else if (sourceResolution.enabled) {
    sourceScanLagSeconds = elapsedSeconds(sourceResolution.registeredAt, now);
  }

  const proofBacklogCount = stats?.undeliveredCount ?? 0;
  const oldestUndeliveredAgeSeconds =
    stats?.oldestUndeliveredAt !== undefined && stats.oldestUndeliveredAt !== null
      ? elapsedSeconds(stats.oldestUndeliveredAt, now)
      : null;
  const maxAttestationPollLagSeconds =
    railResolution.usesRailPoller &&
    stats?.oldestAttestationCheckAt !== undefined &&
    stats.oldestAttestationCheckAt !== null
      ? elapsedSeconds(stats.oldestAttestationCheckAt, now)
      : null;

  const breachedStages: SloProgressStage[] = [];
  const breachReasons: string[] = [];

  if (sourceResolution.enabled) {
    if (sourceScanLagSeconds === null || sourceScanLagSeconds > targets.maxSourceScanLagSeconds) {
      breachedStages.push("source_scan");
      breachReasons.push(
        cursorUpdatedAt === null
          ? `source cursor missing after ${String(sourceScanLagSeconds ?? 0)}s (target <= ${String(targets.maxSourceScanLagSeconds)}s)`
          : `source scan lag ${String(sourceScanLagSeconds)}s exceeds ${String(targets.maxSourceScanLagSeconds)}s`,
      );
    }
  }

  if (railResolution.usesRailPoller && railResolution.railEnabled) {
    if (
      maxAttestationPollLagSeconds !== null &&
      maxAttestationPollLagSeconds > targets.maxAttestationPollLagSeconds
    ) {
      breachedStages.push("attestation_poll");
      breachReasons.push(
        `attestation poll lag ${String(maxAttestationPollLagSeconds)}s exceeds ${String(targets.maxAttestationPollLagSeconds)}s`,
      );
    }
  }

  if (railResolution.destinationEnabled) {
    const backlogBreached = proofBacklogCount > targets.maxProofBacklog;
    const proofAgeBreached =
      oldestUndeliveredAgeSeconds !== null &&
      oldestUndeliveredAgeSeconds > targets.maxDestinationProofLagSeconds;
    if (backlogBreached || proofAgeBreached) {
      breachedStages.push("destination_proof");
      if (backlogBreached) {
        breachReasons.push(
          `destination proof backlog ${String(proofBacklogCount)} exceeds ${String(targets.maxProofBacklog)}`,
        );
      }
      if (proofAgeBreached) {
        breachReasons.push(
          `oldest undelivered transfer age ${String(oldestUndeliveredAgeSeconds)}s exceeds ${String(targets.maxDestinationProofLagSeconds)}s`,
        );
      }
    }
  }

  const disabledReasons: string[] = [];
  if (sourceResolution.disabledBy !== null) disabledReasons.push(sourceResolution.disabledBy);
  if (railResolution.disabledBy !== null) disabledReasons.push(railResolution.disabledBy);
  const disabledBy = disabledReasons.length > 0 ? disabledReasons.join(", ") : null;

  const missingStage = breachedStages[0];
  if (missingStage !== undefined) {
    return {
      laneKey: lane.laneKey,
      originChain: lane.originChain,
      destinationChain: lane.destinationChain,
      route: lane.route,
      routeSlug: lane.routeSlug,
      status: "breached",
      missingStage,
      breachedStages,
      disabledBy,
      targets,
      sourceScanLagSeconds,
      sourceCursorUpdatedAt: cursorUpdatedAt ? cursorUpdatedAt.toISOString() : null,
      maxAttestationPollLagSeconds,
      oldestUndeliveredAgeSeconds,
      proofBacklogCount,
      detail: `${lane.laneKey} missing ${missingStage}: ${breachReasons.join("; ")}`,
    };
  }

  if (disabledBy !== null) {
    return {
      laneKey: lane.laneKey,
      originChain: lane.originChain,
      destinationChain: lane.destinationChain,
      route: lane.route,
      routeSlug: lane.routeSlug,
      status: "disabled",
      missingStage: null,
      breachedStages: [],
      disabledBy,
      targets,
      sourceScanLagSeconds,
      sourceCursorUpdatedAt: cursorUpdatedAt ? cursorUpdatedAt.toISOString() : null,
      maxAttestationPollLagSeconds,
      oldestUndeliveredAgeSeconds,
      proofBacklogCount,
      detail: `${lane.laneKey} intentionally disabled (${disabledBy})`,
    };
  }

  return {
    laneKey: lane.laneKey,
    originChain: lane.originChain,
    destinationChain: lane.destinationChain,
    route: lane.route,
    routeSlug: lane.routeSlug,
    status: "healthy",
    missingStage: null,
    breachedStages: [],
    disabledBy: null,
    targets,
    sourceScanLagSeconds,
    sourceCursorUpdatedAt: cursorUpdatedAt ? cursorUpdatedAt.toISOString() : null,
    maxAttestationPollLagSeconds,
    oldestUndeliveredAgeSeconds,
    proofBacklogCount,
    detail: `${lane.laneKey} within freshness and backlog targets`,
  };
}

function resolveSourceWatcherState(input: {
  readonly originChain: ChainKey;
  readonly config: AppConfig;
  readonly startedAt: Date;
  readonly runtimeState: ReadonlyMap<string, WatcherRuntimeRow>;
  readonly hasPersistedEvidence: boolean;
}): {
  readonly enabled: boolean;
  readonly disabledBy: string | null;
  readonly registeredAt: Date;
} {
  const { originChain, config, startedAt, runtimeState, hasPersistedEvidence } = input;
  const disabledSet = new Set(config.slo.disabledWatchers);

  if (disabledSet.has("indexer")) {
    return {
      enabled: false,
      disabledBy: "config:SLO_DISABLED_WATCHERS=indexer",
      registeredAt: startedAt,
    };
  }
  if (disabledSet.has(originChain)) {
    return {
      enabled: false,
      disabledBy: `config:SLO_DISABLED_WATCHERS=${originChain}`,
      registeredAt: startedAt,
    };
  }

  const persisted = runtimeState.get(originChain);
  if (persisted !== undefined) {
    if (!persisted.enabled) {
      return {
        enabled: false,
        disabledBy: `watcher_runtime_state:${originChain}`,
        registeredAt: persisted.registeredAt,
      };
    }
    return {
      enabled: true,
      disabledBy: null,
      registeredAt: persisted.registeredAt,
    };
  }

  if (hasPersistedEvidence) {
    return {
      enabled: true,
      disabledBy: null,
      registeredAt: startedAt,
    };
  }

  if (config.indexer.enabled && deploymentFor(config.deployments, originChain) !== null) {
    return {
      enabled: true,
      disabledBy: null,
      registeredAt: startedAt,
    };
  }

  return {
    enabled: false,
    disabledBy: "config:INDEXER_ENABLED=false",
    registeredAt: startedAt,
  };
}

function resolveRailAndDestinationState(input: {
  readonly destinationChain: ChainKey;
  readonly route: RouteKind;
  readonly routeSlug: RouteSlug;
  readonly config: AppConfig;
  readonly runtimeState: ReadonlyMap<string, WatcherRuntimeRow>;
  readonly sourceEnabled: boolean;
  readonly hasLaneTransfers: boolean;
}): {
  readonly usesRailPoller: boolean;
  readonly railEnabled: boolean;
  readonly destinationEnabled: boolean;
  readonly disabledBy: string | null;
} {
  const {
    destinationChain,
    route,
    routeSlug,
    config,
    runtimeState,
    sourceEnabled,
    hasLaneTransfers,
  } = input;
  const usesRailPoller = route === RouteKindEnum.Cctp || route === RouteKindEnum.AxelarIts;
  const disabledSet = new Set(config.slo.disabledWatchers);
  const railKey = `rail:${routeSlug}`;
  const legacyAxelarKey = route === RouteKindEnum.AxelarIts ? "rail:axelar" : null;

  if (disabledSet.has(destinationChain)) {
    return {
      usesRailPoller,
      railEnabled: false,
      destinationEnabled: false,
      disabledBy: `config:SLO_DISABLED_WATCHERS=${destinationChain}`,
    };
  }

  if (usesRailPoller) {
    if (disabledSet.has("rails")) {
      return {
        usesRailPoller: true,
        railEnabled: false,
        destinationEnabled: false,
        disabledBy: "config:SLO_DISABLED_WATCHERS=rails",
      };
    }
    if (disabledSet.has(railKey)) {
      return {
        usesRailPoller: true,
        railEnabled: false,
        destinationEnabled: false,
        disabledBy: `config:SLO_DISABLED_WATCHERS=${railKey}`,
      };
    }
    if (legacyAxelarKey !== null && disabledSet.has(legacyAxelarKey)) {
      return {
        usesRailPoller: true,
        railEnabled: false,
        destinationEnabled: false,
        disabledBy: `config:SLO_DISABLED_WATCHERS=${legacyAxelarKey}`,
      };
    }

    const persistedRail =
      runtimeState.get(railKey) ??
      (legacyAxelarKey !== null ? runtimeState.get(legacyAxelarKey) : undefined);
    if (persistedRail !== undefined) {
      if (!persistedRail.enabled) {
        return {
          usesRailPoller: true,
          railEnabled: false,
          destinationEnabled: false,
          disabledBy: `watcher_runtime_state:${persistedRail.componentKey}`,
        };
      }
      return {
        usesRailPoller: true,
        railEnabled: true,
        destinationEnabled: true,
        disabledBy: null,
      };
    }

    if (config.indexer.enabled && !config.rails.enabled) {
      return {
        usesRailPoller: true,
        railEnabled: false,
        destinationEnabled: false,
        disabledBy: "config:RAILS_ENABLED=false",
      };
    }

    const active = sourceEnabled || hasLaneTransfers;
    return {
      usesRailPoller: true,
      railEnabled: active,
      destinationEnabled: active,
      disabledBy: active ? null : "config:RAILS_ENABLED=false",
    };
  }

  const destPersisted = runtimeState.get(destinationChain);
  if (destPersisted !== undefined && !destPersisted.enabled) {
    return {
      usesRailPoller: false,
      railEnabled: false,
      destinationEnabled: false,
      disabledBy: `watcher_runtime_state:${destinationChain}`,
    };
  }

  const active = sourceEnabled || hasLaneTransfers;
  return {
    usesRailPoller: false,
    railEnabled: false,
    destinationEnabled: active,
    disabledBy: active ? null : `config:INDEXER_ENABLED=false`,
  };
}

function deriveLanes(
  config: AppConfig,
  observedStats: readonly LaneTransferStats[],
): readonly LaneDescriptor[] {
  const byKey = new Map<string, LaneDescriptor>();
  const allowedChains = new Set(chainsFor(config.network).map((entry) => entry.key));
  const addLane = (originChain: ChainKey, destinationChain: ChainKey, route: RouteKind): void => {
    if (!allowedChains.has(originChain) || !allowedChains.has(destinationChain)) return;
    const laneKey = formatLaneKey(originChain, destinationChain, route);
    if (!byKey.has(laneKey)) {
      byKey.set(laneKey, {
        laneKey,
        originChain,
        destinationChain,
        route,
        routeSlug: ROUTE_SLUGS[route],
      });
    }
  };

  const stellarChain = stellarChainFor(config.network);
  const evmChains = evmChainsFor(config.network);

  for (const originChain of deployedChains(config.deployments)) {
    const deployment = deploymentFor(config.deployments, originChain);
    if (!deployment) continue;

    if (isStellarDeployment(deployment)) {
      if (adapterFor(config.deployments, originChain, RouteKindEnum.Cctp) !== null) {
        for (const evmChain of evmChains) {
          if (evmChain.cctpDomain !== null && Boolean(RAIL_CONTRACTS[evmChain.key]?.cctp)) {
            addLane(originChain, evmChain.key, RouteKindEnum.Cctp);
          }
        }
      }
      if (adapterFor(config.deployments, originChain, RouteKindEnum.AxelarIts) !== null) {
        const itsPeer: ChainKey = config.network === "testnet" ? "sepolia" : "ethereum";
        addLane(originChain, itsPeer, RouteKindEnum.AxelarIts);
      }
      continue;
    }

    if (isEvmDeployment(deployment)) {
      for (const route of ROUTE_KINDS) {
        if (adapterFor(config.deployments, originChain, route) !== null) {
          addLane(originChain, stellarChain.key, route);
        }
      }
    }
  }

  for (const stat of observedStats) {
    addLane(stat.originChain, stat.destinationChain, stat.route);
  }

  for (const laneKey of Object.keys(config.slo.laneOverrides)) {
    const parsed = parseLaneKey(laneKey);
    if (parsed !== null) {
      addLane(parsed.originChain, parsed.destinationChain, parsed.route);
    }
  }

  return [...byKey.values()].sort((a, b) => a.laneKey.localeCompare(b.laneKey));
}

function parseLaneKey(laneKey: string): {
  readonly originChain: ChainKey;
  readonly destinationChain: ChainKey;
  readonly route: RouteKind;
} | null {
  const match = /^([a-z0-9-]+)->([a-z0-9-]+):([a-z0-9-]+)$/.exec(laneKey);
  if (!match) return null;
  const [, origin, destination, slug] = match;
  if (!origin || !destination || !slug || !isChainKey(origin) || !isChainKey(destination)) {
    return null;
  }
  const route = tryRouteFromSlug(slug);
  if (route === null) return null;
  return { originChain: origin, destinationChain: destination, route };
}

async function readWatcherRuntimeState(
  db: Queryable,
): Promise<ReadonlyMap<string, WatcherRuntimeRow>> {
  try {
    const { rows } = await db.query(
      `SELECT component_key, component_kind, enabled, registered_at, updated_at
         FROM watcher_runtime_state`,
    );
    const map = new Map<string, WatcherRuntimeRow>();
    for (const row of rows) {
      if (typeof row.component_key !== "string" || typeof row.enabled !== "boolean") continue;
      const kind = row.component_kind;
      if (kind !== "chain_watcher" && kind !== "rail_poller") continue;
      const registeredAt = parseTimestamp(row.registered_at) ?? new Date(0);
      const updatedAt = parseTimestamp(row.updated_at) ?? registeredAt;
      map.set(row.component_key, {
        componentKey: row.component_key,
        componentKind: kind,
        enabled: row.enabled,
        registeredAt,
        updatedAt,
      });
    }
    return map;
  } catch (error) {
    if (isUndefinedTableError(error)) return new Map();
    throw error;
  }
}

async function readCursors(db: Queryable): Promise<ReadonlyMap<ChainKey, Date>> {
  const { rows } = await db.query(
    `SELECT chain_key, last_processed_at, updated_at FROM indexer_cursor`,
  );
  const map = new Map<ChainKey, Date>();
  for (const row of rows) {
    if (typeof row.chain_key !== "string" || !isChainKey(row.chain_key)) continue;
    const at = parseTimestamp(row.updated_at) ?? parseTimestamp(row.last_processed_at);
    if (at !== null) {
      map.set(row.chain_key, at);
    }
  }
  return map;
}

async function readLaneTransferStats(db: Queryable): Promise<readonly LaneTransferStats[]> {
  const { rows } = await db.query(
    `SELECT t.origin_chain,
            t.destination_chain,
            t.route,
            count(*)::int AS total_transfers,
            count(*) FILTER (WHERE d.id IS NULL)::int AS undelivered_count,
            min(t.observed_at) FILTER (WHERE d.id IS NULL) AS oldest_undelivered_at,
            min(COALESCE(a.last_checked_at, t.observed_at)) FILTER (
              WHERE d.id IS NULL AND COALESCE(a.status, 'pending') NOT IN ('failed', 'expired')
            ) AS oldest_attestation_check_at
       FROM outbound_transfer t
       LEFT JOIN rail_attestation a
         ON a.transfer_id = t.id
       LEFT JOIN inbound_delivery d
         ON d.destination_chain = t.destination_chain
        AND d.route = t.route
        AND d.source_chain = t.origin_chain
        AND d.source_nonce = t.nonce
      GROUP BY t.origin_chain, t.destination_chain, t.route`,
  );

  const out: LaneTransferStats[] = [];
  for (const row of rows) {
    if (typeof row.origin_chain !== "string" || typeof row.destination_chain !== "string") {
      continue;
    }
    if (!isChainKey(row.origin_chain) || !isChainKey(row.destination_chain)) continue;
    const routeNum = parseIntField(row.route);
    if (routeNum === null || !isRouteKind(routeNum)) continue;
    const totalTransfers = parseIntField(row.total_transfers) ?? 0;
    const undeliveredCount = parseIntField(row.undelivered_count) ?? 0;
    out.push({
      originChain: row.origin_chain,
      destinationChain: row.destination_chain,
      route: routeNum,
      totalTransfers,
      undeliveredCount,
      oldestUndeliveredAt: parseTimestamp(row.oldest_undelivered_at),
      oldestAttestationCheckAt: parseTimestamp(row.oldest_attestation_check_at),
    });
  }
  return out;
}

function parseTimestamp(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function parseIntField(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function elapsedSeconds(since: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - since.getTime()) / 1000));
}

function isUndefinedTableError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    return (error as { code?: unknown }).code === "42P01";
  }
  return (
    error instanceof Error && /relation "watcher_runtime_state" does not exist/i.test(error.message)
  );
}
