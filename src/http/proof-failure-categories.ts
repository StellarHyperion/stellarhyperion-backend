export const PROOF_FAILURE_CATEGORIES = [
  "recipient",
  "token",
  "amount",
  "finality",
  "provider_inconsistency",
] as const;

export type ProofFailureCategory = (typeof PROOF_FAILURE_CATEGORIES)[number];

/** Map internal decoder/provider wording to a bounded public metric label. */
export function normalizeProofFailureReason(reason: string): ProofFailureCategory {
  const value = reason.toLowerCase();
  if (
    [
      "receipt_missing",
      "receipt_reverted",
      "receipt_unavailable",
      "confirmations_pending",
      "non_canonical_receipt",
      "finality_mismatch",
    ].includes(value)
  )
    return "finality";
  if (["fee_mismatch", "amount_mismatch"].includes(value)) return "amount";
  if (["token_mismatch", "messenger_mismatch", "source_adapter_mismatch"].includes(value))
    return "token";
  if (["recipient_mismatch", "destination_domain_mismatch"].includes(value)) return "recipient";
  if (/(recipient|receiver|destination)/.test(value)) return "recipient";
  if (/(token|asset|contract|address)/.test(value)) return "token";
  if (/(amount|value|decim|overflow|underflow)/.test(value)) return "amount";
  if (/(final|confirm|block|ledger|canonical|reorg)/.test(value)) return "finality";
  return "provider_inconsistency";
}

export function emptyProofFailureCategories(): Record<ProofFailureCategory, number> {
  return Object.fromEntries(PROOF_FAILURE_CATEGORIES.map((category) => [category, 0])) as Record<
    ProofFailureCategory,
    number
  >;
}
