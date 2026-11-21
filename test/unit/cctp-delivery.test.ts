import { StrKey } from "@stellar/stellar-sdk";
import { RouteKind, toHex } from "@hyperion/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, hexToBytes, type Hex } from "viem";
import type * as Viem from "viem";
import { loadConfig } from "../../src/config/config.js";
import {
  inspectCctpDelivery,
  describeCctpProofChecks,
  type CctpProofCheckSummary,
} from "../../src/rails/cctp/delivery.js";
import type { PendingTransfer, RailReport } from "../../src/rails/types.js";
import { completeEnv } from "../helpers.js";
import {
  CCTP_RECEIPT_ABI,
  codeHashOf,
  evaluateCctpContractIdentity,
  cctpMessageIdentity,
  inspectCctpMessage,
  inspectCctpPayment,
  matchingCctpPayment,
  verifiedCctpMessage,
  type ExpectedCctpTransfer,
} from "../../src/rails/cctp/events.js";
import type { DeliveryLog } from "../../src/rails/axelar/events.js";
import { reportFor } from "../../src/rails/cctp/iris.js";
import { writeAttestation, writeInbound } from "../../src/chains/writers.js";
import type { Queryable } from "../../src/db/pool.js";

const expected: ExpectedCctpTransfer = {
  sourceToken: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  sourceAdapter: "CARH6IA4TA5QAJNQG4B4I7N4336JEBS3GYLPZSEBUCWSNYTDRC7L3AHT",
  sourceMessenger: "CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP",
  destinationDomain: 0,
  destinationMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
  transmitter: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
  token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  recipient: "0x1111111111111111111111111111111111111111",
  sourceAmount: 997000000n,
};
const nonce: Hex = `0x${"ab".repeat(32)}`;
const word = (address: string) => hexToBytes(`0x${address.slice(2).padStart(64, "0")}`);
function message() {
  const raw = new Uint8Array(148 + 228);
  const view = new DataView(raw.buffer);
  view.setUint32(0, 1);
  view.setUint32(4, 27);
  view.setUint32(8, expected.destinationDomain);
  raw.set(hexToBytes(nonce), 12);
  raw.set(StrKey.decodeContract(expected.sourceMessenger), 44);
  raw.set(word(expected.destinationMessenger), 76);
  view.setUint32(140, 2000);
  view.setUint32(144, 2000);
  view.setUint32(148, 1);
  raw.set(StrKey.decodeContract(expected.sourceToken), 152);
  raw.set(word(expected.recipient), 184);
  raw.set(word(`0x${(expected.sourceAmount / 10n).toString(16)}`), 216);
  raw.set(StrKey.decodeContract(expected.sourceAdapter), 248);
  raw.set(word(`0x${500000n.toString(16)}`), 280);
  raw.set(word(`0x${100000n.toString(16)}`), 312);
  return toHex(raw);
}
const raw = message();
const verified = verifiedCctpMessage(raw, expected);
if (!verified) throw new Error("Invalid test message.");
const received: DeliveryLog = {
  address: expected.transmitter as Hex,
  topics: encodeEventTopics({
    abi: CCTP_RECEIPT_ABI,
    eventName: "MessageReceived",
    args: { caller: expected.recipient as Hex, nonce, finalityThresholdExecuted: 2000 },
  }) as [Hex, ...Hex[]],
  data: encodeAbiParameters(
    [{ type: "uint32" }, { type: "bytes32" }, { type: "bytes" }],
    [27, verified.message.sender, verified.body],
  ),
  logIndex: 4,
};
const paid: DeliveryLog = {
  address: expected.token as Hex,
  topics: encodeEventTopics({
    abi: CCTP_RECEIPT_ABI,
    eventName: "Transfer",
    args: { from: `0x${"0".repeat(40)}`, to: expected.recipient as Hex },
  }) as [Hex, ...Hex[]],
  data: encodeAbiParameters([{ type: "uint256" }], [verified.amount]),
  logIndex: 3,
};
describe("CCTP forwarded destination proof", () => {
  it("binds contract code identity to the canonical proof block", () => {
    const observations = [
      { role: "token_messenger_v2" as const, address: expected.destinationMessenger, codeHash: codeHashOf("0x6000") },
      { role: "message_transmitter_v2" as const, address: expected.transmitter, codeHash: codeHashOf("0x6001") },
      { role: "usdc" as const, address: expected.token, codeHash: codeHashOf("0x6002") },
    ];
    const baseline = new Map(
      observations.map((observation) => [observation.role, observation]),
    );
    expect(
      evaluateCctpContractIdentity({
        destinationChain: "sepolia",
        chainId: 11155111,
        blockNumber: 42n,
        blockHash: `0x${"ab".repeat(32)}`,
        txHash: `0x${"cd".repeat(32)}`,
        observations,
        baselines: baseline,
      }).verdict,
    ).toBe("verified");
    expect(
      evaluateCctpContractIdentity({
        destinationChain: "sepolia",
        chainId: 11155111,
        blockNumber: 42n,
        blockHash: `0x${"ab".repeat(32)}`,
        txHash: `0x${"cd".repeat(32)}`,
        observations: [{ ...observations[0], codeHash: codeHashOf("0x6003") }, ...observations.slice(1)],
        baselines: baseline,
      }).verdict,
    ).toBe("unexpected_upgrade");
  });

  it("requires the exact attested message and an actual native-USDC mint after fees", () => {
    expect(verified.amount).toBe(99600000n);
    expect(verified.feeReconciliation).toEqual({
      burnedAmountSourceUnits: 997000000n,
      forwardingBudgetDestinationUnits: 500000n,
      executedDeductionDestinationUnits: 100000n,
      actualPayoutDestinationUnits: 99600000n,
    });
    expect(matchingCctpPayment([paid, received], raw, expected)).toBe(paid);
    expect(matchingCctpPayment([received], raw, expected)).toBeNull();
    expect(matchingCctpPayment([paid], raw, expected)).toBeNull();
    expect(inspectCctpPayment([received], raw, expected).failure).toBe("mint_missing");
    expect(inspectCctpPayment([paid], raw, expected).failure).toBe("receipt_missing");
    expect(
      inspectCctpPayment(
        [
          { ...paid, data: encodeAbiParameters([{ type: "uint256" }], [verified.amount + 1n]) },
          received,
        ],
        raw,
        expected,
      ).failure,
    ).toBe("amount_mismatch");
  });
  it.each(["sourceToken", "sourceAdapter", "sourceMessenger"] as const)(
    "binds the %s to the indexed source deployment",
    (field) => {
      const replacement = field === "sourceToken" ? expected.sourceAdapter : expected.sourceToken;
      expect(verifiedCctpMessage(raw, { ...expected, [field]: replacement })).toBeNull();
    },
  );
  it("reports bounded field-level diagnostics for domain, token, recipient, and amount mismatches", () => {
    const wrongSourceDomain = hexToBytes(raw);
    new DataView(wrongSourceDomain.buffer).setUint32(4, 6);
    expect(inspectCctpMessage(toHex(wrongSourceDomain), expected).failure).toBe(
      "source_domain_mismatch",
    );
    expect(inspectCctpMessage(raw, { ...expected, destinationDomain: 6 }).failure).toBe(
      "destination_domain_mismatch",
    );
    expect(
      inspectCctpMessage(raw, { ...expected, sourceToken: expected.sourceAdapter }).failure,
    ).toBe("token_mismatch");
    expect(inspectCctpMessage(raw, { ...expected, recipient: expected.token }).failure).toBe(
      "recipient_mismatch",
    );
    expect(
      inspectCctpMessage(raw, { ...expected, sourceAmount: expected.sourceAmount + 10n }).failure,
    ).toBe("amount_mismatch");
  });
  it.each([
    [280, expected.sourceAmount / 10n],
    [280, expected.sourceAmount / 10n + 1n],
    [312, 500001n],
    [312, expected.sourceAmount / 10n],
  ])("rejects inconsistent fee accounting at message offset %i", (offset, value) => {
    const changed = hexToBytes(raw);
    changed.set(word(`0x${value.toString(16)}`), offset);
    expect(inspectCctpMessage(toHex(changed), expected).failure).toBe("fee_mismatch");
  });
  it("rejects a seven-decimal burn that cannot be converted exactly", () => {
    expect(
      inspectCctpMessage(raw, { ...expected, sourceAmount: expected.sourceAmount + 1n }).failure,
    ).toBe("amount_mismatch");
  });
  it.each(["destinationMessenger", "recipient"] as const)("refuses a different %s", (field) => {
    expect(verifiedCctpMessage(raw, { ...expected, [field]: expected.token })).toBeNull();
  });
  it("refuses a different domain or source amount", () => {
    expect(verifiedCctpMessage(raw, { ...expected, destinationDomain: 6 })).toBeNull();
    expect(
      verifiedCctpMessage(raw, { ...expected, sourceAmount: expected.sourceAmount + 10n }),
    ).toBeNull();
  });
  it.each(["transmitter", "token"] as const)(
    "does not trust a log from another %s contract",
    (field) => {
      expect(
        matchingCctpPayment([paid, received], raw, { ...expected, [field]: expected.recipient }),
      ).toBeNull();
    },
  );
  it("refuses an ordinary transfer, incorrect payout and a different nonce", () => {
    const ordinary = {
      ...paid,
      topics: encodeEventTopics({
        abi: CCTP_RECEIPT_ABI,
        eventName: "Transfer",
        args: { from: expected.transmitter as Hex, to: expected.recipient as Hex },
      }) as [Hex, ...Hex[]],
    };
    expect(matchingCctpPayment([ordinary, received], raw, expected)).toBeNull();
    expect(
      matchingCctpPayment(
        [
          { ...paid, data: encodeAbiParameters([{ type: "uint256" }], [verified.amount + 1n]) },
          received,
        ],
        raw,
        expected,
      ),
    ).toBeNull();
    const changed = hexToBytes(raw);
    changed[12] = 1;
    expect(matchingCctpPayment([paid, received], toHex(changed), expected)).toBeNull();
  });
  it("refuses excessive fees and insufficient finality", () => {
    const changed = hexToBytes(raw);
    changed.set(word(`0x${600000n.toString(16)}`), 312);
    expect(verifiedCctpMessage(toHex(changed), expected)).toBeNull();
    expect(inspectCctpMessage(toHex(changed), expected).failure).toBe("fee_mismatch");
    const slow = hexToBytes(raw);
    new DataView(slow.buffer).setUint32(144, 1000);
    expect(verifiedCctpMessage(toHex(slow), expected)).toBeNull();
  });
  it("treats Circle's forward hash only as a candidate, never as delivered", () => {
    const txHash = `0x${"aa".repeat(32)}`;
    expect(reportFor({ status: "complete", forwardTxHash: txHash }).forwardTxHash).toBe(txHash);
    expect(reportFor({ status: "complete", forwardTxHash: txHash }).status).toBe("attested");
    expect(
      reportFor({ status: "complete", forwardTxHash: "invalid" }).forwardTxHash,
    ).toBeUndefined();
  });
  it("keeps full-width message identifiers and omits oversized provider payloads", () => {
    const reference = `0x${"ab".repeat(32)}`;
    const report = reportFor({
      status: "complete",
      eventNonce: reference,
      delayReason: "token=provider-secret",
      message: `0x${"ab".repeat(8192)}`,
    });
    expect(report.reference).toBe(reference);
    expect(report.railStatus).toBe("complete");
    expect(report.messageBytes).toBeNull();
  });
  it("persists only the bounded verification failure code with the attestation", async () => {
    let statement = "";
    let parameters: readonly unknown[] = [];
    const db: Queryable = {
      query(sql, values = []) {
        statement = sql;
        parameters = values;
        return Promise.resolve({ rows: [], rowCount: 1 });
      },
    };
    await writeAttestation(db, {
      transferId: 7n,
      route: 0,
      status: "pending",
      railStatus: "complete",
      railReference: `0x${"ab".repeat(32)}`,
      attestedAt: null,
      checkedAt: new Date("2026-11-19T09:00:00Z"),
      checkFailures: 0,
      lastError: null,
      retryAttempts: 0,
      nextAttemptAt: new Date("2026-11-19T09:01:00Z"),
      retryClass: null,
      verificationFailure: "recipient_mismatch",
    });
    expect(statement).toContain("verification_failure = EXCLUDED.verification_failure");
    expect(parameters[13]).toBe("recipient_mismatch");
  });
});

