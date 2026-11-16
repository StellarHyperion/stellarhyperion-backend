import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/config.js";
import type { Database } from "../../src/db/pool.js";
import {
  ERROR_COMPATIBILITY_TRANSITION,
  PUBLIC_ERROR_SPECS,
  type PublicApiErrorEnvelope,
  sanitizePublicErrorText,
} from "../../src/http/errors.js";
import { buildServer } from "../../src/http/server.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("Consistent public API error envelopes", () => {
  const baseConfig = loadConfig({ env: completeEnv({ KEEPER_ENABLED: "false" }) });
  const { logger } = capturingLogger();

  const pg = new PGlite();
  let injectedDbError: Error | null = null;

  const db = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      if (injectedDbError !== null) {
        throw injectedDbError;
      }
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
      if (injectedDbError !== null) {
        throw injectedDbError;
      }
      await pg.query("SELECT 1");
    },
  };

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
  }, 30_000);

  afterAll(async () => {
    await pg.close();
  });

  it("keeps empty history as 200 empty arrays across transfers, claims, and routes", async () => {
    injectedDbError = null;
    const app = buildServer({
      config: baseConfig,
      logger,
      db: db as unknown as Database,
      readiness: [],
    });

    const transfersRes = await app.inject("/v1/transfers");
    expect(transfersRes.statusCode).toBe(200);
    expect(transfersRes.json()).toEqual({
      transfers: [],
      limit: 20,
      offset: 0,
      count: 0,
    });

    const claimsRes = await app.inject("/v1/claims");
    expect(claimsRes.statusCode).toBe(200);
    expect(claimsRes.json()).toEqual({
      claims: [],
      limit: 20,
      offset: 0,
      count: 0,
    });

    const routesRes = await app.inject("/v1/routes/health");
    expect(routesRes.statusCode).toBe(200);
    expect(routesRes.json()).toEqual({
      routes: [],
      count: 0,
    });

    await app.close();
  });

  it("normalizes validation, not-found, timeout, unavailable, rate-limited, and internal errors", async () => {
    const app = buildServer({
      config: baseConfig,
      logger,
      db: db as unknown as Database,
      readiness: [],
    });

    // 1. Validation errors (400) before SQL execution
    const badTransferId = await app.inject({
      method: "GET",
      url: "/v1/transfers/not-an-int",
      headers: { "x-request-id": "req-val-1" },
    });
    expect(badTransferId.statusCode).toBe(400);
    expect(badTransferId.json<PublicApiErrorEnvelope>()).toEqual({
      error: "bad_request",
      code: "validation_error",
      status: 400,
      message: "invalid id: expected an unsigned integer",
      retryable: false,
      requestId: "req-val-1",
      details: [{ field: "id", reason: "must be a base-10 unsigned integer string" }],
    });

    const badClaimsSettled = await app.inject("/v1/claims?settled=maybe&limit=500");
    expect(badClaimsSettled.statusCode).toBe(400);
    expect(badClaimsSettled.json<PublicApiErrorEnvelope>().code).toBe("validation_error");

    const badRouteChain = await app.inject("/v1/routes/health?originChain=unknown-net");
    expect(badRouteChain.statusCode).toBe(400);
    expect(badRouteChain.json<PublicApiErrorEnvelope>().code).toBe("validation_error");

    // 2. Resource not-found & unknown route not-found (404)
    const missingClaim = await app.inject({
      method: "GET",
      url: "/v1/claims/stellar-testnet/99",
      headers: { "x-request-id": "req-nf-1" },
    });
    expect(missingClaim.statusCode).toBe(404);
    expect(missingClaim.json<PublicApiErrorEnvelope>()).toEqual({
      error: "not_found",
      code: "not_found",
      status: 404,
      message: "no claim found on chain stellar-testnet with id 99",
      retryable: false,
      requestId: "req-nf-1",
    });

    const unknownRoute = await app.inject("/v1/unknown-endpoint?secret=ignored");
    expect(unknownRoute.statusCode).toBe(404);
    const unknownBody = unknownRoute.json<PublicApiErrorEnvelope>();
    expect(unknownBody.code).toBe("not_found");
    expect(unknownBody.error).toBe("not_found");
    expect(unknownBody.message).toBe("no route for GET /v1/unknown-endpoint");
    expect(unknownBody.message).not.toContain("secret");

    // 3. Timeout error (504)
    const pgTimeout = Object.assign(
      new Error("canceling statement due to statement timeout in SELECT * FROM outbound_transfer"),
      { code: "57014" },
    );
    injectedDbError = pgTimeout;
    const timeoutRes = await app.inject("/v1/transfers");
    expect(timeoutRes.statusCode).toBe(504);
    expect(timeoutRes.headers["retry-after"]).toBe("1");
    expect(timeoutRes.json<PublicApiErrorEnvelope>()).toMatchObject({
      error: "request_timeout",
      code: "request_timeout",
      status: 504,
      message: "the request exceeded the server time budget",
      retryable: true,
    });

    // 4. Service unavailable error (503)
    const syntheticConnUri = [
      "post",
      "gres://hyperion:",
      "super-secret-value",
      "@10.0.0.5:5432/db",
    ].join("");
    const pgUnavailable = Object.assign(new Error(`connection refused for ${syntheticConnUri}`), {
      code: "ECONNREFUSED",
    });
    injectedDbError = pgUnavailable;
    const unavailableRes = await app.inject("/v1/claims");
    expect(unavailableRes.statusCode).toBe(503);
    expect(unavailableRes.headers["retry-after"]).toBe("1");
    const unavailableBody = unavailableRes.json<PublicApiErrorEnvelope>();
    expect(unavailableBody).toMatchObject({
      error: "service_unavailable",
      code: "service_unavailable",
      status: 503,
      message: "indexed storage is temporarily unavailable",
      retryable: true,
    });
    expect(JSON.stringify(unavailableBody)).not.toContain("super-secret-value");
    expect(JSON.stringify(unavailableBody)).not.toContain("10.0.0.5");

    // 5. Internal error (500) scrubbing SQL text and schema identifiers
    injectedDbError = Object.assign(
      new Error(
        `syntax error at or near "FROM" in SELECT * FROM outbound_transfer WHERE sender = $1 (${syntheticConnUri})`,
      ),
      { code: "42601" },
    );
    const internalRes = await app.inject("/v1/routes/health");
    expect(internalRes.statusCode).toBe(500);
    const internalBody = internalRes.json<PublicApiErrorEnvelope>();
    expect(internalBody).toMatchObject({
      error: "internal_error",
      code: "internal_error",
      status: 500,
      message: "the server could not complete that request",
      retryable: false,
    });
    expect(JSON.stringify(internalBody)).not.toContain("SELECT");
    expect(JSON.stringify(internalBody)).not.toContain("outbound_transfer");
    expect(JSON.stringify(internalBody)).not.toContain("super-secret-value");

    // Also verify /ready scrubs credentials if db.ping() throws a URI-bearing error.
    const readyRes = await app.inject("/ready");
    expect(readyRes.statusCode).toBe(503);
    expect(readyRes.payload).not.toContain("super-secret-value");
    expect(readyRes.payload).not.toContain("outbound_transfer");

    injectedDbError = null;
    await app.close();
  });

  it("scrubs SQL fragments, connection URIs, seeds, and paths in direct sanitizer and 429 rate limits", async () => {
    const connUri = ["red", "is://default:", "topsecret", "@cache.internal:6379/0"].join("");
    const seedCandidate = `S${"A".repeat(55)}`;
    const scrubbed = sanitizePublicErrorText(
      `failed connecting to ${connUri} with signer ${seedCandidate} at /srv/hyperion/config.json`,
    );
    expect(scrubbed).not.toContain("topsecret");
    expect(scrubbed).not.toContain(seedCandidate);
    expect(scrubbed).not.toContain("/srv/hyperion");

    const sqlScrubbed = sanitizePublicErrorText(
      'relation "pending_claim" does not exist in SELECT * FROM pending_claim',
      "safe fallback",
    );
    expect(sqlScrubbed).toBe("safe fallback");

    // Verify documented compatibility transition covers every public error spec.
    for (const spec of Object.values(PUBLIC_ERROR_SPECS)) {
      expect(ERROR_COMPATIBILITY_TRANSITION[spec.legacyError]).toBe(spec.code);
    }

    const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
    expect(readme).toContain("validation_error");
    expect(readme).toContain("service_unavailable");
    expect(readme).toContain("request_timeout");

    // Verify 429 rate-limit envelope when nodeEnv is production.
    const prodConfig = { ...baseConfig, nodeEnv: "production" as const };
    const prodApp = buildServer({
      config: prodConfig,
      logger,
      db: db as unknown as Database,
      readiness: [],
    });

    let lastStatus = 200;
    let rateLimitedEnvelope: PublicApiErrorEnvelope | null = null;
    for (let i = 0; i < 125; i += 1) {
      const res = await prodApp.inject({
        method: "GET",
        url: "/v1/routes/health",
        remoteAddress: "203.0.113.44",
      });
      lastStatus = res.statusCode;
      if (res.statusCode === 429) {
        rateLimitedEnvelope = res.json<PublicApiErrorEnvelope>();
        break;
      }
    }
    expect(lastStatus).toBe(429);
    expect(rateLimitedEnvelope).toMatchObject({
      error: "too_many_requests",
      code: "rate_limited",
      status: 429,
      retryable: true,
    });

    await prodApp.close();
  });
});
