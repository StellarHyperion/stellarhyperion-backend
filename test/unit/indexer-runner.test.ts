/**
 * What the process decides to watch, and what it admits to not watching.
 *
 * The runner's whole job is the second half of that sentence. A deployment record naming four
 * routers and a build that knows how to watch one of them is the failure that takes longest to
 * notice, because every table involved looks exactly like a quiet week. So these tests are mostly
 * about readiness strings, and the readiness strings are the product.
 *
 * Nothing here starts a poller. `buildIndexer` decides and `start` acts, which is what lets this
 * suite inspect the decision without a socket or a cursor read.
 */
import { describe, expect, it } from "vitest";

import { PolledWorker, buildIndexer } from "../../src/chains/runner.js";
import { loadConfig } from "../../src/config/config.js";
import type { ReadinessReport } from "../../src/runtime/readiness.js";
import { RecordingDb, capturingLogger } from "../stellar-fakes.js";
import { completeEnv } from "../helpers.js";

/** Readiness for every source, by name, so a test can name the one it means. */
async function reports(
  sources: readonly { readiness: () => ReadinessReport | Promise<ReadinessReport> }[],
): Promise<Record<string, ReadinessReport>> {
  const entries = await Promise.all(sources.map(async (source) => await source.readiness()));
  return Object.fromEntries(entries.map((report) => [report.name, report]));
}

function build(env: Readonly<Record<string, string | undefined>> = {}) {
  const config = loadConfig({ env: completeEnv(env) });
  const { logger, lines } = capturingLogger();
  const indexer = buildIndexer({ config, logger, db: new RecordingDb() });
  return { config, indexer, lines };
}

describe("what the runner builds", () => {
  it("watches every router the deployment record names, on both families", () => {
    // The fixture record names a Stellar router and a sepolia one, so a build that watches one of
    // them is the gap this whole suite exists to catch.
    const { indexer } = build();
    expect(indexer.workers.map((worker) => worker.name)).toEqual(["stellar-testnet", "sepolia"]);
  });

  it("watches nothing and says it is ready when the indexer is switched off", async () => {
    // What a second replica wants: answer questions, index nothing, and do not report itself
    // degraded for doing exactly what it was told.
    const { indexer } = build({ INDEXER_ENABLED: "false" });

    expect(indexer.workers).toEqual([]);
    const byName = await reports(indexer.readiness);
    expect(byName.indexer?.state).toBe("ready");
    expect(byName.indexer?.detail).toMatch(/disabled by configuration/);
  });

  it("gives every watcher its own readiness entry, named for its chain", async () => {
    // One entry per chain rather than one for the indexer, because the useful question during an
    // incident is which chain is behind, and an aggregate cannot answer it.
    const { indexer } = build();

    const byName = await reports(indexer.readiness);
    expect(Object.keys(byName).sort()).toEqual(["sepolia", "stellar-testnet"]);
    // Degraded before the first pass, on both, because nothing is indexed yet and saying ready
    // would be claiming to know about a chain this process has not read.
    expect(byName.sepolia?.state).toBe("degraded");
    expect(byName["stellar-testnet"]?.state).toBe("degraded");
  });

  it("calls itself degraded when the record named nothing it can watch", async () => {
    // A process that believes it is indexing and is watching nothing is worse than one that is
    // plainly switched off, because only the second one is honest about it.
    const { indexer, lines } = build({ HYPERION_DEPLOYMENTS_FILE: emptyRecord() });

    expect(indexer.workers).toEqual([]);
    const byName = await reports(indexer.readiness);
    expect(byName.indexer?.state).toBe("degraded");
    expect(byName.indexer?.detail).toMatch(/watching nothing/);
    expect(lines.some((line) => line.message.includes("named no routers"))).toBe(true);
  });

  it("starts nothing until it is told to", () => {
    // The seam this whole suite runs through. Building decides, starting acts, and no socket is
    // opened by any of the tests above because none of them call start.
    const { indexer } = build();
    expect(indexer.workers).toHaveLength(2);
    // Never started, so there is nothing to stop and stopping is still safe.
    return expect(indexer.stop()).resolves.toBeUndefined();
  });
});

describe("a worker's account of itself", () => {
  /** A pass that fails on demand, standing in for a chain nobody can reach. */
  class StubPass {
    failures = 0;
    constructor(
      readonly name: string,
      private readonly fail: boolean,
    ) {}

    tick(): Promise<boolean> {
      if (this.fail) {
        this.failures += 1;
        return Promise.reject(new Error("rpc is not answering"));
      }
      return Promise.resolve(false);
    }

    readiness(): ReadinessReport {
      return { name: this.name, state: "ready", detail: "current" };
    }
  }

  it("passes the pass's own answer through while the polling is working", async () => {
    const { logger } = capturingLogger();
    const worker = new PolledWorker(new StubPass("arc-testnet", false), 50, logger);

    expect(await worker.readiness()).toEqual({
      name: "arc-testnet",
      state: "ready",
      detail: "current",
    });
  });

  it("overrides it with the reason once the polling keeps failing", async () => {
    // Past a few consecutive failures the pass's cached state describes a chain nobody can
    // currently read, and why it cannot be read is the more useful thing to put in front of
    // whoever is looking.
    const { logger } = capturingLogger();
    const pass = new StubPass("arc-testnet", true);
    const worker = new PolledWorker(pass, 5, logger);

    worker.start();
    while (pass.failures < 3) await new Promise((resolve) => setTimeout(resolve, 5));
    const report = await worker.readiness();
    await worker.stop();

    expect(report.state).toBe("degraded");
    expect(report.detail).toContain("rpc is not answering");
  });

  it("never reports down, so one unreachable chain does not take the replica out of rotation", async () => {
    const { logger } = capturingLogger();
    const pass = new StubPass("arc-testnet", true);
    const worker = new PolledWorker(pass, 5, logger);

    worker.start();
    while (pass.failures < 3) await new Promise((resolve) => setTimeout(resolve, 5));
    const report = await worker.readiness();
    await worker.stop();

    expect(report.state).not.toBe("down");
  });

  it("stops after the pass it is in rather than mid tick", async () => {
    const { logger } = capturingLogger();
    const pass = new StubPass("arc-testnet", false);
    const worker = new PolledWorker(pass, 10_000, logger);

    worker.start();
    // Resolves rather than hanging on the ten second interval, because the sleep is interruptible.
    await expect(worker.stop()).resolves.toBeUndefined();
  });
});

/** A record that parses and names no chains, written to a temp path. */
function emptyRecord(): string {
  return new URL("../fixtures/deployments-empty.json", import.meta.url).pathname;
}
