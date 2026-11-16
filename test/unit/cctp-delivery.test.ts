import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { StrKey } from "@stellar/stellar-sdk";
import { RouteKind, toHex } from "@hyperion/protocol";
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, hexToBytes, type Hex } from "viem";
import { loadConfig, type AppConfig } from "../../src/config/config.js";
import type { Database, QueryResultRows, Queryable, Transactional } from "../../src/db/pool.js";
import { bigintOf } from "../../src/db/rows.js";
import { writeInbound, writeOutbound } from "../../src/chains/writers.js";
import { buildServer } from "../../src/http/server.js";
import {
  CCTP_RECEIPT_ABI,
  evaluateCctpMessageFeeAccounting,
  matchingCctpPayment,
  reconcileCctpBurnToMint,
  verifiedCctpMessage,
  type ExpectedCctpTransfer,
} from "../../src/rails/cctp/events.js";
import {
  getCctpFeeReconciliation,
  verifyCctpDelivery,
  type CctpEvmClient,
} from "../../src/rails/cctp/delivery.js";
import type { DeliveryLog } from "../../src/rails/axelar/events.js";
import { reportFor } from "../../src/rails/cctp/iris.js";
import type { PendingTransfer } from "../../src/rails/types.js";
import { completeEnv, readFixture } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

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
    readonly burnAmount?: bigint;
    readonly maxFee?: bigint;
    readonly feeExecuted?: bigint;
    readonly finalityThresholdExecuted?: number;
  } = {},
): Hex {
  const raw = new Uint8Array(148 + 228);
  const view = new DataView(raw.buffer);
  const burnAmount = overrides.burnAmount ?? base.sourceAmount / 10n;
  const maxFee = overrides.maxFee ?? 500000n;
  const feeExecuted = overrides.feeExecuted ?? 100000n;
  const finality = overrides.finalityThresholdExecuted ?? 2000;

  view.setUint32(0, 1);
  view.setUint32(4, 27);
  view.setUint32(8, base.destinationDomain);
  raw.set(hexToBytes(nonce), 12);
  raw.set(StrKey.decodeContract(base.sourceMessenger), 44);
  raw.set(word(base.destinationMessenger), 76);
  view.setUint32(140, 2000);
  view.setUint32(144, finality);
  view.setUint32(148, 1);
  raw.set(StrKey.decodeContract(base.sourceToken), 152);
  raw.set(word(base.recipient), 184);
  raw.set(uint256Word(burnAmount), 216);
  raw.set(StrKey.decodeContract(base.sourceAdapter), 248);
  raw.set(uint256Word(maxFee), 280);
  raw.set(uint256Word(feeExecuted), 312);
  return toHex(raw);
}

const raw = buildMessage();
const verified = verifiedCctpMessage(raw, expected);
if (!verified) throw new Error("Invalid test message.");

const received: DeliveryLog = {
  address: expected.transmitter as Hex,
  topics: encodeEventTopics({
    abi: CCTP_RECEIPT_ABI,
    eventName: "MessageReceived",
    args: { caller: expected.recipient as Hex, nonce, finalityThresholdExecuted: 2000 },
  }) as [Hex, ...Hex[]],
  data: encodeAbiParameters(
    [{ type: "uint32" }, { type: "bytes32" }, { type: "bytes" }],
    [27, verified.message.sender, verified.body],
  ),
  logIndex: 4,
};
const paid: DeliveryLog = {
  address: expected.token as Hex,
  topics: encodeEventTopics({
    abi: CCTP_RECEIPT_ABI,
    eventName: "Transfer",
    args: { from: `0x${"0".repeat(40)}`, to: expected.recipient as Hex },
  }) as [Hex, ...Hex[]],
  data: encodeAbiParameters([{ type: "uint256" }], [verified.amount]),
  logIndex: 3,
};

