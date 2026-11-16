import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { AddressKind, RouteKind, encodeStellarAddress } from "@hyperion/protocol";
import { Keypair } from "@stellar/stellar-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { writeAttestation } from "../../src/chains/writers.js";
import { loadConfig } from "../../src/config/config.js";
import type { Database, Queryable, QueryResultRows } from "../../src/db/pool.js";
import {
  generateDiagnosticsBundle,
  runDiagnosticsCommand,
  sanitizeDiagnosticText,
  sanitizePublicEndpointUrl,
} from "../../src/diagnostics/bundle.js";
import { buildServer } from "../../src/http/server.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const ACTIVE_TESTNET_DEPLOYMENT = fileURLToPath(
  new URL("../../deployments/testnet.json", import.meta.url),
);

function migrationPath(name: string): string {
  return fileURLToPath(new URL(`../../migrations/${name}`, import.meta.url));
}

describe("operational diagnostics bundle command", () => {
  const pg = new PGlite();
  let txLock: Promise<void> = Promise.resolve();

  function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = txLock.then(fn, fn);
    txLock = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  const rawQuery = async (sql: string, params?: readonly unknown[]): Promise<QueryResultRows> => {
    const result = await pg.query(sql, [...(params ?? [])]);
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
  };

  const pgliteDb = {
    query: (sql: string, params?: readonly unknown[]) => runExclusive(() => rawQuery(sql, params)),
    ping: () =>
      runExclusive(async () => {
        await pg.query("SELECT 1");
      }),
    transaction: <T>(work: (tx: Queryable) => Promise<T>): Promise<T> =>
      runExclusive(async () => {
        await pg.exec("BEGIN");
        try {
          const val = await work({ query: rawQuery });
          await pg.exec("COMMIT");
          return val;
        } catch (error) {
          await pg.exec("ROLLBACK").catch(() => undefined);
          throw error;
        }
      }),
    close: () => Promise.resolve(),
  } as unknown as Database;

  beforeAll(async () => {
    for (const name of [
      "1790900000000_initial-schema.sql",
      "1791000000000_cursor-block-hash.sql",
      "1791100000000_cursor-autovacuum-tuning.sql",
    ]) {
      const sql = readFileSync(migrationPath(name), "utf8").split("-- Down Migration")[0]!;
      await pg.exec(sql);
    }
  }, 30_000);

  afterAll(async () => {
    await pg.close();
  });

  it("excludes connection strings, authorization headers, RPC path keys, and signer values while reporting revision and time", async () => {
    const dynamicSecret = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(41)).secret();
    const dbCredUrl = "postgres://hyperion_admin:db_super_secret_99@db.example.internal:5432/prod";
    const redisCredUrl = "rediss://default:redis_secret_token_88@redis.example.internal:6379/0";
    const rpcApiKeySegment = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
    const rpcWithCreds = `https://rpcuser:rpcpass@soroban-testnet.stellar.org/${rpcApiKeySegment}?api_key=leak_me`;
    const bearerToken = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secretpayload";

    const config = loadConfig({
      env: completeEnv({
        HYPERION_DEPLOYMENTS_FILE: ACTIVE_TESTNET_DEPLOYMENT,
        DATABASE_URL: dbCredUrl,
        REDIS_URL: redisCredUrl,
        KEEPER_STELLAR_SECRET: dynamicSecret,
        STELLAR_RPC_URL: rpcWithCreds,
      }),
    });

    const sender = encodeStellarAddress(AddressKind.Account, new Uint8Array(32).fill(11));
    const token = encodeStellarAddress(AddressKind.Contract, new Uint8Array(32).fill(12));
    const fixedNow = new Date("2026-11-16T04:00:00.000Z");

    await pgliteDb.query(
      `INSERT INTO indexer_cursor (chain_key, family, contract, last_processed, updated_at)
       VALUES ('stellar-testnet', 'stellar', $1, 5433900, '2026-11-16T03:59:30.000Z')`,
      [config.indexer.stellar!.routerContractId],
    );
    const outRes = await pgliteDb.query(
      `INSERT INTO outbound_transfer (
         origin_chain, route, nonce, sender, token,
         gross_amount, fee, net_amount, destination_chain, destination,
         origin_block, origin_tx, observed_at
       ) VALUES (
         'stellar-testnet', $1, 201, $2, $3,
         10000000, 30000, 9970000, 'sepolia',
         '0x0000000000000000000000006ef8032ffe4943f27388172549f6700f18bb8b38',
         5433850, $4, '2026-11-16T03:58:00.000Z'
       ) RETURNING id`,
      [RouteKind.Cctp, sender, token, "b".repeat(64)],
    );
    const transferId = BigInt(String(outRes.rows[0]?.id));
    // Provider attested, but no inbound_delivery row yet -> must remain unverified in proofBacklog!
    await writeAttestation(pgliteDb, {
      transferId,
      route: RouteKind.Cctp,
      status: "attested",
      railStatus: "complete",
      railReference: "iris-201",
      attestedAt: new Date("2026-11-16T03:58:45.000Z"),
      checkedAt: new Date("2026-11-16T03:59:00.000Z"),
      checkFailures: 0,
      lastError: null,
    });

    const { logger } = capturingLogger();
    const app = buildServer({ config, logger, db: pgliteDb, readiness: [] });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/v1/diagnostics",
        headers: {
          authorization: bearerToken,
          "x-api-key": "super_secret_header_key",
          cookie: "session_id=secret_cookie_123",
          "x-request-id": "diag-req-113",
        },
      });
      expect(res.statusCode).toBe(200);
      const rawPayload = res.payload;

      // Strictly zero credentials, connection strings, authorization headers, or signer keys.
      expect(rawPayload).not.toContain(dynamicSecret);
      expect(rawPayload).not.toContain("db_super_secret_99");
      expect(rawPayload).not.toContain("redis_secret_token_88");
      expect(rawPayload).not.toContain(dbCredUrl);
      expect(rawPayload).not.toContain(redisCredUrl);
      expect(rawPayload).not.toContain("rpcpass");
      expect(rawPayload).not.toContain(rpcApiKeySegment);
      expect(rawPayload).not.toContain("leak_me");
      expect(rawPayload).not.toContain("secretpayload");
      expect(rawPayload).not.toContain("super_secret_header_key");
      expect(rawPayload).not.toContain("secret_cookie_123");

      const body = res.json();
      expect(body.bundleVersion).toBe(1);
      expect(typeof body.observedAt).toBe("string");
      expect(body.revision).toMatchObject({
        network: "testnet",
        deploymentSchemaVersion: 1,
        deploymentGeneratedAt: "2026-10-29T10:17:56.262Z",
        hasEvmRouter: false,
      });
      expect(body.revision.deployedRouters).toEqual([
        expect.objectContaining({
          chain: "stellar-testnet",
          family: "stellar",
          commit: "b91c6ca",
        }),
      ]);
      expect(body.probes.configuration.data.keeper.signerMode).toBe("configured");
      expect(body.probes.configuration.data.sanitizedRequestHeaders).toEqual(
        expect.objectContaining({ "x-request-id": "diag-req-113" }),
      );
      expect(body.probes.configuration.data.sanitizedRequestHeaders.authorization).toBeUndefined();

      // Provider status "attested" alone never counts as verified delivery.
      expect(body.probes.proofBacklog.data).toMatchObject({
        totalOutboundTransfers: 1,
        verifiedInboundDeliveries: 0,
        unverifiedOutboundCount: 1,
        attestedAwaitingDestinationProof: 1,
      });
    } finally {
      await app.close();
    }

    // Verify CLI entrypoint produces reproducible observedAt & revision output.
    let cliOutput = "";
    const cliResult = await runDiagnosticsCommand({
      env: completeEnv({
        HYPERION_DEPLOYMENTS_FILE: ACTIVE_TESTNET_DEPLOYMENT,
        KEEPER_ENABLED: "false",
      }),
      openDb: () => pgliteDb,
      now: () => fixedNow,
      writeStdout: (text) => {
        cliOutput += text;
      },
    });
    expect(cliResult.exitCode).toBe(0);
    const parsedCli = JSON.parse(cliOutput) as { observedAt: string; overallStatus: string };
    expect(parsedCli.observedAt).toBe("2026-11-16T04:00:00.000Z");
    expect(parsedCli.overallStatus).toBe("degraded");
  });

  it("retains actionable normalized probe results when database or readiness probes fail without leaking secrets", async () => {
    const failingConnUrl = "postgres://admin:leaked_pw_404@127.0.0.1:5439/broken_db";
    const config = loadConfig({
      env: completeEnv({
        HYPERION_DEPLOYMENTS_FILE: ACTIVE_TESTNET_DEPLOYMENT,
        DATABASE_URL: failingConnUrl,
        KEEPER_ENABLED: "false",
      }),
    });

    const failingDb: Queryable = {
      query: () => {
        const err = Object.assign(
          new Error(`connect ECONNREFUSED ${failingConnUrl} Authorization: Bearer secret123`),
          { code: "ECONNREFUSED" },
        );
        return Promise.reject(err);
      },
    };

    const fixedNow = new Date("2026-11-16T04:15:00.000Z");
    const bundle = await generateDiagnosticsBundle({
      config,
      db: failingDb,
      now: () => fixedNow,
    });

    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain("leaked_pw_404");
    expect(serialized).not.toContain("secret123");

    expect(bundle.observedAt).toBe("2026-11-16T04:15:00.000Z");
    expect(bundle.overallStatus).toBe("failed");
    // Configuration probe still succeeds while failed DB probes return normalized category + remediation.
    expect(bundle.probes.configuration.status).toBe("ok");
    expect(bundle.probes.schema.status).toBe("failed");
    expect(bundle.probes.schema.failure).toMatchObject({
      category: "database_unreachable",
      code: "ECONNREFUSED",
    });
    expect(bundle.probes.schema.failure?.remediation.length).toBeGreaterThan(10);
    expect(bundle.probes.workerFreshness.status).toBe("failed");
    expect(bundle.probes.proofBacklog.status).toBe("failed");

    expect(
      sanitizePublicEndpointUrl("https://api.example.com/v2/abcdef0123456789abcdef?token=1"),
    ).toBe("https://api.example.com/v2/[redacted]");
    expect(sanitizeDiagnosticText("error on redis://:topsecret@cache:6379/0")).toContain(
      "[redacted-connection-string]",
    );
  });
});
