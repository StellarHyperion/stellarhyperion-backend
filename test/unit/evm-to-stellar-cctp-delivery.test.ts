import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { StrKey } from "@stellar/stellar-sdk";
import {
  AddressKind,
  BURN_HOOK_DATA,
  BURN_MESSAGE_VERSION,
  FINALITY_THRESHOLD_FINALIZED,
  MESSAGE_VERSION,
  MSG_BODY,
  RAIL_CONTRACTS,
  RouteKind,
  STELLAR_DOMAIN,
  cctpBody,
  encodeCctpHook,
  encodeStellarAddress,
  fromHex,
  parseStellarAddress,
  toHex,
  toWord,
} from "@hyperion/protocol";
import { encodeEventTopics, encodeAbiParameters, parseAbiParameters, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import { configuredReverseCctpLanes } from "../../src/chains/runner.js";
import type { RawStellarEvent } from "../../src/chains/stellar/events.js";
import { writeOutbound } from "../../src/chains/writers.js";
import { admitReverseCctpLane, loadConfig } from "../../src/config/config.js";
import { ConfigError } from "../../src/config/env.js";
import type { Queryable, QueryResultRows, Transactional } from "../../src/db/pool.js";
import {
  verifyCctpDelivery,
  type CctpVerificationClients,
  type SourceCctpBurnState,
  type StellarCctpExecutionState,
} from "../../src/rails/cctp/delivery.js";
import {
  EVM_CCTP_BURN_ABI,
  matchingReverseCctpDelivery,
  verifiedReverseCctpMessage,
  type ExpectedReverseCctpTransfer,
} from "../../src/rails/cctp/events.js";
import { IrisClient, reportFor } from "../../src/rails/cctp/iris.js";
import { RailPass } from "../../src/rails/pass.js";
import { pendingForRail } from "../../src/rails/queue.js";
import type { DeliveryLog } from "../../src/rails/axelar/events.js";
import { completeEnv, readFixture } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "migrations");
const CHECKED_IN_TESTNET_DEPLOYMENTS = join(REPO_ROOT, "deployments", "testnet.json");

const STELLAR_MESSENGER = encodeStellarAddress(AddressKind.Contract, `0x${"41".repeat(32)}`);
const STELLAR_TRANSMITTER = encodeStellarAddress(AddressKind.Contract, `0x${"42".repeat(32)}`);
const RECIPIENT_KEY: Hex = `0x${"71".repeat(32)}`;
const ACCOUNT_RECIPIENT = encodeStellarAddress(AddressKind.Account, RECIPIENT_KEY);
const MUXED_ID = 9_876_543_210_123n;
const MUXED_RECIPIENT = encodeStellarAddress(AddressKind.MuxedAccount, RECIPIENT_KEY, MUXED_ID);
const SENDER_EVM: Hex = `0x${"22".repeat(20)}`;
const ORIGIN_TX: Hex = `0x${"ab".repeat(32)}`;
const STELLAR_TX_BARE = "cd".repeat(32);
const MESSAGE_NONCE: Hex = `0x${"5e".repeat(32)}`;

const SEPOLIA_CCTP = RAIL_CONTRACTS.sepolia?.cctp;
if (!SEPOLIA_CCTP) {
  throw new Error("Sepolia CCTP registry missing");
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

async function createMigratedDb(): Promise<{ db: PgliteDb; close: () => Promise<void> }> {
  const pg = new PGlite();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const raw = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const up = raw.split(/^--\s*Down Migration\b/im)[0] ?? raw;
    await pg.exec(up);
  }
  return {
    db: new PgliteDb(pg),
    close: async () => {
      await pg.close();
    },
  };
}

function deploymentJsonWithInboundCctp(inboundEnabled = true): string {
  const raw = JSON.parse(readFixture("deployments-testnet.json")) as {
    networks: Record<string, Record<string, unknown>>;
  };
  const stellar = raw.networks["stellar-testnet"];
  if (!stellar) throw new Error("stellar-testnet missing from fixture");
  stellar.cctp = {
    tokenMessenger: STELLAR_MESSENGER,
    messageTransmitter: STELLAR_TRANSMITTER,
    inboundEnabled,
  };
  return JSON.stringify(raw);
}

