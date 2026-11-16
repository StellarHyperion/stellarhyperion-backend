import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, stringToHex, type Hex } from "viem";
import {
  AXELAR_GAS_SERVICE_ABI,
  ITS_ABI,
  decodeAxelarGasServiceLog,
  matchingPayment,
  type DeliveryLog,
  type ExpectedDelivery,
} from "../../src/rails/axelar/events.js";
const recipient = "0x1111111111111111111111111111111111111111";
const its = "0x2222222222222222222222222222222222222222";
const token = "0x3333333333333333333333333333333333333333";
const commandId: Hex = `0x${"ab".repeat(32)}`;
const tokenId: Hex = `0x${"cd".repeat(32)}`;
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
    args: { from: its, to: recipient },
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

  it("decodes public Axelar gas-service events with exact amounts and refund recipients without satisfying delivery", () => {
    const gasService: Hex = "0xbE406F0189A0B4cf3A05C286473D23791Dd44Cc6";
    const checksummedRefund = "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B";
    const enclosingTx = `0x${"77".repeat(32)}`;
    const sourceTxRef: Hex = `0x${"88".repeat(32)}`;
    const payloadHash: Hex = `0x${"99".repeat(32)}`;
    const exactNativeWei = 123456789012345678901234567890n;

    const nativePaidLog: DeliveryLog = {
      address: gasService,
      topics: encodeEventTopics({
        abi: AXELAR_GAS_SERVICE_ABI,
        eventName: "NativeGasPaidForContractCall",
        args: {
          sourceAddress: recipient,
          payloadHash,
        },
      }) as [Hex, ...Hex[]],
      data: encodeAbiParameters(
        [{ type: "string" }, { type: "string" }, { type: "uint256" }, { type: "address" }],
        ["ethereum-sepolia", checksummedRefund, exactNativeWei, checksummedRefund],
      ),
      logIndex: 0,
    };

    const nativeAddedLog: DeliveryLog = {
      address: gasService,
      topics: encodeEventTopics({
        abi: AXELAR_GAS_SERVICE_ABI,
        eventName: "NativeGasAdded",
        args: {
          txHash: sourceTxRef,
          logIndex: 4n,
        },
      }) as [Hex, ...Hex[]],
      data: encodeAbiParameters(
        [{ type: "uint256" }, { type: "address" }],
        [50000000000000000n, checksummedRefund],
      ),
      logIndex: 1,
    };

    const nativeRefundLog: DeliveryLog = {
      address: gasService,
      topics: encodeEventTopics({
        abi: AXELAR_GAS_SERVICE_ABI,
        eventName: "Refunded",
        args: {
          txHash: sourceTxRef,
          logIndex: 4n,
        },
      }) as [Hex, ...Hex[]],
      data: encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "uint256" }],
        [checksummedRefund, "0x0000000000000000000000000000000000000000", 25000000000000000n],
      ),
      logIndex: 2,
    };

    const paidDecoded = decodeAxelarGasServiceLog(nativePaidLog, gasService, enclosingTx);
    expect(paidDecoded).toEqual({
      eventKind: "gas_paid",
      isNative: true,
      gasToken: null,
      amount: exactNativeWei,
      sender: recipient,
      refundAddress: checksummedRefund,
      sourceTxRef: enclosingTx,
      sourceLogIndexRef: null,
      messageId: null,
      payloadHash,
      logIndex: 0,
    });

    const addedDecoded = decodeAxelarGasServiceLog(nativeAddedLog, gasService, enclosingTx);
    expect(addedDecoded?.eventKind).toBe("gas_added");
    expect(addedDecoded?.refundAddress).toBe(checksummedRefund);
    expect(addedDecoded?.sourceTxRef).toBe(sourceTxRef);
    expect(addedDecoded?.sourceLogIndexRef).toBe(4n);

    const refundDecoded = decodeAxelarGasServiceLog(nativeRefundLog, gasService, enclosingTx);
    expect(refundDecoded).toEqual({
      eventKind: "refunded",
      isNative: true,
      gasToken: null,
      amount: 25000000000000000n,
      sender: null,
      refundAddress: checksummedRefund,
      sourceTxRef,
      sourceLogIndexRef: 4n,
      messageId: null,
      payloadHash: null,
      logIndex: 2,
    });

    // Gas logs in a receipt can never satisfy destination token payment verification.
    expect(
      matchingPayment([received, nativePaidLog, nativeAddedLog, nativeRefundLog], expected),
    ).toBeNull();
  });
});
