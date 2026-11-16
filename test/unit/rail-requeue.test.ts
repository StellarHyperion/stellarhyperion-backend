import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { AddressKind, encodeStellarAddress } from "@hyperion/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeAttestation, writeInbound, writeOutbound } from "../../src/chains/writers.js";
import type { Queryable, QueryResultRows, Transactional } from "../../src/db/pool.js";
import { bigintOf, integer, text } from "../../src/db/rows.js";
import { RailPass } from "../../src/rails/pass.js";
import { pendingForRail } from "../../src/rails/queue.js";
import {
  executeRequeueCommand,
  listRequeueAudit,
  parseRequeueCliArgs,
  requeueTerminalTransfer,
} from "../../src/rails/requeue.js";
import type { PendingTransfer, RailClient, RailLookup } from "../../src/rails/types.js";
import { capturingLogger } from "../stellar-fakes.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function migrationUpSql(filename: string): string {
  const full = readFileSync(join(REPO_ROOT, "migrations", filename), "utf8");
  const [upPart] = full.split("-- Down Migration");
  if (upPart === undefined) {
    throw new Error(`missing -- Down Migration marker in ${filename}`);
  }
  return upPart;
}

function pgliteTransactional(pg: PGlite): Transactional {
  const toRows = (result: { rows: unknown[]; affectedRows?: number }): QueryResultRows => ({
    rows: result.rows as Record<string, unknown>[],
    rowCount: result.affectedRows ?? result.rows.length,
  });

  return {
    async query(sql: string, params?: readonly unknown[]): Promise<QueryResultRows> {
      const res = await pg.query(sql, params ? [...params] : []);
      return toRows(res);
    },
    async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
      return pg.transaction(async (tx) => {
        const wrapped: Queryable = {
          async query(sql: string, params?: readonly unknown[]): Promise<QueryResultRows> {
            const res = await tx.query(sql, params ? [...params] : []);
            return toRows(res);
          },
        };
        return work(wrapped);
      });
    },
  };
}

const STELLAR_SENDER = encodeStellarAddress(AddressKind.Account, new Uint8Array(32).fill(0x21));
const STELLAR_TOKEN = encodeStellarAddress(AddressKind.Contract, new Uint8Array(32).fill(0x34));
const EVM_RECIPIENT = `0x${"00".repeat(12)}${"ab".repeat(20)}`;
const ORIGIN_TX = "cd".repeat(32);
const GROSS_U256 = 99999999999999999999999999999999999999n;
const FEE_U256 = 111111111111111111111111111111111111n;
const NET_U256 = GROSS_U256 - FEE_U256;

