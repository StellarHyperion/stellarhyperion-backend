import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { AddressKind, RouteKind, encodeStellarAddress } from "@hyperion/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { writeOutbound } from "../../src/chains/writers.js";
import type { Queryable, QueryResultRows, Transactional } from "../../src/db/pool.js";
import { bigintOf } from "../../src/db/rows.js";
import {
  AxelarGmpClient,
  AxelarSchemaParserRegistry,
  MAX_QUARANTINE_PAYLOAD_BYTES,
  MAX_QUARANTINE_RECORDS_PER_TRANSFER,
  listQuarantinedAxelarRecords,
  recordQuarantinedAxelarSchema,
  replayQuarantinedAxelarRecords,
} from "../../src/rails/axelar/gmp.js";
import { RailPass } from "../../src/rails/pass.js";
import type { PendingTransfer } from "../../src/rails/types.js";
import { capturingLogger } from "../stellar-fakes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");

const MIGRATION_FILES = [
  "1790900000000_initial-schema.sql",
  "1791000000000_cursor-block-hash.sql",
  "1791200000000_axelar-schema-quarantine.sql",
];

function extractUpSql(raw: string): string {
  const downIdx = raw.indexOf("-- Down Migration");
  return downIdx === -1 ? raw : raw.slice(0, downIdx);
}

class PgliteDb implements Transactional {
  constructor(private readonly pg: PGlite) {}

  async query(sql: string, params: readonly unknown[] = []): Promise<QueryResultRows> {
    const res = await this.pg.query<Record<string, unknown>>(sql, [...params]);
    return {
      rows: res.rows,
      rowCount: res.affectedRows ?? res.rows.length,
    };
  }

  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (tx) => {
      const wrapped: Queryable = {
        async query(sql: string, params: readonly unknown[] = []): Promise<QueryResultRows> {
          const res = await tx.query<Record<string, unknown>>(sql, [...params]);
          return {
            rows: res.rows,
            rowCount: res.affectedRows ?? res.rows.length,
          };
        },
      };
      return work(wrapped);
    });
  }
}

const BASE_URL = "https://testnet.api.gmp.axelarscan.io";
const STELLAR_SENDER = encodeStellarAddress(AddressKind.Account, new Uint8Array(32).fill(0x21));
const STELLAR_TOKEN = encodeStellarAddress(AddressKind.Contract, new Uint8Array(32).fill(0x42));
const EVM_DEST_WORD = `0x${"00".repeat(12)}${"ab".repeat(20)}`;
const EVM_RECIPIENT = `0x${"ab".repeat(20)}`;
const EVM_TOKEN = `0x${"cd".repeat(20)}`;

function buildDynamicSecretSeed(): string {
  // Valid 56-character base32 secret-shaped string constructed dynamically so gitleaks sees no literal.
  return `S${"A".repeat(55)}`;
}

