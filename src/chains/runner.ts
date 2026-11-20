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
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

import type {
  AppConfig,
  EvmWatchConfig,
  RailsConfig,
  StellarWatchConfig,
} from "../config/config.js";
import type { Transactional } from "../db/pool.js";
import { Poller } from "../runtime/poller.js";
import type { ReadinessReport, ReadinessSource, WorkerKind } from "../runtime/readiness.js";
import { fixedReadiness, recordWorkerHeartbeat } from "../runtime/readiness.js";
import {
  recordWorkerRun,
  withWorkerRun,
  type WorkerRunIdentity,
  type WorkerRunState,
} from "../runtime/worker-runs.js";
import { RouteKind } from "@hyperion/protocol";

import { AxelarGmpClient } from "../rails/axelar/gmp.js";
import { inspectRailBacklog, type InspectRailBacklogOptions } from "../rails/backlog.js";
import { IrisClient } from "../rails/cctp/iris.js";
import { RailPass, type RailProgress } from "../rails/pass.js";
import { requeueTerminalTransfer } from "../rails/requeue.js";
import type {
  BacklogInspectionReport,
  RailClient,
  RailRequeueRequest,
  RailRequeueResult,
} from "../rails/types.js";
import { KeeperWorker } from "../keeper/worker.js";
import { viemClient } from "./evm/client.js";
import { EvmWatcher } from "./evm/watcher.js";
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
  readonly runId?: string;
  readonly executionId?: string;
  start(): void;
  stop(): Promise<void>;
}

export interface IndexerHandle {
  readonly executionId?: string;
  readonly workers: readonly Worker[];
  readonly readiness: readonly ReadinessSource[];
  /** Read-only operator inspection; it does not start workers or change transfer state. */
  inspectBacklog(options?: InspectRailBacklogOptions): Promise<BacklogInspectionReport>;
  /** Begin polling. Separate from building, the way `listen` is separate from `buildServer`. */
  start(): void;
  stop(): Promise<void>;
  requeueTransfer(
    request: RailRequeueRequest,
    options?: { readonly evaluateNow?: boolean },
  ): Promise<RailRequeueResult>;
}

/** One pass is one `tick`, and the component reports its own health. */
interface Pass extends ReadinessSource {
  readonly name: string;
  tick(signal: AbortSignal): Promise<boolean>;
  release?(): Promise<unknown>;
  readonly progress?: { readonly block?: bigint; readonly ledger?: number } | RailProgress | null;
}

export interface PolledWorkerOptions {
  readonly db?: Transactional;
  readonly workerKind?: WorkerKind;
  readonly chainKey?: string | null;
  readonly executionId?: string;
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
  private readonly db: Transactional | undefined;
  private readonly workerKind: WorkerKind;
  private readonly chainKey: string | null;
  readonly runId: string;
  readonly executionId: string;
  private runState: WorkerRunState = "running";
  private started = false;

  constructor(
    private readonly pass: Pass,
    intervalMs: number,
    logger: Logger,
    options: PolledWorkerOptions = {},
  ) {
    this.db = options.db;
    this.workerKind = options.workerKind ?? "other";
    this.chainKey = options.chainKey ?? null;
    this.runId = randomUUID();
    this.executionId = options.executionId ?? this.runId;
    this.poller = new Poller({
      name: pass.name,
      intervalMs,
      logger,
      tick: (signal) =>
        withWorkerRun(this.runIdentity(), async () => {
          this.runState = "running";
          if (this.db !== undefined) await recordWorkerRun(this.db, this.runIdentity(), "running");
          this.started = true;
          let error: unknown;
          let completed = false;
          try {
            const result = await pass.tick(signal);
            completed = true;
            this.runState = signal.aborted ? "stopped" : result ? "running" : "caught_up";
            if (this.db !== undefined)
              await recordWorkerRun(this.db, this.runIdentity(), this.runState, true);
            return result;
          } catch (failure) {
            error = failure;
            this.runState = signal.aborted ? "stopped" : "failed";
            if (this.db !== undefined)
              await recordWorkerRun(this.db, this.runIdentity(), this.runState).catch(() => {
                logger.warn(
                  { event: "worker_run_persistence_failed", worker: pass.name, runId: this.runId },
                  "failed to persist worker outcome",
                );
              });
            throw failure;
          } finally {
            if (this.db !== undefined) {
              await this.persistHeartbeat(completed, error).catch((err: unknown) => {
                logger.warn(
                  { err, worker: pass.name, runId: this.runId },
                  "failed to persist worker heartbeat",
                );
              });
            }
          }
        }),
    });
  }

  private runIdentity(): WorkerRunIdentity {
    return {
      runId: this.runId,
      executionId: this.executionId,
      workerName: this.name,
      workerKind: this.workerKind,
      chainKey: this.chainKey,
    };
  }

