import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import {
  AddressKind,
  RAIL_CONTRACTS,
  RouteKind,
  encodeAxelarMetadata,
  encodeInboundNote,
  encodeStellarAddress,
  fromHex,
  toHex,
  type Hex,
} from "@hyperion/protocol";
import { describe, expect, it } from "vitest";
import { stringToHex } from "viem";

import type { RawStellarEvent } from "../../src/chains/stellar/events.js";
import { configuredReverseItsLanes } from "../../src/chains/runner.js";
import { writeOutbound } from "../../src/chains/writers.js";
import {
  discoverReverseItsLanes,
  loadConfig,
  type AppConfig,
  type ReverseItsLane,
} from "../../src/config/config.js";
import type { Queryable, QueryResultRows, Transactional } from "../../src/db/pool.js";
import {
  verifyItsDelivery,
  type EvmItsSourceState,
  type ItsVerificationClients,
  type StellarItsExecutionState,
} from "../../src/rails/axelar/delivery.js";
import {
  canonicalStellarRecipient,
  isSupportedTokenManagerType,
  matchingReverseItsDelivery,
} from "../../src/rails/axelar/events.js";
import { AxelarGmpClient } from "../../src/rails/axelar/gmp.js";
import { RailPass } from "../../src/rails/pass.js";
import { pendingForRail } from "../../src/rails/queue.js";
import type { PendingTransfer, RailClient, RailLookup, RailReport } from "../../src/rails/types.js";
import { FIXTURES_DIR } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const REPO_ROOT = resolveRepoRoot();

function resolveRepoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function makeStrkey(kind: AddressKind, fillByte: number, muxedId = 0n): string {
  const raw = new Uint8Array(32).fill(fillByte);
  return encodeStellarAddress(kind, toHex(raw), muxedId);
}

const STELLAR_ROUTER = makeStrkey(AddressKind.Contract, 0x11);
const STELLAR_ITS_ADAPTER = makeStrkey(AddressKind.Contract, 0x12);
const STELLAR_TOKEN_SAC = makeStrkey(AddressKind.Contract, 0x13);
const STELLAR_ADMIN = makeStrkey(AddressKind.Account, 0x14);
const STELLAR_TREASURY = makeStrkey(AddressKind.Account, 0x15);
const STELLAR_GUARDIAN = makeStrkey(AddressKind.Account, 0x16);
const STELLAR_ISSUER = makeStrkey(AddressKind.Account, 0x17);
const ACCOUNT_RECIPIENT = makeStrkey(AddressKind.Account, 0x21);
const MUXED_ID = 9_876_543_210_123_456_789n;
const MUXED_BASE_ACCOUNT = makeStrkey(AddressKind.Account, 0x22);
const MUXED_RECIPIENT = makeStrkey(AddressKind.MuxedAccount, 0x22, MUXED_ID);
const OTHER_MUXED_RECIPIENT = makeStrkey(AddressKind.MuxedAccount, 0x22, MUXED_ID + 1n);

const SEPOLIA_ROUTER: Hex = "0x0165878A594ca255338adfa4d48449f69242Eb8F";
const SEPOLIA_ITS_ADAPTER: Hex = "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318";
const SEPOLIA_TOKEN: Hex = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const SEPOLIA_TOKEN_MANAGER: Hex = "0x610178dA211FEF7D417bC0e6FeD39F05609AD788";
const SEPOLIA_SENDER: Hex = "0x2222222222222222222222222222222222222222";

const TOKEN_ID: Hex = `0x${"cd".repeat(32)}`;
const COMMAND_ID: Hex = `0x${"ab".repeat(32)}`;
const STELLAR_EXEC_TX = "ef".repeat(32);
const ORIGIN_EVM_TX: Hex = `0x${"19".repeat(32)}`;
const STELLAR_ITS =
  RAIL_CONTRACTS["stellar-testnet"]?.axelar?.interchainTokenService ??
  makeStrkey(AddressKind.Contract, 0x31);

