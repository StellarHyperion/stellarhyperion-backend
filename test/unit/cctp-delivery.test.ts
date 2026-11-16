import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { StrKey } from "@stellar/stellar-sdk";
import { RouteKind, toHex } from "@hyperion/protocol";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, hexToBytes, type Hex } from "viem";
import { loadConfig, type AppConfig } from "../../src/config/config.js";
import type { QueryResultRows, Queryable, Transactional } from "../../src/db/pool.js";
import { bigintOf } from "../../src/db/rows.js";
import { writeOutbound } from "../../src/chains/writers.js";
import type { DeliveryLog } from "../../src/rails/axelar/events.js";
import {
  reconcileCctpTransferReport,
  verifyCctpDelivery,
  type CctpEvmClient,
} from "../../src/rails/cctp/delivery.js";
import {
  CCTP_RECEIPT_ABI,
  matchingCctpPayment,
  reconcileCctpCandidates,
  verifiedCctpMessage,
  type ExpectedCctpTransfer,
} from "../../src/rails/cctp/events.js";
import { IrisClient, reportFor } from "../../src/rails/cctp/iris.js";
import { RailPass } from "../../src/rails/pass.js";
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

interface BuildMessageOverrides {
  readonly nonce?: Hex;
  readonly sourceDomain?: number;
  readonly destinationDomain?: number;
  readonly sourceMessenger?: string;
  readonly destinationMessenger?: string;
  readonly sourceToken?: string;
  readonly sourceAdapter?: string;
  readonly recipient?: string;
  readonly sourceAmount?: bigint;
  readonly maxFee?: bigint;
  readonly feeExecuted?: bigint;
  readonly finalityThresholdExecuted?: number;
}

function buildCctpMessage(
  base: ExpectedCctpTransfer = expected,
  overrides: BuildMessageOverrides = {},
): Hex {
  const raw = new Uint8Array(148 + 228);
  const view = new DataView(raw.buffer);
  const msgNonce = overrides.nonce ?? nonce;
  const sourceDomain = overrides.sourceDomain ?? 27;
  const destinationDomain = overrides.destinationDomain ?? base.destinationDomain;
  const sourceMessenger = overrides.sourceMessenger ?? base.sourceMessenger;
  const destinationMessenger = overrides.destinationMessenger ?? base.destinationMessenger;
  const sourceToken = overrides.sourceToken ?? base.sourceToken;
  const sourceAdapter = overrides.sourceAdapter ?? base.sourceAdapter;
  const recipient = overrides.recipient ?? base.recipient;
  const sourceAmount = overrides.sourceAmount ?? base.sourceAmount;
  const maxFee = overrides.maxFee ?? 500000n;
  const feeExecuted = overrides.feeExecuted ?? 100000n;
  const finality = overrides.finalityThresholdExecuted ?? 2000;

  view.setUint32(0, 1);
  view.setUint32(4, sourceDomain);
  view.setUint32(8, destinationDomain);
  raw.set(hexToBytes(msgNonce), 12);
  raw.set(StrKey.decodeContract(sourceMessenger), 44);
  raw.set(word(destinationMessenger), 76);
  view.setUint32(140, 2000);
  view.setUint32(144, finality);
  view.setUint32(148, 1);
  raw.set(StrKey.decodeContract(sourceToken), 152);
  raw.set(word(recipient), 184);
  raw.set(word(`0x${(sourceAmount / 10n).toString(16)}`), 216);
  raw.set(StrKey.decodeContract(sourceAdapter), 248);
  raw.set(word(`0x${maxFee.toString(16)}`), 280);
  raw.set(word(`0x${feeExecuted.toString(16)}`), 312);
  return toHex(raw);
}

const raw = buildCctpMessage();
const verified = verifiedCctpMessage(raw, expected);
if (!verified) throw new Error("Invalid test message.");

