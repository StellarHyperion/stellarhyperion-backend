import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/config.js";
import type { Database } from "../../src/db/pool.js";
import type { FormattedTransfer } from "../../src/http/routes/transfers.js";
import { buildServer } from "../../src/http/server.js";
import {
  BoundedSseWriter,
  TransferStreamJournal,
  decodeSseCursor,
  type ResyncPayload,
} from "../../src/http/sse-cursor.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ACTIVE_TESTNET_DEPLOYMENTS = join(REPO_ROOT, "deployments", "testnet.json");

interface ParsedSseEvent {
  readonly id: string | null;
  readonly event: string;
  readonly data: string;
}

function parseSseFrames(payload: string): readonly ParsedSseEvent[] {
  const blocks = payload
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
  const events: ParsedSseEvent[] = [];

  for (const block of blocks) {
    let id: string | null = null;
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("id: ")) {
        id = line.slice(4).trim();
      } else if (line.startsWith("event: ")) {
        event = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        dataLines.push(line.slice(6));
      }
    }
    if (dataLines.length > 0) {
      events.push({ id, event, data: dataLines.join("\n") });
    }
  }

  return events;
}

const pg = new PGlite();
const db = {
  query: async (sql: string, params: readonly unknown[] = []) => {
    const result = await pg.query(sql, [...params]);
    const int8 = result.fields
      .filter((field) => field.dataTypeID === 20)
      .map((field) => field.name);
    const rows = result.rows.map((raw) => {
      const row = { ...(raw as Record<string, unknown>) };
      for (const column of int8) {
        const value = row[column];
        if (typeof value === "number" || typeof value === "bigint") {
          row[column] = String(value);
        }
      }
      return row;
    });
    return { rows, rowCount: result.affectedRows ?? result.rows.length };
  },
  ping: async () => {
    await pg.query("SELECT 1");
  },
};

let clockMs = 1_762_000_000_000;
const streamJournal = new TransferStreamJournal({
  cursorTtlMs: 60_000,
  maxEventsPerTransfer: 4,
  now: () => clockMs,
});
const { logger } = capturingLogger();
const config = loadConfig({
  env: completeEnv({
    KEEPER_ENABLED: "false",
    HYPERION_DEPLOYMENTS_FILE: ACTIVE_TESTNET_DEPLOYMENTS,
  }),
});
const app = buildServer({
  config,
  logger,
  db: db as unknown as Database,
  readiness: [],
  redis: { ping: () => Promise.resolve("PONG") },
  sse: {
    cursorTtlMs: 60_000,
    maxEventsPerTransfer: 4,
    maxPendingFrames: 3,
    drainTimeoutMs: 60,
    now: () => clockMs,
  },
  streamJournal,
});

beforeAll(async () => {
  for (const name of [
    "1790900000000_initial-schema.sql",
    "1791000000000_cursor-block-hash.sql",
    "1791100000000_cursor-autovacuum-tuning.sql",
  ]) {
    const migrationPath = join(REPO_ROOT, "migrations", name);
    const sql = readFileSync(migrationPath, "utf8").split("-- Down Migration")[0] ?? "";
    await pg.exec(sql);
  }
  await app.ready();
}, 30_000);

afterAll(async () => {
  await app.close();
  await pg.close();
});

