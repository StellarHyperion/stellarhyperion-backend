import { StrKey } from "@stellar/stellar-sdk";
import {
  assertSupportedBurn,
  assertSupportedMessage,
  cctpBody,
  parseCctpBurnMessage,
  parseCctpMessage,
  toEvmAddress,
  toHex,
} from "@hyperion/protocol";
import { decodeEventLog, keccak256, parseAbi, type Hex } from "viem";
import type { DeliveryLog } from "../axelar/events.js";

// Source: circlefin/evm-cctp-contracts/src/v2/MessageTransmitterV2.sol.
export const CCTP_RECEIPT_ABI = parseAbi([
  "event MessageReceived(address indexed caller,uint32 sourceDomain,bytes32 indexed nonce,bytes32 sender,uint32 indexed finalityThresholdExecuted,bytes messageBody)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);

export const CCTP_CONTRACT_IDENTITY_ABI = parseAbi([
  "function localDomain() view returns (uint32)",
  "function version() view returns (uint32)",
  "function localMessageTransmitter() view returns (address)",
  "function localMinter() view returns (address)",
  "function remoteTokenMessengers(uint32 domain) view returns (bytes32)",
  "function localTokenMessenger() view returns (address)",
  "function getLocalToken(uint32 remoteDomain, bytes32 remoteToken) view returns (address)",
  "function decimals() view returns (uint8)",
]);

export const EIP1967_IMPLEMENTATION_SLOT: Hex =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const ZEPPELINOS_IMPLEMENTATION_SLOT: Hex =
  "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";

export type CctpContractRole =
  "token_messenger_v2" | "message_transmitter_v2" | "token_minter_v2" | "usdc";

export type CctpContractIssueKind =
  | "empty_code"
  | "missing_implementation_code"
  | "code_hash_mismatch"
  | "unexpected_upgrade"
  | "domain_mismatch"
  | "version_mismatch"
  | "peer_messenger_mismatch"
  | "wiring_mismatch"
  | "token_mapping_mismatch"
  | "token_decimals_mismatch"
  | "wiring_read_failed";

export interface CctpContractIssue {
  readonly role: CctpContractRole;
  readonly kind: CctpContractIssueKind;
  readonly expected: string | null;
  readonly observed: string | null;
  readonly detail: string;
}

export interface CctpContractObservation {
  readonly role: CctpContractRole;
  readonly address: Hex;
  readonly codeHash: Hex | null;
  readonly implementationAddress: Hex | null;
  readonly implementationCodeHash: Hex | null;
}

export interface CctpExpectedCodeIdentity {
  readonly address?: Hex | undefined;
  readonly codeHash?: Hex | undefined;
  readonly implementationAddress?: Hex | null | undefined;
  readonly implementationCodeHash?: Hex | null | undefined;
}

export interface CctpBaselineCodeIdentity {
  readonly address: string;
  readonly codeHash: string;
  readonly implementationAddress: string | null;
  readonly implementationCodeHash: string | null;
}

export interface CctpWiringSnapshot {
  readonly transmitterLocalDomain?: number | null | undefined;
  readonly transmitterVersion?: number | null | undefined;
  readonly messengerLocalTransmitter?: string | null | undefined;
  readonly messengerLocalMinter?: string | null | undefined;
  readonly messengerRemotePeer?: string | null | undefined;
  readonly minterLocalMessenger?: string | null | undefined;
  readonly minterLocalToken?: string | null | undefined;
  readonly usdcDecimals?: number | null | undefined;
  readonly readErrors?: Partial<Record<CctpContractRole, string>> | undefined;
}

export type CctpIdentityVerdict = "verified" | "mismatch" | "unexpected_upgrade";

export interface CctpContractIdentityDiagnostic {
  readonly destinationChain: string;
  readonly chainId: number;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly txHash: Hex;
  readonly verdict: CctpIdentityVerdict;
  readonly issues: readonly CctpContractIssue[];
  readonly observations: Readonly<Record<CctpContractRole, CctpContractObservation>>;
}

export interface ExpectedCctpTransfer {
  sourceToken: string;
  sourceAdapter: string;
  sourceMessenger: string;
  destinationDomain: number;
  destinationMessenger: string;
  transmitter: string;
  minter?: string | undefined;
  token: string;
  recipient: string;
  sourceAmount: bigint;
}

export function parseSlotAddress(slotValue: Hex | undefined): Hex | null {
  if (!slotValue || !/^0x[0-9a-fA-F]{64}$/.test(slotValue)) return null;
  const tail = slotValue.slice(-40).toLowerCase();
  if (/^0{40}$/.test(tail)) return null;
  return `0x${tail}`;
}

export function codeHashOf(bytecode: Hex | undefined): Hex | null {
  if (!bytecode || bytecode === "0x" || bytecode.length <= 2) return null;
  return keccak256(bytecode);
}

export function evaluateCctpContractIdentity(input: {
  readonly destinationChain: string;
  readonly chainId: number;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly txHash: Hex;
  readonly expected: ExpectedCctpTransfer & { readonly minter: string };
  readonly observations: Readonly<Record<CctpContractRole, CctpContractObservation>>;
  readonly wiring: CctpWiringSnapshot;
  readonly pinned?: Partial<Record<CctpContractRole, CctpExpectedCodeIdentity>> | undefined;
  readonly baselines?: Partial<Record<CctpContractRole, CctpBaselineCodeIdentity>> | undefined;
}): CctpContractIdentityDiagnostic {
  const issues: CctpContractIssue[] = [];
  let sawUnexpectedUpgrade = false;

  const roles: readonly CctpContractRole[] = [
    "token_messenger_v2",
    "message_transmitter_v2",
    "token_minter_v2",
    "usdc",
  ];

  for (const role of roles) {
    const obs = input.observations[role];
    if (obs.codeHash === null) {
      issues.push({
        role,
        kind: "empty_code",
        expected: "non-empty contract bytecode",
        observed: null,
        detail: `${role} at ${obs.address} has no deployed bytecode at block ${input.blockNumber.toString()}`,
      });
    }
    if (obs.implementationAddress !== null && obs.implementationCodeHash === null) {
      issues.push({
        role,
        kind: "missing_implementation_code",
        expected: "non-empty proxy implementation bytecode",
        observed: obs.implementationAddress,
        detail: `${role} proxy implementation ${obs.implementationAddress} has empty bytecode at block ${input.blockNumber.toString()}`,
      });
    }

    const pin = input.pinned?.[role];
    if (pin?.address && pin.address.toLowerCase() !== obs.address.toLowerCase()) {
      issues.push({
        role,
        kind: "code_hash_mismatch",
        expected: pin.address.toLowerCase(),
        observed: obs.address.toLowerCase(),
        detail: `${role} address did not match expected configuration`,
      });
    }
    if (pin?.codeHash && obs.codeHash?.toLowerCase() !== pin.codeHash.toLowerCase()) {
      issues.push({
        role,
        kind: "code_hash_mismatch",
        expected: pin.codeHash.toLowerCase(),
        observed: obs.codeHash?.toLowerCase() ?? null,
        detail: `${role} runtime codehash did not match expected hash`,
      });
    }
    if (
      pin?.implementationAddress !== undefined &&
      (pin.implementationAddress?.toLowerCase() ?? null) !==
        (obs.implementationAddress?.toLowerCase() ?? null)
    ) {
      sawUnexpectedUpgrade = true;
      issues.push({
        role,
        kind: "unexpected_upgrade",
        expected: pin.implementationAddress?.toLowerCase() ?? null,
        observed: obs.implementationAddress?.toLowerCase() ?? null,
        detail: `${role} proxy implementation differed from reviewed address`,
      });
    }
    if (
      pin?.implementationCodeHash !== undefined &&
      (pin.implementationCodeHash?.toLowerCase() ?? null) !==
        (obs.implementationCodeHash?.toLowerCase() ?? null)
    ) {
      sawUnexpectedUpgrade = true;
      issues.push({
        role,
        kind: "unexpected_upgrade",
        expected: pin.implementationCodeHash?.toLowerCase() ?? null,
        observed: obs.implementationCodeHash?.toLowerCase() ?? null,
        detail: `${role} proxy implementation codehash differed from reviewed hash`,
      });
    }

    const baseline = input.baselines?.[role];
    if (baseline && obs.codeHash !== null) {
      const addrChanged = baseline.address.toLowerCase() !== obs.address.toLowerCase();
      const codeChanged = baseline.codeHash.toLowerCase() !== obs.codeHash.toLowerCase();
      const implAddrChanged =
        (baseline.implementationAddress?.toLowerCase() ?? null) !==
        (obs.implementationAddress?.toLowerCase() ?? null);
      const implHashChanged =
        (baseline.implementationCodeHash?.toLowerCase() ?? null) !==
        (obs.implementationCodeHash?.toLowerCase() ?? null);

      if (addrChanged || codeChanged || implAddrChanged || implHashChanged) {
        sawUnexpectedUpgrade = true;
        issues.push({
          role,
          kind: "unexpected_upgrade",
          expected: baseline.implementationCodeHash ?? baseline.codeHash,
          observed: obs.implementationCodeHash ?? obs.codeHash,
          detail: `${role} changed code or proxy implementation relative to baseline`,
        });
      }
    }

    const readErr = input.wiring.readErrors?.[role];
    if (readErr !== undefined) {
      issues.push({
        role,
        kind: "wiring_read_failed",
        expected: "readable contract state at proof block",
        observed: null,
        detail: readErr,
      });
    }
  }

  const expectedPeerWord = toHex(
    StrKey.decodeContract(input.expected.sourceMessenger),
  ).toLowerCase();

  if (
    input.wiring.transmitterLocalDomain !== undefined &&
    input.wiring.transmitterLocalDomain !== null &&
    input.wiring.transmitterLocalDomain !== input.expected.destinationDomain
  ) {
    issues.push({
      role: "message_transmitter_v2",
      kind: "domain_mismatch",
      expected: String(input.expected.destinationDomain),
      observed: String(input.wiring.transmitterLocalDomain),
      detail: "MessageTransmitterV2 localDomain did not match destination CCTP domain",
    });
  }

  if (
    input.wiring.transmitterVersion !== undefined &&
    input.wiring.transmitterVersion !== null &&
    input.wiring.transmitterVersion !== 1
  ) {
    issues.push({
      role: "message_transmitter_v2",
      kind: "version_mismatch",
      expected: "1",
      observed: String(input.wiring.transmitterVersion),
      detail: "MessageTransmitterV2 version did not match CCTP v2 wire version",
    });
  }

  if (
    typeof input.wiring.messengerLocalTransmitter === "string" &&
    input.wiring.messengerLocalTransmitter.toLowerCase() !==
      input.expected.transmitter.toLowerCase()
  ) {
    issues.push({
      role: "token_messenger_v2",
      kind: "wiring_mismatch",
      expected: input.expected.transmitter.toLowerCase(),
      observed: input.wiring.messengerLocalTransmitter.toLowerCase(),
      detail: "TokenMessengerV2 localMessageTransmitter did not match expected transmitter",
    });
  }

  if (
    typeof input.wiring.messengerLocalMinter === "string" &&
    input.wiring.messengerLocalMinter.toLowerCase() !== input.expected.minter.toLowerCase()
  ) {
    issues.push({
      role: "token_messenger_v2",
      kind: "wiring_mismatch",
      expected: input.expected.minter.toLowerCase(),
      observed: input.wiring.messengerLocalMinter.toLowerCase(),
      detail: "TokenMessengerV2 localMinter did not match expected TokenMinterV2",
    });
  }

  if (
    typeof input.wiring.messengerRemotePeer === "string" &&
    input.wiring.messengerRemotePeer.toLowerCase() !== expectedPeerWord
  ) {
    issues.push({
      role: "token_messenger_v2",
      kind: "peer_messenger_mismatch",
      expected: expectedPeerWord,
      observed: input.wiring.messengerRemotePeer.toLowerCase(),
      detail: "TokenMessengerV2 remoteTokenMessengers(27) did not match Stellar CCTP messenger",
    });
  }

  if (
    typeof input.wiring.minterLocalMessenger === "string" &&
    input.wiring.minterLocalMessenger.toLowerCase() !==
      input.expected.destinationMessenger.toLowerCase()
  ) {
    issues.push({
      role: "token_minter_v2",
      kind: "wiring_mismatch",
      expected: input.expected.destinationMessenger.toLowerCase(),
      observed: input.wiring.minterLocalMessenger.toLowerCase(),
      detail: "TokenMinterV2 localTokenMessenger did not match expected TokenMessengerV2",
    });
  }

  if (
    typeof input.wiring.minterLocalToken === "string" &&
    input.wiring.minterLocalToken.toLowerCase() !== input.expected.token.toLowerCase()
  ) {
    issues.push({
      role: "token_minter_v2",
      kind: "token_mapping_mismatch",
      expected: input.expected.token.toLowerCase(),
      observed: input.wiring.minterLocalToken.toLowerCase(),
      detail: "TokenMinterV2 getLocalToken(27, sourceToken) did not match destination USDC",
    });
  }

  if (
    input.wiring.usdcDecimals !== undefined &&
    input.wiring.usdcDecimals !== null &&
    input.wiring.usdcDecimals !== 6
  ) {
    issues.push({
      role: "usdc",
      kind: "token_decimals_mismatch",
      expected: "6",
      observed: String(input.wiring.usdcDecimals),
      detail: "Destination USDC decimals did not equal 6",
    });
  }

  const verdict: CctpIdentityVerdict =
    issues.length === 0 ? "verified" : sawUnexpectedUpgrade ? "unexpected_upgrade" : "mismatch";

  return {
    destinationChain: input.destinationChain,
    chainId: input.chainId,
    blockNumber: input.blockNumber,
    blockHash: input.blockHash,
    txHash: input.txHash,
    verdict,
    issues,
    observations: input.observations,
  };
}

export function verifiedCctpMessage(raw: Hex, expected: ExpectedCctpTransfer) {
  const message = parseCctpMessage(raw);
  const body = cctpBody(raw);
  const burn = parseCctpBurnMessage(body);
  assertSupportedMessage(message);
  assertSupportedBurn(burn);
  const word = (address: string) => `0x${address.slice(2).padStart(64, "0")}`.toLowerCase();
  if (
    message.sourceDomain !== 27 ||
    message.destinationDomain !== expected.destinationDomain ||
    message.sender.toLowerCase() !==
      toHex(StrKey.decodeContract(expected.sourceMessenger)).toLowerCase() ||
    message.recipient.toLowerCase() !== word(expected.destinationMessenger) ||
    burn.messageSender.toLowerCase() !==
      toHex(StrKey.decodeContract(expected.sourceAdapter)).toLowerCase() ||
    burn.burnToken.toLowerCase() !==
      toHex(StrKey.decodeContract(expected.sourceToken)).toLowerCase() ||
    toEvmAddress(burn.mintRecipient).toLowerCase() !== expected.recipient.toLowerCase() ||
    expected.sourceAmount % 10n !== 0n ||
    burn.amount !== expected.sourceAmount / 10n ||
    burn.feeExecuted > burn.maxFee ||
    burn.feeExecuted < 0n ||
    burn.feeExecuted >= burn.amount ||
    message.finalityThresholdExecuted < 2000
  )
    return null;
  return { message, body: toHex(body), amount: burn.amount - burn.feeExecuted };
}

export function matchingCctpPayment<T extends DeliveryLog>(
  logs: readonly T[],
  raw: Hex,
  expected: ExpectedCctpTransfer,
): T | null {
  const verified = verifiedCctpMessage(raw, expected);
  if (!verified) return null;
  let received = false;
  let payment: T | null = null;
  for (const log of logs) {
    try {
      const event = decodeEventLog({ abi: CCTP_RECEIPT_ABI, topics: log.topics, data: log.data });
      if (
        event.eventName === "MessageReceived" &&
        log.address.toLowerCase() === expected.transmitter.toLowerCase()
      ) {
        received ||=
          event.args.sourceDomain === 27 &&
          event.args.nonce.toLowerCase() === verified.message.nonce.toLowerCase() &&
          event.args.sender.toLowerCase() === verified.message.sender.toLowerCase() &&
          event.args.finalityThresholdExecuted === verified.message.finalityThresholdExecuted &&
          event.args.messageBody.toLowerCase() === verified.body.toLowerCase();
      }
      if (
        event.eventName === "Transfer" &&
        log.address.toLowerCase() === expected.token.toLowerCase() &&
        /^0x0{40}$/.test(event.args.from) &&
        event.args.to.toLowerCase() === expected.recipient.toLowerCase() &&
        event.args.value === verified.amount
      )
        payment = log;
    } catch {
      /* Unrelated receipt events do not establish this transfer's delivery. */
    }
  }
  return received ? payment : null;
}
