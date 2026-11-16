/**
 * Deterministic fair rail batch scheduler across transfer age buckets and destination chains.
 *
 * Prevents a large stale backlog from starving recent transfers while guaranteeing bounded forward
 * progress for older transfers, and enforces per-destination limits so a single noisy or congested
 * destination chain cannot monopolize an entire pass.
 */
import type {
  FairSchedulerCursor,
  FairSchedulingConfig,
  PendingTransfer,
  RailAgeBucket,
} from "./types.js";

export const AGE_BUCKETS: readonly RailAgeBucket[] = ["fresh", "aging", "stale"];

export const DEFAULT_FRESH_MAX_AGE_MS = 5 * 60_000;
export const DEFAULT_AGING_MAX_AGE_MS = 60 * 60_000;
export const DEFAULT_FRESH_WEIGHT = 5;
export const DEFAULT_AGING_WEIGHT = 3;
export const DEFAULT_STALE_WEIGHT = 2;
export const DEFAULT_MAX_DESTINATION_SHARE = 0.5;

export interface ResolvedFairSchedulingConfig {
  readonly freshMaxAgeMs: number;
  readonly agingMaxAgeMs: number;
  readonly weights: Readonly<Record<RailAgeBucket, number>>;
  readonly maxPerDestination: number | null;
  readonly maxDestinationShare: number;
}

export interface FairScheduleResult<T extends PendingTransfer = PendingTransfer> {
  readonly selected: readonly T[];
  readonly nextCursor: FairSchedulerCursor;
  readonly bucketCounts: Readonly<Record<RailAgeBucket, number>>;
  readonly destinationCounts: Readonly<Record<string, number>>;
}

export function initialFairSchedulerCursor(): FairSchedulerCursor {
  return { bucketOffset: 0, destinationOffset: 0 };
}

export function resolveFairSchedulingConfig(
  config?: FairSchedulingConfig,
): ResolvedFairSchedulingConfig {
  const freshMaxAgeMs = Math.max(1, config?.freshMaxAgeMs ?? DEFAULT_FRESH_MAX_AGE_MS);
  const agingMaxAgeMs = Math.max(
    freshMaxAgeMs + 1,
    config?.agingMaxAgeMs ?? DEFAULT_AGING_MAX_AGE_MS,
  );
  const freshWeight = Math.max(0, config?.freshWeight ?? DEFAULT_FRESH_WEIGHT);
  const agingWeight = Math.max(0, config?.agingWeight ?? DEFAULT_AGING_WEIGHT);
  const staleWeight = Math.max(0, config?.staleWeight ?? DEFAULT_STALE_WEIGHT);

  if (freshWeight + agingWeight + staleWeight <= 0) {
    throw new Error("at least one rail age bucket weight must be positive");
  }

  const maxPerDestination =
    config?.maxPerDestination !== undefined
      ? Math.max(1, Math.floor(config.maxPerDestination))
      : null;

  const rawShare = config?.maxDestinationShare ?? DEFAULT_MAX_DESTINATION_SHARE;
  if (rawShare <= 0 || rawShare > 1) {
    throw new Error("maxDestinationShare must be in the interval (0, 1]");
  }

  return {
    freshMaxAgeMs,
    agingMaxAgeMs,
    weights: {
      fresh: freshWeight,
      aging: agingWeight,
      stale: staleWeight,
    },
    maxPerDestination,
    maxDestinationShare: rawShare,
  };
}

export function classifyRailAgeBucket(
  observedAt: Date,
  now: Date,
  config?: Pick<ResolvedFairSchedulingConfig, "freshMaxAgeMs" | "agingMaxAgeMs">,
): RailAgeBucket {
  const freshMax = config?.freshMaxAgeMs ?? DEFAULT_FRESH_MAX_AGE_MS;
  const agingMax = config?.agingMaxAgeMs ?? DEFAULT_AGING_MAX_AGE_MS;
  const ageMs = Math.max(0, now.getTime() - observedAt.getTime());
  if (ageMs <= freshMax) return "fresh";
  if (ageMs <= agingMax) return "aging";
  return "stale";
}

