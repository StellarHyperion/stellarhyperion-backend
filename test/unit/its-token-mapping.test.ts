import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import {
  AddressKind,
  CHAINS,
  RAIL_CONTRACTS,
  RouteKind,
  encodeStellarAddress,
  isEvmChain,
  toWord,
  type Hex,
} from "@hyperion/protocol";
import { encodeAbiParameters, encodeEventTopics, stringToHex } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { writeOutbound } from "../../src/chains/writers.js";
import { loadConfig, type AppConfig } from "../../src/config/config.js";
import type { Queryable, QueryResultRows, Transactional } from "../../src/db/pool.js";
import { text } from "../../src/db/rows.js";
import {
  compareItsTokenMapping,
  listArchivedTokenMappingAssumptions,
  verifyItsDelivery,
  type ItsDestinationChainProbe,
  type ItsTokenMappingOperatorDiagnostic,
} from "../../src/rails/axelar/delivery.js";
import { ITS_ABI, type DeliveryLog } from "../../src/rails/axelar/events.js";
import { RailPass } from "../../src/rails/pass.js";
import { pendingForRail } from "../../src/rails/queue.js";
import type { PendingTransfer, RailClient, RailLookup } from "../../src/rails/types.js";
import { completeEnv, readFixture } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function migrationUpSql(filename: string): string {
  const full = readFileSync(join(REPO_ROOT, "migrations", filename), "utf8");
  const [upPart] = full.split("-- Down Migration");
  if (upPart === undefined) {
    throw new Error(`missing -- Down Migration marker in ${filename}`);
  }
  return upPart;
}

function pgliteTransactional(pg: PGlite): Transactional {
  const toRows = (result: { rows: unknown[]; affectedRows?: number }): QueryResultRows => ({
    rows: result.rows as Record<string, unknown>[],
    rowCount: result.affectedRows ?? result.rows.length,
  });

  return {
    async query(sql: string, params?: readonly unknown[]): Promise<QueryResultRows> {
      const res = await pg.query(sql, params ? [...params] : []);
      return toRows(res);
    },
    async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
      return pg.transaction(async (tx) => {
        const wrapped: Queryable = {
          async query(sql: string, params?: readonly unknown[]): Promise<QueryResultRows> {
            const res = await tx.query(sql, params ? [...params] : []);
            return toRows(res);
          },
        };
        return work(wrapped);
      });
    },
  };
}

const STELLAR_SENDER = encodeStellarAddress(AddressKind.Account, new Uint8Array(32).fill(0x21));
const STELLAR_ITS_ADAPTER = encodeStellarAddress(
  AddressKind.Contract,
  new Uint8Array(32).fill(0x52),
);
const EVM_RECIPIENT: Hex = "0x1111111111111111111111111111111111111111";
const TOKEN_MANAGER_A: Hex = "0x2222222222222222222222222222222222222222";
const TOKEN_MANAGER_B: Hex = "0x3333333333333333333333333333333333333333";
const DEST_TOKEN_A: Hex = "0x4444444444444444444444444444444444444444";
const DEST_TOKEN_SPOOFED_SAME_SYMBOL: Hex = "0x5555555555555555555555555555555555555555";
const TOKEN_ID_A: Hex = `0x${"cd".repeat(32)}`;
const TOKEN_ID_B: Hex = `0x${"de".repeat(32)}`;
const COMMAND_ID_1: Hex = `0x${"a1".repeat(32)}`;
const COMMAND_ID_2: Hex = `0x${"a2".repeat(32)}`;
const DEST_TX_1: Hex = `0x${"b1".repeat(32)}`;
const DEST_TX_2: Hex = `0x${"b2".repeat(32)}`;
const BLOCK_HASH_1: Hex = `0x${"c1".repeat(32)}`;
const BLOCK_HASH_2: Hex = `0x${"c2".repeat(32)}`;
const GROSS_U256 = 950000000000000000000000n;
const FEE_U256 = 950000000000000000000n;
const NET_U256 = GROSS_U256 - FEE_U256;
const SOURCE_AXELAR_CHAIN = "stellar-2026-q1-2";