function buildReverseItsConfig(): AppConfig {
  const deploymentPath = join(FIXTURES_DIR, "reverse-its-deployments.json");
  const deploymentJson = JSON.stringify({
    schemaVersion: 1,
    generatedAt: "2026-10-12T00:00:00.000Z",
    networks: {
      "stellar-testnet": {
        family: "stellar",
        chain: "stellar-testnet",
        networkPassphrase: "Test SDF Network ; September 2015",
        router: STELLAR_ROUTER,
        adapters: {
          "axelar-its": STELLAR_ITS_ADAPTER,
        },
        tokens: {
          USDC: {
            sacId: STELLAR_TOKEN_SAC,
            code: "USDC",
            issuer: STELLAR_ISSUER,
            decimals: 7,
            flowLimit: "10000000000000",
            routes: ["axelar-its"],
          },
        },
        treasury: STELLAR_TREASURY,
        admin: STELLAR_ADMIN,
        guardian: STELLAR_GUARDIAN,
        feeBps: 30,
        flowWindow: 720,
        timelockDelay: 3600,
        wasmHashes: {
          "hyperion-router": "3b".repeat(32),
          "hyperion-adapter-axelar-its": "4c".repeat(32),
        },
        deployedAt: {
          ledger: 5_100_000,
          timestamp: "2026-10-12T00:00:00.000Z",
        },
        commit: "b302664f1d7a5c9e0348ab27dd51e6904f8c3a2b",
      },
      sepolia: {
        family: "evm",
        chain: "sepolia",
        chainId: 11155111,
        router: SEPOLIA_ROUTER,
        adapters: {
          "axelar-its": SEPOLIA_ITS_ADAPTER,
        },
        tokens: {
          USDC: {
            address: SEPOLIA_TOKEN,
            decimals: 6,
            flowLimit: "1000000000000",
            routes: ["axelar-its"],
          },
        },
        treasury: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
        admin: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        guardian: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        feeBps: 30,
        flowWindow: 3600,
        timelockDelay: 3600,
        deployedAt: {
          blockNumber: "9412880",
          timestamp: "2026-10-12T00:00:00.000Z",
          txHash: `0x${"5d".repeat(32)}`,
        },
        commit: "b302664f1d7a5c9e0348ab27dd51e6904f8c3a2b",
      },
    },
  });

  return loadConfig({
    env: {
      DATABASE_URL: "postgres://localhost:5432/hyperion_test",
      REDIS_URL: "redis://localhost:6379",
      HYPERION_NETWORK: "testnet",
      HYPERION_DEPLOYMENTS_FILE: deploymentPath,
    },
    cwd: REPO_ROOT,
    readFile: (path) => {
      if (path === deploymentPath) return deploymentJson;
      return readFileSync(path, "utf8");
    },
  });
}

class PgliteDb implements Transactional {
  constructor(private readonly pg: PGlite) {}

  async query(sql: string, params: readonly unknown[] = []): Promise<QueryResultRows> {
    const normalizedParams: unknown[] = params.map((item) =>
      item instanceof Date ? item.toISOString() : item,
    );
    const res = await this.pg.query(sql, normalizedParams);
    return {
      rows: res.rows as Record<string, unknown>[],
      rowCount: res.affectedRows ?? res.rows.length,
    };
  }

  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    await this.pg.exec("BEGIN");
    try {
      const out = await work(this);
      await this.pg.exec("COMMIT");
      return out;
    } catch (error) {
      await this.pg.exec("ROLLBACK");
      throw error;
    }
  }
}

async function openMigratedDb(): Promise<{ db: PgliteDb; close: () => Promise<void> }> {
  const pg = new PGlite();
  const migrationsDir = join(REPO_ROOT, "migrations");
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const raw = readFileSync(join(migrationsDir, file), "utf8");
    const upPart = raw.split(/^--\s*Down Migration\b/im)[0] ?? raw;
    await pg.exec(upPart);
  }
  return {
    db: new PgliteDb(pg),
    close: () => pg.close(),
  };
}

function makeItsCallbackEvent(opts: {
  readonly recipient: string;
  readonly nonce: bigint;
  readonly amount: bigint;
  readonly ledger?: number;
  readonly txHash?: string;
  readonly wrapMetadataEnvelope?: boolean;
  readonly destinationAdapter?: string;
  readonly sourceAdapter?: Hex;
  readonly sourceAxelarChain?: string;
  readonly tokenId?: Hex;
  readonly commandId?: Hex;
}): RawStellarEvent {
  const ledger = opts.ledger ?? 5_200_010;
  const note = encodeInboundNote(opts.recipient, opts.nonce);
  const dataBytes = opts.wrapMetadataEnvelope === false ? note : encodeAxelarMetadata(note);
  return {
    type: "contract",
    ledger,
    ledgerClosedAt: "2026-10-12T12:00:05.000Z",
    contractId: STELLAR_ITS,
    id: `${String(ledger).padStart(19, "0")}-0000000001`,
    txHash: opts.txHash ?? STELLAR_EXEC_TX,
    operationIndex: 0,
    transactionIndex: 1,
    inSuccessfulContractCall: true,
    topicJson: [
      { symbol: "interchain_transfer_received" },
      { bytes: (opts.commandId ?? COMMAND_ID).slice(2) },
      { bytes: (opts.tokenId ?? TOKEN_ID).slice(2) },
    ],
    valueJson: {
      map: [
        { key: { symbol: "amount" }, val: { i128: opts.amount.toString() } },
        { key: { symbol: "command_id" }, val: { bytes: (opts.commandId ?? COMMAND_ID).slice(2) } },
        { key: { symbol: "data" }, val: { bytes: toHex(dataBytes).slice(2) } },
        {
          key: { symbol: "destination_address" },
          val: { address: opts.destinationAdapter ?? STELLAR_ITS_ADAPTER },
        },
        {
          key: { symbol: "source_address" },
          val: { bytes: (opts.sourceAdapter ?? SEPOLIA_ITS_ADAPTER).slice(2) },
        },
        {
          key: { symbol: "source_chain" },
          val: { string: opts.sourceAxelarChain ?? "ethereum-sepolia" },
        },
        { key: { symbol: "token_id" }, val: { bytes: (opts.tokenId ?? TOKEN_ID).slice(2) } },
      ],
    },
  };
}