describe("operator-reviewed requeue for terminal rail states (#89)", () => {
  let pg: PGlite;
  let db: Transactional;

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec(migrationUpSql("1790900000000_initial-schema.sql"));
    await pg.exec(migrationUpSql("1791000000000_cursor-block-hash.sql"));
    await pg.exec(migrationUpSql("1791200000000_rail-requeue-audit.sql"));
    db = pgliteTransactional(pg);
  });

  afterEach(async () => {
    await pg.close();
  });

  async function seedOutbound(nonce: bigint, route = 1): Promise<bigint> {
    await db.transaction(async (tx) => {
      await writeOutbound(
        tx,
        {
          chainKey: "stellar-testnet",
          block: 500_000n + nonce,
          txHash: `${ORIGIN_TX.slice(0, 60)}${nonce.toString().padStart(4, "0")}`,
          logIndex: null,
          observedAt: new Date("2026-10-10T10:00:00Z"),
        },
        {
          route,
          nonce,
          sender: STELLAR_SENDER,
          token: STELLAR_TOKEN,
          grossAmount: GROSS_U256,
          fee: FEE_U256,
          netAmount: NET_U256,
          destinationChain: "sepolia",
          destination: EVM_RECIPIENT,
          railRef: `0x${"ef".repeat(32)}`,
        },
      );
    });
    const res = await db.query(
      "SELECT id FROM outbound_transfer WHERE origin_chain = $1 AND nonce = $2",
      ["stellar-testnet", nonce.toString()],
    );
    const row = res.rows[0];
    if (row === undefined) throw new Error("failed to seed outbound_transfer");
    return bigintOf(row, "id");
  }

  it("preserves original amount, recipient, and source identity across failed and expired requeues", async () => {
    const transferId = await seedOutbound(701n, 1);

    await writeAttestation(db, {
      transferId,
      route: 1,
      status: "failed",
      railStatus: "error",
      railReference: `0x${"12".repeat(32)}-0`,
      attestedAt: null,
      checkedAt: new Date("2026-10-10T10:05:00Z"),
      checkFailures: 4,
      lastError: "gateway call reverted before gas top-up",
    });

    const outcome = await requeueTerminalTransfer(db, {
      selector: { originChain: "stellar-testnet", nonce: 701n },
      reviewedBy: "ops-alice",
      reason: "Relayer executed destination call after manual gas addition",
      evidenceReference: `0x${"99".repeat(32)}`,
      at: new Date("2026-10-10T11:00:00Z"),
    });

    expect(outcome.kind).toBe("requeued");
    if (outcome.kind !== "requeued") return;

    expect(outcome.transfer.transferId).toBe(transferId);
    expect(outcome.transfer.originChain).toBe("stellar-testnet");
    expect(outcome.transfer.nonce).toBe(701n);
    expect(outcome.transfer.sender).toBe(STELLAR_SENDER);
    expect(outcome.transfer.token).toBe(STELLAR_TOKEN);
    expect(outcome.transfer.grossAmount).toBe(GROSS_U256);
    expect(outcome.transfer.fee).toBe(FEE_U256);
    expect(outcome.transfer.netAmount).toBe(NET_U256);
    expect(outcome.transfer.destinationChain).toBe("sepolia");
    expect(outcome.transfer.destination).toBe(EVM_RECIPIENT);

    const outboundAfter = await db.query(
      `SELECT origin_chain, nonce::text AS nonce, sender, token,
              gross_amount::text AS gross_amount, fee::text AS fee, net_amount::text AS net_amount,
              destination_chain, destination, rail_ref
         FROM outbound_transfer
        WHERE id = $1`,
      [transferId.toString()],
    );
    expect(outboundAfter.rows).toEqual([
      {
        origin_chain: "stellar-testnet",
        nonce: "701",
        sender: STELLAR_SENDER,
        token: STELLAR_TOKEN,
        gross_amount: GROSS_U256.toString(),
        fee: FEE_U256.toString(),
        net_amount: NET_U256.toString(),
        destination_chain: "sepolia",
        destination: EVM_RECIPIENT,
        rail_ref: `0x${"ef".repeat(32)}`,
      },
    ]);

    const attAfter = await db.query(
      `SELECT status, check_failures, last_checked_at, last_error, rail_reference
         FROM rail_attestation
        WHERE transfer_id = $1`,
      [transferId.toString()],
    );
    const attRow = attAfter.rows[0];
    expect(attRow).toBeDefined();
    if (attRow === undefined) return;
    expect(text(attRow, "status")).toBe("pending");
    expect(integer(attRow, "check_failures")).toBe(0);
    expect(attRow.last_checked_at).toBeNull();
    expect(attRow.last_error).toBeNull();
    expect(text(attRow, "rail_reference")).toBe(`0x${"12".repeat(32)}-0`);

    const eligible = await pendingForRail(db, {
      route: 1,
      limit: 10,
      notCheckedSince: new Date("2026-10-10T10:01:00Z"),
      maxCheckFailures: 5,
    });
    expect(eligible.map((item) => item.transferId)).toEqual([transferId]);
  });

  it("records prior status, reviewed reason, actor, and evidence for every terminal requeue transition", async () => {
    const transferId = await seedOutbound(702n, 0);

    await writeAttestation(db, {
      transferId,
      route: 0,
      status: "expired",
      railStatus: "expired_attestation_window",
      railReference: "cctp-nonce-702",
      attestedAt: null,
      checkedAt: new Date("2026-10-10T12:00:00Z"),
      checkFailures: 2,
      lastError: null,
    });

    const first = await requeueTerminalTransfer(db, {
      selector: { transferId },
      reviewedBy: "ops-bob",
      reason: "Circle re-attestation requested on source burn",
      evidenceReference: "iris-reattest-702",
      at: new Date("2026-10-10T12:30:00Z"),
    });
    expect(first.kind).toBe("requeued");

    // Simulate another terminal failure later and a second reviewed requeue
    await writeAttestation(db, {
      transferId,
      route: 0,
      status: "failed",
      railStatus: "attestation_rejected",
      railReference: "cctp-nonce-702-v2",
      attestedAt: null,
      checkedAt: new Date("2026-10-10T13:00:00Z"),
      checkFailures: 1,
      lastError: "domain temporary mismatch",
    });

    const second = await requeueTerminalTransfer(db, {
      selector: { transferId },
      reviewedBy: "ops-carol",
      reason: "Iris domain endpoint restored with matching v2 attestation",
      evidenceReference: "iris-v2-702",
      at: new Date("2026-10-10T13:15:00Z"),
    });
    expect(second.kind).toBe("requeued");

    const history = await listRequeueAudit(db, transferId);
    expect(history).toHaveLength(2);
    expect(
      history.map((entry) => ({
        priorStatus: entry.priorStatus,
        newStatus: entry.newStatus,
        priorRailStatus: entry.priorRailStatus,
        priorCheckFailures: entry.priorCheckFailures,
        reviewedBy: entry.reviewedBy,
        reviewedReason: entry.reviewedReason,
        evidenceReference: entry.evidenceReference,
      })),
    ).toEqual([
      {
        priorStatus: "expired",
        newStatus: "pending",
        priorRailStatus: "expired_attestation_window",
        priorCheckFailures: 2,
        reviewedBy: "ops-bob",
        reviewedReason: "Circle re-attestation requested on source burn",
        evidenceReference: "iris-reattest-702",
      },
      {
        priorStatus: "failed",
        newStatus: "pending",
        priorRailStatus: "attestation_rejected",
        priorCheckFailures: 1,
        reviewedBy: "ops-carol",
        reviewedReason: "Iris domain endpoint restored with matching v2 attestation",
        evidenceReference: "iris-v2-702",
      },
    ]);
  });

  it("refuses repeated requeues and cannot duplicate a confirmed destination payout", async () => {
    const transferId = await seedOutbound(703n, 1);

    await writeAttestation(db, {
      transferId,
      route: 1,
      status: "failed",
      railStatus: "error",
      railReference: "axelar-msg-703",
      attestedAt: null,
      checkedAt: new Date("2026-10-10T14:00:00Z"),
      checkFailures: 3,
      lastError: "execution reverted",
    });

    const first = await requeueTerminalTransfer(db, {
      selector: { transferId },
      reviewedBy: "ops-dan",
      reason: "Destination execution succeeded on retry tx",
      evidenceReference: `0x${"77".repeat(32)}`,
    });
    expect(first.kind).toBe("requeued");

    // Immediate duplicate requeue while pending is refused without writing another audit row
    const duplicateWhilePending = await requeueTerminalTransfer(db, {
      selector: { transferId },
      reviewedBy: "ops-dan",
      reason: "Accidental double invocation",
    });
    expect(duplicateWhilePending).toMatchObject({
      kind: "refused",
      code: "not_terminal",
      currentStatus: "pending",
    });

    // Destination watcher records canonical on-chain delivery
    await db.transaction(async (tx) => {
      await writeInbound(
        tx,
        {
          chainKey: "sepolia",
          block: 7_000_123n,
          txHash: `0x${"88".repeat(32)}`,
          logIndex: 4,
          observedAt: new Date("2026-10-10T14:05:00Z"),
        },
        {
          route: 1,
          sourceChain: "stellar-testnet",
          sourceNonce: 703n,
          railMessageId: `0x${"55".repeat(32)}`,
          recipient: EVM_RECIPIENT,
          token: `0x${"44".repeat(20)}`,
          amount: NET_U256,
          delivered: true,
          claimId: null,
        },
      );
    });

    // Even before RailPass marks rail_attestation delivered, requeue refuses because inbound_delivery exists
    const refusedWithInbound = await requeueTerminalTransfer(db, {
      selector: { transferId },
      reviewedBy: "ops-dan",
      reason: "Attempt requeue when inbound delivery already landed",
    });
    expect(refusedWithInbound).toMatchObject({
      kind: "refused",
      code: "already_delivered",
    });

    // Run RailPass to settle attestation to delivered without calling provider
    const { logger } = capturingLogger();
    const pass = new RailPass({
      route: 1,
      client: {
        rail: "axelar",
        look(): Promise<RailLookup> {
          return Promise.reject(new Error("must not call external provider once delivered"));
        },
      },
      db,
      logger,
      batchSize: 10,
      recheckAfterMs: 0,
      maxCheckFailures: 5,
    });
    await pass.tick(new AbortController().signal);

    // Requeue after delivered status is also refused
    const refusedAfterDelivered = await requeueTerminalTransfer(db, {
      selector: { transferId },
      reviewedBy: "ops-dan",
      reason: "Attempt requeue after delivered settlement",
    });
    expect(refusedAfterDelivered).toMatchObject({
      kind: "refused",
      code: "already_delivered",
      currentStatus: "delivered",
    });

    const inboundCount = await db.query(
      "SELECT count(*)::int AS n FROM inbound_delivery WHERE source_chain = $1 AND source_nonce = $2",
      ["stellar-testnet", "703"],
    );
    expect(integer(inboundCount.rows[0] ?? {}, "n")).toBe(1);

    const history = await listRequeueAudit(db, transferId);
    expect(history).toHaveLength(1);
  });

  it("supports controlled local admin CLI execution, --evaluate-now, and credential-free validation", async () => {
    const transferId = await seedOutbound(704n, 0);

    await writeAttestation(db, {
      transferId,
      route: 0,
      status: "expired",
      railStatus: "expired",
      railReference: "cctp-704",
      attestedAt: null,
      checkedAt: new Date("2026-10-10T15:00:00Z"),
      checkFailures: 5,
      lastError: "expired window",
    });

    // Rejects secret-bearing strings in CLI arguments
    const badCreds = await executeRequeueCommand(
      [
        "--transfer-id",
        transferId.toString(),
        "--reviewed-by",
        "ops-eve",
        "--reason",
        "checked https://admin:supersecret@rpc.example.org",
      ],
      { db },
    );
    expect(badCreds.exitCode).toBe(2);
    expect(badCreds.output.kind).toBe("invalid_arguments");

    const parsed = parseRequeueCliArgs([
      "--origin-chain",
      "stellar-testnet",
      "--nonce",
      "704",
      "--reviewed-by",
      "ops-eve",
      "--reason",
      "New attestation published on Iris",
      "--evidence",
      "iris-msg-704",
      "--evaluate-now",
    ]);
    expect(parsed.evaluateNow).toBe(true);

    const { logger } = capturingLogger();
    let providerCalls = 0;
    const mockClient: RailClient = {
      rail: "cctp",
      look(_transfer: PendingTransfer): Promise<RailLookup> {
        providerCalls += 1;
        // Provider attestation alone maps to attested, NEVER delivered without destination proof!
        return Promise.resolve({
          kind: "found",
          report: {
            status: "attested",
            railStatus: "complete",
            reference: "iris-msg-704",
            attestedAt: new Date("2026-10-10T15:10:00Z"),
          },
        });
      },
    };
    const pass = new RailPass({
      route: 0,
      client: mockClient,
      db,
      logger,
      batchSize: 10,
      recheckAfterMs: 60_000,
      maxCheckFailures: 5,
    });

    const cliResult = await executeRequeueCommand(
      [
        "--transfer-id",
        transferId.toString(),
        "--reviewed-by",
        "ops-eve",
        "--reason",
        "New attestation published on Iris",
        "--evidence",
        "iris-msg-704",
        "--evaluate-now",
      ],
      {
        db,
        evaluateTransfer: (_route, id, signal) => pass.evaluateTransfer(id, signal),
      },
    );

    expect(cliResult.exitCode).toBe(0);
    expect(providerCalls).toBe(1);
    expect(cliResult.output).toMatchObject({
      kind: "requeued",
      evaluation: { attempted: true, settled: false },
      transfer: {
        transferId: transferId.toString(),
        nonce: "704",
        grossAmount: GROSS_U256.toString(),
        fee: FEE_U256.toString(),
        netAmount: NET_U256.toString(),
        destination: EVM_RECIPIENT,
      },
    });

    // Attestation moved to attested (not delivered, since provider status alone never establishes delivery)
    const att = await db.query(
      "SELECT status, rail_reference FROM rail_attestation WHERE transfer_id = $1",
      [transferId.toString()],
    );
    expect(att.rows[0]).toEqual({
      status: "attested",
      rail_reference: "iris-msg-704",
    });
  });
});
