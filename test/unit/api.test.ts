/**
 * Unit tests for the REST API surface.
 *
 * Verifies endpoint routing, JSON response formatting, 404 handlers,
 * and lifecycle stage derivation without requiring a live Postgres instance.
 */
import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/config.js";
import type { Database } from "../../src/db/pool.js";
import { buildServer } from "../../src/http/server.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

/** Mock database for HTTP unit testing. */
class MockDb {
  constructor(public queryMap: Record<string, readonly Record<string, unknown>[]>) {}

  query(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: readonly Record<string, unknown>[]; rowCount: number }> {
    for (const [key, rows] of Object.entries(this.queryMap)) {
      if (text.includes(key)) {
        if (text.includes("WHERE t.id = $1") && params.length > 0) {
          const id = String(params[0]);
          const filtered = rows.filter((r) => String(r.id) === id);
          return Promise.resolve({ rows: filtered, rowCount: filtered.length });
        }
        return Promise.resolve({ rows, rowCount: rows.length });
      }
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }
}

describe("REST API endpoints", () => {
  const config = loadConfig({ env: completeEnv() });
  const { logger } = capturingLogger();

  it("serves transfer status by origin chain and nonce", async () => {
    const db = new MockDb({
      outbound_transfer: [
        {
          id: "1",
          origin_chain: "sepolia",
          route: 0,
          nonce: "42",
          sender: "0x1111",
          token: "0x2222",
          gross_amount: "1000",
          fee: "10",
          net_amount: "990",
          destination_chain: "stellar-testnet",
          destination: "GBB...",
          rail_ref: null,
          origin_block: "100",
          origin_tx: "0xabc",
          observed_at: new Date("2026-10-07T12:00:00Z"),
          attestation_status: "attested",
          rail_status: "complete",
          rail_reference: "iris-42",
          attested_at: new Date("2026-10-07T12:01:00Z"),
          last_error: null,
          inbound_delivered: false,
          destination_block: null,
          destination_tx: null,
          delivered_at: null,
          claim_id: null,
          claim_settled: false,
        },
      ],
    });

    const app = buildServer({
      config,
      logger,
      db: db as unknown as Database,
      readiness: [],
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/transfers/sepolia/42",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe("1");
    expect(body.stage).toBe("delivering");
    expect(body.origin.chain).toBe("sepolia");
    expect(body.origin.nonce).toBe("42");
    expect(body.rail.status).toBe("attested");
    expect(body.rail.reference).toBe("iris-42");
  });

  it("returns 404 when transfer is not found", async () => {
    const db = new MockDb({});
    const app = buildServer({
      config,
      logger,
      db: db as unknown as Database,
      readiness: [],
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/transfers/sepolia/999",
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });

  it("lists transfers with pagination metadata", async () => {
    const db = new MockDb({
      outbound_transfer: [
        {
          id: "1",
          origin_chain: "sepolia",
          route: 0,
          nonce: "1",
          sender: "0x1111",
          token: "0x2222",
          gross_amount: "100",
          fee: "1",
          net_amount: "99",
          destination_chain: "stellar-testnet",
          destination: "GBB...",
          rail_ref: null,
          origin_block: "10",
          origin_tx: "0x1",
          observed_at: new Date("2026-10-07T12:00:00Z"),
          attestation_status: null,
          rail_status: null,
          rail_reference: null,
          attested_at: null,
          last_error: null,
          inbound_delivered: false,
          destination_block: null,
          destination_tx: null,
          delivered_at: null,
          claim_id: null,
          claim_settled: false,
        },
      ],
    });

    const app = buildServer({
      config,
      logger,
      db: db as unknown as Database,
      readiness: [],
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/transfers?limit=10&offset=0",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transfers).toHaveLength(1);
    expect(body.limit).toBe(10);
    expect(body.offset).toBe(0);
    expect(body.count).toBe(1);
  });

  it("serves parked claims list and by id", async () => {
    const db = new MockDb({
      pending_claim: [
        {
          id: "3",
          chain: "stellar-testnet",
          claim_id: "5",
          recipient: "GAA...",
          token: "CAS...",
          amount: "5000",
          route: 0,
          source_chain: "sepolia",
          source_nonce: "12",
          created_at: new Date("2026-10-07T10:00:00Z"),
          settled: false,
          observed_at: new Date("2026-10-07T10:00:00Z"),
        },
      ],
    });

    const app = buildServer({
      config,
      logger,
      db: db as unknown as Database,
      readiness: [],
    });

    const byIdRes = await app.inject({
      method: "GET",
      url: "/v1/claims/stellar-testnet/5",
    });

    expect(byIdRes.statusCode).toBe(200);
    const claim = byIdRes.json();
    expect(claim.claimId).toBe("5");
    expect(claim.settled).toBe(false);

    const listRes = await app.inject({
      method: "GET",
      url: "/v1/claims?settled=false",
    });

    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().claims).toHaveLength(1);
  });

  it("serves route health with blocker labels", async () => {
    const db = new MockDb({
      route_health: [
        {
          origin_chain: "stellar-testnet",
          destination_chain: "sepolia",
          route: 0,
          token: "CAS...",
          available: true,
          blocker: 0,
          flow_available: "10000000",
          observed_at: new Date("2026-10-07T12:00:00Z"),
        },
      ],
    });

    const app = buildServer({
      config,
      logger,
      db: db as unknown as Database,
      readiness: [],
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/routes/health",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.routes).toHaveLength(1);
    expect(body.routes[0].available).toBe(true);
    expect(body.routes[0].blocker.code).toBe(0);
    expect(body.routes[0].blocker.label).toBe("Ready");
  });

  it("serves system aggregate metrics", async () => {
    const db = new MockDb({
      outbound_transfer: [{ count: 120 }],
      inbound_delivery: [{ count: 110 }],
      pending_claim: [{ total: 10, settled: 8, unsettled: 2 }],
      rail_attestation: [
        { status: "attested", count: 15 },
        { status: "delivered", count: 105 },
      ],
      indexer_cursor: [
        {
          chain_key: "sepolia",
          cursor_block: "7890",
          cursor_hash: "0xhash",
          updated_at: new Date("2026-10-07T12:00:00Z"),
        },
      ],
    });

    const app = buildServer({
      config,
      logger,
      db: db as unknown as Database,
      readiness: [],
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/metrics",
    });

    expect(res.statusCode).toBe(200);
    const metrics = res.json();
    expect(metrics.transfers.totalOutbound).toBe(120);
    expect(metrics.transfers.totalInbound).toBe(110);
    expect(metrics.claims.unsettled).toBe(2);
    expect(metrics.railAttestations.attested).toBe(15);
    expect(metrics.cursors).toHaveLength(1);
  });

  it("serves transfer status by transfer id", async () => {
    const db = new MockDb({
      outbound_transfer: [
        {
          id: "10",
          origin_chain: "sepolia",
          route: 0,
          nonce: "42",
          sender: "0x1111",
          token: "0x2222",
          gross_amount: "1000",
          fee: "10",
          net_amount: "990",
          destination_chain: "stellar-testnet",
          destination: "GBB...",
          rail_ref: null,
          origin_block: "100",
          origin_tx: "0xabc",
          observed_at: new Date("2026-10-07T12:00:00Z"),
          attestation_status: "attested",
          rail_status: "complete",
          rail_reference: "iris-42",
          attested_at: new Date("2026-10-07T12:01:00Z"),
          last_error: null,
          inbound_delivered: false,
          destination_block: null,
          destination_tx: null,
          delivered_at: null,
          claim_id: null,
          claim_settled: false,
        },
      ],
    });

    const app = buildServer({
      config,
      logger,
      db: db as unknown as Database,
      readiness: [],
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/transfers/10",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe("10");

    const apiRes = await app.inject({
      method: "GET",
      url: "/api/v1/transfers/10",
    });
    expect(apiRes.statusCode).toBe(200);
    expect(apiRes.json().id).toBe("10");
  });

  it("serves standard SSE formatted stream and completes for finalized transfer", async () => {
    const db = new MockDb({
      outbound_transfer: [
        {
          id: "1",
          origin_chain: "sepolia",
          route: 0,
          nonce: "42",
          sender: "0x1111",
          token: "0x2222",
          gross_amount: "1000",
          fee: "10",
          net_amount: "990",
          destination_chain: "stellar-testnet",
          destination: "GBB...",
          rail_ref: null,
          origin_block: "100",
          origin_tx: "0xabc",
          observed_at: new Date("2026-10-07T12:00:00Z"),
          attestation_status: "delivered",
          rail_status: "complete",
          rail_reference: "iris-42",
          attested_at: new Date("2026-10-07T12:01:00Z"),
          last_error: null,
          inbound_delivered: true,
          destination_block: "500",
          destination_tx: "0xdef",
          delivered_at: new Date("2026-10-07T12:05:00Z"),
          claim_id: null,
          claim_settled: false,
        },
      ],
    });

    const app = buildServer({
      config,
      logger,
      db: db as unknown as Database,
      readiness: [],
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/transfers/1/stream",
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.payload).toContain("event: transfer_update\ndata: ");
    expect(res.payload).toContain("event: complete\ndata: ");
    expect(res.payload).toContain('"stage":"delivered"');
  });

  it("emits transfer_update on status change and sends periodic ping comments", async () => {
    const transferRow: Record<string, unknown> = {
      id: "2",
      origin_chain: "sepolia",
      route: 0,
      nonce: "43",
      sender: "0x1111",
      token: "0x2222",
      gross_amount: "1000",
      fee: "10",
      net_amount: "990",
      destination_chain: "stellar-testnet",
      destination: "GBB...",
      rail_ref: null,
      origin_block: "100",
      origin_tx: "0xabc",
      observed_at: new Date("2026-10-07T12:00:00Z"),
      attestation_status: "pending",
      rail_status: null,
      rail_reference: null,
      attested_at: null,
      last_error: null,
      inbound_delivered: false,
      destination_block: null,
      destination_tx: null,
      delivered_at: null,
      claim_id: null,
      claim_settled: false,
    };

    const db = new MockDb({
      outbound_transfer: [transferRow],
    });

    const app = buildServer({
      config,
      logger,
      db: db as unknown as Database,
      readiness: [],
    });

    const injectPromise = app.inject({
      method: "GET",
      url: "/api/v1/transfers/2/stream?pollIntervalMs=20&heartbeatIntervalMs=25",
    });

    setTimeout(() => {
      db.queryMap = {
        outbound_transfer: [
          {
            ...transferRow,
            attestation_status: "attested",
            rail_reference: "ref-43",
          },
        ],
      };
    }, 40);

    setTimeout(() => {
      db.queryMap = {
        outbound_transfer: [
          {
            ...transferRow,
            attestation_status: "delivered",
            rail_reference: "ref-43",
            inbound_delivered: true,
          },
        ],
      };
    }, 80);

    const res = await injectPromise;
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.payload).toContain(": ping\n\n");
    expect(res.payload).toContain("event: transfer_update");
    expect(res.payload).toContain("event: complete");
    expect(res.payload).toContain('"stage":"delivering"');
    expect(res.payload).toContain('"stage":"delivered"');
  });

  it("closes connection gracefully on client abort", async () => {
    const db = new MockDb({
      outbound_transfer: [
        {
          id: "3",
          origin_chain: "sepolia",
          route: 0,
          nonce: "44",
          sender: "0x1111",
          token: "0x2222",
          gross_amount: "1000",
          fee: "10",
          net_amount: "990",
          destination_chain: "stellar-testnet",
          destination: "GBB...",
          rail_ref: null,
          origin_block: "100",
          origin_tx: "0xabc",
          observed_at: new Date("2026-10-07T12:00:00Z"),
          attestation_status: "pending",
          rail_status: null,
          rail_reference: null,
          attested_at: null,
          last_error: null,
          inbound_delivered: false,
          destination_block: null,
          destination_tx: null,
          delivered_at: null,
          claim_id: null,
          claim_settled: false,
        },
      ],
    });

    const app = buildServer({
      config,
      logger,
      db: db as unknown as Database,
      readiness: [],
    });

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as { port: number };
    const abortController = new AbortController();

    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/transfers/3/stream?pollIntervalMs=20&heartbeatIntervalMs=20`,
      { signal: abortController.signal },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (reader) {
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      expect(text).toContain("event: transfer_update");
    }

    abortController.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await app.close();
  });

  it("returns 404 when stream or lookup requested for non-existent transfer", async () => {
    const db = new MockDb({});
    const app = buildServer({
      config,
      logger,
      db: db as unknown as Database,
      readiness: [],
    });

    const streamRes = await app.inject({
      method: "GET",
      url: "/api/v1/transfers/999/stream",
    });
    expect(streamRes.statusCode).toBe(404);
    expect(streamRes.json().error).toBe("not_found");

    const lookupRes = await app.inject({
      method: "GET",
      url: "/api/v1/transfers/999",
    });
    expect(lookupRes.statusCode).toBe(404);
    expect(lookupRes.json().error).toBe("not_found");
  });
});
