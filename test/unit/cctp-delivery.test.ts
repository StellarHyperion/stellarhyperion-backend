import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { StrKey } from "@stellar/stellar-sdk";
import { RouteKind, toHex } from "@hyperion/protocol";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, hexToBytes, keccak256, type Hex } from "viem";
import { loadConfig, type AppConfig } from "../../src/config/config.js";
import type { Database, QueryResultRows, Queryable, Transactional } from "../../src/db/pool.js";
import { bigintOf } from "../../src/db/rows.js";
import { writeAttestation, writeInbound, writeOutbound } from "../../src/chains/writers.js";
import { buildServer } from "../../src/http/server.js";
import type { DeliveryLog } from "../../src/rails/axelar/events.js";
import {
  verifyCctpDelivery,
  type CctpEvmClient,
  type CctpPublicDeliveryEvidence,
} from "../../src/rails/cctp/delivery.js";
import {
  CCTP_RECEIPT_ABI,
  matchingCctpPayment,
  verifiedCctpMessage,
  type ExpectedCctpTransfer,
} from "../../src/rails/cctp/events.js";
import { reportFor, sanitizeBoundedPublicRef } from "../../src/rails/cctp/iris.js";
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

async function createTestDb(): Promise<{
  db: Transactional & { ping: () => Promise<void> };
  close: () => Promise<void>;
}> {
  const pg = new PGlite();
  for (const file of [
    "1790900000000_initial-schema.sql",
    "1791000000000_cursor-block-hash.sql",
    "1791100000000_cursor-autovacuum-tuning.sql",
    "1791200000000_cctp-delivery-evidence.sql",
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

describe("read-only CCTP delivery evidence endpoint", () => {
  it("rejects credential-bearing or oversized strings from public reference sanitization", () => {
    expect(sanitizeBoundedPublicRef("https://rpc.example.invalid/v3/my-api-key")).toBeNull();
    expect(sanitizeBoundedPublicRef("Bearer secret-credential-value")).toBeNull();
    expect(sanitizeBoundedPublicRef(`0x${"ab".repeat(80)}`)).toBeNull();
    expect(sanitizeBoundedPublicRef(`0x${"AB".repeat(32)}`)).toBe(`0x${"ab".repeat(32)}`);
  });

  it("exposes missing checks for pending transfers and canonical block/message identity for confirmed deliveries without leaking credentials", async () => {
    const rpcCredentialMarker = "super-secret-rpc-key-999";
    const config = loadStellarOnlyConfig({
      DATABASE_URL: `postgres://hyperion:${rpcCredentialMarker}@127.0.0.1:5433/hyperion`,
      EVM_RPC_URL_SEPOLIA: `https://sepolia.rpc.invalid/${rpcCredentialMarker}`,
    });
    const stellarNet = config.deployments.networks["stellar-testnet"];
    if (stellarNet?.family !== "stellar") throw new Error("Expected stellar deployment");

    const fixtureExpected: ExpectedCctpTransfer = {
      ...expected,
      sourceToken: stellarNet.tokens.USDC!.sacId,
      sourceAdapter: stellarNet.adapters[RouteKind.Cctp]!,
    };

    const { db, close } = await createTestDb();
    const app = buildServer({
      config,
      logger: pino({ level: "silent" }),
      db: db as unknown as Database,
      readiness: [],
    });

    try {
      const originTxPending = "aa".repeat(32);
      const originTxConfirmed = "bb".repeat(32);

      // Transfer #1: Pending CCTP transfer (even with a credential-bearing internal error stored in rail_attestation)
      await db.transaction(async (tx) => {
        await writeOutbound(
          tx,
          {
            chainKey: "stellar-testnet",
            block: 5436000n,
            txHash: originTxPending,
            logIndex: 0,
            observedAt: new Date("2026-10-29T10:00:00Z"),
          },
          {
            route: RouteKind.Cctp,
            nonce: 10n,
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
      const { rows: pendingRows } = await db.query(
        "SELECT id FROM outbound_transfer WHERE origin_chain = $1 AND nonce = $2",
        ["stellar-testnet", "10"],
      );
      const pendingId = bigintOf(pendingRows[0]!, "id");

      await db.transaction(async (tx) => {
        await writeAttestation(tx, {
          transferId: pendingId,
          route: RouteKind.Cctp,
          status: "pending",
          railStatus: "pending_confirmations",
          railReference: `https://iris.invalid/?apikey=${rpcCredentialMarker}`,
          attestedAt: null,
          checkedAt: new Date("2026-10-29T10:01:00Z"),
          checkFailures: 1,
          lastError: `rpc failed against https://sepolia.rpc.invalid/${rpcCredentialMarker}`,
        });
      });

      const pendingRes = await app.inject({
        method: "GET",
        url: `/v1/transfers/${String(pendingId)}/evidence`,
      });
      expect(pendingRes.statusCode).toBe(200);
      expect(pendingRes.body).not.toContain(rpcCredentialMarker);
      const pendingBody = pendingRes.json<CctpPublicDeliveryEvidence>();
      expect(pendingBody.verified).toBe(false);
      expect(pendingBody.status).toBe("pending");
      expect(pendingBody.missingChecks).toEqual([
        "circle_attestation",
        "message_integrity",
        "forward_tx_candidate",
        "canonical_destination_receipt",
        "native_usdc_mint",
      ]);
      // Tainted railReference was stripped to null by bounded public reference sanitizer
      expect(pendingBody.messageIdentity.railReference).toBeNull();

      // Transfer #2: Confirmed CCTP transfer with verified message + canonical block receipt + native USDC mint
      await db.transaction(async (tx) => {
        await writeOutbound(
          tx,
          {
            chainKey: "stellar-testnet",
            block: 5436010n,
            txHash: originTxConfirmed,
            logIndex: 0,
            observedAt: new Date("2026-10-29T10:05:00Z"),
          },
          {
            route: RouteKind.Cctp,
            nonce: 11n,
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
      const { rows: confirmedRows } = await db.query(
        "SELECT id FROM outbound_transfer WHERE origin_chain = $1 AND nonce = $2",
        ["stellar-testnet", "11"],
      );
      const confirmedId = bigintOf(confirmedRows[0]!, "id");

      const msgNonceConfirmed: Hex = `0x${"dd".repeat(32)}`;
      const msgConfirmed = buildMessage(fixtureExpected, msgNonceConfirmed);
      const forwardTxHash: Hex = `0x${"ee".repeat(32)}`;
      const canonicalBlockHash: Hex = `0x${"ff".repeat(32)}`;
      const canonicalBlockNumber = 9_800_123n;

      const evmClient: CctpEvmClient = {
        getChainId: () => Promise.resolve(11155111),
        getBlockNumber: () => Promise.resolve(canonicalBlockNumber + 10n),
        getTransactionReceipt: () =>
          Promise.resolve({
            status: "success",
            blockNumber: canonicalBlockNumber,
            blockHash: canonicalBlockHash,
            transactionHash: forwardTxHash,
            logs: buildReceiptLogs(msgConfirmed, fixtureExpected),
          }),
        getBlock: () =>
          Promise.resolve({
            hash: canonicalBlockHash,
            timestamp: 1_762_100_000n,
          }),
      };

      const pendingTransfer2: PendingTransfer = {
        transferId: confirmedId,
        route: RouteKind.Cctp,
        originChain: "stellar-testnet",
        destinationChain: "sepolia",
        nonce: 11n,
        originTx: originTxConfirmed,
        status: "attested",
        checkFailures: 0,
        delivered: false,
      };
      const verifiedDelivery = await verifyCctpDelivery(
        config,
        db,
        pendingTransfer2,
        reportFor({
          status: "complete",
          eventNonce: "5501",
          messageBytes: msgConfirmed,
          forwardTxHash,
          attestation: "0xdeadbeef",
        }),
        { evmClient },
      );
      expect(verifiedDelivery).not.toBeNull();
      await db.transaction(async (tx) => {
        await writeInbound(tx, verifiedDelivery!.at, verifiedDelivery!.row);
        await writeAttestation(tx, {
          transferId: confirmedId,
          route: RouteKind.Cctp,
          status: "delivered",
          railStatus: "complete",
          railReference: "5501",
          attestedAt: new Date("2026-10-29T10:06:00Z"),
          checkedAt: new Date("2026-10-29T10:06:00Z"),
          checkFailures: 0,
          lastError: null,
        });
      });

      const confirmedRes = await app.inject({
        method: "GET",
        url: "/v1/transfers/stellar-testnet/11/evidence",
      });
      expect(confirmedRes.statusCode).toBe(200);
      expect(confirmedRes.body).not.toContain(rpcCredentialMarker);
      const confirmedBody = confirmedRes.json<CctpPublicDeliveryEvidence>();
      expect(confirmedBody.verified).toBe(true);
      expect(confirmedBody.status).toBe("delivered");
      expect(confirmedBody.missingChecks).toEqual([]);
      expect(confirmedBody.messageIdentity).toEqual({
        nonce: msgNonceConfirmed,
        messageHash: keccak256(msgConfirmed),
        bodyHash: verifiedCctpMessage(msgConfirmed, fixtureExpected)!.bodyHash,
        sourceDomain: 27,
        destinationDomain: 0,
        finalityThresholdExecuted: 2000,
        railReference: "5501",
      });
      expect(confirmedBody.destination.canonicalTxHash).toBe(forwardTxHash);
      expect(confirmedBody.destination.canonicalBlockNumber).toBe(String(canonicalBlockNumber));
      expect(confirmedBody.destination.canonicalBlockHash).toBe(canonicalBlockHash);
      expect(confirmedBody.destination.mintedAmount).toBe("99600000");
      expect(confirmedBody.destination.feeExecuted).toBe("100000");
      expect(confirmedBody.destination.messageLogIndex).toBe(4);
      expect(confirmedBody.destination.mintLogIndex).toBe(3);
    } finally {
      await app.close();
      await close();
    }
  });
});
