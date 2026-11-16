import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { StrKey } from "@stellar/stellar-sdk";
import { RouteKind, toHex } from "@hyperion/protocol";
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, hexToBytes, keccak256, type Hex } from "viem";
import { loadConfig, type AppConfig } from "../../src/config/config.js";
import type { QueryResultRows, Queryable, Transactional } from "../../src/db/pool.js";
import { bigintOf } from "../../src/db/rows.js";
import { writeAttestation, writeInbound, writeOutbound } from "../../src/chains/writers.js";
import type { DeliveryLog } from "../../src/rails/axelar/events.js";
import {
  getCctpRetentionPolicy,
  pruneCctpProofRecords,
  reconstructCctpProofAudit,
  verifyCctpDelivery,
  type CctpEvmClient,
} from "../../src/rails/cctp/delivery.js";
import {
  CCTP_RECEIPT_ABI,
  matchingCctpPayment,
  verifiedCctpMessage,
  type ExpectedCctpTransfer,
} from "../../src/rails/cctp/events.js";
import { reportFor } from "../../src/rails/cctp/iris.js";
import type { PendingTransfer } from "../../src/rails/types.js";
import { completeEnv, readFixture } from "../helpers.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

const expected: ExpectedCctpTransfer = {
  sourceToken: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  sourceAdapter: "CARH6IA4TA5QAJNQG4B4I7N4336JEBS3GYLPZSEBUCWSNYTDRC7L3AHT",
  sourceMessenger: "CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP",
  destinationDomain: 0,
  destinationMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
  transmitter: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
  token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  recipient: "0x1111111111111111111111111111111111111111",
  sourceAmount: 997000000n,
};
const nonce: Hex = `0x${"ab".repeat(32)}`;
const word = (address: string) => hexToBytes(`0x${address.slice(2).padStart(64, "0")}`);

function buildMessage(base: ExpectedCctpTransfer = expected, msgNonce: Hex = nonce): Hex {
  const raw = new Uint8Array(148 + 228);
  const view = new DataView(raw.buffer);
  view.setUint32(0, 1);
  view.setUint32(4, 27);
  view.setUint32(8, base.destinationDomain);
  raw.set(hexToBytes(msgNonce), 12);
  raw.set(StrKey.decodeContract(base.sourceMessenger), 44);
  raw.set(word(base.destinationMessenger), 76);
  view.setUint32(140, 2000);
  view.setUint32(144, 2000);
  view.setUint32(148, 1);
  raw.set(StrKey.decodeContract(base.sourceToken), 152);
  raw.set(word(base.recipient), 184);
  raw.set(word(`0x${(base.sourceAmount / 10n).toString(16)}`), 216);
  raw.set(StrKey.decodeContract(base.sourceAdapter), 248);
  raw.set(word(`0x${500000n.toString(16)}`), 280);
  raw.set(word(`0x${100000n.toString(16)}`), 312);
  return toHex(raw);
}

const raw = buildMessage();
const verified = verifiedCctpMessage(raw, expected);
if (!verified) throw new Error("Invalid test message.");