const evm = vi.hoisted(() => ({
  getChainId: vi.fn(),
  getTransactionReceipt: vi.fn(),
  getBlockNumber: vi.fn(),
  getBlock: vi.fn(),
}));
vi.mock("viem", async (original) => ({
  ...(await original<typeof Viem>()),
  createPublicClient: () => evm,
}));

describe("CCTP full message identity", () => {
  /** Same bottom eight bytes, so the same displayed nonce, but a different full 32-byte nonce. */
  const sibling = (() => {
    const changed = hexToBytes(raw);
    changed[12] = 0x01;
    return toHex(changed);
  })();
  const displayed = BigInt(`0x${nonce.slice(-16)}`).toString();

  it("keeps two messages with the same displayed nonce distinct", () => {
    const first = cctpMessageIdentity(raw);
    const second = cctpMessageIdentity(sibling);
    expect(first?.nonce).toBe(nonce);
    expect(second?.nonce).not.toBe(first?.nonce);
    expect(second?.digest).not.toBe(first?.digest);
    expect(second?.nonce.slice(-16)).toBe(first?.nonce.slice(-16));

    const a = reportFor({ status: "complete", eventNonce: displayed, message: raw });
    const b = reportFor({ status: "complete", eventNonce: displayed, message: sibling });
    expect(a.reference).toBe(first?.nonce);
    expect(b.reference).toBe(second?.nonce);
    expect(a.messageDigest).toBe(first?.digest);
    expect(b.messageDigest).toBe(second?.digest);
    expect(a.reference).not.toBe(displayed);
  });

  it("gives an exact repeated message one identity", () => {
    expect(cctpMessageIdentity(raw)).toEqual(
      cctpMessageIdentity(raw.toUpperCase().replace("0X", "0x")),
    );
  });

  it("withholds a provider message whose nonce contradicts the provider reference", () => {
    const fullMismatch = reportFor({
      status: "complete",
      eventNonce: `0x${"cd".repeat(32)}`,
      message: raw,
    });
    expect(fullMismatch.messageBytes).toBeNull();
    expect(fullMismatch.messageNonce).toBeNull();
    expect(fullMismatch.reference).toBeNull();
    const shortMismatch = reportFor({ status: "complete", eventNonce: "1", message: raw });
    expect(shortMismatch.messageBytes).toBeNull();
    expect(shortMismatch.reference).toBeNull();
  });

  describe("delivery association", () => {
    const base = loadConfig({ env: completeEnv() });
    const source = base.deployments.networks["stellar-testnet"];
    if (source?.family !== "stellar") throw new Error("Expected Stellar source deployment.");
    const config = {
      ...base,
      deployments: {
        ...base.deployments,
        networks: {
          ...base.deployments.networks,
          "stellar-testnet": {
            ...source,
            adapters: { ...source.adapters, [RouteKind.Cctp]: expected.sourceAdapter },
            tokens: {
              ...source.tokens,
              USDC: { ...source.tokens.USDC!, sacId: expected.sourceToken },
            },
          },
        },
      },
    };
    const hash: Hex = `0x${"ef".repeat(32)}`;
    const transfer: PendingTransfer = {
      transferId: 41n,
      route: RouteKind.Cctp,
      originChain: "stellar-testnet",
      destinationChain: "sepolia",
      nonce: 9001n,
      originTx: "source-burn-tx",
      status: "attested",
      checkFailures: 0,
      retryAttempts: 0,
      delivered: false,
    };
    const stored = {
      origin_chain: transfer.originChain,
      nonce: transfer.nonce.toString(),
      origin_tx: transfer.originTx,
      destination_chain: transfer.destinationChain,
      token: expected.sourceToken,
      net_amount: expected.sourceAmount.toString(),
      destination: `0x${expected.recipient.slice(2).padStart(64, "0")}`,
    };
    const identity = cctpMessageIdentity(raw)!;
    const report: RailReport = {
      status: "attested",
      railStatus: "complete",
      reference: identity.nonce,
      attestedAt: null,
      forwardTxHash: hash,
      messageBytes: raw,
      messageNonce: identity.nonce,
      messageDigest: identity.digest,
    };
    const database = (
      source: Record<string, unknown> | null,
      delivered: readonly Record<string, unknown>[] = [],
    ): Queryable => ({
      query: (sql: string) =>
        Promise.resolve(
          sql.includes("FROM inbound_delivery")
            ? { rows: [...delivered], rowCount: delivered.length }
            : { rows: source ? [source] : [], rowCount: source ? 1 : 0 },
        ),
    });

    beforeEach(() => {
      evm.getChainId.mockResolvedValue(11155111);
      evm.getBlockNumber.mockResolvedValue(1000n);
      evm.getTransactionReceipt.mockResolvedValue({
        status: "success",
        blockNumber: 100n,
        transactionHash: hash,
        blockHash: hash,
        logs: [received, paid],
      });
      evm.getBlock.mockResolvedValue({ hash, timestamp: 1700000000n });
    });

    it("retries the complete CCTP proof on the secondary destination RPC", async () => {
      const withSecondary = {
        ...config,
        destinationVerification: {
          ...config.destinationVerification,
          evmRpcUrls: {
            ...config.destinationVerification.evmRpcUrls,
            sepolia: ["https://primary.example/private-key", "https://secondary.example/rpc"],
          },
        },
      };
      evm.getTransactionReceipt.mockRejectedValueOnce(new Error("primary unavailable"));

      const result = await inspectCctpDelivery(withSecondary, database(stored), transfer, report);

      expect(result.delivery).not.toBeNull();
      expect(evm.getTransactionReceipt).toHaveBeenCalledTimes(2);
    });

    it("does not produce CCTP delivery when all destination RPCs report another chain", async () => {
      const withSecondary = {
        ...config,
        destinationVerification: {
          ...config.destinationVerification,
          evmRpcUrls: {
            ...config.destinationVerification.evmRpcUrls,
            sepolia: ["https://primary.example/rpc", "https://secondary.example/rpc"],
          },
        },
      };
      evm.getChainId.mockResolvedValue(1);

      await expect(
        inspectCctpDelivery(withSecondary, database(stored), transfer, report),
      ).rejects.toMatchObject({ name: "DestinationVerificationRpcError" });
      expect(evm.getTransactionReceipt).not.toHaveBeenCalled();
    });

    it("records the full nonce and replays an exact repeat for the same transfer", async () => {
      const first = await inspectCctpDelivery(config, database(stored), transfer, report);
      expect(first.failure).toBeNull();
      expect(first.delivery?.row.railMessageId).toBe(identity.nonce);
      const repeat = await inspectCctpDelivery(
        config,
        database(stored, [{ source_transfer_id: "41" }]),
        transfer,
        report,
      );
      expect(repeat.failure).toBeNull();
      expect(repeat.delivery).toEqual(first.delivery);
    });

    it("never re-associates a message already delivered for another transfer", async () => {
      const result = await inspectCctpDelivery(
        config,
        database(stored, [{ source_transfer_id: "40" }]),
        transfer,
        report,
      );
      expect(result).toMatchObject({ delivery: null, failure: "message_already_delivered" });
    });

    it("refuses a report whose bound digest or nonce differs from the message bytes", async () => {
      for (const changed of [
        { ...report, messageDigest: `0x${"00".repeat(32)}` },
        { ...report, messageNonce: `0x${"00".repeat(32)}` },
      ]) {
        expect(
          (await inspectCctpDelivery(config, database(stored), transfer, changed)).failure,
        ).toBe("invalid_message");
      }
    });

    it.each([
      ["origin_chain", "ethereum"],
      ["nonce", "9002"],
      ["origin_tx", "another-burn-tx"],
      ["destination_chain", "base-sepolia"],
    ])("requires the stored %s burn binding", async (column, value) => {
      const result = await inspectCctpDelivery(
        config,
        database({ ...stored, [column]: value }),
        transfer,
        report,
      );
      expect(result).toMatchObject({ delivery: null, failure: "source_transfer_missing" });
    });

    it("requires the source row to exist on the CCTP route", async () => {
      expect((await inspectCctpDelivery(config, database(null), transfer, report)).failure).toBe(
        "source_transfer_missing",
      );
    });

    it("exposes canonical proof evidence with bounded public references on success", async () => {
      const result = await inspectCctpDelivery(config, database(stored), transfer, report);
      expect(result.failure).toBeNull();
      expect(result.delivery).not.toBeNull();
      if (result.proofEvidence === null) throw new Error("Expected successful delivery");
      expect(result.proofEvidence.txHash).toBe(hash);
      expect(result.proofEvidence.blockNumber).toBe("100");
      expect(typeof result.proofEvidence.blockNumber).toBe("string");
      expect(result.proofEvidence.blockHash).toBe(hash);
      expect(result.proofEvidence.messageNonce).toBe(identity.nonce);
      expect(result.proofEvidence.messageDigest).toBe(identity.digest);
      // mintAmount is an integer string — no floating point
      expect(result.proofEvidence.mintAmount).toBe("99600000");
      expect(typeof result.proofEvidence.mintAmount).toBe("string");
      expect(result.proofEvidence.destinationChain).toBe("sepolia");
      // No credential or adapter address leaks
      const serialized = JSON.stringify(result.proofEvidence);
      expect(serialized).not.toMatch(/apiKey|secret|password|sourceAdapter|CARH6I/i);
    });

    it("does not set proofEvidence when delivery fails", async () => {
      const result = await inspectCctpDelivery(
        config,
        database(stored, [{ source_transfer_id: "40" }]),
        transfer,
        report,
      );
      expect(result.proofEvidence).toBeNull();
      expect(result.failure).toBe("message_already_delivered");
    });
  });
});

