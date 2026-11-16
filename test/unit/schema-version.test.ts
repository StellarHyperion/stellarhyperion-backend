import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/config.js";
import type { Database } from "../../src/db/pool.js";
import {
  DEFAULT_API_SCHEMA_VERSION,
  LATEST_API_SCHEMA_VERSION,
  SUPPORTED_API_SCHEMA_VERSIONS,
} from "../../src/http/schema-version.js";
import { buildServer } from "../../src/http/server.js";
import { completeEnv, readFixture } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ACTIVE_TESTNET_DEPLOYMENTS = join(REPO_ROOT, "deployments", "testnet.json");

interface StoredFixtureSet {
  readonly transferDetail: Record<string, unknown>;
  readonly transferList: Record<string, unknown>;
  readonly claimDetail: Record<string, unknown>;
  readonly claimList: Record<string, unknown>;
  readonly routeHealth: Record<string, unknown>;
}

const v1Fixtures = JSON.parse(readFixture("api-schema-v1-responses.json")) as StoredFixtureSet;
const v2Fixtures = JSON.parse(readFixture("api-schema-v2-responses.json")) as StoredFixtureSet;

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

  await pg.exec(`
    INSERT INTO outbound_transfer (
      origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
      destination_chain, destination, origin_block, origin_tx, observed_at
    ) VALUES (
      'stellar-testnet',
      0,
      42,
      'GDXRQQETEZHGRJTE3U7DYGIWGGYGMM6EAS5NWGPGN2WXFXZYZ6QZIANA',
      'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      10000000,
      30000,
      9970000,
      'sepolia',
      '0x0000000000000000000000006ef8032ffe4943f27388172549f6700f18bb8b38',
      5433900,
      'd2d112fdef5b381534eb10e92806bd0025f307ffb0b2da0d0d3194d3f7892ca2',
      '2026-10-29T10:00:00.000Z'::timestamptz
    );

    INSERT INTO rail_attestation (
      transfer_id, route, status, rail_status, rail_reference, attested_at
    ) VALUES (
      1, 0, 'delivered', 'complete', 'iris-msg-42', '2026-10-29T10:01:00.000Z'::timestamptz
    );

    INSERT INTO inbound_delivery (
      destination_chain, route, source_chain, source_nonce, recipient, token,
      amount, delivered, destination_block, destination_tx, observed_at
    ) VALUES (
      'sepolia',
      0,
      'stellar-testnet',
      42,
      '0x6ef8032ffe4943f27388172549f6700f18bb8b38',
      '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      997000,
      true,
      9413000,
      '0xb8a185a1e723443ab0b787225006fe56db80009fe796c69e8c4f6b8bf31db555',
      '2026-10-29T10:02:00.000Z'::timestamptz
    );

    INSERT INTO pending_claim (
      chain, claim_id, recipient, token, amount, route, source_chain, source_nonce,
      created_at, settled, observed_at
    ) VALUES (
      'stellar-testnet',
      7,
      'GDXRQQETEZHGRJTE3U7DYGIWGGYGMM6EAS5NWGPGN2WXFXZYZ6QZIANA',
      'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      9970000,
      1,
      'sepolia',
      20,
      '2026-10-29T10:03:00.000Z'::timestamptz,
      false,
      '2026-10-29T10:03:05.000Z'::timestamptz
    );

    INSERT INTO route_health (
      origin_chain, destination_chain, route, token, available, blocker, flow_available, sampled_at
    ) VALUES (
      'stellar-testnet',
      'sepolia',
      0,
      'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      true,
      0,
      90000000,
      '2026-10-29T10:04:00.000Z'::timestamptz
    );
  `);

  await app.ready();
}, 30_000);

afterAll(async () => {
  await app.close();
  await pg.close();
});

