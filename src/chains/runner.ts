/**
 * Starting and stopping the watchers as one unit.
 *
 * The runner owns nothing except the list. Each watcher knows its own chain, its own cursor and
 * its own readiness, and this file exists so `main.ts` does not have to know how many there are or
 * what family each one belongs to. B5's rail pollers and B6's keeper join the same list and
 * inherit the same start, stop and readiness behaviour without touching anything else.
 *
 * The split between a watcher and the worker wrapping it is the one decision here worth defending.
 * A watcher is a function from a cursor to a page of rows: no timers, no retry, testable by
 * calling `tick` and looking at the database. The worker is the part with a clock in it. Keeping
 * them apart is why the watcher tests do not sleep, and why the retry policy is one file rather
 * than one per chain.
 */
import type { Logger } from "pino";

import type { AppConfig, StellarWatchConfig } from "../config/config.js";
import type { Transactional } from "../db/pool.js";
import { Poller } from "../runtime/poller.js";
import type { ReadinessReport, ReadinessSource } from "../runtime/readiness.js";
import { fixedReadiness } from "../runtime/readiness.js";
import { StellarRpc } from "./stellar/rpc.js";
import { StellarWatcher } from "./stellar/watcher.js";

/**
 * Consecutive failures before a worker calls itself degraded.
 *
 * One failed page is a public RPC endpoint having a moment, and the poller's backoff is already
 * the right response to it. Three in a row is a pattern, and by then the backoff has stretched to
 * seconds, so it is also the point where the lag starts mattering to somebody.
 */
const FAILURES_BEFORE_DEGRADED = 3;

/** What every background component offers the runner. */
export interface Worker extends ReadinessSource {
  readonly name: string;
  start(): void;
  stop(): Promise<void>;
}

export interface IndexerHandle {
  readonly workers: readonly Worker[];
  readonly readiness: readonly ReadinessSource[];
  /** Begin polling. Separate from building, the way `listen` is separate from `buildServer`. */
  start(): void;
  stop(): Promise<void>;
}

/** One pass is one `tick`, and the component reports its own health. */
interface Pass extends ReadinessSource {
  readonly name: string;
  tick(signal: AbortSignal): Promise<boolean>;
}

/**
 * A pass plus the clock it runs on.
 *
 * Readiness is the pass's own answer until the poller has failed enough times in a row to
 * disagree, because at that point the pass's cached state describes a chain nobody can currently
 * read and the reason it cannot be read is the more useful thing to report.
 */
export class PolledWorker implements Worker {
  private readonly poller: Poller;

  constructor(
    private readonly pass: Pass,
    intervalMs: number,
    logger: Logger,
  ) {
    this.poller = new Poller({
      name: pass.name,
      intervalMs,
      logger,
      tick: (signal) => pass.tick(signal),
    });
  }

  get name(): string {
    return this.pass.name;
  }

  start(): void {
    this.poller.start();
  }

  stop(): Promise<void> {
    return this.poller.stop();
  }

  async readiness(): Promise<ReadinessReport> {
    const stats = this.poller.stats;
    if (stats.consecutiveFailures >= FAILURES_BEFORE_DEGRADED) {
      return {
        name: this.name,
        state: "degraded",
        detail: `${String(stats.consecutiveFailures)} polls in a row failed: ${stats.lastError ?? "no reason recorded"}`,
      };
    }
    return this.pass.readiness();
  }
}

export interface BuildIndexerDeps {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly db: Transactional;
}

/**
 * Decide what this process will watch, without yet watching it.
 *
 * Nothing here opens a socket or reads a cursor, which is what lets the readiness wiring be
 * tested: a record naming three routers and a build that watches one of them is a gap somebody
 * should hear about from `/ready`, and that is only checkable if the decision can be inspected
 * before the pollers are loose.
 */
export function buildIndexer(deps: BuildIndexerDeps): IndexerHandle {
  const { config, logger, db } = deps;

  if (!config.indexer.enabled) {
    return {
      workers: [],
      readiness: [
        fixedReadiness(
          "indexer",
          "ready",
          "disabled by configuration, so this replica answers questions and watches nothing",
        ),
      ],
      start: () => undefined,
      stop: () => Promise.resolve(),
    };
  }

  const workers: Worker[] = [];
  const extra: ReadinessSource[] = [];

  if (config.indexer.stellar !== null) {
    workers.push(stellarWorker(config.indexer.stellar, db, logger));
  } else {
    logger.warn("the deployment record has no Stellar router, so nothing is watching Stellar");
  }

  if (config.indexer.evm.length > 0) {
    // Named rather than skipped. A record listing three EVM routers and a process indexing none of
    // them is a gap somebody should hear about from the readiness endpoint, not discover later
    // from an empty table.
    const chains = config.indexer.evm.map((entry) => entry.chain);
    logger.warn(
      { chains },
      "the deployment record names EVM routers and no EVM watcher is built yet",
    );
    extra.push(
      fixedReadiness(
        "evm",
        "degraded",
        `${chains.join(", ")} are in the deployment record and are not being indexed yet`,
      ),
    );
  }

  if (workers.length === 0) {
    // Worth reporting as degraded rather than ready. A process that believes it is indexing and is
    // watching nothing is the failure that takes longest to notice.
    logger.error("the deployment record named no routers this build can watch");
    extra.push(
      fixedReadiness(
        "indexer",
        "degraded",
        "enabled but watching nothing, because the deployment record named no routers this build can watch",
      ),
    );
  }

  return {
    workers,
    readiness: [...workers, ...extra],
    start: () => {
      for (const worker of workers) worker.start();
      if (workers.length > 0) {
        logger.info({ workers: workers.map((worker) => worker.name) }, "watchers started");
      }
    },
    stop: async () => {
      // In parallel. Each watcher stops after its own current tick, and they share no state, so
      // serialising them would only make shutdown take as long as the slowest chain times the
      // number of chains.
      await Promise.all(workers.map((worker) => worker.stop()));
    },
  };
}

function stellarWorker(config: StellarWatchConfig, db: Transactional, logger: Logger): Worker {
  const child = logger.child({ chain: config.chain });
  const watcher = new StellarWatcher({
    chainKey: config.chain,
    router: config.routerContractId,
    startLedger: config.startLedger,
    pageSize: config.pageSize,
    rpc: new StellarRpc(config.rpcUrl),
    db,
    logger: child,
  });
  return new PolledWorker(watcher, config.pollIntervalMs, child);
}