function rotateArray<T>(items: readonly T[], offset: number): readonly T[] {
  if (items.length <= 1) return items;
  const normalized = ((offset % items.length) + items.length) % items.length;
  if (normalized === 0) return items;
  return [...items.slice(normalized), ...items.slice(0, normalized)];
}

/**
 * Compute target slot quotas across active age buckets for a batch of size `limit`.
 *
 * Every active bucket with eligible items and a positive weight receives a minimum floor of 1 slot
 * whenever `limit` is at least the number of active buckets; when `limit` is smaller than the
 * number of active buckets, `bucketOffset` rotates which buckets receive slots first across ticks
 * so no bucket is ever starved.
 */
export function computeBucketQuotas(
  limit: number,
  availableByBucket: Readonly<Record<RailAgeBucket, number>>,
  weights: Readonly<Record<RailAgeBucket, number>>,
  bucketOffset: number,
): Readonly<Record<RailAgeBucket, number>> {
  const quotas: Record<RailAgeBucket, number> = { fresh: 0, aging: 0, stale: 0 };
  if (limit <= 0) return quotas;

  const rotatedBuckets = rotateArray(AGE_BUCKETS, bucketOffset);
  const activeBuckets = rotatedBuckets.filter(
    (bucket) => availableByBucket[bucket] > 0 && weights[bucket] > 0,
  );
  if (activeBuckets.length === 0) return quotas;

  // When batch limit cannot even hold 1 per active bucket, rotate 1 slot per bucket across passes.
  if (limit <= activeBuckets.length) {
    for (let i = 0; i < limit; i += 1) {
      const bucket = activeBuckets[i];
      if (bucket !== undefined) {
        quotas[bucket] = 1;
      }
    }
    return quotas;
  }

  // Guarantee 1 slot minimum per active bucket, then apportion up to `limit` using Hamilton
  // largest-deficit water-filling against ideal weighted shares (capped by available supply).
  for (const bucket of activeBuckets) {
    quotas[bucket] = 1;
  }
  let remaining = limit - activeBuckets.length;

  while (remaining > 0) {
    const expandable = activeBuckets.filter((bucket) => quotas[bucket] < availableByBucket[bucket]);
    if (expandable.length === 0) break;

    const totalActiveWeight = activeBuckets.reduce((sum, bucket) => sum + weights[bucket], 0);
    let bestBucket: RailAgeBucket | undefined;
    let bestDeficit = Number.NEGATIVE_INFINITY;

    for (const bucket of expandable) {
      const ideal = (limit * weights[bucket]) / totalActiveWeight;
      const deficit = ideal - quotas[bucket];
      if (deficit > bestDeficit) {
        bestDeficit = deficit;
        bestBucket = bucket;
      }
    }

    if (bestBucket === undefined) break;
    quotas[bestBucket] += 1;
    remaining -= 1;
  }

  return quotas;
}

/**
 * Deterministically select up to `limit` transfers across age buckets and destinations.
 *
 * Input `candidates` are assumed to be ordered within each `(ageBucket, destinationChain)` by
 * `last_checked_at ASC NULLS FIRST, id ASC`.
 */