async function createTestDb(): Promise<{
  db: Transactional & { ping: () => Promise<void> };
  close: () => Promise<void>;
}> {
  const pg = new PGlite();
  for (const file of [
    "1790900000000_initial-schema.sql",
    "1791000000000_cursor-block-hash.sql",
    "1791100000000_cursor-autovacuum-tuning.sql",
    "1791200000000_cctp-fee-reconciliation.sql",
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
  const db: Transactional & { ping: () => Promise<void> } = {
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
    ping: async () => {
      await pg.query("SELECT 1");
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

describe("CCTP burn-to-mint fee reconciliation", () => {
  it("reconciles 7-decimal Stellar burns and 6-decimal EVM mints beyond IEEE-754 safe integer precision without floats", () => {
    // 2^60 + 12_345_670 stroops: loses low digits if ever cast through IEEE-754 double!
    const hugeSourceAmount = (1n << 60n) * 10n + 123_456_70n;
    const hugeExpected: ExpectedCctpTransfer = {
      ...expected,
      sourceAmount: hugeSourceAmount,
    };
    const maxFee = 500_000n;
    const feeExecuted = 123_456n;
    const hugeRaw = buildMessage(hugeExpected, {
      burnAmount: hugeSourceAmount / 10n,
      maxFee,
      feeExecuted,
    });
    const hugeVerified = verifiedCctpMessage(hugeRaw, hugeExpected);
    expect(hugeVerified).not.toBeNull();

    const hugeReceived: DeliveryLog = {
      address: hugeExpected.transmitter as Hex,
      topics: encodeEventTopics({
        abi: CCTP_RECEIPT_ABI,
        eventName: "MessageReceived",
        args: { caller: hugeExpected.recipient as Hex, nonce, finalityThresholdExecuted: 2000 },
      }) as [Hex, ...Hex[]],
      data: encodeAbiParameters(
        [{ type: "uint32" }, { type: "bytes32" }, { type: "bytes" }],
        [27, hugeVerified!.message.sender, hugeVerified!.body],
      ),
      logIndex: 1,
    };
    const expectedActual = hugeSourceAmount / 10n - feeExecuted;
    const expectedPlannedMin = hugeSourceAmount / 10n - maxFee;

    const hugePaid: DeliveryLog = {
      address: hugeExpected.token as Hex,
      topics: encodeEventTopics({
        abi: CCTP_RECEIPT_ABI,
        eventName: "Transfer",
        args: { from: `0x${"0".repeat(40)}`, to: hugeExpected.recipient as Hex },
      }) as [Hex, ...Hex[]],
      data: encodeAbiParameters([{ type: "uint256" }], [expectedActual]),
      logIndex: 2,
    };

    const reconciled = reconcileCctpBurnToMint([hugePaid, hugeReceived], hugeRaw, hugeExpected);
    expect(reconciled.ok).toBe(true);
    if (!reconciled.ok) throw new Error("Expected reconciled outcome");
    expect(reconciled.accounting.sourceDecimals).toBe(7);
    expect(reconciled.accounting.destinationDecimals).toBe(6);
    expect(reconciled.accounting.sourceBurnedAmount).toBe(hugeSourceAmount);
    expect(reconciled.accounting.cctpBurnAmount).toBe(hugeSourceAmount / 10n);
    expect(reconciled.accounting.forwardingBudgetMaxFee).toBe(maxFee);
    expect(reconciled.accounting.executedFeeDeduction).toBe(feeExecuted);
    expect(reconciled.accounting.plannedMinPayout).toBe(expectedPlannedMin);
    expect(reconciled.accounting.actualMintPayout).toBe(expectedActual);
  });

  it("fails verification diagnostics on unrepresentable 7th-decimal dust, excess fee deductions, invalid budgets, and inconsistent mint payouts", () => {
    // 1. Non-zero 7th decimal stroop dust
    const dusty = evaluateCctpMessageFeeAccounting(raw, {
      ...expected,
      sourceAmount: expected.sourceAmount + 3n,
    });
    expect(dusty.ok).toBe(false);
    if (!dusty.ok) expect(dusty.code).toBe("unrepresentable_source_precision");

    // 2. Burn amount mismatch
    const wrongBurn = evaluateCctpMessageFeeAccounting(
      buildMessage(expected, { burnAmount: expected.sourceAmount / 10n - 1n }),
      expected,
    );
    expect(wrongBurn.ok).toBe(false);
    if (!wrongBurn.ok) expect(wrongBurn.code).toBe("burn_amount_mismatch");

    // 3. Forwarding budget >= burn amount
    const badBudget = evaluateCctpMessageFeeAccounting(
      buildMessage(expected, { maxFee: expected.sourceAmount / 10n }),
      expected,
    );
    expect(badBudget.ok).toBe(false);
    if (!badBudget.ok) expect(badBudget.code).toBe("invalid_forwarding_budget");

    // 4. Executed fee > maxFee budget
    const excessFee = evaluateCctpMessageFeeAccounting(
      buildMessage(expected, { maxFee: 500_000n, feeExecuted: 500_001n }),
      expected,
    );
    expect(excessFee.ok).toBe(false);
    if (!excessFee.ok) expect(excessFee.code).toBe("excess_fee_deduction");

    // 5. Inconsistent native USDC mint payout vs burn - feeExecuted
    const inconsistentMint = reconcileCctpBurnToMint(
      [
        {
          ...paid,
          data: encodeAbiParameters([{ type: "uint256" }], [verified.amount - 50n]),
        },
        received,
      ],
      raw,
      expected,
    );
    expect(inconsistentMint.ok).toBe(false);
    if (!inconsistentMint.ok) {
      expect(inconsistentMint.code).toBe("inconsistent_mint_payout");
      expect(inconsistentMint.accounting?.actualMintPayout).toBe(verified.amount - 50n);
    }
  });

  it("persists fee reconciliation and exposes actual payout separately from planned minimum on GET /v1/transfers", async () => {
    const config = loadStellarOnlyConfig();
    const stellarNet = config.deployments.networks["stellar-testnet"];
    if (stellarNet?.family !== "stellar") throw new Error("Expected stellar deployment");

    const fixtureExpected: ExpectedCctpTransfer = {
      ...expected,
      sourceToken: stellarNet.tokens.USDC!.sacId,
      sourceAdapter: stellarNet.adapters[RouteKind.Cctp]!,
    };

    // Burn: 99.7000000 USDC (997_000_000 stroops -> 99_700_000 destination units)
    // Forwarding budget maxFee: 500_000 (0.50 USDC) -> plannedMinPayout = 99_200_000 (99.20 USDC)
    // Executed deduction: 120_000 (0.12 USDC) -> actualMintPayout = 99_580_000 (99.58 USDC)
    const msgRaw = buildMessage(fixtureExpected, {
      maxFee: 500_000n,
      feeExecuted: 120_000n,
    });
    const parsedMsg = verifiedCctpMessage(msgRaw, fixtureExpected)!;

    const originTx = "88".repeat(32);
    const forwardTxHash: Hex = `0x${"77".repeat(32)}`;
    const blockHash: Hex = `0x${"66".repeat(32)}`;
    const blockNumber = 8_500_000n;

    const evmClient: CctpEvmClient = {
      getChainId: () => Promise.resolve(11155111),
      getBlockNumber: () => Promise.resolve(blockNumber + 15n),
      getTransactionReceipt: () =>
        Promise.resolve({
          status: "success",
          blockNumber,
          blockHash,
          transactionHash: forwardTxHash,
          logs: [
            {
              address: fixtureExpected.token as Hex,
              topics: encodeEventTopics({
                abi: CCTP_RECEIPT_ABI,
                eventName: "Transfer",
                args: { from: `0x${"0".repeat(40)}`, to: fixtureExpected.recipient as Hex },
              }) as [Hex, ...Hex[]],
              data: encodeAbiParameters([{ type: "uint256" }], [99_580_000n]),
              logIndex: 2,
            },
            {
              address: fixtureExpected.transmitter as Hex,
              topics: encodeEventTopics({
                abi: CCTP_RECEIPT_ABI,
                eventName: "MessageReceived",
                args: {
                  caller: fixtureExpected.recipient as Hex,
                  nonce,
                  finalityThresholdExecuted: 2000,
                },
              }) as [Hex, ...Hex[]],
              data: encodeAbiParameters(
                [{ type: "uint32" }, { type: "bytes32" }, { type: "bytes" }],
                [27, parsedMsg.message.sender, parsedMsg.body],
              ),
              logIndex: 3,
            },
          ],
        }),
      getBlock: () => Promise.resolve({ hash: blockHash, timestamp: 1_762_250_000n }),
    };

    const { db, close } = await createTestDb();
    const { logger } = capturingLogger();
    const app = buildServer({
      config,
      logger,
      db: db as unknown as Database,
      readiness: [],
    });
    await app.ready();

    try {
      await db.transaction(async (tx) => {
        await writeOutbound(
          tx,
          {
            chainKey: "stellar-testnet",
            block: 5438000n,
            txHash: originTx,
            logIndex: 0,
            observedAt: new Date("2026-10-29T10:20:00Z"),
          },
          {
            route: RouteKind.Cctp,
            nonce: 88n,
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
      });

      const { rows } = await db.query(
        "SELECT id FROM outbound_transfer WHERE origin_chain = $1 AND nonce = $2",
        ["stellar-testnet", "88"],
      );
      const transferId = bigintOf(rows[0]!, "id");
      const pending: PendingTransfer = {
        transferId,
        route: RouteKind.Cctp,
        originChain: "stellar-testnet",
        destinationChain: "sepolia",
        nonce: 88n,
        originTx,
        status: null,
        checkFailures: 0,
        delivered: false,
      };

      // Phase 1: Attested message without forwardTxHash -> records plannedMinPayout while actualPayout is null
      const inFlightReport = reportFor({
        status: "complete",
        eventNonce: "88",
        messageBytes: msgRaw,
      });
      await expect(verifyCctpDelivery(config, db, pending, inFlightReport)).resolves.toBeNull();

      const preHttp = await app.inject(`/v1/transfers/by-tx/${originTx}`);
      expect(preHttp.statusCode).toBe(200);
      expect(preHttp.json().destination.plannedMinAmount).toBe("99200000");
      expect(preHttp.json().destination.actualAmount).toBeNull();
      expect(preHttp.json().feeReconciliation).toEqual({
        status: "pending",
        sourceDecimals: 7,
        destinationDecimals: 6,
        sourceBurnedAmount: "997000000",
        destinationBurnAmount: "99700000",
        forwardingBudget: "500000",
        executedDeduction: "120000",
        plannedMinPayout: "99200000",
        actualPayout: null,
        diagnosticCode: null,
      });

      // Phase 2: Forwarded receipt confirmed -> reconciles actualPayout (99_580_000) separately from plannedMinPayout (99_200_000)!
      const settledReport = reportFor({
        status: "complete",
        eventNonce: "88",
        messageBytes: msgRaw,
        forwardTxHash,
      });
      const verifiedDelivery = await verifyCctpDelivery(config, db, pending, settledReport, {
        evmClient,
      });
      expect(verifiedDelivery).not.toBeNull();
      await db.transaction(async (tx) => {
        await writeInbound(tx, verifiedDelivery!.at, verifiedDelivery!.row);
      });

      const storedFee = await getCctpFeeReconciliation(db, transferId);
      expect(storedFee?.status).toBe("reconciled");
      expect(storedFee?.plannedMinPayout).toBe(99_200_000n);
      expect(storedFee?.actualMintPayout).toBe(99_580_000n);

      const postHttp = await app.inject(`/v1/transfers/by-tx/${originTx}`);
      expect(postHttp.statusCode).toBe(200);
      expect(postHttp.json().destination.plannedMinAmount).toBe("99200000");
      expect(postHttp.json().destination.actualAmount).toBe("99580000");
      expect(postHttp.json().destination.amount).toBe("99580000");
      expect(postHttp.json().feeReconciliation).toEqual({
        status: "reconciled",
        sourceDecimals: 7,
        destinationDecimals: 6,
        sourceBurnedAmount: "997000000",
        destinationBurnAmount: "99700000",
        forwardingBudget: "500000",
        executedDeduction: "120000",
        plannedMinPayout: "99200000",
        actualPayout: "99580000",
        diagnosticCode: null,
      });
    } finally {
      await app.close();
      await close();
    }
  });
});
