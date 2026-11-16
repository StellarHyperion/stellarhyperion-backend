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
import { writeOutbound } from "../../src/chains/writers.js";
import { buildServer } from "../../src/http/server.js";
import {
  CCTP_RECEIPT_ABI,
  inspectCctpMessage,
  inspectCctpPaymentLogs,
  matchingCctpPayment,
  sanitizeCctpDiagnosticText,
  verifiedCctpMessage,
  type ExpectedCctpTransfer,
} from "../../src/rails/cctp/events.js";
import {
  getCctpVerificationDiagnostic,
  verifyCctpDelivery,
  type CctpEvmClient,
} from "../../src/rails/cctp/delivery.js";
import type { DeliveryLog } from "../../src/rails/axelar/events.js";
import { IrisClient, reportFor } from "../../src/rails/cctp/iris.js";
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

function buildMessage(base: ExpectedCctpTransfer = expected): Hex {
  const raw = new Uint8Array(148 + 228);
  const view = new DataView(raw.buffer);
  view.setUint32(0, 1);
  view.setUint32(4, 27);
  view.setUint32(8, base.destinationDomain);
  raw.set(hexToBytes(nonce), 12);
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
    "1791200000000_cctp-verification-diagnostics.sql",
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

describe("Structured CCTP verification failure diagnostics", () => {
  it("produces distinct field-level categories for wrong recipient, domain, token, and amount", () => {
    const wrongRecipient = inspectCctpMessage(raw, {
      ...expected,
      recipient: "0x2222222222222222222222222222222222222222",
    });
    expect(wrongRecipient.ok).toBe(false);
    if (!wrongRecipient.ok) {
      expect(wrongRecipient.diagnostic.category).toBe("recipient_mismatch");
      expect(wrongRecipient.diagnostic.fieldName).toBe("mintRecipient");
      expect(wrongRecipient.diagnostic.retryable).toBe(false);
    }

    const wrongDomain = inspectCctpMessage(raw, {
      ...expected,
      destinationDomain: 6,
    });
    expect(wrongDomain.ok).toBe(false);
    if (!wrongDomain.ok) {
      expect(wrongDomain.diagnostic.category).toBe("domain_mismatch");
      expect(wrongDomain.diagnostic.fieldName).toBe("destinationDomain");
      expect(wrongDomain.diagnostic.retryable).toBe(false);
    }

    const wrongSourceToken = inspectCctpMessage(raw, {
      ...expected,
      sourceToken: expected.sourceAdapter,
    });
    expect(wrongSourceToken.ok).toBe(false);
    if (!wrongSourceToken.ok) {
      expect(wrongSourceToken.diagnostic.category).toBe("token_mismatch");
      expect(wrongSourceToken.diagnostic.fieldName).toBe("burnToken");
      expect(wrongSourceToken.diagnostic.retryable).toBe(false);
    }

    const wrongDestToken = inspectCctpPaymentLogs(
      [{ ...paid, address: "0x3333333333333333333333333333333333333333" }, received],
      raw,
      expected,
    );
    expect(wrongDestToken.ok).toBe(false);
    if (!wrongDestToken.ok) {
      expect(wrongDestToken.diagnostic.category).toBe("token_mismatch");
      expect(wrongDestToken.diagnostic.fieldName).toBe("destinationToken");
      expect(wrongDestToken.diagnostic.retryable).toBe(false);
    }

    const wrongAmount = inspectCctpPaymentLogs(
      [
        {
          ...paid,
          data: encodeAbiParameters([{ type: "uint256" }], [verified.amount - 1n]),
        },
        received,
      ],
      raw,
      expected,
    );
    expect(wrongAmount.ok).toBe(false);
    if (!wrongAmount.ok) {
      expect(wrongAmount.diagnostic.category).toBe("amount_mismatch");
      expect(wrongAmount.diagnostic.fieldName).toBe("mintAmount");
      expect(wrongAmount.diagnostic.retryable).toBe(false);
    }
  });

  it("redacts provider credentials and bounds oversized raw hex payloads across diagnostics and client errors", async () => {
    const rawMsgWithSecrets = `upstream https://circle_user:superSecretPass@rpc.sepolia.example/v2?apiKey=sk_live_987654&token=tok_abc Bearer jwt_secret_token payload=${raw}`;
    const sanitized = sanitizeCctpDiagnosticText(rawMsgWithSecrets);

    expect(sanitized).not.toContain("superSecretPass");
    expect(sanitized).not.toContain("sk_live_987654");
    expect(sanitized).not.toContain("tok_abc");
    expect(sanitized).not.toContain("jwt_secret_token");
    expect(sanitized).not.toContain(raw);
    expect(sanitized).toContain("[redacted]");
    expect(sanitized).toContain("[len=376B]");
    expect(sanitized.length).toBeLessThanOrEqual(240);

    // IrisClient error path also strips credentials before surfacing RailError
    const iris = new IrisClient("testnet", {
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error:
                "upstream failure at https://svc:secret999@iris.internal/v2?api_key=circle_key_1",
            }),
            { status: 502, headers: { "content-type": "application/json" } },
          ),
        ),
    });
    await expect(
      iris.look({
        transferId: 1n,
        route: RouteKind.Cctp,
        originChain: "sepolia",
        destinationChain: "stellar-testnet",
        nonce: 1n,
        originTx: `0x${"aa".repeat(32)}`,
        status: null,
        checkFailures: 0,
        delivered: false,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      return (
        !msg.includes("secret999") && !msg.includes("circle_key_1") && msg.includes("[redacted]")
      );
    });
  });

  it("keeps missing evidence retryable without ever marking delivery and exposes sanitized diagnostics via HTTP", async () => {
    const config = loadStellarOnlyConfig();
    const stellarNet = config.deployments.networks["stellar-testnet"];
    if (stellarNet?.family !== "stellar") throw new Error("Expected stellar deployment");

    const fixtureExpected: ExpectedCctpTransfer = {
      ...expected,
      sourceToken: stellarNet.tokens.USDC!.sacId,
      sourceAdapter: stellarNet.adapters[RouteKind.Cctp]!,
    };
    const validMsg = buildMessage(fixtureExpected);
    const wrongRecipientMsg = buildMessage({
      ...fixtureExpected,
      recipient: "0x4444444444444444444444444444444444444444",
    });

    const originTx = "71".repeat(32);
    const forwardTxHash: Hex = `0x${"72".repeat(32)}`;
    const blockHash: Hex = `0x${"73".repeat(32)}`;

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
            block: 5441000n,
            txHash: originTx,
            logIndex: 0,
            observedAt: new Date("2026-10-29T11:30:00Z"),
          },
          {
            route: RouteKind.Cctp,
            nonce: 111n,
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
        ["stellar-testnet", "111"],
      );
      const transferId = bigintOf(rows[0]!, "id");
      const pending: PendingTransfer = {
        transferId,
        route: RouteKind.Cctp,
        originChain: "stellar-testnet",
        destinationChain: "sepolia",
        nonce: 111n,
        originTx,
        status: null,
        checkFailures: 0,
        delivered: false,
      };

      // 1. Missing messageBytes -> retryable missing_evidence, never delivered
      await expect(
        verifyCctpDelivery(config, db, pending, reportFor({ status: "pending_confirmations" })),
      ).resolves.toBeNull();
      const d1 = await getCctpVerificationDiagnostic(db, transferId);
      expect(d1?.outcome).toBe("missing_evidence");
      expect(d1?.category).toBe("missing_message_bytes");
      expect(d1?.retryable).toBe(true);

      // 2. Missing forwardTxHash -> retryable missing_evidence, never delivered
      await expect(
        verifyCctpDelivery(
          config,
          db,
          pending,
          reportFor({ status: "complete", messageBytes: validMsg }),
        ),
      ).resolves.toBeNull();
      const d2 = await getCctpVerificationDiagnostic(db, transferId);
      expect(d2?.outcome).toBe("missing_evidence");
      expect(d2?.category).toBe("missing_forward_tx");
      expect(d2?.retryable).toBe(true);

      // 3. Receipt unavailable with credentialed RPC error -> retryable, credentials redacted!
      const unavailableClient: CctpEvmClient = {
        getChainId: () => Promise.resolve(11155111),
        getBlockNumber: () => Promise.resolve(9_000_000n),
        getTransactionReceipt: () =>
          Promise.reject(
            new Error(
              `Receipt missing on https://rpcuser:rpcsecret@sepolia.node/v1?apiKey=secret_rpc_key raw=${validMsg}`,
            ),
          ),
        getBlock: () => Promise.resolve({ hash: blockHash, timestamp: 1_762_500_000n }),
      };
      await expect(
        verifyCctpDelivery(
          config,
          db,
          pending,
          reportFor({ status: "complete", messageBytes: validMsg, forwardTxHash }),
          { evmClient: unavailableClient },
        ),
      ).resolves.toBeNull();
      const d3 = await getCctpVerificationDiagnostic(db, transferId);
      expect(d3?.outcome).toBe("missing_evidence");
      expect(d3?.category).toBe("receipt_unavailable");
      expect(d3?.retryable).toBe(true);
      expect(d3?.detail).not.toContain("rpcsecret");
      expect(d3?.detail).not.toContain("secret_rpc_key");
      expect(d3?.detail).not.toContain(validMsg);

      // 4. Field-level mismatch (wrong recipient) -> non-retryable mismatch exposed cleanly on HTTP API!
      await expect(
        verifyCctpDelivery(
          config,
          db,
          pending,
          reportFor({ status: "complete", messageBytes: wrongRecipientMsg, forwardTxHash }),
          { evmClient: unavailableClient },
        ),
      ).resolves.toBeNull();

      const httpRes = await app.inject(`/v1/transfers/by-tx/${originTx}`);
      expect(httpRes.statusCode).toBe(200);
      expect(httpRes.json().destination.delivered).toBe(false);
      expect(httpRes.json().verificationDiagnostic).toEqual({
        outcome: "mismatch",
        category: "recipient_mismatch",
        retryable: false,
        field: "mintRecipient",
        expected: fixtureExpected.recipient.toLowerCase(),
        observed: "0x4444444444444444444444444444444444444444",
        detail: "CCTP burn mintRecipient disagreed with outbound transfer destination",
        candidateTxHash: forwardTxHash,
        candidateBlock: null,
      });
    } finally {
      await app.close();
      await close();
    }
  });
});
