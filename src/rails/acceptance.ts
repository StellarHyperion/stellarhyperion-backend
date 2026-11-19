/**
 * Admission for a lane is deliberately separate from a provider's status.
 * A provider can discover a message and call it complete before the destination chain has
 * finalized the matching payment. Missing prerequisites remain visible to operators.
 */
export interface LaneAcceptanceEvidence {
  readonly sourceIndexed: boolean;
  readonly providerDiscovered: boolean;
  readonly destinationReceiptVerified: boolean;
  readonly paymentMatched: boolean;
  readonly tokenMatched: boolean;
  readonly amountMatched: boolean;
  readonly networkMatched: boolean;
}

export interface LaneAcceptanceReport {
  readonly state: "accepted" | "blocked";
  readonly prerequisites: readonly string[];
  readonly reason: string;
}

const REQUIREMENTS: readonly [keyof LaneAcceptanceEvidence, string][] = [
  ["sourceIndexed", "source indexing"],
  ["providerDiscovered", "provider discovery"],
  ["destinationReceiptVerified", "finalized destination receipt"],
  ["paymentMatched", "canonical destination payment"],
  ["tokenMatched", "token identity"],
  ["amountMatched", "integer amount"],
  ["networkMatched", "network identity"],
];

export function evaluateLaneAcceptance(evidence: LaneAcceptanceEvidence): LaneAcceptanceReport {
  const prerequisites = REQUIREMENTS.filter(([key]) => !evidence[key]).map(([, label]) => label);
  if (prerequisites.length === 0) {
    return {
      state: "accepted",
      prerequisites: [],
      reason: "source and destination evidence independently verified",
    };
  }
  return {
    state: "blocked",
    prerequisites,
    reason: `lane remains blocked; missing ${prerequisites.join(", ")}`,
  };
}
