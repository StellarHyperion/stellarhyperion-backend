import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, stringToHex, type Hex } from "viem";
import {
  ITS_ABI,
  matchItsCandidateInReceipt,
  matchingPayment,
  type DeliveryLog,
  type ExpectedDelivery,
} from "../../src/rails/axelar/events.js";

const recipient = "0x1111111111111111111111111111111111111111";
const otherRecipient = "0x4444444444444444444444444444444444444444";
const its = "0x2222222222222222222222222222222222222222";
const token = "0x3333333333333333333333333333333333333333";
const otherToken = "0x5555555555555555555555555555555555555555";
const commandId: Hex = `0x${"ab".repeat(32)}`;
const otherCommandId: Hex = `0x${"ef".repeat(32)}`;
const tokenId: Hex = `0x${"cd".repeat(32)}`;
const otherTokenId: Hex = `0x${"99".repeat(32)}`;
const source = stringToHex("Gsource");

const expected: ExpectedDelivery = {
  its,
  token,
  commandId,
  tokenId,
  sourceChain: "stellar-2026-q1-2",
  sourceAddress: source,
  recipient,
  amount: 9970009n,
};

function makeReceivedLog(
  overrides: Partial<{
    address: Hex;
    commandId: Hex;
    tokenId: Hex;
    sourceChain: string;
    sourceAddress: Hex;
    recipient: Hex;
    amount: bigint;
    logIndex: number | null;
  }> = {},
): DeliveryLog {
  const cmd = overrides.commandId ?? commandId;
  const tid = overrides.tokenId ?? tokenId;
  const dest = overrides.recipient ?? recipient;
  const srcChain = overrides.sourceChain ?? expected.sourceChain;
  const srcAddr = overrides.sourceAddress ?? source;
  const amt = overrides.amount ?? expected.amount;
  return {
    address: overrides.address ?? its,
    topics: encodeEventTopics({
      abi: ITS_ABI,
      eventName: "InterchainTransferReceived",
      args: { commandId: cmd, tokenId: tid, destinationAddress: dest },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters(
      [{ type: "string" }, { type: "bytes" }, { type: "uint256" }, { type: "bytes32" }],
      [srcChain, srcAddr, amt, `0x${"0".repeat(64)}`],
    ),
    logIndex: overrides.logIndex === undefined ? 2 : overrides.logIndex,
  };
}

function makeTransferLog(
  overrides: Partial<{
    tokenAddress: Hex;
    from: Hex;
    to: Hex;
    amount: bigint;
    logIndex: number | null;
  }> = {},
): DeliveryLog {
  return {
    address: overrides.tokenAddress ?? token,
    topics: encodeEventTopics({
      abi: ITS_ABI,
      eventName: "Transfer",
      args: {
        from: overrides.from ?? its,
        to: overrides.to ?? recipient,
      },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: "uint256" }], [overrides.amount ?? expected.amount]),
    logIndex: overrides.logIndex === undefined ? 3 : overrides.logIndex,
  };
}

const received = makeReceivedLog({ logIndex: 2 });
const paid = makeTransferLog({ logIndex: 3 });

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
  ] as const)("rejects mismatched %s", (key) => {
    expect(matchingPayment([received, paid], { ...expected, [key]: "different" })).toBeNull();
  });

  it("rejects a payment of the wrong amount", () => {
    expect(
      matchingPayment([received, paid], { ...expected, amount: expected.amount + 1n }),
    ).toBeNull();
  });

  it("does not lose a matching receipt event when another transfer shares the transaction", () => {
    const unrelated = { ...received, address: token as Hex };
    expect(matchingPayment([received, unrelated, paid], expected)).toBe(paid);
  });

  it("never lets another recipient's payment or self-transfer satisfy the transfer", () => {
    const otherPaid = makeTransferLog({ to: otherRecipient, logIndex: 4 });
    const otherReceived = makeReceivedLog({
      commandId: otherCommandId,
      recipient: otherRecipient,
      logIndex: 5,
    });

    // Target ITS command is present, but the only ERC-20 payment went to another recipient.
    expect(matchingPayment([received, otherPaid, otherReceived], expected)).toBeNull();

    // Self-transfer from recipient to recipient cannot masquerade as an inbound bridge payout.
    const selfTransfer = makeTransferLog({ from: recipient, to: recipient, logIndex: 6 });
    expect(matchingPayment([received, selfTransfer], expected)).toBeNull();

    // Payment on a different token contract cannot satisfy expected.token.
    const wrongTokenPaid = makeTransferLog({ tokenAddress: otherToken, logIndex: 7 });
    expect(matchingPayment([received, wrongTokenPaid], expected)).toBeNull();

    // Target commandId carries wrong tokenId while another command in the receipt has expected tokenId.
    const targetWrongTokenId = makeReceivedLog({
      commandId,
      tokenId: otherTokenId,
      logIndex: 1,
    });
    const otherRightTokenId = makeReceivedLog({
      commandId: otherCommandId,
      tokenId,
      recipient: otherRecipient,
      logIndex: 2,
    });
    expect(matchingPayment([targetWrongTokenId, otherRightTokenId, paid], expected)).toBeNull();

    // When both recipients are genuinely paid in a shared transaction, each matches its own payment.
    const sharedLogs = [otherPaid, otherReceived, paid, received];
    expect(matchingPayment(sharedLogs, expected)).toBe(paid);
    expect(
      matchingPayment(sharedLogs, {
        ...expected,
        commandId: otherCommandId,
        recipient: otherRecipient,
      }),
    ).toBe(otherPaid);
  });

  it("handles duplicate matching evidence and non-overlapping same-tuple batches deterministically", () => {
    const duplicateReceived = makeReceivedLog({ logIndex: 2 });
    const duplicatePaid = makeTransferLog({ logIndex: 3 });

    // Exact duplicate log entries collapse to the first canonical occurrence.
    expect(matchingPayment([received, duplicateReceived, paid, duplicatePaid], expected)).toBe(
      paid,
    );

    // Reversed input array order still canonicalizes by logIndex deterministically.
    expect(matchingPayment([paid, received], expected)).toBe(paid);

    // Two distinct ITS commands in one receipt paying the exact same (tokenId, recipient, amount)
    // in non-overlapping execution frames pair deterministically by logIndex span.
    const paidFirst = makeTransferLog({ logIndex: 10 });
    const receivedFirst = makeReceivedLog({ commandId, logIndex: 11 });
    const paidSecond = makeTransferLog({ logIndex: 20 });
    const receivedSecond = makeReceivedLog({ commandId: otherCommandId, logIndex: 21 });

    const forwardOrder = [paidFirst, receivedFirst, paidSecond, receivedSecond];
    const scrambledOrder = [receivedSecond, paidFirst, paidSecond, receivedFirst];

    expect(matchingPayment(forwardOrder, expected)).toBe(paidFirst);
    expect(matchingPayment(scrambledOrder, expected)).toBe(paidFirst);
    expect(matchingPayment(forwardOrder, { ...expected, commandId: otherCommandId })).toBe(
      paidSecond,
    );
    expect(matchingPayment(scrambledOrder, { ...expected, commandId: otherCommandId })).toBe(
      paidSecond,
    );
  });

  it("leaves ambiguous or conflicting candidates unverified", () => {
    // 1. Conflicting InterchainTransferReceived events with the same commandId.
    const conflictingCmd = makeReceivedLog({
      commandId,
      amount: expected.amount + 500n,
      logIndex: 8,
    });
    const conflictOutcome = matchItsCandidateInReceipt([received, conflictingCmd, paid], expected);
    expect(conflictOutcome.status).toBe("conflicting");
    expect(matchingPayment([received, conflictingCmd, paid], expected)).toBeNull();

    // 2. Same commandId emitted at two distinct logIndex positions.
    const secondSameCmd = makeReceivedLog({ commandId, logIndex: 9 });
    expect(matchItsCandidateInReceipt([received, secondSameCmd, paid], expected).status).toBe(
      "conflicting",
    );

    // 3. Two distinct ERC-20 Transfer logs for a single ITS reception.
    const extraPayment = makeTransferLog({ logIndex: 9 });
    const twoPaymentsOneCmd = matchItsCandidateInReceipt([received, paid, extraPayment], expected);
    expect(twoPaymentsOneCmd.status).toBe("ambiguous");
    expect(matchingPayment([received, paid, extraPayment], expected)).toBeNull();

    // 4. Two competing ITS receptions for (tokenId, recipient, amount) with only one Transfer log.
    const competingCmd = makeReceivedLog({ commandId: otherCommandId, logIndex: 5 });
    const twoCmdsOnePayment = matchItsCandidateInReceipt([received, paid, competingCmd], expected);
    expect(twoCmdsOnePayment.status).toBe("ambiguous");
    expect(matchingPayment([received, paid, competingCmd], expected)).toBeNull();

    // 5. Interleaved spans where call frames overlap ([received1 @ 2, received2 @ 3, paid1 @ 4, paid2 @ 5]).
    const rec1 = makeReceivedLog({ commandId, logIndex: 2 });
    const rec2 = makeReceivedLog({ commandId: otherCommandId, logIndex: 3 });
    const pay1 = makeTransferLog({ logIndex: 4 });
    const pay2 = makeTransferLog({ logIndex: 5 });
    expect(matchItsCandidateInReceipt([rec1, rec2, pay1, pay2], expected).status).toBe("ambiguous");
    expect(matchingPayment([rec1, rec2, pay1, pay2], expected)).toBeNull();
  });
});
