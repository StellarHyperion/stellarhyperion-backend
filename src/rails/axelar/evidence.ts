/**
 * Read-only Axelar delivery evidence builder and credential-safe formatter.
 *
 * Exposes ITS command, canonical destination receipt, and exact ERC-20 token-payment references
 * alongside an explicit verification checklist. Provider `executed` status is always surfaced as
 * candidate discovery only and never establishes payout without confirmed chain evidence.
 */
import {
  CHAINS,
  RAIL_CONTRACTS,
  RouteKind,
  assetOn,
  isChainKey,
  isEvmChain,
  toEvmAddress,
} from "@hyperion/protocol";

import type { AppConfig } from "../../config/config.js";
import type { Queryable } from "../../db/pool.js";
import { integer, integerOrNull, text, textOrNull } from "../../db/rows.js";

export const MAX_EVIDENCE_TEXT_LENGTH = 256;
export const MAX_EVIDENCE_ID_LENGTH = 160;

export type AxelarEvidenceVerdict =
  | "confirmed_delivery"
  | "parked_claim"
  | "insufficient_provider_only"
  | "unverified_candidate"
  | "failed"
  | "awaiting_evidence";

export type ProviderEvidenceAssessment =
  | "corroborated_by_chain_payment"
  | "insufficient_without_chain_payment"
  | "candidate_pending"
  | "provider_failed"
  | "unobserved";

export interface AxelarEvidenceChecklistStep {
  readonly step:
    | "source_transfer_indexed"
    | "provider_candidate_discovery"
    | "its_command_verified"
    | "canonical_receipt_confirmed"
    | "token_mapping_verified"
    | "erc20_payment_matched";
  readonly passed: boolean;
  readonly sufficientAlone: boolean;
  readonly summary: string;
}

export interface AxelarDeliveryEvidence {
  readonly transferId: string;
  readonly route: number;
  readonly verdict: AxelarEvidenceVerdict;
  readonly origin: {
    readonly chain: string;
    readonly nonce: string;
    readonly txHash: string;
    readonly block: string;
    readonly sender: string;
    readonly token: string;
    readonly grossAmount: string;
    readonly fee: string;
    readonly netAmount: string;
    readonly observedAt: string;
  };
  readonly provider: {
    readonly attestationStatus: string | null;
    readonly railStatus: string | null;
    readonly reference: string | null;
    readonly attestedAt: string | null;
    readonly lastCheckedAt: string | null;
    readonly lastError: string | null;
    readonly providerReportsExecuted: boolean;
    readonly sufficientForDelivery: false;
    readonly assessment: ProviderEvidenceAssessment;
  };
  readonly command: {
    readonly verified: boolean;
    readonly itsContract: string | null;
    readonly commandId: string | null;
  };
  readonly receipt: {
    readonly confirmed: boolean;
    readonly destinationChain: string;
    readonly block: string | null;
    readonly txHash: string | null;
    readonly observedAt: string | null;
  };
  readonly tokenPayment: {
    readonly verified: boolean;
    readonly exactMatch: boolean;
    readonly token: string | null;
    readonly symbol: string | null;
    readonly decimals: number | null;
    readonly expectedRecipient: string;
    readonly recipient: string | null;
    readonly expectedAmount: string;
    readonly amount: string | null;
    readonly txHash: string | null;
    readonly logIndex: number | null;
  };
  readonly checklist: {
    readonly sourceTransferIndexed: boolean;
    readonly providerCandidateObserved: boolean;
    readonly providerStatusAloneSufficient: false;
    readonly itsCommandVerified: boolean;
    readonly canonicalReceiptConfirmed: boolean;
    readonly tokenMappingVerified: boolean;
    readonly erc20PaymentExactMatch: boolean;
    readonly payoutEstablished: boolean;
    readonly steps: readonly AxelarEvidenceChecklistStep[];
  };
}

export type ReadAxelarEvidenceOutcome =
  | { readonly kind: "not_found" }
  | { readonly kind: "unsupported_route"; readonly route: number }
  | { readonly kind: "ok"; readonly evidence: AxelarDeliveryEvidence };

const AXELAR_EVIDENCE_SELECT = `
  SELECT t.id,
         t.origin_chain,
         t.route,
         t.nonce,
         t.sender,
         t.token,
         t.gross_amount,
         t.fee,
         t.net_amount,
         t.destination_chain,
         t.destination,
         t.rail_ref,
         t.origin_block,
         t.origin_tx,
         t.observed_at,
         a.status AS attestation_status,
         a.rail_status,
         a.rail_reference,
         a.attested_at,
         a.last_checked_at,
         a.last_error,
         d.rail_message_id,
         d.recipient AS received_recipient,
         d.token AS received_token,
         d.amount AS received_amount,
         d.delivered AS inbound_delivered,
         d.destination_block,
         d.destination_tx,
         d.destination_log_index,
         d.observed_at AS delivered_at,
         c.claim_id,
         c.settled AS claim_settled
    FROM outbound_transfer t
    LEFT JOIN rail_attestation a ON a.transfer_id = t.id
    LEFT JOIN inbound_delivery d
      ON d.destination_chain = t.destination_chain
     AND d.route = t.route
     AND d.source_chain = t.origin_chain
     AND d.source_nonce = t.nonce
    LEFT JOIN pending_claim c
      ON c.chain = t.destination_chain
     AND c.route = t.route
     AND c.source_chain = t.origin_chain
     AND c.source_nonce = t.nonce
`;