export function scheduleFairRailBatch<T extends PendingTransfer>(
  candidates: readonly T[],
  options: {
    readonly limit: number;
    readonly now: Date;
    readonly config?: FairSchedulingConfig | undefined;
    readonly cursor?: FairSchedulerCursor | undefined;
  },
): FairScheduleResult<T> {
  const resolved = resolveFairSchedulingConfig(options.config);
  const cursor = options.cursor ?? initialFairSchedulerCursor();
  const bucketCounts: Record<RailAgeBucket, number> = { fresh: 0, aging: 0, stale: 0 };
  const destinationCounts: Record<string, number> = {};

  if (options.limit <= 0 || candidates.length === 0) {
    return {
      selected: [],
      nextCursor: cursor,
      bucketCounts,
      destinationCounts,
    };
  }

  // Group candidates by bucket -> destinationQueue (preserving internal queue order)
  const queues: Record<RailAgeBucket, Map<string, T[]>> = {
    fresh: new Map<string, T[]>(),
    aging: new Map<string, T[]>(),
    stale: new Map<string, T[]>(),
  };
  const distinctDestinations = new Set<string>();

  for (const item of candidates) {
    const bucket =
      item.ageBucket ??
      classifyRailAgeBucket(item.observedAt ?? options.now, options.now, resolved);
    distinctDestinations.add(item.destinationChain);
    const bucketMap = queues[bucket];
    const existing = bucketMap.get(item.destinationChain);
    if (existing !== undefined) {
      existing.push(item);
    } else {
      bucketMap.set(item.destinationChain, [item]);
    }
  }

  const sortedDestinations = [...distinctDestinations].sort();
  const rotatedDestinations = rotateArray(sortedDestinations, cursor.destinationOffset);

  // Per-destination cap:
  // - If maxPerDestination is explicitly configured, enforce it strictly.
  // - When multiple destinations have eligible transfers, also cap each destination at
  //   ceil(limit * maxDestinationShare) so no single destination can monopolize the pass.
  const shareCap =
    distinctDestinations.size > 1
      ? Math.max(1, Math.ceil(options.limit * resolved.maxDestinationShare))
      : options.limit;
  const perDestinationCeiling =
    resolved.maxPerDestination !== null ? Math.min(resolved.maxPerDestination, shareCap) : shareCap;

  // Compute effective available items per bucket after applying the per-destination ceiling across
  // the pass so bucket quotas know how much schedulable supply exists.
  const availableByBucket: Record<RailAgeBucket, number> = {
    fresh: countBucketItems(queues.fresh),
    aging: countBucketItems(queues.aging),
    stale: countBucketItems(queues.stale),
  };

  const quotas = computeBucketQuotas(
    options.limit,
    availableByBucket,
    resolved.weights,
    cursor.bucketOffset,
  );

  const selected: T[] = [];
  const rotatedBuckets = rotateArray(AGE_BUCKETS, cursor.bucketOffset);

  const takeFromBucket = (bucket: RailAgeBucket, maxToTake: number): number => {
    let taken = 0;
    const bucketMap = queues[bucket];
    while (taken < maxToTake && selected.length < options.limit) {
      let progressed = false;
      for (const dest of rotatedDestinations) {
        if (taken >= maxToTake || selected.length >= options.limit) break;
        const usedForDest = destinationCounts[dest] ?? 0;
        if (usedForDest >= perDestinationCeiling) continue;
        const destQueue = bucketMap.get(dest);
        const nextItem = destQueue?.shift();
        if (nextItem === undefined) continue;
        selected.push(nextItem);
        bucketCounts[bucket] += 1;
        destinationCounts[dest] = usedForDest + 1;
        taken += 1;
        progressed = true;
      }
      if (!progressed) break;
    }
    return taken;
  };

  // Phase 1: Serve each bucket up to its fair quota, round-robining across destinations.
  for (const bucket of rotatedBuckets) {
    takeFromBucket(bucket, quotas[bucket]);
  }

  // Phase 2: Work-conserving spillover across any bucket that still has destination-eligible work
  // (for example, when one bucket had only items for an already-capped destination).
  if (selected.length < options.limit) {
    for (const bucket of rotatedBuckets) {
      if (selected.length >= options.limit) break;
      if (resolved.weights[bucket] <= 0) continue;
      takeFromBucket(bucket, options.limit - selected.length);
    }
  }

  return {
    selected,
    nextCursor: {
      bucketOffset: (cursor.bucketOffset + 1) % AGE_BUCKETS.length,
      destinationOffset:
        sortedDestinations.length > 0
          ? (cursor.destinationOffset + 1) % sortedDestinations.length
          : 0,
    },
    bucketCounts,
    destinationCounts,
  };
}

function countBucketItems<T>(bucketMap: ReadonlyMap<string, readonly T[]>): number {
  let sum = 0;
  for (const list of bucketMap.values()) {
    sum += list.length;
  }
  return sum;
}
