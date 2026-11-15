import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import {
  AddressKind,
  CHAINS,
  RAIL_CONTRACTS,
  RouteKind,
  encodeStellarAddress,
  parseStellarAddress,
} from "@hyperion/protocol";
import type { Hex } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { LogShapeError } from "../../src/chains/evm/logs.js";
import { ClaimPairing, applyRouterLog } from "../../src/chains/evm/store.js";
import { EvmWatcher } from "../../src/chains/evm/watcher.js";
import { buildIndexer } from "../../src/chains/runner.js";
import { admitEvmOriginRouter, loadConfig } from "../../src/config/config.js";
import type { QueryResultRows, Queryable, Transactional } from "../../src/db/pool.js";
import { RailPass } from "../../src/rails/pass.js";
import type { RailClient } from "../../src/rails/types.js";
import { FakeEvmClient, encodedLog } from "../evm-fakes.js";
import { FIXTURES_DIR, completeEnv, readFixture } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const REPO_ROOT = join(FIXTURES_DIR, "..", "..");
const LIVE_TESTNET_DEPLOYMENTS = join(REPO_ROOT, "deployments", "testnet.json");
const ACTIVATED_SEPOLIA_DEPLOYMENTS = join(FIXTURES_DIR, "deployments-sepolia-activated.json");

const SEPOLIA_CHAIN_ID = 11_155_111;
const SEPOLIA_ROUTER: Hex = "0x0165878A594ca255338adfa4d48449f69242Eb8F";
const SEPOLIA_USDC: Hex = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const SEPOLIA_START_BLOCK = 9_412_880n;
const SEPOLIA_DEPLOY_TX: Hex = "0x4c1ba9bd0f28d77e6a3b1c05e8942fd0b7613a5ce84f29d0a71b3e6c5d08947f";
const SENDER: Hex = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

function stripDownMigration(sql: string): string {
  const marker = "-- Down Migration";
  const idx = sql.indexOf(marker);
  return idx === -1 ? sql : sql.slice(0, idx);
}

class PgliteDb implements Transactional {
  constructor(private readonly pg: PGlite) {}

  async query(text: string, params: readonly unknown[] = []): Promise<QueryResultRows> {
    const res = await this.pg.query(text, [...params]);
    return {
      rows: res.rows as Record<string, unknown>[],
      rowCount: res.affectedRows ?? res.rows.length,
    };
  }

  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    return await this.pg.transaction(async (tx) => {
      const wrapped: Queryable = {
        async query(text: string, params: readonly unknown[] = []): Promise<QueryResultRows> {
          const res = await tx.query(text, [...params]);
          return {
            rows: res.rows as Record<string, unknown>[],
            rowCount: res.affectedRows ?? res.rows.length,
          };
        },
      };
      return await work(wrapped);
    });
  }
}

