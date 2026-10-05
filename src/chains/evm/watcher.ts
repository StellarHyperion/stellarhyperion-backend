/**
 * The EVM watcher: one pass over a range of blocks, on a chain that can change its mind.
 *
 * This is a separate file from the Stellar watcher rather than the same one with a flag, and the
 * difference is not stylistic. Stellar has deterministic finality: a closed ledger is closed, so a
 * ledger number is a complete description of a position. An EVM block number is not, because the
 * chain can later disagree about which block had that number. Everything below follows from that.
 *
 * Two mechanisms, doing two different jobs:
 *
 * Confirmations draw the line this watcher will not read past. The registry gives each chain its
 * own number, which is the honest way to treat one on Arc and twelve on Ethereum as the same kind
 * of fact. Indexing only up to `head - confirmations` means the rows written are rows that chain
 * considers settled, so the ordinary case needs no re-reading at all.
 *
 * The cursor's block hash catches the case confirmations were supposed to prevent. Every pass
 * re-reads the hash of the block the cursor sits on, and a hash that no longer matches means the
 * chain reorganised past a block this indexer already believed. That is reported loudly and the
 * cursor is wound back by the reorg depth, so the corrected blocks are read again and the writers
 * overwrite what the orphaned ones said.
 *
 * What it will not do is delete. A transfer orphaned out of existence, rather than changed, leaves
 * a row nothing overwrites, and the only honest fix is a person deciding. A watcher that silently
 * deleted money records to tidy up after a reorg deeper than the chain's own stated finality would
 * be a worse failure than the one it was cleaning up. So that case is reported and left.
 */
import type { Logger } from "pino";
import type { Hex } from "viem";

import type { Queryable, Transactional } from "../../db/pool.js";
import type { ReadinessReport } from "../../runtime/readiness.js";
import { readCursor, writeCursor } from "../stellar/store.js";
import type { Position } from "../writers.js";
import { ClaimPairing, applyRouterLog } from "./store.js";
import { decodeRouterLog, signatureOf } from "./logs.js";
import type { EvmClient, RawEvmLog } from "./client.js";

/**
 * How far behind the confirmation line still counts as current.
 *
 * Measured against the deepest block this watcher is willing to believe rather than against the
 * head, because sitting `confirmations` blocks back is the design and reporting it as lag would
 * make a healthy watcher permanently degraded. Two blocks is one poll interval of slack on every
 * chain in the registry.
 */
const CURRENT_WITHIN_BLOCKS = 2;

export interface EvmWatcherOptions {
  readonly chainKey: string;
  readonly router: Hex;
  /** What the deployment record says this chain is. Checked against the node once. */
  readonly chainId: number;
  /** The block the router was deployed in. Where a fresh cursor starts. */
  readonly startBlock: bigint;
  /** How many blocks behind the head this chain's own finality needs. */
  readonly confirmations: number;
  /** How far back to wind the cursor when a reorg is found below that depth. */
  readonly reorgDepth: number;
  /** Blocks per `getLogs` call. Public endpoints reject wide ranges. */
  readonly logRange: number;
  readonly client: EvmClient;
  readonly db: Transactional;
  readonly logger: Logger;
}

export interface EvmProgress {
  /** The last block indexed, which is what the cursor holds. */
  readonly block: bigint;
  readonly written: number;
  readonly ignored: number;
  readonly head: bigint;
  /** Blocks between the cursor and the deepest block this watcher will read. */
  readonly behind: number;
  readonly reorgs: number;
  readonly at: Date;
}

export class EvmWatcher {
  private lastProgress: EvmProgress | null = null;
  private reorgs = 0;
  /** Set once the node has confirmed which chain it is. */
  private chainConfirmed = false;
  /** Signatures seen once and logged once. A router ahead of this build is not a log flood. */
  private readonly reportedUnknown = new Set<string>();

  constructor(private readonly options: EvmWatcherOptions) {}

  get name(): string {
    return this.options.chainKey;
  }

  get progress(): EvmProgress | null {
    return this.lastProgress;
  }