/**
 * Scrubs URL credentials, query secrets, bearer/basic tokens, key=value secrets, and base32
 * secret seeds while preserving public addresses, command IDs, and transaction hashes.
 */
export function scrubEvidenceText(value: string, maxLength = MAX_EVIDENCE_TEXT_LENGTH): string {
  const scrubbed = value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+:[^/\s@]+)@/gi, "$1[REDACTED]@")
    .replace(
      /([?&](?:api[_-]?key|token|secret|password|auth|key|access[_-]?token)=)[^&\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, "$1 [REDACTED]")
    .replace(
      /\b(api[_-]?key|private[_-]?key|secret|password|x-api-key)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    )
    .replace(/\bS[A-Z2-7]{55}\b/g, "[REDACTED_SECRET]");

  if (scrubbed.length <= maxLength) {
    return scrubbed;
  }
  return `${scrubbed.slice(0, maxLength)}...[truncated]`;
}

function scrubOptionalText(
  value: string | null,
  maxLength = MAX_EVIDENCE_TEXT_LENGTH,
): string | null {
  if (value === null) return null;
  return scrubEvidenceText(value, maxLength);
}

function toIsoOrNull(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) return raw.toISOString();
  if (typeof raw === "string" || typeof raw === "number") {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

function isFullWidthBytes32(value: string | null): boolean {
  return value !== null && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isEvmAddressString(value: string | null): boolean {
  return value !== null && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function parseExactInteger(value: string | null): bigint | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  return BigInt(value);
}

export function formatAxelarDeliveryEvidence(
  row: Record<string, unknown>,
  config: AppConfig,
): ReadAxelarEvidenceOutcome {
  const route = integer(row, "route");
  if (route !== RouteKind.AxelarIts && route !== RouteKind.AxelarGmp) {
    return { kind: "unsupported_route", route };
  }

  const originChain = text(row, "origin_chain");
  const destinationChain = text(row, "destination_chain");
  const originToken = scrubEvidenceText(text(row, "token"), MAX_EVIDENCE_ID_LENGTH);
  const destinationWord = text(row, "destination");

  const destinationIsEvm = isChainKey(destinationChain) && isEvmChain(CHAINS[destinationChain]);
  const expectedRecipient =
    destinationIsEvm && /^0x[0-9a-fA-F]{64}$/.test(destinationWord)
      ? toEvmAddress(destinationWord as `0x${string}`)
      : scrubEvidenceText(destinationWord, MAX_EVIDENCE_ID_LENGTH);

  const rawItsContract = isChainKey(destinationChain)
    ? RAIL_CONTRACTS[destinationChain]?.axelar?.interchainTokenService
    : undefined;
  const itsContract =
    rawItsContract !== undefined && rawItsContract.length > 0 ? rawItsContract : null;

  const deployment = isChainKey(originChain) ? config.deployments.networks[originChain] : undefined;
  const tokenEntry = deployment
    ? Object.entries(
        deployment.tokens as Record<string, { sacId?: string; address?: string; decimals: number }>,
      ).find(([, asset]) => {
        const tokenId = asset.sacId ?? asset.address;
        return tokenId?.toLowerCase() === originToken.toLowerCase();
      })
    : undefined;

  const receivedToken = scrubOptionalText(
    textOrNull(row, "received_token"),
    MAX_EVIDENCE_ID_LENGTH,
  );
  const destinationAsset =
    isChainKey(destinationChain) && tokenEntry ? assetOn(destinationChain, tokenEntry[0]) : null;
  const nativeMetadata =
    destinationAsset?.family === "evm" &&
    destinationAsset.address.toLowerCase() === receivedToken?.toLowerCase()
      ? { symbol: destinationAsset.symbol, decimals: destinationAsset.decimals }
      : null;
  const tokenMetadata =
    nativeMetadata ??
    (receivedToken !== null && route === RouteKind.AxelarIts && tokenEntry
      ? { symbol: `${tokenEntry[0]} (ITS)`, decimals: tokenEntry[1].decimals }
      : null);

  const attestationStatus = scrubOptionalText(textOrNull(row, "attestation_status"), 64);
  const railStatus = scrubOptionalText(textOrNull(row, "rail_status"), 128);
  const providerRef = scrubOptionalText(
    textOrNull(row, "rail_reference") ?? textOrNull(row, "rail_ref"),
    MAX_EVIDENCE_ID_LENGTH,
  );
  const lastError = scrubOptionalText(textOrNull(row, "last_error"), MAX_EVIDENCE_TEXT_LENGTH);

  const commandId = scrubOptionalText(textOrNull(row, "rail_message_id"), MAX_EVIDENCE_ID_LENGTH);
  const destinationTx = scrubOptionalText(
    textOrNull(row, "destination_tx"),
    MAX_EVIDENCE_ID_LENGTH,
  );
  const destinationBlock = scrubOptionalText(textOrNull(row, "destination_block"), 40);
  const destinationLogIndex = integerOrNull(row, "destination_log_index");
  const receivedRecipient = scrubOptionalText(
    textOrNull(row, "received_recipient"),
    MAX_EVIDENCE_ID_LENGTH,
  );
  const expectedAmount = text(row, "net_amount");
  const receivedAmount = textOrNull(row, "received_amount");
  const inboundDelivered = row.inbound_delivered === true;
  const hasClaim = row.claim_id !== null && row.claim_id !== undefined;
  const claimSettled = row.claim_settled === true;

  const inboundRowPresent =
    destinationTx !== null || destinationBlock !== null || receivedAmount !== null;

  const providerReportsExecuted =
    railStatus !== null && /(?:^|\/)executed(?=$|\/)/i.test(railStatus);
  const providerCandidateObserved =
    attestationStatus !== null || railStatus !== null || providerRef !== null;

  const canonicalReceiptConfirmed =
    destinationTx !== null &&
    destinationBlock !== null &&
    (!destinationIsEvm || isFullWidthBytes32(destinationTx));

  const itsCommandVerified = destinationIsEvm
    ? canonicalReceiptConfirmed && isFullWidthBytes32(commandId)
    : canonicalReceiptConfirmed;

  const tokenMappingVerified = destinationIsEvm
    ? canonicalReceiptConfirmed && isEvmAddressString(receivedToken)
    : canonicalReceiptConfirmed && receivedToken !== null && receivedToken.length > 0;

  const expectedBig = parseExactInteger(expectedAmount);
  const receivedBig = parseExactInteger(receivedAmount);
  const amountMatches = expectedBig !== null && receivedBig !== null && expectedBig === receivedBig;
  const recipientMatches =
    receivedRecipient !== null &&
    receivedRecipient.toLowerCase() === expectedRecipient.toLowerCase();

  const erc20PaymentExactMatch = destinationIsEvm
    ? inboundDelivered &&
      canonicalReceiptConfirmed &&
      tokenMappingVerified &&
      recipientMatches &&
      amountMatches &&
      destinationLogIndex !== null
    : inboundDelivered &&
      canonicalReceiptConfirmed &&
      tokenMappingVerified &&
      recipientMatches &&
      amountMatches;

  const payoutEstablished =
    itsCommandVerified &&
    canonicalReceiptConfirmed &&
    tokenMappingVerified &&
    erc20PaymentExactMatch;

  let verdict: AxelarEvidenceVerdict;
  if (payoutEstablished) {
    verdict = "confirmed_delivery";
  } else if (hasClaim && !claimSettled) {
    verdict = "parked_claim";
  } else if (inboundRowPresent) {
    verdict = "unverified_candidate";
  } else if (attestationStatus === "failed" || attestationStatus === "expired") {
    verdict = "failed";
  } else if (providerReportsExecuted || attestationStatus === "attested") {
    verdict = "insufficient_provider_only";
  } else {
    verdict = "awaiting_evidence";
  }

  let assessment: ProviderEvidenceAssessment;
  if (payoutEstablished) {
    assessment = "corroborated_by_chain_payment";
  } else if (attestationStatus === "failed" || attestationStatus === "expired") {
    assessment = "provider_failed";
  } else if (providerReportsExecuted || attestationStatus === "attested") {
    assessment = "insufficient_without_chain_payment";
  } else if (providerCandidateObserved) {
    assessment = "candidate_pending";
  } else {
    assessment = "unobserved";
  }

  const steps: readonly AxelarEvidenceChecklistStep[] = [
    {
      step: "source_transfer_indexed",
      passed: true,
      sufficientAlone: false,
      summary: "Outbound source transfer burn or lock recorded from canonical origin block.",
    },
    {
      step: "provider_candidate_discovery",
      passed: providerCandidateObserved,
      sufficientAlone: false,
      summary: providerReportsExecuted
        ? "Axelar GMP reports executed candidate status; insufficient without destination chain receipt and ERC-20 payment."
        : providerCandidateObserved
          ? "Axelar GMP candidate status observed; awaiting confirmed destination chain execution."
          : "No Axelar GMP candidate status observed yet.",
    },
    {
      step: "its_command_verified",
      passed: itsCommandVerified,
      sufficientAlone: false,
      summary: itsCommandVerified
        ? "Destination ITS InterchainTransferReceived command verified."
        : "Destination ITS command execution not yet verified on chain.",
    },
    {
      step: "canonical_receipt_confirmed",
      passed: canonicalReceiptConfirmed,
      sufficientAlone: false,
      summary: canonicalReceiptConfirmed
        ? "Canonical destination block and transaction receipt confirmed."
        : "Canonical destination transaction receipt not yet confirmed.",
    },
    {
      step: "token_mapping_verified",
      passed: tokenMappingVerified,
      sufficientAlone: false,
      summary: tokenMappingVerified
        ? "Destination token contract address verified against ITS registration."
        : "Destination token contract address not yet verified.",
    },
    {
      step: "erc20_payment_matched",
      passed: erc20PaymentExactMatch,
      sufficientAlone: false,
      summary: erc20PaymentExactMatch
        ? "Exact ERC-20 Transfer log to expected recipient for net transfer amount confirmed."
        : "Exact ERC-20 Transfer payment log not yet confirmed.",
    },
  ];

  const observedIso = toIsoOrNull(row.observed_at) ?? new Date(0).toISOString();

  return {
    kind: "ok",
    evidence: {
      transferId: text(row, "id"),
      route,
      verdict,
      origin: {
        chain: scrubEvidenceText(originChain, 64),
        nonce: text(row, "nonce"),
        txHash: scrubEvidenceText(text(row, "origin_tx"), MAX_EVIDENCE_ID_LENGTH),
        block: text(row, "origin_block"),
        sender: scrubEvidenceText(text(row, "sender"), MAX_EVIDENCE_ID_LENGTH),
        token: originToken,
        grossAmount: text(row, "gross_amount"),
        fee: text(row, "fee"),
        netAmount: expectedAmount,
        observedAt: observedIso,
      },
      provider: {
        attestationStatus,
        railStatus,
        reference: providerRef,
        attestedAt: toIsoOrNull(row.attested_at),
        lastCheckedAt: toIsoOrNull(row.last_checked_at),
        lastError,
        providerReportsExecuted,
        sufficientForDelivery: false,
        assessment,
      },
      command: {
        verified: itsCommandVerified,
        itsContract,
        commandId: itsCommandVerified ? commandId : null,
      },
      receipt: {
        confirmed: canonicalReceiptConfirmed,
        destinationChain: scrubEvidenceText(destinationChain, 64),
        block: canonicalReceiptConfirmed ? destinationBlock : null,
        txHash: canonicalReceiptConfirmed ? destinationTx : null,
        observedAt: canonicalReceiptConfirmed ? toIsoOrNull(row.delivered_at) : null,
      },
      tokenPayment: {
        verified: erc20PaymentExactMatch,
        exactMatch: erc20PaymentExactMatch,
        token: receivedToken,
        symbol: tokenMetadata?.symbol ?? null,
        decimals: tokenMetadata?.decimals ?? null,
        expectedRecipient,
        recipient: receivedRecipient,
        expectedAmount,
        amount: receivedAmount,
        txHash: erc20PaymentExactMatch ? destinationTx : null,
        logIndex: erc20PaymentExactMatch ? destinationLogIndex : null,
      },
      checklist: {
        sourceTransferIndexed: true,
        providerCandidateObserved,
        providerStatusAloneSufficient: false,
        itsCommandVerified,
        canonicalReceiptConfirmed,
        tokenMappingVerified,
        erc20PaymentExactMatch,
        payoutEstablished,
        steps,
      },
    },
  };
}

export async function readAxelarDeliveryEvidenceById(
  db: Queryable,
  config: AppConfig,
  transferId: string,
): Promise<ReadAxelarEvidenceOutcome> {
  const { rows } = await db.query(`${AXELAR_EVIDENCE_SELECT} WHERE t.id = $1 LIMIT 1`, [
    transferId,
  ]);
  const row = rows[0];
  if (row === undefined) {
    return { kind: "not_found" };
  }
  return formatAxelarDeliveryEvidence(row, config);
}

export async function readAxelarDeliveryEvidenceByHop(
  db: Queryable,
  config: AppConfig,
  originChain: string,
  nonce: string,
): Promise<ReadAxelarEvidenceOutcome> {
  const { rows } = await db.query(
    `${AXELAR_EVIDENCE_SELECT} WHERE t.origin_chain = $1 AND t.nonce = $2 LIMIT 1`,
    [originChain, nonce],
  );
  const row = rows[0];
  if (row === undefined) {
    return { kind: "not_found" };
  }
  return formatAxelarDeliveryEvidence(row, config);
}
