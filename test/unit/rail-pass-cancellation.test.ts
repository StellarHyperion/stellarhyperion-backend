import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../../src/config/config.js";
import type { Queryable, QueryResultRows, Transactional } from "../../src/db/pool.js";
import { revalidateItsDeliveryProofs, verifyItsDelivery } from "../../src/rails/axelar/delivery.js";
import { inspectCctpDelivery } from "../../src/rails/cctp/delivery.js";
import { RailPass } from "../../src/rails/pass.js";
import type { RailClient } from "../../src/rails/types.js";
import { capturingLogger } from "../stellar-fakes.js";

vi.mock("../../src/rails/axelar/delivery.js", () => ({
  revalidateItsDeliveryProofs: vi.fn(),
  verifyItsDelivery: vi.fn(),
}));
vi.mock("../../src/rails/cctp/delivery.js", () => ({
  inspectCctpDelivery: vi.fn(),
}));

class CancellingDb implements Transactional {
  readonly statements: string[] = [];

  constructor(private readonly shutdown: AbortController) {}

  query(sql: string): Promise<QueryResultRows> {
    this.statements.push(sql);
    if (sql.includes("FROM outbound_transfer t")) {
      return Promise.resolve({
        rows: [
          {
            id: "18446744073709551627",
            route: 0,
            origin_chain: "stellar-testnet",
            destination_chain: "sepolia",
            nonce: "42",
            origin_tx: "0xabc",
            status: "pending",
            check_failures: 0,
            retry_attempts: 0,
            delivered: false,
          },
        ],
        rowCount: 1,
      });
    }
    if (sql.includes("INSERT INTO inbound_delivery")) {
      this.shutdown.abort(new Error("rail shutdown"));
      return Promise.resolve({ rows: [{ id: "1" }], rowCount: 1 });
    }
    return Promise.resolve({ rows: [], rowCount: 1 });
  }

  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    return work(this);
  }
}

describe("rail delivery persistence during shutdown", () => {
  beforeEach(() => {
    vi.mocked(revalidateItsDeliveryProofs).mockReset();
    vi.mocked(verifyItsDelivery).mockReset().mockResolvedValue(null);
    vi.mocked(inspectCctpDelivery)
      .mockReset()
      .mockResolvedValue({
        delivery: {
          at: {
            chainKey: "sepolia",
            block: 10n,
            txHash: "0xdead",
            logIndex: 0,
            observedAt: new Date("2026-11-21T00:00:00.000Z"),
          },
          row: {
            route: 0,
            sourceChain: "stellar-testnet",
            sourceNonce: 42n,
            recipient: "0x2222222222222222222222222222222222222222",
            token: "0x3333333333333333333333333333333333333333",
            amount: 1_000n,
            delivered: true,
            claimId: null,
            railMessageId: "rail-42",
          },
        },
        failure: null,
        proofEvidence: null,
      } as never);
  });

  it("does not write delivered status when shutdown lands after verified inbound persistence", async () => {
    const shutdown = new AbortController();
    const db = new CancellingDb(shutdown);
    const { logger } = capturingLogger();
    const client = {
      rail: "cctp",
      look: () =>
        Promise.resolve({
          kind: "found",
          report: {
            status: "attested",
            railStatus: "complete",
            reference: "42",
            attestedAt: new Date("2026-11-21T00:00:00.000Z"),
            execution: { txHash: "0xfeed" },
          },
        }),
    } as unknown as RailClient;

    const pass = new RailPass({
      route: 0,
      client,
      db,
      logger,
      batchSize: 1,
      recheckAfterMs: 60_000,
      maxCheckFailures: 5,
      config: { destinationVerification: { evmRpcUrls: {} } } as AppConfig,
    });

    await expect(pass.evaluateTransfer(42n, shutdown.signal)).resolves.toBe(false);
    expect(db.statements.some((sql) => sql.includes("INSERT INTO inbound_delivery"))).toBe(true);
    expect(
      db.statements.some(
        (sql) =>
          sql.includes("INSERT INTO rail_attestation") || sql.includes("UPDATE rail_attestation"),
      ),
    ).toBe(false);
  });
});
