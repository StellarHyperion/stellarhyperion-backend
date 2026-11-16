import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { AddressKind, RAIL_CONTRACTS, RouteKind, encodeStellarAddress } from "@hyperion/protocol";
import pino from "pino";
import { encodeAbiParameters, encodeEventTopics, keccak256, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import { buildIndexer } from "../../src/chains/runner.js";
import { writeInbound, writeOutbound } from "../../src/chains/writers.js";
import { admitGmpLane, loadConfig } from "../../src/config/config.js";
import { ConfigError } from "../../src/config/env.js";
import type { QueryResultRows, Queryable, Transactional } from "../../src/db/pool.js";
import {
  verifyGmpDelivery,
  type GmpEvmReceipt,
  type GmpEvmReceiptReader,
} from "../../src/rails/axelar/gmp-delivery.js";
import {
  AXELAR_GMP_RECEIPT_ABI,
  encodeGmpPayoutPayload,
  matchingGmpPayment,
} from "../../src/rails/axelar/gmp-events.js";
import { AxelarGmpClient } from "../../src/rails/axelar/gmp.js";
import { RailPass } from "../../src/rails/pass.js";
import type { DeliveryLog } from "../../src/rails/axelar/events.js";
import type { PendingTransfer, RailClient, RailReport } from "../../src/rails/types.js";
import { completeEnv, readFixture } from "../helpers.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGRATION_FILES = [
  "1790900000000_initial-schema.sql",
  "1791000000000_cursor-block-hash.sql",
  "1791100000000_cursor-autovacuum-tuning.sql",
];

function hex32(byteHex: string): Hex {
  return `0x${byteHex.repeat(32)}`;
}