  /**
   * Readiness from cached state, never from a network call.
   *
   * Degraded at worst and never down, the same ceiling the Stellar watcher has and for the same
   * reason: `/ready` takes the worst report in the process, and one unreachable chain is not a
   * reason to stop answering about the chains that are reachable.
   */
  readiness(): ReadinessReport {
    const progress = this.lastProgress;
    if (progress === null) {
      return {
        name: this.name,
        state: "degraded",
        detail: "has not completed a pass yet, so nothing it could be asked about is indexed",
      };
    }
    if (progress.behind > CURRENT_WITHIN_BLOCKS) {
      return {
        name: this.name,
        state: "degraded",
        detail:
          `${String(progress.behind)} blocks behind the confirmed head at block ` +
          `${progress.block.toString()}, with the chain at ${progress.head.toString()}`,
      };
    }
    const reorgNote = progress.reorgs === 0 ? "" : `, ${String(progress.reorgs)} reorgs handled`;
    return {
      name: this.name,
      state: "ready",
      detail:
        `current at block ${progress.block.toString()}, ` +
        `${String(this.options.confirmations)} confirmations behind the chain head${reorgNote}`,
    };
  }

  /**
   * One pass. Returns true when it made progress and should be run again immediately, which is how
   * a watcher starting from a deployment block months back catches up without sleeping per range.
   */
  async tick(signal: AbortSignal): Promise<boolean> {
    const { chainKey, router, db, logger, client, confirmations } = this.options;

    const stored = await readCursor(db, chainKey);
    if (stored !== null && stored.contract.toLowerCase() !== router.toLowerCase()) {
      // A different router at a different address shares no history with this cursor. Carrying it
      // over would skip everything the new deployment has ever done, silently.
      throw new Error(
        `the cursor for ${chainKey} was written for router ${stored.contract} and this process is watching ${router}. ` +
          "A redeployed router needs its cursor reset rather than reused.",
      );
    }

    await this.confirmChain(signal);

    const head = await client.blockNumber(signal);
    // The deepest block this chain considers settled. Nothing past it is read, so nothing past it
    // can be written and then taken back.
    const confirmed = head - BigInt(confirmations);

    let from = stored === null ? this.options.startBlock : stored.position + 1n;
    if (stored !== null && stored.hash !== null) {
      const rewound = await this.checkForReorg(stored.position, stored.hash, signal);
      if (rewound !== null) from = rewound;
    }

    if (from > confirmed) {
      // Caught up to the confirmation line. Normal, and the common case on a fast chain.
      this.lastProgress = {
        block: stored?.position ?? this.options.startBlock - 1n,
        written: 0,
        ignored: 0,
        head,
        behind: Number(confirmed - (stored?.position ?? this.options.startBlock - 1n)),
        reorgs: this.reorgs,
        at: new Date(),
      };
      return false;
    }

    const to = min(from + BigInt(this.options.logRange) - 1n, confirmed);
    const logs = await client.logs({ address: router, fromBlock: from, toBlock: to }, signal);

    // Block timestamps, which `getLogs` does not return and three columns need. One call per block
    // that actually has logs, plus the range end for its hash, rather than one per block in range.
    const wanted = new Set<bigint>(logs.map((log) => log.blockNumber));
    wanted.add(to);
    const blocks = await client.blocks([...wanted], signal);

    const endHash = blocks.get(to)?.hash ?? null;
    if (endHash === null) {
      // The range end vanished between the log read and the block read, which is a reorg landing
      // mid pass. Nothing is written and the next pass finds it through the cursor hash.
      logger.warn(
        { chain: chainKey, block: to.toString() },
        "the block at the end of this range disappeared mid pass, so nothing was committed",
      );
      return false;
    }

    let written = 0;
    let ignored = 0;
    const pairing = new ClaimPairing();

    // One transaction for the range and the cursor advance past it. This is the restart guarantee,
    // and splitting it would turn every crash into either a lost range or a duplicated one.
    await db.transaction(async (tx: Queryable) => {
      for (const log of logs) {
        if (log.removed) {
          // viem marks a log from an orphaned block. Indexing one would record a transfer that is
          // no longer on the chain.
          ignored += 1;
          continue;
        }
        const timestamp = blocks.get(log.blockNumber)?.timestamp;
        if (timestamp === undefined) {
          throw new Error(
            `no timestamp for block ${log.blockNumber.toString()} on ${chainKey}, which three columns need`,
          );
        }
        if (await this.apply(tx, log, timestamp, pairing)) written += 1;
        else ignored += 1;
      }

      await writeCursor(tx, {
        chainKey,
        family: "evm",
        contract: router,
        position: to,
        observedAt: timestampOf(blocks.get(to)?.timestamp ?? null),
        // The whole reason the column exists. Without it the next pass cannot tell advancing from
        // being handed a different history.
        hash: endHash,
      });
    });

    const behind = Number(confirmed - to);
    this.lastProgress = {
      block: to,
      written,
      ignored,
      head,
      behind,
      reorgs: this.reorgs,
      at: new Date(),
    };
    logger.info(
      {
        chain: chainKey,
        from: from.toString(),
        to: to.toString(),
        written,
        ignored,
        behind,
      },
      "evm range indexed",
    );

    return behind > 0;
  }

