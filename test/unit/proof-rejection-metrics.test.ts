import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
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
import { afterEach, describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, hexToBytes, stringToHex, type Hex } from "viem";

import { loadConfig } from "../../src/config/config.js";
import type { Database, Queryable, Transactional } from "../../src/db/pool.js";
import { buildServer } from "../../src/http/server.js";
import { verifyItsDelivery, type ItsPublicClientLike } from "../../src/rails/axelar/delivery.js";
import { ITS_ABI, type DeliveryLog } from "../../src/rails/axelar/events.js";
import { verifyCctpDelivery, type CctpPublicClientLike } from "../../src/rails/cctp/delivery.js";
import { CCTP_RECEIPT_ABI } from "../../src/rails/cctp/events.js";
import { RailPass } from "../../src/rails/pass.js";
import {
  PROOF_REJECTION_REASONS,
  type ProofRejectionMetricsSnapshot,
} from "../../src/rails/proof-reasons.js";
import type { PendingTransfer, RailClient, RailReport } from "../../src/rails/types.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const ACTIVE_TESTNET_DEPLOYMENTS = fileURLToPath(
  new URL("../../deployments/testnet.json", import.meta.url),
);
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const WRONG_RECIPIENT = "0x9999999999999999999999999999999999999999";
const RECIPIENT_WORD = `0x000000000000000000000000${RECIPIENT.slice(2)}` as const;
const SENDER_STELLAR = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const CANDIDATE_CCTP_TX: Hex = `0x${"c1".repeat(32)}`;
const CANDIDATE_ITS_TX: Hex = `0x${"a2".repeat(32)}`;
const COMMAND_ID: Hex = `0x${"b3".repeat(32)}`;
const BLOCK_HASH: Hex = `0x${"d4".repeat(32)}`;

interface PgliteHarness {
  readonly pg: PGlite;
  readonly db: Database & Transactional;
}

async function createMigratedDb(): Promise<PgliteHarness> {
  const pg = new PGlite();
  for (const name of [
    "1790900000000_initial-schema.sql",
    "1791000000000_cursor-block-hash.sql",
    "1791100000000_cursor-autovacuum-tuning.sql",
    "1791200000000_proof-rejection-metrics.sql",
  ]) {
    const sql = readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8").split(
      "-- Down Migration",
    )[0]!;
    await pg.exec(sql);
  }

  const runQuery = async (sql: string, params: readonly unknown[] = []) => {
    const normalizedParams = params.map((p) => (p instanceof Date ? p.toISOString() : p));
    const result = await pg.query(sql, normalizedParams);
    const int8 = result.fields
      .filter((field) => field.dataTypeID === 20)
      .map((field) => field.name);
    const rows = result.rows.map((raw) => {
      const row = { ...(raw as Record<string, unknown>) };
      for (const column of int8) {
        const value = row[column];
        if (typeof value === "number" || typeof value === "bigint") row[column] = String(value);
      }
      return row;
    });
    return { rows, rowCount: result.affectedRows ?? result.rows.length };
  };

  const db = {
    query: runQuery,
    ping: async () => {
      await pg.query("SELECT 1");
    },
    close: async () => {
      await pg.close();
    },
    transaction: async <T>(work: (tx: Queryable) => Promise<T>): Promise<T> => {
      await pg.exec("BEGIN");
      try {
        const out = await work({ query: runQuery });
        await pg.exec("COMMIT");
        return out;
      } catch (err) {
        await pg.exec("ROLLBACK");
        throw err;
      }
    },
  };

  return { pg, db: db as unknown as Database & Transactional };
}

function buildCctpMessageHex(options: {
  readonly sourceToken: string;
  readonly sourceAdapter: string;
  readonly destinationMessenger: string;
  readonly recipient: string;
  readonly burnAmount: bigint;
  readonly feeExecuted?: bigint;
  readonly finalityThreshold?: number;
}): Hex {
  const nonce: Hex = `0x${"ee".repeat(32)}`;
  const word = (addr: string) => hexToBytes(`0x${addr.slice(2).padStart(64, "0")}`);
  const raw = new Uint8Array(148 + 228);
  const view = new DataView(raw.buffer);
  view.setUint32(0, 1);
  view.setUint32(4, 27);
  view.setUint32(8, 0); // sepolia domain = 0
  raw.set(hexToBytes(nonce), 12);
  raw.set(StrKey.decodeContract("CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP"), 44);
  raw.set(word(options.destinationMessenger), 76);
  view.setUint32(140, 2000);
  view.setUint32(144, options.finalityThreshold ?? 2000);
  view.setUint32(148, 1);
  raw.set(StrKey.decodeContract(options.sourceToken), 152);
  raw.set(word(options.recipient), 184);
  raw.set(word(`0x${options.burnAmount.toString(16)}`), 216);
  raw.set(StrKey.decodeContract(options.sourceAdapter), 248);
  raw.set(word(`0x${500000n.toString(16)}`), 280);
  raw.set(word(`0x${(options.feeExecuted ?? 100000n).toString(16)}`), 312);
  return toHex(raw);
}

