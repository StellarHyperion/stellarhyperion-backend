import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { AddressKind, RouteKind, encodeStellarAddress, toWord } from "@hyperion/protocol";
import { encodeAbiParameters, encodeEventTopics, type AbiEvent, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildIndexer } from "../../src/chains/runner.js";
import { writeOutbound } from "../../src/chains/writers.js";
import { admitAllbridgeLane, loadConfig, type AppConfig } from "../../src/config/config.js";
import type { QueryResultRows, Queryable, Transactional } from "../../src/db/pool.js";
import { AllbridgeClient } from "../../src/rails/allbridge/client.js";
import type { AllbridgeEvmReceiptReader } from "../../src/rails/allbridge/delivery.js";
import {
  ALLBRIDGE_EVM_ABI,
  computeAllbridgeIntentHash,
  nonceToWord,
} from "../../src/rails/allbridge/events.js";
import { RailPass } from "../../src/rails/pass.js";
import { RailError } from "../../src/rails/types.js";
import { FIXTURES_DIR, completeEnv, readFixture } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const REPO_ROOT = join(FIXTURES_DIR, "..", "..");

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

function encodeAllbridgeLog(
  address: Hex,
  eventName: "MessageReceived" | "Transfer",
  args: Record<string, unknown>,
  logIndex: number,
) {
  const found = ALLBRIDGE_EVM_ABI.find((entry) => entry.name === eventName);
  if (!found) throw new Error(`missing ABI event ${eventName}`);
  const event = found as AbiEvent;
  const topics = encodeEventTopics({
    abi: [event],
    eventName,
    args,
  }) as [Hex, ...Hex[]];
  const unindexed = event.inputs.filter((inp) => inp.indexed !== true);
  const data =
    unindexed.length === 0
      ? "0x"
      : encodeAbiParameters(
          unindexed,
          unindexed.map((inp) => args[inp.name ?? ""]),
        );
  return { address, topics, data, logIndex };
}

