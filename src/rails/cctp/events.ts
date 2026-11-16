import { StrKey } from "@stellar/stellar-sdk";
import {
  assertSupportedBurn,
  assertSupportedMessage,
  cctpBody,
  parseCctpBurnMessage,
  parseCctpMessage,
  toEvmAddress,
  toHex,
  type CctpBurnMessage,
  type CctpMessage,
} from "@hyperion/protocol";
import { decodeEventLog, parseAbi, type Hex } from "viem";
import type { DeliveryLog } from "../axelar/events.js";

// Source: circlefin/evm-cctp-contracts/src/v2/MessageTransmitterV2.sol.
export const CCTP_RECEIPT_ABI = parseAbi([
  "event MessageReceived(address indexed caller,uint32 sourceDomain,bytes32 indexed nonce,bytes32 sender,uint32 indexed finalityThresholdExecuted,bytes messageBody)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);

export const STELLAR_USDC_DECIMALS = 7;
export const EVM_USDC_DECIMALS = 6;
export const STELLAR_TO_EVM_USDC_SCALE = 10n;

export type CctpFeeDiagnosticCode =
  | "malformed_message"
  | "identity_binding_mismatch"
  | "insufficient_finality"
  | "unrepresentable_source_precision"
  | "burn_amount_mismatch"
  | "invalid_forwarding_budget"
  | "excess_fee_deduction"
  | "exhausted_burn_amount"
  | "missing_message_event"
  | "missing_mint_event"
  | "inconsistent_mint_payout";

export interface CctpFeeAccounting {
  readonly sourceDecimals: 7;
  readonly destinationDecimals: 6;
  readonly sourceBurnedAmount: bigint;
  readonly cctpBurnAmount: bigint;
  readonly forwardingBudgetMaxFee: bigint;
  readonly executedFeeDeduction: bigint | null;
  readonly plannedMinPayout: bigint;
  readonly actualMintPayout: bigint | null;
}

export type CctpMessageFeeCheck =
  | {
      readonly ok: true;
      readonly message: CctpMessage;
      readonly burn: CctpBurnMessage;
      readonly body: Hex;
      readonly amount: bigint;
      readonly accounting: CctpFeeAccounting;
    }
  | {
      readonly ok: false;
      readonly code: CctpFeeDiagnosticCode;
      readonly detail: string;
      readonly accounting: CctpFeeAccounting | null;
    };

export type CctpReceiptFeeReconciliation<T extends DeliveryLog> =
  | {
      readonly ok: true;
      readonly payment: T;
      readonly message: CctpMessage;
      readonly burn: CctpBurnMessage;
      readonly body: Hex;
      readonly accounting: CctpFeeAccounting & {
        readonly executedFeeDeduction: bigint;
        readonly actualMintPayout: bigint;
      };
    }
  | {
      readonly ok: false;
      readonly code: CctpFeeDiagnosticCode;
      readonly detail: string;
      readonly accounting: CctpFeeAccounting | null;
    };

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

/**
 * Evaluates exact integer-only fee accounting from 7-decimal Stellar SAC USDC burn units to
 * 6-decimal destination native USDC burn, budget, deduction, and planned minimum payout units.
 */
export function evaluateCctpMessageFeeAccounting(
  raw: Hex,
  expected: ExpectedCctpTransfer,
  options?: { readonly requireFinalized?: boolean },
): CctpMessageFeeCheck {
  let message: CctpMessage;
  let body: Uint8Array;
  let burn: CctpBurnMessage;
  try {
    message = parseCctpMessage(raw);
    body = cctpBody(raw);
    burn = parseCctpBurnMessage(body);
    assertSupportedMessage(message);
    assertSupportedBurn(burn);
  } catch {
    return {
      ok: false,
      code: "malformed_message",
      detail: "CCTP v2 message or burn payload failed structural parsing",
      accounting: null,
    };
  }

  const clampedPlannedMin = burn.amount > burn.maxFee ? burn.amount - burn.maxFee : 0n;
  const baseAccounting: CctpFeeAccounting = {
    sourceDecimals: STELLAR_USDC_DECIMALS,
    destinationDecimals: EVM_USDC_DECIMALS,
    sourceBurnedAmount: expected.sourceAmount,
    cctpBurnAmount: burn.amount,
    forwardingBudgetMaxFee: burn.maxFee,
    executedFeeDeduction: burn.feeExecuted,
    plannedMinPayout: clampedPlannedMin,
    actualMintPayout: null,
  };

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
    toEvmAddress(burn.mintRecipient).toLowerCase() !== expected.recipient.toLowerCase()
  ) {
    return {
      ok: false,
      code: "identity_binding_mismatch",
      detail: "CCTP message contracts, domain, or mint recipient did not match source transfer",
      accounting: null,
    };
  }

  if (expected.sourceAmount <= 0n || expected.sourceAmount % STELLAR_TO_EVM_USDC_SCALE !== 0n) {
    return {
      ok: false,
      code: "unrepresentable_source_precision",
      detail: `7-decimal source amount ${expected.sourceAmount.toString()} is not losslessly divisible by 10 into 6-decimal destination units`,
      accounting: baseAccounting,
    };
  }

  const expectedBurnAmount = expected.sourceAmount / STELLAR_TO_EVM_USDC_SCALE;
  if (burn.amount !== expectedBurnAmount) {
    return {
      ok: false,
      code: "burn_amount_mismatch",
      detail: `6-decimal CCTP burn amount ${burn.amount.toString()} disagrees with scaled source burn ${expectedBurnAmount.toString()}`,
      accounting: baseAccounting,
    };
  }

  if (burn.maxFee < 0n || burn.maxFee >= burn.amount) {
    return {
      ok: false,
      code: "invalid_forwarding_budget",
      detail: `forwarding budget maxFee ${burn.maxFee.toString()} must be non-negative and strictly less than burn amount ${burn.amount.toString()}`,
      accounting: baseAccounting,
    };
  }

  if (burn.feeExecuted < 0n || burn.feeExecuted > burn.maxFee) {
    return {
      ok: false,
      code: "excess_fee_deduction",
      detail: `executed fee deduction ${burn.feeExecuted.toString()} exceeds forwarding budget maxFee ${burn.maxFee.toString()}`,
      accounting: baseAccounting,
    };
  }

  if (burn.feeExecuted >= burn.amount) {
    return {
      ok: false,
      code: "exhausted_burn_amount",
      detail: `executed fee deduction ${burn.feeExecuted.toString()} exhausted burn amount ${burn.amount.toString()}`,
      accounting: baseAccounting,
    };
  }

  const requireFinalized = options?.requireFinalized ?? true;
  if (requireFinalized && message.finalityThresholdExecuted < 2000) {
    return {
      ok: false,
      code: "insufficient_finality",
      detail: `finalityThresholdExecuted ${String(message.finalityThresholdExecuted)} is below 2000`,
      accounting: {
        ...baseAccounting,
        executedFeeDeduction: null,
      },
    };
  }

  const expectedPayout = burn.amount - burn.feeExecuted;
  return {
    ok: true,
    message,
    burn,
    body: toHex(body),
    amount: expectedPayout,
    accounting: baseAccounting,
  };
}

export function verifiedCctpMessage(raw: Hex, expected: ExpectedCctpTransfer) {
  const checked = evaluateCctpMessageFeeAccounting(raw, expected, { requireFinalized: true });
  if (!checked.ok) return null;
  return {
    message: checked.message,
    burn: checked.burn,
    body: checked.body,
    amount: checked.amount,
    accounting: checked.accounting,
  };
}

export function reconcileCctpBurnToMint<T extends DeliveryLog>(
  logs: readonly T[],
  raw: Hex,
  expected: ExpectedCctpTransfer,
): CctpReceiptFeeReconciliation<T> {
  const checked = evaluateCctpMessageFeeAccounting(raw, expected, { requireFinalized: true });
  if (!checked.ok) {
    return checked;
  }

  let received = false;
  let exactPayment: T | null = null;
  let mismatchedMintValue: bigint | null = null;

  for (const log of logs) {
    try {
      const event = decodeEventLog({ abi: CCTP_RECEIPT_ABI, topics: log.topics, data: log.data });
      if (
        event.eventName === "MessageReceived" &&
        log.address.toLowerCase() === expected.transmitter.toLowerCase()
      ) {
        received ||=
          event.args.sourceDomain === 27 &&
          event.args.nonce.toLowerCase() === checked.message.nonce.toLowerCase() &&
          event.args.sender.toLowerCase() === checked.message.sender.toLowerCase() &&
          event.args.finalityThresholdExecuted === checked.message.finalityThresholdExecuted &&
          event.args.messageBody.toLowerCase() === checked.body.toLowerCase();
      }
      if (
        event.eventName === "Transfer" &&
        log.address.toLowerCase() === expected.token.toLowerCase() &&
        /^0x0{40}$/.test(event.args.from) &&
        event.args.to.toLowerCase() === expected.recipient.toLowerCase()
      ) {
        if (event.args.value === checked.amount) {
          exactPayment = log;
        } else {
          mismatchedMintValue = event.args.value;
        }
      }
    } catch {
      /* Unrelated receipt events do not establish this transfer's delivery. */
    }
  }

  if (!received) {
    return {
      ok: false,
      code: "missing_message_event",
      detail: "destination receipt lacked canonical MessageReceived log for attested message",
      accounting: checked.accounting,
    };
  }

  if (exactPayment === null) {
    if (mismatchedMintValue !== null) {
      return {
        ok: false,
        code: "inconsistent_mint_payout",
        detail: `native USDC mint ${mismatchedMintValue.toString()} disagrees with burn minus executed fee ${checked.amount.toString()}`,
        accounting: {
          ...checked.accounting,
          actualMintPayout: mismatchedMintValue,
        },
      };
    }
    return {
      ok: false,
      code: "missing_mint_event",
      detail: "destination receipt lacked native USDC mint Transfer from zero address to recipient",
      accounting: checked.accounting,
    };
  }

  return {
    ok: true,
    payment: exactPayment,
    message: checked.message,
    burn: checked.burn,
    body: checked.body,
    accounting: {
      ...checked.accounting,
      executedFeeDeduction: checked.burn.feeExecuted,
      actualMintPayout: checked.amount,
    },
  };
}

export function matchingCctpPayment<T extends DeliveryLog>(
  logs: readonly T[],
  raw: Hex,
  expected: ExpectedCctpTransfer,
): T | null {
  const reconciled = reconcileCctpBurnToMint(logs, raw, expected);
  return reconciled.ok ? reconciled.payment : null;
}