describe("CCTP proof check summary (describeCctpProofChecks)", () => {
  const candidateForwardTx = `0x${"aa".repeat(32)}` as const;
  const baseReport: RailReport = {
    status: "attested",
    railStatus: "complete",
    reference: null,
    attestedAt: null,
  };

  it("lists forward_tx_missing and message_missing when both are absent", () => {
    const summary = describeCctpProofChecks(baseReport, null);
    expect(summary.hasForwardTxHash).toBe(false);
    expect(summary.hasMessageBytes).toBe(false);
    expect(summary.hasMessageIdentity).toBe(false);
    expect(summary.missingChecks).toContain("forward_tx_missing");
    expect(summary.missingChecks).toContain("message_missing");
    expect(summary.evidence).toBeNull();
  });

  it("sets hasForwardTxHash when a valid 0x hash is present", () => {
    const summary = describeCctpProofChecks(
      { ...baseReport, forwardTxHash: candidateForwardTx },
      null,
    );
    expect(summary.hasForwardTxHash).toBe(true);
    expect(summary.missingChecks).not.toContain("forward_tx_missing");
  });

  it("sets hasMessageBytes when valid hex message bytes are present", () => {
    const summary = describeCctpProofChecks({ ...baseReport, messageBytes: raw }, null);
    expect(summary.hasMessageBytes).toBe(true);
    expect(summary.missingChecks).not.toContain("message_missing");
  });

  it("sets hasMessageIdentity only when both nonce and digest are present alongside message bytes", () => {
    const id = cctpMessageIdentity(raw);
    if (!id) throw new Error("Expected valid test message identity");
    const withIdentity = describeCctpProofChecks(
      { ...baseReport, messageBytes: raw, messageNonce: id.nonce, messageDigest: id.digest },
      null,
    );
    expect(withIdentity.hasMessageIdentity).toBe(true);

    const withoutNonce = describeCctpProofChecks(
      { ...baseReport, messageBytes: raw, messageDigest: id.digest },
      null,
    );
    expect(withoutNonce.hasMessageIdentity).toBe(false);
  });

  it("surfaces a secondary durable failure not already in missingChecks", () => {
    const summary = describeCctpProofChecks(
      { ...baseReport, forwardTxHash: candidateForwardTx, messageBytes: raw },
      "receipt_reverted",
    );
    expect(summary.missingChecks).toContain("receipt_reverted");
    expect(summary.missingChecks).not.toContain("forward_tx_missing");
    expect(summary.missingChecks).not.toContain("message_missing");
  });

  it("does not duplicate forward_tx_missing or message_missing when already in missingChecks", () => {
    const summary = describeCctpProofChecks(baseReport, "forward_tx_missing");
    const count = summary.missingChecks.filter((c) => c === "forward_tx_missing").length;
    expect(count).toBe(1);
  });

  it("produces an empty missingChecks list when all ingredients are present", () => {
    const id = cctpMessageIdentity(raw);
    if (!id) throw new Error("Expected valid test message identity");
    const summary = describeCctpProofChecks(
      {
        ...baseReport,
        forwardTxHash: candidateForwardTx,
        messageBytes: raw,
        messageNonce: id.nonce,
        messageDigest: id.digest,
      },
      null,
    );
    expect(summary.missingChecks).toHaveLength(0);
    expect(summary.hasForwardTxHash).toBe(true);
    expect(summary.hasMessageBytes).toBe(true);
    expect(summary.hasMessageIdentity).toBe(true);
  });

  it("never lets a provider status alone establish delivery — evidence is always null", () => {
    // Even with attested status and a known nonce, describeCctpProofChecks never sets evidence.
    const id = cctpMessageIdentity(raw);
    if (!id) throw new Error("Expected valid test message identity");
    const summary = describeCctpProofChecks(
      {
        ...baseReport,
        status: "attested",
        forwardTxHash: candidateForwardTx,
        messageBytes: raw,
        messageNonce: id.nonce,
        messageDigest: id.digest,
      },
      null,
    );
    // The only allowed source of evidence is inspectCctpDelivery with a live EVM receipt.
    expect(summary.evidence).toBeNull();
  });

  it("omits oversized or malformed message bytes from hasMessageBytes", () => {
    const oversized = describeCctpProofChecks(
      { ...baseReport, messageBytes: `0x${"ab".repeat(4097)}` },
      null,
    );
    expect(oversized.hasMessageBytes).toBe(false);

    const malformed = describeCctpProofChecks({ ...baseReport, messageBytes: "not-hex" }, null);
    expect(malformed.hasMessageBytes).toBe(false);
  });

  it("summary output contains only bounded public references, no credentials", () => {
    const summary: CctpProofCheckSummary = describeCctpProofChecks(
      {
        ...baseReport,
        forwardTxHash: candidateForwardTx,
        messageBytes: raw,
      },
      "amount_mismatch",
    );
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toMatch(/apiKey|token=|secret|password|authorization/i);
    // The failure code itself is bounded — it's one of the allow-listed enum values
    expect(summary.missingChecks).toContain("amount_mismatch");
  });
});