const SEPOLIA_ITS = (RAIL_CONTRACTS.sepolia?.axelar?.interchainTokenService ??
  "0xB5FB4BE02232B1bBA4dC8f81dc24C26980dE9e3C") as Hex;
const SEPOLIA_CHAIN = CHAINS.sepolia;
if (!isEvmChain(SEPOLIA_CHAIN)) {
  throw new Error("expected sepolia to be an EVM chain");
}
const SEPOLIA_CHAIN_ID = SEPOLIA_CHAIN.chainId;
const SEPOLIA_CONFIRMATIONS = BigInt(SEPOLIA_CHAIN.confirmations);

interface TestEnvBundle {
  readonly config: AppConfig;
  readonly sourceUsdcSac: string;
}

function buildConfigWithIts(): TestEnvBundle {
  const parsed = JSON.parse(readFixture("deployments-testnet.json")) as {
    networks: {
      "stellar-testnet": {
        adapters: Record<string, string>;
        tokens: {
          USDC: {
            sacId: string;
            routes: string[];
          };
        };
      };
    };
  };
  parsed.networks["stellar-testnet"].adapters["axelar-its"] = STELLAR_ITS_ADAPTER;
  parsed.networks["stellar-testnet"].tokens.USDC.routes = ["cctp", "axelar-its"];
  const sourceUsdcSac = parsed.networks["stellar-testnet"].tokens.USDC.sacId;
  const config = loadConfig({
    env: completeEnv(),
    readFile: () => JSON.stringify(parsed),
  });
  return { config, sourceUsdcSac };
}

