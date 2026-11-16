/**
 * Reproducible local multi-service recovery rehearsal.
 *
 * Exercises separate API-only and worker configurations against shared PostgreSQL storage and
 * loopback mock providers (Soroban RPC, Circle Iris, Axelar GMP, and Sepolia JSON-RPC) using
 * dedicated rehearsal fixtures and zero production resources.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { StrKey } from "@stellar/stellar-sdk";
import {
  CHAINS,
  RAIL_CONTRACTS,
  RouteKind,
  assetOn,
  isEvmChain,
  isStellarDeployment,
  toHex,
} from "@hyperion/protocol";
import { encodeAbiParameters, encodeEventTopics, hexToBytes, type Hex } from "viem";

import { buildIndexer } from "../chains/runner.js";
import { writeInbound } from "../chains/writers.js";
import { endOfLedgerCursor } from "../chains/stellar/cursor.js";
import type { RawStellarEvent } from "../chains/stellar/events.js";
import { loadConfig } from "../config/config.js";
import type { Database, Queryable, QueryResultRows, Transactional } from "../db/pool.js";
import { buildServer } from "../http/server.js";
import { createLogger, type Logger } from "../logging/logger.js";
import { verifyCctpDelivery } from "../rails/cctp/delivery.js";
import {
  CCTP_RECEIPT_ABI,
  verifiedCctpMessage,
  type ExpectedCctpTransfer,
} from "../rails/cctp/events.js";
import { IrisClient } from "../rails/cctp/iris.js";

const END_OF_WINDOW_INDEX = 0xffff_ffff;
const START_WINDOW = 10_000;
const CURSOR_WINDOW = 9_999;

export type SepoliaReceiptMode = "missing" | "reverted" | "unconfirmed" | "confirmed";
export type IrisLookupMode = "missing" | "complete";
export type AxelarLookupMode = "missing" | "executed_without_receipt";

export interface RehearsalProviderState {
  sorobanHttpStatus: number | null;
  irisHttpStatus: number | null;
  axelarHttpStatus: number | null;
  latestLedger: number;
  irisMode: IrisLookupMode;
  axelarMode: AxelarLookupMode;
  sepoliaReceiptMode: SepoliaReceiptMode;
}

export interface RecordedSorobanCall {
  readonly method: string;
  readonly startLedger: number | null;
  readonly cursor: string | null;
}

export interface RehearsalProvidersHandle {
  readonly port: number;
  readonly urls: {
    readonly sorobanUrl: string;
    readonly irisUrl: string;
    readonly axelarUrl: string;
    readonly sepoliaUrl: string;
  };
  readonly state: RehearsalProviderState;
  readonly sorobanCalls: RecordedSorobanCall[];
  readonly forwardTxHash: Hex;
  close(): Promise<void>;
}

export interface CreateRehearsalProvidersOptions {
  readonly host?: string;
  readonly port?: number;
  readonly events: readonly RawStellarEvent[];
  readonly sourceTokenSacId: string;
  readonly sourceCctpAdapter: string;
  readonly recipientAddress: Hex;
  readonly sourceNetAmount: bigint;
  readonly latestLedger?: number;
}

function padWord(addressOrHex: string): Uint8Array {
  const clean = addressOrHex.startsWith("0x") ? addressOrHex.slice(2) : addressOrHex;
  return hexToBytes(`0x${clean.padStart(64, "0")}`);
}

function buildCctpRehearsalFixture(input: {
  readonly sourceTokenSacId: string;
  readonly sourceCctpAdapter: string;
  readonly recipientAddress: Hex;
  readonly sourceNetAmount: bigint;
}): {
  readonly nonce: Hex;
  readonly forwardTxHash: Hex;
  readonly blockHash: Hex;
  readonly messageBytes: Hex;
  readonly mintAmount: bigint;
  readonly logs: readonly {
    readonly address: Hex;
    readonly topics: readonly Hex[];
    readonly data: Hex;
    readonly logIndex: Hex;
  }[];
} {
  const sepolia = CHAINS.sepolia;
  const contracts = RAIL_CONTRACTS.sepolia?.cctp;
  const token = assetOn("sepolia", "USDC");
  if (!contracts || token?.family !== "evm" || sepolia.cctpDomain === null) {
    throw new Error("Sepolia CCTP registry metadata is unavailable.");
  }

  const expected: ExpectedCctpTransfer = {
    sourceToken: input.sourceTokenSacId,
    sourceAdapter: input.sourceCctpAdapter,
    sourceMessenger: "CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP",
    destinationDomain: sepolia.cctpDomain,
    destinationMessenger: contracts.tokenMessengerV2,
    transmitter: contracts.messageTransmitterV2,
    token: token.address,
    recipient: input.recipientAddress,
    sourceAmount: input.sourceNetAmount,
  };

  const nonce: Hex = `0x${"ab".repeat(32)}`;
  const forwardTxHash: Hex = `0x${"c1".repeat(32)}`;
  const blockHash: Hex = `0x${"b1".repeat(32)}`;

  const raw = new Uint8Array(148 + 228);
  const view = new DataView(raw.buffer);
  view.setUint32(0, 1);
  view.setUint32(4, 27);
  view.setUint32(8, expected.destinationDomain);
  raw.set(hexToBytes(nonce), 12);
  raw.set(StrKey.decodeContract(expected.sourceMessenger), 44);
  raw.set(padWord(expected.destinationMessenger), 76);
  view.setUint32(140, 2000);
  view.setUint32(144, 2000);
  view.setUint32(148, 1);
  raw.set(StrKey.decodeContract(expected.sourceToken), 152);
  raw.set(padWord(expected.recipient), 184);
  const grossMint = expected.sourceAmount / 10n;
  const feeExecuted = 1_000n;
  raw.set(padWord(`0x${grossMint.toString(16)}`), 216);
  raw.set(StrKey.decodeContract(expected.sourceAdapter), 248);
  raw.set(padWord(`0x${5_000n.toString(16)}`), 280);
  raw.set(padWord(`0x${feeExecuted.toString(16)}`), 312);

  const messageBytes = toHex(raw);
  const verified = verifiedCctpMessage(messageBytes, expected);
  if (!verified) {
    throw new Error("Rehearsal CCTP message failed self-verification.");
  }

  const receivedTopics = encodeEventTopics({
    abi: CCTP_RECEIPT_ABI,
    eventName: "MessageReceived",
    args: {
      caller: input.recipientAddress,
      nonce,
      finalityThresholdExecuted: 2000,
    },
  }) as readonly Hex[];
  const receivedData = encodeAbiParameters(
    [{ type: "uint32" }, { type: "bytes32" }, { type: "bytes" }],
    [27, verified.message.sender, verified.body],
  );

  const paidTopics = encodeEventTopics({
    abi: CCTP_RECEIPT_ABI,
    eventName: "Transfer",
    args: {
      from: `0x${"0".repeat(40)}`,
      to: input.recipientAddress,
    },
  }) as readonly Hex[];
  const paidData = encodeAbiParameters([{ type: "uint256" }], [verified.amount]);

  return {
    nonce,
    forwardTxHash,
    blockHash,
    messageBytes,
    mintAmount: verified.amount,
    logs: [
      {
        address: token.address,
        topics: paidTopics,
        data: paidData,
        logIndex: "0x0",
      },
      {
        address: contracts.messageTransmitterV2,
        topics: receivedTopics,
        data: receivedData,
        logIndex: "0x1",
      },
    ],
  };
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function formatEndCursor(windowEnd: number): string {
  const toid = ((BigInt(windowEnd) + 1n) << 32n) - 1n;
  return `${toid.toString().padStart(19, "0")}-${String(END_OF_WINDOW_INDEX).padStart(10, "0")}`;
}

export async function createRehearsalProviders(
  options: CreateRehearsalProvidersOptions,
): Promise<RehearsalProvidersHandle> {
  const sortedEvents = [...options.events].sort((a, b) => a.id.localeCompare(b.id));
  const highestEventLedger = sortedEvents.reduce(
    (max, item) => Math.max(max, item.ledger),
    6100100,
  );
  const state: RehearsalProviderState = {
    sorobanHttpStatus: null,
    irisHttpStatus: null,
    axelarHttpStatus: null,
    latestLedger: options.latestLedger ?? highestEventLedger + 2,
    irisMode: "complete",
    axelarMode: "executed_without_receipt",
    sepoliaReceiptMode: "missing",
  };
  const sorobanCalls: RecordedSorobanCall[] = [];

  const cctpFixture = buildCctpRehearsalFixture({
    sourceTokenSacId: options.sourceTokenSacId,
    sourceCctpAdapter: options.sourceCctpAdapter,
    recipientAddress: options.recipientAddress,
    sourceNetAmount: options.sourceNetAmount,
  });

  const cctpSourceTx = sortedEvents[0]?.txHash ?? "";
  const axelarSourceTx = sortedEvents[1]?.txHash ?? "";
  const receiptBlockNumber = 9_500_100n;

  const server: Server = createServer((req, res) => {
    void (async () => {
      const parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1");

      if (parsedUrl.pathname === "/health") {
        sendJson(res, 200, { status: "ok" });
        return;
      }

      if (parsedUrl.pathname === "/soroban" && req.method === "POST") {
        if (state.sorobanHttpStatus !== null) {
          sendJson(res, state.sorobanHttpStatus, { error: "simulated soroban fault" });
          return;
        }
        const body = await readJsonBody(req);
        const rpcId = body.id ?? 1;
        const method = typeof body.method === "string" ? body.method : "";
        const params =
          typeof body.params === "object" && body.params !== null
            ? (body.params as Record<string, unknown>)
            : {};

        if (method === "getLatestLedger") {
          sorobanCalls.push({ method, startLedger: null, cursor: null });
          sendJson(res, 200, {
            jsonrpc: "2.0",
            id: rpcId,
            result: {
              sequence: state.latestLedger,
              closeTime: 1_793_318_500,
              protocolVersion: 22,
            },
          });
          return;
        }

        if (method === "getEvents") {
          const pagination =
            typeof params.pagination === "object" && params.pagination !== null
              ? (params.pagination as Record<string, unknown>)
              : {};
          const limit = typeof pagination.limit === "number" ? pagination.limit : 200;
          const cursor = typeof pagination.cursor === "string" ? pagination.cursor : null;
          const startLedger = typeof params.startLedger === "number" ? params.startLedger : null;
          sorobanCalls.push({ method, startLedger, cursor });

          const oldest = Math.max(state.latestLedger - 120_960, 1);
          let fromLedger: number;
          if (cursor !== null) {
            const toidPart = cursor.split("-")[0] ?? "0";
            fromLedger = Number(BigInt(toidPart) >> 32n);
          } else {
            fromLedger = startLedger ?? oldest;
          }
          const width = cursor === null ? START_WINDOW : CURSOR_WINDOW;
          const windowEnd = Math.min(fromLedger + width - 1, state.latestLedger);
          const matching = sortedEvents.filter((ev) => {
            if (ev.ledger > windowEnd) return false;
            if (cursor !== null) return ev.id > cursor;
            return ev.ledger >= fromLedger;
          });
          const page = matching.slice(0, limit);
          const filled = page.length === limit && matching.length > page.length;
          const lastEvent = page[page.length - 1];
          const nextCursor =
            filled && lastEvent !== undefined
              ? lastEvent.id
              : endOfLedgerCursor(windowEnd) || formatEndCursor(windowEnd);

          sendJson(res, 200, {
            jsonrpc: "2.0",
            id: rpcId,
            result: {
              events: page,
              cursor: nextCursor,
              latestLedger: state.latestLedger,
              oldestLedger: oldest,
            },
          });
          return;
        }

        sendJson(res, 200, {
          jsonrpc: "2.0",
          id: rpcId,
          error: { code: -32601, message: `unsupported method ${method}` },
        });
        return;
      }

      if (parsedUrl.pathname.startsWith("/iris/v2/messages/") && req.method === "GET") {
        if (state.irisHttpStatus !== null) {
          sendJson(res, state.irisHttpStatus, { error: "simulated iris fault" });
          return;
        }
        const txHash = parsedUrl.searchParams.get("transactionHash") ?? "";
        if (state.irisMode === "missing" || txHash !== cctpSourceTx) {
          sendJson(res, 404, { error: "Message not found for provided parameters" });
          return;
        }
        sendJson(res, 200, {
          messages: [
            {
              status: "complete",
              eventNonce: cctpFixture.nonce,
              forwardTxHash: cctpFixture.forwardTxHash,
              messageBytes: cctpFixture.messageBytes,
              attestation: `0x${"ab".repeat(65)}`,
              attestedAt: "2026-10-30T00:01:00.000Z",
            },
          ],
        });
        return;
      }

      if (parsedUrl.pathname === "/axelar" && req.method === "POST") {
        if (state.axelarHttpStatus !== null) {
          sendJson(res, state.axelarHttpStatus, { error: "simulated axelar fault" });
          return;
        }
        const body = await readJsonBody(req);
        const txHash = typeof body.txHash === "string" ? body.txHash : "";
        if (state.axelarMode === "missing" || txHash !== axelarSourceTx) {
          sendJson(res, 200, { data: [] });
          return;
        }
        sendJson(res, 200, {
          data: [
            {
              status: "executed",
              simplified_status: "received",
              message_id: "rehearsal-axelar-msg-2",
              call: { transactionHash: axelarSourceTx },
              approved: {
                block_timestamp: 1_793_318_510,
              },
            },
          ],
        });
        return;
      }

      if (parsedUrl.pathname === "/sepolia" && req.method === "POST") {
        const body = await readJsonBody(req);
        const rpcId = body.id ?? 1;
        const method = typeof body.method === "string" ? body.method : "";
        const params = Array.isArray(body.params) ? (body.params as unknown[]) : [];

        if (method === "eth_chainId") {
          sendJson(res, 200, { jsonrpc: "2.0", id: rpcId, result: "0xaa36a7" });
          return;
        }

        if (method === "eth_blockNumber") {
          const sepoliaChain = CHAINS.sepolia;
          const confirmations = isEvmChain(sepoliaChain) ? sepoliaChain.confirmations : 3;
          const head =
            state.sepoliaReceiptMode === "unconfirmed"
              ? receiptBlockNumber + 1n
              : receiptBlockNumber + BigInt(confirmations + 2);
          sendJson(res, 200, {
            jsonrpc: "2.0",
            id: rpcId,
            result: `0x${head.toString(16)}`,
          });
          return;
        }

        if (method === "eth_getTransactionReceipt") {
          const requestedHash = typeof params[0] === "string" ? params[0].toLowerCase() : "";
          if (
            state.sepoliaReceiptMode === "missing" ||
            requestedHash !== cctpFixture.forwardTxHash.toLowerCase()
          ) {
            sendJson(res, 200, { jsonrpc: "2.0", id: rpcId, result: null });
            return;
          }
          const blockHex = `0x${receiptBlockNumber.toString(16)}`;
          sendJson(res, 200, {
            jsonrpc: "2.0",
            id: rpcId,
            result: {
              transactionHash: cctpFixture.forwardTxHash,
              transactionIndex: "0x0",
              blockHash: cctpFixture.blockHash,
              blockNumber: blockHex,
              from: `0x${"33".repeat(20)}`,
              to: RAIL_CONTRACTS.sepolia?.cctp?.messageTransmitterV2 ?? `0x${"44".repeat(20)}`,
              cumulativeGasUsed: "0x5208",
              gasUsed: "0x5208",
              effectiveGasPrice: "0x3b9aca00",
              contractAddress: null,
              logs: cctpFixture.logs.map((entry, idx) => ({
                ...entry,
                blockHash: cctpFixture.blockHash,
                blockNumber: blockHex,
                transactionHash: cctpFixture.forwardTxHash,
                transactionIndex: "0x0",
                removed: false,
                logIndex: `0x${idx.toString(16)}`,
              })),
              logsBloom: `0x${"00".repeat(256)}`,
              status: state.sepoliaReceiptMode === "reverted" ? "0x0" : "0x1",
              type: "0x2",
            },
          });
          return;
        }

        if (method === "eth_getBlockByNumber") {
          const blockHex = `0x${receiptBlockNumber.toString(16)}`;
          sendJson(res, 200, {
            jsonrpc: "2.0",
            id: rpcId,
            result: {
              number: blockHex,
              hash: cctpFixture.blockHash,
              parentHash: `0x${"a0".repeat(32)}`,
              nonce: "0x0000000000000000",
              sha3Uncles: `0x${"1d".repeat(32)}`,
              logsBloom: `0x${"00".repeat(256)}`,
              transactionsRoot: `0x${"56".repeat(32)}`,
              stateRoot: `0x${"56".repeat(32)}`,
              receiptsRoot: `0x${"56".repeat(32)}`,
              miner: `0x${"00".repeat(20)}`,
              difficulty: "0x0",
              totalDifficulty: "0x0",
              extraData: "0x",
              size: "0x3e8",
              gasLimit: "0x1c9c380",
              gasUsed: "0x5208",
              timestamp: `0x${(1_793_318_520).toString(16)}`,
              transactions: [],
              uncles: [],
              baseFeePerGas: "0x3b9aca00",
            },
          });
          return;
        }

        sendJson(res, 200, {
          jsonrpc: "2.0",
          id: rpcId,
          error: { code: -32601, message: `unsupported method ${method}` },
        });
        return;
      }

      sendJson(res, 404, { error: "not_found" });
    })().catch((error: unknown) => {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  const listenHost = options.host ?? "127.0.0.1";
  const listenPort = options.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, listenHost, () => {
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected TCP server address for rehearsal providers.");
  }
  const baseHost = listenHost === "0.0.0.0" ? "127.0.0.1" : listenHost;
  const origin = `http://${baseHost}:${String(address.port)}`;

  return {
    port: address.port,
    urls: {
      sorobanUrl: `${origin}/soroban`,
      irisUrl: `${origin}/iris`,
      axelarUrl: `${origin}/axelar`,
      sepoliaUrl: `${origin}/sepolia`,
    },
    state,
    sorobanCalls,
    forwardTxHash: cctpFixture.forwardTxHash,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}

export interface RehearsalDatabase extends Transactional {
  ping(): Promise<void>;
}

export interface RunRecoveryRehearsalOptions {
  readonly db: RehearsalDatabase;
  readonly deploymentsFile?: string;
  readonly events?: readonly RawStellarEvent[];
  readonly staleAfterMs?: number;
  readonly logger?: Logger;
}

export interface RehearsalPhaseSnapshot {
  readonly apiReadyStatus: number;
  readonly apiReadyState: string;
  readonly workerReadyState: string | null;
  readonly workerFreshnessState: string;
  readonly outboundCount: number;
  readonly inboundCount: number;
  readonly cursorBlock: string | null;
}

export interface RecoveryRehearsalReport {
  readonly watchingEvm: readonly string[];
  readonly initial: RehearsalPhaseSnapshot;
  readonly afterProviderOnlyStatus: RehearsalPhaseSnapshot;
  readonly duringProviderFaultAndStaleWindow: RehearsalPhaseSnapshot;
  readonly afterFirstRestartAndCanonicalProof: RehearsalPhaseSnapshot;
  readonly afterSecondRestartReplay: RehearsalPhaseSnapshot;
  readonly preservedOutboundObservedAt: boolean;
  readonly preservedInboundObservedAt: boolean;
  readonly resumedFromPersistedCursor: boolean;
  readonly transferDestinationRecipient: string;
  readonly transferOriginNetAmount: string;
  readonly transferDestinationAmount: string;
}

async function waitForCondition(
  predicate: () => Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out after ${String(timeoutMs)}ms waiting for rehearsal condition.`);
}

export async function runRecoveryRehearsal(
  options: RunRecoveryRehearsalOptions,
): Promise<RecoveryRehearsalReport> {
  const deploymentsFile =
    options.deploymentsFile ??
    resolvePath(process.cwd(), "test/fixtures/rehearsal-deployments-testnet.json");
  const events =
    options.events ??
    (JSON.parse(
      readFileSync(
        resolvePath(process.cwd(), "test/fixtures/rehearsal-stellar-events.json"),
        "utf8",
      ),
    ) as RawStellarEvent[]);
  const staleAfterMs = options.staleAfterMs ?? 5_000;

  const baseEnv: Record<string, string> = {
    NODE_ENV: "test",
    DATABASE_URL: "postgres://rehearsal:rehearsal-local-only@127.0.0.1:55433/hyperion_rehearsal",
    REDIS_URL: "redis://127.0.0.1:56380",
    HYPERION_NETWORK: "testnet",
    HYPERION_DEPLOYMENTS_FILE: deploymentsFile,
    KEEPER_ENABLED: "false",
    WORKER_FRESHNESS_STALE_MS: String(staleAfterMs),
    STELLAR_POLL_INTERVAL_MS: "250",
    RAIL_POLL_INTERVAL_MS: "1000",
    RAIL_RECHECK_AFTER_MS: "0",
  };

  const probeConfig = loadConfig({ env: baseEnv });
  const stellarDeployment = probeConfig.deployments.networks["stellar-testnet"];
  const sourceToken = stellarDeployment?.tokens.USDC;
  const cctpAdapter = stellarDeployment?.adapters[RouteKind.Cctp];
  if (
    !stellarDeployment ||
    !isStellarDeployment(stellarDeployment) ||
    !sourceToken ||
    !("sacId" in sourceToken) ||
    !cctpAdapter
  ) {
    throw new Error("Rehearsal deployment fixture is missing Stellar USDC or CCTP metadata.");
  }

  const providers = await createRehearsalProviders({
    events,
    sourceTokenSacId: sourceToken.sacId,
    sourceCctpAdapter: cctpAdapter,
    recipientAddress: "0x1111111111111111111111111111111111111111",
    sourceNetAmount: 9_970_000n,
  });

  let simulatedNow = new Date();
  const sharedEnv: Record<string, string> = {
    ...baseEnv,
    STELLAR_RPC_URL: providers.urls.sorobanUrl,
    IRIS_API_URL: providers.urls.irisUrl,
    AXELAR_API_URL: providers.urls.axelarUrl,
    EVM_RPC_URL_SEPOLIA: providers.urls.sepoliaUrl,
  };

  const apiConfig = loadConfig({
    env: {
      ...sharedEnv,
      INDEXER_ENABLED: "false",
      RAILS_ENABLED: "false",
    },
  });
  const logger = options.logger ?? createLogger(apiConfig);
  const apiIndexer = buildIndexer({ config: apiConfig, logger, db: options.db });
  const apiServer = buildServer({
    config: apiConfig,
    logger,
    db: options.db as unknown as Database,
    readiness: apiIndexer.readiness,
    startedAt: simulatedNow,
    now: () => simulatedNow,
  });
  await apiServer.ready();

  const snapshot = async (workerState: string | null): Promise<RehearsalPhaseSnapshot> => {
    const readyRes = await apiServer.inject({ method: "GET", url: "/ready" });
    const readyBody = readyRes.json<{ status: string }>();
    const metricsRes = await apiServer.inject({ method: "GET", url: "/v1/metrics" });
    const metricsBody = metricsRes.json<{
      transfers: { totalOutbound: number; totalInbound: number };
      cursors: readonly { chain: string; block: string; updatedAt: string }[];
      workerFreshness: { state: string };
    }>();
    return {
      apiReadyStatus: readyRes.statusCode,
      apiReadyState: readyBody.status,
      workerReadyState: workerState,
      workerFreshnessState: metricsBody.workerFreshness.state,
      outboundCount: metricsBody.transfers.totalOutbound,
      inboundCount: metricsBody.transfers.totalInbound,
      cursorBlock: metricsBody.cursors[0]?.block ?? null,
    };
  };

  try {
    // Phase 1: Cold API availability before any worker runs.
    const initial = await snapshot(null);

    // Phase 2: Worker #1 indexes outbound transfers; providers return "complete"/"executed"
    // while destination Sepolia receipt is missing/reverted (must NOT record inbound_delivery).
    providers.state.sepoliaReceiptMode = "reverted";
    const workerConfig = loadConfig({
      env: {
        ...sharedEnv,
        INDEXER_ENABLED: "true",
        RAILS_ENABLED: "true",
      },
    });
    const worker1 = buildIndexer({ config: workerConfig, logger, db: options.db });
    const worker1Server = buildServer({
      config: workerConfig,
      logger,
      db: options.db as unknown as Database,
      readiness: worker1.readiness,
      startedAt: simulatedNow,
    });
    await worker1Server.ready();
    worker1.start();

    await waitForCondition(async () => {
      const att = await options.db.query(
        "SELECT count(*)::int AS count FROM rail_attestation WHERE status = 'attested'",
      );
      return Number(att.rows[0]?.count ?? 0) === 2;
    });

    simulatedNow = new Date();
    const w1ReadyAfterIngest = (await worker1Server.inject({ method: "GET", url: "/ready" })).json<{
      status: string;
    }>().status;
    const afterProviderOnlyStatus = await snapshot(w1ReadyAfterIngest);

    const firstOutboundRows = await options.db.query(
      "SELECT nonce, destination, gross_amount, net_amount, observed_at FROM outbound_transfer ORDER BY nonce ASC",
    );
    const firstOutboundObservedAt = firstOutboundRows.rows.map((r) =>
      new Date(r.observed_at as string | number | Date).toISOString(),
    );

    // Phase 3: Inject Soroban 503 + Iris 429 provider faults; observe degraded worker vs ready API,
    // then stop Worker #1 and advance clock past staleAfterMs to observe stale workerFreshness.
    providers.state.sorobanHttpStatus = 503;
    providers.state.irisHttpStatus = 429;
    await waitForCondition(async () => {
      const res = await worker1Server.inject({ method: "GET", url: "/ready" });
      const body = res.json<{ status: string }>();
      return res.statusCode === 200 && body.status === "degraded";
    });
    const w1FaultState = (await worker1Server.inject({ method: "GET", url: "/ready" })).json<{
      status: string;
    }>().status;

    await worker1.stop();
    await worker1Server.close();

    const cursorRowBeforeStale = await options.db.query(
      "SELECT updated_at FROM indexer_cursor WHERE chain_key = 'stellar-testnet'",
    );
    const cursorUpdatedMs = new Date(
      cursorRowBeforeStale.rows[0]?.updated_at as string | number | Date,
    ).getTime();
    simulatedNow = new Date(cursorUpdatedMs + staleAfterMs + 2_000);
    const duringProviderFaultAndStaleWindow = await snapshot(w1FaultState);

    // Phase 4: Clear provider faults, enable confirmed canonical Sepolia receipt, and start Worker #2.
    providers.state.sorobanHttpStatus = null;
    providers.state.irisHttpStatus = null;
    providers.state.sepoliaReceiptMode = "confirmed";
    const sorobanCallsBeforeRestart = providers.sorobanCalls.length;

    const worker2 = buildIndexer({ config: workerConfig, logger, db: options.db });
    worker2.start();

    await waitForCondition(async () => {
      const inbound = await options.db.query("SELECT count(*)::int AS count FROM inbound_delivery");
      const callsSinceRestart = providers.sorobanCalls
        .slice(sorobanCallsBeforeRestart)
        .filter((call) => call.method === "getEvents");
      return Number(inbound.rows[0]?.count ?? 0) === 1 && callsSinceRestart.length >= 1;
    });

    await worker2.stop();

    const getEventsCallsAfterRestart = providers.sorobanCalls
      .slice(sorobanCallsBeforeRestart)
      .filter((call) => call.method === "getEvents");
    const resumedFromPersistedCursor =
      getEventsCallsAfterRestart.length > 0 &&
      getEventsCallsAfterRestart.every((call) => call.cursor !== null && call.startLedger === null);

    const firstInboundRows = await options.db.query(
      "SELECT observed_at FROM inbound_delivery WHERE source_chain = 'stellar-testnet' AND source_nonce = 1",
    );
    const firstInboundObservedAt = new Date(
      firstInboundRows.rows[0]?.observed_at as string | number | Date,
    ).toISOString();

    const cursorAfterW2 = await options.db.query(
      "SELECT updated_at FROM indexer_cursor WHERE chain_key = 'stellar-testnet'",
    );
    simulatedNow = new Date(
      new Date(cursorAfterW2.rows[0]?.updated_at as string | number | Date).getTime() + 100,
    );
    const afterFirstRestartAndCanonicalProof = await snapshot("ready");

    // Phase 5: Rewind cursor prior to source events to force full replay across restart #2 (Worker #3)
    // and re-run canonical destination proof upsert to verify zero duplicate source or destination rows
    // and preserved observed_at timestamps.
    const irisReplay = new IrisClient("testnet", { baseUrl: providers.urls.irisUrl });
    const pendingReplay = {
      transferId: 1n,
      originChain: "stellar-testnet",
      destinationChain: "sepolia",
      route: RouteKind.Cctp,
      nonce: 1n,
      originTx: events[0]?.txHash ?? "",
      railRef: null,
      status: "attested" as const,
      checkFailures: 0,
      delivered: false,
    };
    const replayLookup = await irisReplay.look(pendingReplay);
    if (replayLookup.kind === "found") {
      const replayVerified = await verifyCctpDelivery(
        workerConfig,
        options.db,
        pendingReplay,
        replayLookup.report,
      );
      if (replayVerified) {
        await options.db.transaction(async (tx: Queryable) => {
          await writeInbound(tx, replayVerified.at, replayVerified.row);
        });
      }
    }

    await options.db.transaction(async (tx: Queryable) => {
      await tx.query(
        "UPDATE indexer_cursor SET last_processed = $1 WHERE chain_key = 'stellar-testnet'",
        [String(stellarDeployment.deployedAt.ledger - 1)],
      );
      await tx.query(
        "UPDATE rail_attestation SET status = 'attested', last_checked_at = NULL WHERE transfer_id = 1",
      );
    });

    const worker3 = buildIndexer({ config: workerConfig, logger, db: options.db });
    worker3.start();

    await waitForCondition(async () => {
      const cursorNow = await options.db.query(
        "SELECT last_processed FROM indexer_cursor WHERE chain_key = 'stellar-testnet'",
      );
      const att = await options.db.query(
        "SELECT status FROM rail_attestation WHERE transfer_id = 1",
      );
      return (
        Number(cursorNow.rows[0]?.last_processed ?? 0) >= providers.state.latestLedger &&
        att.rows[0]?.status === "delivered"
      );
    });
    await worker3.stop();

    const cursorAfterW3 = await options.db.query(
      "SELECT updated_at FROM indexer_cursor WHERE chain_key = 'stellar-testnet'",
    );
    simulatedNow = new Date(
      new Date(cursorAfterW3.rows[0]?.updated_at as string | number | Date).getTime() + 100,
    );
    const afterSecondRestartReplay = await snapshot("ready");

    const replayOutboundRows = await options.db.query(
      "SELECT nonce, observed_at FROM outbound_transfer ORDER BY nonce ASC",
    );
    const replayOutboundObservedAt = replayOutboundRows.rows.map((r) =>
      new Date(r.observed_at as string | number | Date).toISOString(),
    );
    const preservedOutboundObservedAt =
      firstOutboundObservedAt.length === replayOutboundObservedAt.length &&
      firstOutboundObservedAt.every((val, idx) => val === replayOutboundObservedAt[idx]);

    const replayInboundRows = await options.db.query(
      "SELECT observed_at FROM inbound_delivery WHERE source_chain = 'stellar-testnet' AND source_nonce = 1",
    );
    const replayInboundObservedAt = new Date(
      replayInboundRows.rows[0]?.observed_at as string | number | Date,
    ).toISOString();
    const preservedInboundObservedAt = firstInboundObservedAt === replayInboundObservedAt;

    const transferRes = await apiServer.inject({
      method: "GET",
      url: "/v1/transfers/stellar-testnet/1",
    });
    const transferBody = transferRes.json<{
      origin: { netAmount: string };
      destination: { recipient: string; amount: string | null };
    }>();

    return {
      watchingEvm: workerConfig.indexer.evm.map((entry) => entry.chain),
      initial,
      afterProviderOnlyStatus,
      duringProviderFaultAndStaleWindow,
      afterFirstRestartAndCanonicalProof,
      afterSecondRestartReplay,
      preservedOutboundObservedAt,
      preservedInboundObservedAt,
      resumedFromPersistedCursor,
      transferDestinationRecipient: transferBody.destination.recipient,
      transferOriginNetAmount: transferBody.origin.netAmount,
      transferDestinationAmount: transferBody.destination.amount ?? "",
    };
  } finally {
    await apiServer.close();
    await providers.close();
  }
}

/** Adapter helper turning a basic query engine (such as PGlite in tests) into `RehearsalDatabase`. */
export function wrapTransactionalEngine(engine: {
  query(sql: string, params?: readonly unknown[]): Promise<QueryResultRows>;
  exec?(sql: string): Promise<unknown>;
}): RehearsalDatabase {
  let chain: Promise<void> = Promise.resolve();
  const serialize = async <T>(fn: () => Promise<T>): Promise<T> => {
    const previous = chain;
    let release: () => void = () => undefined;
    chain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  };
  return {
    query: (sql, params = []) => serialize(() => engine.query(sql, params)),
    ping: async () => {
      await serialize(() => engine.query("SELECT 1"));
    },
    transaction: <T>(work: (tx: Queryable) => Promise<T>): Promise<T> =>
      serialize(async () => {
        try {
          await engine.query("BEGIN");
          const value = await work({
            query: (sql, params = []) => engine.query(sql, params),
          });
          await engine.query("COMMIT");
          return value;
        } catch (error) {
          await engine.query("ROLLBACK").catch(() => undefined);
          throw error;
        }
      }),
  };
}

