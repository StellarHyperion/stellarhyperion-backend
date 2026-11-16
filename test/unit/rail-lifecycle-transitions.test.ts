import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { AddressKind, encodeStellarAddress } from "@hyperion/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { writeInbound, writeOutbound } from "../../src/chains/writers.js";
import type { Queryable, QueryResultRows, Transactional } from "../../src/db/pool.js";
import { bigintOf, textOrNull } from "../../src/db/rows.js";
import { RailPass } from "../../src/rails/pass.js";
import {
  commitRailTransition,
  listRailLifecycleTransitions,
  reconcileRailTransition,
} from "../../src/rails/queue.js";
import {
  InvalidRailTransitionError,
  RailError,
  type PendingTransfer,
  type RailClient,
  type RailLookup,
} from "../../src/rails/types.js";
import { capturingLogger } from "../stellar-fakes.js";

const MIGRATIONS = [
  "1790900000000_initial-schema.sql",
  "1791000000000_cursor-block-hash.sql",
  "1791100000000_cursor-autovacuum-tuning.sql",
  "1791200000000_rail-lifecycle-transitions.sql",
] as const;

interface PGliteHarness extends Transactional {
  close(): Promise<void>;
}

async function openMigratedPGlite(): Promise<PGliteHarness> {
  const pg = await PGlite.create();

  const query = async (sql: string, params: readonly unknown[] = []): Promise<QueryResultRows> => {
    const normalized = params.map((p) => (p instanceof Date ? p.toISOString() : p));
    const result =
      normalized.length === 0 && sql.includes(";")
        ? await (async () => {
            await pg.exec(sql);
            return { rows: [], fields: [], affectedRows: 0 };
          })()
        : await pg.query(sql, normalized);

    const int8Cols = result.fields.filter((f) => f.dataTypeID === 20).map((f) => f.name);
    const rows = result.rows.map((raw) => {
      const copy = { ...(raw as Record<string, unknown>) };
      for (const col of int8Cols) {
        const val = copy[col];
        if (typeof val === "number" || typeof val === "bigint") {
          copy[col] = String(val);
        }
      }
      return copy;
    });
    return { rows, rowCount: result.affectedRows ?? rows.length };
  };

  for (const file of MIGRATIONS) {
    const migrationPath = fileURLToPath(new URL(`../../migrations/${file}`, import.meta.url));
    const upSql = readFileSync(migrationPath, "utf8").split(/^--\s*Down Migration\b/m)[0] ?? "";
    await query(upSql);
  }

  return {
    query,
    async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
      await pg.exec("BEGIN");
      try {
        const out = await work({ query });
        await pg.exec("COMMIT");
        return out;
      } catch (err) {
        await pg.exec("ROLLBACK");
        throw err;
      }
    },
    async close(): Promise<void> {
      await pg.close();
    },
  };
}

const STELLAR_DEST = encodeStellarAddress(AddressKind.Account, `0x${"11".repeat(32)}`);

