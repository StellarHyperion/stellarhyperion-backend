import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Database } from "../../src/db/pool.js";
import { writeOutbound, writeInbound } from "../../src/chains/writers.js";
import { evaluateFreshnessSlo } from "../../src/runtime/freshness.js";
import { generateDiagnosticsBundle } from "../../src/diagnostics/bundle.js";
import { loadConfig } from "../../src/config/config.js";
import { completeEnv } from "../helpers.js";

const connection = process.env.TEST_DATABASE_URL;
const suite = connection ? describe : describe.skip;
suite("durable operational evidence on PostgreSQL", () => {
  let db: Database;
  const source = "observability-test";
  const config = loadConfig({
    env: completeEnv({
      INDEXER_ENABLED: "false",
      RAILS_ENABLED: "false",
      KEEPER_ENABLED: "false",
      FRESHNESS_MAX_PROOF_BACKLOG_COUNT: "1",
    }),
  });
  const clean = async () => {
    await db.query("DELETE FROM pending_claim WHERE source_chain = $1", [source]);
    await db.query("DELETE FROM inbound_delivery WHERE source_chain = $1", [source]);
    await db.query("DELETE FROM outbound_transfer WHERE origin_chain = $1", [source]);
  };
  beforeAll(() => {
    db = Database.open(connection ?? "", { maxConnections: 1 });
  });
  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await db.close();
  });

  const outbound = (router: string, nonce: bigint) =>
    writeOutbound(
      db,
      {
        chainKey: source,
        router,
        block: 100n,
        txHash: `source-${router}-${nonce}`,
        logIndex: 1,
        observedAt: new Date(),
      },
      {
        route: 1,
        nonce,
        sender: "Gsender",
        token: "USDC",
        grossAmount: 100n,
        fee: 1n,
        netAmount: 99n,
        destinationChain: "stellar-testnet",
        destination: "Grecipient",
        railRef: null,
      },
    );

  it("requires delivered evidence for the exact router or an unambiguous legacy source", async () => {
    await outbound("router-a", 1n);
    await outbound("router-b", 1n);
    await outbound("router-c", 2n);
    const ids = (
      await db.query(
        "SELECT id, origin_router FROM outbound_transfer WHERE origin_chain=$1 ORDER BY id",
        [source],
      )
    ).rows;
    const firstId = BigInt(String(ids[0]?.id));
    await writeInbound(
      db,
      {
        chainKey: "stellar-testnet",
        block: 101n,
        txHash: "bound-proof",
        logIndex: 1,
        observedAt: new Date(),
      },
      {
        route: 1,
        sourceChain: source,
        sourceNonce: 1n,
        sourceTransferId: firstId,
        railMessageId: null,
        recipient: "Grecipient",
        token: "USDC",
        amount: 99n,
        delivered: true,
        claimId: null,
      },
    );
    await writeInbound(
      db,
      {
        chainKey: "stellar-testnet",
        block: 101n,
        txHash: "parked-proof",
        logIndex: 2,
        observedAt: new Date(),
      },
      {
        route: 1,
        sourceChain: source,
        sourceNonce: 2n,
        railMessageId: null,
        recipient: "Grecipient",
        token: "USDC",
        amount: 99n,
        delivered: false,
        claimId: 800001n,
      },
    );
    let report = await evaluateFreshnessSlo(db, config);
    expect(report.lanes.find((lane) => lane.originChain === source)).toMatchObject({
      pendingCount: 2,
      status: "breached",
      stage: "destination_proof",
    });
    await db.query(
      "UPDATE inbound_delivery SET source_transfer_id=NULL WHERE source_chain=$1 AND source_nonce=1",
      [source],
    );
    report = await evaluateFreshnessSlo(db, config);
    expect(report.lanes.find((lane) => lane.originChain === source)?.pendingCount).toBe(3);
    await db.query(
      "DELETE FROM outbound_transfer WHERE origin_chain=$1 AND origin_router='router-b'",
      [source],
    );
    report = await evaluateFreshnessSlo(db, config);
    expect(report.lanes.find((lane) => lane.originChain === source)?.pendingCount).toBe(1);
  });

  it("enforces read-only diagnostic connections and keeps real schema probes actionable", async () => {
    const readOnly = Database.open(connection ?? "", { readOnly: true, maxConnections: 1 });
    try {
      await expect(
        readOnly.query("CREATE TABLE forbidden_diagnostics_write(id int)"),
      ).rejects.toMatchObject({ code: "25006" });
      const bundle = await generateDiagnosticsBundle({
        config,
        db: readOnly,
        revision: "abc123456",
      });
      expect(bundle.metadata.revision).toBe("abc123456");
      expect(bundle.probes.length).toBeGreaterThan(0);
      expect(bundle.probes.filter((probe) => probe.status === "failed")).toEqual([]);
      expect(bundle.schema.tableCounts.indexer_worker_heartbeat).not.toBeNull();
    } finally {
      await readOnly.close();
    }
  });

  it("exposes queued pool requests before timeout without storing SQL parameters", async () => {
    let release: () => void = () => undefined;
    let acquired: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const transaction = db.transaction(async () => {
      acquired();
      await held;
    });
    await ready;
    const pending = db.query("SELECT count(*) FROM outbound_transfer WHERE sender=$1", [
      "private-wallet-value",
    ]);
    try {
      await expect.poll(() => db.poolSnapshot().waitingRequests).toBe(1);
      expect(db.poolSnapshot().saturated).toBe(true);
    } finally {
      release();
      await transaction;
      await pending;
    }
    const snapshot = db.telemetrySnapshot();
    expect(snapshot.workloads.transfers?.count).toBeGreaterThan(0);
    expect(JSON.stringify(snapshot)).not.toContain("private-wallet-value");
  });
});