describe("Public API schema-version negotiation", () => {
  it("preserves exact stored v1 response fixtures for legacy callers", async () => {
    const transferDetail = await app.inject({ method: "GET", url: "/v1/transfers/1" });
    expect(transferDetail.statusCode).toBe(200);
    expect(transferDetail.headers["x-hyperion-schema-version"]).toBe(DEFAULT_API_SCHEMA_VERSION);
    expect(transferDetail.headers["x-hyperion-supported-versions"]).toBe(
      SUPPORTED_API_SCHEMA_VERSIONS.join(", "),
    );
    expect(transferDetail.json()).toEqual(v1Fixtures.transferDetail);

    const transferList = await app.inject({
      method: "GET",
      url: "/v1/transfers",
      headers: { accept: "application/json" },
    });
    expect(transferList.statusCode).toBe(200);
    expect(transferList.json()).toEqual(v1Fixtures.transferList);

    const claimDetail = await app.inject({
      method: "GET",
      url: "/v1/claims/stellar-testnet/7",
    });
    expect(claimDetail.statusCode).toBe(200);
    expect(claimDetail.json()).toEqual(v1Fixtures.claimDetail);

    const claimList = await app.inject({ method: "GET", url: "/v1/claims" });
    expect(claimList.statusCode).toBe(200);
    expect(claimList.json()).toEqual(v1Fixtures.claimList);

    const routeHealth = await app.inject({ method: "GET", url: "/v1/routes/health" });
    expect(routeHealth.statusCode).toBe(200);
    expect(routeHealth.json()).toEqual(v1Fixtures.routeHealth);
  });

  it("negotiates stored v2 metadata fixtures without altering monetary or token identity fields", async () => {
    const byHeader = await app.inject({
      method: "GET",
      url: "/v1/transfers/1",
      headers: { "x-hyperion-schema-version": LATEST_API_SCHEMA_VERSION },
    });
    expect(byHeader.statusCode).toBe(200);
    expect(byHeader.headers["x-hyperion-schema-version"]).toBe(LATEST_API_SCHEMA_VERSION);
    expect(byHeader.json()).toEqual(v2Fixtures.transferDetail);

    const byVendorAccept = await app.inject({
      method: "GET",
      url: "/v1/transfers",
      headers: { accept: "application/vnd.hyperion.v2+json" },
    });
    expect(byVendorAccept.statusCode).toBe(200);
    expect(byVendorAccept.headers["x-hyperion-schema-version"]).toBe(LATEST_API_SCHEMA_VERSION);
    expect(byVendorAccept.json()).toEqual(v2Fixtures.transferList);

    const claimDetail = await app.inject({
      method: "GET",
      url: "/v1/claims/stellar-testnet/7",
      headers: { accept: "application/json; version=2026-11-01" },
    });
    expect(claimDetail.statusCode).toBe(200);
    expect(claimDetail.json()).toEqual(v2Fixtures.claimDetail);

    const claimList = await app.inject({
      method: "GET",
      url: "/v1/claims",
      headers: { "x-hyperion-schema-version": "v2" },
    });
    expect(claimList.statusCode).toBe(200);
    expect(claimList.json()).toEqual(v2Fixtures.claimList);

    const routeHealth = await app.inject({
      method: "GET",
      url: "/v1/routes/health",
      headers: { "x-hyperion-schema-version": "2026-11-01" },
    });
    expect(routeHealth.statusCode).toBe(200);
    expect(routeHealth.json()).toEqual(v2Fixtures.routeHealth);

    // Monetary and token identity fields remain identical across versions.
    const v1Transfer = v1Fixtures.transferDetail as {
      origin: Record<string, unknown>;
      destination: Record<string, unknown>;
    };
    const v2Transfer = byHeader.json<{
      origin: Record<string, unknown>;
      destination: Record<string, unknown>;
    }>();
    expect(v2Transfer.origin).toEqual(v1Transfer.origin);
    expect(v2Transfer.destination).toEqual(v1Transfer.destination);
  });

  it("never marks provider-only attestation as verified delivery in v2 metadata and supports SSE negotiation", async () => {
    await pg.exec(`
      INSERT INTO outbound_transfer (
        origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
        destination_chain, destination, origin_block, origin_tx, observed_at
      ) VALUES (
        'sepolia',
        0,
        99,
        '0x6ef8032ffe4943f27388172549f6700f18bb8b38',
        '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        5000000,
        15000,
        4985000,
        'stellar-testnet',
        'GDXRQQETEZHGRJTE3U7DYGIWGGYGMM6EAS5NWGPGN2WXFXZYZ6QZIANA',
        9414000,
        '0x4c1ba9bd0f28d77e6a3b1c05e8942fd0b7613a5ce84f29d0a71b3e6c5d08947f',
        '2026-10-29T10:05:00.000Z'::timestamptz
      );

      INSERT INTO rail_attestation (
        transfer_id, route, status, rail_status, rail_reference, attested_at
      ) VALUES (
        2, 0, 'attested', 'complete', 'iris-msg-99', '2026-10-29T10:05:30.000Z'::timestamptz
      );
    `);

    const unverifiedV2 = await app.inject({
      method: "GET",
      url: "/v1/transfers/2",
      headers: { "x-hyperion-schema-version": "2026-11-01" },
    });
    expect(unverifiedV2.statusCode).toBe(200);
    const body = unverifiedV2.json<{
      stage: string;
      destination: { delivered: boolean };
      meta: {
        deliveryFinalized: boolean;
        deliveryVerification: string;
        sourceRouterIndexed: boolean;
      };
    }>();
    expect(body.stage).toBe("delivering");
    expect(body.destination.delivered).toBe(false);
    expect(body.meta).toEqual({
      schemaVersion: "2026-11-01",
      deliveryFinalized: false,
      deliveryVerification: "unverified",
      sourceRouterIndexed: false,
    });

    const sseRes = await app.inject({
      method: "GET",
      url: "/v1/transfers/1/stream",
      headers: { "x-hyperion-schema-version": "2026-11-01" },
    });
    expect(sseRes.statusCode).toBe(200);
    expect(sseRes.headers["x-hyperion-schema-version"]).toBe("2026-11-01");
    expect(sseRes.payload).toContain('"schemaVersion":"2026-11-01"');
    expect(sseRes.payload).toContain('"deliveryVerification":"inbound_delivery"');
  });

  it("returns actionable 406 responses for unsupported, conflicting, or malformed versions", async () => {
    const unsupportedHeader = await app.inject({
      method: "GET",
      url: "/v1/transfers",
      headers: { "x-hyperion-schema-version": "2099-01-01" },
    });
    expect(unsupportedHeader.statusCode).toBe(406);
    const unsupportedBody = unsupportedHeader.json<{
      error: string;
      message: string;
      requestedVersion: string;
      supportedVersions: string[];
      supportedAliases: string[];
    }>();
    expect(unsupportedBody.error).toBe("unsupported_schema_version");
    expect(unsupportedBody.requestedVersion).toBe("2099-01-01");
    expect(unsupportedBody.supportedVersions).toEqual(["2026-10-01", "2026-11-01"]);
    expect(unsupportedBody.supportedAliases).toEqual(["v1", "v2"]);
    expect(unsupportedBody.message).toContain("2026-10-01, 2026-11-01");

    const unsupportedAccept = await app.inject({
      method: "GET",
      url: "/v1/claims",
      headers: { accept: "application/vnd.hyperion.v99+json" },
    });
    expect(unsupportedAccept.statusCode).toBe(406);
    expect(unsupportedAccept.json<{ requestedVersion: string }>().requestedVersion).toBe("v99");

    const conflicting = await app.inject({
      method: "GET",
      url: "/v1/routes/health",
      headers: {
        "x-hyperion-schema-version": "2026-10-01",
        accept: "application/vnd.hyperion.v2+json",
      },
    });
    expect(conflicting.statusCode).toBe(406);
    expect(conflicting.json<{ message: string }>().message).toContain("conflicting");

    const malformed = await app.inject({
      method: "GET",
      url: "/v1/transfers/1",
      headers: { accept: "application/json; version=" },
    });
    expect(malformed.statusCode).toBe(406);
    expect(malformed.json<{ message: string }>().message).toContain("malformed");
  });
});
