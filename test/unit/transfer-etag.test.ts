import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  settleClaim,
  writeAttestation,
  writeClaim,
  writeInbound,
  writeOutbound,
} from "../../src/chains/writers.js";
import { loadConfig } from "../../src/config/config.js";
import type { Database } from "../../src/db/pool.js";
import {
  PENDING_DETAIL_CACHE_CONTROL,
  STABLE_FINALIZED_CACHE_CONTROL,
  UNCACHEABLE_LIST_CACHE_CONTROL,
} from "../../src/http/etag.js";
import type { FormattedTransfer } from "../../src/http/routes/transfers.js";
import { buildServer } from "../../src/http/server.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ACTIVE_TESTNET_DEPLOYMENTS = join(REPO_ROOT, "deployments", "testnet.json");

describe("Conditional GET and canonical ETags for transfer details", () => {
  const config = loadConfig({
    env: completeEnv({
      KEEPER_ENABLED: "false",
      HYPERION_DEPLOYMENTS_FILE: ACTIVE_TESTNET_DEPLOYMENTS,
    }),
  });
  const { logger } = capturingLogger();

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

  const app = buildServer({
    config,
    logger,
    db: db as unknown as Database,
    readiness: [],
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

  it("invalidates ETags across every lifecycle and proof transition and never caches pending records as complete", async () => {
    await writeOutbound(
      db,
      {
        chainKey: "stellar-testnet",
        block: 5437000n,
        txHash: "etag-origin-tx-201",
        logIndex: null,
        observedAt: new Date("2026-11-06T10:00:00Z"),
      },
      {
        route: 0,
        nonce: 201n,
        sender: "GDXRQQETEZHGRJTE3U7DYGIWGGYGMM6EAS5NWGPGN2WXFXZYZ6QZIANA",
        token: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        grossAmount: 10000000n,
        fee: 30000n,
        netAmount: 9970000n,
        destinationChain: "sepolia",
        destination: "0x0000000000000000000000006ef8032ffe4943f27388172549f6700f18bb8b38",
        railRef: "cctp-init-201",
      },
    );

    const seenETags = new Set<string>();

    // Stage 1: initiated (pending)
    const initRes = await app.inject("/v1/transfers/stellar-testnet/201");
    expect(initRes.statusCode).toBe(200);
    const initTransfer = initRes.json<FormattedTransfer>();
    const etagInitiated = String(initRes.headers.etag);
    expect(etagInitiated).toMatch(/^"hyp-tx-v1-[A-Za-z0-9_-]+"$/);
    expect(initRes.headers["cache-control"]).toBe(PENDING_DETAIL_CACHE_CONTROL);
    seenETags.add(etagInitiated);

    // Filter-independent detail routes emit the exact same ETag and honor 304 across endpoints.
    for (const detailUrl of [
      "/v1/transfers/stellar-testnet/201",
      "/v1/transfers/by-tx/etag-origin-tx-201",
      `/v1/transfers/${initTransfer.id}`,
      `/api/v1/transfers/${initTransfer.id}`,
    ]) {
      const reval = await app.inject({
        method: "GET",
        url: detailUrl,
        headers: { "if-none-match": etagInitiated },
      });
      expect(reval.statusCode, `expected 304 on ${detailUrl}`).toBe(304);
      expect(reval.payload).toBe("");
      expect(reval.headers.etag).toBe(etagInitiated);
      expect(reval.headers["cache-control"]).toBe(PENDING_DETAIL_CACHE_CONTROL);
    }

    // Stage 2: provider reports attested/complete, WITHOUT canonical destination receipt.
    // Must invalidate ETag AND still emit pending Cache-Control (provider status never makes it complete).
    await writeAttestation(db, {
      transferId: BigInt(initTransfer.id),
      route: 0,
      status: "attested",
      railStatus: "complete",
      railReference: "0xcandidatehash201",
      attestedAt: new Date("2026-11-06T10:01:00Z"),
      checkedAt: new Date("2026-11-06T10:01:00Z"),
      checkFailures: 0,
      lastError: null,
    });

    const staleAfterAttest = await app.inject({
      method: "GET",
      url: `/v1/transfers/${initTransfer.id}`,
      headers: { "if-none-match": etagInitiated },
    });
    expect(staleAfterAttest.statusCode).toBe(200);
    expect(staleAfterAttest.headers["cache-control"]).toBe(PENDING_DETAIL_CACHE_CONTROL);
    const etagAttested = String(staleAfterAttest.headers.etag);
    expect(seenETags.has(etagAttested)).toBe(false);
    seenETags.add(etagAttested);

    // Stage 3: canonical destination receipt lands -> ETag changes AND Cache-Control transitions to finalized.
    await writeInbound(
      db,
      {
        chainKey: "sepolia",
        block: 7500100n,
        txHash: "0xdesttx201a",
        logIndex: 4,
        observedAt: new Date("2026-11-06T10:03:00Z"),
      },
      {
        route: 0,
        sourceChain: "stellar-testnet",
        sourceNonce: 201n,
        railMessageId: "0xmsgid201a",
        recipient: "0x6ef8032ffe4943f27388172549f6700f18bb8b38",
        token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
        amount: 997000n,
        delivered: true,
        claimId: null,
      },
    );

    const deliveredRes = await app.inject({
      method: "GET",
      url: `/v1/transfers/${initTransfer.id}`,
      headers: { "if-none-match": etagAttested },
    });
    expect(deliveredRes.statusCode).toBe(200);
    expect(deliveredRes.headers["cache-control"]).toBe(STABLE_FINALIZED_CACHE_CONTROL);
    const etagDelivered = String(deliveredRes.headers.etag);
    expect(seenETags.has(etagDelivered)).toBe(false);
    seenETags.add(etagDelivered);

    // Stage 4: canonical proof update (e.g. reorg updates logIndex or railMessageId) invalidates ETag too.
    await writeInbound(
      db,
      {
        chainKey: "sepolia",
        block: 7500101n,
        txHash: "0xdesttx201b",
        logIndex: 9,
        observedAt: new Date("2026-11-06T10:03:00Z"),
      },
      {
        route: 0,
        sourceChain: "stellar-testnet",
        sourceNonce: 201n,
        railMessageId: "0xmsgid201b",
        recipient: "0x6ef8032ffe4943f27388172549f6700f18bb8b38",
        token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
        amount: 997000n,
        delivered: true,
        claimId: null,
      },
    );

    const reorgUpdatedRes = await app.inject({
      method: "GET",
      url: `/v1/transfers/${initTransfer.id}`,
      headers: { "if-none-match": etagDelivered },
    });
    expect(reorgUpdatedRes.statusCode).toBe(200);
    const etagReorged = String(reorgUpdatedRes.headers.etag);
    expect(seenETags.has(etagReorged)).toBe(false);
    seenETags.add(etagReorged);

    // Weak tag, comma-separated tag list, and wildcard '*' all return 304 when matching.
    const weakMatch = await app.inject({
      method: "GET",
      url: `/v1/transfers/${initTransfer.id}`,
      headers: { "if-none-match": `"unrelated-tag", W/${etagReorged}` },
    });
    expect(weakMatch.statusCode).toBe(304);

    const starMatch = await app.inject({
      method: "GET",
      url: `/v1/transfers/${initTransfer.id}`,
      headers: { "if-none-match": "*" },
    });
    expect(starMatch.statusCode).toBe(304);

    // Missing resource still returns 404 even when If-None-Match: * is supplied.
    const missingWithStar = await app.inject({
      method: "GET",
      url: "/v1/transfers/999999",
      headers: { "if-none-match": "*" },
    });
    expect(missingWithStar.statusCode).toBe(404);
  });

  it("keeps parked claims uncached as pending until settled on-chain and marks list routes no-store", async () => {
    await writeOutbound(
      db,
      {
        chainKey: "sepolia",
        block: 9600100n,
        txHash: "0xparkedorigin202",
        logIndex: 1,
        observedAt: new Date("2026-11-06T11:00:00Z"),
      },
      {
        route: 1,
        nonce: 202n,
        sender: "0x6ef8032ffe4943f27388172549f6700f18bb8b38",
        token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
        grossAmount: 3000000n,
        fee: 9000n,
        netAmount: 2991000n,
        destinationChain: "stellar-testnet",
        destination: "GDXRQQETEZHGRJTE3U7DYGIWGGYGMM6EAS5NWGPGN2WXFXZYZ6QZIANA",
        railRef: null,
      },
    );

    await writeClaim(
      db,
      {
        chainKey: "stellar-testnet",
        block: 5437200n,
        txHash: "park-claim-tx-202",
        logIndex: null,
        observedAt: new Date("2026-11-06T11:01:00Z"),
      },
      {
        claimId: 22n,
        recipient: "GDXRQQETEZHGRJTE3U7DYGIWGGYGMM6EAS5NWGPGN2WXFXZYZ6QZIANA",
        token: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        amount: 2991000n,
        route: 1,
        sourceChain: "sepolia",
        sourceNonce: 202n,
        createdAt: new Date("2026-11-06T11:01:00Z"),
      },
    );

    // Parked transfer & unsettled claim both use pending Cache-Control.
    const parkedTransferRes = await app.inject("/v1/transfers/sepolia/202");
    expect(parkedTransferRes.statusCode).toBe(200);
    expect(parkedTransferRes.headers["cache-control"]).toBe(PENDING_DETAIL_CACHE_CONTROL);
    const parkedEtag = String(parkedTransferRes.headers.etag);

    const parkedClaimRes = await app.inject("/v1/claims/stellar-testnet/22");
    expect(parkedClaimRes.statusCode).toBe(200);
    expect(parkedClaimRes.headers["cache-control"]).toBe(PENDING_DETAIL_CACHE_CONTROL);
    const parkedClaimEtag = String(parkedClaimRes.headers.etag);

    // Settling the claim invalidates both the transfer ETag and the claim ETag and transitions Cache-Control.
    await settleClaim(
      db,
      {
        chainKey: "stellar-testnet",
        block: 5437250n,
        txHash: "settle-claim-tx-202",
        logIndex: null,
        observedAt: new Date("2026-11-06T11:05:00Z"),
      },
      22n,
      "GDXRQQETEZHGRJTE3U7DYGIWGGYGMM6EAS5NWGPGN2WXFXZYZ6QZIANA",
    );

    const settledTransferRes = await app.inject({
      method: "GET",
      url: "/v1/transfers/sepolia/202",
      headers: { "if-none-match": parkedEtag },
    });
    expect(settledTransferRes.statusCode).toBe(200);
    expect(settledTransferRes.headers.etag).not.toBe(parkedEtag);
    expect(settledTransferRes.headers["cache-control"]).toBe(STABLE_FINALIZED_CACHE_CONTROL);

    const settledClaimRes = await app.inject({
      method: "GET",
      url: "/v1/claims/stellar-testnet/22",
      headers: { "if-none-match": parkedClaimEtag },
    });
    expect(settledClaimRes.statusCode).toBe(200);
    expect(settledClaimRes.headers.etag).not.toBe(parkedClaimEtag);
    expect(settledClaimRes.headers["cache-control"]).toBe(STABLE_FINALIZED_CACHE_CONTROL);

    const listRes = await app.inject("/v1/transfers");
    expect(listRes.headers["cache-control"]).toBe(UNCACHEABLE_LIST_CACHE_CONTROL);
  });
});
