import { sanitizeDiagnosticText } from "../../logging/logger.js";
import { decodeEventLog, parseAbi, type Hex } from "viem";
export const ITS_ABI = parseAbi([
  "function registeredTokenAddress(bytes32 tokenId) view returns (address)",
  "function tokenManagerAddress(bytes32 tokenId) view returns (address)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "event InterchainTransferReceived(bytes32 indexed commandId, bytes32 indexed tokenId, string sourceChain, bytes sourceAddress, address indexed destinationAddress, uint256 amount, bytes32 dataHash)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
export const AXELAR_GAS_ABI = parseAbi([
  "event GasPaidForContractCall(address indexed sourceAddress, string destinationChain, string destinationAddress, bytes32 indexed payloadHash, address gasToken, uint256 gasFeeAmount, address refundAddress)",
  "event GasPaidForContractCallWithToken(address indexed sourceAddress, string destinationChain, string destinationAddress, bytes32 indexed payloadHash, string symbol, uint256 amount, address gasToken, uint256 gasFeeAmount, address refundAddress)",
  "event NativeGasPaidForContractCall(address indexed sourceAddress, string destinationChain, string destinationAddress, bytes32 indexed payloadHash, uint256 gasFeeAmount, address refundAddress)",
  "event NativeGasPaidForContractCallWithToken(address indexed sourceAddress, string destinationChain, string destinationAddress, bytes32 indexed payloadHash, string symbol, uint256 amount, uint256 gasFeeAmount, address refundAddress)",
  "event GasPaidForExpressCall(address indexed sourceAddress, string destinationChain, string destinationAddress, bytes32 indexed payloadHash, address gasToken, uint256 gasFeeAmount, address refundAddress)",
  "event GasPaidForExpressCallWithToken(address indexed sourceAddress, string destinationChain, string destinationAddress, bytes32 indexed payloadHash, string symbol, uint256 amount, address gasToken, uint256 gasFeeAmount, address refundAddress)",
  "event NativeGasPaidForExpressCall(address indexed sourceAddress, string destinationChain, string destinationAddress, bytes32 indexed payloadHash, uint256 gasFeeAmount, address refundAddress)",
  "event NativeGasPaidForExpressCallWithToken(address indexed sourceAddress, string destinationChain, string destinationAddress, bytes32 indexed payloadHash, string symbol, uint256 amount, uint256 gasFeeAmount, address refundAddress)",
  "event GasAdded(bytes32 indexed txHash, uint256 indexed logIndex, address gasToken, uint256 gasFeeAmount, address refundAddress)",
  "event NativeGasAdded(bytes32 indexed txHash, uint256 indexed logIndex, uint256 gasFeeAmount, address refundAddress)",
  "event ExpressGasAdded(bytes32 indexed txHash, uint256 indexed logIndex, address gasToken, uint256 gasFeeAmount, address refundAddress)",
  "event NativeExpressGasAdded(bytes32 indexed txHash, uint256 indexed logIndex, uint256 gasFeeAmount, address refundAddress)",
  "event Refunded(bytes32 indexed txHash, uint256 indexed logIndex, address payable receiver, address token, uint256 amount)",
]);
export interface DeliveryLog {
  address: Hex;
  topics: [] | [Hex, ...Hex[]];
  data: Hex;
  logIndex: number | null;
}
export interface ExpectedDelivery {
  its: string;
  token: string;
  tokenManager: string;
  commandId: string;
  tokenId: string;
  sourceChain: string;
  sourceAddress: string;
  recipient: string;
  amount: bigint;
}

export type AxelarGasEvidenceKind = "payment" | "topup" | "refund" | "unsupported";
export type AxelarGasLinkBasis = "origin_log" | "source_identity" | "unresolved";

export interface GasLinkTarget {
  readonly transferId: bigint;
  readonly originTx: string;
  readonly originLogIndex: number | null;
  readonly sender: string;
  readonly destinationChain: string;
  readonly destination: string;
}

export interface AxelarGasEvidence<T extends DeliveryLog = DeliveryLog> {
  readonly log: T;
  readonly eventName: string;
  readonly eventSignature: string;
  readonly kind: AxelarGasEvidenceKind;
  readonly native: boolean;
  readonly gasToken: string | null;
  readonly amount: bigint;
  readonly refundAddress: string | null;
  readonly sourceAddress: string | null;
  readonly destinationChain: string | null;
  readonly destinationAddress: string | null;
  readonly sourceLogIndex: number;
  readonly referenceTxHash: string;
  readonly referenceLogIndex: number | null;
  readonly transferId: bigint | null;
  readonly linkBasis: AxelarGasLinkBasis;
  readonly candidateCount: number;
  readonly payload: unknown;
}

const GAS_PAYMENT_EVENTS: readonly string[] = [
  "GasPaidForContractCall",
  "GasPaidForContractCallWithToken",
  "NativeGasPaidForContractCall",
  "NativeGasPaidForContractCallWithToken",
  "GasPaidForExpressCall",
  "GasPaidForExpressCallWithToken",
  "NativeGasPaidForExpressCall",
  "NativeGasPaidForExpressCallWithToken",
];
const GAS_TOPUP_EVENTS: readonly string[] = [
  "GasAdded",
  "NativeGasAdded",
  "ExpressGasAdded",
  "NativeExpressGasAdded",
];
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function gasString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function gasAmount(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return null;
}

function safeLogIndex(value: unknown): number | null {
  const index = gasAmount(value);
  return index !== null && index <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(index) : null;
}

function sameAddress(left: string | null, right: string): boolean {
  return left !== null && left.toLowerCase() === right.toLowerCase();
}

export function inspectAxelarGasEvidence<T extends DeliveryLog>(
  logs: readonly T[],
  gasService: string,
  sourceTxHash: string,
  targets: readonly GasLinkTarget[],
): readonly AxelarGasEvidence<T>[] {
  const records: AxelarGasEvidence<T>[] = [];
  for (const log of logs) {
    if (!sameAddress(log.address, gasService)) continue;
    const signature = log.topics[0] ?? "0x";
    let event: { readonly eventName: string; readonly args: unknown };
    try {
      event = decodeEventLog({
        abi: AXELAR_GAS_ABI,
        topics: log.topics,
        data: log.data,
      });
    } catch {
      records.push({
        log,
        eventName: "unsupported",
        eventSignature: signature,
        kind: "unsupported",
        native: false,
        gasToken: null,
        amount: 0n,
        refundAddress: null,
        sourceAddress: null,
        destinationChain: null,
        destinationAddress: null,
        sourceLogIndex: log.logIndex ?? -1,
        referenceTxHash: sourceTxHash,
        referenceLogIndex: null,
        transferId: null,
        linkBasis: "unresolved",
        candidateCount: 0,
        payload: {
          address: log.address,
          topics: log.topics,
          data: log.data,
          logIndex: log.logIndex,
        },
      });
      continue;
    }
    const name = event.eventName;
    const args = event.args as Record<string, unknown>;
    const kind: AxelarGasEvidenceKind = GAS_PAYMENT_EVENTS.includes(name)
      ? "payment"
      : GAS_TOPUP_EVENTS.includes(name)
        ? "topup"
        : name === "Refunded"
          ? "refund"
          : "unsupported";
    const referenceTx =
      kind === "payment" ? sourceTxHash : (gasString(args.txHash) ?? sourceTxHash);
    const referenceLogIndex =
      kind === "payment" ? log.logIndex : (safeLogIndex(args.logIndex) ?? log.logIndex);
    const sourceAddress = gasString(args.sourceAddress);
    const destinationChain = gasString(args.destinationChain);
    const destinationAddress = gasString(args.destinationAddress);
    const token = gasString(args.gasToken) ?? gasString(args.token);
    const native =
      name.startsWith("Native") || (kind === "refund" && sameAddress(token, ZERO_ADDRESS));
    const candidates =
      kind === "payment"
        ? targets.filter(
            (target) =>
              sameAddress(target.originTx, referenceTx) &&
              sameAddress(target.sender, sourceAddress ?? "") &&
              target.destinationChain === destinationChain &&
              sameAddress(target.destination, destinationAddress ?? ""),
          )
        : kind === "unsupported"
          ? []
          : targets.filter(
              (target) =>
                sameAddress(target.originTx, referenceTx) &&
                target.originLogIndex === referenceLogIndex,
            );
    const only = candidates.length === 1 ? candidates[0] : undefined;
    records.push({
      log,
      eventName: name,
      eventSignature: signature,
      kind,
      native,
      gasToken: native ? null : token,
      amount: gasAmount(kind === "refund" ? args.amount : args.gasFeeAmount) ?? 0n,
      refundAddress: gasString(kind === "refund" ? args.receiver : args.refundAddress),
      sourceAddress,
      destinationChain,
      destinationAddress,
      sourceLogIndex: log.logIndex ?? -1,
      referenceTxHash: referenceTx,
      referenceLogIndex,
      transferId: only?.transferId ?? null,
      linkBasis:
        only === undefined ? "unresolved" : kind === "payment" ? "source_identity" : "origin_log",
      candidateCount: candidates.length,
      payload: {
        eventName: name,
        address: log.address,
        topics: log.topics,
        data: log.data,
        logIndex: log.logIndex,
        sourceAddress,
        destinationChain,
        destinationAddress,
        gasToken: native ? null : token,
        refundAddress: gasString(kind === "refund" ? args.receiver : args.refundAddress),
      },
    });
  }
  return records;
}

export type VerificationMismatchCategory =
  | "source_identity"
  | "command"
  | "token"
  | "precision"
  | "recipient"
  | "amount"
  | "payment_evidence";

export interface VerificationDiagnostic {
  readonly category: VerificationMismatchCategory;
  readonly expected: string | null;
  readonly observed: string | null;
}

export interface PaymentInspection<T extends DeliveryLog> {
  readonly payment: T | null;
  readonly diagnostics: readonly VerificationDiagnostic[];
}

function bounded(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text =
    typeof value === "bigint" || typeof value === "string" || typeof value === "number"
      ? String(value)
      : Object.prototype.toString.call(value);
  const safe = sanitizeDiagnosticText(text);
  return safe.length <= 128 ? safe : `${safe.slice(0, 64)}…${safe.slice(-63)}`;
}

export interface DeliveryEvidence<T extends DeliveryLog = DeliveryLog> {
  readonly received: T | null;
  readonly payment: T | null;
}

interface DestinationInspection<T extends DeliveryLog> extends DeliveryEvidence<T> {
  readonly diagnostics: readonly VerificationDiagnostic[];
  readonly ambiguous: boolean;
}

function inspectDestinationLogs<T extends DeliveryLog>(
  logs: readonly T[],
  expected: ExpectedDelivery,
): DestinationInspection<T> {
  const diagnostics: VerificationDiagnostic[] = [];
  const add = (
    category: VerificationMismatchCategory,
    expectedValue: unknown,
    observedValue: unknown,
  ) => {
    if (!diagnostics.some((item) => item.category === category))
      diagnostics.push({
        category,
        expected: bounded(expectedValue),
        observed: bounded(observedValue),
      });
  };
  const received = new Map<string, T>();
  const payments = new Map<string, T>();
  for (const log of logs) {
    let event: ReturnType<
      typeof decodeEventLog<typeof ITS_ABI, undefined, [Hex, ...Hex[]], Hex, true>
    >;
    try {
      event = decodeEventLog({ abi: ITS_ABI, topics: log.topics, data: log.data });
    } catch {
      continue;
    }
    const identity = `${String(log.logIndex ?? "none")}:${log.topics.join("").toLowerCase()}:${log.data.toLowerCase()}`;
    if (
      event.eventName === "InterchainTransferReceived" &&
      log.address.toLowerCase() === expected.its.toLowerCase()
    ) {
      const args = event.args;
      const exact =
        args.commandId.toLowerCase() === expected.commandId.toLowerCase() &&
        args.tokenId.toLowerCase() === expected.tokenId.toLowerCase() &&
        args.sourceChain === expected.sourceChain &&
        args.sourceAddress.toLowerCase() === expected.sourceAddress.toLowerCase() &&
        args.destinationAddress.toLowerCase() === expected.recipient.toLowerCase() &&
        args.amount === expected.amount;
      if (exact) {
        if (!received.has(identity)) received.set(identity, log);
        continue;
      }
      if (args.commandId.toLowerCase() !== expected.commandId.toLowerCase())
        add("command", expected.commandId, args.commandId);
      if (args.tokenId.toLowerCase() !== expected.tokenId.toLowerCase())
        add("token", expected.tokenId, args.tokenId);
      if (
        args.sourceChain !== expected.sourceChain ||
        args.sourceAddress.toLowerCase() !== expected.sourceAddress.toLowerCase()
      )
        add(
          "source_identity",
          `${expected.sourceChain}:${expected.sourceAddress}`,
          `${args.sourceChain}:${args.sourceAddress}`,
        );
      if (args.destinationAddress.toLowerCase() !== expected.recipient.toLowerCase())
        add("recipient", expected.recipient, args.destinationAddress);
      if (args.amount !== expected.amount) add("amount", expected.amount, args.amount);
    }
    if (
      event.eventName === "Transfer" &&
      log.address.toLowerCase() === expected.token.toLowerCase()
    ) {
      const args = event.args;
      if (
        args.from.toLowerCase() === expected.tokenManager.toLowerCase() &&
        args.to.toLowerCase() === expected.recipient.toLowerCase() &&
        args.value === expected.amount &&
        log.logIndex !== null
      ) {
        if (!payments.has(identity)) payments.set(identity, log);
        continue;
      }
      if (args.from.toLowerCase() !== expected.tokenManager.toLowerCase())
        add("token", expected.tokenManager, args.from);
      if (args.to.toLowerCase() !== expected.recipient.toLowerCase())
        add("recipient", expected.recipient, args.to);
      if (args.value !== expected.amount) add("amount", expected.amount, args.value);
    }
  }
  const ambiguous = received.size > 1 || payments.size > 1;
  if (ambiguous)
    add(
      "payment_evidence",
      "exactly one matching ITS receipt and ERC-20 payment",
      `${String(received.size)} receipts and ${String(payments.size)} payments`,
    );
  return {
    received: ambiguous ? null : ([...received.values()][0] ?? null),
    payment: ambiguous ? null : ([...payments.values()][0] ?? null),
    diagnostics,
    ambiguous,
  };
}

/** Inspect the two independent destination proofs without collapsing a missing one into failure. */
export function inspectDeliveryEvidence<T extends DeliveryLog>(
  logs: readonly T[],
  expected: ExpectedDelivery,
): DeliveryEvidence<T> {
  const { received, payment } = inspectDestinationLogs(logs, expected);
  return { received, payment };
}

export function normalizeVerificationDiagnostics(
  items: readonly VerificationDiagnostic[],
): readonly VerificationDiagnostic[] {
  const categories: readonly VerificationMismatchCategory[] = [
    "source_identity",
    "command",
    "token",
    "precision",
    "recipient",
    "amount",
    "payment_evidence",
  ];
  const result: VerificationDiagnostic[] = [];
  for (const item of items) {
    if (
      !categories.includes(item.category) ||
      result.some((previous) => previous.category === item.category)
    )
      continue;
    result.push({
      category: item.category,
      expected: bounded(item.expected),
      observed: bounded(item.observed),
    });
    if (result.length === categories.length) break;
  }
  return result;
}

/** Compare configured source-token metadata with the destination token contract metadata. */
export function inspectTokenMapping(
  expected: { readonly symbol: string; readonly decimals: number },
  observed: { readonly symbol: string; readonly decimals: number },
): readonly VerificationDiagnostic[] {
  const diagnostics: VerificationDiagnostic[] = [];
  if (expected.symbol !== observed.symbol)
    diagnostics.push({ category: "token", expected: expected.symbol, observed: observed.symbol });
  if (expected.decimals !== observed.decimals)
    diagnostics.push({
      category: "precision",
      expected: String(expected.decimals),
      observed: String(observed.decimals),
    });
  return diagnostics;
}

/** Return bounded public diagnostics only when no exact receipt/payment pair exists. */
export function inspectPayment<T extends DeliveryLog>(
  logs: readonly T[],
  expected: ExpectedDelivery,
): PaymentInspection<T> {
  const inspection = inspectDestinationLogs(logs, expected);
  if (inspection.received && inspection.payment)
    return { payment: inspection.payment, diagnostics: [] };
  const diagnostics = [...inspection.diagnostics];
  const add = (
    category: VerificationMismatchCategory,
    expectedValue: unknown,
    observedValue: unknown,
  ) => {
    if (!diagnostics.some((item) => item.category === category))
      diagnostics.push({
        category,
        expected: bounded(expectedValue),
        observed: bounded(observedValue),
      });
  };
  if (!inspection.received || !inspection.payment)
    add("payment_evidence", "canonical ITS receipt and matching ERC-20 payment", null);
  return { payment: null, diagnostics: normalizeVerificationDiagnostics(diagnostics) };
}

export function matchingPayment<T extends DeliveryLog>(
  logs: readonly T[],
  expected: ExpectedDelivery,
): T | null {
  const evidence = inspectDeliveryEvidence(logs, expected);
  return evidence.received === null ? null : evidence.payment;
}
