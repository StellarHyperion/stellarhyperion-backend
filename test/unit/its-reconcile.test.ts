import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { AddressKind, RouteKind, encodeStellarAddress, toWord, type Hex } from "@hyperion/protocol";
import { encodeAbiParameters, encodeEventTopics, stringToHex } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { writeAttestation, writeInbound, writeOutbound } from "../../src/chains/writers.js";
import type { Queryable, QueryResultRows, Transactional } from "../../src/db/pool.js";
import { bigintOf } from "../../src/db/rows.js";
import { ITS_ABI, type DeliveryLog } from "../../src/rails/axelar/events.js";
import {
  ReadOnlyViolationError,
  executeItsReconcileCommand,
  parseItsReconcileCliArgs,
  reconcileItsTransfer,
  wrapReadOnlyQueryable,
  type ItsReceiptProofInput,
} from "../../src/rails/axelar/delivery.js";

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
const ALT_STELLAR_SENDER = encodeStellarAddress(AddressKind.Account, new Uint8Array(32).fill(0x22));
const STELLAR_SAC_TOKEN = encodeStellarAddress(AddressKind.Contract, new Uint8Array(32).fill(0x34));
const EVM_RECIPIENT: Hex = "0x1111111111111111111111111111111111111111";
const WRONG_EVM_RECIPIENT: Hex = "0x9999999999999999999999999999999999999999";
const EVM_ITS_ADDRESS: Hex = "0x2222222222222222222222222222222222222222";
const EVM_ITS_TOKEN: Hex = "0x3333333333333333333333333333333333333333";
const WRONG_EVM_TOKEN: Hex = "0x4444444444444444444444444444444444444444";
const COMMAND_ID: Hex = `0x${"ab".repeat(32)}`;
const TOKEN_ID: Hex = `0x${"cd".repeat(32)}`;
const DEST_TX: Hex = `0x${"ef".repeat(32)}`;
const BLOCK_HASH: Hex = `0x${"77".repeat(32)}`;
const ORIGIN_TX = "55".repeat(32);
const GROSS_U256 = 88888888888888888888888888888888888888n;
const FEE_U256 = 111111111111111111111111111111111111n;
const NET_U256 = GROSS_U256 - FEE_U256;

