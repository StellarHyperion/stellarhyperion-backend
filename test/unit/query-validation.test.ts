import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { AddressKind, encodeStellarAddress } from "@hyperion/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/config.js";
import type { Database } from "../../src/db/pool.js";
import { buildServer } from "../../src/http/server.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ACTIVE_TESTNET_DEPLOYMENTS = join(REPO_ROOT, "deployments", "testnet.json");

const STELLAR_SENDER = "GDXRQQETEZHGRJTE3U7DYGIWGGYGMM6EAS5NWGPGN2WXFXZYZ6QZIANA";
const ACTIVE_USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const OTHER_CONTRACT_TOKEN = "CD5IB466XCQIUDYWV22PUMJTF6EE3KPXBDGLLBSKAPNE6QPXVUZLXJGA";
const MUXED_STELLAR_ADDRESS = encodeStellarAddress(
  AddressKind.MuxedAccount,
  `0x${"11".repeat(32)}`,
  42n,
);

const pg = new PGlite();
let sqlCallCount = 0;

const db = {
  query: async (sql: string, params: readonly unknown[] = []) => {
    sqlCallCount += 1;
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
      destination_chain, destination, origin_block, origin_tx
    ) VALUES
      (
        'stellar-testnet',
        0,
        10,
        '${STELLAR_SENDER}',
        '${ACTIVE_USDC_SAC}',
        10000000,
        30000,
        9970000,
        'sepolia',
        '0x0000000000000000000000006ef8032ffe4943f27388172549f6700f18bb8b38',
        5434000,
        'd2d112fdef5b381534eb10e92806bd0025f307ffb0b2da0d0d3194d3f7892ca2'
      ),
      (
        'stellar-testnet',
        1,
        11,
        '${STELLAR_SENDER}',
        '${OTHER_CONTRACT_TOKEN}',
        5000000,
        15000,
        4985000,
        'base-sepolia',
        '0x0000000000000000000000003c44cdddb6a900fa2b585dd299e03d12fa4293bc',
        5434001,
        'literal_100%_tx_marker'
      );

    INSERT INTO pending_claim (
      chain, claim_id, recipient, token, amount, route, source_chain, source_nonce, created_at
    ) VALUES (
      'stellar-testnet',
      7,
      '${STELLAR_SENDER}',
      '${ACTIVE_USDC_SAC}',
      9970000,
      0,
      'sepolia',
      55,
      now()
    );

    INSERT INTO route_health (
      origin_chain, destination_chain, route, token, available, blocker, flow_available
    ) VALUES (
      'stellar-testnet',
      'sepolia',
      0,
      '${ACTIVE_USDC_SAC}',
      true,
      0,
      90000000
    );
  `);

  await app.ready();
  sqlCallCount = 0;
}, 30_000);

afterAll(async () => {
  await app.close();
  await pg.close();
});

describe("Filter composition validation for public queries", () => {
  it("rejects conflicting or malformed filter combinations before executing any SQL", async () => {
    sqlCallCount = 0;

    const invalidRequests = [
      "/v1/transfers?originChain=ethereum",
      "/v1/transfers?originChain=unknown-chain",
      "/v1/transfers?originChain=stellar-testnet&destinationChain=stellar-testnet",
      "/v1/transfers?originChain=sepolia&destinationChain=base-sepolia",
      `/v1/transfers?originChain=sepolia&sender=${STELLAR_SENDER}`,
      "/v1/transfers?originChain=stellar-testnet&sender=0x6ef8032ffe4943f27388172549f6700f18bb8b38",
      `/v1/transfers?destinationChain=sepolia&recipient=${STELLAR_SENDER}`,
      `/v1/transfers?sender=${STELLAR_SENDER}&recipient=${STELLAR_SENDER}`,
      `/v1/transfers?sender=${MUXED_STELLAR_ADDRESS}`,
      `/v1/transfers?recipient=${MUXED_STELLAR_ADDRESS}&route=allbridge`,
      "/v1/transfers?recipient=0x1100000000000000000000006ef8032ffe4943f27388172549f6700f18bb8b38",
      "/v1/transfers?sender=GINVALIDCRC16ADDRESS",
      "/v1/transfers?originChain=stellar-testnet&token=EURC",
      "/v1/transfers?originChain=stellar-testnet&token=USDC&route=allbridge",
      "/v1/transfers?originChain=stellar-testnet&token=0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      "/v1/transfers?route=99",
      "/v1/transfers?limit=0",
      "/v1/transfers?limit=101",
      "/v1/transfers?offset=-1",
      "/v1/transfers/stellar-testnet/not-a-nonce",
      "/v1/transfers/not-an-id",
      "/v1/claims?chain=sepolia&recipient=" + STELLAR_SENDER,
      "/v1/claims?settled=maybe",
      "/v1/claims/ethereum/7",
      "/v1/routes/health?originChain=sepolia&destinationChain=arc-testnet",
    ];

    for (const url of invalidRequests) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, `expected 400 for ${url}`).toBe(400);
      expect(res.json<{ error: string }>().error).toBe("invalid_query");
    }

    expect(sqlCallCount).toBe(0);
  });

  it("selects the active deployment and canonical asset/recipient identities for valid combined filters", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/transfers?originChain=stellar-testnet&destinationChain=sepolia&route=cctp&token=USDC&sender=${STELLAR_SENDER}&recipient=0x6Ef8032fFe4943F27388172549f6700f18bB8b38&limit=5&offset=0`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      transfers: { id: string; origin: { token: string; netAmount: string } }[];
      count: number;
    }>();
    expect(body.count).toBe(1);
    expect(body.transfers[0]?.origin.token).toBe(ACTIVE_USDC_SAC);
    expect(body.transfers[0]?.origin.netAmount).toBe("9970000");

    // EVM source query on active deployment (which has no Hyperion EVM router) returns empty 200.
    const unindexedEvm = await app.inject({
      method: "GET",
      url: `/v1/transfers?originChain=sepolia&destinationChain=stellar-testnet&token=USDC&recipient=${STELLAR_SENDER}`,
    });
    expect(unindexedEvm.statusCode).toBe(200);
    expect(unindexedEvm.json<{ count: number }>().count).toBe(0);

    // Filtered claims and route health select canonical SAC identity.
    const claims = await app.inject({
      method: "GET",
      url: `/v1/claims?chain=stellar-testnet&token=USDC&recipient=${STELLAR_SENDER}&settled=false`,
    });
    expect(claims.statusCode).toBe(200);
    expect(claims.json<{ count: number }>().count).toBe(1);

    const routeHealth = await app.inject({
      method: "GET",
      url: "/v1/routes/health?originChain=stellar-testnet&destinationChain=sepolia&route=0&token=USDC",
    });
    expect(routeHealth.statusCode).toBe(200);
    expect(routeHealth.json<{ count: number }>().count).toBe(1);
  });

  it("prevents search input from altering SQL structure or injecting LIKE wildcards", async () => {
    const sqlAttempt = await app.inject({
      method: "GET",
      url: `/v1/transfers?search=${encodeURIComponent("') OR 1=1; DROP TABLE outbound_transfer; --")}`,
    });
    expect(sqlAttempt.statusCode).toBe(200);
    expect(sqlAttempt.json<{ count: number }>().count).toBe(0);

    // Bare `%` or `_` must not act as wildcards matching every row.
    const percentOnly = await app.inject({
      method: "GET",
      url: `/v1/transfers?search=${encodeURIComponent("%")}`,
    });
    expect(percentOnly.statusCode).toBe(200);
    // Matches ONLY row 2 whose tx hash literally contains '%', not row 1!
    const percentMatches = percentOnly.json<{
      transfers: { origin: { txHash: string } }[];
    }>();
    expect(percentMatches.transfers).toHaveLength(1);
    expect(percentMatches.transfers[0]?.origin.txHash).toBe("literal_100%_tx_marker");

    const multiUnderscore = await app.inject({
      method: "GET",
      url: `/v1/transfers?search=${encodeURIComponent("________")}`,
    });
    expect(multiUnderscore.statusCode).toBe(200);
    expect(multiUnderscore.json<{ count: number }>().count).toBe(0);
  });
});