describe("Allbridge signed-intent and payment verification (#148)", () => {
  const validator1 = privateKeyToAccount(generatePrivateKey());
  const validator2 = privateKeyToAccount(generatePrivateKey());
  const validator3 = privateKeyToAccount(generatePrivateKey());
  const rogueSigner = privateKeyToAccount(generatePrivateKey());

  const stellarAdapter = encodeStellarAddress(AddressKind.Contract, `0x${"41".repeat(32)}`);
  const stellarBridge = encodeStellarAddress(AddressKind.Contract, `0x${"42".repeat(32)}`);
  const stellarMessenger = encodeStellarAddress(AddressKind.Contract, `0x${"43".repeat(32)}`);
  const stellarPool = encodeStellarAddress(AddressKind.Contract, `0x${"44".repeat(32)}`);
  const stellarSender = encodeStellarAddress(AddressKind.Account, `0x${"45".repeat(32)}`);

  const sepoliaAdapter: Hex = "0x2279b7a0a67db372996a5fab50d91eaa73d2ebe6";
  const sepoliaBridge: Hex = "0x8a791620dd6260079bf849dc5567adc3f2fdc318";
  const sepoliaMessenger: Hex = "0x610178da211fef7d417bc0e6fed39f05609ad788";
  const sepoliaPool: Hex = "0xb7f8bc63bbcad18155201308c8f3540b07f84f5e";
  const sepoliaRecipient: Hex = "0x90f79bf6eb2c4f870365e785982e1f101e93b906";
  const sepoliaUsdc: Hex = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";

  let pg: PGlite;
  let db: PgliteDb;

  function buildAllbridgeDeploymentsJson(): string {
    const base = JSON.parse(readFixture("deployments-testnet.json")) as {
      networks: {
        "stellar-testnet": {
          adapters: Record<string, string>;
          tokens: { USDC: { routes: string[]; sacId: string } };
          allbridge?: unknown;
        };
        sepolia: {
          adapters: Record<string, string>;
          tokens: { USDC: { routes: string[]; address: string } };
          allbridge?: unknown;
        };
      };
    };
    base.networks["stellar-testnet"].adapters.allbridge = stellarAdapter;
    base.networks["stellar-testnet"].tokens.USDC.routes.push("allbridge");
    base.networks["stellar-testnet"].allbridge = {
      chainSymbol: "SRB",
      bridge: stellarBridge,
      messenger: stellarMessenger,
      pools: { USDC: stellarPool },
      maxSlippageBps: 50,
      validatorTrust: {
        model: "configured-validator-quorum",
        validators: [validator1.address, validator2.address, validator3.address],
        requiredSignatures: 2,
      },
    };

    base.networks.sepolia.adapters.allbridge = sepoliaAdapter;
    base.networks.sepolia.tokens.USDC.routes.push("allbridge");
    base.networks.sepolia.allbridge = {
      chainSymbol: "SEP",
      bridge: sepoliaBridge,
      messenger: sepoliaMessenger,
      pools: { USDC: sepoliaPool },
      maxSlippageBps: 50,
      validatorTrust: {
        model: "configured-validator-quorum",
        validators: [validator1.address, validator2.address, validator3.address],
        requiredSignatures: 2,
      },
    };

    return JSON.stringify(base);
  }

  function loadAllbridgeConfig(): AppConfig {
    const json = buildAllbridgeDeploymentsJson();
    return loadConfig({
      env: completeEnv({
        HYPERION_DEPLOYMENTS_FILE: "/virtual/deployments-allbridge.json",
        ALLBRIDGE_API_URL: "https://allbridge.example.test",
        KEEPER_ENABLED: "false",
      }),
      readFile: () => json,
    });
  }

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

  describe("deployment metadata gating and validator trust validation", () => {
    it("keeps Allbridge lanes and pollers disabled without validated Allbridge deployment metadata", () => {
      const defaultConfig = loadConfig({
        env: completeEnv({ KEEPER_ENABLED: "false" }),
      });

      expect(defaultConfig.rails.allbridgeLanes).toEqual([]);
      expect(admitAllbridgeLane(defaultConfig, "stellar-testnet", "sepolia")).toEqual({
        enabled: false,
        reason: "missing_allbridge_adapter",
      });

      const { logger } = capturingLogger();
      const indexer = buildIndexer({ config: defaultConfig, logger, db });
      const railWorkers = indexer.workers
        .map((w) => w.name)
        .filter((name) => name.startsWith("rail:"));
      expect(railWorkers).toEqual(["rail:cctp", "rail:axelar"]);
    });

    it("rejects malformed validator quorum trust disclosures or missing pool contracts", () => {
      const brokenQuorum = JSON.parse(buildAllbridgeDeploymentsJson()) as {
        networks: {
          sepolia: {
            allbridge: { validatorTrust: { requiredSignatures: number; validators: string[] } };
          };
        };
      };
      brokenQuorum.networks.sepolia.allbridge.validatorTrust.requiredSignatures = 4;

      expect(() =>
        loadConfig({
          env: completeEnv({ HYPERION_DEPLOYMENTS_FILE: "/virtual/broken-quorum.json" }),
          readFile: () => JSON.stringify(brokenQuorum),
        }),
      ).toThrow(/requiredSignatures/);

      const duplicateValidators = JSON.parse(buildAllbridgeDeploymentsJson()) as {
        networks: {
          sepolia: {
            allbridge: { validatorTrust: { requiredSignatures: number; validators: string[] } };
          };
        };
      };
      duplicateValidators.networks.sepolia.allbridge.validatorTrust.validators = [
        validator1.address,
        validator1.address,
      ];
      expect(() =>
        loadConfig({
          env: completeEnv({ HYPERION_DEPLOYMENTS_FILE: "/virtual/dup-validators.json" }),
          readFile: () => JSON.stringify(duplicateValidators),
        }),
      ).toThrow(/duplicate signer/);
    });

    it("refuses Allbridge lookups on lanes without validated deployment metadata", async () => {
      const defaultConfig = loadConfig({ env: completeEnv({ KEEPER_ENABLED: "false" }) });
      const client = new AllbridgeClient("https://allbridge.example.test", defaultConfig, {
        fetch: () => Promise.resolve(new Response("{}", { status: 200 })),
      });

      await expect(
        client.look({
          transferId: 1n,
          route: RouteKind.Allbridge,
          originChain: "stellar-testnet",
          destinationChain: "sepolia",
          nonce: 1n,
          originTx: "ab".repeat(32),
          status: null,
          checkFailures: 0,
          delivered: false,
        }),
      ).rejects.toSatisfy((err: unknown) => err instanceof RailError && err.kind === "permanent");
    });

    it("admits validated Allbridge lanes and registers rail:allbridge when ALLBRIDGE_API_URL is set", () => {
      const config = loadAllbridgeConfig();
      const admission = admitAllbridgeLane(config, "stellar-testnet", "sepolia");
      expect(admission.enabled).toBe(true);

      const { logger } = capturingLogger();
      const indexer = buildIndexer({ config, logger, db });
      const railWorkers = indexer.workers
        .map((w) => w.name)
        .filter((name) => name.startsWith("rail:"));
      expect(railWorkers).toEqual(["rail:cctp", "rail:axelar", "rail:allbridge"]);
    });
  });

  describe("validator signature vs destination payout proof", () => {
    it("treats valid validator quorum signatures as attested (never delivered) and discloses trust", async () => {
      const config = loadAllbridgeConfig();
      const stellarSac =
        config.deployments.networks["stellar-testnet"]?.tokens.USDC &&
        "sacId" in config.deployments.networks["stellar-testnet"].tokens.USDC
          ? config.deployments.networks["stellar-testnet"].tokens.USDC.sacId
          : "";

      const sourceNetAmount = 100_000_000n; // 10 USDC on 7-decimal Stellar SAC
      const nonce = 7n;
      const messageHash = computeAllbridgeIntentHash({
        sourceChainSymbol: "SRB",
        destinationChainSymbol: "SEP",
        sourceNonce: nonce,
        recipient: toWord(sepoliaRecipient),
        sourceAmount: sourceNetAmount,
        destinationPool: sepoliaPool,
      });

      await db.transaction(async (tx) => {
        await writeOutbound(
          tx,
          {
            chainKey: "stellar-testnet",
            block: 1_290_000n,
            txHash: "aa".repeat(32),
            logIndex: null,
            observedAt: new Date("2026-10-30T15:00:00.000Z"),
          },
          {
            route: RouteKind.Allbridge,
            nonce,
            sender: stellarSender,
            token: stellarSac,
            grossAmount: 100_300_000n,
            fee: 300_000n,
            netAmount: sourceNetAmount,
            destinationChain: "sepolia",
            destination: toWord(sepoliaRecipient),
            railRef: messageHash,
          },
        );
      });

      const sig1 = await validator1.sign({ hash: messageHash });
      const sig2 = await validator2.sign({ hash: messageHash });

      // Provider claims status="delivered" with valid 2/3 quorum signatures, but no destination tx receipt exists.
      const client = new AllbridgeClient("https://allbridge.example.test", config, {
        fetch: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                status: "delivered",
                messageHash,
                sourceChainSymbol: "SRB",
                destinationChainSymbol: "SEP",
                sourceNonce: nonce.toString(),
                recipient: toWord(sepoliaRecipient),
                sourceAmount: sourceNetAmount.toString(),
                signatures: [sig1, sig2],
                attestedAt: "2026-10-30T15:01:00.000Z",
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          ),
      });

      const { logger } = capturingLogger();
      const pass = new RailPass({
        route: RouteKind.Allbridge,
        config,
        client,
        db,
        logger,
        batchSize: 10,
        recheckAfterMs: 1_000,
        maxCheckFailures: 3,
        now: () => new Date("2026-10-30T15:02:00.000Z"),
      });

      await pass.tick(AbortSignal.timeout(5_000));

      const attRows = await db.query(
        "SELECT status, rail_status, rail_reference FROM rail_attestation",
      );
      expect(attRows.rows).toEqual([
        {
          status: "attested",
          rail_status: "delivered/quorum:2/2",
          rail_reference: messageHash,
        },
      ]);

      const inboundRows = await db.query("SELECT count(*)::int AS cnt FROM inbound_delivery");
      expect(inboundRows.rows[0]?.cnt).toBe(0);
    });

    it("keeps status pending when signatures come from unconfigured signers or duplicate one validator", async () => {
      const config = loadAllbridgeConfig();
      const nonce = 8n;
      const sourceNetAmount = 50_000_000n;
      const messageHash = computeAllbridgeIntentHash({
        sourceChainSymbol: "SRB",
        destinationChainSymbol: "SEP",
        sourceNonce: nonce,
        recipient: sepoliaRecipient,
        sourceAmount: sourceNetAmount,
        destinationPool: sepoliaPool,
      });

      const sig1 = await validator1.sign({ hash: messageHash });
      const rogueSig = await rogueSigner.sign({ hash: messageHash });

      const client = new AllbridgeClient("https://allbridge.example.test", config, {
        fetch: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                status: "signed",
                messageHash,
                sourceChainSymbol: "SRB",
                destinationChainSymbol: "SEP",
                sourceNonce: nonce.toString(),
                recipient: sepoliaRecipient,
                sourceAmount: sourceNetAmount.toString(),
                signatures: [sig1, sig1, rogueSig],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          ),
      });

      const lookup = await client.look({
        transferId: 1n,
        route: RouteKind.Allbridge,
        originChain: "stellar-testnet",
        destinationChain: "sepolia",
        nonce,
        originTx: "bb".repeat(32),
        status: null,
        checkFailures: 0,
        delivered: false,
      });

      expect(lookup.kind).toBe("found");
      if (lookup.kind !== "found") throw new Error("expected found lookup");
      expect(lookup.report.status).toBe("pending");
      expect(lookup.report.allbridge?.trustDisclosure).toMatchObject({
        model: "configured-validator-quorum",
        requiredSignatures: 2,
        verifiedSigners: [validator1.address.toLowerCase()],
        quorumSatisfied: false,
      });
    });
  });

  describe("agreement between source message identity and actual token payment", () => {
    it("marks delivered only when confirmed destination receipt proves MessageReceived and recipient token Transfer within bounds", async () => {
      const config = loadAllbridgeConfig();
      const stellarDeployment = config.deployments.networks["stellar-testnet"];
      if (!stellarDeployment || !("sacId" in (stellarDeployment.tokens.USDC ?? {}))) {
        throw new Error("missing stellar USDC");
      }
      const stellarSac = (stellarDeployment.tokens.USDC as { sacId: string }).sacId;

      const nonce = 15n;
      const sourceNetAmount = 100_000_000n; // 10.0000000 USDC (7 decimals)
      const paidAmount = 9_970_000n; // 9.970000 USDC (6 decimals, 30 bps pool fee <= 50 bps maxSlippageBps)
      const destTxHash: Hex = `0x${"55".repeat(32)}`;
      const blockHash: Hex = `0x${"66".repeat(32)}`;
      const receiptBlock = 9_500_000n;

      const messageHash = computeAllbridgeIntentHash({
        sourceChainSymbol: "SRB",
        destinationChainSymbol: "SEP",
        sourceNonce: nonce,
        recipient: toWord(sepoliaRecipient),
        sourceAmount: sourceNetAmount,
        destinationPool: sepoliaPool,
      });

      await db.transaction(async (tx) => {
        await writeOutbound(
          tx,
          {
            chainKey: "stellar-testnet",
            block: 1_295_000n,
            txHash: "cc".repeat(32),
            logIndex: null,
            observedAt: new Date("2026-10-30T16:00:00.000Z"),
          },
          {
            route: RouteKind.Allbridge,
            nonce,
            sender: stellarSender,
            token: stellarSac,
            grossAmount: 100_300_000n,
            fee: 300_000n,
            netAmount: sourceNetAmount,
            destinationChain: "sepolia",
            destination: toWord(sepoliaRecipient),
            railRef: messageHash,
          },
        );
      });

      const sig1 = await validator1.sign({ hash: messageHash });
      const sig3 = await validator3.sign({ hash: messageHash });

      const client = new AllbridgeClient("https://allbridge.example.test", config, {
        fetch: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                status: "completed",
                messageHash,
                sourceChainSymbol: "SRB",
                destinationChainSymbol: "SEP",
                sourceNonce: nonce.toString(),
                recipient: toWord(sepoliaRecipient),
                sourceAmount: sourceNetAmount.toString(),
                signatures: [sig1, sig3],
                destinationTxHash: destTxHash,
                attestedAt: "2026-10-30T16:01:00.000Z",
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          ),
      });

      // 1. Adapter custody alone (Transfer to sepoliaAdapter, not sepoliaRecipient) must NOT establish delivery.
      const custodyOnlyLogs = [
        encodeAllbridgeLog(
          sepoliaMessenger,
          "MessageReceived",
          {
            messageHash,
            sourceNonce: nonceToWord(nonce),
            sourceChainSymbol: "SRB",
          },
          0,
        ),
        encodeAllbridgeLog(
          sepoliaUsdc,
          "Transfer",
          {
            from: sepoliaPool,
            to: sepoliaAdapter,
            value: paidAmount,
          },
          1,
        ),
      ];

      // 2. Excessive slippage / underpayment (below 50 bps bound: 9_900_000 < 9_950_000) must NOT establish delivery.
      const underpaidLogs = [
        custodyOnlyLogs[0]!,
        encodeAllbridgeLog(
          sepoliaUsdc,
          "Transfer",
          {
            from: sepoliaPool,
            to: sepoliaRecipient,
            value: 9_900_000n,
          },
          1,
        ),
      ];

      // 3. Wrong messageHash on chain must NOT establish delivery.
      const wrongMessageLogs = [
        encodeAllbridgeLog(
          sepoliaMessenger,
          "MessageReceived",
          {
            messageHash: `0x${"ff".repeat(32)}`,
            sourceNonce: nonceToWord(nonce),
            sourceChainSymbol: "SRB",
          },
          0,
        ),
        encodeAllbridgeLog(
          sepoliaUsdc,
          "Transfer",
          {
            from: sepoliaPool,
            to: sepoliaRecipient,
            value: paidAmount,
          },
          1,
        ),
      ];

      const { logger } = capturingLogger();
      for (const rejectedLogs of [custodyOnlyLogs, underpaidLogs, wrongMessageLogs]) {
        const reader: AllbridgeEvmReceiptReader = {
          getChainId: () => Promise.resolve(11_155_111),
          getBlockNumber: () => Promise.resolve(receiptBlock + 20n),
          getTransactionReceipt: () =>
            Promise.resolve({
              status: "success",
              blockNumber: receiptBlock,
              blockHash,
              transactionHash: destTxHash,
              logs: rejectedLogs,
            }),
          getBlock: () => Promise.resolve({ hash: blockHash, timestamp: 1_793_000_000n }),
        };

        const pass = new RailPass({
          route: RouteKind.Allbridge,
          config,
          client,
          db,
          logger,
          batchSize: 10,
          recheckAfterMs: 0,
          maxCheckFailures: 3,
          allbridgeVerifyDeps: { evmClientFactory: () => reader },
        });
        await pass.tick(AbortSignal.timeout(5_000));

        const inboundCheck = await db.query("SELECT count(*)::int AS cnt FROM inbound_delivery");
        expect(inboundCheck.rows[0]?.cnt).toBe(0);
      }

      // 4. Valid confirmed receipt with matching MessageReceived + recipient Transfer within bounds succeeds!
      const validLogs = [
        custodyOnlyLogs[0]!,
        encodeAllbridgeLog(
          sepoliaUsdc,
          "Transfer",
          {
            from: sepoliaPool,
            to: sepoliaRecipient,
            value: paidAmount,
          },
          2,
        ),
      ];
      const validReader: AllbridgeEvmReceiptReader = {
        getChainId: () => Promise.resolve(11_155_111),
        getBlockNumber: () => Promise.resolve(receiptBlock + 20n),
        getTransactionReceipt: () =>
          Promise.resolve({
            status: "success",
            blockNumber: receiptBlock,
            blockHash,
            transactionHash: destTxHash,
            logs: validLogs,
          }),
        getBlock: () => Promise.resolve({ hash: blockHash, timestamp: 1_793_000_000n }),
      };

      const pass = new RailPass({
        route: RouteKind.Allbridge,
        config,
        client,
        db,
        logger,
        batchSize: 10,
        recheckAfterMs: 0,
        maxCheckFailures: 3,
        allbridgeVerifyDeps: { evmClientFactory: () => validReader },
      });
      await pass.tick(AbortSignal.timeout(5_000));

      const inbound = await db.query(
        `SELECT destination_chain,
                route,
                source_chain,
                source_nonce::text AS source_nonce,
                rail_message_id,
                recipient,
                token,
                amount::text AS amount,
                delivered,
                claim_id
           FROM inbound_delivery`,
      );
      expect(inbound.rows).toEqual([
        {
          destination_chain: "sepolia",
          route: RouteKind.Allbridge,
          source_chain: "stellar-testnet",
          source_nonce: "15",
          rail_message_id: messageHash,
          recipient: sepoliaRecipient.toLowerCase(),
          token: sepoliaUsdc.toLowerCase(),
          amount: paidAmount.toString(),
          delivered: true,
          claim_id: null,
        },
      ]);

      const att = await db.query("SELECT status FROM rail_attestation");
      expect(att.rows).toEqual([{ status: "delivered" }]);
    });

    it("verifies reverse-direction EVM-to-Stellar Allbridge payouts for classic accounts and refuses muxed strkeys", async () => {
      const muxed = encodeStellarAddress(AddressKind.MuxedAccount, `0x${"77".repeat(32)}`, 42n);
      expect(() =>
        computeAllbridgeIntentHash({
          sourceChainSymbol: "SEP",
          destinationChainSymbol: "SRB",
          sourceNonce: 1n,
          recipient: muxed,
          sourceAmount: 1_000_000n,
          destinationPool: stellarPool,
        }),
      ).toThrow(/cannot represent muxed Stellar recipients/);

      const config = loadAllbridgeConfig();
      const stellarDeployment = config.deployments.networks["stellar-testnet"];
      if (!stellarDeployment || !("sacId" in (stellarDeployment.tokens.USDC ?? {}))) {
        throw new Error("missing stellar USDC");
      }
      const stellarSac = (stellarDeployment.tokens.USDC as { sacId: string }).sacId;

      const nonce = 21n;
      const sourceNetAmount = 20_000_000n; // 20 USDC on 6-decimal Sepolia
      const paidStellarAmount = 199_400_000n; // 19.9400000 USDC on 7-decimal Stellar (30 bps pool fee)
      const destTxHash: Hex = `0x${"88".repeat(32)}`;
      const messageHash = computeAllbridgeIntentHash({
        sourceChainSymbol: "SEP",
        destinationChainSymbol: "SRB",
        sourceNonce: nonce,
        recipient: stellarSender,
        sourceAmount: sourceNetAmount,
        destinationPool: stellarPool,
      });

      await db.transaction(async (tx) => {
        await writeOutbound(
          tx,
          {
            chainKey: "sepolia",
            block: 9_600_000n,
            txHash: `0x${"99".repeat(32)}`,
            logIndex: 0,
            observedAt: new Date("2026-10-30T17:00:00.000Z"),
          },
          {
            route: RouteKind.Allbridge,
            nonce,
            sender: sepoliaRecipient,
            token: sepoliaUsdc,
            grossAmount: 20_060_000n,
            fee: 60_000n,
            netAmount: sourceNetAmount,
            destinationChain: "stellar-testnet",
            destination: stellarSender,
            railRef: messageHash,
          },
        );
      });

      const sig1 = await validator1.sign({ hash: messageHash });
      const sig2 = await validator2.sign({ hash: messageHash });
      const client = new AllbridgeClient("https://allbridge.example.test", config, {
        fetch: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                status: "completed",
                messageHash,
                sourceChainSymbol: "SEP",
                destinationChainSymbol: "SRB",
                sourceNonce: nonce.toString(),
                recipient: stellarSender,
                sourceAmount: sourceNetAmount.toString(),
                signatures: [sig1, sig2],
                destinationTxHash: destTxHash,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          ),
      });

      const { logger } = capturingLogger();
      const pass = new RailPass({
        route: RouteKind.Allbridge,
        config,
        client,
        db,
        logger,
        batchSize: 10,
        recheckAfterMs: 0,
        maxCheckFailures: 3,
        allbridgeVerifyDeps: {
          stellarTxReader: (_rpcUrl, txHash) =>
            Promise.resolve({
              status: "SUCCESS",
              ledger: 1_300_050,
              latestLedger: 1_300_055,
              ledgerCloseTime: 1_793_100_000,
              txHash,
              events: [
                {
                  contractId: stellarMessenger,
                  kind: "message_received",
                  messageHash,
                  sourceNonce: nonce,
                  sourceChainSymbol: "SEP",
                },
                {
                  contractId: stellarSac,
                  kind: "token_transfer",
                  from: stellarPool,
                  to: stellarSender,
                  amount: paidStellarAmount,
                },
              ],
            }),
        },
      });
      await pass.tick(AbortSignal.timeout(5_000));

      const inbound = await db.query(
        "SELECT destination_chain, recipient, amount::text AS amount, delivered FROM inbound_delivery",
      );
      expect(inbound.rows).toEqual([
        {
          destination_chain: "stellar-testnet",
          recipient: stellarSender,
          amount: paidStellarAmount.toString(),
          delivered: true,
        },
      ]);
    });
  });
});
