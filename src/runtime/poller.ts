/**
 * The loop every watcher runs in.
 *
 * Three things this does that a bare `setInterval` does not, and all three are things the
 * indexer needs rather than things that are nice to have:
 *
 * One tick at a time. `setInterval` will happily start a second tick while the first is still
 * reading a page, and two ticks sharing one cursor race each other into writing the same page
 * twice or skipping one.
 *
 * Catch up without waiting. A watcher starting from a deployment block months behind the head has
 * thousands of pages to read, and sleeping four seconds between them would take a week. A tick
 * that says it made progress is followed immediately by the next one, and only a tick that found
 * nothing new waits out the interval.
 *
 * Back off on failure, with a ceiling. A rate limited RPC endpoint answers a retry storm with
 * more rate limiting. Doubling the wait on each consecutive failure and capping it means a
 * flapping endpoint costs one request a minute instead of one a second, and a recovered endpoint
 * is picked up again on the next tick rather than after a long sulk.
 */
import type { Logger } from "pino";

export interface PollerStats {
  readonly ticks: number;
  readonly lastSuccessAt: Date | null;
  readonly lastErrorAt: Date | null;
  /** The message only. A stack trace in a readiness body is noise nobody acts on. */
  readonly lastError: string | null;
  readonly consecutiveFailures: number;
  readonly running: boolean;
}

export interface PollerOptions {
  readonly name: string;
  readonly intervalMs: number;
  readonly logger: Logger;
  /** Ceiling on the backoff wait. Default is thirty times the interval or one minute, whichever is less. */
  readonly maxBackoffMs?: number;
  /**
   * One pass. Returns true when it made progress and should be run again immediately, false when
   * it caught up and the interval should be waited out.
   */
  readonly tick: (signal: AbortSignal) => Promise<boolean>;
}

export class Poller {
  private readonly controller = new AbortController();
  private loop: Promise<void> | null = null;
  private sleeping: (() => void) | null = null;

  private ticks = 0;
  private lastSuccessAt: Date | null = null;
  private lastErrorAt: Date | null = null;
  private lastError: string | null = null;
  private consecutiveFailures = 0;

  constructor(private readonly options: PollerOptions) {}

  get name(): string {
    return this.options.name;
  }

  /**
   * Whether a stop has been asked for.
   *
   * A method rather than a direct read of `signal.aborted`, and not for style. The loop below
   * tests the flag, then awaits, then tests it again, and `abort` is called from `stop` on another
   * turn of the event loop. TypeScript cannot see that, so it narrows the flag to false at the top
   * of the loop and keeps that narrowing across every await inside it, which makes the later checks
   * look like dead code to the compiler and to the linter. Reading it through a call defeats the
   * narrowing, because a function result is not something the checker tracks that way.
   */
  private isAborted(): boolean {
    return this.controller.signal.aborted;
  }

  get stats(): PollerStats {
    return {
      ticks: this.ticks,
      lastSuccessAt: this.lastSuccessAt,
      lastErrorAt: this.lastErrorAt,
      lastError: this.lastError,
      consecutiveFailures: this.consecutiveFailures,
      running: this.loop !== null && !this.isAborted(),
    };
  }

  start(): void {
    this.loop ??= this.run();
  }

  /** Stop after the current tick finishes. Never mid-transaction, which is the whole point. */
  async stop(): Promise<void> {
    this.controller.abort();
    this.wake();
    await this.loop;
  }

  private async run(): Promise<void> {
    const { logger, name, tick, intervalMs } = this.options;
    const maxBackoff = this.options.maxBackoffMs ?? Math.min(intervalMs * 30, 60_000);

    while (!this.isAborted()) {
      let progressed = false;
      try {
        progressed = await tick(this.controller.signal);
        this.ticks += 1;
        this.lastSuccessAt = new Date();
        this.consecutiveFailures = 0;
        this.lastError = null;
      } catch (error) {
        if (this.isAborted()) break;
        this.consecutiveFailures += 1;
        this.lastErrorAt = new Date();
        this.lastError = messageOf(error);
        // Full error at warn for the first few, then the message only. A chain that has been
        // down for an hour should not be writing a stack trace every four seconds.
        if (this.consecutiveFailures <= 3) {
          logger.warn(
            { err: error, poller: name, failures: this.consecutiveFailures },
            "poll failed",
          );
        } else {
          logger.warn(
            { poller: name, failures: this.consecutiveFailures, reason: this.lastError },
            "poll still failing",
          );
        }
      }

      if (this.isAborted()) break;
      if (progressed && this.consecutiveFailures === 0) continue;

      const wait =
        this.consecutiveFailures === 0
          ? intervalMs
          : Math.min(intervalMs * 2 ** (this.consecutiveFailures - 1), maxBackoff);
      await this.sleep(wait);
    }
  }

  /** Interruptible, so shutdown does not have to wait out a sixty second backoff. */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.sleeping = null;
        resolve();
      }, ms);
      this.sleeping = () => {
        clearTimeout(timer);
        this.sleeping = null;
        resolve();
      };
    });
  }

  private wake(): void {
    this.sleeping?.();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
