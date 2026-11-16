import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { AddressKind, RAIL_CONTRACTS, RouteKind, encodeStellarAddress } from "@hyperion/protocol";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/config.js";
import type { Database } from "../../src/db/pool.js";
import { bigintOf } from "../../src/db/rows.js";
import { buildServer } from "../../src/http/server.js";
import {
  MAX_EVIDENCE_TEXT_LENGTH,
  type AxelarDeliveryEvidence,
} from "../../src/rails/axelar/delivery.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");

const MIGRATION_FILES = [
  "1790900000000_initial-schema.sql",
  "1791000000000_cursor-block-hash.sql",
  "1791100000000_cursor-autovacuum-tuning.sql",
];

const STELLAR_SENDER = encodeStellarAddress(AddressKind.Account, new Uint8Array(32).fill(0x19));
const STELLAR_TOKEN = encodeStellarAddress(AddressKind.Contract, new Uint8Array(32).fill(0x27));
const EVM_RECIPIENT = "0x6ef8032ffe4943f27388172549f6700f18bb8b38";
const EVM_DEST_WORD = `0x000000000000000000000000${EVM_RECIPIENT.slice(2)}`;
const EVM_ITS_TOKEN = "0x9999999999999999999999999999999999999999";

function buildDynamicSecretSeed(): string {
  return `S${"B".repeat(55)}`;
}

