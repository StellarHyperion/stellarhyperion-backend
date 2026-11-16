import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { AddressKind, encodeStellarAddress } from "@hyperion/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeAttestation, writeInbound, writeOutbound } from "../../src/chains/writers.js";
import type { Queryable, QueryResultRows, Transactional } from "../../src/db/pool.js";
import { bigintOf, integer, text, textOrNull, timestampOrNull } from "../../src/db/rows.js";
import { RailCircuitBreaker, sanitizeCircuitError } from "../../src/rails/circuit-breaker.js";
import { RailPass } from "../../src/rails/pass.js";
import { RailError, type PendingTransfer, type RailLookup } from "../../src/rails/types.js";
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

const STELLAR_SENDER = encodeStellarAddress(AddressKind.Account, new Uint8Array(32).fill(0x11));
const STELLAR_TOKEN = encodeStellarAddress(AddressKind.Contract, new Uint8Array(32).fill(0x22));
const EVM_RECIPIENT = `0x${"00".repeat(12)}${"33".repeat(20)}`;
const EVM_TOKEN = `0x${"44".repeat(20)}`;

describe("per-provider circuit breakers for rail discovery (#88)", () => {
  let pg: PGlite;
  let db: Transactional;

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec(migrationUpSql("1790900000000_initial-schema.sql"));
    await pg.exec(migrationUpSql("1791000000000_cursor-block-hash.sql"));
    db = pgliteTransactional(pg);
  });

  afterEach(async () => {
    await pg.close();
  });

  async function seedTransfer(
    nonce: bigint,
    route: number,
    destinationChain = "sepolia",
  ): Promise<bigint> {
    await db.transaction(async (tx) => {
      await writeOutbound(
        tx,
        {
          chainKey: "stellar-testnet",
          block: 800_000n + nonce,
          txHash: `${"aa".repeat(30)}${nonce.toString().padStart(4, "0")}`,
          logIndex: null,
          observedAt: new Date("2026-10-12T00:00:00Z"),
        },
        {
          route,
          nonce,
          sender: STELLAR_SENDER,
          token: STELLAR_TOKEN,
          grossAmount: 5_001_000n,
          fee: 1_000n,
          netAmount: 5_000_000n,
          destinationChain,
          destination: EVM_RECIPIENT,
          railRef: null,
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

  it("isolates provider outages across rails and keeps independent destination proof verification active", async () => {
    await seedTransfer(1n, 0, "sepolia");
    await seedTransfer(2n, 0, "base-sepolia");
    await seedTransfer(3n, 0, "sepolia");
    const deliveredViaInboundNonce = 4n;
    await seedTransfer(deliveredViaInboundNonce, 0, "sepolia");
    await seedTransfer(10n, 1, "sepolia");

    let clock = new Date("2026-10-12T01:00:00Z");
    const { logger } = capturingLogger();

    let cctpLookups = 0;
    let axelarLookups = 0;
    let confirmationsReady = false;

    const cctpPass = new RailPass({
      route: 0,
      client: {
        rail: "cctp",
        look(transfer: PendingTransfer): Promise<RailLookup> {
          cctpLookups += 1;
          if (transfer.nonce === 1n && cctpLookups === 1) {
            return Promise.resolve({
              kind: "found",
              report: {
                status: "attested",
                railStatus: "complete",
                reference: "cctp-nonce-1",
                attestedAt: new Date("2026-10-12T01:00:00Z"),
                forwardTxHash: `0x${"bb".repeat(32)}`,
                messageBytes: "0x1234",
              },
            });
          }
          return Promise.reject(
            new RailError(
              "cctp",
              "transient",
              "http 503 from https://user:secretpass@iris.example.com/v2/messages",
            ),
          );
        },
      },
      db,
      logger,
      batchSize: 10,
      recheckAfterMs: 0,
      maxCheckFailures: 5,
      now: () => clock,
      circuitBreaker: {
        failureThreshold: 2,
        openDurationMs: 60_000,
        halfOpenMaxProbes: 1,
      },
      verifyCandidateDelivery: (transfer, report) => {
        if (!confirmationsReady || report.forwardTxHash === undefined) {
          return Promise.resolve(null);
        }
        return Promise.resolve({
          at: {
            chainKey: transfer.destinationChain,
            block: 9_000_001n,
            txHash: report.forwardTxHash,
            logIndex: 2,
            observedAt: clock,
          },
          row: {
            route: transfer.route,
            sourceChain: transfer.originChain,
            sourceNonce: transfer.nonce,
            railMessageId: report.reference,
            recipient: EVM_RECIPIENT,
            token: EVM_TOKEN,
            amount: 5_000_000n,
            delivered: true,
            claimId: null,
          },
        });
      },
    });

    const axelarPass = new RailPass({
      route: 1,
      client: {
        rail: "axelar",
        look(transfer: PendingTransfer): Promise<RailLookup> {
          axelarLookups += 1;
          return Promise.resolve({
            kind: "found",
            report: {
              status: "attested",
              railStatus: "executed",
              reference: `axelar-ref-${transfer.nonce.toString()}`,
              attestedAt: clock,
            },
          });
        },
      },
      db,
      logger,
      batchSize: 10,
      recheckAfterMs: 0,
      maxCheckFailures: 5,
      now: () => clock,
    });

    // Tick 1: nonce 1 gets candidate report (confirmations not ready yet), nonces 2 & 3 fail -> cctp circuit opens!
    // Nonce 4 is NOT even called because circuit opened after 2 failures!
    await cctpPass.tick(new AbortController().signal);
    expect(cctpLookups).toBe(3);
    expect(cctpPass.circuitSnapshot().state).toBe("open");
    expect(cctpPass.circuitSnapshot().deliveryImplied).toBe(false);
    expect(cctpPass.circuitSnapshot().lastError).not.toContain("secretpass");

    // Axelar pass runs completely unaffected by CCTP outage
    await axelarPass.tick(new AbortController().signal);
    expect(axelarLookups).toBe(1);
    expect(axelarPass.circuitSnapshot().state).toBe("closed");

    // While CCTP circuit is still OPEN:
    // (a) Destination watcher indexes inbound_delivery for nonce 4
    await db.transaction(async (tx) => {
      await writeInbound(
        tx,
        {
          chainKey: "sepolia",
          block: 9_000_010n,
          txHash: `0x${"cc".repeat(32)}`,
          logIndex: 0,
          observedAt: clock,
        },
        {
          route: 0,
          sourceChain: "stellar-testnet",
          sourceNonce: deliveredViaInboundNonce,
          railMessageId: "cctp-msg-4",
          recipient: EVM_RECIPIENT,
          token: EVM_TOKEN,
          amount: 5_000_000n,
          delivered: true,
          claimId: null,
        },
      );
    });
    // (b) Destination confirmations for nonce 1's stored candidate report become ready
    confirmationsReady = true;
    clock = new Date("2026-10-12T01:00:15Z"); // Still well within 60s open window!

    await cctpPass.tick(new AbortController().signal);

    // Zero additional provider lookups were made while circuit was open!
    expect(cctpLookups).toBe(3);
    expect(cctpPass.circuitSnapshot().state).toBe("open");

    // Yet BOTH independent proof paths settled nonces 1 and 4 to delivered, while nonces 2 & 3 stay non-delivered!
    const rows = await db.query(
      `SELECT t.nonce::text AS nonce, a.status
         FROM outbound_transfer t
         LEFT JOIN rail_attestation a ON a.transfer_id = t.id
        WHERE t.route = 0
        ORDER BY t.nonce ASC`,
    );
    expect(rows.rows).toEqual([
      { nonce: "1", status: "delivered" },
      { nonce: "2", status: "pending" },
      { nonce: "3", status: null },
      { nonce: "4", status: "delivered" },
    ]);
  });

  it("uses bounded half-open probes and recovers without resetting stored evidence", async () => {
    const id1 = await seedTransfer(21n, 1);
    const id2 = await seedTransfer(22n, 1);
    const id3 = await seedTransfer(23n, 1);

    const attestedTimestamp = new Date("2026-10-12T02:00:00Z");
    await writeAttestation(db, {
      transferId: id1,
      route: 1,
      status: "attested",
      railStatus: "approved",
      railReference: "0xabc111-0",
      attestedAt: attestedTimestamp,
      checkedAt: new Date("2026-10-12T02:00:00Z"),
      checkFailures: 0,
      lastError: null,
    });
    await writeAttestation(db, {
      transferId: id2,
      route: 1,
      status: "pending",
      railStatus: "confirming",
      railReference: "0xabc222-0",
      attestedAt: null,
      checkedAt: new Date("2026-10-12T02:00:01Z"),
      checkFailures: 0,
      lastError: null,
    });
    await writeAttestation(db, {
      transferId: id3,
      route: 1,
      status: "pending",
      railStatus: "called",
      railReference: "0xabc333-0",
      attestedAt: null,
      checkedAt: new Date("2026-10-12T02:00:02Z"),
      checkFailures: 0,
      lastError: null,
    });

    let clock = new Date("2026-10-12T02:05:00Z");
    let providerHealthy = false;
    const seenProbes: bigint[] = [];
    const { logger } = capturingLogger();

    const breaker = new RailCircuitBreaker({
      provider: "axelar",
      failureThreshold: 1,
      openDurationMs: 30_000,
      maxOpenDurationMs: 120_000,
      halfOpenMaxProbes: 1,
      halfOpenSuccessThreshold: 1,
    });

    const pass = new RailPass({
      route: 1,
      client: {
        rail: "axelar",
        look(transfer: PendingTransfer): Promise<RailLookup> {
          seenProbes.push(transfer.nonce);
          if (!providerHealthy) {
            return Promise.reject(new RailError("axelar", "transient", "http 502 bad gateway"));
          }
          // Provider recovers; for 21 returns missing on a lagging replica to prove stored evidence is NOT wiped!
          if (transfer.nonce === 21n) {
            return Promise.resolve({ kind: "missing" });
          }
          return Promise.resolve({
            kind: "found",
            report: {
              status: "attested",
              railStatus: "executed",
              reference: `0xabc${transfer.nonce.toString()}-0`,
              attestedAt: clock,
            },
          });
        },
      },
      db,
      logger,
      batchSize: 10,
      recheckAfterMs: 10_000,
      maxCheckFailures: 3,
      now: () => clock,
      circuitBreaker: breaker,
    });

    // 1. First failure trips circuit immediately (failureThreshold = 1) after checking only nonce 21
    await pass.tick(new AbortController().signal);
    expect(seenProbes).toEqual([21n]);
    expect(pass.circuitSnapshot().state).toBe("open");

    // 2. Advance past 30s open window -> circuit enters half_open; only ONE bounded probe runs and fails -> re-opens for 60s!
    clock = new Date("2026-10-12T02:05:31Z");
    expect(pass.circuitSnapshot().state).toBe("half_open");
    expect(pass.readiness().state).toBe("degraded");

    await pass.tick(new AbortController().signal);
    expect(seenProbes).toEqual([21n, 22n]);
    expect(pass.circuitSnapshot().state).toBe("open");
    expect(pass.circuitSnapshot().totalTrips).toBe(2);

    // Verify stored evidence and check_failures were NOT reset or inflated during outage & failed probe!
    const midOutage = await db.query(
      `SELECT t.nonce::text AS nonce, a.status, a.rail_status, a.rail_reference,
              a.attested_at, a.check_failures
         FROM outbound_transfer t
         JOIN rail_attestation a ON a.transfer_id = t.id
        ORDER BY t.nonce ASC`,
    );
    expect(
      midOutage.rows.map((r) => ({
        nonce: text(r, "nonce"),
        status: text(r, "status"),
        railStatus: textOrNull(r, "rail_status"),
        railRef: textOrNull(r, "rail_reference"),
        attestedAt: timestampOrNull(r, "attested_at")?.toISOString() ?? null,
        failures: integer(r, "check_failures"),
      })),
    ).toEqual([
      {
        nonce: "21",
        status: "attested",
        railStatus: "approved",
        railRef: "0xabc111-0",
        attestedAt: attestedTimestamp.toISOString(),
        failures: 0,
      },
      {
        nonce: "22",
        status: "pending",
        railStatus: "confirming",
        railRef: "0xabc222-0",
        attestedAt: null,
        failures: 0,
      },
      {
        nonce: "23",
        status: "pending",
        railStatus: "called",
        railRef: "0xabc333-0",
        attestedAt: null,
        failures: 0,
      },
    ]);

    // 3. Advance past 60s second open window with provider healthy -> probe succeeds, circuit closes, work resumes!
    providerHealthy = true;
    clock = new Date("2026-10-12T02:06:35Z");
    await pass.tick(new AbortController().signal);

    expect(pass.circuitSnapshot().state).toBe("closed");
    expect(pass.readiness().state).toBe("ready");

    const recovered = await db.query(
      `SELECT t.nonce::text AS nonce, a.status, a.rail_status, a.rail_reference, a.attested_at
         FROM outbound_transfer t
         JOIN rail_attestation a ON a.transfer_id = t.id
        ORDER BY t.nonce ASC`,
    );
    expect(
      recovered.rows.map((r) => ({
        nonce: text(r, "nonce"),
        status: text(r, "status"),
        railStatus: textOrNull(r, "rail_status"),
        railRef: textOrNull(r, "rail_reference"),
        attestedAt: timestampOrNull(r, "attested_at")?.toISOString() ?? null,
      })),
    ).toEqual([
      {
        nonce: "21",
        status: "attested",
        railStatus: "approved",
        railRef: "0xabc111-0",
        attestedAt: attestedTimestamp.toISOString(),
      },
      {
        nonce: "22",
        status: "attested",
        railStatus: "executed",
        railRef: "0xabc22-0",
        attestedAt: clock.toISOString(),
      },
      {
        nonce: "23",
        status: "attested",
        railStatus: "executed",
        railRef: "0xabc23-0",
        attestedAt: clock.toISOString(),
      },
    ]);
  });

  it("exposes observable credential-free circuit state and never implies delivery", () => {
    const scrubbed = sanitizeCircuitError(
      "request failed for https://svc:topsecret@gmp.axelar.example?api_key=mysecret123",
    );
    expect(scrubbed).not.toContain("topsecret");
    expect(scrubbed).not.toContain("mysecret123");

    const t0 = new Date("2026-10-12T03:00:00Z");
    const breaker = new RailCircuitBreaker({
      provider: "cctp",
      failureThreshold: 2,
      openDurationMs: 15_000,
      halfOpenMaxProbes: 1,
    });

    expect(breaker.snapshot(t0)).toMatchObject({
      provider: "cctp",
      state: "closed",
      consecutiveFailures: 0,
      deliveryImplied: false,
    });

    breaker.recordProviderFailure(t0, "timeout 1");
    expect(breaker.snapshot(t0).state).toBe("closed");

    const opened = breaker.recordProviderFailure(t0, "timeout 2");
    expect(opened.state).toBe("open");
    expect(opened.deliveryImplied).toBe(false);
    expect(breaker.tryAcquireDiscoveryPermit(t0).allowed).toBe(false);

    const tHalfOpen = new Date(t0.getTime() + 15_000);
    expect(breaker.snapshot(tHalfOpen)).toMatchObject({
      state: "half_open",
      halfOpenProbesRemaining: 1,
      deliveryImplied: false,
    });

    const p1 = breaker.tryAcquireDiscoveryPermit(tHalfOpen);
    const p2 = breaker.tryAcquireDiscoveryPermit(tHalfOpen);
    expect(p1).toEqual({ allowed: true, mode: "probe" });
    expect(p2.allowed).toBe(false);

    const closed = breaker.recordSuccess(tHalfOpen);
    expect(closed).toMatchObject({
      state: "closed",
      consecutiveFailures: 0,
      lastError: null,
      deliveryImplied: false,
    });
  });
});
