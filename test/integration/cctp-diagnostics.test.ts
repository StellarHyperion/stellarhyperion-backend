import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Viem from "viem";
import { RouteKind } from "@hyperion/protocol";
import { Database } from "../../src/db/pool.js";
import { writeOutbound } from "../../src/chains/writers.js";
import { loadConfig } from "../../src/config/config.js";
import { RailPass } from "../../src/rails/pass.js";
import { pendingForRail } from "../../src/rails/queue.js";
import type { RailReport } from "../../src/rails/types.js";
import { completeEnv } from "../helpers.js";
import { cctpProofFixture } from "../tooling/proof-fixtures.js";
import { capturingLogger } from "../stellar-fakes.js";

const evm = vi.hoisted(() => ({
  getChainId: vi.fn(),
  getTransactionReceipt: vi.fn(),
  getBlockNumber: vi.fn(),
  getBlock: vi.fn(),
}));
vi.mock("viem", async (original) => ({
  ...(await original<typeof Viem>()),
  createPublicClient: () => evm,
}));
const connection = process.env.TEST_DATABASE_URL;
(connection ? describe : describe.skip)("durable CCTP mismatch diagnostics", () => {
  let db: Database;
  let id: string;
  const fixture = cctpProofFixture();
  const base = loadConfig({ env: completeEnv() });
  const source = base.deployments.networks["stellar-testnet"]!;
  if (source.family !== "stellar") throw new Error("Expected Stellar source deployment.");
  const config = {
    ...base,
    deployments: {
      ...base.deployments,
      networks: {
        ...base.deployments.networks,
        "stellar-testnet": {
          ...source,
          adapters: { ...source.adapters, [RouteKind.Cctp]: fixture.expected.sourceAdapter },
          tokens: {
            ...source.tokens,
            USDC: { ...source.tokens.USDC!, sacId: fixture.expected.sourceToken },
          },
        },
      },
    },
  };
  const hash = `0x${"ef".repeat(32)}` as const;
  let now = new Date("2026-11-19T00:00:00Z");
  const clean = async () => {
    await db.query(
      "DELETE FROM inbound_delivery WHERE source_chain='stellar-testnet' AND source_nonce=9998300",
    );
    await db.query(
      "DELETE FROM rail_attestation WHERE transfer_id IN (SELECT id FROM outbound_transfer WHERE origin_router='cctp-diagnostic-test')",
    );
    await db.query("DELETE FROM outbound_transfer WHERE origin_router='cctp-diagnostic-test'");
  };
  beforeAll(() => {
    db = Database.open(connection ?? "");
  });
  beforeEach(async () => {
    await clean();
    now = new Date("2026-11-19T00:00:00Z");
    await writeOutbound(
      db,
      {
        chainKey: "stellar-testnet",
        router: "cctp-diagnostic-test",
        block: 1n,
        txHash: "cctp-diagnostic-source",
        logIndex: 0,
        observedAt: now,
      },
      {
        route: RouteKind.Cctp,
        nonce: 9998300n,
        sender: "Gsource",
        token: fixture.expected.sourceToken,
        grossAmount: fixture.expected.sourceAmount + 1000n,
        fee: 1000n,
        netAmount: fixture.expected.sourceAmount,
        destinationChain: "sepolia",
        destination: `0x${fixture.expected.recipient.slice(2).padStart(64, "0")}`,
        railRef: "0x00",
      },
    );
    id = String(
      (
        await db.query(
          "SELECT id FROM outbound_transfer WHERE origin_router='cctp-diagnostic-test'",
        )
      ).rows[0]!.id,
    );
    evm.getChainId.mockResolvedValue(11155111);
    evm.getBlockNumber.mockResolvedValue(1000n);
    evm.getTransactionReceipt.mockResolvedValue({
      status: "success",
      blockNumber: 100n,
      transactionHash: hash,
      blockHash: hash,
      logs: [fixture.received, fixture.paid],
    });
    evm.getBlock.mockResolvedValue({ hash, timestamp: 1700000000n });
  });
  afterAll(async () => {
    await clean();
    await db.close();
  });
  const tick = async (report: RailReport) => {
    const { logger } = capturingLogger();
    const pass = new RailPass({
      config,
      db,
      logger,
      route: RouteKind.Cctp,
      batchSize: 100,
      recheckAfterMs: 1000,
      maxCheckFailures: 2,
      now: () => now,
      client: { rail: "cctp", look: () => Promise.resolve({ kind: "found", report }) },
    });
    await pass.tick(new AbortController().signal);
    now = new Date(now.getTime() + 1001);
    return (
      await db.query(
        "SELECT status,verification_failure,check_failures,next_attempt_at FROM rail_attestation WHERE transfer_id=$1",
        [id],
      )
    ).rows[0];
  };
  const report: RailReport = {
    status: "attested",
    railStatus: "complete",
    reference: null,
    attestedAt: null,
    forwardTxHash: hash,
    messageBytes: fixture.raw,
  };
  it.each(["forward_tx_missing", "message_missing"] as const)(
    "keeps %s retryable across new pass instances without consuming failures",
    async (failure) => {
      const { forwardTxHash, ...withoutForwardTx } = report;
      expect(forwardTxHash).toBe(hash);
      const missingReport =
        failure === "forward_tx_missing" ? withoutForwardTx : { ...report, messageBytes: null };
      for (let attempt = 0; attempt < 3; attempt++) {
        const row = await tick(missingReport);
        expect(row?.status).toBe("pending");
        expect(row?.verification_failure).toBe(failure);
        expect(row?.check_failures).toBe(0);
        expect(row?.next_attempt_at).toBeInstanceOf(Date);
      }
      expect(
        (
          await pendingForRail(db, {
            route: 0,
            limit: 100,
            now,
            notCheckedSince: now,
            maxCheckFailures: 2,
          })
        ).some((t) => t.transferId.toString() === id),
      ).toBe(true);
      expect(
        (await db.query("SELECT 1 FROM inbound_delivery WHERE source_nonce=9998300")).rows,
      ).toHaveLength(0);
      expect((await tick(report))?.status).toBe("delivered");
      expect(
        (
          await db.query(
            "SELECT amount::text,recipient FROM inbound_delivery WHERE source_nonce=9998300",
          )
        ).rows,
      ).toEqual([{ amount: "99600000", recipient: fixture.expected.recipient }]);
    },
  );
  it("persists a bounded mismatch and clears it only when canonical proof establishes delivery", async () => {
    await db.query(
      "UPDATE outbound_transfer SET net_amount=net_amount+10,gross_amount=gross_amount+10 WHERE id=$1",
      [id],
    );
    expect((await tick(report))?.verification_failure).toBe("amount_mismatch");
    await db.query(
      "UPDATE outbound_transfer SET net_amount=net_amount-10,gross_amount=gross_amount-10 WHERE id=$1",
      [id],
    );
    const delivered = await tick(report);
    expect(delivered?.status).toBe("delivered");
    expect(delivered?.verification_failure).toBeNull();
    await expect(
      db.query(
        "UPDATE rail_attestation SET verification_failure='token=private-provider-value' WHERE transfer_id=$1",
        [id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
