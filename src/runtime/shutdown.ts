/**
 * Shutting down on purpose rather than being killed.
 *
 * The thing a graceful shutdown is actually protecting here is the indexer's cursor. A watcher
 * killed between writing a page of events and committing the cursor advance is fine, because
 * those are one transaction. A watcher killed while a transaction is open holds a Postgres
 * connection until the server times it out, and the next process to start finds the row it wants
 * locked. So the order matters: stop accepting new work, let the current page finish, then close
 * the pool.
 *
 * Steps run in reverse registration order, which is the order that undoes them. Each one gets the
 * remaining budget rather than the whole budget, so ten steps cannot take ten times the timeout.
 */
import type { Logger } from "pino";

export interface ShutdownStep {
  readonly name: string;
  readonly run: () => Promise<void>;
}

export class Shutdown {
  private readonly steps: ShutdownStep[] = [];
  private running: Promise<void> | null = null;

  constructor(
    private readonly logger: Logger,
    private readonly budgetMs: number,
  ) {}

  /** Register a step. Later registrations shut down first. */
  add(name: string, run: () => Promise<void>): void {
    this.steps.push({ name, run });
  }

  /** Whether shutdown has already been asked for, which is what a poll loop checks. */
  get started(): boolean {
    return this.running !== null;
  }

  /**
   * Run every step once.
   *
   * Idempotent because two signals in quick succession is normal: a container runtime sends
   * SIGTERM and an impatient operator sends another one.
   */
  run(reason: string): Promise<void> {
    this.running ??= this.execute(reason);
    return this.running;
  }

  private async execute(reason: string): Promise<void> {
    const startedAt = Date.now();
    this.logger.info({ reason, steps: this.steps.length }, "shutting down");

    for (const step of [...this.steps].reverse()) {
      const remaining = this.budgetMs - (Date.now() - startedAt);
      if (remaining <= 0) {
        this.logger.warn({ step: step.name }, "shutdown budget spent, skipping remaining steps");
        break;
      }
      try {
        await withDeadline(step.run(), remaining, step.name);
        this.logger.debug({ step: step.name }, "shutdown step done");
      } catch (error) {
        // Logged and carried on. A step that will not finish must not stop the pool from closing,
        // because an unclosed pool is what leaves locks behind for the next process.
        this.logger.error({ err: error, step: step.name }, "shutdown step failed");
      }
    }

    this.logger.info({ ms: Date.now() - startedAt }, "shutdown complete");
  }
}

/** Install the signal handlers. Returns the handler so a test can call it without a real signal. */
export function installSignalHandlers(shutdown: Shutdown, logger: Logger): () => void {
  const onSignal = (signal: NodeJS.Signals): void => {
    void shutdown.run(signal).then(
      () => {
        process.exitCode = 0;
      },
      (error: unknown) => {
        logger.error({ err: error }, "shutdown threw");
        process.exitCode = 1;
      },
    );
  };

  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  // An unhandled rejection in a poll loop is a bug, and continuing past it means the watcher is
  // silently not watching. Shutting down makes the supervisor restart it, which is both more
  // honest and more likely to recover.
  process.on("unhandledRejection", (reason: unknown) => {
    logger.fatal({ err: reason }, "unhandled rejection, shutting down");
    void shutdown.run("unhandledRejection").then(() => {
      process.exitCode = 1;
    });
  });

  return () => {
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  };
}

async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${what} did not finish within ${ms}ms`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
