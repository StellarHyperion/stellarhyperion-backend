import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import {
  AddressKind,
  CHAINS,
  RAIL_CONTRACTS,
  assetOn,
  encodeStellarAddress,
  isEvmChain,
  toHex,
} from "@hyperion/protocol";
import { StrKey } from "@stellar/stellar-sdk";
import { encodeAbiParameters, encodeEventTopics, hexToBytes, type Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";

import { PolledWorker } from "../../src/chains/runner.js";
import { writeAttestation, writeOutbound } from "../../src/chains/writers.js";
import { loadConfig } from "../../src/config/config.js";
import type { Queryable, QueryResultRows, Transactional } from "../../src/db/pool.js";
import { bigintOf, integer, text } from "../../src/db/rows.js";
import { AxelarGmpClient } from "../../src/rails/axelar/gmp.js";
import {
  CCTP_RECEIPT_ABI,
  verifiedCctpMessage,
  type ExpectedCctpTransfer,
} from "../../src/rails/cctp/events.js";
import { IrisClient } from "../../src/rails/cctp/iris.js";
import { RailPass } from "../../src/rails/pass.js";
import {
  RailError,
  type PendingTransfer,
  type RailClient,
  type RailLookup,
} from "../../src/rails/types.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const MIGRATIONS = [
  "1790900000000_initial-schema.sql",
  "1791000000000_cursor-block-hash.sql",
  "1791100000000_cursor-autovacuum-tuning.sql",
] as const;

interface PGliteHarness extends Transactional {
  close(): Promise<void>;
}

async function openPGlite(): Promise<PGliteHarness> {
  const pg = await PGlite.create();
  const query = async (sql: string, params: readonly unknown[] = []): Promise<QueryResultRows> => {
    const normalized = params.map((p) => (p instanceof Date ? p.toISOString() : p));
    const result =
      normalized.length === 0 && sql.includes(";")
        ? await (async () => {
            await pg.exec(sql);
            return { rows: [], fields: [], affectedRows: 0 };
          })()
        : await pg.query(sql, normalized);

    const int8Cols = result.fields.filter((f) => f.dataTypeID === 20).map((f) => f.name);
    const rows = result.rows.map((raw) => {
      const copy = { ...(raw as Record<string, unknown>) };
      for (const col of int8Cols) {
        const val = copy[col];
        if (typeof val === "number" || typeof val === "bigint") {
          copy[col] = String(val);
        }
      }
      return copy;
    });
    return { rows, rowCount: result.affectedRows ?? rows.length };
  };

  for (const file of MIGRATIONS) {
    const path = fileURLToPath(new URL(`../../migrations/${file}`, import.meta.url));
    const upSql = readFileSync(path, "utf8").split(/^--\s*Down Migration\b/m)[0] ?? "";
    await query(upSql);
  }

  return {
    query,
    async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
      await pg.exec("BEGIN");
      try {
        const out = await work({ query });
        await pg.exec("COMMIT");
        return out;
      } catch (err) {
        await pg.exec("ROLLBACK");
        throw err;
      }
    },
    async close(): Promise<void> {
      await pg.close();
    },
  };
}

const STELLAR_DEST = encodeStellarAddress(AddressKind.Account, `0x${"12".repeat(32)}`);

