import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { StrKey } from "@stellar/stellar-sdk";
import { RAIL_CONTRACTS, RouteKind, assetOn, toHex } from "@hyperion/protocol";
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, hexToBytes, keccak256, type Hex } from "viem";
import { loadConfig, type AppConfig } from "../../src/config/config.js";
import type { QueryResultRows, Queryable, Transactional } from "../../src/db/pool.js";
import { bigintOf } from "../../src/db/rows.js";
import { writeOutbound } from "../../src/chains/writers.js";
import type { DeliveryLog } from "../../src/rails/axelar/events.js";
import {
  verifyCctpDelivery,
  verifyCctpDeliveryWithDiagnostics,
  type CctpEvmClient,
} from "../../src/rails/cctp/delivery.js";
import {
  CCTP_RECEIPT_ABI,
  EIP1967_IMPLEMENTATION_SLOT,
  ZEPPELINOS_IMPLEMENTATION_SLOT,
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
    "1791200000000_cctp-contract-diagnostics.sql",
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

describe("CCTP destination contract code-identity diagnostics", () => {
  const sepoliaContracts = RAIL_CONTRACTS.sepolia?.cctp;
  const sepoliaUsdc = assetOn("sepolia", "USDC");
  if (!sepoliaContracts || sepoliaUsdc?.family !== "evm") {
    throw new Error("Missing Sepolia CCTP registry entries");
  }

  const messengerImplV1: Hex = "0x3333333333333333333333333333333333333333";
  const messengerImplV2: Hex = "0x4444444444444444444444444444444444444444";
  const usdcImplV1: Hex = "0x5555555555555555555555555555555555555555";
  const zeroSlot: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";

  const codeByAddress = (overrides: Record<string, Hex> = {}): Readonly<Record<string, Hex>> => ({
    [sepoliaContracts.tokenMessengerV2.toLowerCase()]: "0x6080604052348015600f57600080fd5b01",
    [sepoliaContracts.messageTransmitterV2.toLowerCase()]: "0x6080604052348015600f57600080fd5b02",
    [sepoliaContracts.tokenMinterV2.toLowerCase()]: "0x6080604052348015600f57600080fd5b03",
    [sepoliaUsdc.address.toLowerCase()]: "0x6080604052348015600f57600080fd5b04",
    [messengerImplV1.toLowerCase()]: "0x6080604052348015600f57600080fd5b11",
    [messengerImplV2.toLowerCase()]: "0x6080604052348015600f57600080fd5b22",
    [usdcImplV1.toLowerCase()]: "0x6080604052348015600f57600080fd5b33",
    ...overrides,
  });

  function padSlotAddress(addr: Hex): Hex {
    return `0x${addr.slice(2).padStart(64, "0")}`;
  }

  it("retains current proof behavior for active known contracts and binds observations to chain and block", async () => {
    const config = loadStellarOnlyConfig();
    const stellarNet = config.deployments.networks["stellar-testnet"];
    if (stellarNet?.family !== "stellar") throw new Error("Expected stellar deployment");

    const fixtureExpected: ExpectedCctpTransfer = {
      ...expected,
      sourceToken: stellarNet.tokens.USDC!.sacId,
      sourceAdapter: stellarNet.adapters[RouteKind.Cctp]!,
    };
    const msgNonceA: Hex = `0x${"a1".repeat(32)}`;
    const msgA = buildMessage(fixtureExpected, msgNonceA);
    const forwardHashA: Hex = `0x${"b1".repeat(32)}`;
    const blockHashA: Hex = `0x${"c1".repeat(32)}`;
    const proofBlockA = 9_600_100n;
    const codes = codeByAddress();
    const observedBlocks: bigint[] = [];

    const evmClient: CctpEvmClient = {
      getChainId: () => Promise.resolve(11155111),
      getBlockNumber: () => Promise.resolve(proofBlockA + 20n),
      getTransactionReceipt: () =>
        Promise.resolve({
          status: "success",
          blockNumber: proofBlockA,
          blockHash: blockHashA,
          transactionHash: forwardHashA,
          logs: buildReceiptLogs(msgA, fixtureExpected),
        }),
      getBlock: () =>
        Promise.resolve({
          hash: blockHashA,
          timestamp: 1_761_800_000n,
        }),
      getCode: ({ address, blockNumber }) => {
        observedBlocks.push(blockNumber);
        return Promise.resolve(codes[address.toLowerCase()] ?? "0x");
      },
      getStorageAt: ({ address, slot, blockNumber }) => {
        observedBlocks.push(blockNumber);
        const lower = address.toLowerCase();
        if (
          lower === sepoliaContracts.tokenMessengerV2.toLowerCase() &&
          slot === EIP1967_IMPLEMENTATION_SLOT
        ) {
          return Promise.resolve(padSlotAddress(messengerImplV1));
        }
        if (
          lower === sepoliaUsdc.address.toLowerCase() &&
          slot === ZEPPELINOS_IMPLEMENTATION_SLOT
        ) {
          return Promise.resolve(padSlotAddress(usdcImplV1));
        }
        return Promise.resolve(zeroSlot);
      },
      readContract: ({ functionName, blockNumber }) => {
        observedBlocks.push(blockNumber);
        switch (functionName) {
          case "localDomain":
            return Promise.resolve(0);
          case "version":
            return Promise.resolve(1);
          case "localMessageTransmitter":
            return Promise.resolve(sepoliaContracts.messageTransmitterV2);
          case "localMinter":
            return Promise.resolve(sepoliaContracts.tokenMinterV2);
          case "remoteTokenMessengers":
            return Promise.resolve(toHex(StrKey.decodeContract(fixtureExpected.sourceMessenger)));
          case "localTokenMessenger":
            return Promise.resolve(sepoliaContracts.tokenMessengerV2);
          case "getLocalToken":
            return Promise.resolve(sepoliaUsdc.address);
          case "decimals":
            return Promise.resolve(6);
        }
      },
    };

    const { db, close } = await createTestDb();
    try {
      await db.transaction(async (tx) => {
        await writeOutbound(
          tx,
          {
            chainKey: "stellar-testnet",
            block: 5434000n,
            txHash: "11".repeat(32),
            logIndex: 0,
            observedAt: new Date("2026-10-29T10:00:00Z"),
          },
          {
            route: RouteKind.Cctp,
            nonce: 1n,
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
        ["stellar-testnet", "1"],
      );
      const transferId = bigintOf(rows[0]!, "id");
      const pending: PendingTransfer = {
        transferId,
        route: RouteKind.Cctp,
        originChain: "stellar-testnet",
        destinationChain: "sepolia",
        nonce: 1n,
        originTx: "11".repeat(32),
        status: "attested",
        checkFailures: 0,
        delivered: false,
      };
      const report = reportFor({
        status: "complete",
        messageBytes: msgA,
        forwardTxHash: forwardHashA,
      });

      const outcome = await verifyCctpDeliveryWithDiagnostics(config, db, pending, report, {
        evmClient,
      });
      expect(outcome.delivery).not.toBeNull();
      expect(outcome.delivery?.row.amount).toBe(99600000n);
      expect(outcome.diagnostic?.verdict).toBe("verified");
      expect(outcome.diagnostic?.destinationChain).toBe("sepolia");
      expect(outcome.diagnostic?.chainId).toBe(11155111);
      expect(outcome.diagnostic?.blockNumber).toBe(proofBlockA);
      expect(outcome.diagnostic?.blockHash).toBe(blockHashA);
      expect(outcome.diagnostic?.observations.token_messenger_v2.implementationAddress).toBe(
        messengerImplV1,
      );
      expect(outcome.diagnostic?.observations.token_messenger_v2.implementationCodeHash).toBe(
        keccak256(codes[messengerImplV1.toLowerCase()]!),
      );
      expect(observedBlocks.every((b) => b === proofBlockA)).toBe(true);

      // Now simulate an unreviewed proxy implementation upgrade at a later block for transfer #2
      await db.transaction(async (tx) => {
        await writeOutbound(
          tx,
          {
            chainKey: "stellar-testnet",
            block: 5434001n,
            txHash: "22".repeat(32),
            logIndex: 0,
            observedAt: new Date("2026-10-29T10:01:00Z"),
          },
          {
            route: RouteKind.Cctp,
            nonce: 2n,
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
      const { rows: rows2 } = await db.query(
        "SELECT id FROM outbound_transfer WHERE origin_chain = $1 AND nonce = $2",
        ["stellar-testnet", "2"],
      );
      const transferId2 = bigintOf(rows2[0]!, "id");
      const msgB = buildMessage(fixtureExpected, `0x${"a2".repeat(32)}`);
      const forwardHashB: Hex = `0x${"b2".repeat(32)}`;
      const blockHashB: Hex = `0x${"c2".repeat(32)}`;
      const proofBlockB = 9_600_250n;

      const upgradedClient: CctpEvmClient = {
        ...evmClient,
        getBlockNumber: () => Promise.resolve(proofBlockB + 20n),
        getTransactionReceipt: () =>
          Promise.resolve({
            status: "success",
            blockNumber: proofBlockB,
            blockHash: blockHashB,
            transactionHash: forwardHashB,
            logs: buildReceiptLogs(msgB, fixtureExpected),
          }),
        getBlock: () =>
          Promise.resolve({
            hash: blockHashB,
            timestamp: 1_761_801_000n,
          }),
        getStorageAt: ({ address, slot }) => {
          const lower = address.toLowerCase();
          if (
            lower === sepoliaContracts.tokenMessengerV2.toLowerCase() &&
            slot === EIP1967_IMPLEMENTATION_SLOT
          ) {
            return Promise.resolve(padSlotAddress(messengerImplV2));
          }
          if (
            lower === sepoliaUsdc.address.toLowerCase() &&
            slot === ZEPPELINOS_IMPLEMENTATION_SLOT
          ) {
            return Promise.resolve(padSlotAddress(usdcImplV1));
          }
          return Promise.resolve(zeroSlot);
        },
      };

      const pending2: PendingTransfer = {
        transferId: transferId2,
        route: RouteKind.Cctp,
        originChain: "stellar-testnet",
        destinationChain: "sepolia",
        nonce: 2n,
        originTx: "22".repeat(32),
        status: "attested",
        checkFailures: 0,
        delivered: false,
      };
      const report2 = reportFor({
        status: "complete",
        messageBytes: msgB,
        forwardTxHash: forwardHashB,
      });

      const upgradeOutcome = await verifyCctpDeliveryWithDiagnostics(
        config,
        db,
        pending2,
        report2,
        { evmClient: upgradedClient },
      );
      expect(upgradeOutcome.delivery).toBeNull();
      expect(upgradeOutcome.diagnostic?.verdict).toBe("unexpected_upgrade");
      expect(upgradeOutcome.diagnostic?.blockNumber).toBe(proofBlockB);
      expect(upgradeOutcome.diagnostic?.blockHash).toBe(blockHashB);
      expect(
        upgradeOutcome.diagnostic?.issues.some(
          (i) => i.role === "token_messenger_v2" && i.kind === "unexpected_upgrade",
        ),
      ).toBe(true);

      const { rows: persistedDiag } = await db.query(
        "SELECT destination_chain, block_number, block_hash, verdict FROM cctp_contract_diagnostic WHERE transfer_id = $1",
        [String(transferId2)],
      );
      expect(persistedDiag).toEqual([
        {
          destination_chain: "sepolia",
          block_number: String(proofBlockB),
          block_hash: blockHashB.toLowerCase(),
          verdict: "unexpected_upgrade",
        },
      ]);
    } finally {
      await close();
    }
  });

  it("refuses delivery when contract bytecode is absent or peer/token wiring mismatches", async () => {
    const config = loadStellarOnlyConfig();
    const stellarNet = config.deployments.networks["stellar-testnet"];
    if (stellarNet?.family !== "stellar") throw new Error("Expected stellar deployment");

    const fixtureExpected: ExpectedCctpTransfer = {
      ...expected,
      sourceToken: stellarNet.tokens.USDC!.sacId,
      sourceAdapter: stellarNet.adapters[RouteKind.Cctp]!,
    };
    const msgC = buildMessage(fixtureExpected, `0x${"a3".repeat(32)}`);
    const forwardHashC: Hex = `0x${"b3".repeat(32)}`;
    const blockHashC: Hex = `0x${"c3".repeat(32)}`;
    const proofBlockC = 9_600_500n;
    const codesMissingTransmitter = codeByAddress({
      [sepoliaContracts.messageTransmitterV2.toLowerCase()]: "0x",
    });

    const mismatchedClient: CctpEvmClient = {
      getChainId: () => Promise.resolve(11155111),
      getBlockNumber: () => Promise.resolve(proofBlockC + 20n),
      getTransactionReceipt: () =>
        Promise.resolve({
          status: "success",
          blockNumber: proofBlockC,
          blockHash: blockHashC,
          transactionHash: forwardHashC,
          logs: buildReceiptLogs(msgC, fixtureExpected),
        }),
      getBlock: () =>
        Promise.resolve({
          hash: blockHashC,
          timestamp: 1_761_802_000n,
        }),
      getCode: ({ address }) =>
        Promise.resolve(codesMissingTransmitter[address.toLowerCase()] ?? "0x"),
      getStorageAt: () => Promise.resolve(zeroSlot),
      readContract: ({ functionName }) => {
        switch (functionName) {
          case "localDomain":
            return Promise.resolve(0);
          case "version":
            return Promise.resolve(1);
          case "localMessageTransmitter":
            return Promise.resolve(sepoliaContracts.messageTransmitterV2);
          case "localMinter":
            return Promise.resolve(sepoliaContracts.tokenMinterV2);
          case "remoteTokenMessengers":
            // Wrong peer Stellar messenger!
            return Promise.resolve(`0x${"99".repeat(32)}`);
          case "localTokenMessenger":
            return Promise.resolve(sepoliaContracts.tokenMessengerV2);
          case "getLocalToken":
            return Promise.resolve(sepoliaUsdc.address);
          case "decimals":
            return Promise.resolve(6);
        }
      },
    };

    const { db, close } = await createTestDb();
    try {
      await db.transaction(async (tx) => {
        await writeOutbound(
          tx,
          {
            chainKey: "stellar-testnet",
            block: 5434010n,
            txHash: "33".repeat(32),
            logIndex: 0,
            observedAt: new Date("2026-10-29T10:05:00Z"),
          },
          {
            route: RouteKind.Cctp,
            nonce: 3n,
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
        ["stellar-testnet", "3"],
      );
      const transferId = bigintOf(rows[0]!, "id");
      const pending: PendingTransfer = {
        transferId,
        route: RouteKind.Cctp,
        originChain: "stellar-testnet",
        destinationChain: "sepolia",
        nonce: 3n,
        originTx: "33".repeat(32),
        status: "attested",
        checkFailures: 0,
        delivered: false,
      };
      const report = reportFor({
        status: "complete",
        messageBytes: msgC,
        forwardTxHash: forwardHashC,
      });

      const verifiedNull = await verifyCctpDelivery(config, db, pending, report, {
        evmClient: mismatchedClient,
      });
      expect(verifiedNull).toBeNull();

      const outcome = await verifyCctpDeliveryWithDiagnostics(config, db, pending, report, {
        evmClient: mismatchedClient,
      });
      expect(outcome.delivery).toBeNull();
      expect(outcome.diagnostic?.verdict).toBe("mismatch");
      expect(outcome.diagnostic?.issues.map((i) => i.kind)).toEqual(
        expect.arrayContaining(["empty_code", "peer_messenger_mismatch"]),
      );
    } finally {
      await close();
    }
  });
});