describe("CCTP pending transfer proof check regression", () => {
  const candidateForwardTx = `0x${"aa".repeat(32)}` as const;
  /**
   * Verifies that a report without forwardTxHash or messageBytes shows the right
   * missing checks without touching the database — mirrors what the pass does when
   * it records forward_tx_missing or message_missing without consuming check_failures.
   */
  it("forward_tx_missing is retryable and does not expose internal fields", () => {
    const summary = describeCctpProofChecks(
      {
        status: "attested",
        railStatus: "complete",
        reference: null,
        attestedAt: null,
        // No forwardTxHash
        messageBytes: raw,
      },
      null,
    );
    expect(summary.hasForwardTxHash).toBe(false);
    expect(summary.hasMessageBytes).toBe(true);
    expect(summary.missingChecks).toEqual(["forward_tx_missing"]);
    expect(summary.evidence).toBeNull();
  });

  it("message_missing is retryable and both forward_tx and message checks are shown", () => {
    const summary = describeCctpProofChecks(
      {
        status: "attested",
        railStatus: "complete",
        reference: null,
        attestedAt: null,
        forwardTxHash: candidateForwardTx,
        // No messageBytes
      },
      null,
    );
    expect(summary.hasForwardTxHash).toBe(true);
    expect(summary.hasMessageBytes).toBe(false);
    expect(summary.missingChecks).toEqual(["message_missing"]);
    expect(summary.evidence).toBeNull();
  });

  it("provider status 'attested' with both ingredients still yields evidence:null until receipt confirmed", () => {
    const id = cctpMessageIdentity(raw);
    if (!id) throw new Error("Expected valid test message identity");
    const summary = describeCctpProofChecks(
      {
        status: "attested",
        railStatus: "complete",
        reference: id.nonce,
        attestedAt: new Date(),
        forwardTxHash: candidateForwardTx,
        messageBytes: raw,
        messageNonce: id.nonce,
        messageDigest: id.digest,
      },
      null,
    );
    // All ingredients present — missingChecks is empty — but evidence is still null
    // because confirming delivery requires inspectCctpDelivery with an EVM receipt.
    expect(summary.missingChecks).toHaveLength(0);
    expect(summary.evidence).toBeNull();
  });
  it("persists the CCTP fee reconciliation as integer base units with the indexed delivery", async () => {
    let statement = "";
    let parameters: readonly unknown[] = [];
    const db: Queryable = {
      query(sql, values = []) {
        statement = sql;
        parameters = values;
        return Promise.resolve({ rows: [], rowCount: 1 });
      },
    };
    await writeInbound(
      db,
      {
        chainKey: "sepolia",
        block: 100n,
        txHash: `0x${"11".repeat(32)}`,
        logIndex: 4,
        observedAt: new Date("2026-11-19T09:00:00Z"),
      },
      {
        sourceTransferId: 7n,
        route: RouteKind.Cctp,
        sourceChain: "stellar-testnet",
        sourceNonce: 8n,
        railMessageId: nonce,
        recipient: expected.recipient,
        token: expected.token,
        amount: 99600000n,
        delivered: true,
        claimId: null,
        cctpFeeReconciliation: verified.feeReconciliation,
      },
    );
    expect(statement).toContain("cctp_actual_payout_destination_units");
    expect(parameters.slice(15)).toEqual(["997000000", "500000", "100000", "99600000"]);
  });
});