interface BuildReverseCctpParams {
  readonly version?: number;
  readonly burnVersion?: number;
  readonly sourceDomain?: number;
  readonly destinationDomain?: number;
  readonly nonce?: Hex;
  readonly senderWord?: Hex;
  readonly recipientWord?: Hex;
  readonly destinationCallerWord?: Hex;
  readonly minFinality?: number;
  readonly finalityExecuted?: number;
  readonly burnTokenWord?: Hex;
  readonly mintRecipientWord?: Hex;
  readonly amount?: bigint;
  readonly messageSenderWord?: Hex;
  readonly maxFee?: bigint;
  readonly feeExecuted?: bigint;
  readonly expirationBlock?: bigint;
  readonly hookBytes?: Uint8Array;
}

function writeU32Be(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

function writeU256Be(buf: Uint8Array, offset: number, value: bigint): void {
  const hex = value.toString(16).padStart(64, "0");
  buf.set(fromHex(`0x${hex}`), offset);
}

function buildReverseCctpMessage(
  expected: ExpectedReverseCctpTransfer,
  overrides: BuildReverseCctpParams = {},
): Hex {
  const hook = overrides.hookBytes ?? encodeCctpHook(expected.recipient);
  const total = MSG_BODY + BURN_HOOK_DATA + hook.length;
  const out = new Uint8Array(total);

  writeU32Be(out, 0, overrides.version ?? MESSAGE_VERSION);
  writeU32Be(out, 4, overrides.sourceDomain ?? expected.sourceDomain);
  writeU32Be(out, 8, overrides.destinationDomain ?? STELLAR_DOMAIN);
  out.set(fromHex(overrides.nonce ?? MESSAGE_NONCE), 12);
  out.set(fromHex(overrides.senderWord ?? toWord(expected.sourceMessenger)), 44);
  out.set(
    fromHex(overrides.recipientWord ?? toHex(StrKey.decodeContract(expected.destinationMessenger))),
    76,
  );
  out.set(fromHex(overrides.destinationCallerWord ?? `0x${"0".repeat(64)}`), 108);
  writeU32Be(out, 140, overrides.minFinality ?? FINALITY_THRESHOLD_FINALIZED);
  writeU32Be(out, 144, overrides.finalityExecuted ?? FINALITY_THRESHOLD_FINALIZED);

  const b = MSG_BODY;
  writeU32Be(out, b, overrides.burnVersion ?? BURN_MESSAGE_VERSION);
  out.set(fromHex(overrides.burnTokenWord ?? toWord(expected.sourceToken)), b + 4);
  out.set(
    fromHex(
      overrides.mintRecipientWord ?? toHex(StrKey.decodeContract(expected.destinationAdapter)),
    ),
    b + 36,
  );
  writeU256Be(out, b + 68, overrides.amount ?? expected.sourceAmount);
  out.set(fromHex(overrides.messageSenderWord ?? toWord(expected.sourceAdapter)), b + 100);
  writeU256Be(out, b + 132, overrides.maxFee ?? 50_000n);
  writeU256Be(out, b + 164, overrides.feeExecuted ?? 10_000n);
  writeU256Be(out, b + 196, overrides.expirationBlock ?? 0n);
  out.set(hook, b + BURN_HOOK_DATA);

  return toHex(out);
}

function buildSourceMessageSentLog(messenger: Hex, rawMessage: Hex): DeliveryLog {
  const topics = encodeEventTopics({
    abi: EVM_CCTP_BURN_ABI,
    eventName: "MessageSent",
  });
  const data = encodeAbiParameters(parseAbiParameters("bytes"), [rawMessage]);
  return {
    address: messenger,
    topics: topics as [Hex, ...Hex[]],
    data,
    logIndex: 1,
  };
}

function buildStellarEvents(params: {
  readonly ledger: number;
  readonly txHash: string;
  readonly expected: ExpectedReverseCctpTransfer;
  readonly rawMessage: Hex;
  readonly stellarAmount: bigint;
  readonly settlement:
    { readonly kind: "delivered" } | { readonly kind: "parked"; readonly claimId: bigint };
}): RawStellarEvent[] {
  const closedAt = "2026-10-05T12:00:00.000Z";
  const bodyHex = toHex(cctpBody(params.rawMessage));
  const senderHex = toWord(params.expected.sourceMessenger);
  const parsedRecipient = parseStellarAddress(params.expected.recipient);

  const receiveEvent: RawStellarEvent = {
    type: "contract",
    ledger: params.ledger,
    ledgerClosedAt: closedAt,
    contractId: params.expected.destinationTransmitter,
    id: "0005529336885739520-0000000001",
    txHash: params.txHash,
    operationIndex: 0,
    transactionIndex: 0,
    inSuccessfulContractCall: true,
    topicJson: [{ symbol: "cctp" }, { symbol: "message_received" }],
    valueJson: {
      map: [
        {
          key: { symbol: "finality_threshold_executed" },
          val: { u32: FINALITY_THRESHOLD_FINALIZED },
        },
        { key: { symbol: "message_body" }, val: { bytes: bodyHex } },
        { key: { symbol: "nonce" }, val: { bytes: MESSAGE_NONCE } },
        { key: { symbol: "sender" }, val: { bytes: senderHex } },
        { key: { symbol: "source_domain" }, val: { u32: params.expected.sourceDomain } },
      ],
    },
  };

  const bridgeInEvent: RawStellarEvent = {
    type: "contract",
    ledger: params.ledger,
    ledgerClosedAt: closedAt,
    contractId: params.expected.destinationRouter,
    id: "0005529336885739520-0000000002",
    txHash: params.txHash,
    operationIndex: 0,
    transactionIndex: 0,
    inSuccessfulContractCall: true,
    topicJson: [{ symbol: "hyperion" }, { symbol: "in" }],
    valueJson: {
      map: [
        {
          key: { symbol: "inbound" },
          val: {
            map: [
              { key: { symbol: "amount" }, val: { i128: params.stellarAmount.toString() } },
              {
                key: { symbol: "claim_id" },
                val: {
                  u64:
                    params.settlement.kind === "parked"
                      ? params.settlement.claimId.toString()
                      : "0",
                },
              },
              {
                key: { symbol: "delivered" },
                val: { bool: params.settlement.kind === "delivered" },
              },
              { key: { symbol: "ledger" }, val: { u32: params.ledger } },
              { key: { symbol: "recipient" }, val: { address: params.expected.recipient } },
              { key: { symbol: "route" }, val: { u32: RouteKind.Cctp } },
              { key: { symbol: "source_chain" }, val: { string: params.expected.originChain } },
              {
                key: { symbol: "source_nonce" },
                val: { u64: params.expected.sourceNonce.toString() },
              },
              { key: { symbol: "token" }, val: { address: params.expected.destinationToken } },
            ],
          },
        },
      ],
    },
  };

  if (params.settlement.kind === "delivered") {
    const toAddr =
      parsedRecipient.kind === AddressKind.MuxedAccount
        ? encodeStellarAddress(AddressKind.Account, parsedRecipient.key)
        : params.expected.recipient;
    const sacValue =
      parsedRecipient.kind === AddressKind.MuxedAccount
        ? {
            map: [
              { key: { symbol: "amount" }, val: { i128: params.stellarAmount.toString() } },
              { key: { symbol: "to_muxed_id" }, val: { u64: parsedRecipient.muxedId.toString() } },
            ],
          }
        : { i128: params.stellarAmount.toString() };

    const sacPayoutEvent: RawStellarEvent = {
      type: "contract",
      ledger: params.ledger,
      ledgerClosedAt: closedAt,
      contractId: params.expected.destinationToken,
      id: "0005529336885739520-0000000003",
      txHash: params.txHash,
      operationIndex: 0,
      transactionIndex: 0,
      inSuccessfulContractCall: true,
      topicJson: [
        { symbol: "transfer" },
        { address: params.expected.destinationRouter },
        { address: toAddr },
      ],
      valueJson: sacValue,
    };
    return [receiveEvent, bridgeInEvent, sacPayoutEvent];
  }

  const claimParkedEvent: RawStellarEvent = {
    type: "contract",
    ledger: params.ledger,
    ledgerClosedAt: closedAt,
    contractId: params.expected.destinationRouter,
    id: "0005529336885739520-0000000003",
    txHash: params.txHash,
    operationIndex: 0,
    transactionIndex: 0,
    inSuccessfulContractCall: true,
    topicJson: [{ symbol: "hyperion" }, { symbol: "park" }],
    valueJson: {
      map: [
        {
          key: { symbol: "claim" },
          val: {
            map: [
              { key: { symbol: "amount" }, val: { i128: params.stellarAmount.toString() } },
              { key: { symbol: "created_at" }, val: { u64: "1791201600" } },
              { key: { symbol: "id" }, val: { u64: params.settlement.claimId.toString() } },
              { key: { symbol: "recipient" }, val: { address: params.expected.recipient } },
              { key: { symbol: "route" }, val: { u32: RouteKind.Cctp } },
              { key: { symbol: "settled" }, val: { bool: false } },
              { key: { symbol: "source_chain" }, val: { string: params.expected.originChain } },
              {
                key: { symbol: "source_nonce" },
                val: { u64: params.expected.sourceNonce.toString() },
              },
              { key: { symbol: "token" }, val: { address: params.expected.destinationToken } },
            ],
          },
        },
      ],
    },
  };

  const sacCustodyEvent: RawStellarEvent = {
    type: "contract",
    ledger: params.ledger,
    ledgerClosedAt: closedAt,
    contractId: params.expected.destinationToken,
    id: "0005529336885739520-0000000004",
    txHash: params.txHash,
    operationIndex: 0,
    transactionIndex: 0,
    inSuccessfulContractCall: true,
    topicJson: [
      { symbol: "transfer" },
      { address: params.expected.destinationAdapter },
      { address: params.expected.destinationRouter },
    ],
    valueJson: { i128: params.stellarAmount.toString() },
  };

  return [receiveEvent, bridgeInEvent, claimParkedEvent, sacCustodyEvent];
}

describe("EVM-to-Stellar CCTP V2 delivery verification (#150)", () => {
  it("blocks reverse CCTP lane admission when inbound Stellar contract capability is missing or disabled", () => {
    const activeConfig = loadConfig({
      env: completeEnv({ HYPERION_DEPLOYMENTS_FILE: CHECKED_IN_TESTNET_DEPLOYMENTS }),
    });
    const activeAdmission = admitReverseCctpLane(activeConfig, "sepolia", "stellar-testnet");
    expect(activeAdmission.admitted).toBe(false);
    if (!activeAdmission.admitted) {
      expect(activeAdmission.blockers).toContain("missing_origin_deployment");
      expect(activeAdmission.blockers).toContain("missing_stellar_cctp_inbound_contracts");
    }
    expect(configuredReverseCctpLanes(activeConfig)).toEqual([]);

    const fixtureConfig = loadConfig({ env: completeEnv() });
    const fixtureAdmission = admitReverseCctpLane(fixtureConfig, "sepolia", "stellar-testnet");
    expect(fixtureAdmission).toEqual({
      admitted: false,
      lane: null,
      blockers: ["missing_stellar_cctp_inbound_contracts"],
    });

    const disabledConfig = loadConfig({
      env: completeEnv({ HYPERION_DEPLOYMENTS_FILE: "/virtual/deployments.json" }),
      readFile: () => deploymentJsonWithInboundCctp(false),
    });
    const disabledAdmission = admitReverseCctpLane(disabledConfig, "sepolia", "stellar-testnet");
    expect(disabledAdmission).toEqual({
      admitted: false,
      lane: null,
      blockers: ["inbound_capability_disabled"],
    });

    expect(() =>
      loadConfig({
        env: completeEnv({ STELLAR_CCTP_TOKEN_MESSENGER: STELLAR_MESSENGER }),
      }),
    ).toThrow(ConfigError);

    expect(() =>
      loadConfig({
        env: completeEnv({
          STELLAR_CCTP_TOKEN_MESSENGER: ACCOUNT_RECIPIENT,
          STELLAR_CCTP_MESSAGE_TRANSMITTER: STELLAR_TRANSMITTER,
        }),
      }),
    ).toThrow(ConfigError);

    const admittedConfig = loadConfig({
      env: completeEnv({ HYPERION_DEPLOYMENTS_FILE: "/virtual/deployments.json" }),
      readFile: () => deploymentJsonWithInboundCctp(true),
    });
    const admitted = admitReverseCctpLane(admittedConfig, "sepolia", "stellar-testnet");
    expect(admitted.admitted).toBe(true);
    expect(configuredReverseCctpLanes(admittedConfig)).toHaveLength(1);
  });

  it("binds source burn identity, Circle message fields, and full Stellar account/muxed hooks", () => {
    const config = loadConfig({
      env: completeEnv({ HYPERION_DEPLOYMENTS_FILE: "/virtual/deployments.json" }),
      readFile: () => deploymentJsonWithInboundCctp(true),
    });
    const admission = admitReverseCctpLane(config, "sepolia", "stellar-testnet");
    if (!admission.admitted) throw new Error("expected admitted lane");
    const lane = admission.lane;

    const expectedMuxed: ExpectedReverseCctpTransfer = {
      originChain: lane.originChain,
      sourceNonce: 42n,
      sourceDomain: lane.sourceDomain,
      sourceToken: lane.originToken,
      sourceAdapter: lane.originAdapter,
      sourceMessenger: lane.originMessenger,
      sourceAmount: 2_500_000n,
      expectedMessageNonce: MESSAGE_NONCE,
      destinationMessenger: lane.destinationMessenger,
      destinationTransmitter: lane.destinationTransmitter,
      destinationAdapter: lane.destinationAdapter,
      destinationRouter: lane.destinationRouter,
      destinationToken: lane.destinationTokenSacId,
      recipient: MUXED_RECIPIENT,
    };

    const rawMuxed = buildReverseCctpMessage(expectedMuxed, { feeExecuted: 10_000n });
    const verified = verifiedReverseCctpMessage(rawMuxed, expectedMuxed);
    expect(verified).not.toBeNull();
    expect(verified?.hookRecipient).toBe(MUXED_RECIPIENT);
    expect(verified?.netUsdc6).toBe(2_490_000n);
    expect(verified?.stellarAmount).toBe(24_900_000n);

    // Stripping muxed sub-account id or mutating any bound message/burn field must fail.
    expect(
      verifiedReverseCctpMessage(rawMuxed, {
        ...expectedMuxed,
        recipient: ACCOUNT_RECIPIENT,
      }),
    ).toBeNull();
    expect(
      verifiedReverseCctpMessage(
        buildReverseCctpMessage(expectedMuxed, { sourceDomain: 6 }),
        expectedMuxed,
      ),
    ).toBeNull();
    expect(
      verifiedReverseCctpMessage(
        buildReverseCctpMessage(expectedMuxed, { destinationDomain: 0 }),
        expectedMuxed,
      ),
    ).toBeNull();
    expect(
      verifiedReverseCctpMessage(
        buildReverseCctpMessage(expectedMuxed, {
          senderWord: toWord(`0x${"99".repeat(20)}`),
        }),
        expectedMuxed,
      ),
    ).toBeNull();
    expect(
      verifiedReverseCctpMessage(
        buildReverseCctpMessage(expectedMuxed, {
          burnTokenWord: toWord(`0x${"88".repeat(20)}`),
        }),
        expectedMuxed,
      ),
    ).toBeNull();
    expect(
      verifiedReverseCctpMessage(
        buildReverseCctpMessage(expectedMuxed, {
          mintRecipientWord: toHex(StrKey.decodeContract(lane.destinationRouter)),
        }),
        expectedMuxed,
      ),
    ).toBeNull();
    expect(
      verifiedReverseCctpMessage(
        buildReverseCctpMessage(expectedMuxed, { amount: 2_500_001n }),
        expectedMuxed,
      ),
    ).toBeNull();
    expect(
      verifiedReverseCctpMessage(
        buildReverseCctpMessage(expectedMuxed, { maxFee: 10_000n, feeExecuted: 10_001n }),
        expectedMuxed,
      ),
    ).toBeNull();
    expect(
      verifiedReverseCctpMessage(
        buildReverseCctpMessage(expectedMuxed, { finalityExecuted: 1000 }),
        expectedMuxed,
      ),
    ).toBeNull();
    expect(
      verifiedReverseCctpMessage(
        buildReverseCctpMessage(expectedMuxed, { nonce: `0x${"ef".repeat(32)}` }),
        expectedMuxed,
      ),
    ).toBeNull();

    // Destination event matching rejects missing SAC recipient transfer even when BridgeIn says delivered.
    const events = buildStellarEvents({
      ledger: 1_290_100,
      txHash: STELLAR_TX_BARE,
      expected: expectedMuxed,
      rawMessage: rawMuxed,
      stellarAmount: 24_900_000n,
      settlement: { kind: "delivered" },
    });
    expect(matchingReverseCctpDelivery(events, rawMuxed, expectedMuxed)?.kind).toBe("delivered");
    expect(matchingReverseCctpDelivery(events.slice(0, 2), rawMuxed, expectedMuxed)).toBeNull();
  });

  it("verifies completed muxed payout end-to-end and rejects tampered source receipts or disabled adapter state", async () => {
    const { db, close } = await createMigratedDb();
    try {
      const config = loadConfig({
        env: completeEnv({ HYPERION_DEPLOYMENTS_FILE: "/virtual/deployments.json" }),
        readFile: () => deploymentJsonWithInboundCctp(true),
      });
      const admission = admitReverseCctpLane(config, "sepolia", "stellar-testnet");
      if (!admission.admitted) throw new Error("expected admitted lane");
      const lane = admission.lane;

      await writeOutbound(
        db,
        {
          chainKey: "sepolia",
          block: 9_413_000n,
          txHash: ORIGIN_TX,
          logIndex: 0,
          observedAt: new Date("2026-10-05T11:58:00.000Z"),
        },
        {
          route: RouteKind.Cctp,
          nonce: 77n,
          sender: SENDER_EVM,
          token: lane.originToken,
          grossAmount: 5_015_000n,
          fee: 15_000n,
          netAmount: 5_000_000n,
          destinationChain: "stellar-testnet",
          destination: MUXED_RECIPIENT,
          railRef: MESSAGE_NONCE,
        },
      );

      const expected: ExpectedReverseCctpTransfer = {
        originChain: lane.originChain,
        sourceNonce: 77n,
        sourceDomain: lane.sourceDomain,
        sourceToken: lane.originToken,
        sourceAdapter: lane.originAdapter,
        sourceMessenger: lane.originMessenger,
        sourceAmount: 5_000_000n,
        expectedMessageNonce: MESSAGE_NONCE,
        destinationMessenger: lane.destinationMessenger,
        destinationTransmitter: lane.destinationTransmitter,
        destinationAdapter: lane.destinationAdapter,
        destinationRouter: lane.destinationRouter,
        destinationToken: lane.destinationTokenSacId,
        recipient: MUXED_RECIPIENT,
      };
      const rawMessage = buildReverseCctpMessage(expected, { feeExecuted: 25_000n });
      const expectedStellarAmount = (5_000_000n - 25_000n) * 10n;

      // Iris returns 64-hex Stellar forwardTxHash without 0x prefix.
      const irisReport = reportFor({
        status: "complete",
        eventNonce: MESSAGE_NONCE,
        forwardTxHash: STELLAR_TX_BARE,
        messageBytes: rawMessage,
        attestation: `0x${"aa".repeat(65)}`,
        attestationTimestamp: "2026-10-05T11:59:00.000Z",
      });
      expect(irisReport.forwardTxHash).toBe(`0x${STELLAR_TX_BARE}`);

      const validSourceState: SourceCctpBurnState = {
        chainId: lane.originChainId,
        receiptStatus: "success",
        logs: [buildSourceMessageSentLog(lane.originMessenger, rawMessage)],
      };
      const validStellarState: StellarCctpExecutionState = {
        status: "SUCCESS",
        ledger: 1_295_000,
        latestLedger: 1_295_010,
        events: buildStellarEvents({
          ledger: 1_295_000,
          txHash: STELLAR_TX_BARE,
          expected,
          rawMessage,
          stellarAmount: expectedStellarAmount,
          settlement: { kind: "delivered" },
        }),
        inboundCapability: {
          router: lane.destinationRouter,
          tokenMessenger: lane.destinationMessenger,
          messageTransmitter: lane.destinationTransmitter,
          inboundEnabled: true,
        },
      };

      const pending = await pendingForRail(db, {
        route: RouteKind.Cctp,
        limit: 10,
        notCheckedSince: new Date("2026-10-05T12:05:00.000Z"),
        maxCheckFailures: 5,
      });
      expect(pending).toHaveLength(1);
      const firstPending = pending[0];
      if (!firstPending) throw new Error("missing pending transfer");

      // Source burn receipt without matching MessageSent log is rejected.
      expect(
        await verifyCctpDelivery(config, db, firstPending, irisReport, {
          readSourceBurnReceipt: () => Promise.resolve({ ...validSourceState, logs: [] }),
          readStellarCctpExecution: () => Promise.resolve(validStellarState),
        }),
      ).toBeNull();

      // Disabled on-chain inbound capability on Stellar adapter is rejected.
      expect(
        await verifyCctpDelivery(config, db, firstPending, irisReport, {
          readSourceBurnReceipt: () => Promise.resolve(validSourceState),
          readStellarCctpExecution: () =>
            Promise.resolve({
              ...validStellarState,
              inboundCapability: {
                ...validStellarState.inboundCapability,
                inboundEnabled: false,
              },
            }),
        }),
      ).toBeNull();

      const { logger } = capturingLogger();
      const iris = new IrisClient("testnet", {
        fetch: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                messages: [
                  {
                    status: "complete",
                    eventNonce: MESSAGE_NONCE,
                    forwardTxHash: STELLAR_TX_BARE,
                    messageBytes: rawMessage,
                    attestation: `0x${"aa".repeat(65)}`,
                    attestationTimestamp: "2026-10-05T11:59:00.000Z",
                  },
                ],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          ),
      });
      const cctpClients: CctpVerificationClients = {
        readSourceBurnReceipt: () => Promise.resolve(validSourceState),
        readStellarCctpExecution: () => Promise.resolve(validStellarState),
      };

      const pass = new RailPass({
        route: RouteKind.Cctp,
        client: iris,
        db,
        logger,
        batchSize: 10,
        recheckAfterMs: 1_000,
        maxCheckFailures: 5,
        now: () => new Date("2026-10-05T12:01:00.000Z"),
        config,
        cctpClients,
      });

      await pass.tick(new AbortController().signal);

      const inboundRows = await db.query(
        "SELECT recipient, token, amount, delivered, claim_id, rail_message_id FROM inbound_delivery",
      );
      expect(inboundRows.rows).toEqual([
        {
          recipient: MUXED_RECIPIENT,
          token: lane.destinationTokenSacId,
          amount: expectedStellarAmount.toString(),
          delivered: true,
          claim_id: null,
          rail_message_id: MESSAGE_NONCE,
        },
      ]);

      const attestationRows = await db.query("SELECT status FROM rail_attestation");
      expect(attestationRows.rows).toEqual([{ status: "delivered" }]);
    } finally {
      await close();
    }
  });

  it("distinguishes a parked fixed-recipient claim from a completed recipient payment", async () => {
    const { db, close } = await createMigratedDb();
    try {
      const config = loadConfig({
        env: completeEnv({ HYPERION_DEPLOYMENTS_FILE: "/virtual/deployments.json" }),
        readFile: () => deploymentJsonWithInboundCctp(true),
      });
      const admission = admitReverseCctpLane(config, "sepolia", "stellar-testnet");
      if (!admission.admitted) throw new Error("expected admitted lane");
      const lane = admission.lane;

      await writeOutbound(
        db,
        {
          chainKey: "sepolia",
          block: 9_413_100n,
          txHash: ORIGIN_TX,
          logIndex: 0,
          observedAt: new Date("2026-10-05T11:58:00.000Z"),
        },
        {
          route: RouteKind.Cctp,
          nonce: 88n,
          sender: SENDER_EVM,
          token: lane.originToken,
          grossAmount: 3_009_000n,
          fee: 9_000n,
          netAmount: 3_000_000n,
          destinationChain: "stellar-testnet",
          destination: ACCOUNT_RECIPIENT,
          railRef: MESSAGE_NONCE,
        },
      );

      const expected: ExpectedReverseCctpTransfer = {
        originChain: lane.originChain,
        sourceNonce: 88n,
        sourceDomain: lane.sourceDomain,
        sourceToken: lane.originToken,
        sourceAdapter: lane.originAdapter,
        sourceMessenger: lane.originMessenger,
        sourceAmount: 3_000_000n,
        expectedMessageNonce: MESSAGE_NONCE,
        destinationMessenger: lane.destinationMessenger,
        destinationTransmitter: lane.destinationTransmitter,
        destinationAdapter: lane.destinationAdapter,
        destinationRouter: lane.destinationRouter,
        destinationToken: lane.destinationTokenSacId,
        recipient: ACCOUNT_RECIPIENT,
      };
      const rawMessage = buildReverseCctpMessage(expected, { feeExecuted: 0n });
      const expectedStellarAmount = 30_000_000n;
      const claimId = 55n;

      const { logger } = capturingLogger();
      const iris = new IrisClient("testnet", {
        fetch: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                messages: [
                  {
                    status: "complete",
                    eventNonce: MESSAGE_NONCE,
                    forwardTxHash: STELLAR_TX_BARE,
                    messageBytes: rawMessage,
                    attestation: `0x${"bb".repeat(65)}`,
                    attestationTimestamp: "2026-10-05T11:59:00.000Z",
                  },
                ],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          ),
      });

      const pass = new RailPass({
        route: RouteKind.Cctp,
        client: iris,
        db,
        logger,
        batchSize: 10,
        recheckAfterMs: 1_000,
        maxCheckFailures: 5,
        now: () => new Date("2026-10-05T12:01:00.000Z"),
        config,
        cctpClients: {
          readSourceBurnReceipt: () =>
            Promise.resolve({
              chainId: lane.originChainId,
              receiptStatus: "success",
              logs: [buildSourceMessageSentLog(lane.originMessenger, rawMessage)],
            }),
          readStellarCctpExecution: () =>
            Promise.resolve({
              status: "SUCCESS",
              ledger: 1_295_200,
              latestLedger: 1_295_205,
              events: buildStellarEvents({
                ledger: 1_295_200,
                txHash: STELLAR_TX_BARE,
                expected,
                rawMessage,
                stellarAmount: expectedStellarAmount,
                settlement: { kind: "parked", claimId },
              }),
              inboundCapability: {
                router: lane.destinationRouter,
                tokenMessenger: lane.destinationMessenger,
                messageTransmitter: lane.destinationTransmitter,
                inboundEnabled: true,
              },
            }),
        },
      });

      await pass.tick(new AbortController().signal);

      const inboundRows = await db.query(
        "SELECT recipient, amount, delivered, claim_id FROM inbound_delivery",
      );
      expect(inboundRows.rows).toEqual([
        {
          recipient: ACCOUNT_RECIPIENT,
          amount: expectedStellarAmount.toString(),
          delivered: false,
          claim_id: "55",
        },
      ]);

      const claimRows = await db.query(
        "SELECT chain, claim_id, recipient, amount, settled FROM pending_claim",
      );
      expect(claimRows.rows).toEqual([
        {
          chain: "stellar-testnet",
          claim_id: "55",
          recipient: ACCOUNT_RECIPIENT,
          amount: expectedStellarAmount.toString(),
          settled: false,
        },
      ]);

      // Attestation remains attested (never delivered) while funds sit in a parked claim.
      const attestationRows = await db.query("SELECT status FROM rail_attestation");
      expect(attestationRows.rows).toEqual([{ status: "attested" }]);

      // Queue does not misclassify the parked claim as delivered: true.
      const nextQueue = await pendingForRail(db, {
        route: RouteKind.Cctp,
        limit: 10,
        notCheckedSince: new Date("2026-10-05T12:10:00.000Z"),
        maxCheckFailures: 5,
      });
      expect(nextQueue).toHaveLength(1);
      expect(nextQueue[0]?.delivered).toBe(false);
    } finally {
      await close();
    }
  });
});