function makeRouterBridgeInEvent(opts: {
  readonly recipient: string;
  readonly nonce: bigint;
  readonly amount: bigint;
  readonly delivered: boolean;
  readonly claimId: bigint;
  readonly ledger?: number;
  readonly txHash?: string;
}): RawStellarEvent {
  const ledger = opts.ledger ?? 5_200_010;
  return {
    type: "contract",
    ledger,
    ledgerClosedAt: "2026-10-12T12:00:05.000Z",
    contractId: STELLAR_ROUTER,
    id: `${String(ledger).padStart(19, "0")}-0000000003`,
    txHash: opts.txHash ?? STELLAR_EXEC_TX,
    operationIndex: 0,
    transactionIndex: 1,
    inSuccessfulContractCall: true,
    topicJson: [{ symbol: "hyperion" }, { symbol: "in" }],
    valueJson: {
      map: [
        {
          key: { symbol: "inbound" },
          val: {
            map: [
              { key: { symbol: "amount" }, val: { i128: opts.amount.toString() } },
              { key: { symbol: "claim_id" }, val: { u64: opts.claimId.toString() } },
              { key: { symbol: "delivered" }, val: { bool: opts.delivered } },
              { key: { symbol: "ledger" }, val: { u32: ledger } },
              { key: { symbol: "recipient" }, val: { address: opts.recipient } },
              { key: { symbol: "route" }, val: { u32: RouteKind.AxelarIts } },
              { key: { symbol: "source_chain" }, val: { string: "sepolia" } },
              { key: { symbol: "source_nonce" }, val: { u64: opts.nonce.toString() } },
              { key: { symbol: "token" }, val: { address: STELLAR_TOKEN_SAC } },
            ],
          },
        },
      ],
    },
  };
}

function makeClaimParkedEvent(opts: {
  readonly claimId: bigint;
  readonly recipient: string;
  readonly nonce: bigint;
  readonly amount: bigint;
  readonly ledger?: number;
  readonly txHash?: string;
}): RawStellarEvent {
  const ledger = opts.ledger ?? 5_200_010;
  return {
    type: "contract",
    ledger,
    ledgerClosedAt: "2026-10-12T12:00:05.000Z",
    contractId: STELLAR_ROUTER,
    id: `${String(ledger).padStart(19, "0")}-0000000002`,
    txHash: opts.txHash ?? STELLAR_EXEC_TX,
    operationIndex: 0,
    transactionIndex: 1,
    inSuccessfulContractCall: true,
    topicJson: [{ symbol: "hyperion" }, { symbol: "park" }],
    valueJson: {
      map: [
        {
          key: { symbol: "claim" },
          val: {
            map: [
              { key: { symbol: "amount" }, val: { i128: opts.amount.toString() } },
              { key: { symbol: "created_at" }, val: { u64: "1791806405" } },
              { key: { symbol: "id" }, val: { u64: opts.claimId.toString() } },
              { key: { symbol: "recipient" }, val: { address: opts.recipient } },
              { key: { symbol: "route" }, val: { u32: RouteKind.AxelarIts } },
              { key: { symbol: "settled" }, val: { bool: false } },
              { key: { symbol: "source_chain" }, val: { string: "sepolia" } },
              { key: { symbol: "source_nonce" }, val: { u64: opts.nonce.toString() } },
              { key: { symbol: "token" }, val: { address: STELLAR_TOKEN_SAC } },
            ],
          },
        },
      ],
    },
  };
}

function makeSacTransferEvent(opts: {
  readonly from: string;
  readonly to: string;
  readonly amount: bigint;
  readonly toMuxedId?: bigint;
  readonly index?: number;
  readonly ledger?: number;
  readonly txHash?: string;
}): RawStellarEvent {
  const ledger = opts.ledger ?? 5_200_010;
  const idx = opts.index ?? 4;
  return {
    type: "contract",
    ledger,
    ledgerClosedAt: "2026-10-12T12:00:05.000Z",
    contractId: STELLAR_TOKEN_SAC,
    id: `${String(ledger).padStart(19, "0")}-${String(idx).padStart(10, "0")}`,
    txHash: opts.txHash ?? STELLAR_EXEC_TX,
    operationIndex: 0,
    transactionIndex: 1,
    inSuccessfulContractCall: true,
    topicJson: [
      { symbol: "transfer" },
      { address: opts.from },
      { address: opts.to },
      { string: "USDC" },
    ],
    valueJson:
      opts.toMuxedId !== undefined
        ? {
            map: [
              { key: { symbol: "amount" }, val: { i128: opts.amount.toString() } },
              { key: { symbol: "to_muxed_id" }, val: { u64: opts.toMuxedId.toString() } },
            ],
          }
        : { i128: opts.amount.toString() },
  };
}

