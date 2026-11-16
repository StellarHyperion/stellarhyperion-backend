import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildIndexer } from "../../src/chains/runner.js";
import { writeAttestation, writeInbound } from "../../src/chains/writers.js";
import { loadConfig } from "../../src/config/config.js";
import type { Queryable, QueryResultRows, Transactional } from "../../src/db/pool.js";
import { BacklogValidationError, inspectRailBacklog } from "../../src/rails/backlog.js";
import { runBacklogCli } from "../../src/rails/inspect.js";
import { RailPass } from "../../src/rails/pass.js";
import type { BacklogInspectionReport, RailClient } from "../../src/rails/types.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const pg = new PGlite();

function normalizeRows(result: {
  readonly rows: readonly unknown[];
  readonly fields: readonly { readonly name: string; readonly dataTypeID: number }[];
  readonly affectedRows?: number;
}): QueryResultRows {
  const int8Columns = result.fields
    .filter((field) => field.dataTypeID === 20)
    .map((field) => field.name);
  const rows = result.rows.map((raw) => {
    const row = { ...(raw as Record<string, unknown>) };
    for (const column of int8Columns) {
      const value = row[column];
      if (typeof value === "number" || typeof value === "bigint") {
        row[column] = String(value);
      }
    }
    return row;
  });
  return { rows, rowCount: result.affectedRows ?? result.rows.length };
}