describe("EVM-origin source indexing for an activated router revision (#149)", () => {
  let pg: PGlite;
  let db: PgliteDb;

  beforeAll(async () => {
    pg = new PGlite();
    for (const file of [
      "1790900000000_initial-schema.sql",
      "1791000000000_cursor-block-hash.sql",
      "1791100000000_cursor-autovacuum-tuning.sql",
    ]) {
      const sql = readFileSync(join(REPO_ROOT, "migrations", file), "utf8");
      await pg.exec(stripDownMigration(sql));
    }
    db = new PgliteDb(pg);
  });

  afterAll(async () => {
    await pg.close();
  });

  beforeEach(async () => {
    await pg.exec(
      "TRUNCATE indexer_cursor, outbound_transfer, inbound_delivery, pending_claim, rail_attestation, admin_action, route_health RESTART IDENTITY CASCADE",
    );
  });

  describe("registry presence vs deployment activation gating", () => {
    it("does not activate EVM watchers from chain/rail registry entries when the deployment record has no EVM router", () => {
      expect(CHAINS.sepolia.family).toBe("evm");
      expect(CHAINS["base-sepolia"].family).toBe("evm");
      expect(CHAINS["arc-testnet"].family).toBe("evm");
      expect(RAIL_CONTRACTS.sepolia?.cctp).not.toBeNull();

      const config = loadConfig({
        env: completeEnv({
          HYPERION_DEPLOYMENTS_FILE: LIVE_TESTNET_DEPLOYMENTS,
          KEEPER_ENABLED: "false",
        }),
      });

      expect(config.indexer.evm).toEqual([]);
      expect(admitEvmOriginRouter(config, "sepolia")).toEqual({
        activated: false,
        reason: "not_in_deployments",
      });
      expect(admitEvmOriginRouter(config, "base-sepolia")).toEqual({
        activated: false,
        reason: "not_in_deployments",
      });
      expect(admitEvmOriginRouter(config, "arc-testnet")).toEqual({
        activated: false,
        reason: "not_in_deployments",
      });
      expect(admitEvmOriginRouter(config, "stellar-testnet")).toEqual({
        activated: false,
        reason: "not_evm_chain",
      });
      expect(admitEvmOriginRouter(config, "ethereum")).toEqual({
        activated: false,
        reason: "wrong_network",
      });

      const { logger } = capturingLogger();
      const indexer = buildIndexer({ config, logger, db });
      const workerNames = indexer.workers.map((worker) => worker.name);
      expect(workerNames).toContain("stellar-testnet");
      expect(workerNames).not.toContain("sepolia");
    });

    it("withholds staged, candidate, and disabled EVM router revisions from active indexing", () => {
      const baseFixture = JSON.parse(readFixture("deployments-sepolia-activated.json")) as {
        networks: { sepolia: { activation: { status: string } } };
      };

      for (const status of ["staged", "candidate", "disabled"] as const) {
        const clone = structuredClone(baseFixture);
        clone.networks.sepolia.activation.status = status;

        const config = loadConfig({
          env: completeEnv({
            HYPERION_DEPLOYMENTS_FILE: "/virtual/deployments.json",
            KEEPER_ENABLED: "false",
          }),
          readFile: () => JSON.stringify(clone),
        });

        expect(config.indexer.evm).toEqual([]);
        expect(config.indexer.unactivatedEvm).toHaveLength(1);
        expect(config.indexer.unactivatedEvm?.[0]).toMatchObject({
          chain: "sepolia",
          chainId: SEPOLIA_CHAIN_ID,
          routerAddress: SEPOLIA_ROUTER,
          startBlock: SEPOLIA_START_BLOCK,
          deploymentTxHash: SEPOLIA_DEPLOY_TX,
          status,
        });
        expect(admitEvmOriginRouter(config, "sepolia")).toEqual({
          activated: false,
          reason: "unactivated_revision",
          status,
        });

        const { logger, lines } = capturingLogger();
        const indexer = buildIndexer({ config, logger, db });
        expect(indexer.workers.map((w) => w.name)).not.toContain("sepolia");
        expect(
          lines.some((line) =>
            line.message.includes("EVM router revision in deployment record is not active"),
          ),
        ).toBe(true);
      }
    });

    it("admits an activated Sepolia router revision from validated deployment metadata", () => {
      const config = loadConfig({
        env: completeEnv({
          HYPERION_DEPLOYMENTS_FILE: ACTIVATED_SEPOLIA_DEPLOYMENTS,
          KEEPER_ENABLED: "false",
        }),
      });

      const admission = admitEvmOriginRouter(config, "sepolia");
      expect(admission.activated).toBe(true);
      if (!admission.activated) throw new Error("expected activated router");
      expect(admission.watch).toMatchObject({
        chain: "sepolia",
        chainId: SEPOLIA_CHAIN_ID,
        routerAddress: SEPOLIA_ROUTER,
        startBlock: SEPOLIA_START_BLOCK,
        deploymentTxHash: SEPOLIA_DEPLOY_TX,
        commit: "c9140e7a2b51d68f40e91a3bc7d820f1e56a4b90",
        activation: {
          status: "active",
          acceptance: "delivered",
        },
      });
    });

    it("rejects zero-address EVM routers during configuration loading", () => {
      const clone = JSON.parse(readFixture("deployments-sepolia-activated.json")) as {
        networks: { sepolia: { router: string } };
      };
      clone.networks.sepolia.router = `0x${"0".repeat(40)}`;

      expect(() =>
        loadConfig({
          env: completeEnv({ HYPERION_DEPLOYMENTS_FILE: "/virtual/zero-router.json" }),
          readFile: () => JSON.stringify(clone),
        }),
      ).toThrow(/zero address/);
    });
  });

  describe("router address and initialization block verification before indexing", () => {
    function validDeploymentReceipt(client: FakeEvmClient) {
      return {
        status: "success" as const,
        blockNumber: SEPOLIA_START_BLOCK,
        blockHash: client.stampFor(SEPOLIA_START_BLOCK).hash,
        contractAddress: SEPOLIA_ROUTER,
        to: null,
        logAddresses: [SEPOLIA_ROUTER],
      };
    }

    it("refuses zero-address routers and empty runtime bytecode before fetching any logs", async () => {
      const emptyBytecodeClient = new FakeEvmClient({
        chainId: SEPOLIA_CHAIN_ID,
        head: SEPOLIA_START_BLOCK + 20n,
        logs: [],
        bytecodeByAddress: { [SEPOLIA_ROUTER]: "0x" },
      });
      const { logger } = capturingLogger();

      const zeroRouterWatcher = new EvmWatcher({
        chainKey: "sepolia",
        router: `0x${"0".repeat(40)}`,
        chainId: SEPOLIA_CHAIN_ID,
        startBlock: SEPOLIA_START_BLOCK,
        confirmations: 3,
        reorgDepth: 3,
        logRange: 100,
        client: emptyBytecodeClient,
        db,
        logger,
      });
      await expect(zeroRouterWatcher.tick(AbortSignal.timeout(5_000))).rejects.toThrow(
        /not a deployed non-zero contract address/,
      );

      const emptyCodeWatcher = new EvmWatcher({
        chainKey: "sepolia",
        router: SEPOLIA_ROUTER,
        chainId: SEPOLIA_CHAIN_ID,
        startBlock: SEPOLIA_START_BLOCK,
        deploymentTxHash: SEPOLIA_DEPLOY_TX,
        confirmations: 3,
        reorgDepth: 3,
        logRange: 100,
        client: emptyBytecodeClient,
        db,
        logger,
      });
      await expect(emptyCodeWatcher.tick(AbortSignal.timeout(5_000))).rejects.toThrow(
        /no deployed contract bytecode/,
      );
      expect(emptyBytecodeClient.logQueries).toEqual([]);
    });

    it("refuses unverified initialization blocks and invalid deployment receipts before indexing", async () => {
      const { logger } = capturingLogger();

      const missingStartBlockClient = new FakeEvmClient({
        chainId: SEPOLIA_CHAIN_ID,
        head: SEPOLIA_START_BLOCK + 20n,
        logs: [],
        missing: [SEPOLIA_START_BLOCK],
      });
      const missingBlockWatcher = new EvmWatcher({
        chainKey: "sepolia",
        router: SEPOLIA_ROUTER,
        chainId: SEPOLIA_CHAIN_ID,
        startBlock: SEPOLIA_START_BLOCK,
        deploymentTxHash: SEPOLIA_DEPLOY_TX,
        confirmations: 3,
        reorgDepth: 3,
        logRange: 100,
        client: missingStartBlockClient,
        db,
        logger,
      });
      await expect(missingBlockWatcher.tick(AbortSignal.timeout(5_000))).rejects.toThrow(
        /initialization block .* could not be verified/,
      );
      expect(missingStartBlockClient.logQueries).toEqual([]);

      // Missing receipt (null), reverted receipt, wrong blockNumber, non-canonical blockHash, and unrelated contract.
      const baseStampClient = new FakeEvmClient({
        chainId: SEPOLIA_CHAIN_ID,
        head: SEPOLIA_START_BLOCK + 20n,
        logs: [],
      });
      const validReceipt = validDeploymentReceipt(baseStampClient);

      const badCases: readonly {
        readonly receipt: typeof validReceipt | null | Record<string, unknown>;
        readonly expectedError: RegExp;
      }[] = [
        { receipt: null, expectedError: /was not found on the RPC node/ },
        {
          receipt: { ...validReceipt, status: "reverted" },
          expectedError: /reverted/,
        },
        {
          receipt: { ...validReceipt, blockNumber: SEPOLIA_START_BLOCK + 1n },
          expectedError: /expected startBlock/,
        },
        {
          receipt: { ...validReceipt, blockHash: `0x${"ef".repeat(32)}` },
          expectedError: /non-canonical block hash/,
        },
        {
          receipt: {
            ...validReceipt,
            contractAddress: "0x000000000000000000000000000000000000beef",
            to: null,
            logAddresses: [],
          },
          expectedError: /did not deploy or initialize router/,
        },
      ];

      for (const bad of badCases) {
        const client = new FakeEvmClient({
          chainId: SEPOLIA_CHAIN_ID,
          head: SEPOLIA_START_BLOCK + 20n,
          logs: [],
          receiptsByHash: {
            [SEPOLIA_DEPLOY_TX]: bad.receipt as typeof validReceipt | null,
          },
        });
        const watcher = new EvmWatcher({
          chainKey: "sepolia",
          router: SEPOLIA_ROUTER,
          chainId: SEPOLIA_CHAIN_ID,
          startBlock: SEPOLIA_START_BLOCK,
          deploymentTxHash: SEPOLIA_DEPLOY_TX,
          confirmations: 3,
          reorgDepth: 3,
          logRange: 100,
          client,
          db,
          logger,
        });
        await expect(watcher.tick(AbortSignal.timeout(5_000))).rejects.toThrow(bad.expectedError);
        expect(client.logQueries).toEqual([]);
      }
    });

    it("verifies router bytecode, startBlock, and deploymentTxHash once and refuses stale router cursors", async () => {
      const probe = new FakeEvmClient({
        chainId: SEPOLIA_CHAIN_ID,
        head: SEPOLIA_START_BLOCK + 20n,
        logs: [],
      });
      const client = new FakeEvmClient({
        chainId: SEPOLIA_CHAIN_ID,
        head: SEPOLIA_START_BLOCK + 20n,
        logs: [],
        receiptsByHash: { [SEPOLIA_DEPLOY_TX]: validDeploymentReceipt(probe) },
      });
      const { logger } = capturingLogger();
      const watcher = new EvmWatcher({
        chainKey: "sepolia",
        router: SEPOLIA_ROUTER,
        chainId: SEPOLIA_CHAIN_ID,
        startBlock: SEPOLIA_START_BLOCK,
        deploymentTxHash: SEPOLIA_DEPLOY_TX,
        commit: "c9140e7a2b51d68f40e91a3bc7d820f1e56a4b90",
        confirmations: 3,
        reorgDepth: 3,
        logRange: 100,
        client,
        db,
        logger,
      });

      expect(await watcher.tick(AbortSignal.timeout(5_000))).toBe(false);
      expect(client.codeCalls).toBe(1);
      expect(client.logQueries).toHaveLength(1);
      expect(client.logQueries[0]?.fromBlock).toBe(SEPOLIA_START_BLOCK);

      client.advanceHeadTo(SEPOLIA_START_BLOCK + 25n);
      await watcher.tick(AbortSignal.timeout(5_000));
      expect(client.codeCalls).toBe(1);

      // Simulate redeploying a new router revision without resetting the stored cursor.
      const nextRevisionWatcher = new EvmWatcher({
        chainKey: "sepolia",
        router: "0x000000000000000000000000000000000000cafe",
        chainId: SEPOLIA_CHAIN_ID,
        startBlock: SEPOLIA_START_BLOCK + 100n,
        confirmations: 3,
        reorgDepth: 3,
        logRange: 100,
        client,
        db,
        logger,
      });
      await expect(nextRevisionWatcher.tick(AbortSignal.timeout(5_000))).rejects.toThrow(
        /needs its cursor reset rather than reused/,
      );
    });
  });

  describe("chain-specific recipient identity, exact integer amounts, and provider clamping", () => {
    const accountRecipient = encodeStellarAddress(AddressKind.Account, `0x${"11".repeat(32)}`);
    const contractRecipient = encodeStellarAddress(AddressKind.Contract, `0x${"22".repeat(32)}`);
    const muxedSubAccountId = 9_876_543_210_123_456_789n;
    const muxedRecipient = encodeStellarAddress(
      AddressKind.MuxedAccount,
      `0x${"33".repeat(32)}`,
      muxedSubAccountId,
    );
    const evmPeerRecipient = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

    it("indexes EVM BridgeOut logs preserving G/C/M Stellar strkeys, EVM recipients, and full uint256 amounts", async () => {
      const wideGross = (1n << 200n) + 1_000_000n;
      const wideFee = 3_000n;
      const wideNet = wideGross - wideFee;

      const logs = [
        {
          ...encodedLog(
            "BridgeOut",
            {
              route: RouteKind.Cctp,
              sender: SENDER,
              nonce: 0n,
              token: SEPOLIA_USDC,
              grossAmount: 125_000_000n,
              fee: 375_000n,
              netAmount: 124_625_000n,
              destinationChain: "stellar-testnet",
              destinationAddress: accountRecipient,
              railRef: `0x${"aa".repeat(32)}`,
            },
            { blockNumber: SEPOLIA_START_BLOCK + 1n, logIndex: 0 },
          ),
          address: SEPOLIA_ROUTER,
        },
        {
          ...encodedLog(
            "BridgeOut",
            {
              route: RouteKind.AxelarIts,
              sender: SENDER,
              nonce: 1n,
              token: SEPOLIA_USDC,
              grossAmount: 50_000_000n,
              fee: 150_000n,
              netAmount: 49_850_000n,
              destinationChain: "stellar-testnet",
              destinationAddress: contractRecipient,
              railRef: `0x${"bb".repeat(32)}`,
            },
            { blockNumber: SEPOLIA_START_BLOCK + 2n, logIndex: 0 },
          ),
          address: SEPOLIA_ROUTER,
        },
        {
          ...encodedLog(
            "BridgeOut",
            {
              route: RouteKind.Cctp,
              sender: SENDER,
              nonce: 2n,
              token: SEPOLIA_USDC,
              grossAmount: wideGross,
              fee: wideFee,
              netAmount: wideNet,
              destinationChain: "stellar-testnet",
              destinationAddress: muxedRecipient,
              railRef: `0x${"cc".repeat(32)}`,
            },
            { blockNumber: SEPOLIA_START_BLOCK + 3n, logIndex: 0 },
          ),
          address: SEPOLIA_ROUTER,
        },
        {
          ...encodedLog(
            "BridgeOut",
            {
              route: RouteKind.Cctp,
              sender: SENDER,
              nonce: 3n,
              token: SEPOLIA_USDC,
              grossAmount: 10_000_000n,
              fee: 0n,
              netAmount: 10_000_000n,
              destinationChain: "base-sepolia",
              destinationAddress: evmPeerRecipient,
              railRef: `0x${"00".repeat(32)}`,
            },
            { blockNumber: SEPOLIA_START_BLOCK + 4n, logIndex: 0 },
          ),
          address: SEPOLIA_ROUTER,
        },
      ];

      const stampProbe = new FakeEvmClient({
        chainId: SEPOLIA_CHAIN_ID,
        head: SEPOLIA_START_BLOCK + 20n,
        logs,
      });
      const client = new FakeEvmClient({
        chainId: SEPOLIA_CHAIN_ID,
        head: SEPOLIA_START_BLOCK + 20n,
        logs,
        receiptsByHash: {
          [SEPOLIA_DEPLOY_TX]: {
            status: "success",
            blockNumber: SEPOLIA_START_BLOCK,
            blockHash: stampProbe.stampFor(SEPOLIA_START_BLOCK).hash,
            contractAddress: SEPOLIA_ROUTER,
            to: null,
            logAddresses: [SEPOLIA_ROUTER],
          },
        },
      });

      const { logger } = capturingLogger();
      const watcher = new EvmWatcher({
        chainKey: "sepolia",
        router: SEPOLIA_ROUTER,
        chainId: SEPOLIA_CHAIN_ID,
        startBlock: SEPOLIA_START_BLOCK,
        deploymentTxHash: SEPOLIA_DEPLOY_TX,
        confirmations: 3,
        reorgDepth: 5,
        logRange: 100,
        client,
        db,
        logger,
      });

      await watcher.tick(AbortSignal.timeout(5_000));

      const { rows } = await db.query(
        `SELECT nonce::text AS nonce,
                route,
                sender,
                token,
                gross_amount::text AS gross_amount,
                fee::text AS fee,
                net_amount::text AS net_amount,
                destination_chain,
                destination,
                rail_ref
           FROM outbound_transfer
          WHERE origin_chain = 'sepolia'
          ORDER BY nonce::numeric ASC`,
      );

      expect(rows).toHaveLength(4);
      expect(rows[0]).toEqual({
        nonce: "0",
        route: RouteKind.Cctp,
        sender: SENDER.toLowerCase(),
        token: SEPOLIA_USDC.toLowerCase(),
        gross_amount: "125000000",
        fee: "375000",
        net_amount: "124625000",
        destination_chain: "stellar-testnet",
        destination: accountRecipient,
        rail_ref: `0x${"aa".repeat(32)}`,
      });
      expect(rows[1]?.destination).toBe(contractRecipient);

      // Muxed Stellar recipient retains its exact 69-char M... strkey and full 64-bit muxedId.
      expect(rows[2]?.destination).toBe(muxedRecipient);
      expect(String(rows[2]?.destination)).toHaveLength(69);
      const parsedMuxed = parseStellarAddress(String(rows[2]?.destination));
      expect(parsedMuxed.kind).toBe(AddressKind.MuxedAccount);
      expect(parsedMuxed.muxedId).toBe(muxedSubAccountId);
      expect(rows[2]?.gross_amount).toBe(wideGross.toString());
      expect(rows[2]?.fee).toBe(wideFee.toString());
      expect(rows[2]?.net_amount).toBe(wideNet.toString());

      // EVM destination is normalized to canonical lowercase 42-char address and zero railRef is null.
      expect(rows[3]?.destination).toBe(evmPeerRecipient.toLowerCase());
      expect(rows[3]?.rail_ref).toBeNull();

      // Replaying the range after a cursor reset overwrites cleanly without duplicating rows.
      await db.query("DELETE FROM indexer_cursor WHERE chain_key = 'sepolia'");
      await watcher.tick(AbortSignal.timeout(5_000));
      const replayed = await db.query("SELECT count(*)::int AS cnt FROM outbound_transfer");
      expect(replayed.rows[0]?.cnt).toBe(4);

      // Provider status reporting "delivered" without verified destination chain events is clamped to "attested".
      const optimisticProvider: RailClient = {
        rail: "cctp",
        look: () =>
          Promise.resolve({
            kind: "found",
            report: {
              status: "delivered",
              railStatus: "complete",
              reference: "event-nonce-99",
              attestedAt: new Date("2026-10-30T14:25:00.000Z"),
            },
          }),
      };
      const pass = new RailPass({
        route: RouteKind.Cctp,
        client: optimisticProvider,
        db,
        logger,
        batchSize: 10,
        recheckAfterMs: 1_000,
        maxCheckFailures: 3,
        now: () => new Date("2026-10-30T14:26:00.000Z"),
      });
      await pass.tick(AbortSignal.timeout(5_000));

      const attestations = await db.query(
        "SELECT status, rail_status FROM rail_attestation ORDER BY transfer_id ASC",
      );
      expect(attestations.rows.length).toBeGreaterThan(0);
      for (const att of attestations.rows) {
        expect(att.status).toBe("attested");
      }
    });

    it("rejects malformed strkey checksums, zero EVM destinations, and broken fee arithmetic", async () => {
      const at = {
        chainKey: "sepolia",
        block: SEPOLIA_START_BLOCK + 5n,
        txHash: `0x${"dd".repeat(32)}`,
        logIndex: 0,
        observedAt: new Date("2026-10-30T14:30:00.000Z"),
      };
      const corruptedStrkey = `${accountRecipient.slice(0, -2)}AA`;

      await expect(
        applyRouterLog(
          db,
          at,
          {
            name: "BridgeOut",
            args: {
              route: RouteKind.Cctp,
              sender: SENDER,
              nonce: 10n,
              token: SEPOLIA_USDC,
              grossAmount: 1_000n,
              fee: 10n,
              netAmount: 990n,
              destinationChain: "stellar-testnet",
              destinationAddress: corruptedStrkey,
              railRef: `0x${"00".repeat(32)}`,
            },
          },
          new ClaimPairing(),
        ),
      ).rejects.toBeInstanceOf(LogShapeError);

      await expect(
        applyRouterLog(
          db,
          at,
          {
            name: "BridgeOut",
            args: {
              route: RouteKind.Cctp,
              sender: SENDER,
              nonce: 11n,
              token: SEPOLIA_USDC,
              grossAmount: 1_000n,
              fee: 10n,
              netAmount: 990n,
              destinationChain: "base-sepolia",
              destinationAddress: `0x${"0".repeat(40)}`,
              railRef: `0x${"00".repeat(32)}`,
            },
          },
          new ClaimPairing(),
        ),
      ).rejects.toBeInstanceOf(LogShapeError);

      await expect(
        applyRouterLog(
          db,
          at,
          {
            name: "BridgeOut",
            args: {
              route: RouteKind.Cctp,
              sender: SENDER,
              nonce: 12n,
              token: SEPOLIA_USDC,
              grossAmount: 1_000n,
              fee: 10n,
              netAmount: 900n,
              destinationChain: "stellar-testnet",
              destinationAddress: accountRecipient,
              railRef: `0x${"00".repeat(32)}`,
            },
          },
          new ClaimPairing(),
        ),
      ).rejects.toBeInstanceOf(LogShapeError);
    });
  });
});