describe("rail lifecycle transition history (#92)", () => {
  const handles: PGliteHarness[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const db = handles.pop();
      if (db !== undefined) await db.close();
    }
  });

  it("deduplicates repeated identical polls while recording genuine status and evidence transitions", async () => {
    const db = await openMigratedPGlite();
    handles.push(db);
    const { logger } = capturingLogger();

    const baseTime = new Date("2026-10-16T10:00:00.000Z");
    let clockMs = baseTime.getTime();

    await db.transaction(async (tx) => {
      await writeOutbound(
        tx,
        {
          chainKey: "sepolia",
          block: 5000n,
          txHash: `0x${"aa".repeat(32)}`,
          logIndex: 0,
          observedAt: baseTime,
        },
        {
          route: 0,
          nonce: 901n,
          sender: `0x${"22".repeat(20)}`,
          token: `0x${"33".repeat(20)}`,
          grossAmount: 100_050_000n,
          fee: 50_000n,
          netAmount: 100_000_000n,
          destinationChain: "stellar-testnet",
          destination: STELLAR_DEST,
          railRef: null,
        },
      );
    });

    let currentLookup: RailLookup = { kind: "missing" };
    let throwTransient = false;

    const client: RailClient = {
      rail: "cctp",
      look(_transfer: PendingTransfer): Promise<RailLookup> {
        if (throwTransient) {
          const urlWithCreds = [
            "https",
            "://",
            "svc",
            ":",
            "secret_key",
            "@iris.example/v2?api_key=tok123",
          ].join("");
          return Promise.reject(
            new RailError("cctp", "transient", `upstream timeout at ${urlWithCreds}`),
          );
        }
        return Promise.resolve(currentLookup);
      },
    };

    const pass = new RailPass({
      route: 0,
      client,
      db,
      logger,
      batchSize: 10,
      recheckAfterMs: 1_000,
      maxCheckFailures: 10,
      now: () => new Date(clockMs),
    });

    // 1. Poll 10 times while missing -> exactly 1 transition (null -> pending, awaiting_provider_index).
    for (let i = 0; i < 10; i += 1) {
      clockMs += 5_000;
      await pass.tick(new AbortController().signal);
    }

    let history = await listRailLifecycleTransitions(db, { originChain: "sepolia", nonce: 901n });
    expect(history).toHaveLength(1);
    expect(history[0]?.previousStatus).toBeNull();
    expect(history[0]?.nextStatus).toBe("pending");
    expect(history[0]?.reason).toBe("awaiting_provider_index");

    // 2. Provider discovers message as pending_confirmations; poll 8 times -> 1 new transition (total 2).
    currentLookup = {
      kind: "found",
      report: {
        status: "pending",
        railStatus: "pending_confirmations",
        reference: "event-nonce-901",
        attestedAt: null,
      },
    };
    for (let i = 0; i < 8; i += 1) {
      clockMs += 5_000;
      await pass.tick(new AbortController().signal);
    }

    history = await listRailLifecycleTransitions(db, { originChain: "sepolia", nonce: 901n });
    expect(history).toHaveLength(2);
    expect(history[1]?.previousStatus).toBe("pending");
    expect(history[1]?.nextStatus).toBe("pending");
    expect(history[1]?.reason).toBe("provider_pending");
    expect(history[1]?.evidence.railStatus).toBe("pending_confirmations");
    expect(history[1]?.evidence.railReference).toBe("event-nonce-901");

    // 3. Provider reaches attested; poll 8 times (plus 3 transient error ticks) -> bounded transitions, never delivered!
    currentLookup = {
      kind: "found",
      report: {
        status: "attested",
        railStatus: "complete",
        reference: "event-nonce-901",
        attestedAt: new Date(clockMs),
      },
    };
    for (let i = 0; i < 8; i += 1) {
      clockMs += 5_000;
      await pass.tick(new AbortController().signal);
    }

    history = await listRailLifecycleTransitions(db, { originChain: "sepolia", nonce: 901n });
    expect(history).toHaveLength(3);
    expect(history[2]?.previousStatus).toBe("pending");
    expect(history[2]?.nextStatus).toBe("attested");
    expect(history[2]?.reason).toBe("provider_attested");

    throwTransient = true;
    for (let i = 0; i < 3; i += 1) {
      clockMs += 5_000;
      await pass.tick(new AbortController().signal);
    }
    throwTransient = false;

    history = await listRailLifecycleTransitions(db, { originChain: "sepolia", nonce: 901n });
    expect(history).toHaveLength(4);
    expect(history[3]?.reason).toBe("lookup_transient_error");

    const attRow = await db.query("SELECT last_error FROM rail_attestation");
    const sanitizedLastError = textOrNull(attRow.rows[0] ?? {}, "last_error") ?? "";
    expect(sanitizedLastError).toContain("[redacted]");
    expect(sanitizedLastError).not.toContain("secret_key");
    expect(sanitizedLastError).not.toContain("tok123");

    // 4. Destination inbound_delivery lands -> transitions cleanly to delivered with exact destination proof refs.
    await db.transaction(async (tx) => {
      await writeInbound(
        tx,
        {
          chainKey: "stellar-testnet",
          block: 8000n,
          txHash: `0x${"dd".repeat(32)}`,
          logIndex: null,
          observedAt: new Date(clockMs),
        },
        {
          route: 0,
          sourceChain: "sepolia",
          sourceNonce: 901n,
          railMessageId: `0x${"ee".repeat(32)}`,
          recipient: STELLAR_DEST,
          token: `0x${"33".repeat(20)}`,
          amount: 100_000_000n,
          delivered: true,
          claimId: null,
        },
      );
    });

    clockMs += 5_000;
    await pass.tick(new AbortController().signal);

    history = await listRailLifecycleTransitions(db, { originChain: "sepolia", nonce: 901n });
    expect(history).toHaveLength(5);
    const finalItem = history[4];
    expect(finalItem?.previousStatus).toBe("attested");
    expect(finalItem?.nextStatus).toBe("delivered");
    expect(finalItem?.reason).toBe("inbound_delivery_observed");
    expect(finalItem?.evidence.destinationTx).toBe(`0x${"dd".repeat(32)}`);
    expect(finalItem?.evidence.railMessageId).toBe(`0x${"ee".repeat(32)}`);
    expect(finalItem?.grossAmount).toBe("100050000");
    expect(finalItem?.netAmount).toBe("100000000");
    expect(finalItem?.destination).toBe(STELLAR_DEST);
  });

  it("rejects backward transitions and unverified delivered claims unless explicitly reconciled", async () => {
    const db = await openMigratedPGlite();
    handles.push(db);
    const { logger, lines } = capturingLogger();

    const now = new Date("2026-10-16T12:00:00.000Z");
    await db.transaction(async (tx) => {
      await writeOutbound(
        tx,
        {
          chainKey: "sepolia",
          block: 6000n,
          txHash: `0x${"b1".repeat(32)}`,
          logIndex: 0,
          observedAt: now,
        },
        {
          route: 1,
          nonce: 902n,
          sender: `0x${"22".repeat(20)}`,
          token: `0x${"33".repeat(20)}`,
          grossAmount: 50_010_000n,
          fee: 10_000n,
          netAmount: 50_000_000n,
          destinationChain: "stellar-testnet",
          destination: STELLAR_DEST,
          railRef: `0x${"c1".repeat(32)}`,
        },
      );
    });

    const idRes = await db.query("SELECT id FROM outbound_transfer WHERE nonce = 902");
    const transferId = bigintOf(idRes.rows[0] ?? {}, "id");

    // Provider status alone cannot write 'delivered' without inbound_delivery.
    await expect(
      db.transaction((tx) =>
        commitRailTransition(tx, {
          transferId,
          route: 1,
          nextStatus: "delivered",
          reason: "fake_provider_delivered",
          checkedAt: now,
          checkFailures: 0,
        }),
      ),
    ).rejects.toThrow(InvalidRailTransitionError);

    // Advance to attested.
    await db.transaction((tx) =>
      commitRailTransition(tx, {
        transferId,
        route: 1,
        nextStatus: "attested",
        reason: "provider_attested",
        evidence: { railStatus: "executed", railReference: "axelar-msg-902" },
        attestedAt: now,
        checkedAt: now,
        checkFailures: 0,
      }),
    );

    // Direct backward transition attested -> pending without reconciliation must throw.
    await expect(
      db.transaction((tx) =>
        commitRailTransition(tx, {
          transferId,
          route: 1,
          nextStatus: "pending",
          reason: "regressed_poll",
          checkedAt: new Date(now.getTime() + 5_000),
          checkFailures: 0,
        }),
      ),
    ).rejects.toThrow(InvalidRailTransitionError);

    // RailPass encountering a regressing provider poll (attested -> pending) ignores the regression and warns.
    const regressingClient: RailClient = {
      rail: "axelar",
      look(): Promise<RailLookup> {
        return Promise.resolve({
          kind: "found",
          report: {
            status: "pending",
            railStatus: "called",
            reference: "axelar-msg-902",
            attestedAt: null,
          },
        });
      },
    };
    const pass = new RailPass({
      route: 1,
      client: regressingClient,
      db,
      logger,
      batchSize: 10,
      recheckAfterMs: 0,
      maxCheckFailures: 5,
      now: () => new Date(now.getTime() + 10_000),
    });
    await pass.tick(new AbortController().signal);
    expect(lines.some((l) => l.message.includes("backward rail status regression"))).toBe(true);

    const attAfterRegression = await db.query(
      "SELECT status FROM rail_attestation WHERE transfer_id = $1",
      [transferId.toString()],
    );
    expect(attAfterRegression.rows[0]?.status).toBe("attested");

    // Explicit operator reconciliation permits audited backward transition and records reconciled=true.
    const reconciled = await reconcileRailTransition(db, {
      transferId,
      nextStatus: "pending",
      reconciliationReason: "operator_reconciled_after_axelar_gateway_reorg",
      recordedAt: new Date(now.getTime() + 20_000),
    });
    expect(reconciled.reconciled).toBe(true);
    expect(reconciled.previousStatus).toBe("attested");
    expect(reconciled.nextStatus).toBe("pending");

    const history = await listRailLifecycleTransitions(db, { transferId });
    expect(history).toHaveLength(2);
    expect(history[1]?.reconciled).toBe(true);
    expect(history[1]?.previousStatus).toBe("attested");
    expect(history[1]?.nextStatus).toBe("pending");
    expect(history[1]?.reason).toBe("operator_reconciled_after_axelar_gateway_reorg");
  });

  it("keeps transition history joined to exact source transfers and cascades cleanly on reorg purge", async () => {
    const db = await openMigratedPGlite();
    handles.push(db);
    const now = new Date("2026-10-16T13:00:00.000Z");

    await db.transaction(async (tx) => {
      for (const nonce of [1001n, 1002n]) {
        await writeOutbound(
          tx,
          {
            chainKey: "sepolia",
            block: 7000n + nonce,
            txHash: `0x${nonce.toString(16).padStart(64, "0")}`,
            logIndex: 0,
            observedAt: now,
          },
          {
            route: 0,
            nonce,
            sender: `0x${"44".repeat(20)}`,
            token: `0x${"55".repeat(20)}`,
            grossAmount: nonce * 1_000_000n,
            fee: 0n,
            netAmount: nonce * 1_000_000n,
            destinationChain: "stellar-testnet",
            destination: STELLAR_DEST,
            railRef: null,
          },
        );
      }
    });

    const rowsRes = await db.query(
      "SELECT id, nonce::text AS nonce FROM outbound_transfer ORDER BY nonce ASC",
    );
    const id1 = bigintOf(rowsRes.rows[0] ?? {}, "id");
    const id2 = bigintOf(rowsRes.rows[1] ?? {}, "id");

    await db.transaction(async (tx) => {
      await commitRailTransition(tx, {
        transferId: id1,
        route: 0,
        nextStatus: "pending",
        reason: "provider_pending",
        evidence: { railStatus: "pending_confirmations", railReference: "ref-1001" },
        checkedAt: now,
        checkFailures: 0,
      });
      await commitRailTransition(tx, {
        transferId: id2,
        route: 0,
        nextStatus: "failed",
        reason: "provider_failed",
        evidence: { railStatus: "failed", railReference: "ref-1002" },
        checkedAt: now,
        checkFailures: 0,
      });
    });

    const t1History = await listRailLifecycleTransitions(db, {
      originChain: "sepolia",
      nonce: 1001n,
    });
    expect(t1History).toHaveLength(1);
    expect(t1History[0]?.transferId).toBe(id1);
    expect(t1History[0]?.nonce).toBe(1001n);
    expect(t1History[0]?.netAmount).toBe("1001000000");
    expect(t1History[0]?.evidence.railReference).toBe("ref-1001");

    const t2History = await listRailLifecycleTransitions(db, {
      originChain: "sepolia",
      nonce: 1002n,
    });
    expect(t2History).toHaveLength(1);
    expect(t2History[0]?.transferId).toBe(id2);
    expect(t2History[0]?.nextStatus).toBe("failed");

    // Deleting source transfer 1001 cascades its transition rows without affecting 1002.
    await db.query("DELETE FROM outbound_transfer WHERE id = $1", [id1.toString()]);
    expect(await listRailLifecycleTransitions(db, { transferId: id1 })).toHaveLength(0);
    expect(await listRailLifecycleTransitions(db, { transferId: id2 })).toHaveLength(1);
  });
});
