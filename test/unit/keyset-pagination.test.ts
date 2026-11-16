import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/config.js";
import type { Database } from "../../src/db/pool.js";
import { buildServer } from "../../src/http/server.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

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
} as unknown as Database;

describe("keyset pagination for transfer and claim history", () => {
  const { logger } = capturingLogger();
  const config = loadConfig({ env: completeEnv({ KEEPER_ENABLED: "false" }) });
  const app = buildServer({
    config,
    logger,
    db,
    readiness: [],
  });

  const stellarDeployment = config.deployments.networks["stellar-testnet"];
  if (stellarDeployment?.family !== "stellar" || !stellarDeployment.tokens.USDC) {
    throw new Error("Expected stellar-testnet fixture deployment");
  }
  const senderAddress = stellarDeployment.admin;
  const tokenAddress = stellarDeployment.tokens.USDC.sacId;
  const evmRecipientWord = "0x0000000000000000000000006ef8032ffe4943f27388172549f6700f18bb8b38";

  beforeAll(async () => {
    for (const name of [
      "1790900000000_initial-schema.sql",
      "1791000000000_cursor-block-hash.sql",
      "1791100000000_cursor-autovacuum-tuning.sql",
    ]) {
      const sql = readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8").split(
        "-- Down Migration",
      )[0]!;
      await pg.exec(sql);
    }
    await app.ready();
  }, 30_000);

  beforeEach(async () => {
    await pg.exec(`
      TRUNCATE outbound_transfer, rail_attestation, inbound_delivery, pending_claim RESTART IDENTITY CASCADE;
    `);
  });

  afterAll(async () => {
    await app.close();
    await pg.close();
  });

  async function insertTransfer(nonce: number, route = 0): Promise<void> {
    await pg.query(
      `INSERT INTO outbound_transfer
         (origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount, destination_chain, destination, origin_block, origin_tx)
       VALUES
         ('stellar-testnet', $1, $2, $3, $4, 10000000, 30000, 9970000, 'sepolia', $5, $6, $7)`,
      [
        route,
        nonce,
        senderAddress,
        tokenAddress,
        evmRecipientWord,
        1287400 + nonce,
        `tx-nonce-${String(nonce)}`,
      ],
    );
  }

  it("walks descending transfer history without duplicates or skipped rows when new transfers arrive mid-walk", async () => {
    for (let nonce = 1; nonce <= 6; nonce += 1) {
      await insertTransfer(nonce);
    }

    const page1 = await app.inject("/v1/transfers?originChain=stellar-testnet&limit=2");
    expect(page1.statusCode).toBe(200);
    const body1 = page1.json();
    expect(body1.transfers.map((t: { origin: { nonce: string } }) => t.origin.nonce)).toEqual([
      "6",
      "5",
    ]);
    expect(body1.pageInfo.hasMore).toBe(true);
    expect(body1.pageInfo.sort).toBe("desc");

    // Insert three newer transfers while the client holds page1's cursor.
    await insertTransfer(7);
    await insertTransfer(8);
    await insertTransfer(9);

    const seenNonces: string[] = body1.transfers.map(
      (t: { origin: { nonce: string } }) => t.origin.nonce,
    );
    let cursor: string | null = body1.pageInfo.nextCursor;

    while (cursor !== null) {
      const nextRes = await app.inject(
        `/v1/transfers?originChain=stellar-testnet&limit=2&cursor=${encodeURIComponent(cursor)}`,
      );
      expect(nextRes.statusCode).toBe(200);
      const nextBody = nextRes.json();
      expect(nextBody.pageInfo.mode).toBe("keyset");
      expect(nextBody.offset).toBeNull();
      for (const transfer of nextBody.transfers) {
        seenNonces.push(transfer.origin.nonce);
      }
      cursor = nextBody.pageInfo.nextCursor;
    }

    // Every transfer from the snapshot downward (6..1) appears once, with zero duplicates or skips.
    expect(seenNonces).toEqual(["6", "5", "4", "3", "2", "1"]);
  });

  it("walks ascending transfer history and picks up newly appended transfers without skipping", async () => {
    for (let nonce = 1; nonce <= 4; nonce += 1) {
      await insertTransfer(nonce);
    }

    const page1 = await app.inject("/v1/transfers?originChain=stellar-testnet&sort=asc&limit=2");
    expect(page1.statusCode).toBe(200);
    const body1 = page1.json();
    expect(body1.transfers.map((t: { origin: { nonce: string } }) => t.origin.nonce)).toEqual([
      "1",
      "2",
    ]);

    // Insert additional transfers before continuing the ascending walk.
    await insertTransfer(5);
    await insertTransfer(6);

    const seenNonces: string[] = body1.transfers.map(
      (t: { origin: { nonce: string } }) => t.origin.nonce,
    );
    let cursor: string | null = body1.pageInfo.nextCursor;

    while (cursor !== null) {
      const nextRes = await app.inject(
        `/v1/transfers?originChain=stellar-testnet&sort=asc&limit=2&cursor=${encodeURIComponent(cursor)}`,
      );
      expect(nextRes.statusCode).toBe(200);
      const nextBody = nextRes.json();
      for (const transfer of nextBody.transfers) {
        seenNonces.push(transfer.origin.nonce);
      }
      cursor = nextBody.pageInfo.nextCursor;
    }

    expect(seenNonces).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it("returns bounded 400 validation errors for malformed, oversized, out-of-range, or mismatched cursors", async () => {
    for (let nonce = 1; nonce <= 3; nonce += 1) {
      await insertTransfer(nonce, 0);
    }

    const page1 = await app.inject(
      "/v1/transfers?originChain=stellar-testnet&route=0&sort=desc&limit=1",
    );
    expect(page1.statusCode).toBe(200);
    const validCursor: string = page1.json().pageInfo.nextCursor;

    // 1. Filter mismatch (changing route or omitting originChain)
    const filterMismatch = await app.inject(
      `/v1/transfers?originChain=stellar-testnet&route=1&cursor=${encodeURIComponent(validCursor)}`,
    );
    expect(filterMismatch.statusCode).toBe(400);
    expect(filterMismatch.json()).toMatchObject({
      error: "bad_request",
      code: "cursor_filter_mismatch",
    });

    // 2. Sort mismatch (switching desc cursor to asc)
    const sortMismatch = await app.inject(
      `/v1/transfers?originChain=stellar-testnet&route=0&sort=asc&cursor=${encodeURIComponent(validCursor)}`,
    );
    expect(sortMismatch.statusCode).toBe(400);
    expect(sortMismatch.json()).toMatchObject({
      error: "bad_request",
      code: "cursor_sort_mismatch",
    });

    // 3. Combining cursor and offset
    const conflicting = await app.inject(
      `/v1/transfers?originChain=stellar-testnet&route=0&offset=2&cursor=${encodeURIComponent(validCursor)}`,
    );
    expect(conflicting.statusCode).toBe(400);
    expect(conflicting.json()).toMatchObject({
      error: "bad_request",
      code: "conflicting_pagination",
    });

    // 4. Oversized or arbitrary untrusted cursor is never echoed back in the error body
    const untrustedMarker = `UNTRUSTED_${"A".repeat(700)}`;
    const oversized = await app.inject(`/v1/transfers?cursor=${untrustedMarker}`);
    expect(oversized.statusCode).toBe(400);
    expect(oversized.body).not.toContain("UNTRUSTED_");
    expect(oversized.body.length).toBeLessThan(250);
    expect(oversized.json()).toMatchObject({
      error: "bad_request",
      code: "invalid_cursor",
    });

    // 5. Crafted cursor exceeding PostgreSQL bigint range fails validation before SQL
    const forgedOverflow = Buffer.from(
      JSON.stringify({
        v: 1,
        k: "transfers",
        s: "desc",
        f: "0".repeat(32),
        id: "9999999999999999999",
      }),
      "utf8",
    ).toString("base64url");
    const overflowRes = await app.inject(`/v1/transfers?cursor=${forgedOverflow}`);
    expect(overflowRes.statusCode).toBe(400);
    expect(overflowRes.json()).toMatchObject({
      error: "bad_request",
      code: "invalid_cursor",
    });

    // 6. Invalid sort direction
    const badSort = await app.inject("/v1/transfers?sort=sideways");
    expect(badSort.statusCode).toBe(400);
    expect(badSort.json()).toMatchObject({
      error: "bad_request",
      code: "invalid_sort",
    });
  });

  it("preserves documented offset compatibility and supports keyset pagination on claims", async () => {
    for (let nonce = 1; nonce <= 4; nonce += 1) {
      await insertTransfer(nonce);
    }

    const offsetPage = await app.inject("/v1/transfers?limit=2&offset=1");
    expect(offsetPage.statusCode).toBe(200);
    const offsetBody = offsetPage.json();
    expect(offsetBody.limit).toBe(2);
    expect(offsetBody.offset).toBe(1);
    expect(offsetBody.count).toBe(2);
    expect(offsetBody.transfers.map((t: { origin: { nonce: string } }) => t.origin.nonce)).toEqual([
      "3",
      "2",
    ]);
    expect(offsetBody.transfers[0].origin.grossAmount).toBe("10000000");

    for (const claimId of [10, 20, 30]) {
      await pg.query(
        `INSERT INTO pending_claim (chain, claim_id, recipient, token, amount, route, source_chain, source_nonce, created_at)
         VALUES ('stellar-testnet', $1, $2, $3, 9970000, 0, 'sepolia', $1, now())`,
        [claimId, senderAddress, tokenAddress],
      );
    }

    const claimPage1 = await app.inject("/v1/claims?chain=stellar-testnet&limit=2");
    expect(claimPage1.statusCode).toBe(200);
    const claimBody1 = claimPage1.json();
    expect(claimBody1.claims.map((c: { claimId: string }) => c.claimId)).toEqual(["30", "20"]);
    expect(claimBody1.pageInfo.hasMore).toBe(true);

    const claimPage2 = await app.inject(
      `/v1/claims?chain=stellar-testnet&limit=2&cursor=${encodeURIComponent(claimBody1.pageInfo.nextCursor)}`,
    );
    expect(claimPage2.statusCode).toBe(200);
    const claimBody2 = claimPage2.json();
    expect(claimBody2.claims.map((c: { claimId: string }) => c.claimId)).toEqual(["10"]);
    expect(claimBody2.pageInfo.hasMore).toBe(false);
    expect(claimBody2.pageInfo.nextCursor).toBeNull();
  });
});