async function openTestDatabase(): Promise<{
  readonly db: Transactional;
  readonly close: () => Promise<void>;
}> {
  const pg = new PGlite();
  for (const migration of MIGRATION_FILES) {
    const fullSql = readFileSync(join(REPO_ROOT, "migrations", migration), "utf8");
    const upSql = fullSql.split(/^--\s*Down Migration\b/m)[0] ?? fullSql;
    await pg.exec(upSql);
  }
  const runQuery = async (
    text: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResultRows> => {
    const res = await pg.query(text, [...params]);
    return {
      rows: res.rows as Record<string, unknown>[],
      rowCount: res.affectedRows ?? res.rows.length,
    };
  };
  const db: Transactional = {
    query: runQuery,
    transaction: async <T>(work: (tx: Queryable) => Promise<T>): Promise<T> => {
      await pg.exec("BEGIN");
      try {
        const value = await work({ query: runQuery });
        await pg.exec("COMMIT");
        return value;
      } catch (error) {
        await pg.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { db, close: () => pg.close() };
}

const STELLAR_GMP_ADAPTER = encodeStellarAddress(AddressKind.Contract, hex32("31"));
const STELLAR_GMP_RECEIVER = encodeStellarAddress(AddressKind.Contract, hex32("32"));
const STELLAR_SENDER = encodeStellarAddress(AddressKind.Account, hex32("41"));
const STELLAR_MUXED_RECIPIENT = encodeStellarAddress(
  AddressKind.MuxedAccount,
  hex32("42"),
  9876543210123456789n,
);

const SEPOLIA_GMP_ADAPTER = "0x4444444444444444444444444444444444444444";
const SEPOLIA_GMP_RECEIVER = "0x5555555555555555555555555555555555555555";
const SEPOLIA_RECIPIENT = "0x7777777777777777777777777777777777777777";

function buildGmpDeploymentJson(
  options: {
    readonly includeSepoliaGmp?: boolean;
    readonly disableSepoliaReceiver?: boolean;
    readonly provenance?: string;
    readonly capturedFrom?: string;
  } = {},
): string {
  const base = JSON.parse(readFixture("deployments-testnet.json")) as {
    schemaVersion: number;
    generatedAt: string;
    provenance?: string;
    capturedFrom?: string;
    networks: Record<string, Record<string, unknown>>;
  };

  if (options.provenance !== undefined) {
    base.provenance = options.provenance;
  }
  if (options.capturedFrom !== undefined) {
    base.capturedFrom = options.capturedFrom;
  }

  const stellar = base.networks["stellar-testnet"] as {
    adapters: Record<string, string>;
    tokens: { USDC: { routes: string[] } };
    gmpReceiver?: Record<string, unknown>;
  };
  stellar.adapters["axelar-gmp"] = STELLAR_GMP_ADAPTER;
  stellar.tokens.USDC.routes.push("axelar-gmp");
  stellar.gmpReceiver = { receiver: STELLAR_GMP_RECEIVER, enabled: true };

  if (options.includeSepoliaGmp !== false) {
    const sepolia = base.networks.sepolia as {
      adapters: Record<string, string>;
      tokens: { USDC: { routes: string[] } };
      gmpReceiver?: Record<string, unknown>;
    };
    sepolia.adapters["axelar-gmp"] = SEPOLIA_GMP_ADAPTER;
    sepolia.tokens.USDC.routes.push("axelar-gmp");
    sepolia.gmpReceiver = options.disableSepoliaReceiver
      ? { enabled: false }
      : { receiver: SEPOLIA_GMP_RECEIVER, enabled: true };
  }

  return JSON.stringify(base, null, 2);
}

function buildGmpEvmLogs(params: {
  readonly gateway: Hex;
  readonly destinationReceiver: Hex;
  readonly destinationRouter: Hex;
  readonly token: Hex;
  readonly commandId: Hex;
  readonly sourceAxelarChain: string;
  readonly sourceOriginChain: string;
  readonly sourceAdapter: string;
  readonly sourceNonce: bigint;
  readonly recipient: Hex;
  readonly transferTo?: Hex;
  readonly amount: bigint;
  readonly payloadHash: Hex;
  readonly includeClaimParked?: boolean;
}): readonly (DeliveryLog & { readonly logIndex: number })[] {
  const approved: DeliveryLog & { readonly logIndex: number } = {
    address: params.gateway,
    topics: encodeEventTopics({
      abi: AXELAR_GMP_RECEIPT_ABI,
      eventName: "ContractCallApproved",
      args: {
        commandId: params.commandId,
        contractAddress: params.destinationReceiver,
        payloadHash: params.payloadHash,
      },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters(
      [{ type: "string" }, { type: "string" }, { type: "bytes32" }, { type: "uint256" }],
      [params.sourceAxelarChain, params.sourceAdapter, hex32("11"), 0n],
    ),
    logIndex: 1,
  };

  const executed: DeliveryLog & { readonly logIndex: number } = {
    address: params.gateway,
    topics: encodeEventTopics({
      abi: AXELAR_GMP_RECEIPT_ABI,
      eventName: "ContractCallExecuted",
      args: { commandId: params.commandId },
    }) as [Hex, ...Hex[]],
    data: "0x",
    logIndex: 2,
  };

  const bridgeIn: DeliveryLog & { readonly logIndex: number } = {
    address: params.destinationRouter,
    topics: encodeEventTopics({
      abi: AXELAR_GMP_RECEIPT_ABI,
      eventName: "BridgeIn",
      args: {
        route: RouteKind.AxelarGmp,
        recipient: params.recipient,
        token: params.token,
      },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "string" }, { type: "uint64" }, { type: "bytes32" }],
      [params.amount, params.sourceOriginChain, params.sourceNonce, params.commandId],
    ),
    logIndex: 3,
  };

  const transferTo = params.transferTo ?? params.recipient;
  const payout: DeliveryLog & { readonly logIndex: number } = {
    address: params.token,
    topics: encodeEventTopics({
      abi: AXELAR_GMP_RECEIPT_ABI,
      eventName: "Transfer",
      args: {
        from: params.destinationRouter,
        to: transferTo,
      },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: "uint256" }], [params.amount]),
    logIndex: 4,
  };

  if (!params.includeClaimParked) {
    return [approved, executed, bridgeIn, payout];
  }

  const parked: DeliveryLog & { readonly logIndex: number } = {
    address: params.destinationRouter,
    topics: encodeEventTopics({
      abi: AXELAR_GMP_RECEIPT_ABI,
      eventName: "ClaimParked",
      args: {
        id: 77n,
        recipient: params.recipient,
        token: params.token,
      },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint8" }, { type: "string" }, { type: "uint64" }],
      [params.amount, RouteKind.AxelarGmp, params.sourceOriginChain, params.sourceNonce],
    ),
    logIndex: 5,
  };

  return [approved, executed, bridgeIn, payout, parked];
}

describe("Authenticated Axelar GMP payout verification (#147)", () => {
  it("blocks configuration admission when deployed GMP receiver support or gateway support is missing", () => {
    expect(() =>
      loadConfig({
        env: completeEnv({ KEEPER_ENABLED: "false" }),
        readFile: () => buildGmpDeploymentJson({ includeSepoliaGmp: false }),
      }),
    ).toThrow(ConfigError);

    expect(() =>
      loadConfig({
        env: completeEnv({ KEEPER_ENABLED: "false" }),
        readFile: () => buildGmpDeploymentJson({ disableSepoliaReceiver: true }),
      }),
    ).toThrow(/receiver/i);

    const baselineConfig = loadConfig({
      env: completeEnv({ KEEPER_ENABLED: "false" }),
      readFile: () => readFixture("deployments-testnet.json"),
    });
    expect(admitGmpLane(baselineConfig, "stellar-testnet", "sepolia", "USDC")).toEqual({
      admitted: false,
      reason: "missing_source_gmp_adapter",
    });

    const logger = pino({ level: "silent" });
    const fakeDb: Transactional = {
      query: () => Promise.resolve({ rows: [], rowCount: 0 }),
      transaction: <T>(work: (tx: Queryable) => Promise<T>) =>
        work({ query: () => Promise.resolve({ rows: [], rowCount: 0 }) }),
    };
    const baselineIndexer = buildIndexer({ config: baselineConfig, logger, db: fakeDb });
    expect(baselineIndexer.workers.map((w) => w.name)).not.toContain("rail:axelar-gmp");

    const admittedConfig = loadConfig({
      env: completeEnv({ KEEPER_ENABLED: "false" }),
      readFile: () => buildGmpDeploymentJson(),
    });
    expect(admittedConfig.rails.gmpLanes).toHaveLength(2);
    const admittedIndexer = buildIndexer({ config: admittedConfig, logger, db: fakeDb });
    expect(admittedIndexer.workers.map((w) => w.name)).toContain("rail:axelar-gmp");
  });

  it("refuses local rehearsal deployments, fixture provenance, and local RPC chain ids as live delivered evidence", async () => {
    expect(() =>
      loadConfig({
        env: completeEnv({ KEEPER_ENABLED: "false" }),
        readFile: () => buildGmpDeploymentJson({ provenance: "local rehearsal capture" }),
      }),
    ).toThrow(ConfigError);

    expect(() =>
      loadConfig({
        env: completeEnv({ KEEPER_ENABLED: "false" }),
        readFile: () => buildGmpDeploymentJson({ capturedFrom: "anvil-local-node" }),
      }),
    ).toThrow(ConfigError);

    const { db, close } = await openTestDatabase();
    try {
      const config = loadConfig({
        env: completeEnv({ KEEPER_ENABLED: "false" }),
        readFile: () => buildGmpDeploymentJson(),
      });
      const sepoliaUsdc = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
      const stellarUsdc = "CD5IB466XCQIUDYWV22PUMJTF6EE3KPXBDGLLBSKAPNE6QPXVUZLXJGA";
      const originTx = hex32("91");
      const execTx = hex32("92");
      const commandId = hex32("93");
      const paddedRecipient = `0x${SEPOLIA_RECIPIENT.slice(2).padStart(64, "0")}`;

      await writeOutbound(
        db,
        {
          chainKey: "stellar-testnet",
          block: 1287500n,
          txHash: originTx,
          logIndex: null,
          observedAt: new Date("2026-10-01T00:00:00Z"),
        },
        {
          route: RouteKind.AxelarGmp,
          nonce: 42n,
          sender: STELLAR_SENDER,
          token: stellarUsdc,
          grossAmount: 10_000_000n,
          fee: 30_000n,
          netAmount: 9_970_000n,
          destinationChain: "sepolia",
          destination: paddedRecipient,
          railRef: commandId,
        },
      );
      const idRes = await db.query("SELECT id FROM outbound_transfer WHERE nonce = $1", ["42"]);
      const transferId = BigInt(String(idRes.rows[0]?.id));

      const payload = encodeGmpPayoutPayload({
        destinationFamily: "evm",
        recipient: SEPOLIA_RECIPIENT,
        sourceNonce: 42n,
        destinationToken: sepoliaUsdc,
        destinationAmount: 997_000n,
      });

      const baseTransfer: PendingTransfer = {
        transferId,
        route: RouteKind.AxelarGmp,
        originChain: "stellar-testnet",
        destinationChain: "sepolia",
        nonce: 42n,
        originTx,
        status: null,
        checkFailures: 0,
        delivered: false,
      };
      const baseReport: RailReport = {
        status: "attested",
        railStatus: "executed",
        reference: `${originTx}-0`,
        attestedAt: new Date("2026-10-01T00:01:00Z"),
        execution: { txHash: execTx, commandId },
        gmpCandidate: {
          sourceChain: "stellar-2026-q1-2",
          sourceAddress: STELLAR_GMP_ADAPTER,
          destinationContractAddress: SEPOLIA_GMP_RECEIVER,
          payloadHash: keccak256(payload),
          payload,
        },
      };

      // Candidate report tagged with local/fixture provenance is blocked.
      expect(
        await verifyGmpDelivery(config, db, baseTransfer, {
          ...baseReport,
          gmpCandidate: { ...baseReport.gmpCandidate, provenance: "anvil-fixture" },
        }),
      ).toBeNull();

      // Local chain keys are blocked.
      expect(
        await verifyGmpDelivery(config, db, { ...baseTransfer, originChain: "local" }, baseReport),
      ).toBeNull();

      // Local rehearsal RPC chain id (31337) is blocked even if logs would otherwise match.
      const localRpcReader: GmpEvmReceiptReader = {
        getChainId: () => Promise.resolve(31337),
        getBlockNumber: () => Promise.resolve(9_413_000n),
        getTransactionReceipt: () =>
          Promise.reject(new Error("must stop before reading local receipt")),
        getBlock: () => Promise.reject(new Error("must stop before reading local block")),
      };
      expect(
        await verifyGmpDelivery(config, db, baseTransfer, baseReport, {
          evmClientFactory: () => localRpcReader,
        }),
      ).toBeNull();
    } finally {
      await close();
    }
  });

  it("binds source peer, payload recipient, token, amount, and canonical block hash across EVM and Stellar lanes", async () => {
    const { db, close } = await openTestDatabase();
    try {
      const config = loadConfig({
        env: completeEnv({ KEEPER_ENABLED: "false" }),
        readFile: () => buildGmpDeploymentJson(),
      });
      const rawSepoliaGw = RAIL_CONTRACTS.sepolia?.axelar?.gateway;
      const stellarGateway = RAIL_CONTRACTS["stellar-testnet"]?.axelar?.gateway;
      if (!rawSepoliaGw || !stellarGateway) {
        throw new Error("missing protocol registry Axelar gateways");
      }
      const sepoliaGateway = rawSepoliaGw as Hex;
      const sepoliaRouter = "0x0165878A594ca255338adfa4d48449f69242Eb8F";
      const stellarRouter = "CDVDU67TASWDY7ECUQWGPIIAYVLFYTGULAQVLMUEYRIBILVHKJHBCPSI";
      const sepoliaUsdc = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
      const stellarUsdc = "CD5IB466XCQIUDYWV22PUMJTF6EE3KPXBDGLLBSKAPNE6QPXVUZLXJGA";

      const originTx = hex32("a1");
      const execTx = hex32("a2");
      const blockHash = hex32("a3");
      const commandId = hex32("a4");
      const paddedRecipient = `0x${SEPOLIA_RECIPIENT.slice(2).padStart(64, "0")}`;

      await writeOutbound(
        db,
        {
          chainKey: "stellar-testnet",
          block: 1288000n,
          txHash: originTx,
          logIndex: null,
          observedAt: new Date("2026-10-02T00:00:00Z"),
        },
        {
          route: RouteKind.AxelarGmp,
          nonce: 101n,
          sender: STELLAR_SENDER,
          token: stellarUsdc,
          grossAmount: 25_000_000n,
          fee: 75_000n,
          netAmount: 24_925_000n,
          destinationChain: "sepolia",
          destination: paddedRecipient,
          railRef: commandId,
        },
      );
      const expectedEvmAmount = 2_492_500n;
      const payload = encodeGmpPayoutPayload({
        destinationFamily: "evm",
        recipient: SEPOLIA_RECIPIENT,
        sourceNonce: 101n,
        destinationToken: sepoliaUsdc,
        destinationAmount: expectedEvmAmount,
      });
      const payloadHash = keccak256(payload);

      const validLogs = buildGmpEvmLogs({
        gateway: sepoliaGateway,
        destinationReceiver: SEPOLIA_GMP_RECEIVER,
        destinationRouter: sepoliaRouter,
        token: sepoliaUsdc,
        commandId,
        sourceAxelarChain: "stellar-2026-q1-2",
        sourceOriginChain: "stellar-testnet",
        sourceAdapter: STELLAR_GMP_ADAPTER,
        sourceNonce: 101n,
        recipient: SEPOLIA_RECIPIENT,
        amount: expectedEvmAmount,
        payloadHash,
      });

      // Direct event-matcher regression checks on peer, recipient, token, amount, custody, and parked claims.
      const baseExpected = {
        gateway: sepoliaGateway,
        destinationReceiver: SEPOLIA_GMP_RECEIVER,
        destinationRouter: sepoliaRouter,
        token: sepoliaUsdc,
        commandId,
        sourceAxelarChain: "stellar-2026-q1-2",
        sourceOriginChain: "stellar-testnet",
        sourceAdapter: STELLAR_GMP_ADAPTER,
        sourceNonce: 101n,
        recipient: SEPOLIA_RECIPIENT,
        amount: expectedEvmAmount,
        payload,
      };
      expect(matchingGmpPayment(validLogs, baseExpected)?.logIndex).toBe(4);
      expect(
        matchingGmpPayment(validLogs, {
          ...baseExpected,
          sourceAdapter: STELLAR_GMP_RECEIVER,
        }),
      ).toBeNull();
      expect(
        matchingGmpPayment(validLogs, {
          ...baseExpected,
          recipient: SEPOLIA_GMP_RECEIVER,
        }),
      ).toBeNull();
      expect(
        matchingGmpPayment(validLogs, {
          ...baseExpected,
          token: SEPOLIA_GMP_ADAPTER,
        }),
      ).toBeNull();
      expect(
        matchingGmpPayment(validLogs, {
          ...baseExpected,
          amount: expectedEvmAmount + 1n,
        }),
      ).toBeNull();

      // Receiver-only custody without payout to recipient is rejected.
      const custodyOnlyLogs = buildGmpEvmLogs({
        gateway: sepoliaGateway,
        destinationReceiver: SEPOLIA_GMP_RECEIVER,
        destinationRouter: sepoliaRouter,
        token: sepoliaUsdc,
        commandId,
        sourceAxelarChain: "stellar-2026-q1-2",
        sourceOriginChain: "stellar-testnet",
        sourceAdapter: STELLAR_GMP_ADAPTER,
        sourceNonce: 101n,
        recipient: SEPOLIA_RECIPIENT,
        transferTo: SEPOLIA_GMP_RECEIVER,
        amount: expectedEvmAmount,
        payloadHash,
      });
      expect(matchingGmpPayment(custodyOnlyLogs, baseExpected)).toBeNull();

      // Parked claims do not qualify as delivered payout.
      const parkedLogs = buildGmpEvmLogs({
        gateway: sepoliaGateway,
        destinationReceiver: SEPOLIA_GMP_RECEIVER,
        destinationRouter: sepoliaRouter,
        token: sepoliaUsdc,
        commandId,
        sourceAxelarChain: "stellar-2026-q1-2",
        sourceOriginChain: "stellar-testnet",
        sourceAdapter: STELLAR_GMP_ADAPTER,
        sourceNonce: 101n,
        recipient: SEPOLIA_RECIPIENT,
        amount: expectedEvmAmount,
        payloadHash,
        includeClaimParked: true,
      });
      expect(matchingGmpPayment(parkedLogs, baseExpected)).toBeNull();

      // Provider status alone (even if rogue client claims "delivered") never establishes delivery when receipt fails.
      let receiptState: GmpEvmReceipt = {
        status: "reverted",
        blockNumber: 9_500_000n,
        blockHash,
        transactionHash: execTx,
        logs: validLogs,
      };
      let canonicalBlockHash: Hex = blockHash;
      const evmReader: GmpEvmReceiptReader = {
        getChainId: () => Promise.resolve(11155111),
        getBlockNumber: () => Promise.resolve(9_500_020n),
        getTransactionReceipt: () => Promise.resolve(receiptState),
        getBlock: () => Promise.resolve({ hash: canonicalBlockHash, timestamp: 1_790_900_120n }),
      };

      const rogueClient: RailClient = {
        rail: "axelar-gmp",
        look: () =>
          Promise.resolve({
            kind: "found",
            report: {
              status: "delivered",
              railStatus: "executed",
              reference: `${originTx}-0`,
              attestedAt: new Date("2026-10-02T00:01:00Z"),
              execution: { txHash: execTx, commandId },
              gmpCandidate: {
                sourceChain: "stellar-2026-q1-2",
                sourceAddress: STELLAR_GMP_ADAPTER,
                destinationContractAddress: SEPOLIA_GMP_RECEIVER,
                payloadHash,
                payload,
              },
            },
          }),
      };

      const passWithRogue = new RailPass({
        route: RouteKind.AxelarGmp,
        client: rogueClient,
        db,
        logger: pino({ level: "silent" }),
        batchSize: 10,
        recheckAfterMs: 0,
        maxCheckFailures: 5,
        now: () => new Date("2026-10-02T00:02:00Z"),
        config,
        gmpVerifyDeps: { evmClientFactory: () => evmReader },
      });
      await passWithRogue.tick(new AbortController().signal);

      const attBefore = await db.query("SELECT status FROM rail_attestation");
      expect(attBefore.rows[0]?.status).toBe("attested");
      const inboundBefore = await db.query("SELECT * FROM inbound_delivery");
      expect(inboundBefore.rows).toHaveLength(0);

      // Non-canonical block hash is also rejected even when receipt status is "success".
      receiptState = { ...receiptState, status: "success" };
      canonicalBlockHash = hex32("ff");
      const gmpClient = new AxelarGmpClient("https://axelar.example.invalid", {
        railName: "axelar-gmp",
        fetch: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                data: [
                  {
                    status: "executed",
                    message_id: `${originTx}-0`,
                    command_id: commandId,
                    call: {
                      transactionHash: originTx,
                      chain: "stellar-2026-q1-2",
                      returnValues: {
                        sender: STELLAR_GMP_ADAPTER,
                        destinationContractAddress: SEPOLIA_GMP_RECEIVER,
                        payloadHash,
                        payload,
                      },
                    },
                    approved: {
                      block_timestamp: 1_790_900_100,
                      returnValues: {
                        sourceChain: "stellar-2026-q1-2",
                        sourceAddress: STELLAR_GMP_ADAPTER,
                        contractAddress: SEPOLIA_GMP_RECEIVER,
                        payloadHash,
                      },
                    },
                    executed: {
                      block_timestamp: 1_790_900_120,
                      transactionHash: execTx,
                    },
                  },
                ],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          ),
      });

      let passNow = new Date("2026-10-02T00:05:00Z");
      const realPass = new RailPass({
        route: RouteKind.AxelarGmp,
        client: gmpClient,
        db,
        logger: pino({ level: "silent" }),
        batchSize: 10,
        recheckAfterMs: 0,
        maxCheckFailures: 5,
        now: () => passNow,
        config,
        gmpVerifyDeps: { evmClientFactory: () => evmReader },
      });
      await realPass.tick(new AbortController().signal);
      expect((await db.query("SELECT * FROM inbound_delivery")).rows).toHaveLength(0);

      // Canonical block hash + matching verified events establish delivery and remain replay-safe.
      canonicalBlockHash = blockHash;
      passNow = new Date("2026-10-02T00:05:10Z");
      await realPass.tick(new AbortController().signal);
      const inboundAfter = await db.query(
        "SELECT recipient, token, amount::text AS amount, delivered, rail_message_id FROM inbound_delivery",
      );
      expect(inboundAfter.rows).toEqual([
        {
          recipient: SEPOLIA_RECIPIENT.toLowerCase(),
          token: sepoliaUsdc.toLowerCase(),
          amount: "2492500",
          delivered: true,
          rail_message_id: commandId,
        },
      ]);
      const attAfter = await db.query("SELECT status FROM rail_attestation");
      expect(attAfter.rows[0]?.status).toBe("delivered");

      // Replay inbound write to prove idempotency without duplicating rows.
      await writeInbound(
        db,
        {
          chainKey: "sepolia",
          block: 9_500_000n,
          txHash: execTx,
          logIndex: 4,
          observedAt: new Date(1_790_900_120 * 1000),
        },
        {
          route: RouteKind.AxelarGmp,
          sourceChain: "stellar-testnet",
          sourceNonce: 101n,
          railMessageId: commandId,
          recipient: SEPOLIA_RECIPIENT.toLowerCase(),
          token: sepoliaUsdc.toLowerCase(),
          amount: expectedEvmAmount,
          delivered: true,
          claimId: null,
        },
      );
      expect((await db.query("SELECT * FROM inbound_delivery")).rows).toHaveLength(1);

      // Reverse direction (Sepolia -> Stellar) preserving full muxed M... strkey and 7-decimal stroops.
      const evmOriginTx = hex32("b1");
      const stellarExecTx = hex32("b2");
      const reverseCommandId = hex32("b3");
      await writeOutbound(
        db,
        {
          chainKey: "sepolia",
          block: 9_500_100n,
          txHash: evmOriginTx,
          logIndex: 0,
          observedAt: new Date("2026-10-02T01:00:00Z"),
        },
        {
          route: RouteKind.AxelarGmp,
          nonce: 202n,
          sender: SEPOLIA_RECIPIENT,
          token: sepoliaUsdc,
          grossAmount: 1_000_000n,
          fee: 3_000n,
          netAmount: 997_000n,
          destinationChain: "stellar-testnet",
          destination: STELLAR_MUXED_RECIPIENT,
          railRef: reverseCommandId,
        },
      );
      const revIdRes = await db.query(
        "SELECT id FROM outbound_transfer WHERE origin_chain = 'sepolia' AND nonce = $1",
        ["202"],
      );
      const revTransferId = BigInt(String(revIdRes.rows[0]?.id));
      const reversePayload = encodeGmpPayoutPayload({
        destinationFamily: "stellar",
        recipient: STELLAR_MUXED_RECIPIENT,
        sourceNonce: 202n,
        destinationToken: stellarUsdc,
        destinationAmount: 9_970_000n,
      });
      const reversePayloadHash = keccak256(reversePayload);

      const reverseVerified = await verifyGmpDelivery(
        config,
        db,
        {
          transferId: revTransferId,
          route: RouteKind.AxelarGmp,
          originChain: "sepolia",
          destinationChain: "stellar-testnet",
          nonce: 202n,
          originTx: evmOriginTx,
          status: null,
          checkFailures: 0,
          delivered: false,
        },
        {
          status: "attested",
          railStatus: "executed",
          reference: `${evmOriginTx}-0`,
          attestedAt: new Date("2026-10-02T01:01:00Z"),
          execution: { txHash: stellarExecTx, commandId: reverseCommandId },
          gmpCandidate: {
            sourceChain: "ethereum-sepolia",
            sourceAddress: SEPOLIA_GMP_ADAPTER,
            destinationContractAddress: STELLAR_GMP_RECEIVER,
            payloadHash: reversePayloadHash,
            payload: reversePayload,
          },
        },
        {
          stellarTxReader: () =>
            Promise.resolve({
              status: "SUCCESS",
              ledger: 1_290_010,
              latestLedger: 1_290_015,
              txHash: stellarExecTx,
              createdAtUnix: 1_790_904_000,
              approvals: [
                {
                  gatewayContract: stellarGateway,
                  commandId: reverseCommandId,
                  sourceChain: "ethereum-sepolia",
                  sourceAddress: SEPOLIA_GMP_ADAPTER,
                  destinationContract: STELLAR_GMP_RECEIVER,
                  payloadHash: reversePayloadHash,
                },
              ],
              executions: [
                {
                  gatewayContract: stellarGateway,
                  commandId: reverseCommandId,
                },
              ],
              tokenTransfers: [
                {
                  tokenContract: stellarUsdc,
                  from: stellarRouter,
                  to: STELLAR_MUXED_RECIPIENT,
                  amount: 9_970_000n,
                  logIndex: 2,
                },
              ],
            }),
        },
      );

      expect(reverseVerified).not.toBeNull();
      expect(reverseVerified?.row).toEqual({
        route: RouteKind.AxelarGmp,
        sourceChain: "sepolia",
        sourceNonce: 202n,
        railMessageId: reverseCommandId,
        recipient: STELLAR_MUXED_RECIPIENT,
        token: stellarUsdc,
        amount: 9_970_000n,
        delivered: true,
        claimId: null,
      });
    } finally {
      await close();
    }
  });
});
