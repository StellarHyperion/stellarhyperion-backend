/** Keep client-selected SSE intervals within Node's safe timer range and service limits. */
export function transferStreamIntervals(query: {
  pollIntervalMs?: string;
  heartbeatIntervalMs?: string;
}): { poll: number; heartbeat: number } {
  return {
    poll: Math.min(30_000, Math.max(Number(query.pollIntervalMs) || 1000, 1000)),
    heartbeat: Math.min(60_000, Math.max(Number(query.heartbeatIntervalMs) || 15_000, 5000)),
  };
}
