import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/config.js";
import type { Database } from "../../src/db/pool.js";
import {
  API_CONTRACT_VERSION,
  OPENAPI_SPEC_VERSION,
  buildOpenApiDocument,
  validateOpenApiResponse,
  validateValueAgainstSchema,
} from "../../src/http/openapi.js";
import { buildServer } from "../../src/http/server.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ACTIVE_TESTNET_DEPLOYMENTS = join(REPO_ROOT, "deployments", "testnet.json");
const STORED_FIXTURES_PATH = join(REPO_ROOT, "test", "fixtures", "openapi-v1-responses.json");

interface StoredFixtureCase {
  readonly name: string;
  readonly pathTemplate: string;
  readonly method: string;
  readonly statusCode: number;
  readonly body: unknown;
}

describe("Versioned machine-readable OpenAPI contract", () => {
  const activeConfig = loadConfig({
    env: completeEnv({
      KEEPER_ENABLED: "false",
      HYPERION_DEPLOYMENTS_FILE: ACTIVE_TESTNET_DEPLOYMENTS,
    }),
  });
  const contract = buildOpenApiDocument(activeConfig);

  it("specifies all monetary amounts and wide 64-bit identifiers as decimal strings", () => {
    expect(contract.openapi).toBe(OPENAPI_SPEC_VERSION);
    expect(contract.info["x-contract-version"]).toBe(API_CONTRACT_VERSION);
    expect(contract.info.description).toContain("stellar-testnet");

    const uint256Schema = contract.components.schemas.DecimalUint256String;
    const uint64Schema = contract.components.schemas.DecimalUint64String;
    if (uint256Schema === undefined || uint64Schema === undefined) {
      throw new Error("Expected decimal string schemas in OpenAPI components");
    }
    expect(uint256Schema).toMatchObject({ type: "string", pattern: "^[0-9]+$" });
    expect(uint64Schema).toMatchObject({ type: "string", pattern: "^[0-9]+$" });

    // Numeric JSON floats/ints are rejected where decimal strings are required.
    const numericAmountFailure = validateValueAgainstSchema(
      contract,
      uint256Schema,
      10000000,
      "$.grossAmount",
    );
    expect(numericAmountFailure.length).toBeGreaterThan(0);

    const fractionalStringFailure = validateValueAgainstSchema(
      contract,
      uint256Schema,
      "10.50",
      "$.grossAmount",
    );
    expect(fractionalStringFailure.length).toBeGreaterThan(0);

    // Full uint256 max and u64 max decimal strings validate cleanly.
    expect(
      validateValueAgainstSchema(
        contract,
        uint256Schema,
        "115792089237316195423570985008687907853269984665640564039457584007913129639935",
      ),
    ).toEqual([]);
    expect(validateValueAgainstSchema(contract, uint64Schema, "18446744073709551615")).toEqual([]);
  });

  it("validates stored runtime response fixtures including unknown metadata and error envelopes", () => {
    const fixtures = JSON.parse(
      readFileSync(STORED_FIXTURES_PATH, "utf8"),
    ) as readonly StoredFixtureCase[];
    expect(fixtures.length).toBeGreaterThanOrEqual(6);

    for (const fixture of fixtures) {
      const errors = validateOpenApiResponse(
        contract,
        fixture.pathTemplate,
        fixture.method,
        fixture.statusCode,
        fixture.body,
      );
      expect(errors, `fixture '${fixture.name}' failed OpenAPI validation`).toEqual([]);
    }

    // Verify every operation explicitly documents 400, 429, and 500 error responses.
    for (const [pathKey, methods] of Object.entries(contract.paths)) {
      for (const [methodKey, operation] of Object.entries(methods)) {
        expect(
          operation.responses["400"],
          `${methodKey.toUpperCase()} ${pathKey} missing 400 spec`,
        ).toBeDefined();
        expect(
          operation.responses["429"],
          `${methodKey.toUpperCase()} ${pathKey} missing 429 spec`,
        ).toBeDefined();
        expect(
          operation.responses["500"],
          `${methodKey.toUpperCase()} ${pathKey} missing 500 spec`,
        ).toBeDefined();
      }
    }
  });

  it("serves /v1/openapi.json and /api/v1/openapi.json with contract version headers and validates 503 readiness", async () => {
    const { logger } = capturingLogger();
    const failingDb = {
      query: () => Promise.resolve({ rows: [], rowCount: 0 }),
      ping: () => Promise.reject(new Error("database offline")),
    };

    const app = buildServer({
      config: activeConfig,
      logger,
      db: failingDb as unknown as Database,
      readiness: [],
    });

    const v1Spec = await app.inject("/v1/openapi.json");
    expect(v1Spec.statusCode).toBe(200);
    expect(v1Spec.headers["x-api-contract-version"]).toBe(API_CONTRACT_VERSION);

    const aliasSpec = await app.inject("/api/v1/openapi.json");
    expect(aliasSpec.statusCode).toBe(200);
    expect(aliasSpec.json()).toEqual(v1Spec.json());

    const readyDown = await app.inject("/ready");
    expect(readyDown.statusCode).toBe(503);
    expect(validateOpenApiResponse(contract, "/ready", "GET", 503, readyDown.json())).toEqual([]);

    await app.close();
  });
});
