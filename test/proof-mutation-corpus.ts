import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import {
  AddressKind,
  CHAINS,
  RAIL_CONTRACTS,
  RouteKind,
  assetOn,
  encodeStellarAddress,
  isStellarDeployment,
  toHex,
} from "@hyperion/protocol";
import { StrKey } from "@stellar/stellar-sdk";
import { encodeAbiParameters, encodeEventTopics, hexToBytes, stringToHex, type Hex } from "viem";

import { loadConfig, type AppConfig } from "../src/config/config.js";
import type { Queryable, QueryResultRows, Transactional } from "../src/db/pool.js";
import {
  verifyItsDelivery,
  type ItsDeliveryRpcClient,
  type StellarContractView,
  type VerifiedDelivery,
} from "../src/rails/axelar/delivery.js";
import { ITS_ABI, type DeliveryLog } from "../src/rails/axelar/events.js";
import { verifyCctpDelivery, type CctpDeliveryRpcClient } from "../src/rails/cctp/delivery.js";
import { CCTP_RECEIPT_ABI } from "../src/rails/cctp/events.js";
import type { PendingTransfer, RailReport } from "../src/rails/types.js";

const STELLAR_CCTP_MESSENGER = "CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP";

export type ProofRailKind = "cctp" | "axelar-its";

export interface ExpectedMutationOracleEntry {
  readonly caseId: string;
  readonly rail: ProofRailKind;
  readonly mutationKind: string;
  readonly mutatedField: string;
  readonly expectedAccepted: boolean;
  readonly expectedLogIndex: number | null;
}

export interface ProofMutationCaseRecord {
  readonly caseId: string;
  readonly rail: ProofRailKind;
  readonly mutationKind: string;
  readonly mutatedField: string;
  readonly description: string;
  readonly expectedAccepted: boolean;
  readonly expectedLogIndex: number | null;
  readonly actualAccepted: boolean;
  readonly actualLogIndex: number | null;
  readonly verifiedAmount: string | null;
  readonly verifiedRecipient: string | null;
  readonly verifiedToken: string | null;
  readonly matchesExpected: boolean;
}

export interface ProofMutationCorpusReport {
  readonly corpusVersion: string;
  readonly totalCases: number;
  readonly passedCases: number;
  readonly records: readonly ProofMutationCaseRecord[];
  readonly mismatches: readonly ProofMutationCaseRecord[];
  readonly allMatched: boolean;
}

function deterministicHex(seed: number, byteLen: number): Hex {
  const out: string[] = [];
  for (let i = 0; i < byteLen; i += 1) {
    out.push(((seed + i * 19) & 0xff).toString(16).padStart(2, "0"));
  }
  return `0x${out.join("")}`;
}

function evmWord(addressOrHex: string): Uint8Array {
  return hexToBytes(`0x${addressOrHex.slice(2).padStart(64, "0")}`);
}

export function loadProofMutationOracle(): {
  readonly corpusVersion: string;
  readonly cases: readonly ExpectedMutationOracleEntry[];
} {
  const fullPath = fileURLToPath(
    new URL("./fixtures/proof-mutation-expected.json", import.meta.url),
  );
  return JSON.parse(readFileSync(fullPath, "utf8")) as {
    readonly corpusVersion: string;
    readonly cases: readonly ExpectedMutationOracleEntry[];
  };
}