async function runMockProviderServerFromCli(): Promise<void> {
  const deploymentsPath =
    process.env.REHEARSAL_DEPLOYMENTS_FILE ??
    resolvePath(process.cwd(), "test/fixtures/rehearsal-deployments-testnet.json");
  const eventsPath =
    process.env.REHEARSAL_EVENTS_FILE ??
    resolvePath(process.cwd(), "test/fixtures/rehearsal-stellar-events.json");
  const port = Number.parseInt(process.env.REHEARSAL_PROVIDER_PORT ?? "18090", 10);
  const host = process.env.REHEARSAL_PROVIDER_HOST ?? "0.0.0.0";

  const parsedDeployment = JSON.parse(readFileSync(deploymentsPath, "utf8")) as {
    networks: {
      "stellar-testnet": {
        adapters: { cctp: string };
        tokens: { USDC: { sacId: string } };
      };
    };
  };
  const events = JSON.parse(readFileSync(eventsPath, "utf8")) as RawStellarEvent[];
  const handle = await createRehearsalProviders({
    host,
    port,
    events,
    sourceTokenSacId: parsedDeployment.networks["stellar-testnet"].tokens.USDC.sacId,
    sourceCctpAdapter: parsedDeployment.networks["stellar-testnet"].adapters.cctp,
    recipientAddress: "0x1111111111111111111111111111111111111111",
    sourceNetAmount: 9_970_000n,
  });
  handle.state.sepoliaReceiptMode = "confirmed";

  const stop = () => {
    void handle.close().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv.includes("--serve-providers")) {
  await runMockProviderServerFromCli();
}