function buildReceiptLogs(overrides?: {
  readonly sender?: string;
  readonly recipient?: Hex;
  readonly token?: Hex;
  readonly amount?: bigint;
  readonly paymentAmount?: bigint;
}): readonly DeliveryLog[] {
  const senderHex = stringToHex(overrides?.sender ?? STELLAR_SENDER);
  const recipient = overrides?.recipient ?? EVM_RECIPIENT;
  const token = overrides?.token ?? EVM_ITS_TOKEN;
  const cmdAmount = overrides?.amount ?? NET_U256;
  const payAmount = overrides?.paymentAmount ?? cmdAmount;

  const receivedLog: DeliveryLog = {
    address: EVM_ITS_ADDRESS,
    topics: encodeEventTopics({
      abi: ITS_ABI,
      eventName: "InterchainTransferReceived",
      args: { commandId: COMMAND_ID, tokenId: TOKEN_ID, destinationAddress: recipient },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters(
      [{ type: "string" }, { type: "bytes" }, { type: "uint256" }, { type: "bytes32" }],
      ["stellar-2026-q1-2", senderHex, cmdAmount, `0x${"0".repeat(64)}`],
    ),
    logIndex: 4,
  };

  const transferLog: DeliveryLog = {
    address: token,
    topics: encodeEventTopics({
      abi: ITS_ABI,
      eventName: "Transfer",
      args: { from: EVM_ITS_ADDRESS, to: recipient },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: "uint256" }], [payAmount]),
    logIndex: 5,
  };

  return [receivedLog, transferLog];
}

function makeReceiptProof(logs = buildReceiptLogs()): ItsReceiptProofInput {
  return {
    txHash: DEST_TX,
    receiptStatus: "success",
    blockNumber: 9_500_010n,
    receiptBlockHash: BLOCK_HASH,
    canonicalBlockHash: BLOCK_HASH,
    headBlockNumber: 9_500_030n,
    requiredConfirmations: 12,
    itsAddress: EVM_ITS_ADDRESS,
    commandId: COMMAND_ID,
    tokenId: TOKEN_ID,
    sourceChainName: "stellar-2026-q1-2",
    destinationToken: EVM_ITS_TOKEN,
    logs,
  };
}

describe("read-only ITS source-to-payout reconciliation (#84)", () => {
  let pg: PGlite;
  let db: Transactional;

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(migrationUpSql("1790900000000_initial-schema.sql"));
    await pg.exec(migrationUpSql("1791000000000_cursor-block-hash.sql"));
    db = pgliteTransactional(pg);
  });

  beforeEach(async () => {
    await db.query("DELETE FROM pending_claim");
    await db.query("DELETE FROM inbound_delivery");
    await db.query("DELETE FROM rail_attestation");
    await db.query("DELETE FROM outbound_transfer");
  });

  afterAll(async () => {
    await pg.close();
  });

  async function seedOutbound(overrides?: {
    readonly nonce?: bigint;
    readonly route?: number;
    readonly destination?: string;
    readonly railRef?: string | null;
  }): Promise<bigint> {
    const nonce = overrides?.nonce ?? 42n;
    await db.transaction(async (tx) => {
      await writeOutbound(
        tx,
        {
          chainKey: "stellar-testnet",
          block: 700_000n + nonce,
          txHash: ORIGIN_TX,
          logIndex: null,
          observedAt: new Date("2026-10-20T01:00:00Z"),
        },
        {
          route: overrides?.route ?? RouteKind.AxelarIts,
          nonce,
          sender: STELLAR_SENDER,
          token: STELLAR_SAC_TOKEN,
          grossAmount: GROSS_U256,
          fee: FEE_U256,
          netAmount: NET_U256,
          destinationChain: "sepolia",
          destination: overrides?.destination ?? toWord(EVM_RECIPIENT),
          railRef: overrides?.railRef === undefined ? null : overrides.railRef,
        },
      );
    });
    const { rows } = await db.query(
      "SELECT id FROM outbound_transfer WHERE origin_chain = $1 AND nonce = $2",
      ["stellar-testnet", nonce.toString()],
    );
    const first = rows[0];
    if (!first) throw new Error("failed to seed outbound_transfer");
    return bigintOf(first, "id");
  }

  it("reconciles a complete source-to-payout ITS transfer with exact integer-string bindings", async () => {
    const transferId = await seedOutbound();
    await writeAttestation(db, {
      transferId,
      route: RouteKind.AxelarIts,
      status: "delivered",
      railStatus: "executed/received",
      railReference: "0xaxelar-msg-42",
      attestedAt: new Date("2026-10-20T01:01:00Z"),
      checkedAt: new Date("2026-10-20T01:02:00Z"),
      checkFailures: 0,
      lastError: null,
    });
    await writeInbound(
      db,
      {
        chainKey: "sepolia",
        block: 9_500_010n,
        txHash: DEST_TX,
        logIndex: 5,
        observedAt: new Date("2026-10-20T01:01:30Z"),
      },
      {
        route: RouteKind.AxelarIts,
        sourceChain: "stellar-testnet",
        sourceNonce: 42n,
        railMessageId: COMMAND_ID,
        recipient: EVM_RECIPIENT,
        token: EVM_ITS_TOKEN,
        amount: NET_U256,
        delivered: true,
        claimId: null,
      },
    );

    const report = await reconcileItsTransfer(
      db,
      { transferId },
      {
        expectedDestinationToken: EVM_ITS_TOKEN,
        receiptProof: makeReceiptProof(),
      },
    );

    expect(report.readOnly).toBe(true);
    expect(report.verdict).toBe("reconciled_delivered");
    expect(report.payoutVerified).toBe(true);
    expect(report.missingHistory).toEqual([]);
    expect(report.bindings.allAgreed).toBe(true);
    expect(report.bindings.sourceAccount.status).toBe("matched");
    expect(report.bindings.recipient.status).toBe("matched");
    expect(report.bindings.token.status).toBe("matched");
    expect(report.bindings.amount.status).toBe("matched");
    expect(report.sourceTransfer?.netAmount).toBe(NET_U256.toString());
    expect(report.destinationProof.amount).toBe(NET_U256.toString());
    expect(report.destinationProof.commandId).toBe(COMMAND_ID);
    expect(report.provider.reference).toBe("0xaxelar-msg-42");
    expect(report.provider.sufficientForPayout).toBe(false);
  });

  it("never treats provider executed status alone as payout and reports missing inbound_delivery", async () => {
    const transferId = await seedOutbound();
    await writeAttestation(db, {
      transferId,
      route: RouteKind.AxelarIts,
      status: "attested",
      railStatus: "executed/received",
      railReference: "0xaxelar-msg-executed-only",
      attestedAt: new Date("2026-10-20T01:01:00Z"),
      checkedAt: new Date("2026-10-20T01:02:00Z"),
      checkFailures: 0,
      lastError: null,
    });

    const report = await reconcileItsTransfer(db, {
      originChain: "stellar-testnet",
      nonce: 42n,
    });

    expect(report.verdict).toBe("awaiting_destination_proof");
    expect(report.payoutVerified).toBe(false);
    expect(report.missingHistory).toEqual(["inbound_delivery"]);
    expect(report.provider.railStatus).toBe("executed/received");
    expect(report.provider.sufficientForPayout).toBe(false);
  });

  it("reports missing outbound_transfer, rail_attestation, and provider_reference without fabricating references", async () => {
    const missingTransfer = await reconcileItsTransfer(db, { transferId: 9999n });
    expect(missingTransfer.verdict).toBe("missing_history");
    expect(missingTransfer.payoutVerified).toBe(false);
    expect(missingTransfer.missingHistory).toEqual(["outbound_transfer"]);
    expect(missingTransfer.provider.reference).toBeNull();

    // Seed outbound and inbound proof without rail_attestation or rail_ref.
    await seedOutbound({ nonce: 43n, railRef: null });
    await writeInbound(
      db,
      {
        chainKey: "sepolia",
        block: 9_500_015n,
        txHash: DEST_TX,
        logIndex: 5,
        observedAt: new Date("2026-10-20T01:05:00Z"),
      },
      {
        route: RouteKind.AxelarIts,
        sourceChain: "stellar-testnet",
        sourceNonce: 43n,
        railMessageId: COMMAND_ID,
        recipient: EVM_RECIPIENT,
        token: EVM_ITS_TOKEN,
        amount: NET_U256,
        delivered: true,
        claimId: null,
      },
    );

    const report = await reconcileItsTransfer(db, { originTx: ORIGIN_TX });
    expect(report.payoutVerified).toBe(true);
    expect(report.verdict).toBe("missing_history");
    expect(report.missingHistory).toEqual(["rail_attestation", "provider_reference"]);
    // Must not fabricate provider.reference from originTx or commandId.
    expect(report.provider.reference).toBeNull();
    expect(report.destinationProof.commandId).toBe(COMMAND_ID);
  });

  it("detects disagreements across sourceAccount, recipient, token, and amount bindings", async () => {
    const transferId = await seedOutbound();
    await writeAttestation(db, {
      transferId,
      route: RouteKind.AxelarIts,
      status: "attested",
      railStatus: "executed/received",
      railReference: "0xaxelar-msg-42",
      attestedAt: new Date("2026-10-20T01:01:00Z"),
      checkedAt: new Date("2026-10-20T01:02:00Z"),
      checkFailures: 0,
      lastError: null,
    });
    await writeInbound(
      db,
      {
        chainKey: "sepolia",
        block: 9_500_010n,
        txHash: DEST_TX,
        logIndex: 5,
        observedAt: new Date("2026-10-20T01:01:30Z"),
      },
      {
        route: RouteKind.AxelarIts,
        sourceChain: "stellar-testnet",
        sourceNonce: 42n,
        railMessageId: COMMAND_ID,
        recipient: EVM_RECIPIENT,
        token: EVM_ITS_TOKEN,
        amount: NET_U256,
        delivered: true,
        claimId: null,
      },
    );

    // 1. Source account mismatch in receipt proof
    const wrongSenderReport = await reconcileItsTransfer(
      db,
      { transferId },
      { receiptProof: makeReceiptProof(buildReceiptLogs({ sender: ALT_STELLAR_SENDER })) },
    );
    expect(wrongSenderReport.verdict).toBe("binding_mismatch");
    expect(wrongSenderReport.payoutVerified).toBe(false);
    expect(wrongSenderReport.bindings.sourceAccount.status).toBe("mismatch");

    // 2. Token binding mismatch against expected ITS token
    const wrongTokenReport = await reconcileItsTransfer(
      db,
      { transferId },
      { expectedDestinationToken: WRONG_EVM_TOKEN },
    );
    expect(wrongTokenReport.verdict).toBe("binding_mismatch");
    expect(wrongTokenReport.bindings.token.status).toBe("mismatch");

    // 3. Recipient mismatch in inbound_delivery
    await writeInbound(
      db,
      {
        chainKey: "sepolia",
        block: 9_500_010n,
        txHash: DEST_TX,
        logIndex: 5,
        observedAt: new Date("2026-10-20T01:01:30Z"),
      },
      {
        route: RouteKind.AxelarIts,
        sourceChain: "stellar-testnet",
        sourceNonce: 42n,
        railMessageId: COMMAND_ID,
        recipient: WRONG_EVM_RECIPIENT,
        token: EVM_ITS_TOKEN,
        amount: NET_U256,
        delivered: true,
        claimId: null,
      },
    );
    const wrongRecipientReport = await reconcileItsTransfer(db, { transferId });
    expect(wrongRecipientReport.verdict).toBe("binding_mismatch");
    expect(wrongRecipientReport.bindings.recipient.status).toBe("mismatch");

    // 4. Amount mismatch (1 wei difference)
    await writeInbound(
      db,
      {
        chainKey: "sepolia",
        block: 9_500_010n,
        txHash: DEST_TX,
        logIndex: 5,
        observedAt: new Date("2026-10-20T01:01:30Z"),
      },
      {
        route: RouteKind.AxelarIts,
        sourceChain: "stellar-testnet",
        sourceNonce: 42n,
        railMessageId: COMMAND_ID,
        recipient: EVM_RECIPIENT,
        token: EVM_ITS_TOKEN,
        amount: NET_U256 - 1n,
        delivered: true,
        claimId: null,
      },
    );
    const wrongAmountReport = await reconcileItsTransfer(db, { transferId });
    expect(wrongAmountReport.verdict).toBe("binding_mismatch");
    expect(wrongAmountReport.bindings.amount.status).toBe("mismatch");
  });

  it("enforces read-only SQL, rejects top-up or fabrication CLI flags, and scrubs credentials", async () => {
    const readOnly = wrapReadOnlyQueryable(db);
    await expect(
      readOnly.query("DELETE FROM rail_attestation WHERE transfer_id = 1"),
    ).rejects.toBeInstanceOf(ReadOnlyViolationError);
    await expect(
      readOnly.query("UPDATE rail_attestation SET rail_reference = 'fake'"),
    ).rejects.toBeInstanceOf(ReadOnlyViolationError);

    for (const forbidden of ["--top-up", "--pay-gas", "--fabricate-reference", "--write"]) {
      const cliResult = await executeItsReconcileCommand(["--transfer-id", "1", forbidden], { db });
      expect(cliResult.exitCode).toBe(64);
    }

    const parsed = parseItsReconcileCliArgs([
      "--origin-chain",
      "stellar-testnet",
      "--nonce",
      "42",
      "--expected-destination-token",
      EVM_ITS_TOKEN,
    ]);
    expect(parsed.selector).toEqual({ originChain: "stellar-testnet", nonce: 42n });

    const transferId = await seedOutbound();
    const dynamicSeed = `S${"A".repeat(55)}`;
    await writeAttestation(db, {
      transferId,
      route: RouteKind.AxelarIts,
      status: "pending",
      railStatus: "called",
      railReference: "0xaxelar-msg-42",
      attestedAt: null,
      checkedAt: new Date("2026-10-20T01:02:00Z"),
      checkFailures: 1,
      lastError: `rpc https://ops:supersecret@rpc.example.org?apiKey=mykey123 Bearer tok999 ${dynamicSeed}`,
    });

    const report = await reconcileItsTransfer(db, { transferId });
    expect(report.provider.lastError).not.toContain("supersecret");
    expect(report.provider.lastError).not.toContain("mykey123");
    expect(report.provider.lastError).not.toContain("tok999");
    expect(report.provider.lastError).not.toContain(dynamicSeed);
    expect(report.provider.lastError).toContain("[REDACTED]");
  });
});