describe("Axelar delivery evidence read API", () => {
  let pg: PGlite;
  let app: FastifyInstance;

  beforeAll(async () => {
    pg = new PGlite();
    for (const name of MIGRATION_FILES) {
      const raw = readFileSync(path.join(MIGRATIONS_DIR, name), "utf8");
      const upSql = raw.split("-- Down Migration")[0] ?? raw;
      await pg.exec(upSql);
    }

    const dbAdapter = {
      query: async (sql: string, params: readonly unknown[] = []) => {
        const result = await pg.query<Record<string, unknown>>(sql, [...params]);
        const int8Cols = result.fields
          .filter((field) => field.dataTypeID === 20)
          .map((field) => field.name);
        const rows = result.rows.map((raw) => {
          const copy: Record<string, unknown> = { ...raw };
          for (const col of int8Cols) {
            const val = copy[col];
            if (typeof val === "number" || typeof val === "bigint") {
              copy[col] = String(val);
            }
          }
          return copy;
        });
        return { rows, rowCount: result.affectedRows ?? result.rows.length };
      },
      ping: async () => {
        await pg.query("SELECT 1");
      },
    };

    const { logger } = capturingLogger();
    const config = loadConfig({ env: completeEnv({ KEEPER_ENABLED: "false" }) });
    app = buildServer({
      config,
      logger,
      db: dbAdapter as unknown as Database,
      readiness: [],
      redis: { ping: () => Promise.resolve("PONG") },
    });
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await pg.close();
  });

  beforeEach(async () => {
    await pg.exec(
      "TRUNCATE rail_attestation, inbound_delivery, pending_claim, outbound_transfer RESTART IDENTITY CASCADE",
    );
  });

  it("identifies the exact matching ERC-20 payment, ITS command, and canonical receipt when delivery is confirmed", async () => {
    const commandId = `0x${"ab".repeat(32)}`;
    const originTx = `0x${"11".repeat(32)}`;
    const destTx = `0x${"cd".repeat(32)}`;
    const providerRef = `${originTx}-2`;
    // Large uint256-scale exact integer amount beyond IEEE-754 safe integer precision.
    const grossAmount = "123456789012345678901234567890";
    const fee = "123456789012345678901234567";
    const netAmount = "123333332223333333222333333323";

    const insertRes = await pg.query<Record<string, unknown>>(
      `INSERT INTO outbound_transfer
         (origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
          destination_chain, destination, rail_ref, origin_block, origin_tx, observed_at)
       VALUES
         ('stellar-testnet', $1, 101, $2, $3, $4, $5, $6,
          'sepolia', $7, $8, 88001, $9, '2026-10-12T08:00:00Z')
       RETURNING id`,
      [
        RouteKind.AxelarIts,
        STELLAR_SENDER,
        STELLAR_TOKEN,
        grossAmount,
        fee,
        netAmount,
        EVM_DEST_WORD,
        providerRef,
        originTx,
      ],
    );
    const firstRow = insertRes.rows[0];
    if (!firstRow) throw new Error("Expected inserted transfer row");
    const transferId = bigintOf(firstRow, "id").toString();

    await pg.query(
      `INSERT INTO rail_attestation
         (transfer_id, route, status, rail_status, rail_reference, attested_at, last_checked_at)
       VALUES ($1, $2, 'delivered', 'executed/received', $3, '2026-10-12T08:01:00Z', '2026-10-12T08:02:00Z')`,
      [transferId, RouteKind.AxelarIts, providerRef],
    );

    await pg.query(
      `INSERT INTO inbound_delivery
         (destination_chain, route, source_chain, source_nonce, rail_message_id,
          recipient, token, amount, delivered, claim_id,
          destination_block, destination_tx, destination_log_index, observed_at)
       VALUES
         ('sepolia', $1, 'stellar-testnet', 101, $2,
          $3, $4, $5, true, NULL,
          7123456, $6, 7, '2026-10-12T08:01:30Z')`,
      [RouteKind.AxelarIts, commandId, EVM_RECIPIENT, EVM_ITS_TOKEN, netAmount, destTx],
    );

    const byId = await app.inject(`/v1/transfers/${transferId}/evidence/axelar`);
    expect(byId.statusCode).toBe(200);
    const evidence = byId.json<AxelarDeliveryEvidence>();

    expect(evidence.verdict).toBe("confirmed_delivery");
    expect(evidence.origin.netAmount).toBe(netAmount);
    expect(evidence.origin.grossAmount).toBe(grossAmount);
    expect(evidence.origin.txHash).toBe(originTx);

    expect(evidence.command).toEqual({
      verified: true,
      itsContract: RAIL_CONTRACTS.sepolia?.axelar?.interchainTokenService ?? null,
      commandId,
    });

    expect(evidence.receipt).toEqual({
      confirmed: true,
      destinationChain: "sepolia",
      block: "7123456",
      txHash: destTx,
      observedAt: "2026-10-12T08:01:30.000Z",
    });

    expect(evidence.tokenPayment).toEqual({
      verified: true,
      exactMatch: true,
      token: EVM_ITS_TOKEN,
      symbol: null,
      decimals: null,
      expectedRecipient: EVM_RECIPIENT,
      recipient: EVM_RECIPIENT,
      expectedAmount: netAmount,
      amount: netAmount,
      txHash: destTx,
      logIndex: 7,
    });

    expect(evidence.provider.sufficientForDelivery).toBe(false);
    expect(evidence.provider.assessment).toBe("corroborated_by_chain_payment");
    expect(evidence.checklist).toMatchObject({
      sourceTransferIndexed: true,
      providerCandidateObserved: true,
      providerStatusAloneSufficient: false,
      itsCommandVerified: true,
      canonicalReceiptConfirmed: true,
      tokenMappingVerified: true,
      erc20PaymentExactMatch: true,
      payoutEstablished: true,
    });
    expect(evidence.checklist.steps).toHaveLength(6);

    // Also accessible by hop (:originChain/:nonce/evidence/axelar) and /api/v1 alias.
    const byHop = await app.inject("/v1/transfers/stellar-testnet/101/evidence/axelar");
    expect(byHop.statusCode).toBe(200);
    expect(byHop.json<AxelarDeliveryEvidence>()).toEqual(evidence);

    const apiAlias = await app.inject(`/api/v1/transfers/${transferId}/evidence`);
    expect(apiAlias.statusCode).toBe(200);
    expect(apiAlias.json<AxelarDeliveryEvidence>()).toEqual(evidence);
  });

  it("displays provider executed status alone as insufficient when destination ERC-20 payment is unconfirmed", async () => {
    const originTx = `0x${"22".repeat(32)}`;
    const providerRef = `${originTx}-0`;

    const insertRes = await pg.query<Record<string, unknown>>(
      `INSERT INTO outbound_transfer
         (origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
          destination_chain, destination, rail_ref, origin_block, origin_tx, observed_at)
       VALUES
         ('stellar-testnet', $1, 202, $2, $3, 10005000, 5000, 10000000,
          'sepolia', $4, $5, 88050, $6, '2026-10-12T09:00:00Z')
       RETURNING id`,
      [RouteKind.AxelarIts, STELLAR_SENDER, STELLAR_TOKEN, EVM_DEST_WORD, providerRef, originTx],
    );
    const row = insertRes.rows[0];
    if (!row) throw new Error("Expected inserted row");
    const transferId = bigintOf(row, "id").toString();

    await pg.query(
      `INSERT INTO rail_attestation
         (transfer_id, route, status, rail_status, rail_reference, attested_at, last_checked_at)
       VALUES ($1, $2, 'attested', 'executed/received', $3, '2026-10-12T09:01:00Z', '2026-10-12T09:01:10Z')`,
      [transferId, RouteKind.AxelarIts, providerRef],
    );

    const res = await app.inject(`/v1/transfers/${transferId}/evidence/axelar`);
    expect(res.statusCode).toBe(200);
    const body = res.json<AxelarDeliveryEvidence>();

    expect(body.verdict).toBe("insufficient_provider_only");
    expect(body.provider.providerReportsExecuted).toBe(true);
    expect(body.provider.sufficientForDelivery).toBe(false);
    expect(body.provider.assessment).toBe("insufficient_without_chain_payment");
    expect(body.command.verified).toBe(false);
    expect(body.command.commandId).toBeNull();
    expect(body.receipt.confirmed).toBe(false);
    expect(body.tokenPayment.verified).toBe(false);
    expect(body.tokenPayment.exactMatch).toBe(false);
    expect(body.checklist.providerCandidateObserved).toBe(true);
    expect(body.checklist.providerStatusAloneSufficient).toBe(false);
    expect(body.checklist.payoutEstablished).toBe(false);

    const providerStep = body.checklist.steps.find(
      (s) => s.step === "provider_candidate_discovery",
    );
    expect(providerStep?.passed).toBe(true);
    expect(providerStep?.sufficientAlone).toBe(false);
    expect(providerStep?.summary).toContain("insufficient");
  });

  it("rejects mismatched destination token payment amounts and keeps output bounded and credential-free", async () => {
    const originTx = `0x${"33".repeat(32)}`;
    const destTx = `0x${"44".repeat(32)}`;
    const commandId = `0x${"55".repeat(32)}`;
    const secretSeed = buildDynamicSecretSeed();
    const leakedError = [
      "RPC failure on https://operator:topsecretpass@sepolia.internal.example/v2?api_key=axl_live_987654",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secretpayload",
      `signer=${secretSeed} private_key=deadbeef012345`,
      "pad:".concat("Z".repeat(2048)),
    ].join(" | ");

    const insertRes = await pg.query<Record<string, unknown>>(
      `INSERT INTO outbound_transfer
         (origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
          destination_chain, destination, origin_block, origin_tx, observed_at)
       VALUES
         ('stellar-testnet', $1, 303, $2, $3, 5005000, 5000, 5000000,
          'sepolia', $4, 88100, $5, '2026-10-12T10:00:00Z')
       RETURNING id`,
      [RouteKind.AxelarIts, STELLAR_SENDER, STELLAR_TOKEN, EVM_DEST_WORD, originTx],
    );
    const row = insertRes.rows[0];
    if (!row) throw new Error("Expected inserted row");
    const transferId = bigintOf(row, "id").toString();

    await pg.query(
      `INSERT INTO rail_attestation
         (transfer_id, route, status, rail_status, rail_reference, last_error)
       VALUES ($1, $2, 'attested', 'executed?token=querysecret999', 'axl-ref?api_key=refsecret', $3)`,
      [transferId, RouteKind.AxelarIts, leakedError],
    );

    // Seed an inbound_delivery with a 1-unit short payment so exactMatch must fail.
    await pg.query(
      `INSERT INTO inbound_delivery
         (destination_chain, route, source_chain, source_nonce, rail_message_id,
          recipient, token, amount, delivered, claim_id,
          destination_block, destination_tx, destination_log_index, observed_at)
       VALUES
         ('sepolia', $1, 'stellar-testnet', 303, $2,
          $3, $4, 4999999, true, NULL,
          7200000, $5, 2, '2026-10-12T10:02:00Z')`,
      [RouteKind.AxelarIts, commandId, EVM_RECIPIENT, EVM_ITS_TOKEN, destTx],
    );

    const res = await app.inject(`/v1/transfers/${transferId}/evidence/axelar`);
    expect(res.statusCode).toBe(200);
    const rawPayload = res.body;
    const body = res.json<AxelarDeliveryEvidence>();

    expect(body.verdict).toBe("unverified_candidate");
    expect(body.tokenPayment.verified).toBe(false);
    expect(body.tokenPayment.exactMatch).toBe(false);
    expect(body.checklist.erc20PaymentExactMatch).toBe(false);
    expect(body.checklist.payoutEstablished).toBe(false);

    // Credential-free and bounded checks
    expect(rawPayload).not.toContain("topsecretpass");
    expect(rawPayload).not.toContain("axl_live_987654");
    expect(rawPayload).not.toContain("secretpayload");
    expect(rawPayload).not.toContain("querysecret999");
    expect(rawPayload).not.toContain("refsecret");
    expect(rawPayload).not.toContain("deadbeef012345");
    expect(rawPayload).not.toContain(secretSeed);
    expect(body.provider.lastError).not.toBeNull();
    expect(body.provider.lastError?.length).toBeLessThanOrEqual(
      MAX_EVIDENCE_TEXT_LENGTH + "...[truncated]".length,
    );
    expect(Buffer.byteLength(rawPayload, "utf8")).toBeLessThan(4096);
  });

  it("returns 404 for unknown transfers and 400 for malformed parameters or non-Axelar routes", async () => {
    const missing = await app.inject("/v1/transfers/99999/evidence/axelar");
    expect(missing.statusCode).toBe(404);

    const badId = await app.inject("/v1/transfers/not-an-integer/evidence/axelar");
    expect(badId.statusCode).toBe(400);

    // Seed a CCTP transfer (route 0) and confirm /evidence/axelar rejects non-Axelar routes cleanly.
    const cctpInsert = await pg.query<Record<string, unknown>>(
      `INSERT INTO outbound_transfer
         (origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
          destination_chain, destination, origin_block, origin_tx)
       VALUES
         ('stellar-testnet', $1, 404, $2, $3, 1000, 10, 990, 'sepolia', $4, 90000, '0xcctp')
       RETURNING id`,
      [RouteKind.Cctp, STELLAR_SENDER, STELLAR_TOKEN, EVM_DEST_WORD],
    );
    const cctpRow = cctpInsert.rows[0];
    if (!cctpRow) throw new Error("Expected CCTP row");
    const cctpId = bigintOf(cctpRow, "id").toString();

    const wrongRoute = await app.inject(`/v1/transfers/${cctpId}/evidence/axelar`);
    expect(wrongRoute.statusCode).toBe(400);
    expect(wrongRoute.json<{ error: string }>().error).toBe("unsupported_route");
  });
});
