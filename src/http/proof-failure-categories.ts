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
  if (/(recipient|receiver|destination)/.test(value)) return "recipient";
  if (/(token|asset|contract|address)/.test(value)) return "token";
  if (/(amount|value|decim|overflow|underflow)/.test(value)) return "amount";
  if (/(final|confirm|block|ledger|canonical|reorg)/.test(value)) return "finality";
  return "provider_inconsistency";
}

export function emptyProofFailureCategories(): Record<ProofFailureCategory, number> {
  return Object.fromEntries(PROOF_FAILURE_CATEGORIES.map((category) => [category, 0])) as Record<ProofFailureCategory, number>;
}
