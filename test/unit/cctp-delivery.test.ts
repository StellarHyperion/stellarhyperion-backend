import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { StrKey } from "@stellar/stellar-sdk";
import { RouteKind, displayNonce, parseCctpMessage, toHex } from "@hyperion/protocol";
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, hexToBytes, keccak256, type Hex } from "viem";
import { loadConfig, type AppConfig } from "../../src/config/config.js";
import type { QueryResultRows, Queryable, Transactional } from "../../src/db/pool.js";
import { bigintOf } from "../../src/db/rows.js";
import { writeInbound, writeOutbound } from "../../src/chains/writers.js";
import type { DeliveryLog } from "../../src/rails/axelar/events.js";
import {
  listCctpProviderMessagesByOriginTx,
  verifyCctpDelivery,
  type CctpEvmClient,
} from "../../src/rails/cctp/delivery.js";
import {
  CCTP_RECEIPT_ABI,
  deriveCctpMessageIdentity,
  matchingCctpPayment,
  verifiedCctpMessage,
  type ExpectedCctpTransfer,
} from "../../src/rails/cctp/events.js";
import {
  IrisClient,
  deduplicateReportsByFullIdentity,
  reportFor,
} from "../../src/rails/cctp/iris.js";
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

function buildMessage(
  base: ExpectedCctpTransfer = expected,
  overrides: {
    readonly nonce?: Hex;
    readonly recipient?: string;
    readonly sourceAmount?: bigint;
  } = {},
): Hex {
  const raw = new Uint8Array(148 + 228);
  const view = new DataView(raw.buffer);
  const msgNonce = overrides.nonce ?? nonce;
  const recipient = overrides.recipient ?? base.recipient;
  const sourceAmount = overrides.sourceAmount ?? base.sourceAmount;

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
  raw.set(word(recipient), 184);
  raw.set(word(`0x${(sourceAmount / 10n).toString(16)}`), 216);
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
    "1791200000000_cctp-message-identity.sql",
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

function loadStellarOnlyConfig(): AppConfig {
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
    env: completeEnv({ KEEPER_ENABLED: "false" }),
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

describe("CCTP full-message identity deduplication", () => {
  // Identical bottom 8 bytes (`000000000000002a` -> displayNonce === 42n), distinct upper 24 bytes!
  const fullNonce1: Hex = `0x${"11".repeat(24)}000000000000002a`;
  const fullNonce2: Hex = `0x${"22".repeat(24)}000000000000002a`;
  const otherRecipient = "0x9999999999999999999999999999999999999999";

  it("keeps two messages with the exact same displayed 64-bit nonce distinct in memory and in provider records", () => {
    const msg1 = buildMessage(expected, { nonce: fullNonce1, recipient: otherRecipient });
    const msg2 = buildMessage(expected, { nonce: fullNonce2 });

    expect(displayNonce(parseCctpMessage(msg1))).toBe(42n);
    expect(displayNonce(parseCctpMessage(msg2))).toBe(42n);

    const id1 = deriveCctpMessageIdentity(msg1);
    const id2 = deriveCctpMessageIdentity(msg2);
    expect(id1?.displayedNonce).toBe("42");
    expect(id2?.displayedNonce).toBe("42");
    expect(id1?.fullNonce).toBe(fullNonce1);
    expect(id2?.fullNonce).toBe(fullNonce2);
    expect(id1?.messageDigest).toBe(keccak256(msg1));
    expect(id2?.messageDigest).toBe(keccak256(msg2));
    expect(id1?.messageDigest).not.toBe(id2?.messageDigest);

    const deduped = deduplicateReportsByFullIdentity([
      reportFor({ status: "complete", eventNonce: "42", messageBytes: msg1 }),
      reportFor({ status: "complete", eventNonce: "42", messageBytes: msg2 }),
    ]);
    expect(deduped).toHaveLength(2);
  });

  it("deduplicates exact repeated messages without duplicating delivery records while requiring all burn bindings for transfer association", async () => {
    const config = loadStellarOnlyConfig();
    const stellarNet = config.deployments.networks["stellar-testnet"];
    if (stellarNet?.family !== "stellar") throw new Error("Expected stellar deployment");

    const fixtureExpected: ExpectedCctpTransfer = {
      ...expected,
      sourceToken: stellarNet.tokens.USDC!.sacId,
      sourceAdapter: stellarNet.adapters[RouteKind.Cctp]!,
    };

    // Unrelated message shares displayedNonce = 42 ("42") with target message, but wrong recipient!
    const collidingDisplayMsg = buildMessage(fixtureExpected, {
      nonce: fullNonce1,
      recipient: otherRecipient,
    });
    const targetMsg = buildMessage(fixtureExpected, {
      nonce: fullNonce2,
    });

    const originTx = "44".repeat(32);
    const forwardHash1: Hex = `0x${"a1".repeat(32)}`;
    const forwardHash2: Hex = `0x${"a2".repeat(32)}`;
    const blockHash: Hex = `0x${"b2".repeat(32)}`;
    const receiptBlock = 9_900_000n;

    const iris = new IrisClient("testnet", {
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              messages: [
                {
                  status: "complete",
                  eventNonce: "42",
                  messageBytes: collidingDisplayMsg,
                  forwardTxHash: forwardHash1,
                },
                {
                  status: "pending_confirmations",
                  eventNonce: "42",
                  messageBytes: targetMsg,
                },
                // Exact repeated message (same full 32-byte nonce + full message digest)
                {
                  status: "complete",
                  eventNonce: "42",
                  messageBytes: targetMsg,
                  forwardTxHash: forwardHash2,
                  attestation: "0xdeadbeef",
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
    });

    const evmClient: CctpEvmClient = {
      getChainId: () => Promise.resolve(11155111),
      getBlockNumber: () => Promise.resolve(receiptBlock + 10n),
      getTransactionReceipt: ({ hash }) => {
        expect(hash).toBe(forwardHash2);
        return Promise.resolve({
          status: "success",
          blockNumber: receiptBlock,
          blockHash,
          transactionHash: forwardHash2,
          logs: buildReceiptLogs(targetMsg, fixtureExpected),
        });
      },
      getBlock: () =>
        Promise.resolve({
          hash: blockHash,
          timestamp: 1_762_200_000n,
        }),
    };

    const { db, close } = await createTestDb();
    try {
      await db.transaction(async (tx) => {
        await writeOutbound(
          tx,
          {
            chainKey: "stellar-testnet",
            block: 5437000n,
            txHash: originTx,
            logIndex: 0,
            observedAt: new Date("2026-10-29T10:10:00Z"),
          },
          {
            route: RouteKind.Cctp,
            nonce: 77n,
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
      const { rows } = await db.query(
        "SELECT id FROM outbound_transfer WHERE origin_chain = $1 AND nonce = $2",
        ["stellar-testnet", "77"],
      );
      const transferId = bigintOf(rows[0]!, "id");

      const pending: PendingTransfer = {
        transferId,
        route: RouteKind.Cctp,
        originChain: "stellar-testnet",
        destinationChain: "sepolia",
        nonce: 77n,
        originTx,
        status: null,
        checkFailures: 0,
        delivered: false,
      };

      const lookup = await iris.look(pending);
      expect(lookup.kind).toBe("found");
      if (lookup.kind !== "found") throw new Error("Expected found lookup");
      // 3 Iris entries -> 2 distinct full-identity messages (exact repeat collapsed, same-displayNonce kept separate!)
      expect(lookup.report.candidates).toHaveLength(2);

      // Run verification + inbound write TWICE with repeated exact messages to prove idempotency
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const verifiedDelivery = await verifyCctpDelivery(config, db, pending, lookup.report, {
          evmClient,
        });
        expect(verifiedDelivery).not.toBeNull();
        expect(verifiedDelivery?.row.railMessageId).toBe(fullNonce2);
        await db.transaction(async (tx) => {
          await writeInbound(tx, verifiedDelivery!.at, verifiedDelivery!.row);
        });
      }

      const storedMessages = await listCctpProviderMessagesByOriginTx(db, originTx);
      expect(storedMessages).toHaveLength(2);

      // First message had same displayedNonce "42" ("42") but wrong recipient -> NOT associated with transferId!
      expect(storedMessages[0]?.displayedNonce).toBe("42");
      expect(storedMessages[0]?.fullNonce).toBe(fullNonce1);
      expect(storedMessages[0]?.transferId).toBeNull();

      // Second message matched ALL burn bindings -> associated with transferId and marked delivered!
      expect(storedMessages[1]?.displayedNonce).toBe("42");
      expect(storedMessages[1]?.fullNonce).toBe(fullNonce2);
      expect(storedMessages[1]?.messageDigest).toBe(keccak256(targetMsg));
      expect(storedMessages[1]?.transferId).toBe(transferId);
      expect(storedMessages[1]?.status).toBe("delivered");

      // Repeated exact messages produced only ONE inbound_delivery row bound to full 32-byte nonce!
      const { rows: inboundRows } = await db.query(
        "SELECT rail_message_id, amount FROM inbound_delivery WHERE source_chain = $1 AND source_nonce = $2",
        ["stellar-testnet", "77"],
      );
      expect(inboundRows).toEqual([
        {
          rail_message_id: fullNonce2,
          amount: "99600000",
        },
      ]);
    } finally {
      await close();
    }
  });
});