function buildReceiptLogs(
  msgRaw: Hex,
  targetExpected: ExpectedCctpTransfer = expected,
): readonly DeliveryLog[] {
  const parsed = verifiedCctpMessage(msgRaw, targetExpected);
  if (!parsed) throw new Error("Expected valid CCTP message for receipt log fixture.");
  const receivedLog: DeliveryLog = {
    address: targetExpected.transmitter as Hex,
    topics: encodeEventTopics({
      abi: CCTP_RECEIPT_ABI,
      eventName: "MessageReceived",
      args: {
        caller: targetExpected.recipient as Hex,
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
    address: targetExpected.token as Hex,
    topics: encodeEventTopics({
      abi: CCTP_RECEIPT_ABI,
      eventName: "Transfer",
      args: { from: `0x${"0".repeat(40)}`, to: targetExpected.recipient as Hex },
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

function loadStellarOnlyTestConfig(): AppConfig {
  const parsedFixture = JSON.parse(readFixture("deployments-testnet.json")) as {
    schemaVersion: number;
    generatedAt: string;
    networks: Record<string, unknown>;
  };
  const stellarOnly = JSON.stringify({
    schemaVersion: parsedFixture.schemaVersion,
    generatedAt: parsedFixture.generatedAt,
    networks: {
      "stellar-testnet": parsedFixture.networks["stellar-testnet"],
    },
  });
  return loadConfig({
    env: completeEnv({ KEEPER_ENABLED: "false" }),
    readFile: () => stellarOnly,
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

describe("CCTP multi-message source transaction reconciliation", () => {
  const otherRecipient = "0x2222222222222222222222222222222222222222";
  const nonceA: Hex = `0x${"11".repeat(32)}`;
  const nonceB: Hex = `0x${"22".repeat(32)}`;
  const forwardHashA: Hex = `0x${"aa".repeat(32)}`;
  const forwardHashB: Hex = `0x${"bb".repeat(32)}`;

  it("matches the unique burn matching complete source intent and ignores unrelated burns", () => {
    const unrelatedRecipientMsg = buildCctpMessage(expected, {
      nonce: nonceA,
      recipient: otherRecipient,
    });
    const unrelatedAmountMsg = buildCctpMessage(expected, {
      nonce: `0x${"33".repeat(32)}`,
      sourceAmount: expected.sourceAmount + 50_000_000n,
    });
    const unrelatedDomainMsg = buildCctpMessage(expected, {
      nonce: `0x${"44".repeat(32)}`,
      destinationDomain: 6,
    });
    const matchingMsg = buildCctpMessage(expected, {
      nonce: nonceB,
    });

    const reconciled = reconcileCctpCandidates(
      [
        reportFor({
          status: "complete",
          eventNonce: "101",
          messageBytes: unrelatedRecipientMsg,
          forwardTxHash: forwardHashA,
        }),
        reportFor({
          status: "complete",
          eventNonce: "102",
          messageBytes: unrelatedAmountMsg,
          forwardTxHash: `0x${"cc".repeat(32)}`,
        }),
        reportFor({
          status: "complete",
          eventNonce: "103",
          messageBytes: unrelatedDomainMsg,
        }),
        reportFor({
          status: "complete",
          eventNonce: "104",
          messageBytes: matchingMsg,
          forwardTxHash: forwardHashB,
        }),
      ],
      expected,
    );

    expect(reconciled.kind).toBe("matched");
    if (reconciled.kind !== "matched") throw new Error("Expected matched candidate");
    expect(reconciled.verified.message.nonce).toBe(nonceB);
    expect(reconciled.candidate.forwardTxHash).toBe(forwardHashB);
    expect(reconciled.candidate.reference).toBe("104");
  });

  it("collapses byte-identical duplicate candidate messages while keeping conflicting payloads ambiguous", () => {
    const duplicateMsg = buildCctpMessage(expected, { nonce: nonceA });
    const deduped = reconcileCctpCandidates(
      [
        reportFor({
          status: "pending_confirmations",
          eventNonce: "77",
          messageBytes: duplicateMsg,
        }),
        reportFor({
          status: "complete",
          eventNonce: "77",
          messageBytes: duplicateMsg.toUpperCase().replace("0X", "0x"),
          forwardTxHash: forwardHashA,
          attestation: "0xdeadbeef",
        }),
      ],
      expected,
    );
    expect(deduped.kind).toBe("matched");
    if (deduped.kind !== "matched") throw new Error("Expected collapsed duplicate match");
    expect(deduped.candidate.status).toBe("attested");
    expect(deduped.candidate.forwardTxHash).toBe(forwardHashA);
    expect(deduped.candidate.attestationSignature).toBe("0xdeadbeef");

    // Same nonce, both matching intent, but different feeExecuted bytes -> conflicting duplicate!
    const conflictingSameNonce = buildCctpMessage(expected, {
      nonce: nonceA,
      feeExecuted: 50000n,
    });
    const conflicted = reconcileCctpCandidates(
      [
        reportFor({ status: "complete", messageBytes: duplicateMsg, forwardTxHash: forwardHashA }),
        reportFor({
          status: "complete",
          messageBytes: conflictingSameNonce,
          forwardTxHash: forwardHashB,
        }),
      ],
      expected,
    );
    expect(conflicted).toEqual({
      kind: "ambiguous",
      nonces: [nonceA],
    });
  });

  it("leaves two distinct burns with identical transfer intent ambiguous unless disambiguated by railRef", () => {
    const firstMatching = buildCctpMessage(expected, { nonce: nonceA });
    const secondMatching = buildCctpMessage(expected, { nonce: nonceB });
    const candidates = [
      reportFor({
        status: "complete",
        eventNonce: "201",
        messageBytes: firstMatching,
        forwardTxHash: forwardHashA,
      }),
      reportFor({
        status: "complete",
        eventNonce: "202",
        messageBytes: secondMatching,
        forwardTxHash: forwardHashB,
      }),
    ];

    const ambiguous = reconcileCctpCandidates(candidates, {
      ...expected,
      railRef: `0x${"0".repeat(64)}`,
    });
    expect(ambiguous).toEqual({
      kind: "ambiguous",
      nonces: [nonceA, nonceB],
    });

    const disambiguated = reconcileCctpCandidates(candidates, {
      ...expected,
      railRef: nonceB,
    });
    expect(disambiguated.kind).toBe("matched");
    if (disambiguated.kind !== "matched") throw new Error("Expected railRef disambiguation");
    expect(disambiguated.verified.message.nonce).toBe(nonceB);
    expect(disambiguated.candidate.forwardTxHash).toBe(forwardHashB);
  });

  it("preserves all distinct Iris candidates from one source tx and verifies only unambiguous matches end-to-end", async () => {
    const config = loadStellarOnlyTestConfig();
    const stellarNet = config.deployments.networks["stellar-testnet"];
    if (stellarNet?.family !== "stellar") {
      throw new Error("Expected stellar-testnet fixture deployment");
    }
    const fixtureExpected: ExpectedCctpTransfer = {
      ...expected,
      sourceToken: stellarNet.tokens.USDC!.sacId,
      sourceAdapter: stellarNet.adapters[RouteKind.Cctp]!,
    };

    const unrelatedBurn = buildCctpMessage(fixtureExpected, {
      nonce: nonceA,
      recipient: otherRecipient,
    });
    const targetBurn = buildCctpMessage(fixtureExpected, {
      nonce: nonceB,
    });
    const duplicateTargetBurn = buildCctpMessage(fixtureExpected, {
      nonce: nonceB,
    });

    const originTx = "d2d112fdef5b381534eb10e92806bd0025f307ffb0b2da0d0d3194d3f7892ca2";
    const iris = new IrisClient("testnet", {
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              messages: [
                {
                  status: "complete",
                  eventNonce: "9001",
                  messageBytes: unrelatedBurn,
                  forwardTxHash: forwardHashA,
                },
                {
                  status: "pending_confirmations",
                  eventNonce: "9002",
                  messageBytes: targetBurn,
                },
                {
                  status: "complete",
                  eventNonce: "9002",
                  messageBytes: duplicateTargetBurn,
                  forwardTxHash: forwardHashB,
                  attestation: "0x1234",
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
    });

    const { db, close } = await createTestDb();
    try {
      await db.transaction(async (tx) => {
        await writeOutbound(
          tx,
          {
            chainKey: "stellar-testnet",
            block: 5433900n,
            txHash: originTx,
            logIndex: 0,
            observedAt: new Date("2026-10-29T10:00:00Z"),
          },
          {
            nonce: 42n,
            route: RouteKind.Cctp,
            sender: stellarNet.admin,
            token: fixtureExpected.sourceToken,
            grossAmount: 1000000000n,
            fee: 3000000n,
            netAmount: fixtureExpected.sourceAmount,
            destinationChain: "sepolia",
            destination: `0x${fixtureExpected.recipient.slice(2).padStart(64, "0")}`,
            railRef: `0x${"0".repeat(64)}`,
          },
        );
      });
      const { rows: insertedRows } = await db.query(
        "SELECT id FROM outbound_transfer WHERE origin_chain = $1 AND nonce = $2",
        ["stellar-testnet", "42"],
      );
      const transferId = bigintOf(insertedRows[0]!, "id");

      const pending: PendingTransfer = {
        transferId,
        route: RouteKind.Cctp,
        originChain: "stellar-testnet",
        destinationChain: "sepolia",
        nonce: 42n,
        originTx,
        status: null,
        checkFailures: 0,
        delivered: false,
      };

      const lookup = await iris.look(pending);
      expect(lookup.kind).toBe("found");
      if (lookup.kind !== "found") throw new Error("Expected found lookup");
      // Exact duplicate collapsed -> 2 distinct candidates remain, reference is withheld until reconciled
      expect(lookup.report.candidates).toHaveLength(2);
      expect(lookup.report.reference).toBeNull();
      expect(lookup.report.railStatus).toBe("multi_candidate(2)");

      const reconciledReport = await reconcileCctpTransferReport(
        config,
        db,
        pending,
        lookup.report,
      );
      expect(reconciledReport?.reconciliation.kind).toBe("matched");
      expect(reconciledReport?.report.reference).toBe("9002");
      expect(reconciledReport?.report.forwardTxHash).toBe(forwardHashB);

      const blockHash: Hex = `0x${"ef".repeat(32)}`;
      const evmClient: CctpEvmClient = {
        getChainId: () => Promise.resolve(11155111),
        getBlockNumber: () => Promise.resolve(9500100n),
        getTransactionReceipt: ({ hash }) => {
          expect(hash).toBe(forwardHashB);
          return Promise.resolve({
            status: "success",
            blockNumber: 9500000n,
            blockHash,
            transactionHash: forwardHashB,
            logs: buildReceiptLogs(targetBurn, fixtureExpected),
          });
        },
        getBlock: () =>
          Promise.resolve({
            hash: blockHash,
            timestamp: 1761732224n,
          }),
      };

      const verifiedDelivery = await verifyCctpDelivery(config, db, pending, lookup.report, {
        evmClient,
      });
      expect(verifiedDelivery).not.toBeNull();
      expect(verifiedDelivery?.row.railMessageId).toBe(nonceB);
      expect(verifiedDelivery?.row.amount).toBe(99600000n);
      expect(verifiedDelivery?.at.txHash).toBe(forwardHashB);

      // Ambiguous multi-burn source tx (two distinct nonces with identical burn intent) stays unverified
      const twinBurn = buildCctpMessage(fixtureExpected, {
        nonce: `0x${"55".repeat(32)}`,
      });
      const ambiguousIris = new IrisClient("testnet", {
        fetch: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                messages: [
                  {
                    status: "complete",
                    eventNonce: "9002",
                    messageBytes: targetBurn,
                    forwardTxHash: forwardHashB,
                  },
                  {
                    status: "complete",
                    eventNonce: "9003",
                    messageBytes: twinBurn,
                    forwardTxHash: forwardHashA,
                  },
                ],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          ),
      });

      const ambiguousLookup = await ambiguousIris.look(pending);
      if (ambiguousLookup.kind !== "found") throw new Error("Expected found lookup");
      const ambiguousVerified = await verifyCctpDelivery(
        config,
        db,
        pending,
        ambiguousLookup.report,
        { evmClient },
      );
      expect(ambiguousVerified).toBeNull();

      const pass = new RailPass({
        route: RouteKind.Cctp,
        client: ambiguousIris,
        db,
        logger: pino({ level: "silent" }),
        batchSize: 10,
        recheckAfterMs: 0,
        maxCheckFailures: 5,
        config,
      });
      await pass.tick(new AbortController().signal);

      const { rows: attRows } = await db.query(
        "SELECT status, rail_status, rail_reference FROM rail_attestation WHERE transfer_id = $1",
        [String(transferId)],
      );
      expect(attRows).toEqual([
        {
          status: "pending",
          rail_status: "ambiguous_candidates(2)",
          rail_reference: null,
        },
      ]);
      const { rows: inboundRows } = await db.query("SELECT id FROM inbound_delivery");
      expect(inboundRows).toHaveLength(0);
    } finally {
      await close();
    }
  });
});
