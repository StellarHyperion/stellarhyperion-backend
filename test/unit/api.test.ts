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
  constructor(private readonly queryMap: Record<string, readonly Record<string, unknown>[]>) {}

  query(text: string): Promise<{ rows: readonly Record<string, unknown>[]; rowCount: number }> {
    for (const [key, rows] of Object.entries(this.queryMap)) {
      if (text.includes(key)) {
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
});