function buildReceiptLogs(params: {
  readonly commandId: Hex;
  readonly tokenId: Hex;
  readonly tokenAddress: Hex;
}): readonly DeliveryLog[] {
  const received: DeliveryLog = {
    address: SEPOLIA_ITS,
    topics: encodeEventTopics({
      abi: ITS_ABI,
      eventName: "InterchainTransferReceived",
      args: {
        commandId: params.commandId,
        tokenId: params.tokenId,
        destinationAddress: EVM_RECIPIENT,
      },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters(
      [{ type: "string" }, { type: "bytes" }, { type: "uint256" }, { type: "bytes32" }],
      [SOURCE_AXELAR_CHAIN, stringToHex(STELLAR_SENDER), NET_U256, `0x${"0".repeat(64)}`],
    ),
    logIndex: 1,
  };

  const transfer: DeliveryLog = {
    address: params.tokenAddress,
    topics: encodeEventTopics({
      abi: ITS_ABI,
      eventName: "Transfer",
      args: { from: SEPOLIA_ITS, to: EVM_RECIPIENT },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: "uint256" }], [NET_U256]),
    logIndex: 2,
  };

  return [received, transfer];
}

describe("ITS token mapping change detection (#82)", () => {
  let pg: PGlite;
  let db: Transactional;
  let config: AppConfig;
  let sourceUsdcSac: string;

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(migrationUpSql("1790900000000_initial-schema.sql"));
    await pg.exec(migrationUpSql("1791000000000_cursor-block-hash.sql"));
    await pg.exec(migrationUpSql("1791200000000_its-token-mapping-audit.sql"));
    db = pgliteTransactional(pg);
    const bundle = buildConfigWithIts();
    config = bundle.config;
    sourceUsdcSac = bundle.sourceUsdcSac;
  });

  beforeEach(async () => {
    await db.query("DELETE FROM its_token_mapping_audit");
    await db.query("DELETE FROM inbound_delivery");
    await db.query("DELETE FROM rail_attestation");
    await db.query("DELETE FROM outbound_transfer");
  });

  afterAll(async () => {
    await pg.close();
  });

  async function seedTransfer(nonce: bigint): Promise<PendingTransfer> {
    const originTx = `0x${nonce.toString(16).padStart(64, "0")}`;
    await db.transaction(async (tx) => {
      await writeOutbound(
        tx,
        {
          chainKey: "stellar-testnet",
          block: 900_000n + nonce,
          txHash: originTx,
          logIndex: null,
          observedAt: new Date("2026-10-22T00:00:00Z"),
        },
        {
          route: RouteKind.AxelarIts,
          nonce,
          sender: STELLAR_SENDER,
          token: sourceUsdcSac,
          grossAmount: GROSS_U256,
          fee: FEE_U256,
          netAmount: NET_U256,
          destinationChain: "sepolia",
          destination: toWord(EVM_RECIPIENT),
          railRef: null,
        },
      );
    });

    const pending = await pendingForRail(db, {
      route: RouteKind.AxelarIts,
      limit: 20,
      notCheckedSince: new Date("2026-10-22T01:00:00Z"),
      maxCheckFailures: 5,
    });
    const matched = pending.find((item) => item.nonce === nonce);
    if (!matched) throw new Error(`missing seeded transfer for nonce ${nonce.toString()}`);
    return matched;
  }

  it("never lets registry symbol equality bypass changed token identity, manager, or decimals", () => {
    // Same "USDC" symbol on both registry and ERC-20, yet contract address changed:
    expect(
      compareItsTokenMapping(
        {
          tokenId: TOKEN_ID_A,
          tokenManager: TOKEN_MANAGER_A,
          destinationToken: DEST_TOKEN_A,
          decimals: 7,
          registrySymbol: "USDC",
        },
        {
          tokenId: TOKEN_ID_A,
          tokenManager: TOKEN_MANAGER_A,
          registeredTokenAddress: DEST_TOKEN_SPOOFED_SAME_SYMBOL,
          managerTokenAddress: DEST_TOKEN_SPOOFED_SAME_SYMBOL,
          decimals: 7,
          symbol: "USDC",
        },
      ),
    ).toEqual(["destination_token_changed"]);

    // Same "USDC" symbol, yet decimals precision changed from 7 to 6:
    expect(
      compareItsTokenMapping(
        {
          tokenId: TOKEN_ID_A,
          tokenManager: TOKEN_MANAGER_A,
          destinationToken: DEST_TOKEN_A,
          decimals: 7,
          registrySymbol: "USDC",
        },
        {
          tokenId: TOKEN_ID_A,
          tokenManager: TOKEN_MANAGER_A,
          registeredTokenAddress: DEST_TOKEN_A,
          managerTokenAddress: DEST_TOKEN_A,
          decimals: 6,
          symbol: "USDC",
        },
      ),
    ).toEqual(["decimals_precision_changed"]);

    // TokenManager and ITS registeredTokenAddress disagree:
    expect(
      compareItsTokenMapping(
        { tokenId: TOKEN_ID_A, registrySymbol: "USDC" },
        {
          tokenId: TOKEN_ID_A,
          tokenManager: TOKEN_MANAGER_A,
          registeredTokenAddress: DEST_TOKEN_A,
          managerTokenAddress: DEST_TOKEN_SPOOFED_SAME_SYMBOL,
          decimals: 7,
          symbol: "USDC",
        },
      ),
    ).toEqual(["manager_token_disagreement"]);
  });

  it("archives verified proof assumptions and blocks subsequent drifted proofs while keeping history auditable", async () => {
    const first = await seedTransfer(1n);
    const second = await seedTransfer(2n);
    const diagnostics: ItsTokenMappingOperatorDiagnostic[] = [];

    const readSourceLane = () =>
      Promise.resolve({
        tokenId: TOKEN_ID_A,
        sourceChainName: SOURCE_AXELAR_CHAIN,
      });

    // Transfer 1 establishes baseline proof at block 3000 with DEST_TOKEN_A, TOKEN_MANAGER_A, decimals 7.
    const probe1: ItsDestinationChainProbe = {
      getChainId: () => Promise.resolve(SEPOLIA_CHAIN_ID),
      getTransactionReceipt: () =>
        Promise.resolve({
          status: "success",
          blockNumber: 3000n,
          blockHash: BLOCK_HASH_1,
          transactionHash: DEST_TX_1,
          logs: buildReceiptLogs({
            commandId: COMMAND_ID_1,
            tokenId: TOKEN_ID_A,
            tokenAddress: DEST_TOKEN_A,
          }),
        }),
      getBlockNumber: () => Promise.resolve(3000n + SEPOLIA_CONFIRMATIONS),
      getBlock: () => Promise.resolve({ hash: BLOCK_HASH_1, timestamp: 1_790_001_000n }),
      readTokenMappingState: () =>
        Promise.resolve({
          tokenManager: TOKEN_MANAGER_A,
          registeredTokenAddress: DEST_TOKEN_A,
          managerTokenAddress: DEST_TOKEN_A,
          decimals: 7,
          symbol: "USDC",
        }),
    };

    const verifiedFirst = await verifyItsDelivery(
      config,
      db,
      first,
      {
        status: "attested",
        railStatus: "executed/received",
        reference: "0xmsg-1",
        attestedAt: new Date("2026-10-22T00:01:00Z"),
        execution: { txHash: DEST_TX_1, commandId: COMMAND_ID_1 },
      },
      {
        readSourceLane,
        createDestinationProbe: () => probe1,
        onTokenMappingDrift: (d) => diagnostics.push(d),
      },
    );

    expect(verifiedFirst).not.toBeNull();
    expect(diagnostics).toHaveLength(0);

    // Transfer 2 arrives at block 3050 where destination manager switched to TOKEN_MANAGER_B,
    // token contract changed to DEST_TOKEN_SPOOFED_SAME_SYMBOL (still reporting symbol "USDC"),
    // and decimals changed from 7 to 6.
    const probe2: ItsDestinationChainProbe = {
      getChainId: () => Promise.resolve(SEPOLIA_CHAIN_ID),
      getTransactionReceipt: () =>
        Promise.resolve({
          status: "success",
          blockNumber: 3050n,
          blockHash: BLOCK_HASH_2,
          transactionHash: DEST_TX_2,
          logs: buildReceiptLogs({
            commandId: COMMAND_ID_2,
            tokenId: TOKEN_ID_A,
            tokenAddress: DEST_TOKEN_SPOOFED_SAME_SYMBOL,
          }),
        }),
      getBlockNumber: () => Promise.resolve(3050n + SEPOLIA_CONFIRMATIONS),
      getBlock: () => Promise.resolve({ hash: BLOCK_HASH_2, timestamp: 1_790_002_000n }),
      readTokenMappingState: () =>
        Promise.resolve({
          tokenManager: TOKEN_MANAGER_B,
          registeredTokenAddress: DEST_TOKEN_SPOOFED_SAME_SYMBOL,
          managerTokenAddress: DEST_TOKEN_SPOOFED_SAME_SYMBOL,
          decimals: 6,
          symbol: "USDC",
        }),
    };

    const verifiedSecond = await verifyItsDelivery(
      config,
      db,
      second,
      {
        status: "attested",
        railStatus: "executed/received",
        reference: "0xmsg-2",
        attestedAt: new Date("2026-10-22T00:02:00Z"),
        execution: { txHash: DEST_TX_2, commandId: COMMAND_ID_2 },
      },
      {
        readSourceLane,
        createDestinationProbe: () => probe2,
        onTokenMappingDrift: (d) => diagnostics.push(d),
      },
    );

    // Proof establishment is blocked!
    expect(verifiedSecond).toBeNull();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.driftReasons).toEqual([
      "token_manager_changed",
      "destination_token_changed",
      "decimals_precision_changed",
    ]);
    expect(diagnostics[0]?.observed.symbol).toBe("USDC");
    expect(diagnostics[0]?.observed.registrySymbol).toBe("USDC");

    // Verify Transfer 1's archived verified proof assumptions remain intact alongside Transfer 2's drift row!
    const allAudit = await listArchivedTokenMappingAssumptions(db);
    expect(allAudit).toHaveLength(2);
    expect(allAudit[0]?.transferId).toBe(first.transferId);
    expect(allAudit[0]?.status).toBe("verified");
    expect(allAudit[0]?.observedDestinationToken).toBe(DEST_TOKEN_A.toLowerCase());
    expect(allAudit[0]?.observedTokenManager).toBe(TOKEN_MANAGER_A.toLowerCase());
    expect(allAudit[0]?.observedDecimals).toBe(7);

    expect(allAudit[1]?.transferId).toBe(second.transferId);
    expect(allAudit[1]?.status).toBe("drift_detected");
    expect(allAudit[1]?.expectedDestinationToken).toBe(DEST_TOKEN_A.toLowerCase());
    expect(allAudit[1]?.observedDestinationToken).toBe(
      DEST_TOKEN_SPOOFED_SAME_SYMBOL.toLowerCase(),
    );
    expect(allAudit[1]?.expectedDecimals).toBe(7);
    expect(allAudit[1]?.observedDecimals).toBe(6);
  });

  it("emits structured operator warning logs via RailPass when tokenId drifts on chain", async () => {
    const transfer = await seedTransfer(3n);
    const { logger, lines } = capturingLogger();

    const mockClient: RailClient = {
      rail: "axelar",
      look: (): Promise<RailLookup> =>
        Promise.resolve({
          kind: "found",
          report: {
            status: "attested",
            railStatus: "executed/received",
            reference: "0xmsg-3",
            attestedAt: new Date("2026-10-22T00:05:00Z"),
            execution: { txHash: DEST_TX_2, commandId: COMMAND_ID_2 },
          },
        }),
    };

    const pass = new RailPass({
      route: RouteKind.AxelarIts,
      client: mockClient,
      db,
      logger,
      batchSize: 10,
      recheckAfterMs: 0,
      maxCheckFailures: 5,
      config,
      itsDeliveryOptions: {
        readSourceLane: () =>
          Promise.resolve({ tokenId: TOKEN_ID_A, sourceChainName: SOURCE_AXELAR_CHAIN }),
        createDestinationProbe: () => ({
          getChainId: () => Promise.resolve(SEPOLIA_CHAIN_ID),
          getTransactionReceipt: () =>
            Promise.resolve({
              status: "success",
              blockNumber: 4000n,
              blockHash: BLOCK_HASH_2,
              transactionHash: DEST_TX_2,
              // Receipt emits TOKEN_ID_B instead of expected TOKEN_ID_A!
              logs: buildReceiptLogs({
                commandId: COMMAND_ID_2,
                tokenId: TOKEN_ID_B,
                tokenAddress: DEST_TOKEN_A,
              }),
            }),
          getBlockNumber: () => Promise.resolve(4000n + SEPOLIA_CONFIRMATIONS),
          getBlock: () => Promise.resolve({ hash: BLOCK_HASH_2, timestamp: 1_790_003_000n }),
          readTokenMappingState: () =>
            Promise.resolve({
              tokenManager: TOKEN_MANAGER_A,
              registeredTokenAddress: DEST_TOKEN_A,
              managerTokenAddress: DEST_TOKEN_A,
              decimals: 7,
              symbol: "USDC",
            }),
        }),
      },
    });

    await pass.tick(new AbortController().signal);

    // Must remain attested (NOT delivered) and emit operator warning
    const attRow = (
      await db.query("SELECT status FROM rail_attestation WHERE transfer_id = $1", [
        transfer.transferId.toString(),
      ])
    ).rows[0];
    expect(attRow).toBeDefined();
    if (attRow) {
      expect(text(attRow, "status")).toBe("attested");
    }
    expect((await db.query("SELECT id FROM inbound_delivery")).rows).toHaveLength(0);
    expect(lines.some((entry) => entry.message.includes("its token mapping drift detected"))).toBe(
      true,
    );
  });
});
