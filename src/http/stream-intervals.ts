function boundedInterval(
  input: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const interval = Number(input) || fallback;
  if (interval < minimum) return minimum;
  if (interval > maximum) return maximum;
  return interval;
}

/** Keep client-selected SSE intervals within Node's safe timer range and service limits. */
export function transferStreamIntervals(query: {
  pollIntervalMs?: string;
  heartbeatIntervalMs?: string;
}): { poll: number; heartbeat: number } {
  return {
    poll: boundedInterval(query.pollIntervalMs, 1000, 1000, 30_000),
    heartbeat: boundedInterval(query.heartbeatIntervalMs, 15_000, 5000, 60_000),
  };
}
