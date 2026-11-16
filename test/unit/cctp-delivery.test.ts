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
import { writeOutbound } from "../../src/chains/writers.js";
import {
  CCTP_RECEIPT_ABI,
  matchingCctpPayment,
  verifiedCctpMessage,
  verifyCctpReplacementEquivalence,
  type ExpectedCctpTransfer,
} from "../../src/rails/cctp/events.js";
import {
  listCctpMessageVersions,
  verifyCctpDelivery,
  type CctpEvmClient,
} from "../../src/rails/cctp/delivery.js";
import type { DeliveryLog } from "../../src/rails/axelar/events.js";
import { IrisClient, reportFor } from "../../src/rails/cctp/iris.js";
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
const uint256Word = (val: bigint) => word(`0x${val.toString(16)}`);

function buildMessage(
  base: ExpectedCctpTransfer = expected,
  overrides: {
    readonly messageVersion?: number;
    readonly burnVersion?: number;
    readonly nonce?: Hex;
    readonly recipient?: string;
    readonly burnAmount?: bigint;
    readonly maxFee?: bigint;
    readonly feeExecuted?: bigint;
    readonly expirationBlock?: bigint;
    readonly minFinalityThreshold?: number;
    readonly finalityThresholdExecuted?: number;
    readonly destinationCaller?: string;
    readonly hookBytes?: Uint8Array;
  } = {},
): Hex {
  const hook = overrides.hookBytes ?? new Uint8Array(0);
  const raw = new Uint8Array(148 + 228 + hook.length);
  const view = new DataView(raw.buffer);
  const msgVersion = overrides.messageVersion ?? 1;
  const burnVersion = overrides.burnVersion ?? 1;
  const msgNonce = overrides.nonce ?? nonce;
  const recipient = overrides.recipient ?? base.recipient;
  const burnAmount = overrides.burnAmount ?? base.sourceAmount / 10n;
  const maxFee = overrides.maxFee ?? 500_000n;
  const feeExecuted = overrides.feeExecuted ?? 100_000n;
  const expirationBlock = overrides.expirationBlock ?? 0n;
  const minFinality = overrides.minFinalityThreshold ?? 2000;
  const finalityExecuted = overrides.finalityThresholdExecuted ?? 2000;

  view.setUint32(0, msgVersion);
  view.setUint32(4, 27);
  view.setUint32(8, base.destinationDomain);
  raw.set(hexToBytes(msgNonce), 12);
  raw.set(StrKey.decodeContract(base.sourceMessenger), 44);
  raw.set(word(base.destinationMessenger), 76);
  if (overrides.destinationCaller) {
    raw.set(word(overrides.destinationCaller), 108);
  }
  view.setUint32(140, minFinality);
  view.setUint32(144, finalityExecuted);
  view.setUint32(148, burnVersion);
  raw.set(StrKey.decodeContract(base.sourceToken), 152);
  raw.set(word(recipient), 184);
  raw.set(uint256Word(burnAmount), 216);
  raw.set(StrKey.decodeContract(base.sourceAdapter), 248);
  raw.set(uint256Word(maxFee), 280);
  raw.set(uint256Word(feeExecuted), 312);
  raw.set(uint256Word(expirationBlock), 344);
  if (hook.length > 0) {
    raw.set(hook, 376);
  }
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
    "1791200000000_cctp-message-replacements.sql",
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

describe("CCTP message replacement and attestation versions", () => {
  it("rejects replacements that mutate source burn intent, recipient, amount, or use unsupported replacement semantics", () => {
    const originalFast = buildMessage(expected, {
      minFinalityThreshold: 1000,
      finalityThresholdExecuted: 1000,
      expirationBlock: 55_000n,
      maxFee: 500_000n,
      feeExecuted: 250_000n,
    });

    // Valid finalized replacement preserving identical burn intent & recipient
    const validReplacement = buildMessage(expected, {
      minFinalityThreshold: 2000,
      finalityThresholdExecuted: 2000,
      expirationBlock: 0n,
      maxFee: 500_000n,
      feeExecuted: 80_000n,
    });
    expect(verifyCctpReplacementEquivalence(originalFast, validReplacement, expected)).toEqual({
      ok: true,
      status: "equivalent_replacement",
      reason: null,
    });

    // Silent recipient mutation -> intent_mismatch
    const mutatedRecipient = buildMessage(expected, {
      recipient: "0x9999999999999999999999999999999999999999",
      expirationBlock: 0n,
    });
    expect(verifyCctpReplacementEquivalence(originalFast, mutatedRecipient, expected)).toEqual({
      ok: false,
      status: "intent_mismatch",
      reason: "recipient_mutated",
    });

    // Silent burn amount mutation -> intent_mismatch
    const mutatedAmount = buildMessage(expected, {
      burnAmount: expected.sourceAmount / 10n - 100n,
      expirationBlock: 0n,
    });
    expect(verifyCctpReplacementEquivalence(originalFast, mutatedAmount, expected)).toEqual({
      ok: false,
      status: "intent_mismatch",
      reason: "burn_amount_mutated",
    });

    // Unsupported replacement semantics: version=2, hook payload, nonce change, unauthorized destinationCaller
    const unsupportedVersion = buildMessage(expected, { burnVersion: 2 });
    expect(
      verifyCctpReplacementEquivalence(originalFast, unsupportedVersion, expected).status,
    ).toBe("unsupported_semantics");

    const unsupportedHook = buildMessage(expected, { hookBytes: new Uint8Array([1, 2, 3, 4]) });
    expect(verifyCctpReplacementEquivalence(originalFast, unsupportedHook, expected)).toEqual({
      ok: false,
      status: "unsupported_semantics",
      reason: "unsupported_hook_semantics",
    });

    const changedNonce = buildMessage(expected, { nonce: `0x${"cd".repeat(32)}` });
    expect(verifyCctpReplacementEquivalence(originalFast, changedNonce, expected)).toEqual({
      ok: false,
      status: "unsupported_semantics",
      reason: "replacement_nonce_changed",
    });

    const lockedCaller = buildMessage(expected, {
      destinationCaller: "0x8888888888888888888888888888888888888888",
    });
    expect(verifyCctpReplacementEquivalence(originalFast, lockedCaller, expected)).toEqual({
      ok: false,
      status: "unsupported_semantics",
      reason: "unsupported_destination_caller_change",
    });
  });

  it("preserves auditable expired original evidence across valid replacement settlement and leaves unsupported replacements unresolved", async () => {
    const config = loadStellarOnlyConfig();
    const stellarNet = config.deployments.networks["stellar-testnet"];
    if (stellarNet?.family !== "stellar") throw new Error("Expected stellar deployment");

    const fixtureExpected: ExpectedCctpTransfer = {
      ...expected,
      sourceToken: stellarNet.tokens.USDC!.sacId,
      sourceAdapter: stellarNet.adapters[RouteKind.Cctp]!,
    };

    const expiredFastOriginal = buildMessage(fixtureExpected, {
      minFinalityThreshold: 1000,
      finalityThresholdExecuted: 1000,
      expirationBlock: 77_000n,
      maxFee: 500_000n,
      feeExecuted: 200_000n,
    });
    const finalizedReplacement = buildMessage(fixtureExpected, {
      minFinalityThreshold: 2000,
      finalityThresholdExecuted: 2000,
      expirationBlock: 0n,
      maxFee: 500_000n,
      feeExecuted: 75_000n,
    });

    const originTx1 = "51".repeat(32);
    const originTx2 = "52".repeat(32);
    const forwardTxHash: Hex = `0x${"f1".repeat(32)}`;
    const blockHash: Hex = `0x${"b1".repeat(32)}`;
    const blockNumber = 9_100_000n;

    const evmClient: CctpEvmClient = {
      getChainId: () => Promise.resolve(11155111),
      getBlockNumber: () => Promise.resolve(blockNumber + 20n),
      getTransactionReceipt: () =>
        Promise.resolve({
          status: "success",
          blockNumber,
          blockHash,
          transactionHash: forwardTxHash,
          logs: buildReceiptLogs(finalizedReplacement, fixtureExpected),
        }),
      getBlock: () => Promise.resolve({ hash: blockHash, timestamp: 1_762_300_000n }),
    };

    const { db, close } = await createTestDb();
    try {
      await db.transaction(async (tx) => {
        for (const [idx, txHash] of [
          [91n, originTx1],
          [92n, originTx2],
        ] as const) {
          await writeOutbound(
            tx,
            {
              chainKey: "stellar-testnet",
              block: 5439000n + idx,
              txHash,
              logIndex: 0,
              observedAt: new Date("2026-10-29T10:30:00Z"),
            },
            {
              route: RouteKind.Cctp,
              nonce: idx,
              sender: stellarNet.admin,
              token: fixtureExpected.sourceToken,
              grossAmount: 1_000_000_000n,
              fee: 3_000_000n,
              netAmount: fixtureExpected.sourceAmount,
              destinationChain: "sepolia",
              destination: `0x${fixtureExpected.recipient.slice(2).padStart(64, "0")}`,
              railRef: null,
            },
          );
        }
      });

      const { rows: t1Rows } = await db.query(
        "SELECT id FROM outbound_transfer WHERE origin_chain = $1 AND nonce = $2",
        ["stellar-testnet", "91"],
      );
      const transferId1 = bigintOf(t1Rows[0]!, "id");
      const pending1: PendingTransfer = {
        transferId: transferId1,
        route: RouteKind.Cctp,
        originChain: "stellar-testnet",
        destinationChain: "sepolia",
        nonce: 91n,
        originTx: originTx1,
        status: null,
        checkFailures: 0,
        delivered: false,
      };

      // Poll 1: Only the expired fast attestation exists -> unresolved, recorded as expired original
      const irisExpiredAndReplaced = new IrisClient("testnet", {
        fetch: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                data: [
                  {
                    status: "expired",
                    eventNonce: "91",
                    messageBytes: expiredFastOriginal,
                    attestation: "0xfastexpiredsig",
                    decodedMessage: { decodedMessageBody: { expirationBlock: "77000" } },
                  },
                  {
                    status: "complete",
                    eventNonce: "91",
                    messageBytes: finalizedReplacement,
                    attestation: "0xfinalizedsig",
                    forwardTxHash,
                    replacesMessageHash: keccak256(expiredFastOriginal),
                  },
                ],
              }),
              { status: 200 },
            ),
          ),
      });

      const lookup1 = await irisExpiredAndReplaced.look(pending1);
      expect(lookup1.kind).toBe("found");
      if (lookup1.kind !== "found") throw new Error("Expected found lookup");
      expect(lookup1.report.status).toBe("attested");
      expect(lookup1.report.versionCandidates).toHaveLength(2);

      const settled = await verifyCctpDelivery(config, db, pending1, lookup1.report, {
        evmClient,
      });
      expect(settled).not.toBeNull();
      expect(settled?.row.amount).toBe(99_700_000n - 75_000n);

      const versions1 = await listCctpMessageVersions(db, transferId1);
      expect(versions1).toHaveLength(2);
      // Expired original remains completely auditable with its raw bytes, signature, expiry, and superseded_by_digest!
      expect(versions1[0]?.versionOrdinal).toBe(1);
      expect(versions1[0]?.equivalenceStatus).toBe("original");
      expect(versions1[0]?.lifecycleState).toBe("expired");
      expect(versions1[0]?.attestationTier).toBe("fast");
      expect(versions1[0]?.expirationBlock).toBe(77_000n);
      expect(versions1[0]?.attestationSignature).toBe("0xfastexpiredsig");
      expect(versions1[0]?.supersededByDigest).toBe(keccak256(finalizedReplacement));

      // Replacement links back to original via replacesDigest and transitions to settled!
      expect(versions1[1]?.versionOrdinal).toBe(2);
      expect(versions1[1]?.equivalenceStatus).toBe("equivalent_replacement");
      expect(versions1[1]?.lifecycleState).toBe("settled");
      expect(versions1[1]?.attestationTier).toBe("finalized");
      expect(versions1[1]?.replacesDigest).toBe(keccak256(expiredFastOriginal));
      expect(versions1[1]?.forwardTxHash).toBe(forwardTxHash);

      // Transfer 2: Unsupported replacement semantics (non-empty hook payload) leaves delivery unresolved!
      const { rows: t2Rows } = await db.query(
        "SELECT id FROM outbound_transfer WHERE origin_chain = $1 AND nonce = $2",
        ["stellar-testnet", "92"],
      );
      const transferId2 = bigintOf(t2Rows[0]!, "id");
      const pending2: PendingTransfer = {
        ...pending1,
        transferId: transferId2,
        nonce: 92n,
        originTx: originTx2,
      };
      const unsupportedHookReplacement = buildMessage(fixtureExpected, {
        hookBytes: new Uint8Array([0x01, 0xaa, 0xbb]),
      });

      const badLookup = await new IrisClient("testnet", {
        fetch: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                data: [
                  {
                    status: "expired",
                    eventNonce: "92",
                    messageBytes: expiredFastOriginal,
                    attestation: "0xfastexpiredsig",
                  },
                  {
                    status: "complete",
                    eventNonce: "92",
                    messageBytes: unsupportedHookReplacement,
                    attestation: "0xunsupportedhooksig",
                    forwardTxHash,
                  },
                ],
              }),
              { status: 200 },
            ),
          ),
      }).look(pending2);
      if (badLookup.kind !== "found") throw new Error("Expected found lookup");

      await expect(
        verifyCctpDelivery(config, db, pending2, badLookup.report, { evmClient }),
      ).resolves.toBeNull();

      const versions2 = await listCctpMessageVersions(db, transferId2);
      expect(versions2).toHaveLength(2);
      expect(versions2[0]?.lifecycleState).toBe("expired");
      expect(versions2[1]?.lifecycleState).toBe("rejected");
      expect(versions2[1]?.equivalenceStatus).toBe("unsupported_semantics");
      expect(versions2[1]?.equivalenceReason).toBe("unsupported_hook_semantics");
    } finally {
      await close();
    }
  });
});