async function createCorpusDb(): Promise<{
  readonly db: Transactional;
  close(): Promise<void>;
}> {
  const pg = await PGlite.create();
  const migrations = [
    "1790900000000_initial-schema.sql",
    "1791000000000_cursor-block-hash.sql",
    "1791100000000_cursor-autovacuum-tuning.sql",
  ] as const;

  for (const name of migrations) {
    const fullPath = fileURLToPath(new URL(`../migrations/${name}`, import.meta.url));
    const upSql = readFileSync(fullPath, "utf8").split(/^--\s*Down Migration\b/m)[0] ?? "";
    await pg.exec(upSql);
  }

  const runQuery = async (
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResultRows> => {
    const normalized = params.map((p) => (p instanceof Date ? p.toISOString() : p));
    const result = await pg.query(sql, normalized);
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

  return {
    db: {
      query: runQuery,
      async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
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
    },
    async close(): Promise<void> {
      await pg.close();
    },
  };
}

interface CctpMessageBuildSpec {
  readonly sourceDomain: number;
  readonly destinationDomain: number;
  readonly nonce: Hex;
  readonly sourceMessenger: string;
  readonly destinationMessenger: string;
  readonly minFinalityThreshold: number;
  readonly finalityThresholdExecuted: number;
  readonly burnToken: string;
  readonly mintRecipient: string;
  readonly burnAmount: bigint;
  readonly messageSender: string;
  readonly maxFee: bigint;
  readonly feeExecuted: bigint;
}

function buildCctpV2MessageHex(spec: CctpMessageBuildSpec): {
  readonly raw: Hex;
  readonly bodyHex: Hex;
  readonly senderHex: Hex;
} {
  const raw = new Uint8Array(148 + 228);
  const view = new DataView(raw.buffer);
  view.setUint32(0, 1);
  view.setUint32(4, spec.sourceDomain);
  view.setUint32(8, spec.destinationDomain);
  raw.set(hexToBytes(spec.nonce), 12);
  const senderBytes = StrKey.decodeContract(spec.sourceMessenger);
  raw.set(senderBytes, 44);
  raw.set(evmWord(spec.destinationMessenger), 76);
  view.setUint32(140, spec.minFinalityThreshold);
  view.setUint32(144, spec.finalityThresholdExecuted);
  view.setUint32(148, 1);
  raw.set(StrKey.decodeContract(spec.burnToken), 152);
  raw.set(evmWord(spec.mintRecipient), 184);
  raw.set(evmWord(`0x${spec.burnAmount.toString(16)}`), 216);
  raw.set(StrKey.decodeContract(spec.messageSender), 248);
  raw.set(evmWord(`0x${spec.maxFee.toString(16)}`), 280);
  raw.set(evmWord(`0x${spec.feeExecuted.toString(16)}`), 312);

  return {
    raw: toHex(raw),
    bodyHex: toHex(raw.subarray(148)),
    senderHex: toHex(senderBytes),
  };
}

function buildCctpMessageReceivedLog(args: {
  readonly transmitter: Hex;
  readonly caller: Hex;
  readonly nonce: Hex;
  readonly finalityThresholdExecuted: number;
  readonly sourceDomain: number;
  readonly senderHex: Hex;
  readonly bodyHex: Hex;
  readonly logIndex: number;
}): DeliveryLog {
  return {
    address: args.transmitter,
    topics: encodeEventTopics({
      abi: CCTP_RECEIPT_ABI,
      eventName: "MessageReceived",
      args: {
        caller: args.caller,
        nonce: args.nonce,
        finalityThresholdExecuted: args.finalityThresholdExecuted,
      },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters(
      [{ type: "uint32" }, { type: "bytes32" }, { type: "bytes" }],
      [args.sourceDomain, args.senderHex, args.bodyHex],
    ),
    logIndex: args.logIndex,
  };
}

function buildErc20TransferLog(args: {
  readonly token: Hex;
  readonly from: Hex;
  readonly to: Hex;
  readonly value: bigint;
  readonly logIndex: number;
}): DeliveryLog {
  return {
    address: args.token,
    topics: encodeEventTopics({
      abi: CCTP_RECEIPT_ABI,
      eventName: "Transfer",
      args: { from: args.from, to: args.to },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: "uint256" }], [args.value]),
    logIndex: args.logIndex,
  };
}

function buildItsReceivedLog(args: {
  readonly its: Hex;
  readonly commandId: Hex;
  readonly tokenId: Hex;
  readonly destinationAddress: Hex;
  readonly sourceChain: string;
  readonly sourceAddress: Hex;
  readonly amount: bigint;
  readonly logIndex: number;
}): DeliveryLog {
  return {
    address: args.its,
    topics: encodeEventTopics({
      abi: ITS_ABI,
      eventName: "InterchainTransferReceived",
      args: {
        commandId: args.commandId,
        tokenId: args.tokenId,
        destinationAddress: args.destinationAddress,
      },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters(
      [{ type: "string" }, { type: "bytes" }, { type: "uint256" }, { type: "bytes32" }],
      [args.sourceChain, args.sourceAddress, args.amount, `0x${"0".repeat(64)}`],
    ),
    logIndex: args.logIndex,
  };
}

interface ExecutableMutationCase {
  readonly caseId: string;
  readonly rail: ProofRailKind;
  readonly mutationKind: string;
  readonly mutatedField: string;
  readonly description: string;
  readonly run: () => Promise<VerifiedDelivery | null>;
}

export async function runDestinationProofMutationCorpus(): Promise<ProofMutationCorpusReport> {
  const oracle = loadProofMutationOracle();
  const oracleById = new Map<string, ExpectedMutationOracleEntry>();
  for (const entry of oracle.cases) {
    oracleById.set(entry.caseId, entry);
  }

  const deploymentsPath = fileURLToPath(
    new URL("./fixtures/deployments-testnet.json", import.meta.url),
  );
  const baseConfig = loadConfig({
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgres://hyperion:not-a-real-password@127.0.0.1:5433/hyperion",
      REDIS_URL: "redis://127.0.0.1:6380",
      HYPERION_NETWORK: "testnet",
      HYPERION_DEPLOYMENTS_FILE: deploymentsPath,
      KEEPER_ENABLED: "false",
    },
  });

  const stellarBase = baseConfig.deployments.networks["stellar-testnet"];
  if (!stellarBase || !isStellarDeployment(stellarBase) || !stellarBase.tokens.USDC) {
    throw new Error("Missing stellar-testnet deployment fixture");
  }

  const itsAdapterStrkey = encodeStellarAddress(AddressKind.Contract, deterministicHex(0x31, 32));
  const itsHubContractStrkey = encodeStellarAddress(
    AddressKind.Contract,
    deterministicHex(0x32, 32),
  );
  const altContractStrkey = encodeStellarAddress(AddressKind.Contract, deterministicHex(0x33, 32));
  const stellarSenderStrkey = encodeStellarAddress(AddressKind.Account, deterministicHex(0x34, 32));
  const altStellarSenderStrkey = encodeStellarAddress(
    AddressKind.Account,
    deterministicHex(0x35, 32),
  );

  // Clone config with RouteKind.AxelarIts adapter wired on stellar-testnet so verifyItsDelivery runs end-to-end.
  const config: AppConfig = {
    ...baseConfig,
    deployments: {
      ...baseConfig.deployments,
      networks: {
        ...baseConfig.deployments.networks,
        "stellar-testnet": {
          ...stellarBase,
          adapters: {
            ...stellarBase.adapters,
            [RouteKind.AxelarIts]: itsAdapterStrkey,
          },
        },
      },
    },
  };

  const cctpContracts = RAIL_CONTRACTS.sepolia?.cctp;
  const axelarContracts = RAIL_CONTRACTS.sepolia?.axelar;
  const sepoliaUsdc = assetOn("sepolia", "USDC");
  const sepoliaChain = CHAINS.sepolia;
  if (
    !cctpContracts ||
    !axelarContracts ||
    sepoliaUsdc?.family !== "evm" ||
    sepoliaChain.family !== "evm" ||
    sepoliaChain.cctpDomain === null
  ) {
    throw new Error("Missing Sepolia protocol registry constants");
  }

  const recipientEvm = deterministicHex(0x41, 20);
  const attackerEvm = deterministicHex(0x42, 20);
  const fakeTokenEvm = deterministicHex(0x43, 20);
  const recipientWord = `0x${"0".repeat(24)}${recipientEvm.slice(2)}`;

  const cctpSourceAmount = 997_000_000n; // 7 decimals -> 99_700_000n (6 decimals)
  const cctpBurnAmount = cctpSourceAmount / 10n;
  const cctpMaxFee = 500_000n;
  const cctpFeeExecuted = 100_000n;
  const cctpNetMint = cctpBurnAmount - cctpFeeExecuted;
  const cctpNonce = deterministicHex(0x51, 32);
  const cctpForwardTx = deterministicHex(0x52, 32);

  const itsNetAmount = 42_500_000n;
  const itsTokenIdBytes = hexToBytes(deterministicHex(0x61, 32));
  const itsTokenIdHex = toHex(itsTokenIdBytes);
  const itsCommandId = deterministicHex(0x62, 32);
  const itsExecTx = deterministicHex(0x63, 32);
  const itsDestToken = deterministicHex(0x64, 20);
  const itsSourceChainName = "stellar-2026-q1-2";

  const canonicalBlockNumber = 9_500_100n;
  const canonicalBlockHash = deterministicHex(0x71, 32);
  const nonCanonicalBlockHash = deterministicHex(0x72, 32);
  const confirmedHeadBlock = canonicalBlockNumber + BigInt(sepoliaChain.confirmations) + 2n;

  const corpusDb = await createCorpusDb();
  const db = corpusDb.db;

  try {
    // Seed outbound_transfer #1 (CCTP) and #2 (Axelar ITS) on stellar-testnet -> sepolia.
    await db.query(
      `INSERT INTO outbound_transfer
         (origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
          destination_chain, destination, origin_block, origin_tx, observed_at)
       VALUES
         ('stellar-testnet', 0, 101, $1, $2, $3, 3000000, $4,
          'sepolia', $5, 5100001, 'stellar-cctp-origin-101', '2026-10-16T12:00:00.000Z'),
         ('stellar-testnet', 1, 102, $1, $2, 42600000, 100000, $6,
          'sepolia', $5, 5100002, 'stellar-its-origin-102', '2026-10-16T12:01:00.000Z')`,
      [
        stellarSenderStrkey,
        stellarBase.tokens.USDC.sacId,
        String(cctpSourceAmount + 3_000_000n),
        String(cctpSourceAmount),
        recipientWord,
        String(itsNetAmount),
      ],
    );

    const cctpPending: PendingTransfer = {
      transferId: 1n,
      route: RouteKind.Cctp,
      originChain: "stellar-testnet",
      destinationChain: "sepolia",
      nonce: 101n,
      originTx: "stellar-cctp-origin-101",
      status: "attested",
      checkFailures: 0,
      delivered: false,
    };

    const itsPending: PendingTransfer = {
      transferId: 2n,
      route: RouteKind.AxelarIts,
      originChain: "stellar-testnet",
      destinationChain: "sepolia",
      nonce: 102n,
      originTx: "stellar-its-origin-102",
      status: "attested",
      checkFailures: 0,
      delivered: false,
    };

    const baseCctpSpec: CctpMessageBuildSpec = {
      sourceDomain: 27,
      destinationDomain: sepoliaChain.cctpDomain,
      nonce: cctpNonce,
      sourceMessenger: STELLAR_CCTP_MESSENGER,
      destinationMessenger: cctpContracts.tokenMessengerV2,
      minFinalityThreshold: 2000,
      finalityThresholdExecuted: 2000,
      burnToken: stellarBase.tokens.USDC.sacId,
      mintRecipient: recipientEvm,
      burnAmount: cctpBurnAmount,
      messageSender: stellarBase.adapters[RouteKind.Cctp] ?? altContractStrkey,
      maxFee: cctpMaxFee,
      feeExecuted: cctpFeeExecuted,
    };

    const runCctpScenario = async (opts: {
      readonly messageSpec?: Partial<CctpMessageBuildSpec>;
      readonly logs?: (built: ReturnType<typeof buildCctpV2MessageHex>) => readonly DeliveryLog[];
      readonly receiptStatus?: "success" | "reverted";
      readonly receiptBlockHash?: Hex;
      readonly canonicalBlockHash?: Hex;
      readonly headBlockNumber?: bigint;
    }): Promise<VerifiedDelivery | null> => {
      const mergedSpec: CctpMessageBuildSpec = { ...baseCctpSpec, ...opts.messageSpec };
      const built = buildCctpV2MessageHex(mergedSpec);

      const defaultLogs: readonly DeliveryLog[] = [
        buildErc20TransferLog({
          token: sepoliaUsdc.address,
          from: `0x${"0".repeat(40)}`,
          to: recipientEvm,
          value: cctpNetMint,
          logIndex: 3,
        }),
        buildCctpMessageReceivedLog({
          transmitter: cctpContracts.messageTransmitterV2,
          caller: recipientEvm,
          nonce: mergedSpec.nonce,
          finalityThresholdExecuted: mergedSpec.finalityThresholdExecuted,
          sourceDomain: mergedSpec.sourceDomain,
          senderHex: built.senderHex,
          bodyHex: built.bodyHex,
          logIndex: 4,
        }),
      ];

      const evmClient: CctpDeliveryRpcClient = {
        getChainId: () => Promise.resolve(sepoliaChain.chainId),
        getTransactionReceipt: () =>
          Promise.resolve({
            status: opts.receiptStatus ?? "success",
            blockNumber: canonicalBlockNumber,
            blockHash: opts.receiptBlockHash ?? canonicalBlockHash,
            transactionHash: cctpForwardTx,
            logs: opts.logs ? opts.logs(built) : defaultLogs,
          }),
        getBlockNumber: () => Promise.resolve(opts.headBlockNumber ?? confirmedHeadBlock),
        getBlock: () =>
          Promise.resolve({
            hash: opts.canonicalBlockHash ?? canonicalBlockHash,
            timestamp: 1_792_152_000n,
          }),
      };

      const report: RailReport = {
        status: "attested",
        railStatus: "complete",
        reference: "cctp-101",
        attestedAt: new Date("2026-10-16T12:00:30.000Z"),
        forwardTxHash: cctpForwardTx,
        messageBytes: built.raw,
      };

      return verifyCctpDelivery(config, db, cctpPending, report, { evmClient });
    };

    const stellarView: StellarContractView = (contract, method) => {
      if (contract === itsAdapterStrkey && method === "token_id_for") {
        return Promise.resolve(itsTokenIdBytes);
      }
      if (contract === itsAdapterStrkey && method === "get_config") {
        return Promise.resolve({ its: itsHubContractStrkey });
      }
      if (contract === itsHubContractStrkey && method === "chain_name") {
        return Promise.resolve(itsSourceChainName);
      }
      return Promise.reject(new Error(`Unexpected Soroban call ${contract}.${method}`));
    };

    const runItsScenario = async (opts: {
      readonly logs?: readonly DeliveryLog[];
      readonly receiptStatus?: "success" | "reverted";
      readonly receiptBlockHash?: Hex;
      readonly canonicalBlockHash?: Hex;
      readonly reportCommandId?: Hex;
    }): Promise<VerifiedDelivery | null> => {
      const defaultLogs: readonly DeliveryLog[] = [
        buildItsReceivedLog({
          its: axelarContracts.interchainTokenService as Hex,
          commandId: itsCommandId,
          tokenId: itsTokenIdHex,
          destinationAddress: recipientEvm,
          sourceChain: itsSourceChainName,
          sourceAddress: stringToHex(stellarSenderStrkey),
          amount: itsNetAmount,
          logIndex: 4,
        }),
        buildErc20TransferLog({
          token: itsDestToken,
          from: axelarContracts.interchainTokenService as Hex,
          to: recipientEvm,
          value: itsNetAmount,
          logIndex: 5,
        }),
      ];

      const evmClient: ItsDeliveryRpcClient = {
        getChainId: () => Promise.resolve(sepoliaChain.chainId),
        getTransactionReceipt: () =>
          Promise.resolve({
            status: opts.receiptStatus ?? "success",
            blockNumber: canonicalBlockNumber,
            blockHash: opts.receiptBlockHash ?? canonicalBlockHash,
            transactionHash: itsExecTx,
            logs: opts.logs ?? defaultLogs,
          }),
        getBlockNumber: () => Promise.resolve(confirmedHeadBlock),
        readContract: () => Promise.resolve(itsDestToken),
        getBlock: () =>
          Promise.resolve({
            hash: opts.canonicalBlockHash ?? canonicalBlockHash,
            timestamp: 1_792_152_060n,
          }),
      };

      const report: RailReport = {
        status: "attested",
        railStatus: "executed",
        reference: "axelar-102",
        attestedAt: new Date("2026-10-16T12:01:30.000Z"),
        execution: {
          txHash: itsExecTx,
          commandId: opts.reportCommandId ?? itsCommandId,
        },
      };

      return verifyItsDelivery(config, db, itsPending, report, { evmClient, stellarView });
    };

    const noiseUnknownLog: DeliveryLog = {
      address: fakeTokenEvm,
      topics: [deterministicHex(0x88, 32)],
      data: "0x1234",
      logIndex: 0,
    };

    const cases: readonly ExecutableMutationCase[] = [
      // --- CCTP cases ---
      {
        caseId: "cctp_baseline_valid",
        rail: "cctp",
        mutationKind: "valid_baseline",
        mutatedField: "none",
        description:
          "Canonical CCTP V2 MessageReceived + native USDC zero-from mint matches expected payout.",
        run: () => runCctpScenario({}),
      },
      {
        caseId: "cctp_harmless_unrelated_logs_interleaved",
        rail: "cctp",
        mutationKind: "harmless_noise",
        mutatedField: "receipt.logs[unrelated]",
        description:
          "Unrelated ERC-20 transfers, unknown topics, and foreign transmitter logs do not invalidate valid CCTP proof.",
        run: () =>
          runCctpScenario({
            logs: (built) => [
              noiseUnknownLog,
              buildErc20TransferLog({
                token: fakeTokenEvm,
                from: `0x${"0".repeat(40)}`,
                to: attackerEvm,
                value: 999n,
                logIndex: 1,
              }),
              buildErc20TransferLog({
                token: sepoliaUsdc.address,
                from: `0x${"0".repeat(40)}`,
                to: recipientEvm,
                value: cctpNetMint,
                logIndex: 3,
              }),
              buildCctpMessageReceivedLog({
                transmitter: fakeTokenEvm,
                caller: attackerEvm,
                nonce: deterministicHex(0x91, 32),
                finalityThresholdExecuted: 2000,
                sourceDomain: 0,
                senderHex: built.senderHex,
                bodyHex: built.bodyHex,
                logIndex: 2,
              }),
              buildCctpMessageReceivedLog({
                transmitter: cctpContracts.messageTransmitterV2,
                caller: recipientEvm,
                nonce: cctpNonce,
                finalityThresholdExecuted: 2000,
                sourceDomain: 27,
                senderHex: built.senderHex,
                bodyHex: built.bodyHex,
                logIndex: 4,
              }),
              noiseUnknownLog,
            ],
          }),
      },
      {
        caseId: "cctp_harmless_other_recipient_mint_in_same_tx",
        rail: "cctp",
        mutationKind: "harmless_noise",
        mutatedField: "receipt.logs[other_mint]",
        description:
          "Batch transaction containing another user's USDC mint alongside the expected mint still resolves the matching log.",
        run: () =>
          runCctpScenario({
            logs: (built) => [
              buildErc20TransferLog({
                token: sepoliaUsdc.address,
                from: `0x${"0".repeat(40)}`,
                to: attackerEvm,
                value: cctpNetMint,
                logIndex: 1,
              }),
              buildErc20TransferLog({
                token: sepoliaUsdc.address,
                from: `0x${"0".repeat(40)}`,
                to: recipientEvm,
                value: cctpNetMint,
                logIndex: 3,
              }),
              buildCctpMessageReceivedLog({
                transmitter: cctpContracts.messageTransmitterV2,
                caller: recipientEvm,
                nonce: cctpNonce,
                finalityThresholdExecuted: 2000,
                sourceDomain: 27,
                senderHex: built.senderHex,
                bodyHex: built.bodyHex,
                logIndex: 4,
              }),
            ],
          }),
      },
      {
        caseId: "cctp_mutated_mint_recipient",
        rail: "cctp",
        mutationKind: "recipient_mismatch",
        mutatedField: "burnMessage.mintRecipient",
        description:
          "Mutating burnMessage.mintRecipient away from outbound destination is rejected.",
        run: () => runCctpScenario({ messageSpec: { mintRecipient: attackerEvm } }),
      },
      {
        caseId: "cctp_mutated_transfer_to_recipient",
        rail: "cctp",
        mutationKind: "recipient_mismatch",
        mutatedField: "Transfer.to",
        description: "Mutating native USDC Transfer.to away from outbound destination is rejected.",
        run: () =>
          runCctpScenario({
            logs: (built) => [
              buildErc20TransferLog({
                token: sepoliaUsdc.address,
                from: `0x${"0".repeat(40)}`,
                to: attackerEvm,
                value: cctpNetMint,
                logIndex: 3,
              }),
              buildCctpMessageReceivedLog({
                transmitter: cctpContracts.messageTransmitterV2,
                caller: recipientEvm,
                nonce: cctpNonce,
                finalityThresholdExecuted: 2000,
                sourceDomain: 27,
                senderHex: built.senderHex,
                bodyHex: built.bodyHex,
                logIndex: 4,
              }),
            ],
          }),
      },
      {
        caseId: "cctp_mutated_burn_amount",
        rail: "cctp",
        mutationKind: "amount_mismatch",
        mutatedField: "burnMessage.amount",
        description:
          "Mutating burnMessage.amount away from converted outbound net_amount is rejected.",
        run: () => runCctpScenario({ messageSpec: { burnAmount: cctpBurnAmount + 1n } }),
      },
      {
        caseId: "cctp_mutated_payout_transfer_amount",
        rail: "cctp",
        mutationKind: "amount_mismatch",
        mutatedField: "Transfer.value",
        description:
          "Mutating native USDC Transfer.value away from burnAmount - feeExecuted is rejected.",
        run: () =>
          runCctpScenario({
            logs: (built) => [
              buildErc20TransferLog({
                token: sepoliaUsdc.address,
                from: `0x${"0".repeat(40)}`,
                to: recipientEvm,
                value: cctpNetMint + 1n,
                logIndex: 3,
              }),
              buildCctpMessageReceivedLog({
                transmitter: cctpContracts.messageTransmitterV2,
                caller: recipientEvm,
                nonce: cctpNonce,
                finalityThresholdExecuted: 2000,
                sourceDomain: 27,
                senderHex: built.senderHex,
                bodyHex: built.bodyHex,
                logIndex: 4,
              }),
            ],
          }),
      },
      {
        caseId: "cctp_mutated_excessive_fee",
        rail: "cctp",
        mutationKind: "amount_mismatch",
        mutatedField: "burnMessage.feeExecuted",
        description: "Mutating burnMessage.feeExecuted above maxFee is rejected.",
        run: () => runCctpScenario({ messageSpec: { feeExecuted: cctpMaxFee + 1n } }),
      },
      {
        caseId: "cctp_mutated_burn_source_token",
        rail: "cctp",
        mutationKind: "token_mismatch",
        mutatedField: "burnMessage.burnToken",
        description:
          "Mutating burnMessage.burnToken away from source Stellar USDC SAC is rejected.",
        run: () => runCctpScenario({ messageSpec: { burnToken: altContractStrkey } }),
      },
      {
        caseId: "cctp_mutated_destination_token_contract",
        rail: "cctp",
        mutationKind: "token_mismatch",
        mutatedField: "Transfer.address",
        description: "Transfer mint emitted by a counterfeit ERC-20 token contract is rejected.",
        run: () =>
          runCctpScenario({
            logs: (built) => [
              buildErc20TransferLog({
                token: fakeTokenEvm,
                from: `0x${"0".repeat(40)}`,
                to: recipientEvm,
                value: cctpNetMint,
                logIndex: 3,
              }),
              buildCctpMessageReceivedLog({
                transmitter: cctpContracts.messageTransmitterV2,
                caller: recipientEvm,
                nonce: cctpNonce,
                finalityThresholdExecuted: 2000,
                sourceDomain: 27,
                senderHex: built.senderHex,
                bodyHex: built.bodyHex,
                logIndex: 4,
              }),
            ],
          }),
      },
      {
        caseId: "cctp_mutated_ordinary_non_mint_transfer",
        rail: "cctp",
        mutationKind: "non_mint_transfer",
        mutatedField: "Transfer.from",
        description: "Ordinary non-zero-from ERC-20 Transfer cannot masquerade as a CCTP mint.",
        run: () =>
          runCctpScenario({
            logs: (built) => [
              buildErc20TransferLog({
                token: sepoliaUsdc.address,
                from: attackerEvm,
                to: recipientEvm,
                value: cctpNetMint,
                logIndex: 3,
              }),
              buildCctpMessageReceivedLog({
                transmitter: cctpContracts.messageTransmitterV2,
                caller: recipientEvm,
                nonce: cctpNonce,
                finalityThresholdExecuted: 2000,
                sourceDomain: 27,
                senderHex: built.senderHex,
                bodyHex: built.bodyHex,
                logIndex: 4,
              }),
            ],
          }),
      },
      {
        caseId: "cctp_mutated_source_domain",
        rail: "cctp",
        mutationKind: "domain_mismatch",
        mutatedField: "message.sourceDomain",
        description: "CCTP message with sourceDomain != 27 (Stellar) is rejected.",
        run: () => runCctpScenario({ messageSpec: { sourceDomain: 6 } }),
      },
      {
        caseId: "cctp_mutated_destination_domain",
        rail: "cctp",
        mutationKind: "domain_mismatch",
        mutatedField: "message.destinationDomain",
        description: "CCTP message with destinationDomain != target chain domain is rejected.",
        run: () => runCctpScenario({ messageSpec: { destinationDomain: 6 } }),
      },
      {
        caseId: "cctp_mutated_source_adapter",
        rail: "cctp",
        mutationKind: "sender_mismatch",
        mutatedField: "burnMessage.messageSender",
        description:
          "CCTP burn initiated by an unknown contract instead of Hyperion CCTP adapter is rejected.",
        run: () => runCctpScenario({ messageSpec: { messageSender: altContractStrkey } }),
      },
      {
        caseId: "cctp_mutated_finality_threshold",
        rail: "cctp",
        mutationKind: "finality_violation",
        mutatedField: "message.finalityThresholdExecuted",
        description: "CCTP message executed below finality threshold 2000 is rejected.",
        run: () => runCctpScenario({ messageSpec: { finalityThresholdExecuted: 1000 } }),
      },
      {
        caseId: "cctp_mutated_canonical_block_hash",
        rail: "cctp",
        mutationKind: "canonical_hash_mismatch",
        mutatedField: "block.hash",
        description:
          "CCTP receipt on an orphaned block (receipt.blockHash != canonical getBlock.hash) is rejected.",
        run: () => runCctpScenario({ canonicalBlockHash: nonCanonicalBlockHash }),
      },
      {
        caseId: "cctp_mutated_reverted_receipt",
        rail: "cctp",
        mutationKind: "receipt_reverted",
        mutatedField: "receipt.status",
        description: "Reverted CCTP destination transaction receipt is rejected.",
        run: () => runCctpScenario({ receiptStatus: "reverted" }),
      },
      {
        caseId: "cctp_mutated_insufficient_confirmations",
        rail: "cctp",
        mutationKind: "insufficient_confirmations",
        mutatedField: "headBlockNumber",
        description:
          "Unconfirmed CCTP destination receipt below chain confirmation threshold is rejected.",
        run: () => runCctpScenario({ headBlockNumber: canonicalBlockNumber }),
      },

      // --- Axelar ITS cases ---
      {
        caseId: "its_baseline_valid",
        rail: "axelar-its",
        mutationKind: "valid_baseline",
        mutatedField: "none",
        description:
          "Canonical ITS InterchainTransferReceived + registered token Transfer matches expected payout.",
        run: () => runItsScenario({}),
      },
      {
        caseId: "its_harmless_unrelated_logs_interleaved",
        rail: "axelar-its",
        mutationKind: "harmless_noise",
        mutatedField: "receipt.logs[unrelated]",
        description:
          "Unrelated contract events and another user's ITS transfer in the same tx do not invalidate valid ITS proof.",
        run: () =>
          runItsScenario({
            logs: [
              noiseUnknownLog,
              buildItsReceivedLog({
                its: axelarContracts.interchainTokenService as Hex,
                commandId: deterministicHex(0x95, 32),
                tokenId: itsTokenIdHex,
                destinationAddress: attackerEvm,
                sourceChain: itsSourceChainName,
                sourceAddress: stringToHex(altStellarSenderStrkey),
                amount: 123n,
                logIndex: 1,
              }),
              buildErc20TransferLog({
                token: itsDestToken,
                from: axelarContracts.interchainTokenService as Hex,
                to: attackerEvm,
                value: 123n,
                logIndex: 2,
              }),
              buildItsReceivedLog({
                its: axelarContracts.interchainTokenService as Hex,
                commandId: itsCommandId,
                tokenId: itsTokenIdHex,
                destinationAddress: recipientEvm,
                sourceChain: itsSourceChainName,
                sourceAddress: stringToHex(stellarSenderStrkey),
                amount: itsNetAmount,
                logIndex: 4,
              }),
              buildErc20TransferLog({
                token: itsDestToken,
                from: axelarContracts.interchainTokenService as Hex,
                to: recipientEvm,
                value: itsNetAmount,
                logIndex: 5,
              }),
              noiseUnknownLog,
            ],
          }),
      },
      {
        caseId: "its_mutated_event_recipient",
        rail: "axelar-its",
        mutationKind: "recipient_mismatch",
        mutatedField: "InterchainTransferReceived.destinationAddress",
        description: "Mutating InterchainTransferReceived.destinationAddress is rejected.",
        run: () =>
          runItsScenario({
            logs: [
              buildItsReceivedLog({
                its: axelarContracts.interchainTokenService as Hex,
                commandId: itsCommandId,
                tokenId: itsTokenIdHex,
                destinationAddress: attackerEvm,
                sourceChain: itsSourceChainName,
                sourceAddress: stringToHex(stellarSenderStrkey),
                amount: itsNetAmount,
                logIndex: 4,
              }),
              buildErc20TransferLog({
                token: itsDestToken,
                from: axelarContracts.interchainTokenService as Hex,
                to: recipientEvm,
                value: itsNetAmount,
                logIndex: 5,
              }),
            ],
          }),
      },
      {
        caseId: "its_mutated_transfer_recipient",
        rail: "axelar-its",
        mutationKind: "recipient_mismatch",
        mutatedField: "Transfer.to",
        description: "Mutating ITS token Transfer.to away from outbound destination is rejected.",
        run: () =>
          runItsScenario({
            logs: [
              buildItsReceivedLog({
                its: axelarContracts.interchainTokenService as Hex,
                commandId: itsCommandId,
                tokenId: itsTokenIdHex,
                destinationAddress: recipientEvm,
                sourceChain: itsSourceChainName,
                sourceAddress: stringToHex(stellarSenderStrkey),
                amount: itsNetAmount,
                logIndex: 4,
              }),
              buildErc20TransferLog({
                token: itsDestToken,
                from: axelarContracts.interchainTokenService as Hex,
                to: attackerEvm,
                value: itsNetAmount,
                logIndex: 5,
              }),
            ],
          }),
      },
      {
        caseId: "its_mutated_event_amount",
        rail: "axelar-its",
        mutationKind: "amount_mismatch",
        mutatedField: "InterchainTransferReceived.amount",
        description:
          "Mutating InterchainTransferReceived.amount away from outbound net_amount is rejected.",
        run: () =>
          runItsScenario({
            logs: [
              buildItsReceivedLog({
                its: axelarContracts.interchainTokenService as Hex,
                commandId: itsCommandId,
                tokenId: itsTokenIdHex,
                destinationAddress: recipientEvm,
                sourceChain: itsSourceChainName,
                sourceAddress: stringToHex(stellarSenderStrkey),
                amount: itsNetAmount + 1n,
                logIndex: 4,
              }),
              buildErc20TransferLog({
                token: itsDestToken,
                from: axelarContracts.interchainTokenService as Hex,
                to: recipientEvm,
                value: itsNetAmount,
                logIndex: 5,
              }),
            ],
          }),
      },
      {
        caseId: "its_mutated_transfer_amount",
        rail: "axelar-its",
        mutationKind: "amount_mismatch",
        mutatedField: "Transfer.value",
        description:
          "Mutating ITS ERC-20 Transfer.value away from outbound net_amount is rejected.",
        run: () =>
          runItsScenario({
            logs: [
              buildItsReceivedLog({
                its: axelarContracts.interchainTokenService as Hex,
                commandId: itsCommandId,
                tokenId: itsTokenIdHex,
                destinationAddress: recipientEvm,
                sourceChain: itsSourceChainName,
                sourceAddress: stringToHex(stellarSenderStrkey),
                amount: itsNetAmount,
                logIndex: 4,
              }),
              buildErc20TransferLog({
                token: itsDestToken,
                from: axelarContracts.interchainTokenService as Hex,
                to: recipientEvm,
                value: itsNetAmount - 1n,
                logIndex: 5,
              }),
            ],
          }),
      },
      {
        caseId: "its_mutated_token_id",
        rail: "axelar-its",
        mutationKind: "token_mismatch",
        mutatedField: "InterchainTransferReceived.tokenId",
        description:
          "Mutating InterchainTransferReceived.tokenId away from adapter token_id_for is rejected.",
        run: () =>
          runItsScenario({
            logs: [
              buildItsReceivedLog({
                its: axelarContracts.interchainTokenService as Hex,
                commandId: itsCommandId,
                tokenId: deterministicHex(0x99, 32),
                destinationAddress: recipientEvm,
                sourceChain: itsSourceChainName,
                sourceAddress: stringToHex(stellarSenderStrkey),
                amount: itsNetAmount,
                logIndex: 4,
              }),
              buildErc20TransferLog({
                token: itsDestToken,
                from: axelarContracts.interchainTokenService as Hex,
                to: recipientEvm,
                value: itsNetAmount,
                logIndex: 5,
              }),
            ],
          }),
      },
      {
        caseId: "its_mutated_destination_token_contract",
        rail: "axelar-its",
        mutationKind: "token_mismatch",
        mutatedField: "Transfer.address",
        description:
          "Transfer log emitted by an unregistered token contract instead of registeredTokenAddress is rejected.",
        run: () =>
          runItsScenario({
            logs: [
              buildItsReceivedLog({
                its: axelarContracts.interchainTokenService as Hex,
                commandId: itsCommandId,
                tokenId: itsTokenIdHex,
                destinationAddress: recipientEvm,
                sourceChain: itsSourceChainName,
                sourceAddress: stringToHex(stellarSenderStrkey),
                amount: itsNetAmount,
                logIndex: 4,
              }),
              buildErc20TransferLog({
                token: fakeTokenEvm,
                from: axelarContracts.interchainTokenService as Hex,
                to: recipientEvm,
                value: itsNetAmount,
                logIndex: 5,
              }),
            ],
          }),
      },
      {
        caseId: "its_mutated_its_contract_address",
        rail: "axelar-its",
        mutationKind: "token_mismatch",
        mutatedField: "InterchainTransferReceived.address",
        description:
          "InterchainTransferReceived emitted by a spoofed contract instead of official ITS contract is rejected.",
        run: () =>
          runItsScenario({
            logs: [
              buildItsReceivedLog({
                its: fakeTokenEvm,
                commandId: itsCommandId,
                tokenId: itsTokenIdHex,
                destinationAddress: recipientEvm,
                sourceChain: itsSourceChainName,
                sourceAddress: stringToHex(stellarSenderStrkey),
                amount: itsNetAmount,
                logIndex: 4,
              }),
              buildErc20TransferLog({
                token: itsDestToken,
                from: axelarContracts.interchainTokenService as Hex,
                to: recipientEvm,
                value: itsNetAmount,
                logIndex: 5,
              }),
            ],
          }),
      },
      {
        caseId: "its_mutated_source_chain_domain",
        rail: "axelar-its",
        mutationKind: "domain_mismatch",
        mutatedField: "InterchainTransferReceived.sourceChain",
        description:
          "Mutating InterchainTransferReceived.sourceChain away from verified Stellar Axelar chain name is rejected.",
        run: () =>
          runItsScenario({
            logs: [
              buildItsReceivedLog({
                its: axelarContracts.interchainTokenService as Hex,
                commandId: itsCommandId,
                tokenId: itsTokenIdHex,
                destinationAddress: recipientEvm,
                sourceChain: "ethereum",
                sourceAddress: stringToHex(stellarSenderStrkey),
                amount: itsNetAmount,
                logIndex: 4,
              }),
              buildErc20TransferLog({
                token: itsDestToken,
                from: axelarContracts.interchainTokenService as Hex,
                to: recipientEvm,
                value: itsNetAmount,
                logIndex: 5,
              }),
            ],
          }),
      },
      {
        caseId: "its_mutated_source_address",
        rail: "axelar-its",
        mutationKind: "sender_mismatch",
        mutatedField: "InterchainTransferReceived.sourceAddress",
        description:
          "Mutating InterchainTransferReceived.sourceAddress away from outbound sender is rejected.",
        run: () =>
          runItsScenario({
            logs: [
              buildItsReceivedLog({
                its: axelarContracts.interchainTokenService as Hex,
                commandId: itsCommandId,
                tokenId: itsTokenIdHex,
                destinationAddress: recipientEvm,
                sourceChain: itsSourceChainName,
                sourceAddress: stringToHex(altStellarSenderStrkey),
                amount: itsNetAmount,
                logIndex: 4,
              }),
              buildErc20TransferLog({
                token: itsDestToken,
                from: axelarContracts.interchainTokenService as Hex,
                to: recipientEvm,
                value: itsNetAmount,
                logIndex: 5,
              }),
            ],
          }),
      },
      {
        caseId: "its_mutated_command_id",
        rail: "axelar-its",
        mutationKind: "command_id_mismatch",
        mutatedField: "InterchainTransferReceived.commandId",
        description:
          "Mutating InterchainTransferReceived.commandId away from candidate execution.commandId is rejected.",
        run: () => runItsScenario({ reportCommandId: deterministicHex(0x9a, 32) }),
      },
      {
        caseId: "its_missing_transfer_log",
        rail: "axelar-its",
        mutationKind: "incomplete_receipt",
        mutatedField: "receipt.logs[Transfer]",
        description:
          "InterchainTransferReceived without an accompanying token Transfer event is rejected.",
        run: () =>
          runItsScenario({
            logs: [
              buildItsReceivedLog({
                its: axelarContracts.interchainTokenService as Hex,
                commandId: itsCommandId,
                tokenId: itsTokenIdHex,
                destinationAddress: recipientEvm,
                sourceChain: itsSourceChainName,
                sourceAddress: stringToHex(stellarSenderStrkey),
                amount: itsNetAmount,
                logIndex: 4,
              }),
            ],
          }),
      },
      {
        caseId: "its_missing_received_log",
        rail: "axelar-its",
        mutationKind: "incomplete_receipt",
        mutatedField: "receipt.logs[InterchainTransferReceived]",
        description: "Bare token Transfer without InterchainTransferReceived is rejected.",
        run: () =>
          runItsScenario({
            logs: [
              buildErc20TransferLog({
                token: itsDestToken,
                from: axelarContracts.interchainTokenService as Hex,
                to: recipientEvm,
                value: itsNetAmount,
                logIndex: 5,
              }),
            ],
          }),
      },
      {
        caseId: "its_mutated_canonical_block_hash",
        rail: "axelar-its",
        mutationKind: "canonical_hash_mismatch",
        mutatedField: "block.hash",
        description:
          "ITS receipt on an orphaned block (receipt.blockHash != canonical getBlock.hash) is rejected.",
        run: () => runItsScenario({ canonicalBlockHash: nonCanonicalBlockHash }),
      },
      {
        caseId: "its_mutated_reverted_receipt",
        rail: "axelar-its",
        mutationKind: "receipt_reverted",
        mutatedField: "receipt.status",
        description: "Reverted ITS destination transaction receipt is rejected.",
        run: () => runItsScenario({ receiptStatus: "reverted" }),
      },
    ];

    const records: ProofMutationCaseRecord[] = [];
    for (const item of cases) {
      const expected = oracleById.get(item.caseId);
      if (expected === undefined) {
        throw new Error(`Case '${item.caseId}' missing from independent expected oracle fixture`);
      }

      const verified = await item.run();
      const actualAccepted = verified !== null;
      const actualLogIndex = verified?.at.logIndex ?? null;
      const matchesExpected =
        actualAccepted === expected.expectedAccepted &&
        actualLogIndex === expected.expectedLogIndex &&
        expected.rail === item.rail &&
        expected.mutatedField === item.mutatedField;

      records.push({
        caseId: item.caseId,
        rail: item.rail,
        mutationKind: item.mutationKind,
        mutatedField: item.mutatedField,
        description: item.description,
        expectedAccepted: expected.expectedAccepted,
        expectedLogIndex: expected.expectedLogIndex,
        actualAccepted,
        actualLogIndex,
        verifiedAmount: verified ? verified.row.amount.toString() : null,
        verifiedRecipient: verified ? verified.row.recipient : null,
        verifiedToken: verified ? verified.row.token : null,
        matchesExpected,
      });
    }

    const mismatches = records.filter((r) => !r.matchesExpected);
    return {
      corpusVersion: oracle.corpusVersion,
      totalCases: records.length,
      passedCases: records.length - mismatches.length,
      records,
      mismatches,
      allMatched: mismatches.length === 0 && records.length === oracle.cases.length,
    };
  } finally {
    await corpusDb.close();
  }
}
