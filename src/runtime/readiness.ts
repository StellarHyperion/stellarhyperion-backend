/**
 * What "ready" means, as a thing a component reports rather than a thing the HTTP layer guesses.
 *
 * `/health` and `/ready` are answering two different questions and the distinction is not
 * cosmetic. A liveness probe that checks Postgres restarts the API every time the database
 * hiccups, which turns a brief database problem into a rolling outage. A readiness probe that
 * does not check Postgres sends traffic to a process that cannot answer a single query. So
 * liveness is "this process is still a process" and readiness is "this process can do its job",
 * and anything with a dependency belongs in the second one.
 *
 * This interface is the seam the rail pollers and the keeper plug into later: each one reports
 * its own readiness and the HTTP layer only aggregates.
 */

export type ReadinessState = "ready" | "degraded" | "down";

export interface ReadinessReport {
  /** Stable, lowercase, dash separated. Shows up in the `/ready` body and in alerts. */
  readonly name: string;
  readonly state: ReadinessState;
  /** One sentence a human can act on. Never a stack trace and never a connection string. */
  readonly detail: string;
}

export interface ReadinessSource {
  /**
   * Answer from cached state, not by making a network call.
   *
   * Readiness is polled by a load balancer every couple of seconds. A check that talks to an RPC
   * endpoint turns the probe into load, and a slow endpoint into a false negative. Components
   * record their own last known good state as they work and report it from memory here. The one
   * exception is the database, which gets a `SELECT 1`, because that is cheaper than the probe
   * itself and because it is the dependency nothing else can compensate for.
   */
  readiness(): ReadinessReport | Promise<ReadinessReport>;
}

/**
 * The worst state wins.
 *
 * A single degraded watcher makes the process degraded rather than down, because it can still
 * answer about the chains that are working. Anything down makes the whole thing down.
 */
export function worstOf(reports: readonly ReadinessReport[]): ReadinessState {
  if (reports.some((report) => report.state === "down")) return "down";
  if (reports.some((report) => report.state === "degraded")) return "degraded";
  return "ready";
}

/** Readiness that only reports what it is told, for a component with nothing to check. */
export function fixedReadiness(
  name: string,
  state: ReadinessState,
  detail: string,
): ReadinessSource {
  return { readiness: () => ({ name, state, detail }) };
}