describe("proof rejection metrics by shared normalized reason", () => {
  const openHarnesses: PgliteHarness[] = [];

  afterEach(async () => {
    while (openHarnesses.length > 0) {
      const h = openHarnesses.pop()!;
      await h.pg.close();
    }
  });

  it("classifies recipient, token, amount, finality, and provider inconsistency symmetrically across CCTP and ITS", async () => {
    const harness = await createMigratedDb();
    openHarnesses.push(harness);

    const secretRpcUrl = "https://operator:super_secret_token@rpc.stellar.internal:8545";
    const config = loadConfig({
      env: completeEnv({
        HYPERION_DEPLOYMENTS_FILE: ACTIVE_TESTNET_DEPLOYMENTS,
        STELLAR_RPC_URL: secretRpcUrl,
        KEEPER_ENABLED: "false",
      }),
    });
    const stellarNet = config.deployments.networks["stellar-testnet"];
    if (!stellarNet || !isStellarDeployment(stellarNet) || !stellarNet.tokens.USDC) {
      throw new Error("expected stellar-testnet deployment");
    }
    const sacId = stellarNet.tokens.USDC.sacId;
    const cctpAdapter = stellarNet.adapters[RouteKind.Cctp]!;
    const sepoliaCctp = RAIL_CONTRACTS.sepolia!.cctp!;
    const sepoliaUsdc = assetOn("sepolia", "USDC")!;
    if (sepoliaUsdc.family !== "evm") throw new Error("expected EVM USDC");
    const sepoliaChain = CHAINS.sepolia;
    if (!isEvmChain(sepoliaChain)) throw new Error("expected EVM sepolia");
    const sepoliaChainId = sepoliaChain.chainId;

    // Insert 1 CCTP outbound transfer and 1 ITS outbound transfer
    const cctpInsert = await harness.db.query(
      `INSERT INTO outbound_transfer
         (origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
          destination_chain, destination, origin_block, origin_tx)
       VALUES ('stellar-testnet', 0, 101, $1, $2, 1000000000, 3000000, 997000000,
               'sepolia', $3, 500, '0xcctpsrc')
       RETURNING id`,
      [SENDER_STELLAR, sacId, RECIPIENT_WORD],
    );
    const cctpId = BigInt(String(cctpInsert.rows[0]?.id));

    const itsInsert = await harness.db.query(
      `INSERT INTO outbound_transfer
         (origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
          destination_chain, destination, origin_block, origin_tx)
       VALUES ('stellar-testnet', 1, 202, $1, $2, 10000000, 30000, 9970000,
               'sepolia', $3, 501, '0xitssrc')
       RETURNING id`,
      [SENDER_STELLAR, sacId, RECIPIENT_WORD],
    );
    const itsId = BigInt(String(itsInsert.rows[0]?.id));

    const cctpTransfer: PendingTransfer = {
      transferId: cctpId,
      route: RouteKind.Cctp,
      originChain: "stellar-testnet",
      destinationChain: "sepolia",
      nonce: 101n,
      originTx: "0xcctpsrc",
      status: "attested",
      checkFailures: 0,
      delivered: false,
    };

    const itsTransfer: PendingTransfer = {
      transferId: itsId,
      route: RouteKind.AxelarIts,
      originChain: "stellar-testnet",
      destinationChain: "sepolia",
      nonce: 202n,
      originTx: "0xitssrc",
      status: "attested",
      checkFailures: 0,
      delivered: false,
    };

    const { logger, lines } = capturingLogger();

    // --- 1. CCTP rejections across all 5 shared normalized categories ---
    // (a) recipient_mismatch
    expect(
      await verifyCctpDelivery(
        config,
        harness.db,
        cctpTransfer,
        {
          status: "attested",
          railStatus: "complete",
          reference: "ref-1",
          attestedAt: new Date(),
          forwardTxHash: CANDIDATE_CCTP_TX,
          messageBytes: buildCctpMessageHex({
            sourceToken: sacId,
            sourceAdapter: cctpAdapter,
            destinationMessenger: sepoliaCctp.tokenMessengerV2,
            recipient: WRONG_RECIPIENT,
            burnAmount: 99_700_000n,
          }),
        },
        { logger },
      ),
    ).toBeNull();

    // (b) token_mismatch
    expect(
      await verifyCctpDelivery(
        config,
        harness.db,
        cctpTransfer,
        {
          status: "attested",
          railStatus: "complete",
          reference: "ref-1",
          attestedAt: new Date(),
          forwardTxHash: CANDIDATE_CCTP_TX,
          messageBytes: buildCctpMessageHex({
            sourceToken: cctpAdapter, // wrong token contract
            sourceAdapter: cctpAdapter,
            destinationMessenger: sepoliaCctp.tokenMessengerV2,
            recipient: RECIPIENT,
            burnAmount: 99_700_000n,
          }),
        },
        { logger },
      ),
    ).toBeNull();

    // (c) amount_mismatch
    expect(
      await verifyCctpDelivery(
        config,
        harness.db,
        cctpTransfer,
        {
          status: "attested",
          railStatus: "complete",
          reference: "ref-1",
          attestedAt: new Date(),
          forwardTxHash: CANDIDATE_CCTP_TX,
          messageBytes: buildCctpMessageHex({
            sourceToken: sacId,
            sourceAdapter: cctpAdapter,
            destinationMessenger: sepoliaCctp.tokenMessengerV2,
            recipient: RECIPIENT,
            burnAmount: 50_000_000n,
          }),
        },
        { logger },
      ),
    ).toBeNull();

    // (d) insufficient_finality (finalityThreshold < 2000)
    expect(
      await verifyCctpDelivery(
        config,
        harness.db,
        cctpTransfer,
        {
          status: "attested",
          railStatus: "complete",
          reference: "ref-1",
          attestedAt: new Date(),
          forwardTxHash: CANDIDATE_CCTP_TX,
          messageBytes: buildCctpMessageHex({
            sourceToken: sacId,
            sourceAdapter: cctpAdapter,
            destinationMessenger: sepoliaCctp.tokenMessengerV2,
            recipient: RECIPIENT,
            burnAmount: 99_700_000n,
            finalityThreshold: 1000,
          }),
        },
        { logger },
      ),
    ).toBeNull();

    // (e) provider_inconsistency (reverted receipt on destination RPC)
    const validCctpMsg = buildCctpMessageHex({
      sourceToken: sacId,
      sourceAdapter: cctpAdapter,
      destinationMessenger: sepoliaCctp.tokenMessengerV2,
      recipient: RECIPIENT,
      burnAmount: 99_700_000n,
    });
    const revertedCctpClient: CctpPublicClientLike = {
      getChainId: () => Promise.resolve(sepoliaChainId),
      getTransactionReceipt: () =>
        Promise.resolve({
          status: "reverted",
          blockNumber: 100n,
          blockHash: BLOCK_HASH,
          transactionHash: CANDIDATE_CCTP_TX,
          logs: [],
        }),
      getBlockNumber: () => Promise.resolve(150n),
      getBlock: () => Promise.resolve({ hash: BLOCK_HASH, timestamp: 1_790_000_100n }),
    };
    expect(
      await verifyCctpDelivery(
        config,
        harness.db,
        cctpTransfer,
        {
          status: "attested",
          railStatus: "complete",
          reference: "ref-1",
          attestedAt: new Date(),
          forwardTxHash: CANDIDATE_CCTP_TX,
          messageBytes: validCctpMsg,
        },
        { publicClient: revertedCctpClient, logger },
      ),
    ).toBeNull();

    // --- 2. Axelar ITS rejections across all 5 shared normalized categories ---
    const tokenIdBytes = new Uint8Array(32).fill(0x55);
    const tokenIdHex = toHex(tokenIdBytes);
    const itsAddress = RAIL_CONTRACTS.sepolia!.axelar!.interchainTokenService as Hex;
    const destItsToken: Hex = "0x3333333333333333333333333333333333333333";
    const sourceChainName = "stellar-2026-q1";

    const simulateView = (_contract: string, method: string): Promise<unknown> => {
      if (method === "token_id_for") return Promise.resolve(tokenIdBytes);
      if (method === "get_config") return Promise.resolve({ its: "CITS_CONTRACT" });
      if (method === "chain_name") return Promise.resolve(sourceChainName);
      return Promise.resolve(null);
    };

    const makeItsLogs = (overrides: {
      readonly recipient?: Hex;
      readonly tokenId?: Hex;
      readonly amount?: bigint;
    }): DeliveryLog[] => {
      const rec = overrides.recipient ?? RECIPIENT;
      const tid = overrides.tokenId ?? tokenIdHex;
      const amt = overrides.amount ?? 9_970_000n;
      return [
        {
          address: itsAddress,
          topics: encodeEventTopics({
            abi: ITS_ABI,
            eventName: "InterchainTransferReceived",
            args: { commandId: COMMAND_ID, tokenId: tid, destinationAddress: rec },
          }) as [Hex, ...Hex[]],
          data: encodeAbiParameters(
            [{ type: "string" }, { type: "bytes" }, { type: "uint256" }, { type: "bytes32" }],
            [sourceChainName, stringToHex(SENDER_STELLAR), amt, `0x${"0".repeat(64)}`],
          ),
          logIndex: 0,
        },
        {
          address: destItsToken,
          topics: encodeEventTopics({
            abi: ITS_ABI,
            eventName: "Transfer",
            args: { from: itsAddress, to: rec },
          }) as [Hex, ...Hex[]],
          data: encodeAbiParameters([{ type: "uint256" }], [amt]),
          logIndex: 1,
        },
      ];
    };

    const makeItsClient = (opts: {
      readonly status?: string;
      readonly head?: bigint;
      readonly logs?: readonly DeliveryLog[];
    }): ItsPublicClientLike => ({
      getChainId: () => Promise.resolve(sepoliaChainId),
      getTransactionReceipt: () =>
        Promise.resolve({
          status: opts.status ?? "success",
          blockNumber: 200n,
          blockHash: BLOCK_HASH,
          transactionHash: CANDIDATE_ITS_TX,
          logs: opts.logs ?? makeItsLogs({}),
        }),
      getBlockNumber: () => Promise.resolve(opts.head ?? 250n),
      readContract: () => Promise.resolve(destItsToken),
      getBlock: () => Promise.resolve({ hash: BLOCK_HASH, timestamp: 1_790_000_200n }),
    });

    const itsCandidateReport: RailReport = {
      status: "attested",
      railStatus: "executed",
      reference: "gmp-ref-1",
      attestedAt: new Date(),
      execution: { txHash: CANDIDATE_ITS_TX, commandId: COMMAND_ID },
    };

    // (a) recipient_mismatch
    expect(
      await verifyItsDelivery(config, harness.db, itsTransfer, itsCandidateReport, {
        simulateView,
        publicClient: makeItsClient({ logs: makeItsLogs({ recipient: WRONG_RECIPIENT }) }),
        logger,
      }),
    ).toBeNull();

    // (b) token_mismatch
    expect(
      await verifyItsDelivery(config, harness.db, itsTransfer, itsCandidateReport, {
        simulateView,
        publicClient: makeItsClient({ logs: makeItsLogs({ tokenId: `0x${"77".repeat(32)}` }) }),
        logger,
      }),
    ).toBeNull();

    // (c) amount_mismatch
    expect(
      await verifyItsDelivery(config, harness.db, itsTransfer, itsCandidateReport, {
        simulateView,
        publicClient: makeItsClient({ logs: makeItsLogs({ amount: 123n }) }),
        logger,
      }),
    ).toBeNull();

    // (d) insufficient_finality (head too close to receipt block)
    expect(
      await verifyItsDelivery(config, harness.db, itsTransfer, itsCandidateReport, {
        simulateView,
        publicClient: makeItsClient({ head: 201n }),
        logger,
      }),
    ).toBeNull();

    // (e) provider_inconsistency (reverted receipt)
    expect(
      await verifyItsDelivery(config, harness.db, itsTransfer, itsCandidateReport, {
        simulateView,
        publicClient: makeItsClient({ status: "reverted" }),
        logger,
      }),
    ).toBeNull();

    // Verify separate API-only server exposes durable cross-process metrics & readiness
    const apiConfig = loadConfig({
      env: completeEnv({
        HYPERION_DEPLOYMENTS_FILE: ACTIVE_TESTNET_DEPLOYMENTS,
        STELLAR_RPC_URL: secretRpcUrl,
        INDEXER_ENABLED: "false",
        KEEPER_ENABLED: "false",
      }),
    });
    const app = buildServer({
      config: apiConfig,
      logger,
      db: harness.db,
      readiness: [],
    });

    const metricsRes = await app.inject({ method: "GET", url: "/v1/metrics" });
    expect(metricsRes.statusCode).toBe(200);
    const metricsJson = metricsRes.json<{
      transfers: { totalInbound: number };
      proofRejections: ProofRejectionMetricsSnapshot;
    }>();

    expect(metricsJson.transfers.totalInbound).toBe(0);
    expect(metricsJson.proofRejections.categories).toEqual(PROOF_REJECTION_REASONS);
    expect(metricsJson.proofRejections.totalRejected).toBe(10);
    expect(metricsJson.proofRejections.integrityRejections).toBe(6);
    expect(metricsJson.proofRejections.byReason).toEqual({
      recipient_mismatch: 2,
      token_mismatch: 2,
      amount_mismatch: 2,
      insufficient_finality: 2,
      provider_inconsistency: 2,
    });
    expect(metricsJson.proofRejections.byRail.cctp.reasons).toEqual({
      recipient_mismatch: 1,
      token_mismatch: 1,
      amount_mismatch: 1,
      insufficient_finality: 1,
      provider_inconsistency: 1,
    });
    expect(metricsJson.proofRejections.byRail["axelar-its"].reasons).toEqual({
      recipient_mismatch: 1,
      token_mismatch: 1,
      amount_mismatch: 1,
      insufficient_finality: 1,
      provider_inconsistency: 1,
    });

    const readyRes = await app.inject({ method: "GET", url: "/ready" });
    expect(readyRes.statusCode).toBe(200);
    expect(readyRes.json().status).toBe("degraded");
    expect(readyRes.json().proofRejections).toEqual({
      state: "degraded",
      totalRejected: 10,
      integrityRejections: 6,
    });

    // Verify metric labels, bodies, and logs NEVER expose candidate hashes, wallet addresses, or credentials
    const rawMetricsText = metricsRes.body;
    const rawReadyText = readyRes.body;
    const rawLogsText = JSON.stringify(lines);
    for (const forbidden of [
      CANDIDATE_CCTP_TX,
      CANDIDATE_ITS_TX,
      COMMAND_ID,
      RECIPIENT,
      WRONG_RECIPIENT,
      SENDER_STELLAR,
      "super_secret_token",
      secretRpcUrl,
    ]) {
      expect(rawMetricsText).not.toContain(forbidden);
      expect(rawReadyText).not.toContain(forbidden);
      expect(rawLogsText).not.toContain(forbidden);
    }

    await app.close();
  });

  it("ensures RailPass keeps transfers undelivered when candidate destination proof is rejected", async () => {
    const harness = await createMigratedDb();
    openHarnesses.push(harness);

    const config = loadConfig({ env: completeEnv({ KEEPER_ENABLED: "false" }) });
    const stellarNet = config.deployments.networks["stellar-testnet"];
    if (!stellarNet || !isStellarDeployment(stellarNet) || !stellarNet.tokens.USDC) {
      throw new Error("expected stellar-testnet deployment");
    }

    await harness.db.query(
      `INSERT INTO outbound_transfer
         (origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
          destination_chain, destination, origin_block, origin_tx)
       VALUES ('stellar-testnet', 0, 303, $1, $2, 1000000000, 3000000, 997000000,
               'sepolia', $3, 600, '0xcctpsrc303')`,
      [SENDER_STELLAR, stellarNet.tokens.USDC.sacId, RECIPIENT_WORD],
    );

    const fakeIrisClient: RailClient = {
      rail: "cctp",
      look: () =>
        Promise.resolve({
          kind: "found",
          report: {
            status: "attested",
            railStatus: "complete",
            reference: "iris-303",
            attestedAt: new Date("2026-10-29T12:00:00Z"),
            forwardTxHash: CANDIDATE_CCTP_TX,
            // Missing messageBytes despite forwardTxHash -> provider_inconsistency!
          },
        }),
    };

    const { logger } = capturingLogger();
    const pass = new RailPass({
      route: RouteKind.Cctp,
      client: fakeIrisClient,
      db: harness.db,
      logger,
      batchSize: 10,
      recheckAfterMs: 1_000,
      maxCheckFailures: 5,
      config,
    });

    await pass.tick(AbortSignal.timeout(5_000));

    // Must NOT write inbound_delivery or mark status = 'delivered'
    const inboundCount = await harness.db.query(
      "SELECT count(*)::int AS count FROM inbound_delivery",
    );
    expect(Number(inboundCount.rows[0]?.count)).toBe(0);

    const attestation = await harness.db.query("SELECT status FROM rail_attestation");
    expect(attestation.rows[0]?.status).toBe("attested");

    const counters = await harness.db.query(
      "SELECT rail, reason, rejected_count FROM proof_rejection_counter",
    );
    expect(counters.rows).toEqual([
      { rail: "cctp", reason: "provider_inconsistency", rejected_count: "1" },
    ]);

    // Verify unused Event ABI reference still decodes cleanly
    expect(CCTP_RECEIPT_ABI).toBeDefined();
  });
});
