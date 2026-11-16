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
import { bigintOf, text } from "../../src/db/rows.js";
import { writeAttestation, writeInbound, writeOutbound } from "../../src/chains/writers.js";
import { buildServer } from "../../src/http/server.js";
import {
  CCTP_RECEIPT_ABI,
  matchingCctpPayment,
  verifiedCctpMessage,
  type ExpectedCctpTransfer,
} from "../../src/rails/cctp/events.js";
import {
  getCctpDeliveryProof,
  revalidateCctpDeliveries,
  verifyCctpDelivery,
  type CctpReadOnlyEvmClient,
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

async function createTestDb(): Promise<{
  db: Transactional & { ping: () => Promise<void> };
  close: () => Promise<void>;
}> {
  const pg = new PGlite();
  for (const file of [
    "1790900000000_initial-schema.sql",
    "1791000000000_cursor-block-hash.sql",
    "1791100000000_cursor-autovacuum-tuning.sql",
    "1791200000000_cctp-proof-revalidation.sql",
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

describe("CCTP destination-proof revalidation after confirmation", () => {
  it("keeps valid canonical proofs intact with exact amount and token identity, demotes reorged mints from confirmed state, and never invokes broadcast or mint methods", async () => {
    const config = loadStellarOnlyConfig();
    const stellarNet = config.deployments.networks["stellar-testnet"];
    if (stellarNet?.family !== "stellar") throw new Error("Expected stellar deployment");

    const fixtureExpected: ExpectedCctpTransfer = {
      ...expected,
      sourceToken: stellarNet.tokens.USDC!.sacId,
      sourceAdapter: stellarNet.adapters[RouteKind.Cctp]!,
    };

    const nonceValid: Hex = `0x${"11".repeat(32)}`;
    const nonceReorged: Hex = `0x${"22".repeat(32)}`;
    const validMsg = buildMessage(fixtureExpected, nonceValid);
    const reorgedMsg = buildMessage(fixtureExpected, nonceReorged);

    const originTxValid = "61".repeat(32);
    const originTxReorged = "62".repeat(32);
    const forwardTxValid: Hex = `0x${"c1".repeat(32)}`;
    const forwardTxReorged: Hex = `0x${"c2".repeat(32)}`;
    const forwardTxReconciled: Hex = `0x${"c3".repeat(32)}`;

    const canonicalBlockHash1: Hex = `0x${"d1".repeat(32)}`;
    const initialBlockHash2: Hex = `0x${"d2".repeat(32)}`;
    const reorgReplacementBlockHash2: Hex = `0x${"d9".repeat(32)}`;
    const canonicalBlockHash3: Hex = `0x${"d3".repeat(32)}`;

    let reorgOccurred = false;
    const rpcMethodsCalled: string[] = [];

    // Proxy ensures ANY unexpected method (e.g. sendRawTransaction, writeContract, receiveMessage) throws immediately!
    const baseClient: CctpReadOnlyEvmClient = {
      getChainId: () => {
        rpcMethodsCalled.push("getChainId");
        return Promise.resolve(11155111);
      },
      getBlockNumber: () => {
        rpcMethodsCalled.push("getBlockNumber");
        return Promise.resolve(reorgOccurred ? 9_500_200n : 9_500_050n);
      },
      getTransactionReceipt: ({ hash }) => {
        rpcMethodsCalled.push("getTransactionReceipt");
        if (hash === forwardTxValid) {
          return Promise.resolve({
            status: "success",
            blockNumber: 9_500_001n,
            blockHash: canonicalBlockHash1,
            transactionHash: forwardTxValid,
            logs: buildReceiptLogs(validMsg, fixtureExpected),
          });
        }
        if (hash === forwardTxReorged) {
          if (reorgOccurred) {
            return Promise.reject(new Error("Transaction receipt not found on canonical chain"));
          }
          return Promise.resolve({
            status: "success",
            blockNumber: 9_500_002n,
            blockHash: initialBlockHash2,
            transactionHash: forwardTxReorged,
            logs: buildReceiptLogs(reorgedMsg, fixtureExpected),
          });
        }
        if (hash === forwardTxReconciled) {
          return Promise.resolve({
            status: "success",
            blockNumber: 9_500_110n,
            blockHash: canonicalBlockHash3,
            transactionHash: forwardTxReconciled,
            logs: buildReceiptLogs(reorgedMsg, fixtureExpected),
          });
        }
        return Promise.reject(new Error(`Unexpected hash ${hash}`));
      },
      getBlock: ({ blockNumber }) => {
        rpcMethodsCalled.push("getBlock");
        if (blockNumber === 9_500_001n) {
          return Promise.resolve({ hash: canonicalBlockHash1, timestamp: 1_762_400_001n });
        }
        if (blockNumber === 9_500_002n) {
          return Promise.resolve({
            hash: reorgOccurred ? reorgReplacementBlockHash2 : initialBlockHash2,
            timestamp: 1_762_400_002n,
          });
        }
        if (blockNumber === 9_500_110n) {
          return Promise.resolve({ hash: canonicalBlockHash3, timestamp: 1_762_401_000n });
        }
        return Promise.resolve({ hash: null, timestamp: 0n });
      },
    };

    const guardedClient = new Proxy(baseClient as unknown as Record<string, unknown>, {
      get(target, prop: string) {
        if (
          prop === "sendRawTransaction" ||
          prop === "sendTransaction" ||
          prop === "writeContract" ||
          prop === "receiveMessage"
        ) {
          throw new Error(`Forbidden write/mint method invoked: ${prop}`);
        }
        return target[prop];
      },
    }) as unknown as CctpReadOnlyEvmClient;

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
        for (const [nonceNum, txHash] of [
          [101n, originTxValid],
          [102n, originTxReorged],
        ] as const) {
          await writeOutbound(
            tx,
            {
              chainKey: "stellar-testnet",
              block: 5440000n + nonceNum,
              txHash,
              logIndex: 0,
              observedAt: new Date("2026-10-29T11:00:00Z"),
            },
            {
              route: RouteKind.Cctp,
              nonce: nonceNum,
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

      const { rows: outRows } = await db.query(
        "SELECT id, nonce FROM outbound_transfer ORDER BY nonce ASC",
      );
      const idValid = bigintOf(outRows[0]!, "id");
      const idReorged = bigintOf(outRows[1]!, "id");

      const pendingValid: PendingTransfer = {
        transferId: idValid,
        route: RouteKind.Cctp,
        originChain: "stellar-testnet",
        destinationChain: "sepolia",
        nonce: 101n,
        originTx: originTxValid,
        status: null,
        checkFailures: 0,
        delivered: false,
      };
      const pendingReorged: PendingTransfer = {
        transferId: idReorged,
        route: RouteKind.Cctp,
        originChain: "stellar-testnet",
        destinationChain: "sepolia",
        nonce: 102n,
        originTx: originTxReorged,
        status: null,
        checkFailures: 0,
        delivered: false,
      };

      // Confirm both transfers initially
      const v1 = await verifyCctpDelivery(
        config,
        db,
        pendingValid,
        reportFor({
          status: "complete",
          eventNonce: "101",
          messageBytes: validMsg,
          forwardTxHash: forwardTxValid,
        }),
        { evmClient: guardedClient },
      );
      const v2 = await verifyCctpDelivery(
        config,
        db,
        pendingReorged,
        reportFor({
          status: "complete",
          eventNonce: "102",
          messageBytes: reorgedMsg,
          forwardTxHash: forwardTxReorged,
        }),
        { evmClient: guardedClient },
      );
      expect(v1).not.toBeNull();
      expect(v2).not.toBeNull();

      await db.transaction(async (tx) => {
        await writeInbound(tx, v1!.at, v1!.row);
        await writeAttestation(tx, {
          transferId: idValid,
          route: RouteKind.Cctp,
          status: "delivered",
          railStatus: "complete",
          railReference: "101",
          attestedAt: new Date("2026-10-29T11:01:00Z"),
          checkedAt: new Date("2026-10-29T11:01:00Z"),
          checkFailures: 0,
          lastError: null,
        });
        await writeInbound(tx, v2!.at, v2!.row);
        await writeAttestation(tx, {
          transferId: idReorged,
          route: RouteKind.Cctp,
          status: "delivered",
          railStatus: "complete",
          railReference: "102",
          attestedAt: new Date("2026-10-29T11:01:00Z"),
          checkedAt: new Date("2026-10-29T11:01:00Z"),
          checkFailures: 0,
          lastError: null,
        });
      });

      // Now simulate destination chain reorganization on block 9_500_002!
      reorgOccurred = true;
      rpcMethodsCalled.length = 0;

      const summary = await revalidateCctpDeliveries(config, db, {
        evmClientForChain: () => guardedClient,
      });
      expect(summary).toEqual({ checked: 2, canonical: 1, orphaned: 1 });

      // Strictly read-only RPC calls ONLY
      expect(new Set(rpcMethodsCalled)).toEqual(
        new Set(["getChainId", "getBlockNumber", "getBlock", "getTransactionReceipt"]),
      );

      // 1. Valid proof retains exact received amount (99600000) and token identity!
      const proofValid = await getCctpDeliveryProof(db, idValid);
      expect(proofValid?.revalidationState).toBe("canonical");
      expect(proofValid?.mintedAmount).toBe(99_600_000n);
      expect(proofValid?.tokenAddress).toBe(fixtureExpected.token.toLowerCase());
      expect(proofValid?.lastCheckedHead).toBe(9_500_200n);

      const resValid = await app.inject(`/v1/transfers/by-tx/${originTxValid}`);
      expect(resValid.statusCode).toBe(200);
      expect(resValid.json().destination.delivered).toBe(true);
      expect(resValid.json().destination.amount).toBe("99600000");
      expect(resValid.json().destination.token).toBe(fixtureExpected.token.toLowerCase());

      // 2. Reorged mint CANNOT remain permanently marked confirmed!
      const proofReorged = await getCctpDeliveryProof(db, idReorged);
      expect(proofReorged?.revalidationState).toBe("orphaned");
      expect(proofReorged?.orphanReason).toBe("block_hash_mismatch");

      const { rows: attRows } = await db.query(
        "SELECT status FROM rail_attestation WHERE transfer_id = $1",
        [idReorged.toString()],
      );
      expect(text(attRows[0]!, "status")).toBe("attested");

      const resReorged = await app.inject(`/v1/transfers/by-tx/${originTxReorged}`);
      expect(resReorged.statusCode).toBe(200);
      expect(resReorged.json().destination.delivered).toBe(false);
      expect(resReorged.json().stage).toBe("delivering");

      // 3. Subsequent canonical forwarding transaction transitions orphaned proof cleanly to reconciled
      const v2Reconciled = await verifyCctpDelivery(
        config,
        db,
        pendingReorged,
        reportFor({
          status: "complete",
          eventNonce: "102",
          messageBytes: reorgedMsg,
          forwardTxHashes: [forwardTxReorged, forwardTxReconciled],
        }),
        { evmClient: guardedClient },
      );
      expect(v2Reconciled).not.toBeNull();
      expect(v2Reconciled?.at.txHash).toBe(forwardTxReconciled);

      const proofReconciled = await getCctpDeliveryProof(db, idReorged);
      expect(proofReconciled?.revalidationState).toBe("reconciled");
      expect(proofReconciled?.orphanReason).toBeNull();
      expect(proofReconciled?.txHash).toBe(forwardTxReconciled);
    } finally {
      await app.close();
      await close();
    }
  });
});