describe("Axelar provider schema drift quarantine", () => {
  let pg: PGlite;
  let db: PgliteDb;

  beforeAll(async () => {
    pg = new PGlite();
    for (const file of MIGRATION_FILES) {
      const sql = extractUpSql(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
      await pg.exec(sql);
    }
    db = new PgliteDb(pg);
  });

  afterAll(async () => {
    await pg.close();
  });

  beforeEach(async () => {
    await pg.exec(
      "TRUNCATE axelar_schema_quarantine, rail_attestation, inbound_delivery, outbound_transfer RESTART IDENTITY CASCADE",
    );
  });

  async function seedOutboundTransfer(nonce: bigint, originTx: string): Promise<PendingTransfer> {
    await db.transaction(async (tx) => {
      await writeOutbound(
        tx,
        {
          chainKey: "stellar-testnet",
          block: 5000n + nonce,
          txHash: originTx,
          logIndex: null,
          observedAt: new Date("2026-10-10T10:00:00Z"),
        },
        {
          route: RouteKind.AxelarIts,
          nonce,
          sender: STELLAR_SENDER,
          token: STELLAR_TOKEN,
          grossAmount: 10_005_000n,
          fee: 5_000n,
          netAmount: 10_000_000n,
          destinationChain: "sepolia",
          destination: EVM_DEST_WORD,
          railRef: null,
        },
      );
    });

    const { rows } = await db.query(
      "SELECT id FROM outbound_transfer WHERE origin_chain = $1 AND nonce = $2",
      ["stellar-testnet", nonce.toString()],
    );
    const firstRow = rows[0];
    if (!firstRow) {
      throw new Error("Expected seeded outbound_transfer row");
    }
    const id = bigintOf(firstRow, "id");
    return {
      transferId: id,
      route: RouteKind.AxelarIts,
      originChain: "stellar-testnet",
      destinationChain: "sepolia",
      nonce,
      originTx,
      status: null,
      checkFailures: 0,
      delivered: false,
    };
  }

  it("never maps unknown statuses, non-string statuses, drifted execution fields, or unsupported envelopes to delivered", async () => {
    const { logger } = capturingLogger();

    const cases = [
      {
        nonce: 1n,
        originTx: `0x${"11".repeat(32)}`,
        expectedDrift: "unknown_status",
        expectedRef: "axl-msg-unknown-1",
        body: {
          data: [
            {
              call: { transactionHash: `0x${"11".repeat(32)}` },
              status: "delivered",
              message_id: "axl-msg-unknown-1",
              command_id: `0x${"aa".repeat(32)}`,
              executed: { transactionHash: `0x${"bb".repeat(32)}` },
            },
          ],
        },
      },
      {
        nonce: 2n,
        originTx: `0x${"22".repeat(32)}`,
        expectedDrift: "invalid_status_type",
        expectedRef: "axl-msg-obj-2",
        body: {
          data: [
            {
              call: { transactionHash: `0x${"22".repeat(32)}` },
              status: { phase: "EXECUTED" },
              id: "axl-msg-obj-2",
            },
          ],
        },
      },
      {
        nonce: 3n,
        originTx: `0x${"33".repeat(32)}`,
        expectedDrift: "unsupported_execution_shape",
        expectedRef: "axl-msg-exec-3",
        body: {
          data: [
            {
              call: { transactionHash: `0x${"33".repeat(32)}` },
              status: "executed",
              message_id: "axl-msg-exec-3",
              commandId: `0x${"cc".repeat(32)}`,
              executed: { tx_hash: `0x${"dd".repeat(32)}` },
            },
          ],
        },
      },
      {
        nonce: 4n,
        originTx: `0x${"44".repeat(32)}`,
        expectedDrift: "unsupported_envelope",
        expectedRef: "axl-msg-env-4",
        body: {
          messages: [
            {
              sourceTxHash: `0x${"44".repeat(32)}`,
              messageId: "axl-msg-env-4",
              state: "DELIVERED_FINAL",
            },
          ],
        },
      },
    ] as const;

    const payloadByOrigin = new Map<string, unknown>(
      cases.map((entry) => [entry.originTx.toLowerCase(), entry.body]),
    );

    for (const entry of cases) {
      await seedOutboundTransfer(entry.nonce, entry.originTx);
    }

    const fetch = ((_url: unknown, init?: RequestInit) => {
      const rawBody = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(rawBody) as { txHash?: string };
      const body = payloadByOrigin.get((parsed.txHash ?? "").toLowerCase()) ?? { data: [] };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof globalThis.fetch;

    const client = new AxelarGmpClient(BASE_URL, {
      fetch,
      quarantineDb: db,
    });

    const pass = new RailPass({
      route: RouteKind.AxelarIts,
      client,
      db,
      logger,
      batchSize: 10,
      recheckAfterMs: 0,
      maxCheckFailures: 5,
    });

    await pass.tick(new AbortController().signal);

    // Zero inbound deliveries exist, and no rail_attestation row may say delivered or attested.
    const inboundCount = await db.query("SELECT COUNT(*)::int AS cnt FROM inbound_delivery");
    expect(inboundCount.rows[0]?.cnt).toBe(0);

    const attestations = await db.query(
      "SELECT transfer_id, status, rail_reference FROM rail_attestation ORDER BY transfer_id ASC",
    );
    expect(attestations.rows).toHaveLength(4);
    for (const row of attestations.rows) {
      expect(row.status).toBe("pending");
    }

    const quarantined = await listQuarantinedAxelarRecords(db);
    expect(quarantined).toHaveLength(4);
    for (let i = 0; i < cases.length; i += 1) {
      const item = quarantined[i];
      const expected = cases[i];
      expect(item).toBeDefined();
      expect(expected).toBeDefined();
      if (!item || !expected) continue;
      expect(item.nonce).toBe(expected.nonce);
      expect(item.originTx).toBe(expected.originTx);
      expect(item.driftKind).toBe(expected.expectedDrift);
      expect(item.providerReference).toBe(expected.expectedRef);
      expect(item.quarantineStatus).toBe("quarantined");
    }
  });

  it("scrubs credentials, bounds oversized payloads, deduplicates identical payloads, and caps per-transfer entries", async () => {
    const transfer = await seedOutboundTransfer(10n, `0x${"55".repeat(32)}`);
    const secretSeed = buildDynamicSecretSeed();

    const noisyPayload = {
      call: {
        transactionHash: transfer.originTx,
        rpcEndpoint: "https://user:supersecret@rpc.example.org/v1?api_key=leak123&mode=fast",
      },
      status: "experimental_v3",
      message_id: "axl-msg-10",
      authorization: "Bearer top-secret-jwt-token",
      apiKey: "raw-api-key-value",
      debugNote: `Signer leaked ${secretSeed} and Bearer inline-token-xyz`,
      giantBlob: "x".repeat(MAX_QUARANTINE_PAYLOAD_BYTES * 2),
    };

    const first = await recordQuarantinedAxelarSchema(db, {
      transfer,
      providerReference: "axl-msg-10",
      driftKind: "unknown_status",
      observedStatus: "experimental_v3",
      rawPayload: noisyPayload,
      observedAt: new Date("2026-10-10T10:05:00Z"),
    });
    expect(first).not.toBeNull();
    if (!first) return;

    const serialized = JSON.stringify(first.boundedPayload);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(MAX_QUARANTINE_PAYLOAD_BYTES);
    expect(first.payloadTruncated).toBe(true);
    expect(serialized).not.toContain("supersecret");
    expect(serialized).not.toContain("leak123");
    expect(serialized).not.toContain("top-secret-jwt-token");
    expect(serialized).not.toContain("raw-api-key-value");
    expect(serialized).not.toContain("inline-token-xyz");
    expect(serialized).not.toContain(secretSeed);
    expect(serialized).toContain("[REDACTED]");

    // Recording the identical drifted payload increments occurrences instead of inserting duplicates.
    const second = await recordQuarantinedAxelarSchema(db, {
      transfer,
      providerReference: "axl-msg-10",
      driftKind: "unknown_status",
      observedStatus: "experimental_v3",
      rawPayload: noisyPayload,
      observedAt: new Date("2026-10-10T10:06:00Z"),
    });
    expect(second?.id).toBe(first.id);
    expect(second?.occurrences).toBe(2);

    // Distinct payloads up to MAX_QUARANTINE_RECORDS_PER_TRANSFER succeed; beyond the cap returns null.
    for (let idx = 1; idx < MAX_QUARANTINE_RECORDS_PER_TRANSFER; idx += 1) {
      const inserted = await recordQuarantinedAxelarSchema(db, {
        transfer,
        providerReference: `axl-msg-10-${String(idx)}`,
        driftKind: "unknown_status",
        observedStatus: `status_${String(idx)}`,
        rawPayload: { status: `status_${String(idx)}`, idx },
      });
      expect(inserted).not.toBeNull();
    }

    const overCap = await recordQuarantinedAxelarSchema(db, {
      transfer,
      providerReference: "axl-msg-over-cap",
      driftKind: "unknown_status",
      observedStatus: "overflow_status",
      rawPayload: { status: "overflow_status", extra: true },
    });
    expect(overCap).toBeNull();

    const allForTransfer = await listQuarantinedAxelarRecords(db, {
      transferId: transfer.transferId,
    });
    expect(allForTransfer).toHaveLength(MAX_QUARANTINE_RECORDS_PER_TRANSFER);
  });

  it("permits idempotent replay once a supported parser is registered while still requiring chain proof for delivered", async () => {
    const providerOnlyTransfer = await seedOutboundTransfer(21n, `0x${"61".repeat(32)}`);
    const chainVerifiedTransfer = await seedOutboundTransfer(22n, `0x${"62".repeat(32)}`);

    const cmd21 = `0x${"71".repeat(32)}` as const;
    const tx21 = `0x${"81".repeat(32)}` as const;
    const cmd22 = `0x${"72".repeat(32)}` as const;
    const tx22 = `0x${"82".repeat(32)}` as const;

    await recordQuarantinedAxelarSchema(db, {
      transfer: providerOnlyTransfer,
      providerReference: "axl-v2-21",
      driftKind: "unsupported_execution_shape",
      observedStatus: "v2_executed",
      rawPayload: {
        schemaVersion: 2,
        messageId: "axl-v2-21",
        state: "v2_executed",
        commandId: cmd21,
        destTxHash: tx21,
      },
    });

    await recordQuarantinedAxelarSchema(db, {
      transfer: chainVerifiedTransfer,
      providerReference: "axl-v2-22",
      driftKind: "unsupported_execution_shape",
      observedStatus: "v2_executed",
      rawPayload: {
        schemaVersion: 2,
        messageId: "axl-v2-22",
        state: "v2_executed",
        commandId: cmd22,
        destTxHash: tx22,
      },
    });

    const registry = new AxelarSchemaParserRegistry();

    // Before registering the v2 parser, nothing replays.
    const emptyReplay = await replayQuarantinedAxelarRecords(db, registry);
    expect(emptyReplay).toEqual({
      scanned: 2,
      replayed: 0,
      skippedUnsupported: 2,
      skippedTruncated: 0,
    });

    // Register a parser that even attempts to claim status: "delivered" directly from provider JSON.
    registry.register({
      id: "axelar-gmp-v2",
      canParse(payload: unknown): boolean {
        return (
          typeof payload === "object" &&
          payload !== null &&
          (payload as { schemaVersion?: unknown }).schemaVersion === 2
        );
      },
      parse(payload: unknown) {
        const p = payload as {
          messageId: string;
          state: string;
          commandId: `0x${string}`;
          destTxHash: `0x${string}`;
        };
        return {
          kind: "found",
          report: {
            status: "delivered",
            railStatus: p.state,
            reference: p.messageId,
            attestedAt: new Date("2026-10-10T11:00:00Z"),
            execution: {
              txHash: p.destTxHash,
              commandId: p.commandId,
            },
          },
        };
      },
    });

    const fixedReplayTime = new Date("2026-10-10T12:00:00Z");
    let verifyCalls = 0;

    const firstReplay = await replayQuarantinedAxelarRecords(db, registry, {
      now: () => fixedReplayTime,
      verifyDelivery: (transfer, report) => {
        verifyCalls += 1;
        if (transfer.nonce !== 22n || !report.execution) {
          return Promise.resolve(null);
        }
        return Promise.resolve({
          at: {
            chainKey: "sepolia",
            block: 99_100n,
            txHash: report.execution.txHash,
            logIndex: 4,
            observedAt: new Date("2026-10-10T11:01:00Z"),
          },
          row: {
            route: RouteKind.AxelarIts,
            sourceChain: transfer.originChain,
            sourceNonce: transfer.nonce,
            railMessageId: report.execution.commandId,
            recipient: EVM_RECIPIENT,
            token: EVM_TOKEN,
            amount: 10_000_000n,
            delivered: true,
            claimId: null,
          },
        });
      },
    });

    expect(firstReplay).toEqual({
      scanned: 2,
      replayed: 2,
      skippedUnsupported: 0,
      skippedTruncated: 0,
    });
    expect(verifyCalls).toBe(2);

    // Transfer 21 had no verified chain receipt/payment -> clamped to attested, NEVER delivered!
    const att21 = await db.query(
      "SELECT status, rail_reference FROM rail_attestation WHERE transfer_id = $1",
      [providerOnlyTransfer.transferId.toString()],
    );
    expect(att21.rows[0]?.status).toBe("attested");
    expect(att21.rows[0]?.rail_reference).toBe("axl-v2-21");

    // Transfer 22 passed destination chain verification -> inbound_delivery written and status = delivered.
    const att22 = await db.query(
      "SELECT status, rail_reference FROM rail_attestation WHERE transfer_id = $1",
      [chainVerifiedTransfer.transferId.toString()],
    );
    expect(att22.rows[0]?.status).toBe("delivered");
    expect(att22.rows[0]?.rail_reference).toBe("axl-v2-22");

    // Default replay skips already-replayed rows.
    const secondReplayDefault = await replayQuarantinedAxelarRecords(db, registry);
    expect(secondReplayDefault).toEqual({
      scanned: 0,
      replayed: 0,
      skippedUnsupported: 0,
      skippedTruncated: 0,
    });

    // Forced replay with includeReplayed: true is completely idempotent and preserves replayed_at and inbound_delivery.
    const forcedReplay = await replayQuarantinedAxelarRecords(db, registry, {
      includeReplayed: true,
      now: () => new Date("2026-10-10T13:00:00Z"),
      verifyDelivery: () => Promise.resolve(null),
    });
    expect(forcedReplay.replayed).toBe(2);

    const inboundAfterForced = await db.query("SELECT * FROM inbound_delivery");
    expect(inboundAfterForced.rows).toHaveLength(1);
    const firstInbound = inboundAfterForced.rows[0];
    expect(firstInbound).toBeDefined();
    if (firstInbound) {
      expect(bigintOf(firstInbound, "source_nonce")).toBe(22n);
    }

    const att22After = await db.query(
      "SELECT status FROM rail_attestation WHERE transfer_id = $1",
      [chainVerifiedTransfer.transferId.toString()],
    );
    expect(att22After.rows[0]?.status).toBe("delivered");

    const recordsAfter = await listQuarantinedAxelarRecords(db);
    expect(recordsAfter).toHaveLength(2);
    for (const rec of recordsAfter) {
      expect(rec.quarantineStatus).toBe("replayed");
      expect(rec.replayedParser).toBe("axelar-gmp-v2");
      expect(rec.replayedAt?.toISOString()).toBe(fixedReplayTime.toISOString());
    }
  });
});