function validSourceState(overrides: Partial<EvmItsSourceState> = {}): EvmItsSourceState {
  return {
    chainId: 11155111,
    adapterTokenId: TOKEN_ID,
    registeredTokenAddress: SEPOLIA_TOKEN,
    tokenManagerAddress: SEPOLIA_TOKEN_MANAGER,
    tokenManagerType: 2, // LOCK_UNLOCK
    peer: {
      axelarChain: "stellar-2026-q1-2",
      peerAddress: stringToHex(STELLAR_ITS_ADAPTER),
      configured: true,
      enabled: true,
    },
    ...overrides,
  };
}

function validStellarState(
  events: readonly RawStellarEvent[],
  overrides: Partial<StellarItsExecutionState> = {},
): StellarItsExecutionState {
  return {
    status: "SUCCESS",
    ledger: 5_200_010,
    latestLedger: 5_200_012,
    events,
    adapterTokenId: fromHex(TOKEN_ID),
    registeredTokenAddress: STELLAR_TOKEN_SAC,
    tokenManagerType: "mint_burn",
    configuredIts: STELLAR_ITS,
    configuredPeer: {
      axelarChain: "ethereum-sepolia",
      peerAddress: SEPOLIA_ITS_ADAPTER,
      enabled: true,
    },
    ...overrides,
  };
}