function buildReceiptLogs(
  msgRaw: Hex,
  target: ExpectedCctpTransfer = expected,
): readonly DeliveryLog[] {
  const parsed = verifiedCctpMessage(msgRaw, target);
  if (!parsed) throw new Error("Invalid test message for receipt.");
  const receivedLog: DeliveryLog = {
    address: target.transmitter as Hex,
    topics: encodeEventTopics({
      abi: CCTP_RECEIPT_ABI,
      eventName: "MessageReceived",
      args: {
        caller: target.recipient as Hex,
        nonce: parsed.message.nonce,
        finalityThresholdExecuted: parsed.message.finalityThresholdExecuted,
      },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters(
      [{ type: "uint32" }, { type: "bytes32" }, { type: "bytes" }],
      [27, parsed.message.sender, parsed.body],
    ),
    logIndex: 4,
  };
  const paidLog: DeliveryLog = {
    address: target.token as Hex,
    topics: encodeEventTopics({
      abi: CCTP_RECEIPT_ABI,
      eventName: "Transfer",
      args: { from: `0x${"0".repeat(40)}`, to: target.recipient as Hex },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: "uint256" }], [parsed.amount]),
    logIndex: 3,
  };
  return [paidLog, receivedLog];
}

const [paid, received] = buildReceiptLogs(raw) as [DeliveryLog, DeliveryLog];

async function createTestDb(): Promise<{ db: Transactional; close: () => Promise<void> }> {
  const pg = new PGlite();
  for (const file of [
    "1790900000000_initial-schema.sql",
    "1791000000000_cursor-block-hash.sql",
    "1791100000000_cursor-autovacuum-tuning.sql",
    "1791200000000_cctp-proof-retention.sql",
  ]) {
    const upSql = readFileSync(join(MIGRATIONS_DIR, file), "utf8").split("-- Down Migration")[0]!;
    await pg.exec(upSql);
  }
  const queryable: Queryable = {
    query: async (sql: string, params?: readonly unknown[]): Promise<QueryResultRows> => {
      const normalizedParams = params?.map((item) =>
        typeof item === "bigint" ? item.toString() : item,
      );
      const res = await pg.query<Record<string, unknown>>(sql, normalizedParams);
      const int8Cols = res.fields.filter((f) => f.dataTypeID === 20).map((f) => f.name);
      const rows = res.rows.map((rawRow) => {
        const copy: Record<string, unknown> = { ...rawRow };
        for (const col of int8Cols) {
          const val = copy[col];
          if (typeof val === "number" || typeof val === "bigint") {
            copy[col] = String(val);
          }
        }
        return copy;
      });
      return { rows, rowCount: res.affectedRows ?? rows.length };
    },
  };
  const db: Transactional = {
    query: (sql, params) => queryable.query(sql, params),
    transaction: async <T>(fn: (tx: Queryable) => Promise<T>): Promise<T> => {
      await pg.exec("BEGIN");
      try {
        const out = await fn(queryable);
        await pg.exec("COMMIT");
        return out;
      } catch (err) {
        await pg.exec("ROLLBACK");
        throw err;
      }
    },
  };
  return {
    db,
    close: async () => {
      await pg.close();
    },
  };
}

function loadStellarOnlyConfig(
  envOverrides: Readonly<Record<string, string | undefined>> = {},
): AppConfig {
  const parsed = JSON.parse(readFixture("deployments-testnet.json")) as {
    schemaVersion: number;
    generatedAt: string;
    networks: Record<string, unknown>;
  };
  const rawJson = JSON.stringify({
    schemaVersion: parsed.schemaVersion,
    generatedAt: parsed.generatedAt,
    networks: { "stellar-testnet": parsed.networks["stellar-testnet"] },
  });
  return loadConfig({
    env: completeEnv({ KEEPER_ENABLED: "false", ...envOverrides }),
    readFile: () => rawJson,
  });
}

describe("CCTP forwarded destination proof", () => {
  it("requires the exact attested message and an actual native-USDC mint after fees", () => {
    expect(verified.amount).toBe(99600000n);
    expect(matchingCctpPayment([paid, received], raw, expected)).toBe(paid);
    expect(matchingCctpPayment([received], raw, expected)).toBeNull();
    expect(matchingCctpPayment([paid], raw, expected)).toBeNull();
  });
  it.each(["sourceToken", "sourceAdapter", "sourceMessenger"] as const)(
    "binds the %s to the indexed source deployment",
    (field) => {
      const replacement = field === "sourceToken" ? expected.sourceAdapter : expected.sourceToken;
      expect(verifiedCctpMessage(raw, { ...expected, [field]: replacement })).toBeNull();
    },
  );
  it.each(["destinationMessenger", "recipient"] as const)("refuses a different %s", (field) => {
    expect(verifiedCctpMessage(raw, { ...expected, [field]: expected.token })).toBeNull();
  });
  it("refuses a different domain or source amount", () => {
    expect(verifiedCctpMessage(raw, { ...expected, destinationDomain: 6 })).toBeNull();
    expect(
      verifiedCctpMessage(raw, { ...expected, sourceAmount: expected.sourceAmount + 10n }),
    ).toBeNull();
  });
  it.each(["transmitter", "token"] as const)(
    "does not trust a log from another %s contract",
    (field) => {
      expect(
        matchingCctpPayment([paid, received], raw, { ...expected, [field]: expected.recipient }),
      ).toBeNull();
    },
  );
  it("refuses an ordinary transfer, incorrect payout and a different nonce", () => {
    const ordinary = {
      ...paid,
      topics: encodeEventTopics({
        abi: CCTP_RECEIPT_ABI,
        eventName: "Transfer",
        args: { from: expected.transmitter as Hex, to: expected.recipient as Hex },
      }) as [Hex, ...Hex[]],
    };
    expect(matchingCctpPayment([ordinary, received], raw, expected)).toBeNull();
    expect(
      matchingCctpPayment(
        [
          { ...paid, data: encodeAbiParameters([{ type: "uint256" }], [verified.amount + 1n]) },
          received,
        ],
        raw,
        expected,
      ),
    ).toBeNull();
    const changed = hexToBytes(raw);
    changed[12] = 1;
    expect(matchingCctpPayment([paid, received], toHex(changed), expected)).toBeNull();
  });
  it("refuses excessive fees and insufficient finality", () => {
    const changed = hexToBytes(raw);
    changed.set(word(`0x${600000n.toString(16)}`), 312);
    expect(verifiedCctpMessage(toHex(changed), expected)).toBeNull();
    const slow = hexToBytes(raw);
    new DataView(slow.buffer).setUint32(144, 1000);
    expect(verifiedCctpMessage(toHex(slow), expected)).toBeNull();
  });
  it("treats Circle's forward hash only as a candidate, never as delivered", () => {
    const txHash = `0x${"aa".repeat(32)}`;
    expect(reportFor({ status: "complete", forwardTxHash: txHash }).forwardTxHash).toBe(txHash);
    expect(reportFor({ status: "complete", forwardTxHash: txHash }).status).toBe("attested");
    expect(
      reportFor({ status: "complete", forwardTxHash: "invalid" }).forwardTxHash,
    ).toBeUndefined();
  });
});

describe("CCTP configurable proof-retention policy", () => {
  it("exposes retention bounds in configuration and migration defaults", async () => {
    const defaultCfg = loadStellarOnlyConfig();
    expect(defaultCfg.rails.cctpRetention).toEqual({
      rawProofRetentionDays: 90,
      unconfirmedProofRetentionDays: 30,
    });

    const customCfg = loadStellarOnlyConfig({
      CCTP_RAW_PROOF_RETENTION_DAYS: "14",
      CCTP_UNCONFIRMED_PROOF_RETENTION_DAYS: "7",
    });
    expect(customCfg.rails.cctpRetention).toEqual({
      rawProofRetentionDays: 14,
      unconfirmedProofRetentionDays: 7,
    });

    const { db, close } = await createTestDb();
    try {
      const dbPolicy = await getCctpRetentionPolicy(db);
      expect(dbPolicy.rawProofRetentionDays).toBe(90);
      expect(dbPolicy.unconfirmedProofRetentionDays).toBe(30);
      expect(dbPolicy.preserveConfirmedSummary).toBe(true);
    } finally {
      await close();
    }
  });

  it("never removes the canonical evidence behind a confirmed payout and preserves original verification assumptions after compaction", async () => {
    const config = loadStellarOnlyConfig({
      CCTP_RAW_PROOF_RETENTION_DAYS: "10",
      CCTP_UNCONFIRMED_PROOF_RETENTION_DAYS: "5",
    });
    const stellarNet = config.deployments.networks["stellar-testnet"];
    if (stellarNet?.family !== "stellar") throw new Error("Expected stellar deployment");

    const fixtureExpected: ExpectedCctpTransfer = {
      ...expected,
      sourceToken: stellarNet.tokens.USDC!.sacId,
      sourceAdapter: stellarNet.adapters[RouteKind.Cctp]!,
    };

    const confirmedNonce: Hex = `0x${"c1".repeat(32)}`;
    const confirmedMsg = buildMessage(fixtureExpected, confirmedNonce);
    const forwardHash: Hex = `0x${"d1".repeat(32)}`;
    const blockHash: Hex = `0x${"e1".repeat(32)}`;
    const receiptBlock = 9_700_000n;
    const headBlock = 9_700_012n;

    const expiredNonce: Hex = `0x${"c2".repeat(32)}`;
    const expiredMsg = buildMessage(fixtureExpected, expiredNonce);

    const activePendingNonce: Hex = `0x${"c3".repeat(32)}`;
    const activePendingMsg = buildMessage(fixtureExpected, activePendingNonce);

    const evmClient: CctpEvmClient = {
      getChainId: () => Promise.resolve(11155111),
      getBlockNumber: () => Promise.resolve(headBlock),
      getTransactionReceipt: () =>
        Promise.resolve({
          status: "success",
          blockNumber: receiptBlock,
          blockHash,
          transactionHash: forwardHash,
          logs: buildReceiptLogs(confirmedMsg, fixtureExpected),
        }),
      getBlock: () =>
        Promise.resolve({
          hash: blockHash,
          timestamp: 1_762_000_000n,
        }),
    };

    const { db, close } = await createTestDb();
    try {
      const recorded20DaysAgo = new Date("2026-10-01T00:00:00Z");
      const now = new Date("2026-10-21T00:00:00Z");

      // Insert 3 outbound transfers: #1 confirmed, #2 terminal expired without payout, #3 still pending
      for (const n of [1n, 2n, 3n]) {
        await db.transaction(async (tx) => {
          await writeOutbound(
            tx,
            {
              chainKey: "stellar-testnet",
              block: 5435000n + n,
              txHash: `${String(n)}0`.repeat(32).slice(0, 64),
              logIndex: 0,
              observedAt: recorded20DaysAgo,
            },
            {
              route: RouteKind.Cctp,
              nonce: n,
              sender: stellarNet.admin,
              token: fixtureExpected.sourceToken,
              grossAmount: 1000000000n,
              fee: 3000000n,
              netAmount: fixtureExpected.sourceAmount,
              destinationChain: "sepolia",
              destination: `0x${fixtureExpected.recipient.slice(2).padStart(64, "0")}`,
              railRef: null,
            },
          );
        });
      }

      const { rows: idRows } = await db.query(
        "SELECT nonce, id FROM outbound_transfer ORDER BY nonce ASC",
      );
      const id1 = bigintOf(idRows[0]!, "id");
      const id2 = bigintOf(idRows[1]!, "id");
      const id3 = bigintOf(idRows[2]!, "id");

      const transfer1: PendingTransfer = {
        transferId: id1,
        route: RouteKind.Cctp,
        originChain: "stellar-testnet",
        destinationChain: "sepolia",
        nonce: 1n,
        originTx: "10".repeat(32),
        status: "attested",
        checkFailures: 0,
        delivered: false,
      };
      const verified1 = await verifyCctpDelivery(
        config,
        db,
        transfer1,
        reportFor({
          status: "complete",
          messageBytes: confirmedMsg,
          forwardTxHash: forwardHash,
          attestation: "0xabcdef12",
        }),
        { evmClient, recordedAt: recorded20DaysAgo },
      );
      expect(verified1).not.toBeNull();
      await db.transaction(async (tx) => {
        await writeInbound(tx, verified1!.at, verified1!.row);
      });

      // Transfer #2: candidate message without forwardTxHash, marked expired in rail_attestation
      await verifyCctpDelivery(
        config,
        db,
        {
          transferId: id2,
          route: RouteKind.Cctp,
          originChain: "stellar-testnet",
          destinationChain: "sepolia",
          nonce: 2n,
          originTx: "20".repeat(32),
          status: "expired",
          checkFailures: 0,
          delivered: false,
        },
        reportFor({
          status: "expired",
          messageBytes: expiredMsg,
          attestation: "0xdeadbeef",
        }),
        { recordedAt: recorded20DaysAgo },
      );
      await db.transaction(async (tx) => {
        await writeAttestation(tx, {
          transferId: id2,
          route: RouteKind.Cctp,
          status: "expired",
          railStatus: "expired",
          railReference: "2",
          attestedAt: null,
          checkedAt: recorded20DaysAgo,
          checkFailures: 0,
          lastError: null,
        });
      });

      // Transfer #3: candidate message without forwardTxHash, still pending in rail_attestation
      await verifyCctpDelivery(
        config,
        db,
        {
          transferId: id3,
          route: RouteKind.Cctp,
          originChain: "stellar-testnet",
          destinationChain: "sepolia",
          nonce: 3n,
          originTx: "30".repeat(32),
          status: "pending",
          checkFailures: 0,
          delivered: false,
        },
        reportFor({
          status: "pending_confirmations",
          messageBytes: activePendingMsg,
        }),
        { recordedAt: recorded20DaysAgo },
      );
      await db.transaction(async (tx) => {
        await writeAttestation(tx, {
          transferId: id3,
          route: RouteKind.Cctp,
          status: "pending",
          railStatus: "pending_confirmations",
          railReference: "3",
          attestedAt: null,
          checkedAt: recorded20DaysAgo,
          checkFailures: 0,
          lastError: null,
        });
      });

      const pruneResult = await pruneCctpProofRecords(db, {
        policy: config.rails.cctpRetention,
        now,
      });
      expect(pruneResult.compactedConfirmedCount).toBe(1);
      expect(pruneResult.deletedUnconfirmedCount).toBe(1);
      expect(pruneResult.policy.rawProofRetentionDays).toBe(10);
      expect(pruneResult.policy.unconfirmedProofRetentionDays).toBe(5);

      // Expired terminal candidate #2 was pruned; active pending candidate #3 was preserved!
      expect(await reconstructCctpProofAudit(db, id2)).toHaveLength(0);
      expect(await reconstructCctpProofAudit(db, id3)).toHaveLength(1);

      // Confirmed payout #1 retained full canonical summary + original verification assumptions!
      const reconstructed = await reconstructCctpProofAudit(db, id1);
      expect(reconstructed).toHaveLength(1);
      const audit = reconstructed[0]!;
      expect(audit.confirmedPayout).toBe(true);
      expect(audit.rawPayloadRetained).toBe(false);
      expect(audit.rawPrunedAt?.toISOString()).toBe(now.toISOString());
      expect(audit.messageIdentity).toEqual({
        nonce: confirmedNonce,
        messageHash: keccak256(confirmedMsg),
        bodyHash: verifiedCctpMessage(confirmedMsg, fixtureExpected)!.bodyHash,
        sourceDomain: 27,
        destinationDomain: 0,
        finalityThresholdExecuted: 2000,
      });
      expect(audit.accounting).toEqual({
        sourceAmount: "997000000",
        burnAmount: "99700000",
        feeExecuted: "100000",
        mintAmount: "99600000",
        mintRecipient: expected.recipient.toLowerCase(),
      });
      expect(audit.receiptEvidence).toEqual({
        forwardTxHash: forwardHash,
        receiptTxHash: forwardHash,
        receiptBlockNumber: receiptBlock,
        receiptBlockHash: blockHash,
        messageLogIndex: 4,
        mintLogIndex: 3,
      });
      expect(audit.verificationAssumptions).toEqual({
        sourceToken: fixtureExpected.sourceToken,
        sourceAdapter: fixtureExpected.sourceAdapter,
        sourceMessenger: fixtureExpected.sourceMessenger,
        destinationChain: "sepolia",
        destinationChainId: 11155111,
        destinationDomain: 0,
        destinationMessenger: expected.destinationMessenger.toLowerCase(),
        messageTransmitter: expected.transmitter.toLowerCase(),
        destinationToken: expected.token.toLowerCase(),
        recipient: expected.recipient.toLowerCase(),
        sourceAmount: "997000000",
        confirmationsRequired: 3,
        headBlockAtVerification: headBlock.toString(),
        minFinalityThreshold: 2000,
      });
    } finally {
      await close();
    }
  });
});
