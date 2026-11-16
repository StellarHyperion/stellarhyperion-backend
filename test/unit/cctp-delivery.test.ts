import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { StrKey } from "@stellar/stellar-sdk";
import { RouteKind, toHex } from "@hyperion/protocol";
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, hexToBytes, type Hex } from "viem";
import { loadConfig, type AppConfig } from "../../src/config/config.js";
import type { QueryResultRows, Queryable, Transactional } from "../../src/db/pool.js";
import { bigintOf, integer, textOrNull } from "../../src/db/rows.js";
import { writeOutbound } from "../../src/chains/writers.js";
import {
  CCTP_RECEIPT_ABI,
  classifyCctpPaymentEvidence,
  matchingCctpPayment,
  verifiedCctpMessage,
  type ExpectedCctpTransfer,
} from "../../src/rails/cctp/events.js";
import {
  verifyCctpDelivery,
  verifyCctpDeliveryClassified,
  type CctpEvmClient,
} from "../../src/rails/cctp/delivery.js";
import type { DeliveryLog } from "../../src/rails/axelar/events.js";
import { IrisClient, reportFor } from "../../src/rails/cctp/iris.js";
import { RailPass } from "../../src/rails/pass.js";
import { RailError, type PendingTransfer } from "../../src/rails/types.js";
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