describe("cancellation-aware rail passes (#90)", () => {
  const openDbs: PGliteHarness[] = [];

  afterEach(async () => {
    while (openDbs.length > 0) {
      const db = openDbs.pop();
      if (db !== undefined) await db.close();
    }
  });

  it("aborts IrisClient and AxelarGmpClient HTTP reads as cancelled rather than permanent failures", async () => {
    const sampleTransfer: PendingTransfer = {
      transferId: 1n,
      route: 0,
      originChain: "sepolia",
      destinationChain: "stellar-testnet",
      nonce: 1n,
      originTx: `0x${"aa".repeat(32)}`,
      status: null,
      checkFailures: 0,
      delivered: false,
    };

    const abortAwareFetch = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal;
        if (sig?.aborted) {
          reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
          return;
        }
        sig?.addEventListener(
          "abort",
          () => {
            reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
          },
          { once: true },
        );
      })) as typeof globalThis.fetch;

    const c1 = new AbortController();
    const irisPromise = new IrisClient("testnet", { fetch: abortAwareFetch }).look(
      sampleTransfer,
      c1.signal,
    );
    c1.abort();
    await expect(irisPromise).rejects.toSatisfy(
      (err: unknown) => err instanceof RailError && err.kind === "cancelled",
    );

    const c2 = new AbortController();
    const axelarPromise = new AxelarGmpClient("https://testnet.api.gmp.axelarscan.io", {
      fetch: abortAwareFetch,
    }).look({ ...sampleTransfer, route: 1 }, c2.signal);
    c2.abort();
    await expect(axelarPromise).rejects.toSatisfy(
      (err: unknown) => err instanceof RailError && err.kind === "cancelled",
    );
  });

  it("completes cancellation within the configured shutdown budget even when a provider ignores AbortSignal", async () => {
    const db = await openPGlite();
    openDbs.push(db);
    const { logger } = capturingLogger();
    const now = new Date("2026-10-16T10:00:00.000Z");

    await db.transaction(async (tx) => {
      await writeOutbound(
        tx,
        {
          chainKey: "sepolia",
          block: 1000n,
          txHash: `0x${"b1".repeat(32)}`,
          logIndex: 0,
          observedAt: now,
        },
        {
          route: 0,
          nonce: 1n,
          sender: `0x${"22".repeat(20)}`,
          token: `0x${"33".repeat(20)}`,
          grossAmount: 10_000_000n,
          fee: 0n,
          netAmount: 10_000_000n,
          destinationChain: "stellar-testnet",
          destination: STELLAR_DEST,
          railRef: null,
        },
      );
    });

    let enteredLook!: () => void;
    const lookStarted = new Promise<void>((resolve) => {
      enteredLook = resolve;
    });

    // Wedged client that never resolves and ignores AbortSignal completely.
    const wedgedClient: RailClient = {
      rail: "cctp",
      look(): Promise<RailLookup> {
        enteredLook();
        return new Promise<RailLookup>(() => undefined);
      },
    };

    const pass = new RailPass({
      route: 0,
      client: wedgedClient,
      db,
      logger,
      batchSize: 10,
      recheckAfterMs: 60_000,
      maxCheckFailures: 5,
      shutdownBudgetMs: 35,
      now: () => now,
    });

    const worker = new PolledWorker(pass, 10_000, logger);
    worker.start();
    await lookStarted;

    const stopStart = Date.now();
    await worker.stop();
    const elapsedMs = Date.now() - stopStart;

    expect(elapsedMs).toBeLessThan(350);
    expect(pass.progress?.cancelled).toBe(true);
    expect(pass.progress?.failures).toBe(0);
  });

  it("never advances an incomplete destination verification to delivered when aborted mid-verification", async () => {
    const db = await openPGlite();
    openDbs.push(db);
    const config = loadConfig({ env: completeEnv() });
    const { logger } = capturingLogger();

    const stellarDeploy = config.deployments.networks["stellar-testnet"];
    const sepoliaChain = CHAINS.sepolia;
    const cctpContracts = RAIL_CONTRACTS.sepolia?.cctp;
    const sepoliaUsdc = assetOn("sepolia", "USDC");
    if (
      stellarDeploy?.family !== "stellar" ||
      !isEvmChain(sepoliaChain) ||
      !cctpContracts ||
      sepoliaUsdc?.family !== "evm" ||
      sepoliaChain.cctpDomain === null
    ) {
      throw new Error("Expected testnet CCTP fixtures");
    }

    const sacId = stellarDeploy.tokens.USDC?.sacId ?? "";
    const adapter = stellarDeploy.adapters[0] ?? "";
    const recipient = "0x1111111111111111111111111111111111111111";
    const expected: ExpectedCctpTransfer = {
      sourceToken: sacId,
      sourceAdapter: adapter,
      sourceMessenger: "CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP",
      destinationDomain: sepoliaChain.cctpDomain,
      destinationMessenger: cctpContracts.tokenMessengerV2,
      transmitter: cctpContracts.messageTransmitterV2,
      token: sepoliaUsdc.address,
      recipient,
      sourceAmount: 40_000_000n,
    };

    const padWord = (addr: string): Uint8Array =>
      hexToBytes(`0x${addr.slice(2).padStart(64, "0")}`);
    const msgNonce: Hex = `0x${"81".repeat(32)}`;
    const raw = new Uint8Array(148 + 228);
    const view = new DataView(raw.buffer);
    view.setUint32(0, 1);
    view.setUint32(4, 27);
    view.setUint32(8, expected.destinationDomain);
    raw.set(hexToBytes(msgNonce), 12);
    raw.set(StrKey.decodeContract(expected.sourceMessenger), 44);
    raw.set(padWord(expected.destinationMessenger), 76);
    view.setUint32(140, 2000);
    view.setUint32(144, 2000);
    view.setUint32(148, 1);
    raw.set(StrKey.decodeContract(expected.sourceToken), 152);
    raw.set(padWord(expected.recipient), 184);
    raw.set(padWord(`0x${(expected.sourceAmount / 10n).toString(16)}`), 216);
    raw.set(StrKey.decodeContract(expected.sourceAdapter), 248);
    raw.set(padWord(`0x${500000n.toString(16)}`), 280);
    raw.set(padWord(`0x${100000n.toString(16)}`), 312);
    const rawHex = toHex(raw);
    const parsed = verifiedCctpMessage(rawHex, expected);
    if (!parsed) throw new Error("Expected valid CCTP message");

    const receiveLog = {
      address: expected.transmitter as Hex,
      topics: encodeEventTopics({
        abi: CCTP_RECEIPT_ABI,
        eventName: "MessageReceived",
        args: { caller: recipient as Hex, nonce: msgNonce, finalityThresholdExecuted: 2000 },
      }) as [Hex, ...Hex[]],
      data: encodeAbiParameters(
        [{ type: "uint32" }, { type: "bytes32" }, { type: "bytes" }],
        [27, parsed.message.sender, parsed.body],
      ),
      logIndex: 0,
    };
    const mintLog = {
      address: expected.token as Hex,
      topics: encodeEventTopics({
        abi: CCTP_RECEIPT_ABI,
        eventName: "Transfer",
        args: { from: `0x${"0".repeat(40)}`, to: recipient as Hex },
      }) as [Hex, ...Hex[]],
      data: encodeAbiParameters([{ type: "uint256" }], [parsed.amount]),
      logIndex: 1,
    };

    const now = new Date("2026-10-16T11:00:00.000Z");
    await db.transaction(async (tx) => {
      await writeOutbound(
        tx,
        {
          chainKey: "stellar-testnet",
          block: 2000n,
          txHash: `0x${"c1".repeat(32)}`,
          logIndex: null,
          observedAt: now,
        },
        {
          route: 0,
          nonce: 55n,
          sender: stellarDeploy.admin,
          token: sacId,
          grossAmount: 40_000_000n,
          fee: 0n,
          netAmount: 40_000_000n,
          destinationChain: "sepolia",
          destination: `0x${recipient.slice(2).padStart(64, "0")}`,
          railRef: null,
        },
      );
    });

    const controller = new AbortController();
    const blockHash: Hex = `0x${"dd".repeat(32)}`;
    const forwardTx: Hex = `0x${"ee".repeat(32)}`;

    const pass = new RailPass({
      route: 0,
      config,
      client: {
        rail: "cctp",
        look(): Promise<RailLookup> {
          return Promise.resolve({
            kind: "found",
            report: {
              status: "attested",
              railStatus: "complete",
              reference: "iris-55",
              attestedAt: now,
              forwardTxHash: forwardTx,
              messageBytes: rawHex,
            },
          });
        },
      },
      db,
      logger,
      batchSize: 10,
      recheckAfterMs: 60_000,
      maxCheckFailures: 5,
      shutdownBudgetMs: 100,
      now: () => now,
      evmClient: {
        getChainId: () => Promise.resolve(sepoliaChain.chainId),
        getTransactionReceipt: () =>
          Promise.resolve({
            status: "success",
            blockNumber: 5000n,
            blockHash,
            transactionHash: forwardTx,
            logs: [receiveLog, mintLog],
          }),
        getBlockNumber: () => Promise.resolve(5100n),
        getBlock: () => {
          // Abort fires right before canonical block confirmation finishes!
          controller.abort();
          return Promise.resolve({ hash: blockHash, timestamp: 1_790_000_000n });
        },
      },
    });

    const more = await pass.tick(controller.signal);
    expect(more).toBe(false);
    expect(pass.progress?.cancelled).toBe(true);

    const inboundRows = await db.query("SELECT count(*)::int AS n FROM inbound_delivery");
    expect(inboundRows.rows[0]?.n).toBe(0);

    const deliveredRows = await db.query(
      "SELECT count(*)::int AS n FROM rail_attestation WHERE status = 'delivered'",
    );
    expect(deliveredRows.rows[0]?.n).toBe(0);
  });

  it("preserves already committed progress and resumes remaining candidates on restart using durable retry state", async () => {
    const db = await openPGlite();
    openDbs.push(db);
    const { logger } = capturingLogger();

    const t0 = new Date("2026-10-16T12:00:00.000Z");
    const priorCheckAt = new Date("2026-10-16T11:50:00.000Z");
    const passOneTime = new Date("2026-10-16T12:05:00.000Z");
    const passTwoTime = new Date("2026-10-16T12:05:10.000Z");

    await db.transaction(async (tx) => {
      for (const nonce of [1n, 2n, 3n]) {
        await writeOutbound(
          tx,
          {
            chainKey: "sepolia",
            block: 3000n + nonce,
            txHash: `0x${nonce.toString(16).padStart(64, "0")}`,
            logIndex: 0,
            observedAt: t0,
          },
          {
            route: 0,
            nonce,
            sender: `0x${"22".repeat(20)}`,
            token: `0x${"33".repeat(20)}`,
            grossAmount: 10_000_000n * nonce,
            fee: 0n,
            netAmount: 10_000_000n * nonce,
            destinationChain: "stellar-testnet",
            destination: STELLAR_DEST,
            railRef: null,
          },
        );
      }
    });

    const idRows = await db.query(
      "SELECT id, nonce::text AS nonce FROM outbound_transfer ORDER BY nonce ASC",
    );
    const id2 = bigintOf(idRows.rows[1] ?? {}, "id");

    // Seed durable retry state on Transfer 2 (check_failures = 2, checked 15 minutes ago)
    // and Transfer 1 (checked 16 minutes ago so Queue orders 3 NULLS FIRST, then 1, then 2).
    const id1 = bigintOf(idRows.rows[0] ?? {}, "id");
    await db.transaction(async (tx) => {
      await writeAttestation(tx, {
        transferId: id1,
        route: 0,
        status: "pending",
        railStatus: "pending_confirmations",
        railReference: "ref-1",
        attestedAt: null,
        checkedAt: new Date(priorCheckAt.getTime() - 60_000),
        checkFailures: 0,
        lastError: null,
      });
      await writeAttestation(tx, {
        transferId: id2,
        route: 0,
        status: "pending",
        railStatus: "pending_confirmations",
        railReference: "ref-2",
        attestedAt: null,
        checkedAt: priorCheckAt,
        checkFailures: 2,
        lastError: "previous transient timeout",
      });
    });

    // Queue order for Pass 1: nonce 3 (last_checked_at IS NULL), then nonce 1, then nonce 2.
    // Let nonce 3 commit as attested, then abort while nonce 2 (or nonce 1) is in flight!
    const passOneSeenNonces: bigint[] = [];
    const passOneController = new AbortController();

    const passOne = new RailPass({
      route: 0,
      client: {
        rail: "cctp",
        look(transfer: PendingTransfer, signal?: AbortSignal): Promise<RailLookup> {
          passOneSeenNonces.push(transfer.nonce);
          if (transfer.nonce === 3n) {
            return Promise.resolve({
              kind: "found",
              report: {
                status: "attested",
                railStatus: "complete",
                reference: "ref-3",
                attestedAt: passOneTime,
              },
            });
          }
          // Second item in queue (nonce 1) aborts mid-read!
          return new Promise<RailLookup>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                reject(new RailError("cctp", "cancelled", "cancelled"));
              },
              { once: true },
            );
            passOneController.abort();
          });
        },
      },
      db,
      logger,
      batchSize: 10,
      recheckAfterMs: 60_000,
      maxCheckFailures: 5,
      shutdownBudgetMs: 200,
      now: () => passOneTime,
    });

    await passOne.tick(passOneController.signal);

    // Nonce 3 committed; nonce 1 aborted mid-lookup; nonce 2 never started!
    expect(passOneSeenNonces).toEqual([3n, 1n]);

    const afterPassOne = await db.query(
      `SELECT t.nonce::text AS nonce, a.status, a.check_failures
         FROM outbound_transfer t
         JOIN rail_attestation a ON a.transfer_id = t.id
        ORDER BY t.nonce ASC`,
    );
    expect(
      afterPassOne.rows.map((r) => ({
        nonce: text(r, "nonce"),
        status: text(r, "status"),
        failures: integer(r, "check_failures"),
      })),
    ).toEqual([
      { nonce: "1", status: "pending", failures: 0 },
      { nonce: "2", status: "pending", failures: 2 },
      { nonce: "3", status: "attested", failures: 0 },
    ]);

    // Restarted RailPass (10s later, well within 60s recheckAfterMs so already-checked nonce 3 is skipped,
    // while eligible nonces 1 and 2 with preserved durable retry state ARE picked up immediately!):
    const restartedSeen: { nonce: bigint; checkFailures: number }[] = [];
    const passTwo = new RailPass({
      route: 0,
      client: {
        rail: "cctp",
        look(transfer: PendingTransfer): Promise<RailLookup> {
          restartedSeen.push({ nonce: transfer.nonce, checkFailures: transfer.checkFailures });
          return Promise.resolve({
            kind: "found",
            report: {
              status: "attested",
              railStatus: "complete",
              reference: `ref-${transfer.nonce.toString()}`,
              attestedAt: passTwoTime,
            },
          });
        },
      },
      db,
      logger,
      batchSize: 10,
      recheckAfterMs: 60_000,
      maxCheckFailures: 5,
      shutdownBudgetMs: 200,
      now: () => passTwoTime,
    });

    await passTwo.tick(new AbortController().signal);

    expect(restartedSeen).toEqual([
      { nonce: 1n, checkFailures: 0 },
      { nonce: 2n, checkFailures: 2 },
    ]);
  });
});
