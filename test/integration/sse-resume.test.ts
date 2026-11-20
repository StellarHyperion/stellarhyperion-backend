import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { Database } from "../../src/db/pool.js";
import { buildServer } from "../../src/http/server.js";
import { loadConfig } from "../../src/config/config.js";
import {
  decodeStreamCursor,
  encodeStreamCursor,
  STREAM_CURSOR_TTL_MS,
} from "../../src/http/stream-cursor.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";
import { requestQuery } from "../../src/http/request-budget.js";

const connection = process.env.TEST_DATABASE_URL;
(connection ? describe : describe.skip)("HTTP durable lifecycle stream resume", () => {
  let db: Database;
  let app: FastifyInstance;
  let address: string;
  let id: string;
  let cursor: string;
  const config = loadConfig({
    env: completeEnv({ RAILS_ENABLED: "false", KEEPER_ENABLED: "false" }),
  });
  beforeAll(async () => {
    db = Database.open(connection ?? "");
    app = buildServer({
      config,
      db,
      logger: capturingLogger().logger,
      readiness: [],
      redis: { ping: () => Promise.resolve("PONG") },
    });
    app.get("/budget-regression", async (request) => {
      await requestQuery(request, db, "SELECT pg_sleep(2)", [], 40);
      return { done: true };
    });
    app.get("/disconnect-regression", async (request) => {
      await requestQuery(request, db, "SELECT pg_sleep(2)");
      return { done: true };
    });
    address = await app.listen({ host: "127.0.0.1", port: 0 });
  });
  beforeEach(async () => {
    await db.query("DELETE FROM outbound_transfer WHERE origin_tx='sse291-fixture'");
    const row =
      await db.query(`INSERT INTO outbound_transfer(origin_chain,origin_router,route,nonce,sender,token,gross_amount,fee,net_amount,destination_chain,destination,origin_block,origin_tx)
      VALUES ('stellar-testnet','sse291-router',1,9998291,'sender','USDC',100,0,100,'sepolia','recipient',1,'sse291-fixture') RETURNING id`);
    id = String(row.rows[0]?.id);
    await db.query(
      "INSERT INTO rail_attestation(transfer_id,route,status) VALUES($1,1,'pending')",
      [id],
    );
    const history = await db.query(
      "SELECT id::text FROM rail_attestation_history WHERE transfer_id=$1",
      [id],
    );
    cursor = encodeStreamCursor(id, String(history.rows[0]?.id));
  });
  afterAll(async () => {
    await app.close();
    await db.query("DELETE FROM outbound_transfer WHERE origin_tx='sse291-fixture'");
    await db.close();
  });
  const endpoint = () => `${address}/v1/transfers/${id}/stream?pollIntervalMs=1000`;
  it("propagates an HTTP deadline and an abandoned socket into server-side cancellation", async () => {
    const start = performance.now();
    const deadline = await fetch(`${address}/budget-regression`);
    expect(deadline.status).toBe(504);
    expect(await deadline.json()).toMatchObject({ error: "request_budget_exceeded" });
    expect(performance.now() - start).toBeLessThan(1000);
    await expect(
      fetch(`${address}/disconnect-regression`, { signal: AbortSignal.timeout(40) }),
    ).rejects.toThrow();
    for (let attempt = 0; attempt < 40; attempt++) {
      const active = await db.query(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='hyperion-backend' AND query='SELECT pg_sleep(2)' AND state='active'",
      );
      if (active.rows[0]?.count === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const active = await db.query(
      "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='hyperion-backend' AND query='SELECT pg_sleep(2)' AND state='active'",
    );
    expect(active.rows[0]?.count).toBe(0);
    await expect(db.query("SELECT 1 AS healthy")).resolves.toMatchObject({
      rows: [{ healthy: 1 }],
    });
  });
  it("replays every committed rail change after the accepted cursor, including changes made while disconnected", async () => {
    await db.query("UPDATE rail_attestation SET status='attested' WHERE transfer_id=$1", [id]);
    await db.query("UPDATE rail_attestation SET status='failed' WHERE transfer_id=$1", [id]);
    const response = await fetch(endpoint(), {
      headers: { "Last-Event-ID": cursor },
      signal: AbortSignal.timeout(3000),
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let text = "";
    while (!text.includes("event: transfer_update")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    await reader.cancel();
    const events = text.split("\n\n").filter((part) => part.includes("event: rail_transition"));
    expect(events).toHaveLength(2);
    const transitions = events.map(
      (event) =>
        JSON.parse(event.split("data: ")[1] ?? "{}") as { newStatus: string; historyId: string },
    );
    expect(transitions.map((event) => event.newStatus)).toEqual(["attested", "failed"]);
    for (const [index, event] of events.entries()) {
      const token = event.split("\n")[0]?.slice(4) ?? "";
      expect(decodeStreamCursor(token, id)).toBe(transitions[index]?.historyId);
    }
  });
  it("returns explicit resync instructions for expired and invalid source cursors", async () => {
    for (const token of [
      encodeStreamCursor(id, "0", Date.now() - STREAM_CURSOR_TTL_MS - 1),
      encodeStreamCursor("99999999", "0"),
      encodeStreamCursor(id, "9223372036854775807"),
    ]) {
      const response = await fetch(endpoint(), { headers: { "Last-Event-ID": token } });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: "cursor_expired", resync: true });
    }
  });
  it("bounds replay and requires resync when disconnected history exceeds its window", async () => {
    await db.transaction(async (tx) => {
      await tx.query(
        "SELECT set_config('hyperion.rail_reconcile_transfer',$1,true),set_config('hyperion.rail_reconcile_reason','operator_requeue',true)",
        [id],
      );
      for (let step = 0; step < 51; step++) {
        await tx.query("UPDATE rail_attestation SET status='attested' WHERE transfer_id=$1", [id]);
        await tx.query("UPDATE rail_attestation SET status='pending' WHERE transfer_id=$1", [id]);
      }
    });
    const response = await fetch(endpoint(), { headers: { "Last-Event-ID": cursor } });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "cursor_expired", resync: true });
  });
  it("stops polling after its client disconnects", async () => {
    const queries = vi.spyOn(db, "query");
    const response = await fetch(endpoint());
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const count = queries.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(queries.mock.calls).toHaveLength(count);
    queries.mockRestore();
  });
});
