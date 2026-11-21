import { StrKey } from "@stellar/stellar-sdk";
import {
  assertSupportedBurn,
  assertSupportedMessage,
  cctpBody,
  parseCctpBurnMessage,
  parseCctpMessage,
  toHex,
  toEvmAddress,
} from "@hyperion/protocol";
import {
  decodeEventLog,
  encodeAbiParameters,
  keccak256,
  parseAbi,
  stringToHex,
  type Hex,
} from "viem";
import type { DeliveryLog } from "../axelar/events.js";
import type { CctpFeeReconciliation, CctpVerificationFailure } from "../types.js";

// Source: circlefin/evm-cctp-contracts/src/v2/MessageTransmitterV2.sol.
export const CCTP_RECEIPT_ABI = parseAbi([
  "event MessageReceived(address indexed caller,uint32 sourceDomain,bytes32 indexed nonce,bytes32 sender,uint32 indexed finalityThresholdExecuted,bytes messageBody)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
export interface ExpectedCctpTransfer {
  sourceToken: string;
  sourceAdapter: string;
  sourceMessenger: string;
  destinationDomain: number;
  destinationMessenger: string;
  transmitter: string;
  token: string;
  recipient: string;
  sourceAmount: bigint;
}

export type CctpContractRole = "token_messenger_v2" | "message_transmitter_v2" | "usdc";

export interface CctpContractObservation {
  readonly role: CctpContractRole;
  readonly address: string;
  readonly codeHash: Hex;
}

export interface CctpContractIdentityDiagnostic {
  readonly destinationChain: string;
  readonly chainId: number;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly txHash: Hex;
  readonly verdict: "verified" | "mismatch" | "unexpected_upgrade";
  readonly issues: readonly string[];
  readonly observations: readonly CctpContractObservation[];
}

export function codeHashOf(code: Hex | undefined): Hex {
  return keccak256(code ?? "0x");
}

export const EIP1967_IMPLEMENTATION_SLOT: Hex =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const USDC_IMPLEMENTATION_SLOT = keccak256(
  stringToHex("org.zeppelinos.proxy.implementation"),
);

export function proxyImplementationAddress(value: Hex | undefined): Hex | null {
  if (value === undefined || !/^0x0{24}[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error("Contract implementation storage is unavailable or malformed.");
  }
  const address = `0x${value.slice(-40).toLowerCase()}` as const;
  return /^0x0{40}$/.test(address) ? null : address;
}

/** Keep direct-contract hashes unchanged; bind known proxies to implementation address and code. */
export function cctpContractFingerprint(
  code: Hex | undefined,
  implementations: readonly {
    readonly slot: Hex;
    readonly address: Hex;
    readonly code: Hex | undefined;
  }[],
): Hex {
  if (
    code === undefined ||
    code === "0x" ||
    implementations.some((entry) => entry.code === undefined || entry.code === "0x")
  )
    return codeHashOf(undefined);
  if (implementations.length === 0) return codeHashOf(code);
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32[]" }, { type: "address[]" }, { type: "bytes32[]" }],
      [
        codeHashOf(code),
        implementations.map((entry) => entry.slot),
        implementations.map((entry) => entry.address),
        implementations.map((entry) => codeHashOf(entry.code)),
      ],
    ),
  );
}

/** Compare destination contract code at the canonical proof block with durable baselines. */
export function evaluateCctpContractIdentity(input: {
  readonly destinationChain: string;
  readonly chainId: number;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly txHash: Hex;
  readonly observations: readonly CctpContractObservation[];
  readonly baselines: ReadonlyMap<CctpContractRole, { address: string; codeHash: string }>;
}): CctpContractIdentityDiagnostic {
  const issues: string[] = [];
  let unexpectedUpgrade = false;
  for (const observation of input.observations) {
    const baseline = input.baselines.get(observation.role);
    if (observation.codeHash === codeHashOf(undefined))
      issues.push(`${observation.role}:empty_code`);
    if (baseline === undefined) {
      issues.push(`${observation.role}:baseline_missing`);
      continue;
    }
    if (baseline.address.toLowerCase() !== observation.address.toLowerCase()) {
      issues.push(`${observation.role}:address_mismatch`);
    } else if (baseline.codeHash.toLowerCase() !== observation.codeHash.toLowerCase()) {
      issues.push(`${observation.role}:code_hash_changed`);
      unexpectedUpgrade = true;
    }
  }
  return {
    destinationChain: input.destinationChain,
    chainId: input.chainId,
    blockNumber: input.blockNumber,
    blockHash: input.blockHash,
    txHash: input.txHash,
    verdict: unexpectedUpgrade ? "unexpected_upgrade" : issues.length > 0 ? "mismatch" : "verified",
    issues,
    observations: input.observations,
  };
}

/**
 * The full-width identity of one exact CCTP message.
 *
 * The nonce is all thirty-two bytes Circle assigned, never the eight-byte `displayNonce` an
 * explorer shows, and the digest is keccak256 over the exact message bytes. Two messages that
 * share a displayed nonce therefore stay distinct, and a byte-for-byte repeat has one identity.
 */
export interface CctpMessageIdentity {
  readonly nonce: Hex;
  readonly digest: Hex;
}

/**
 * Canonical destination-chain evidence that this exact CCTP message was executed.
 *
 * Every field is a bounded public reference drawn from the destination receipt and block.
 * No provider credential, URL path, or internal adapter address appears here.
 *
 * `txHash` and `blockNumber` are the canonical mint transaction and the block that
 * confirmed it. `messageNonce` and `messageDigest` are the full-width identity of the
 * exact message bytes that were consumed — not the eight-byte displayed nonce an explorer
 * shows. A verifier that accepts a shorter nonce accepts a weaker identity.
 */
export interface CctpProofEvidence {
  /** The destination transaction that executed the mint. Full 32-byte hex, 0x-prefixed. */
  readonly txHash: Hex;
  /** Block number on the destination chain that contains `txHash`, as an integer string. */
  readonly blockNumber: string;
  /** keccak256 hash of that block, used to confirm the block is canonical. */
  readonly blockHash: Hex;
  /** Log index of the USDC Transfer event within `txHash`. */
  readonly mintLogIndex: number;
  /** The full 32-byte CCTP nonce extracted from the executed message bytes. */
  readonly messageNonce: Hex;
  /** keccak256 of the exact message bytes, linking provider record to destination event. */
  readonly messageDigest: Hex;
  /** Net USDC amount minted after fees, as an integer string to avoid float imprecision. */
  readonly mintAmount: string;
  /** Destination chain key, e.g. "sepolia". */
  readonly destinationChain: string;
}

export function cctpMessageIdentity(raw: string): CctpMessageIdentity | null {
  if (raw.length > 8192 || !/^0x(?:[0-9a-fA-F]{2})+$/.test(raw)) return null;
  try {
    const message = parseCctpMessage(raw as Hex);
    if (!/^0x[0-9a-fA-F]{64}$/.test(message.nonce)) return null;
    return {
      nonce: message.nonce.toLowerCase() as Hex,
      digest: keccak256(raw.toLowerCase() as Hex),
    };
  } catch {
    return null;
  }
}

export type CctpMessageVerification =
  | {
      readonly message: ReturnType<typeof parseCctpMessage>;
      readonly body: Uint8Array;
      readonly amount: bigint;
      readonly feeReconciliation: CctpFeeReconciliation;
      readonly failure: null;
    }
  | {
      readonly message: null;
      readonly body: null;
      readonly amount: null;
      readonly feeReconciliation: null;
      readonly failure: CctpVerificationFailure;
    };

export function inspectCctpMessage(
  raw: Hex,
  expected: ExpectedCctpTransfer,
): CctpMessageVerification {
  try {
    const message = parseCctpMessage(raw);
    const body = cctpBody(raw);
    const burn = parseCctpBurnMessage(body);
    assertSupportedMessage(message);
    assertSupportedBurn(burn);
    const word = (address: string) => `0x${address.slice(2).padStart(64, "0")}`.toLowerCase();
    if (message.sourceDomain !== 27) return invalidMessage("source_domain_mismatch");
    if (message.destinationDomain !== expected.destinationDomain)
      return invalidMessage("destination_domain_mismatch");
    if (
      message.sender.toLowerCase() !==
        toHex(StrKey.decodeContract(expected.sourceMessenger)).toLowerCase() ||
      message.recipient.toLowerCase() !== word(expected.destinationMessenger)
    )
      return invalidMessage("messenger_mismatch");
    if (
      burn.messageSender.toLowerCase() !==
      toHex(StrKey.decodeContract(expected.sourceAdapter)).toLowerCase()
    )
      return invalidMessage("source_adapter_mismatch");
    if (
      burn.burnToken.toLowerCase() !==
      toHex(StrKey.decodeContract(expected.sourceToken)).toLowerCase()
    )
      return invalidMessage("token_mismatch");
    if (toEvmAddress(burn.mintRecipient).toLowerCase() !== expected.recipient.toLowerCase())
      return invalidMessage("recipient_mismatch");
    if (expected.sourceAmount % 10n !== 0n || burn.amount !== expected.sourceAmount / 10n)
      return invalidMessage("amount_mismatch");
    if (
      burn.maxFee < 0n ||
      burn.maxFee >= burn.amount ||
      burn.feeExecuted > burn.maxFee ||
      burn.feeExecuted < 0n ||
      burn.feeExecuted >= burn.amount
    )
      return invalidMessage("fee_mismatch");
    if (message.finalityThresholdExecuted < 2000) return invalidMessage("finality_mismatch");
    const actualPayout = burn.amount - burn.feeExecuted;
    return {
      message,
      body,
      amount: actualPayout,
      feeReconciliation: {
        burnedAmountSourceUnits: expected.sourceAmount,
        forwardingBudgetDestinationUnits: burn.maxFee,
        executedDeductionDestinationUnits: burn.feeExecuted,
        actualPayoutDestinationUnits: actualPayout,
      },
      failure: null,
    };
  } catch {
    return invalidMessage("invalid_message");
  }
}

function invalidMessage(failure: CctpVerificationFailure): CctpMessageVerification {
  return { message: null, body: null, amount: null, feeReconciliation: null, failure };
}

export function verifiedCctpMessage(raw: Hex, expected: ExpectedCctpTransfer) {
  const result = inspectCctpMessage(raw, expected);
  if (result.failure !== null) return null;
  return {
    message: result.message,
    body: toHex(result.body),
    amount: result.amount,
    feeReconciliation: result.feeReconciliation,
  };
}

export function inspectCctpPayment<T extends DeliveryLog>(
  logs: readonly T[],
  raw: Hex,
  expected: ExpectedCctpTransfer,
):
  | { readonly payment: T; readonly failure: null }
  | { readonly payment: null; readonly failure: CctpVerificationFailure } {
  const verified = inspectCctpMessage(raw, expected);
  if (verified.failure !== null) return { payment: null, failure: verified.failure };
  const encodedBody = toHex(verified.body);
  let sawReceipt = false;
  let received = false;
  let payment: T | null = null;
  let receiptFailure: CctpVerificationFailure | null = null;
  let mintMismatch: CctpVerificationFailure | null = null;
  for (const log of logs) {
    try {
      const event = decodeEventLog({ abi: CCTP_RECEIPT_ABI, topics: log.topics, data: log.data });
      if (
        event.eventName === "MessageReceived" &&
        log.address.toLowerCase() === expected.transmitter.toLowerCase()
      ) {
        sawReceipt = true;
        if (
          event.args.sourceDomain === 27 &&
          event.args.nonce.toLowerCase() === verified.message.nonce.toLowerCase() &&
          event.args.sender.toLowerCase() === verified.message.sender.toLowerCase() &&
          event.args.finalityThresholdExecuted === verified.message.finalityThresholdExecuted &&
          event.args.messageBody.toLowerCase() === encodedBody.toLowerCase()
        ) {
          received = true;
        } else if (event.args.sourceDomain !== 27) {
          receiptFailure = "source_domain_mismatch";
        } else if (
          event.args.finalityThresholdExecuted !== verified.message.finalityThresholdExecuted
        ) {
          receiptFailure = "finality_mismatch";
        } else {
          receiptFailure = "receipt_mismatch";
        }
      }
      if (event.eventName === "Transfer" && /^0x0{40}$/.test(event.args.from)) {
        const to = event.args.to.toLowerCase();
        const tokenMatches = log.address.toLowerCase() === expected.token.toLowerCase();
        if (
          !tokenMatches &&
          to === expected.recipient.toLowerCase() &&
          event.args.value === verified.amount
        ) {
          mintMismatch ??= "token_mismatch";
        } else if (tokenMatches && to !== expected.recipient.toLowerCase()) {
          mintMismatch ??= "recipient_mismatch";
        } else if (tokenMatches && event.args.value !== verified.amount) {
          mintMismatch ??= "amount_mismatch";
        } else if (tokenMatches) {
          payment = log;
        }
      }
    } catch {
      // Unrelated receipt events do not establish this transfer's delivery.
    }
  }
  if (!received) {
    return {
      payment: null,
      failure: sawReceipt ? (receiptFailure ?? "receipt_mismatch") : "receipt_missing",
    };
  }
  if (!payment) return { payment: null, failure: mintMismatch ?? "mint_missing" };
  return { payment, failure: null };
}

/*
 * A null result from the legacy convenience API remains useful to callers that only need proof,
 * while delivery diagnostics use inspectCctpPayment to retain a bounded failure category.
 */
export function matchingCctpPayment<T extends DeliveryLog>(
  logs: readonly T[],
  raw: Hex,
  expected: ExpectedCctpTransfer,
): T | null {
  const result = inspectCctpPayment(logs, raw, expected);
  return result.payment;
}
