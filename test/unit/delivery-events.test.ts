import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, stringToHex, type Hex } from "viem";
import {
  ITS_ABI,
  inspectDeliveryEvidence,
  matchingPayment,
  inspectPayment,
  normalizeVerificationDiagnostics,
  type DeliveryLog,
  type ExpectedDelivery,
} from "../../src/rails/axelar/events.js";
const recipient = "0x1111111111111111111111111111111111111111";
const its = "0x2222222222222222222222222222222222222222";
const token = "0x3333333333333333333333333333333333333333";
const tokenManager = "0x4444444444444444444444444444444444444444";
const commandId: Hex = `0x${"ab".repeat(32)}`;
const tokenId: Hex = `0x${"cd".repeat(32)}`;
const source = stringToHex("Gsource");
const expected: ExpectedDelivery = {
  its,
  token,
  tokenManager,
  commandId,
  tokenId,
  sourceChain: "stellar-2026-q1-2",
  sourceAddress: source,
  recipient,
  amount: 9970009n,
};
const received: DeliveryLog = {
  address: its,
  topics: encodeEventTopics({
    abi: ITS_ABI,
    eventName: "InterchainTransferReceived",
    args: { commandId, tokenId, destinationAddress: recipient },
  }) as [Hex, ...Hex[]],
  data: encodeAbiParameters(
    [{ type: "string" }, { type: "bytes" }, { type: "uint256" }, { type: "bytes32" }],
    [expected.sourceChain, source, expected.amount, `0x${"0".repeat(64)}`],
  ),
  logIndex: 2,
};
const paid: DeliveryLog = {
  address: token,
  topics: encodeEventTopics({
    abi: ITS_ABI,
    eventName: "Transfer",
    args: { from: tokenManager, to: recipient },
  }) as [Hex, ...Hex[]],
  data: encodeAbiParameters([{ type: "uint256" }], [expected.amount]),
  logIndex: 3,
};
describe("Destination delivery evidence", () => {
  it("requires both the exact ITS event and actual token payment", () => {
    expect(matchingPayment([received, paid], expected)).toBe(paid);
    expect(matchingPayment([received], expected)).toBeNull();
    expect(matchingPayment([paid], expected)).toBeNull();
  });
  it.each([
    "its",
    "token",
    "commandId",
    "tokenId",
    "sourceChain",
    "sourceAddress",
    "recipient",
    "tokenManager",
  ] as const)("rejects mismatched %s", (key) => {
    expect(matchingPayment([received, paid], { ...expected, [key]: "different" })).toBeNull();
  });
  it("rejects a payment of the wrong amount", () => {
    expect(
      matchingPayment([received, paid], { ...expected, amount: expected.amount + 1n }),
    ).toBeNull();
  });
  it("returns bounded structured diagnostics for invalid evidence", () => {
    const inspection = inspectPayment([received, paid], {
      ...expected,
      recipient: "0x4444444444444444444444444444444444444444",
    });
    expect(inspection.payment).toBeNull();
    expect(inspection.diagnostics).toEqual(
      expect.arrayContaining([
        {
          category: "recipient",
          expected: "0x4444444444444444444444444444444444444444",
          observed: recipient,
        },
      ]),
    );
  });
  it("does not lose a matching receipt event when another transfer shares the transaction", () => {
    const unrelated = { ...received, address: token as Hex };
    expect(matchingPayment([received, unrelated, paid], expected)).toBe(paid);
  });

  it("accepts the exact pair alongside a mismatched ITS event", () => {
    const unrelated = {
      ...received,
      data: encodeAbiParameters(
        [{ type: "string" }, { type: "bytes" }, { type: "uint256" }, { type: "bytes32" }],
        ["other-source", source, expected.amount + 1n, `0x${"0".repeat(64)}`],
      ),
    };
    expect(inspectPayment([unrelated, received, paid], expected)).toEqual({
      payment: paid,
      diagnostics: [],
    });
  });

  it("normalizes, bounds and sanitizes persisted diagnostic identifiers", () => {
    const result = normalizeVerificationDiagnostics([
      {
        category: "source_identity",
        expected: "public-source",
        observed: "https://user:password@provider/path?token=private-value",
      },
      { category: "amount", expected: "1", observed: "9".repeat(1000) },
      { category: "amount", expected: "ignored-duplicate", observed: "2" },
    ]);
    expect(result).toHaveLength(2);
    expect(JSON.stringify(result)).not.toMatch(/password|private-value|ignored-duplicate/);
    expect(result.every((item) => (item.observed?.length ?? 0) <= 128)).toBe(true);
  });

  it("reports receipt and payout evidence independently", () => {
    expect(inspectDeliveryEvidence([received], expected)).toEqual({
      received,
      payment: null,
    });
    expect(inspectDeliveryEvidence([paid], expected)).toEqual({
      received: null,
      payment: paid,
    });
  });

  it("never satisfies a transfer with another recipient's payment", () => {
    const otherRecipient = "0x5555555555555555555555555555555555555555";
    const otherPaid: DeliveryLog = {
      ...paid,
      topics: encodeEventTopics({
        abi: ITS_ABI,
        eventName: "Transfer",
        args: { from: tokenManager, to: otherRecipient },
      }) as [Hex, ...Hex[]],
      logIndex: 4,
    };
    expect(matchingPayment([received, otherPaid], expected)).toBeNull();
  });

  it("selects the exact pair among unrelated ITS candidates and payments", () => {
    const otherCommand: Hex = `0x${"ef".repeat(32)}`;
    const otherReceived: DeliveryLog = {
      ...received,
      topics: encodeEventTopics({
        abi: ITS_ABI,
        eventName: "InterchainTransferReceived",
        args: { commandId: otherCommand, tokenId, destinationAddress: recipient },
      }) as [Hex, ...Hex[]],
      logIndex: 1,
    };
    const otherPaid: DeliveryLog = {
      ...paid,
      topics: encodeEventTopics({
        abi: ITS_ABI,
        eventName: "Transfer",
        args: { from: tokenManager, to: "0x5555555555555555555555555555555555555555" },
      }) as [Hex, ...Hex[]],
      logIndex: 4,
    };
    expect(matchingPayment([otherReceived, received, otherPaid, paid], expected)).toBe(paid);
  });

  it("deduplicates replayed identical evidence deterministically", () => {
    expect(matchingPayment([received, paid, { ...received }, { ...paid }], expected)).toBe(paid);
  });

  it("remains unverified when exact candidates conflict", () => {
    expect(matchingPayment([received, { ...received, logIndex: 5 }, paid], expected)).toBeNull();
    expect(matchingPayment([received, paid, { ...paid, logIndex: 6 }], expected)).toBeNull();
    const inspection = inspectPayment([received, { ...received, logIndex: 5 }, paid], expected);
    expect(inspection.payment).toBeNull();
    expect(inspection.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "payment_evidence",
          observed: "2 receipts and 1 payments",
        }),
      ]),
    );
  });
});