describe("Resumable SSE event cursors", () => {
  it("replays all committed lifecycle changes from an accepted cursor without missing intermediate stages", async () => {
    await pg.exec(`
      INSERT INTO outbound_transfer (
        origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
        destination_chain, destination, origin_block, origin_tx, observed_at
      ) VALUES (
        'stellar-testnet',
        0,
        101,
        'GDXRQQETEZHGRJTE3U7DYGIWGGYGMM6EAS5NWGPGN2WXFXZYZ6QZIANA',
        'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
        10000000,
        30000,
        9970000,
        'sepolia',
        '0x0000000000000000000000006ef8032ffe4943f27388172549f6700f18bb8b38',
        5434100,
        'd2d112fdef5b381534eb10e92806bd0025f307ffb0b2da0d0d3194d3f7892ca2',
        '2026-10-29T11:00:00.000Z'::timestamptz
      );
    `);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as { port: number };
    const abortController = new AbortController();

    const firstStream = await fetch(
      `http://127.0.0.1:${String(address.port)}/v1/transfers/1/stream`,
      {
        signal: abortController.signal,
      },
    );
    expect(firstStream.status).toBe(200);
    const reader = firstStream.body?.getReader();
    expect(reader).toBeDefined();

    let firstPayload = "";
    if (reader !== undefined) {
      const chunk = await reader.read();
      firstPayload = new TextDecoder().decode(chunk.value);
    }
    abortController.abort();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(streamJournal.diagnostics().activeStreams).toBe(0);

    const initialEvents = parseSseFrames(firstPayload);
    expect(initialEvents).toHaveLength(1);
    const initialCursor = initialEvents[0]?.id ?? "";
    expect(decodeSseCursor(initialCursor)?.stage).toBe("initiated");

    // While client is disconnected, both rail attestation and canonical inbound delivery commit.
    await pg.exec(`
      INSERT INTO rail_attestation (
        transfer_id, route, status, rail_status, rail_reference, attested_at
      ) VALUES (
        1, 0, 'delivered', 'complete', 'iris-101', '2026-10-29T11:01:00.000Z'::timestamptz
      );

      INSERT INTO inbound_delivery (
        destination_chain, route, source_chain, source_nonce, recipient, token,
        amount, delivered, destination_block, destination_tx, observed_at
      ) VALUES (
        'sepolia',
        0,
        'stellar-testnet',
        101,
        '0x6ef8032ffe4943f27388172549f6700f18bb8b38',
        '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        997000,
        true,
        9415000,
        '0xb8a185a1e723443ab0b787225006fe56db80009fe796c69e8c4f6b8bf31db555',
        '2026-10-29T11:02:00.000Z'::timestamptz
      );
    `);

    clockMs += 5_000;
    const resumed = await app.inject({
      method: "GET",
      url: "/v1/transfers/1/stream",
      headers: { "last-event-id": initialCursor },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.headers["x-hyperion-stream-resync"]).toBeUndefined();

    const replayed = parseSseFrames(resumed.payload);
    expect(replayed.map((item) => item.event)).toEqual([
      "transfer_update",
      "transfer_update",
      "complete",
    ]);

    const deliveringPayload = JSON.parse(replayed[0]?.data ?? "{}") as {
      stage: string;
      destination: { delivered: boolean };
    };
    const deliveredPayload = JSON.parse(replayed[1]?.data ?? "{}") as {
      stage: string;
      destination: { delivered: boolean; amount: string };
    };
    expect(deliveringPayload.stage).toBe("delivering");
    expect(deliveringPayload.destination.delivered).toBe(false);
    expect(deliveredPayload.stage).toBe("delivered");
    expect(deliveredPayload.destination.delivered).toBe(true);
    expect(deliveredPayload.destination.amount).toBe("997000");

    // Reconnecting from the delivered update cursor replays only the terminal complete frame.
    const deliveredUpdateCursor = replayed[1]?.id ?? "";
    const resumeBeforeComplete = await app.inject({
      method: "GET",
      url: `/v1/transfers/1/stream?cursor=${encodeURIComponent(deliveredUpdateCursor)}`,
    });
    const finalReplay = parseSseFrames(resumeBeforeComplete.payload);
    expect(finalReplay.map((item) => item.event)).toEqual(["complete"]);

    // Stateless replica resume also reconstructs missed transitions cleanly.
    const statelessApp = buildServer({
      config,
      logger,
      db: db as unknown as Database,
      readiness: [],
      sse: { cursorTtlMs: 60_000, now: () => clockMs },
    });
    const statelessResumed = await statelessApp.inject({
      method: "GET",
      url: "/v1/transfers/1/stream",
      headers: { "last-event-id": initialCursor },
    });
    expect(parseSseFrames(statelessResumed.payload).map((item) => item.event)).toEqual([
      "transfer_update",
      "transfer_update",
      "complete",
    ]);
    await statelessApp.close();
  });

  it("emits explicit resync_required instructions for expired, evicted, mismatched, and malformed cursors", async () => {
    await pg.exec(`
      INSERT INTO outbound_transfer (
        origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
        destination_chain, destination, origin_block, origin_tx, observed_at
      ) VALUES (
        'stellar-testnet',
        0,
        102,
        'GDXRQQETEZHGRJTE3U7DYGIWGGYGMM6EAS5NWGPGN2WXFXZYZ6QZIANA',
        'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
        5000000,
        15000,
        4985000,
        'sepolia',
        '0x0000000000000000000000006ef8032ffe4943f27388172549f6700f18bb8b38',
        5434200,
        '32625b8565111bafac0eff8c218c09332a79f5ea7df4ca48dc568cc68f8e153e',
        '2026-10-29T11:05:00.000Z'::timestamptz
      );

      INSERT INTO inbound_delivery (
        destination_chain, route, source_chain, source_nonce, recipient, token,
        amount, delivered, destination_block, destination_tx, observed_at
      ) VALUES (
        'sepolia',
        0,
        'stellar-testnet',
        102,
        '0x6ef8032ffe4943f27388172549f6700f18bb8b38',
        '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        498500,
        true,
        9415100,
        '0x6c69ef4219b7ac35075f76f3fa1d9db1fdd1995c56b4452ea1523155f6f7520b',
        '2026-10-29T11:06:00.000Z'::timestamptz
      );
    `);

    const fresh = await app.inject({ method: "GET", url: "/v1/transfers/2/stream" });
    const freshCursor = parseSseFrames(fresh.payload)[0]?.id ?? "";

    // Advance past cursorTtlMs (60_000 ms).
    clockMs += 65_000;
    const expiredRes = await app.inject({
      method: "GET",
      url: "/v1/transfers/2/stream",
      headers: { "last-event-id": freshCursor },
    });
    expect(expiredRes.statusCode).toBe(200);
    expect(expiredRes.headers["x-hyperion-stream-resync"]).toBe("required");
    const expiredFrames = parseSseFrames(expiredRes.payload);
    expect(expiredFrames).toHaveLength(1);
    expect(expiredFrames[0]?.event).toBe("resync_required");
    const expiredBody = JSON.parse(expiredFrames[0]?.data ?? "{}") as ResyncPayload;
    expect(expiredBody.reason).toBe("expired");
    expect(expiredBody.snapshotUrl).toBe("/v1/transfers/2");
    expect(expiredBody.streamUrl).toBe("/v1/transfers/2/stream");
    expect(expiredBody.instructions).toContain("snapshotUrl");

    // Wrong-transfer cursor.
    const reissued = await app.inject({ method: "GET", url: "/v1/transfers/2/stream" });
    const transfer2Cursor = parseSseFrames(reissued.payload)[0]?.id ?? "";
    const mismatchRes = await app.inject({
      method: "GET",
      url: "/v1/transfers/1/stream",
      headers: { "last-event-id": transfer2Cursor },
    });
    const mismatchBody = JSON.parse(
      parseSseFrames(mismatchRes.payload)[0]?.data ?? "{}",
    ) as ResyncPayload;
    expect(mismatchBody.reason).toBe("transfer_mismatch");

    // Malformed cursor.
    const malformedRes = await app.inject({
      method: "GET",
      url: "/api/v1/transfers/2/stream",
      headers: { "last-event-id": "not-a-valid-cursor" },
    });
    const malformedBody = JSON.parse(
      parseSseFrames(malformedRes.payload)[0]?.data ?? "{}",
    ) as ResyncPayload;
    expect(malformedBody.reason).toBe("malformed_cursor");
    expect(malformedBody.snapshotUrl).toBe("/api/v1/transfers/2");

    // Conflicting header and query cursor.
    const conflictingRes = await app.inject({
      method: "GET",
      url: "/v1/transfers/2/stream?cursor=hyp1.other",
      headers: { "last-event-id": transfer2Cursor },
    });
    const conflictingBody = JSON.parse(
      parseSseFrames(conflictingRes.payload)[0]?.data ?? "{}",
    ) as ResyncPayload;
    expect(conflictingBody.reason).toBe("conflicting_cursor");

    // Evicted cursor when per-transfer ring buffer overflows.
    const smallJournal = new TransferStreamJournal({
      cursorTtlMs: 60_000,
      maxEventsPerTransfer: 2,
      now: () => clockMs,
    });
    const detail = (await app.inject("/v1/transfers/1")).json<FormattedTransfer>();
    const firstRecorded = smallJournal.recordInitial({
      ...detail,
      stage: "initiated",
      destination: {
        ...detail.destination,
        delivered: false,
        amount: null,
        txHash: null,
        block: null,
        deliveredAt: null,
      },
      rail: null,
    });
    const evictedCursor = firstRecorded.latestUpdateFrame.cursor;
    smallJournal.recordInitial({
      ...detail,
      stage: "attesting",
      destination: {
        ...detail.destination,
        delivered: false,
      },
    });
    const evictedOutcome = smallJournal.resolveResume("1", evictedCursor, detail);
    expect(evictedOutcome).toMatchObject({ ok: false, reason: "evicted" });
  });

  it("handles socket backpressure, skips heartbeats while congested, and releases all listeners without leaking", () => {
    class FakeRequest extends EventEmitter {}
    class FakeResponse extends EventEmitter {
      writableEnded = false;
      destroyed = false;
      allowWrites = false;
      readonly written: string[] = [];

      write(chunk: string): boolean {
        this.written.push(chunk);
        return this.allowWrites;
      }

      end(): void {
        this.writableEnded = true;
      }
    }

    const req = new FakeRequest();
    const res = new FakeResponse();
    let closeCalls = 0;

    const writer = new BoundedSseWriter({
      requestRaw: req as unknown as IncomingMessage,
      responseRaw: res as unknown as ServerResponse,
      maxPendingFrames: 2,
      maxBufferedBytes: 4096,
      drainTimeoutMs: 500,
      onClose: () => {
        closeCalls += 1;
      },
    });

    // First write triggers backpressure (`allowWrites = false`).
    expect(writer.writeFrame("frame-1\n\n")).toBe(true);
    expect(writer.isBackpressured()).toBe(true);

    // Heartbeats are dropped while backpressured so slow clients never accumulate ping backlog.
    writer.writeHeartbeat(": ping\n\n");
    expect(res.written).toEqual(["frame-1\n\n"]);

    // Queue up to maxPendingFrames (2).
    expect(writer.writeFrame("frame-2\n\n")).toBe(true);
    expect(writer.writeFrame("frame-3\n\n")).toBe(true);

    // Drain flushes queued frames in order.
    res.allowWrites = true;
    res.emit("drain");
    expect(writer.isBackpressured()).toBe(false);
    expect(res.written).toEqual(["frame-1\n\n", "frame-2\n\n", "frame-3\n\n"]);

    // Exceeding maxPendingFrames while stalled evicts the slow reader and detaches all listeners.
    res.allowWrites = false;
    expect(writer.writeFrame("frame-4\n\n")).toBe(true);
    expect(writer.writeFrame("frame-5\n\n")).toBe(true);
    expect(writer.writeFrame("frame-6\n\n")).toBe(true);
    expect(writer.writeFrame("frame-7-overflow\n\n")).toBe(false);

    expect(res.writableEnded).toBe(true);
    expect(closeCalls).toBe(1);
    expect(req.listenerCount("close")).toBe(0);
    expect(res.listenerCount("close")).toBe(0);
    expect(res.listenerCount("error")).toBe(0);
    expect(res.listenerCount("drain")).toBe(0);
    expect(streamJournal.diagnostics().activeStreams).toBe(0);
  });
});