  /**
   * Confirm the node is the chain the deployment record claims, once per process.
   *
   * Once, not per pass, because an endpoint does not change its mind about which chain it is and
   * a call per pass would be a request per poll for an answer that never moves. It throws rather
   * than degrades: there is no useful partial behaviour available when the rows about to be
   * written would be attributed to the wrong chain.
   */
  private async confirmChain(signal: AbortSignal): Promise<void> {
    if (this.chainConfirmed) return;
    const actual = await this.options.client.chainId(signal);
    if (actual !== this.options.chainId) {
      throw new Error(
        `the endpoint for ${this.options.chainKey} reports chain id ${String(actual)} and the deployment record says ${String(this.options.chainId)}. ` +
          "Indexing it would file another chain's transfers under this one.",
      );
    }
    this.chainConfirmed = true;
  }

  /**
   * Confirm the cursor still sits on the block it was written for.
   *
   * Returns the block to resume from when it does not, and null when nothing has changed. A
   * mismatch here is not an ordinary reorg: it is one that reached past the confirmation depth
   * this chain's registry entry claims is enough, which is worth saying out loud at error level
   * rather than handling quietly.
   */
  private async checkForReorg(
    position: bigint,
    expected: string,
    signal: AbortSignal,
  ): Promise<bigint | null> {
    const { chainKey, logger, reorgDepth, confirmations } = this.options;
    const blocks = await this.options.client.blocks([position], signal);
    const actual = blocks.get(position)?.hash ?? null;

    if (actual !== null && actual.toLowerCase() === expected.toLowerCase()) return null;

    this.reorgs += 1;
    const rewound = position - BigInt(reorgDepth) + 1n;
    const from = rewound < this.options.startBlock ? this.options.startBlock : rewound;
    logger.error(
      {
        chain: chainKey,
        block: position.toString(),
        expected,
        actual,
        confirmations,
        resumingFrom: from.toString(),
      },
      actual === null
        ? "the block at the cursor is gone from this node, which is a reorg past the confirmation depth; winding back"
        : "the block at the cursor has a different hash, which is a reorg past the confirmation depth; winding back",
    );
    return from;
  }

  private async apply(
    tx: Queryable,
    log: RawEvmLog,
    timestamp: bigint,
    pairing: ClaimPairing,
  ): Promise<boolean> {
    const { chainKey, logger } = this.options;
    const decoded = decodeRouterLog(log);
    if (decoded === null) {
      const signature = signatureOf(log);
      if (!this.reportedUnknown.has(signature)) {
        this.reportedUnknown.add(signature);
        logger.warn(
          { chain: chainKey, signature },
          "the router emitted an event signature this build does not know; it is running ahead of the indexer",
        );
      }
      return false;
    }

    const at: Position = {
      chainKey,
      block: log.blockNumber,
      txHash: log.transactionHash,
      // Unlike Soroban, which orders events within a transaction instead.
      logIndex: log.logIndex,
      observedAt: new Date(Number(timestamp) * 1000),
    };

    const applied = await applyRouterLog(tx, at, decoded, pairing);
    if (applied.kind === "unmatched") {
      // A settlement for a row this indexer never saw created, which means the creating log is
      // before the start block. Inventing a row from a settlement would record a claim with no
      // origin and a created_at nobody knows.
      logger.warn(
        { chain: chainKey, what: applied.what, block: log.blockNumber.toString() },
        "settlement for something this indexer never saw created",
      );
      return false;
    }
    return applied.kind === "written";
  }
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function timestampOf(seconds: bigint | null): Date | null {
  return seconds === null ? null : new Date(Number(seconds) * 1000);
}