function createPgliteDb(executedSql: string[]): Transactional & Queryable {
  const rawQuery = async (
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResultRows> => {
    executedSql.push(sql.trim());
    const result = await pg.query(sql, [...params]);
    return normalizeRows(result);
  };

  return {
    query: (sql: string, params: readonly unknown[] = []) => rawQuery(sql, params),
    transaction: async <T>(work: (tx: Queryable) => Promise<T>): Promise<T> => {
      await pg.exec("BEGIN");
      try {
        const tx: Queryable = {
          query: (sql: string, params: readonly unknown[] = []) => rawQuery(sql, params),
        };
        const out = await work(tx);
        await pg.exec("COMMIT");
        return out;
      } catch (error) {
        await pg.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

describe("rail backlog age, proof-stage, and retry inspection tools", () => {
  const executedSql: string[] = [];
  const db = createPgliteDb(executedSql);
  const { logger } = capturingLogger();
  const config = loadConfig({ env: completeEnv({ KEEPER_ENABLED: "false" }) });
  const stellarDeployment = config.deployments.networks["stellar-testnet"];
  if (stellarDeployment?.family !== "stellar" || !stellarDeployment.tokens.USDC) {
    throw new Error("Expected stellar-testnet deployment in test fixture");
  }
  const senderAddress = stellarDeployment.admin;
  const sacToken = stellarDeployment.tokens.USDC.sacId;
  const recipientWord = "0x0000000000000000000000006ef8032ffe4943f27388172549f6700f18bb8b38";

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
  }, 30_000);

  beforeEach(async () => {
    executedSql.length = 0;
    await pg.exec(`
      TRUNCATE outbound_transfer, rail_attestation, inbound_delivery, pending_claim, indexer_cursor RESTART IDENTITY CASCADE;
    `);
  });

  afterAll(async () => {
    await pg.close();
  });

  async function seedTransfer(input: {
    readonly nonce: number;
    readonly route?: number;
    readonly destinationChain?: string;
    readonly observedAtIso: string;
  }): Promise<bigint> {
    const route = input.route ?? 0;
    const destinationChain = input.destinationChain ?? "sepolia";
    await pg.query(
      `INSERT INTO outbound_transfer
         (origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
          destination_chain, destination, origin_block, origin_tx, observed_at)
       VALUES
         ('stellar-testnet', $1, $2, $3, $4, 10000000, 30000, 9970000, $5, $6, $7, $8, $9::timestamptz)`,
      [
        route,
        input.nonce,
        senderAddress,
        sacToken,
        destinationChain,
        recipientWord,
        1287400 + input.nonce,
        `tx-nonce-${String(input.nonce)}`,
        input.observedAtIso,
      ],
    );
    const idResult = await pg.query<{ id: number | string }>(
      "SELECT id FROM outbound_transfer WHERE origin_chain = 'stellar-testnet' AND nonce = $1",
      [input.nonce],
    );
    return BigInt(idResult.rows[0]!.id);
  }

  it("distinguishes provider discovery delay from destination receipt verification delay across all retry classes", async () => {
    const fixedNow = new Date("2026-10-30T01:00:00.000Z");

    // 1. Never checked -> provider_discovery, overdue (observed 90s ago, recheckAfterMs = 10s)
    await seedTransfer({
      nonce: 1,
      route: 0,
      destinationChain: "sepolia",
      observedAtIso: "2026-10-30T00:58:30.000000Z",
    });

    // 2. Checked 4s ago, still pending -> provider_discovery, cooling_down
    const id2 = await seedTransfer({
      nonce: 2,
      route: 0,
      destinationChain: "base-sepolia",
      observedAtIso: "2026-10-30T00:59:20.000000Z",
    });
    await writeAttestation(db, {
      transferId: id2,
      route: 0,
      status: "pending",
      railStatus: "pending_confirmations",
      railReference: null,
      attestedAt: null,
      checkedAt: new Date("2026-10-30T00:59:56.000Z"),
      checkFailures: 0,
      lastError: null,
    });

    // 3. Attested 80s ago (40s after departure), checked 30s ago -> destination_receipt_verification, overdue
    const id3 = await seedTransfer({
      nonce: 3,
      route: 1,
      destinationChain: "sepolia",
      observedAtIso: "2026-10-30T00:58:00.000000Z",
    });
    await writeAttestation(db, {
      transferId: id3,
      route: 1,
      status: "attested",
      railStatus: "executed",
      railReference: "axelar-msg-3",
      attestedAt: new Date("2026-10-30T00:58:40.000Z"),
      checkedAt: new Date("2026-10-30T00:59:30.000Z"),
      checkFailures: 0,
      lastError: null,
    });

    // 4. Failed twice, checked 25s ago -> provider_discovery, retry_overdue
    const id4 = await seedTransfer({
      nonce: 4,
      route: 0,
      destinationChain: "arc-testnet",
      observedAtIso: "2026-10-30T00:57:00.000000Z",
    });
    await writeAttestation(db, {
      transferId: id4,
      route: 0,
      status: "pending",
      railStatus: null,
      railReference: null,
      attestedAt: null,
      checkedAt: new Date("2026-10-30T00:59:35.000Z"),
      checkFailures: 2,
      lastError: "iris temporary 502",
    });

    // 5. Exhausted check_failures (5 >= maxCheckFailures 5) with credential-bearing upstream error
    const id5 = await seedTransfer({
      nonce: 5,
      route: 0,
      destinationChain: "sepolia",
      observedAtIso: "2026-10-30T00:55:00.000000Z",
    });
    const syntheticErrorUrl = [
      "https://op",
      "erator:top",
      "-secret@rpc.sepolia.test/v1?api_key=",
      "key_999",
    ].join("");
    await writeAttestation(db, {
      transferId: id5,
      route: 0,
      status: "attested",
      railStatus: "complete",
      railReference: "iris-5",
      attestedAt: new Date("2026-10-30T00:56:00.000Z"),
      checkedAt: new Date("2026-10-30T00:58:00.000Z"),
      checkFailures: 5,
      lastError: `rpc call failed against ${syntheticErrorUrl}`,
    });

    // 6. Inbound delivery already indexed while rail_attestation still says attested -> attestation_reconciliation
    const id6 = await seedTransfer({
      nonce: 6,
      route: 0,
      destinationChain: "base-sepolia",
      observedAtIso: "2026-10-30T00:59:00.000000Z",
    });
    await writeAttestation(db, {
      transferId: id6,
      route: 0,
      status: "attested",
      railStatus: "complete",
      railReference: "iris-6",
      attestedAt: new Date("2026-10-30T00:59:10.000Z"),
      checkedAt: new Date("2026-10-30T00:59:20.000Z"),
      checkFailures: 0,
      lastError: null,
    });
    await db.transaction(async (tx) => {
      await writeInbound(
        tx,
        {
          chainKey: "base-sepolia",
          block: 9900n,
          txHash: "0xdest6",
          logIndex: 1,
          observedAt: new Date("2026-10-30T00:59:30.000Z"),
        },
        {
          route: 0,
          sourceChain: "stellar-testnet",
          sourceNonce: 6n,
          railMessageId: "0xmsg6",
          recipient: "0x6ef8032ffe4943f27388172549f6700f18bb8b38",
          token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
          amount: 997_000n,
          delivered: true,
          claimId: null,
        },
      );
    });

    // 7. Terminal delivered transfer -> excluded from backlog completely
    const id7 = await seedTransfer({
      nonce: 7,
      route: 0,
      destinationChain: "sepolia",
      observedAtIso: "2026-10-30T00:50:00.000000Z",
    });
    await writeAttestation(db, {
      transferId: id7,
      route: 0,
      status: "delivered",
      railStatus: "complete",
      railReference: "iris-7",
      attestedAt: new Date("2026-10-30T00:50:30.000Z"),
      checkedAt: new Date("2026-10-30T00:51:00.000Z"),
      checkFailures: 0,
      lastError: null,
    });

    const report = await inspectRailBacklog(db, {
      recheckAfterMs: 10_000,
      maxCheckFailures: 5,
      now: () => fixedNow,
    });

    expect(report.readOnly).toBe(true);
    expect(report.summary.totalMatching).toBe(6);
    expect(report.summary.overdueCount).toBe(5);
    expect(report.summary.exhaustedCount).toBe(1);
    expect(report.summary.byDestination).toEqual({
      "arc-testnet": 1,
      "base-sepolia": 2,
      sepolia: 3,
    });
    expect(report.summary.byStage).toEqual({
      provider_discovery: 3,
      destination_receipt_verification: 2,
      attestation_reconciliation: 1,
    });
    expect(report.summary.byRetryClass).toEqual({
      never_checked: 1,
      cooling_down: 1,
      overdue: 2,
      retry_overdue: 1,
      exhausted: 1,
    });

    const byNonce = new Map(report.candidates.map((item) => [item.nonce, item]));

    // Nonce 1: waiting on provider discovery for 90,000ms, no receipt delay
    expect(byNonce.get("1")?.missingProofStage).toBe("provider_discovery");
    expect(byNonce.get("1")?.delays).toEqual({
      totalAgeMs: 90_000,
      providerDiscoveryDelayMs: 90_000,
      receiptVerificationDelayMs: null,
      overdueByMs: 80_000,
    });

    // Nonce 3: provider discovered in 40,000ms; waiting on destination receipt verification for 80,000ms
    expect(byNonce.get("3")?.missingProofStage).toBe("destination_receipt_verification");
    expect(byNonce.get("3")?.delays).toEqual({
      totalAgeMs: 120_000,
      providerDiscoveryDelayMs: 40_000,
      receiptVerificationDelayMs: 80_000,
      overdueByMs: 20_000,
    });

    // Nonce 5: exhausted and credentials scrubbed from lastError
    expect(byNonce.get("5")?.retryClass).toBe("exhausted");
    expect(byNonce.get("5")?.lastError).not.toContain("top-secret");
    expect(byNonce.get("5")?.lastError).not.toContain("key_999");

    // Nonce 6: destination receipt already indexed -> attestation_reconciliation
    expect(byNonce.get("6")?.missingProofStage).toBe("attestation_reconciliation");
  });

  it("paginates large backlogs deterministically across colliding microsecond timestamps and rejects mismatched cursors", async () => {
    const fixedNow = new Date("2026-10-30T02:00:00.000Z");

    // Seed 35 transfers, intentionally sharing timestamps and microsecond offsets.
    for (let nonce = 1; nonce <= 35; nonce += 1) {
      const group = Math.floor((nonce - 1) / 4);
      const micros = (nonce % 3) * 111;
      const observedAtIso = `2026-10-30T01:${String(group).padStart(2, "0")}:00.${String(micros).padStart(6, "0")}Z`;
      await seedTransfer({
        nonce,
        route: nonce % 2,
        destinationChain: nonce % 3 === 0 ? "arc-testnet" : "sepolia",
        observedAtIso,
      });
    }

    const walkNonces = async (sort: "asc" | "desc"): Promise<string[]> => {
      const collected: string[] = [];
      let cursor: string | undefined;
      let pages = 0;

      for (;;) {
        const page = await inspectRailBacklog(db, {
          limit: 6,
          sort,
          cursor,
          now: () => fixedNow,
        });
        pages += 1;
        expect(page.summary.totalMatching).toBe(35);
        for (const candidate of page.candidates) {
          collected.push(candidate.nonce);
        }
        if (!page.pageInfo.hasMore || page.pageInfo.nextCursor === null) {
          break;
        }
        cursor = page.pageInfo.nextCursor;
      }

      expect(pages).toBe(6);
      return collected;
    };

    const ascNonces = await walkNonces("asc");
    const descNonces = await walkNonces("desc");

    expect(ascNonces).toHaveLength(35);
    expect(new Set(ascNonces).size).toBe(35);
    expect(descNonces).toEqual([...ascNonces].reverse());

    const firstPage = await inspectRailBacklog(db, {
      destinationChain: "sepolia",
      limit: 5,
      sort: "asc",
      now: () => fixedNow,
    });
    expect(firstPage.pageInfo.nextCursor).not.toBeNull();

    await expect(
      inspectRailBacklog(db, {
        destinationChain: "arc-testnet",
        cursor: firstPage.pageInfo.nextCursor ?? undefined,
        now: () => fixedNow,
      }),
    ).rejects.toThrow(BacklogValidationError);

    await expect(
      inspectRailBacklog(db, {
        destinationChain: "sepolia",
        sort: "desc",
        cursor: firstPage.pageInfo.nextCursor ?? undefined,
        now: () => fixedNow,
      }),
    ).rejects.toThrow(BacklogValidationError);
  });

  it("executes in a READ ONLY transaction via CLI, RailPass, and IndexerHandle without mutating lifecycle state", async () => {
    const fixedNow = new Date("2026-10-30T03:00:00.000Z");
    const id1 = await seedTransfer({
      nonce: 101,
      route: 0,
      destinationChain: "sepolia",
      observedAtIso: "2026-10-30T02:50:00.000000Z",
    });
    await writeAttestation(db, {
      transferId: id1,
      route: 0,
      status: "attested",
      railStatus: "complete",
      railReference: "iris-101",
      attestedAt: new Date("2026-10-30T02:51:00.000Z"),
      checkedAt: new Date("2026-10-30T02:55:00.000Z"),
      checkFailures: 1,
      lastError: "temporary rpc timeout",
    });

    const snapshotState = async () => {
      const transfers = await pg.query("SELECT * FROM outbound_transfer ORDER BY id");
      const attestations = await pg.query("SELECT * FROM rail_attestation ORDER BY transfer_id");
      const inbound = await pg.query("SELECT * FROM inbound_delivery ORDER BY id");
      const claims = await pg.query("SELECT * FROM pending_claim ORDER BY chain, claim_id");
      return {
        transfers: transfers.rows,
        attestations: attestations.rows,
        inbound: inbound.rows,
        claims: claims.rows,
      };
    };

    const stateBefore = await snapshotState();
    executedSql.length = 0;

    const unreachableClient: RailClient = {
      rail: "cctp",
      look: () => Promise.reject(new Error("inspection must never call provider client")),
    };
    const pass = new RailPass({
      route: 0,
      client: unreachableClient,
      db,
      logger,
      batchSize: 10,
      recheckAfterMs: 10_000,
      maxCheckFailures: 5,
      now: () => fixedNow,
    });

    const passReport = await pass.inspectBacklog();
    expect(passReport.summary.totalMatching).toBe(1);
    expect(pass.progress).toBeNull();

    const indexer = buildIndexer({ config, logger, db });
    const indexerReport = await indexer.inspectBacklog({ now: () => fixedNow });
    expect(indexerReport.summary.totalMatching).toBe(1);

    let jsonOut = "";
    let errOut = "";
    const jsonExit = await runBacklogCli(
      ["--route", "0", "--overdue-only", "--format", "json"],
      {
        stdout: (chunk) => {
          jsonOut += chunk;
        },
        stderr: (chunk) => {
          errOut += chunk;
        },
      },
      {
        db,
        recheckAfterMs: 10_000,
        maxCheckFailures: 5,
        now: () => fixedNow,
      },
    );
    expect(jsonExit).toBe(0);
    expect(errOut).toBe("");
    const parsedCli = JSON.parse(jsonOut) as BacklogInspectionReport;
    expect(parsedCli.candidates[0]?.missingProofStage).toBe("destination_receipt_verification");
    expect(parsedCli.candidates[0]?.retryClass).toBe("retry_overdue");

    let tableOut = "";
    const tableExit = await runBacklogCli(
      ["--destination", "sepolia", "--format", "table"],
      {
        stdout: (chunk) => {
          tableOut += chunk;
        },
        stderr: () => undefined,
      },
      {
        db,
        recheckAfterMs: 10_000,
        maxCheckFailures: 5,
        now: () => fixedNow,
      },
    );
    expect(tableExit).toBe(0);
    expect(tableOut).toContain("Rail Backlog Report");
    expect(tableOut).toContain("destination_receipt_verification");

    expect(executedSql.some((stmt) => stmt === "SET TRANSACTION READ ONLY")).toBe(true);

    const stateAfter = await snapshotState();
    expect(stateAfter).toEqual(stateBefore);
  });
});
