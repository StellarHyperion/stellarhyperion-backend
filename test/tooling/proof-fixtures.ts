import { StrKey } from "@stellar/stellar-sdk";
import { toHex } from "@hyperion/protocol";
import { encodeAbiParameters, encodeEventTopics, hexToBytes, stringToHex, type Hex } from "viem";
import {
  CCTP_RECEIPT_ABI,
  verifiedCctpMessage,
  type ExpectedCctpTransfer,
} from "../../src/rails/cctp/events.js";
import { ITS_ABI, type DeliveryLog, type ExpectedDelivery } from "../../src/rails/axelar/events.js";

// Independently encoded source message and receipt events. No provider status establishes proof.
export function cctpProofFixture() {
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

  return { expected, raw, received, paid };
}

export function itsProofFixture(service: Hex = "0x2222222222222222222222222222222222222222") {
  const recipient = "0x1111111111111111111111111111111111111111";
  const its = service;
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

  return { expected, received, paid };
}