function buildMessage(target: ExpectedCctpTransfer = expected): Hex {
  const raw = new Uint8Array(148 + 228);
  const view = new DataView(raw.buffer);
  view.setUint32(0, 1);
  view.setUint32(4, 27);
  view.setUint32(8, target.destinationDomain);
  raw.set(hexToBytes(nonce), 12);
  raw.set(StrKey.decodeContract(target.sourceMessenger), 44);
  raw.set(word(target.destinationMessenger), 76);
  view.setUint32(140, 2000);
  view.setUint32(144, 2000);
  view.setUint32(148, 1);
  raw.set(StrKey.decodeContract(target.sourceToken), 152);
  raw.set(word(target.recipient), 184);
  raw.set(word(`0x${(target.sourceAmount / 10n).toString(16)}`), 216);
  raw.set(StrKey.decodeContract(target.sourceAdapter), 248);
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

const SAMPLE_TRANSFER: PendingTransfer = {
  transferId: 1n,
  route: RouteKind.Cctp,
  originChain: "stellar-testnet",
  destinationChain: "sepolia",
  nonce: 1n,
  originTx: "ab".repeat(32),
  status: null,
  checkFailures: 0,
  delivered: false,
};

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

describe("CCTP provider-response resource limits", () => {
  it("cancels oversized streaming envelopes immediately before buffering remaining chunks into memory", async () => {
    let chunksPulled = 0;
    let streamCancelled = false;
    const chunk = new Uint8Array(4096).fill(0x61);

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksPulled += 1;
        if (chunksPulled > 100) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
      cancel() {
        streamCancelled = true;
      },
    });

    const client = new IrisClient("testnet", {
      limits: { maxResponseBytes: 10_000 },
      fetch: () =>
        Promise.resolve(
          new Response(stream, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
    });

    await expect(client.look(SAMPLE_TRANSFER)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof RailError &&
        err.kind === "resourceLimit" &&
        err.limitCode === "response_bytes_exceeded",
    );

    // 3 chunks = 12,288 bytes > 10,000 byte limit; remaining 97 chunks are never pulled!
    expect(chunksPulled).toBeLessThanOrEqual(4);
    expect(streamCancelled).toBe(true);
  });

  it("rejects declared Content-Length overflows before reading the body stream", async () => {
    let pulled = false;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true;
          controller.enqueue(new TextEncoder().encode('{"data":[]}'));
          controller.close();
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );

    const client = new IrisClient("testnet", {
      limits: { maxResponseBytes: 1024 },
      fetch: () =>
        Promise.resolve(
          new Response(stream, {
            status: 200,
            headers: {
              "content-type": "application/json",
              "content-length": "99999999",
            },
          }),
        ),
    });

    await expect(client.look(SAMPLE_TRANSFER)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof RailError &&
        err.kind === "resourceLimit" &&
        err.limitCode === "response_bytes_exceeded",
    );
    expect(pulled).toBe(false);
    expect(cancelled).toBe(true);
  });

  it("enforces JSON nesting depth, structural count, candidate message count, message bytes, and attestation bytes limits", async () => {
    // 1. Deeply nested JSON
    const nested = `${'{"a":'.repeat(20)}1${"}".repeat(20)}`;
    const depthClient = new IrisClient("testnet", {
      limits: { maxJsonDepth: 10 },
      fetch: () => Promise.resolve(new Response(nested, { status: 200 })),
    });
    await expect(depthClient.look(SAMPLE_TRANSFER)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof RailError &&
        err.kind === "resourceLimit" &&
        err.limitCode === "json_depth_exceeded",
    );

    // 2. Excessive JSON tokens
    const manyTokens = JSON.stringify({
      data: Array.from({ length: 30 }, (_, i) => ({
        status: "pending_confirmations",
        id: String(i),
      })),
    });
    const tokenClient = new IrisClient("testnet", {
      limits: { maxJsonValues: 25 },
      fetch: () => Promise.resolve(new Response(manyTokens, { status: 200 })),
    });
    await expect(tokenClient.look(SAMPLE_TRANSFER)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof RailError &&
        err.kind === "resourceLimit" &&
        err.limitCode === "json_tokens_exceeded",
    );

    // 3. Candidate message array count overflow
    const tooManyMessages = JSON.stringify({
      data: Array.from({ length: 5 }, () => ({ status: "pending_confirmations" })),
    });
    const countClient = new IrisClient("testnet", {
      limits: { maxMessages: 3 },
      fetch: () => Promise.resolve(new Response(tooManyMessages, { status: 200 })),
    });
    await expect(countClient.look(SAMPLE_TRANSFER)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof RailError &&
        err.kind === "resourceLimit" &&
        err.limitCode === "message_count_exceeded",
    );

    // 4. Oversized messageBytes hex string
    const hugeMsgPayload = JSON.stringify({
      data: [{ status: "complete", messageBytes: `0x${"ab".repeat(600)}` }],
    });
    const msgSizeClient = new IrisClient("testnet", {
      limits: { maxMessageHexBytes: 512 },
      fetch: () => Promise.resolve(new Response(hugeMsgPayload, { status: 200 })),
    });
    await expect(msgSizeClient.look(SAMPLE_TRANSFER)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof RailError &&
        err.kind === "resourceLimit" &&
        err.limitCode === "message_bytes_exceeded",
    );

    // 5. Oversized attestation hex string
    const hugeAttPayload = JSON.stringify({
      data: [
        {
          status: "complete",
          messageBytes: raw,
          attestation: `0x${"cd".repeat(400)}`,
        },
      ],
    });
    const attSizeClient = new IrisClient("testnet", {
      limits: { maxAttestationHexBytes: 256 },
      fetch: () => Promise.resolve(new Response(hugeAttPayload, { status: 200 })),
    });
    await expect(attSizeClient.look(SAMPLE_TRANSFER)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof RailError &&
        err.kind === "resourceLimit" &&
        err.limitCode === "attestation_bytes_exceeded",
    );
  });

  it("parses valid supported Circle v2 responses unchanged under default limits", async () => {
    const forwardTxHash: Hex = `0x${"cc".repeat(32)}`;
    const attSig = `0x${"dd".repeat(65)}`;
    const validV2 = JSON.stringify({
      data: [
        {
          status: "complete",
          eventNonce: "9001",
          messageBytes: raw,
          attestation: attSig,
          forwardTxHash,
          attestationTimestamp: "2026-10-29T10:15:00.000Z",
          decodedMessage: {
            decodedMessageBody: {
              expirationBlock: "5432100",
            },
          },
        },
      ],
      pagination: { page: 1, pageSize: 10, total: 1 },
    });

    const client = new IrisClient("testnet", {
      fetch: () => Promise.resolve(new Response(validV2, { status: 200 })),
    });

    const lookup = await client.look(SAMPLE_TRANSFER);
    expect(lookup.kind).toBe("found");
    if (lookup.kind !== "found") throw new Error("Expected found lookup");
    expect(lookup.report.status).toBe("attested");
    expect(lookup.report.reference).toBe("9001");
    expect(lookup.report.messageBytes).toBe(raw);
    expect(lookup.report.attestationSignature).toBe(attSig);
    expect(lookup.report.forwardTxHash).toBe(forwardTxHash);
    expect(lookup.report.railStatus).toContain("expires@5432100");
  });

  it("categorizes resource-limit failures separately from invalid payment evidence across events, delivery, and RailPass", async () => {
    // 1. Direct payment evidence classification: wrong recipient vs oversized message vs oversized receipt logs
    const wrongRecipientOutcome = classifyCctpPaymentEvidence([paid, received], raw, {
      ...expected,
      recipient: "0x2222222222222222222222222222222222222222",
    });
    expect(wrongRecipientOutcome).toEqual({ outcome: "invalid_payment_evidence" });

    const oversizedRawOutcome = classifyCctpPaymentEvidence(
      [paid, received],
      `0x${"ff".repeat(600)}`,
      expected,
      { maxMessageHexBytes: 512 },
    );
    expect(oversizedRawOutcome.outcome).toBe("resource_limit");
    if (oversizedRawOutcome.outcome === "resource_limit") {
      expect(oversizedRawOutcome.code).toBe("message_bytes_exceeded");
      expect(oversizedRawOutcome.error.kind).toBe("resourceLimit");
    }

    // 2. End-to-end delivery & RailPass distinction against real embedded PostgreSQL
    const config = loadStellarOnlyConfig();
    const stellarNet = config.deployments.networks["stellar-testnet"];
    if (stellarNet?.family !== "stellar") throw new Error("Expected stellar deployment");

    const fixtureExpected: ExpectedCctpTransfer = {
      ...expected,
      sourceToken: stellarNet.tokens.USDC!.sacId,
      sourceAdapter: stellarNet.adapters[RouteKind.Cctp]!,
    };
    const validMsg = buildMessage(fixtureExpected);
    const forwardTxHash: Hex = `0x${"ee".repeat(32)}`;
    const blockHash: Hex = `0x${"bb".repeat(32)}`;

    const revertedEvmClient: CctpEvmClient = {
      getChainId: () => Promise.resolve(11155111),
      getBlockNumber: () => Promise.resolve(1_000_100n),
      getTransactionReceipt: () =>
        Promise.resolve({
          status: "reverted",
          blockNumber: 1_000_000n,
          blockHash,
          transactionHash: forwardTxHash,
          logs: [],
        }),
      getBlock: () => Promise.resolve({ hash: blockHash, timestamp: 1_762_200_000n }),
    };

    const { db, close } = await createTestDb();
    try {
      await db.transaction(async (tx) => {
        await writeOutbound(
          tx,
          {
            chainKey: "stellar-testnet",
            block: 5437000n,
            txHash: SAMPLE_TRANSFER.originTx,
            logIndex: 0,
            observedAt: new Date("2026-10-29T10:10:00Z"),
          },
          {
            route: RouteKind.Cctp,
            nonce: 55n,
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
        ["stellar-testnet", "55"],
      );
      const transferId = bigintOf(rows[0]!, "id");
      const transfer: PendingTransfer = {
        ...SAMPLE_TRANSFER,
        transferId,
        nonce: 55n,
      };

      // Invalid payment evidence (reverted destination receipt): returns null / invalid_payment_evidence, does NOT throw!
      const candidateReport = reportFor({
        status: "complete",
        eventNonce: "55",
        messageBytes: validMsg,
        forwardTxHash,
      });
      await expect(
        verifyCctpDelivery(config, db, transfer, candidateReport, { evmClient: revertedEvmClient }),
      ).resolves.toBeNull();
      const classifiedInvalid = await verifyCctpDeliveryClassified(
        config,
        db,
        transfer,
        candidateReport,
        { evmClient: revertedEvmClient },
      );
      expect(classifiedInvalid).toEqual({ outcome: "invalid_payment_evidence" });

      // Resource limit violation (oversized receipt log list): throws RailError(kind: "resourceLimit") / outcome: "resource_limit"!
      const floodedLogsClient: CctpEvmClient = {
        ...revertedEvmClient,
        getTransactionReceipt: () =>
          Promise.resolve({
            status: "success",
            blockNumber: 1_000_000n,
            blockHash,
            transactionHash: forwardTxHash,
            logs: Array.from({ length: 12 }, (_, idx) => ({ ...paid, logIndex: idx })),
          }),
      };
      const classifiedLimit = await verifyCctpDeliveryClassified(
        config,
        db,
        transfer,
        candidateReport,
        { evmClient: floodedLogsClient, limits: { maxReceiptLogs: 5 } },
      );
      expect(classifiedLimit.outcome).toBe("resource_limit");
      if (classifiedLimit.outcome === "resource_limit") {
        expect(classifiedLimit.code).toBe("receipt_logs_exceeded");
      }

      // RailPass records resourceLimit with [resource_limit:...] tag while keeping transfer pending
      const { logger } = capturingLogger();
      const pass = new RailPass({
        route: RouteKind.Cctp,
        client: new IrisClient("testnet", {
          limits: { maxResponseBytes: 128 },
          fetch: () => Promise.resolve(new Response("x".repeat(512), { status: 200 })),
        }),
        db,
        logger,
        batchSize: 10,
        recheckAfterMs: 1_000,
        maxCheckFailures: 5,
        config,
      });

      await pass.tick(new AbortController().signal);
      const { rows: attRows } = await db.query(
        "SELECT status, check_failures, last_error FROM rail_attestation WHERE transfer_id = $1",
        [transferId.toString()],
      );
      expect(attRows).toHaveLength(1);
      expect(attRows[0]?.status).toBe("pending");
      expect(integer(attRows[0]!, "check_failures")).toBe(1);
      expect(textOrNull(attRows[0]!, "last_error")).toContain(
        "[resource_limit:response_bytes_exceeded]",
      );
    } finally {
      await close();
    }
  });
});