  private async persistHeartbeat(completed: boolean, error?: unknown): Promise<void> {
    if (this.db === undefined) return;
    const stats = this.poller.stats;
    const report = await (completed ? this.pass.readiness() : this.readiness());
    const progress = this.pass.progress;
    const consecutiveFailures = completed ? 0 : stats.consecutiveFailures + 1;
    await recordWorkerHeartbeat(this.db, {
      workerName: this.name,
      workerKind: this.workerKind,
      chainKey: this.chainKey,
      state: consecutiveFailures >= FAILURES_BEFORE_DEGRADED ? "degraded" : report.state,
      detail: report.detail,
      completed,
      lastCursorBlock:
        progress && "block" in progress
          ? (progress.block ?? null)
          : progress && "ledger" in progress
            ? BigInt(progress.ledger)
            : null,
      consecutiveFailures,
      lastError: completed ? null : error instanceof Error ? error.message : String(error),
      runId: this.runId,
      metadata: {
        runId: this.runId,
        executionId: this.executionId,
        caughtUp: this.runState === "caught_up",
        ticks: stats.ticks + (completed ? 1 : 0),
        running: stats.running,
      },
    });
  }

  get name(): string {
    return this.pass.name;
  }

  start(): void {
    this.poller.start();
  }

  async stop(): Promise<void> {
    await this.poller.stop();
    if (this.started && this.runState === "running" && this.db !== undefined) {
      this.runState = "stopped";
      await recordWorkerRun(this.db, this.runIdentity(), "stopped");
    }
    if (this.pass.release !== undefined) {
      await this.pass.release().catch(() => undefined);
    }
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
  const executionId = randomUUID();
  const railShutdown = new AbortController();
  const passes = buildRailPasses(
    config.rails,
    config.network,
    db,
    logger,
    config,
    railShutdown.signal,
  );
  const inspectBacklog = (
    options: InspectRailBacklogOptions = {},
  ): Promise<BacklogInspectionReport> =>
    inspectRailBacklog(db, {
      ...options,
      recheckAfterMs: config.rails.recheckAfterMs,
      maxCheckFailures: config.rails.maxCheckFailures,
    });
  const requeueTransfer: IndexerHandle["requeueTransfer"] = async (request, options) => {
    if (options?.evaluateNow === true && !config.rails.enabled) {
      throw new Error("immediate rail evaluation is disabled by configuration");
    }
    const result = await requeueTerminalTransfer(db, request);
    if (options?.evaluateNow === true) {
      const pass = passes.find((candidate) => candidate.route === result.route);
      if (pass === undefined) {
        throw new Error(`no rail evaluator is configured for route ${String(result.route)}`);
      }
      await pass.evaluateTransfer(result.transferId);
    }
    return result;
  };

  if (!config.indexer.enabled) {
    return {
      executionId,
      workers: [],
      readiness: [
        fixedReadiness(
          "indexer",
          "ready",
          "disabled by configuration, so this replica answers questions and watches nothing",
        ),
      ],
      inspectBacklog,
      start: () => undefined,
      stop: () => Promise.resolve(),
      requeueTransfer,
    };
  }

  const workers: Worker[] = [];
  const extra: ReadinessSource[] = [];

  if (config.indexer.stellar !== null) {
    workers.push(stellarWorker(config.indexer.stellar, db, logger, config, executionId));
  } else {
    logger.warn("the deployment record has no Stellar router, so nothing is watching Stellar");
  }

  // One per chain in the record. Each carries its own confirmations from the registry, which is
  // the honest way to treat one block on Arc and twelve on Ethereum as the same kind of fact.
  for (const chain of config.indexer.evm) {
    workers.push(evmWorker(chain, db, logger, config, executionId));
  }

  // Counted before the rail pollers join the list, because the two questions are different. "Is
  // anything watching a chain" must not be answered yes by a rail poller: a process with two rail
  // pollers and no watcher is indexing nothing, and letting the rails pad the count is how that
  // stops being reported.
  const chainWatchers = workers.length;

  // The rail pollers join the same list and inherit the same start, stop and readiness behaviour.
  // They are not conditional on a router being watched: a transfer indexed by a previous run is
  // still waiting on its rail whether or not this replica is watching the chain it left.
  if (config.rails.enabled) {
    for (const worker of railWorkersFromPasses(passes, config.rails, db, logger, executionId)) {
      workers.push(worker);
    }
  } else {
    extra.push(
      fixedReadiness(
        "rails",
        "ready",
        "disabled by configuration, so no transfer's rail status is being refreshed",
      ),
    );
  }

  // The keeper submits Stellar TTL maintenance and claim settlement through BullMQ.
  if (config.keeper.enabled) {
    workers.push(new KeeperWorker(config, db, logger));
  } else {
    extra.push(
      fixedReadiness(
        "keeper",
        "ready",
        "disabled by configuration, so no automated upkeep tasks run on this replica",
      ),
    );
  }

  if (chainWatchers === 0) {
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
    executionId,
    workers,
    readiness: [...workers, ...extra],
    inspectBacklog,
    start: () => {
      for (const worker of workers) worker.start();
      if (workers.length > 0) {
        logger.info({ workers: workers.map((worker) => worker.name) }, "watchers started");
      }
    },
    stop: async () => {
      railShutdown.abort();
      // In parallel. Each watcher stops after its own current tick, and they share no state, so
      // serialising them would only make shutdown take as long as the slowest chain times the
      // number of chains.
      await Promise.all(workers.map((worker) => worker.stop()));
    },
    requeueTransfer,
  };
}

/**
 * One worker per rail that has a status API to ask.
 *
 * Allbridge is absent on purpose rather than by omission. It is outbound only by construction and
 * exposes no attestation to poll, so a transfer on it is pending until an inbound delivery appears,
 * which the queue already settles without a request. A poller for it would make a request a tick
 * for an answer that does not exist.
 */
export function buildRailPasses(
  config: RailsConfig,
  network: AppConfig["network"],
  db: Transactional,
  logger: Logger,
  appConfig: AppConfig,
  shutdownSignal?: AbortSignal,
): readonly RailPass[] {
  const clients: readonly { readonly route: RouteKind; readonly client: RailClient }[] = [
    {
      route: RouteKind.Cctp,
      client: new IrisClient(network, { baseUrl: config.irisUrl }),
    },
    {
      route: RouteKind.AxelarIts,
      client: new AxelarGmpClient(config.axelarUrl, {
        onUnknownStatus: (status) => {
          logger.warn(
            { rail: "axelar", status },
            "the rail reported a status this build does not know; it is recorded verbatim and the transfer stays pending",
          );
        },
      }),
    },
  ];

  return clients.map(({ route, client }) => {
    const child = logger.child({ rail: client.rail, route });
    return new RailPass({
      route,
      config: appConfig,
      client,
      db,
      logger: child,
      batchSize: config.batchSize,
      recheckAfterMs: config.recheckAfterMs,
      maxCheckFailures: config.maxCheckFailures,
      ...(shutdownSignal === undefined ? {} : { shutdownSignal }),
    });
  });
}

function railWorkersFromPasses(
  passes: readonly RailPass[],
  config: RailsConfig,
  db: Transactional,
  logger: Logger,
  executionId: string,
): readonly Worker[] {
  return passes.map((pass) => {
    const child = logger.child({ rail: pass.rail, route: pass.route });
    return new PolledWorker(pass, config.pollIntervalMs, child, {
      db,
      workerKind: "rail",
      chainKey: null,
      executionId,
    });
  });
}

function evmWorker(
  config: EvmWatchConfig,
  db: Transactional,
  logger: Logger,
  app?: AppConfig,
  executionId?: string,
): Worker {
  const child = logger.child({ chain: config.chain, chainId: config.chainId });
  const watcher = new EvmWatcher({
    ...(app
      ? { ownerId: `${app.indexerLeaseOwnerId}:${randomUUID()}`, leaseTtlMs: app.indexerLeaseTtlMs }
      : {}),
    chainKey: config.chain,
    router: config.routerAddress,
    chainId: config.chainId,
    startBlock: config.startBlock,
    confirmations: config.confirmations,
    finalityMode: config.finalityMode ?? "confirmations",
    allowFinalityFallback: config.allowFinalityFallback ?? false,
    reorgDepth: config.reorgDepth,
    logRange: config.logRange,
    client: viemClient(config.rpcUrls, { logger: child }),
    db,
    logger: child,
  });
  return new PolledWorker(watcher, config.pollIntervalMs, child, {
    db,
    workerKind: "chain",
    chainKey: config.chain,
    ...(executionId === undefined ? {} : { executionId }),
  });
}

function stellarWorker(
  config: StellarWatchConfig,
  db: Transactional,
  logger: Logger,
  app?: AppConfig,
  executionId?: string,
): Worker {
  const child = logger.child({ chain: config.chain });
  const watcher = new StellarWatcher({
    ...(app
      ? { ownerId: `${app.indexerLeaseOwnerId}:${randomUUID()}`, leaseTtlMs: app.indexerLeaseTtlMs }
      : {}),
    chainKey: config.chain,
    router: config.routerContractId,
    startLedger: config.startLedger,
    pageSize: config.pageSize,
    rpc: new StellarRpc(config.rpcUrl),
    ...(config.historicalRpcUrl !== undefined &&
    config.historicalRpcUrl !== null &&
    config.historicalRpcUrl !== ""
      ? { historicalRpc: new StellarRpc(config.historicalRpcUrl) }
      : {}),
    db,
    logger: child,
  });
  return new PolledWorker(watcher, config.pollIntervalMs, child, {
    db,
    workerKind: "chain",
    chainKey: config.chain,
    ...(executionId === undefined ? {} : { executionId }),
  });
}