describe("EVM-to-Stellar ITS delivery verification", () => {
  it("keeps checked-in testnet deployments without EVM reverse-ITS lanes while discovering configured ones", () => {
    const checkedIn = loadConfig({
      env: {
        DATABASE_URL: "postgres://localhost:5432/hyperion_test",
        REDIS_URL: "redis://localhost:6379",
        HYPERION_NETWORK: "testnet",
        HYPERION_DEPLOYMENTS_FILE: join(REPO_ROOT, "deployments", "testnet.json"),
      },
      cwd: REPO_ROOT,
    });
    expect(discoverReverseItsLanes(checkedIn)).toEqual([]);

    const configured = buildReverseItsConfig();
    const lanes = configuredReverseItsLanes(configured);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.originChain).toBe("sepolia");
    expect(lanes[0]?.destinationChain).toBe("stellar-testnet");
    expect(lanes[0]?.symbol).toBe("USDC");
  });

  it("preserves full encoded identity for both account (G...) and muxed (M...) Stellar recipients", async () => {
    const config = buildReverseItsConfig();
    const { db, close } = await openMigratedDb();
    try {
      const sourceNet = 25_000_000n; // 25 USDC (6 decimals on Sepolia)
      const expectedStellarAmount = 250_000_000n; // 25 USDC (7 decimals on Stellar)

      await db.transaction(async (tx) => {
        await writeOutbound(
          tx,
          {
            chainKey: "sepolia",
            block: 9_500_001n,
            txHash: ORIGIN_EVM_TX,
            logIndex: 0,
            observedAt: new Date("2026-10-12T11:59:00.000Z"),
          },
          {
            route: RouteKind.AxelarIts,
            nonce: 77n,
            sender: SEPOLIA_SENDER,
            token: SEPOLIA_TOKEN.toLowerCase(),
            grossAmount: 25_075_000n,
            fee: 75_000n,
            netAmount: sourceNet,
            destinationChain: "stellar-testnet",
            destination: ACCOUNT_RECIPIENT,
            railRef: COMMAND_ID,
          },
        );
        await writeOutbound(
          tx,
          {
            chainKey: "sepolia",
            block: 9_500_002n,
            txHash: `0x${"2a".repeat(32)}`,
            logIndex: 0,
            observedAt: new Date("2026-10-12T11:59:10.000Z"),
          },
          {
            route: RouteKind.AxelarIts,
            nonce: 78n,
            sender: SEPOLIA_SENDER,
            token: SEPOLIA_TOKEN.toLowerCase(),
            grossAmount: 25_075_000n,
            fee: 75_000n,
            netAmount: sourceNet,
            destinationChain: "stellar-testnet",
            destination: MUXED_RECIPIENT,
            railRef: `0x${"bc".repeat(32)}`,
          },
        );
      });

      const muxedCommandId: Hex = `0x${"bc".repeat(32)}`;
      const muxedTxHash = "fe".repeat(32);

      const eventsByTx = new Map<string, readonly RawStellarEvent[]>([
        [
          STELLAR_EXEC_TX,
          [
            makeItsCallbackEvent({
              recipient: ACCOUNT_RECIPIENT,
              nonce: 77n,
              amount: expectedStellarAmount,
            }),
            makeSacTransferEvent({
              from: STELLAR_ITS_ADAPTER,
              to: STELLAR_ROUTER,
              amount: expectedStellarAmount,
              index: 2,
            }),
            makeRouterBridgeInEvent({
              recipient: ACCOUNT_RECIPIENT,
              nonce: 77n,
              amount: expectedStellarAmount,
              delivered: true,
              claimId: 0n,
            }),
            makeSacTransferEvent({
              from: STELLAR_ROUTER,
              to: ACCOUNT_RECIPIENT,
              amount: expectedStellarAmount,
              index: 4,
            }),
          ],
        ],
        [
          muxedTxHash,
          [
            makeItsCallbackEvent({
              recipient: MUXED_RECIPIENT,
              nonce: 78n,
              amount: expectedStellarAmount,
              txHash: muxedTxHash,
              commandId: muxedCommandId,
            }),
            makeSacTransferEvent({
              from: STELLAR_ITS_ADAPTER,
              to: STELLAR_ROUTER,
              amount: expectedStellarAmount,
              txHash: muxedTxHash,
              index: 2,
            }),
            makeRouterBridgeInEvent({
              recipient: MUXED_RECIPIENT,
              nonce: 78n,
              amount: expectedStellarAmount,
              delivered: true,
              claimId: 0n,
              txHash: muxedTxHash,
            }),
            // CAP-0067 SAC transfer carrying base G... account + explicit u64 to_muxed_id
            makeSacTransferEvent({
              from: STELLAR_ROUTER,
              to: MUXED_BASE_ACCOUNT,
              toMuxedId: MUXED_ID,
              amount: expectedStellarAmount,
              txHash: muxedTxHash,
              index: 4,
            }),
          ],
        ],
      ]);

      const itsClients: ItsVerificationClients = {
        readEvmItsSource: (_lane: ReverseItsLane) => Promise.resolve(validSourceState()),
        readStellarItsExecution: (_lane, txHashHex) =>
          Promise.resolve(validStellarState(eventsByTx.get(txHashHex) ?? [])),
      };

      const railClient: RailClient = {
        rail: "axelar",
        look: (pending: PendingTransfer): Promise<RailLookup> => {
          const isMuxed = pending.nonce === 78n;
          return Promise.resolve({
            kind: "found",
            report: {
              status: "attested",
              railStatus: "executed/received",
              reference: isMuxed ? "msg-78" : "msg-77",
              attestedAt: new Date("2026-10-12T12:00:05.000Z"),
              execution: {
                txHash: `0x${isMuxed ? muxedTxHash : STELLAR_EXEC_TX}`,
                commandId: isMuxed ? muxedCommandId : COMMAND_ID,
              },
            },
          });
        },
      };

      const { logger } = capturingLogger();
      const pass = new RailPass({
        route: RouteKind.AxelarIts,
        config,
        client: railClient,
        itsClients,
        db,
        logger,
        batchSize: 10,
        recheckAfterMs: 0,
        maxCheckFailures: 5,
      });

      await pass.tick(new AbortController().signal);

      const { rows } = await db.query(
        `SELECT source_nonce, recipient, token, amount, delivered, claim_id, rail_message_id
           FROM inbound_delivery
          ORDER BY source_nonce ASC`,
      );
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        source_nonce: "77",
        recipient: ACCOUNT_RECIPIENT,
        token: STELLAR_TOKEN_SAC,
        amount: "250000000",
        delivered: true,
        claim_id: null,
        rail_message_id: COMMAND_ID.toLowerCase(),
      });
      expect(rows[1]).toMatchObject({
        source_nonce: "78",
        recipient: MUXED_RECIPIENT,
        token: STELLAR_TOKEN_SAC,
        amount: "250000000",
        delivered: true,
        claim_id: null,
        rail_message_id: muxedCommandId.toLowerCase(),
      });
      expect(String(rows[1]?.recipient)).toHaveLength(69);
      expect(canonicalStellarRecipient(String(rows[1]?.recipient))?.muxedId).toBe(MUXED_ID);
    } finally {
      await close();
    }
  });

  it("rejects muxed identity stripping or muxedId alteration across note, router and SAC events", () => {
    const amount = 250_000_000n;
    const baseExpected = {
      originChain: "sepolia",
      sourceAxelarChain: "ethereum-sepolia",
      sourceAdapter: SEPOLIA_ITS_ADAPTER,
      sourceNonce: 99n,
      commandId: COMMAND_ID,
      tokenId: TOKEN_ID,
      its: STELLAR_ITS,
      destinationAdapter: STELLAR_ITS_ADAPTER,
      router: STELLAR_ROUTER,
      token: STELLAR_TOKEN_SAC,
      recipient: MUXED_RECIPIENT,
      amount,
    };

    const callback = makeItsCallbackEvent({
      recipient: MUXED_RECIPIENT,
      nonce: 99n,
      amount,
    });
    const bridgeInMuxed = makeRouterBridgeInEvent({
      recipient: MUXED_RECIPIENT,
      nonce: 99n,
      amount,
      delivered: true,
      claimId: 0n,
    });

    // Direct M... address on SAC transfer succeeds
    const directMuxedSac = makeSacTransferEvent({
      from: STELLAR_ROUTER,
      to: MUXED_RECIPIENT,
      amount,
    });
    expect(
      matchingReverseItsDelivery([callback, bridgeInMuxed, directMuxedSac], baseExpected),
    ).not.toBeNull();

    // Stripped to underlying G... account without to_muxed_id must fail
    const strippedToAccountSac = makeSacTransferEvent({
      from: STELLAR_ROUTER,
      to: MUXED_BASE_ACCOUNT,
      amount,
    });
    expect(
      matchingReverseItsDelivery([callback, bridgeInMuxed, strippedToAccountSac], baseExpected),
    ).toBeNull();

    // Wrong muxedId on CAP-0067 SAC transfer must fail
    const wrongMuxedIdSac = makeSacTransferEvent({
      from: STELLAR_ROUTER,
      to: MUXED_BASE_ACCOUNT,
      toMuxedId: MUXED_ID + 1n,
      amount,
    });
    expect(
      matchingReverseItsDelivery([callback, bridgeInMuxed, wrongMuxedIdSac], baseExpected),
    ).toBeNull();

    // Router BridgeIn stripped to G... or wrong M... must fail
    const wrongRouterBridgeIn = makeRouterBridgeInEvent({
      recipient: OTHER_MUXED_RECIPIENT,
      nonce: 99n,
      amount,
      delivered: true,
      claimId: 0n,
    });
    expect(
      matchingReverseItsDelivery([callback, wrongRouterBridgeIn, directMuxedSac], baseExpected),
    ).toBeNull();
  });

  it("refuses to treat adapter custody alone as final payout and records parked claims without marking delivered", async () => {
    const config = buildReverseItsConfig();
    const { db, close } = await openMigratedDb();
    try {
      await db.transaction(async (tx) => {
        await writeOutbound(
          tx,
          {
            chainKey: "sepolia",
            block: 9_600_001n,
            txHash: ORIGIN_EVM_TX,
            logIndex: 0,
            observedAt: new Date("2026-10-12T12:10:00.000Z"),
          },
          {
            route: RouteKind.AxelarIts,
            nonce: 201n,
            sender: SEPOLIA_SENDER,
            token: SEPOLIA_TOKEN.toLowerCase(),
            grossAmount: 10_030_000n,
            fee: 30_000n,
            netAmount: 10_000_000n,
            destinationChain: "stellar-testnet",
            destination: MUXED_RECIPIENT,
            railRef: COMMAND_ID,
          },
        );
      });

      const expectedAmount = 100_000_000n;
      const pendingList = await pendingForRail(db, {
        route: RouteKind.AxelarIts,
        limit: 10,
        notCheckedSince: new Date("2026-10-12T13:00:00.000Z"),
        maxCheckFailures: 5,
      });
      const transfer = pendingList[0];
      expect(transfer).toBeDefined();
      if (transfer === undefined) return;

      const report: RailReport = {
        status: "attested",
        railStatus: "executed/received",
        reference: "msg-201",
        attestedAt: new Date("2026-10-12T12:11:00.000Z"),
        execution: {
          txHash: `0x${STELLAR_EXEC_TX}`,
          commandId: COMMAND_ID,
        },
      };

      // Case 1: Adapter custody only (ITS callback + SAC transfer to adapter, no router payout)
      const adapterCustodyOnlyEvents: readonly RawStellarEvent[] = [
        makeItsCallbackEvent({
          recipient: MUXED_RECIPIENT,
          nonce: 201n,
          amount: expectedAmount,
        }),
        makeSacTransferEvent({
          from: STELLAR_ITS,
          to: STELLAR_ITS_ADAPTER,
          amount: expectedAmount,
          index: 2,
        }),
      ];
      const adapterOnlyResult = await verifyItsDelivery(config, db, transfer, report, {
        readEvmItsSource: () => Promise.resolve(validSourceState()),
        readStellarItsExecution: () => Promise.resolve(validStellarState(adapterCustodyOnlyEvents)),
      });
      expect(adapterOnlyResult).toBeNull();

      // Case 2: Router BridgeIn claims delivered=true, yet tokens stayed on adapter/router without SAC transfer to recipient
      const routerWithoutRecipientTransfer: readonly RawStellarEvent[] = [
        ...adapterCustodyOnlyEvents,
        makeSacTransferEvent({
          from: STELLAR_ITS_ADAPTER,
          to: STELLAR_ROUTER,
          amount: expectedAmount,
          index: 3,
        }),
        makeRouterBridgeInEvent({
          recipient: MUXED_RECIPIENT,
          nonce: 201n,
          amount: expectedAmount,
          delivered: true,
          claimId: 0n,
        }),
      ];
      const missingPayoutResult = await verifyItsDelivery(config, db, transfer, report, {
        readEvmItsSource: () => Promise.resolve(validSourceState()),
        readStellarItsExecution: () =>
          Promise.resolve(validStellarState(routerWithoutRecipientTransfer)),
      });
      expect(missingPayoutResult).toBeNull();

      // Case 3: Parked claim on router (tokens in router custody, ClaimParked + BridgeIn(delivered=false))
      const parkedEvents: readonly RawStellarEvent[] = [
        makeItsCallbackEvent({
          recipient: MUXED_RECIPIENT,
          nonce: 201n,
          amount: expectedAmount,
        }),
        makeSacTransferEvent({
          from: STELLAR_ITS_ADAPTER,
          to: STELLAR_ROUTER,
          amount: expectedAmount,
          index: 2,
        }),
        makeClaimParkedEvent({
          claimId: 42n,
          recipient: MUXED_RECIPIENT,
          nonce: 201n,
          amount: expectedAmount,
        }),
        makeRouterBridgeInEvent({
          recipient: MUXED_RECIPIENT,
          nonce: 201n,
          amount: expectedAmount,
          delivered: false,
          claimId: 42n,
        }),
      ];

      const { logger } = capturingLogger();
      const pass = new RailPass({
        route: RouteKind.AxelarIts,
        config,
        client: {
          rail: "axelar",
          look: () => Promise.resolve({ kind: "found", report }),
        },
        itsClients: {
          readEvmItsSource: () => Promise.resolve(validSourceState()),
          readStellarItsExecution: () => Promise.resolve(validStellarState(parkedEvents)),
        },
        db,
        logger,
        batchSize: 10,
        recheckAfterMs: 0,
        maxCheckFailures: 5,
      });

      await pass.tick(new AbortController().signal);

      const inbound = await db.query("SELECT * FROM inbound_delivery WHERE source_nonce = 201");
      expect(inbound.rows).toHaveLength(1);
      expect(inbound.rows[0]?.delivered).toBe(false);
      expect(inbound.rows[0]?.claim_id).toBe("42");
      expect(inbound.rows[0]?.recipient).toBe(MUXED_RECIPIENT);

      const claims = await db.query("SELECT * FROM pending_claim WHERE claim_id = 42");
      expect(claims.rows).toHaveLength(1);
      expect(claims.rows[0]?.recipient).toBe(MUXED_RECIPIENT);
      expect(claims.rows[0]?.settled).toBe(false);

      const attestation = await db.query(
        "SELECT status FROM rail_attestation WHERE transfer_id = $1",
        [transfer.transferId.toString()],
      );
      expect(attestation.rows[0]?.status).toBe("attested");

      // Queue query must not treat parked inbound_delivery(delivered=false) as delivered
      const requeued = await pendingForRail(db, {
        route: RouteKind.AxelarIts,
        limit: 10,
        notCheckedSince: new Date(Date.now() + 60_000),
        maxCheckFailures: 5,
      });
      expect(requeued[0]?.delivered).toBe(false);
    } finally {
      await close();
    }
  });

  it("leaves unsupported or mismatched token-manager mappings unverified", async () => {
    expect(isSupportedTokenManagerType(0)).toBe(true);
    expect(isSupportedTokenManagerType(1)).toBe(true);
    expect(isSupportedTokenManagerType(2)).toBe(true);
    expect(isSupportedTokenManagerType(4)).toBe(true);
    expect(isSupportedTokenManagerType("mint_burn")).toBe(true);
    expect(isSupportedTokenManagerType(["LockUnlock"])).toBe(true);

    // Fee-on-transfer (3 / lock_unlock_fee) and gateway/unknown variants are unsupported
    expect(isSupportedTokenManagerType(3)).toBe(false);
    expect(isSupportedTokenManagerType("lock_unlock_fee")).toBe(false);
    expect(isSupportedTokenManagerType(["LockUnlockFee"])).toBe(false);
    expect(isSupportedTokenManagerType(5)).toBe(false);
    expect(isSupportedTokenManagerType(null)).toBe(false);

    const config = buildReverseItsConfig();
    const { db, close } = await openMigratedDb();
    try {
      await db.transaction(async (tx) => {
        await writeOutbound(
          tx,
          {
            chainKey: "sepolia",
            block: 9_700_001n,
            txHash: ORIGIN_EVM_TX,
            logIndex: 0,
            observedAt: new Date("2026-10-12T12:20:00.000Z"),
          },
          {
            route: RouteKind.AxelarIts,
            nonce: 301n,
            sender: SEPOLIA_SENDER,
            token: SEPOLIA_TOKEN.toLowerCase(),
            grossAmount: 5_015_000n,
            fee: 15_000n,
            netAmount: 5_000_000n,
            destinationChain: "stellar-testnet",
            destination: ACCOUNT_RECIPIENT,
            railRef: COMMAND_ID,
          },
        );
      });

      const pending = (
        await pendingForRail(db, {
          route: RouteKind.AxelarIts,
          limit: 10,
          notCheckedSince: new Date("2026-10-12T13:00:00.000Z"),
          maxCheckFailures: 5,
        })
      )[0];
      expect(pending).toBeDefined();
      if (pending === undefined) return;

      const validEvents: readonly RawStellarEvent[] = [
        makeItsCallbackEvent({
          recipient: ACCOUNT_RECIPIENT,
          nonce: 301n,
          amount: 50_000_000n,
        }),
        makeRouterBridgeInEvent({
          recipient: ACCOUNT_RECIPIENT,
          nonce: 301n,
          amount: 50_000_000n,
          delivered: true,
          claimId: 0n,
        }),
        makeSacTransferEvent({
          from: STELLAR_ROUTER,
          to: ACCOUNT_RECIPIENT,
          amount: 50_000_000n,
        }),
      ];

      const report: RailReport = {
        status: "attested",
        railStatus: "executed/received",
        reference: "msg-301",
        attestedAt: new Date("2026-10-12T12:21:00.000Z"),
        execution: { txHash: `0x${STELLAR_EXEC_TX}`, commandId: COMMAND_ID },
      };

      const invalidCases: readonly {
        readonly label: string;
        readonly evm: EvmItsSourceState;
        readonly stellar: StellarItsExecutionState;
      }[] = [
        {
          label: "EVM fee-on-transfer token manager (type 3)",
          evm: validSourceState({ tokenManagerType: 3 }),
          stellar: validStellarState(validEvents),
        },
        {
          label: "Stellar fee-on-transfer token manager",
          evm: validSourceState(),
          stellar: validStellarState(validEvents, { tokenManagerType: "lock_unlock_fee" }),
        },
        {
          label: "unlinked zero tokenId on EVM adapter",
          evm: validSourceState({ adapterTokenId: `0x${"00".repeat(32)}` }),
          stellar: validStellarState(validEvents),
        },
        {
          label: "mismatched Stellar token_id_for",
          evm: validSourceState(),
          stellar: validStellarState(validEvents, {
            adapterTokenId: fromHex(`0x${"99".repeat(32)}`),
          }),
        },
        {
          label: "mismatched Stellar registered_token_address",
          evm: validSourceState(),
          stellar: validStellarState(validEvents, {
            registeredTokenAddress: makeStrkey(AddressKind.Contract, 0x77),
          }),
        },
      ];

      for (const testCase of invalidCases) {
        const res = await verifyItsDelivery(config, db, pending, report, {
          readEvmItsSource: () => Promise.resolve(testCase.evm),
          readStellarItsExecution: () => Promise.resolve(testCase.stellar),
        });
        expect(res, testCase.label).toBeNull();
      }
    } finally {
      await close();
    }
  });

  it("extracts Stellar 64-hex execution hashes without an 0x prefix in AxelarGmpClient", async () => {
    const parentId = `${ORIGIN_EVM_TX}-2`;
    const hubChildId = `${"aa".repeat(32)}-9`;
    const stellarRawHash = STELLAR_EXEC_TX;
    const rawCommandId = "ab".repeat(32);

    const responses = [
      {
        data: [
          {
            id: parentId,
            call: { transactionHash: ORIGIN_EVM_TX },
            status: "executed",
            executed: { childMessageIDs: [hubChildId] },
          },
        ],
      },
      {
        data: [
          {
            id: hubChildId,
            call: { parentMessageID: parentId },
            status: "executed",
            command_id: rawCommandId,
            executed: { transactionHash: stellarRawHash },
          },
        ],
      },
    ];

    const fetchMock = (() =>
      Promise.resolve(new Response(JSON.stringify(responses.shift())))) as typeof globalThis.fetch;

    const client = new AxelarGmpClient("https://testnet.api.gmp.axelarscan.io", {
      fetch: fetchMock,
    });
    const lookup = await client.look({
      transferId: 1n,
      route: RouteKind.AxelarIts,
      originChain: "sepolia",
      destinationChain: "stellar-testnet",
      nonce: 1n,
      originTx: ORIGIN_EVM_TX,
      status: null,
      checkFailures: 0,
      delivered: false,
    });

    expect(lookup.kind).toBe("found");
    if (lookup.kind === "found") {
      expect(lookup.report.execution).toEqual({
        txHash: `0x${stellarRawHash}`,
        commandId: `0x${rawCommandId}`,
      });
    }
  });
});
