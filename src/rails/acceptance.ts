/**
 * Admission for a lane is deliberately separate from a provider's status.
 * A provider can discover a message and call it complete before the destination chain has
 * finalized the matching payment. Missing prerequisites remain visible to operators.
 */
import { createPublicKey, verify } from "node:crypto";

export interface LaneAcceptanceEvidence {
  readonly sourceIndexed: boolean;
  readonly providerDiscovered: boolean;
  readonly destinationReceiptVerified: boolean;
  readonly paymentMatched: boolean;
  readonly tokenMatched: boolean;
  readonly amountMatched: boolean;
  readonly networkMatched: boolean;
}

/** Public, independently signed acceptance. Trusted keys come from the owning deployment review. */
export interface SignedLaneAcceptance {
  readonly network: string;
  readonly sourceChain: string;
  readonly destinationChain: string;
  readonly token: string;
  readonly representation: string;
  readonly decimals: number;
  readonly sourceTransaction: string;
  readonly sourceBlockHash: string;
  readonly destinationTransaction: string;
  readonly destinationBlockHash: string;
  readonly amount: string;
  readonly sourceSignature: string;
  readonly destinationSignature: string;
}

export interface LaneAcceptancePolicy {
  readonly network: string;
  readonly sourceChain: string;
  readonly destinationChain: string;
  readonly token: string;
  readonly representation: string;
  readonly decimals: number;
  readonly sourcePublicKey: string;
  readonly destinationPublicKey: string;
}

/** Stable, domain-separated bytes bind both reviewers to exactly the same public payment. */
export function laneAcceptancePayload(proof: SignedLaneAcceptance): Buffer {
  return Buffer.from(
    JSON.stringify([
      "hyperion-lane-acceptance-v1",
      proof.network,
      proof.sourceChain,
      proof.destinationChain,
      proof.token,
      proof.representation,
      proof.decimals,
      proof.sourceTransaction,
      proof.sourceBlockHash,
      proof.destinationTransaction,
      proof.destinationBlockHash,
      proof.amount,
    ]),
  );
}

function signedPaymentMatches(proof: SignedLaneAcceptance, policy: LaneAcceptancePolicy): boolean {
  try {
    if (
      ![
        proof.network,
        proof.sourceChain,
        proof.destinationChain,
        proof.token,
        proof.representation,
      ].every((value) => value.length > 0 && value.length <= 256)
    )
      return false;
    if (
      !["network", "sourceChain", "destinationChain", "token", "representation", "decimals"].every(
        (key) =>
          proof[key as keyof SignedLaneAcceptance] === policy[key as keyof LaneAcceptancePolicy],
      )
    )
      return false;
    if (
      !Number.isInteger(proof.decimals) ||
      proof.decimals < 0 ||
      proof.decimals > 18 ||
      !/^[1-9][0-9]{0,77}$/.test(proof.amount) ||
      BigInt(proof.amount) > (1n << 256n) - 1n ||
      ![
        proof.sourceTransaction,
        proof.sourceBlockHash,
        proof.destinationTransaction,
        proof.destinationBlockHash,
      ].every((value) => /^(0x)?[0-9a-fA-F]{64}$/.test(value))
    )
      return false;
    const source = createPublicKey(policy.sourcePublicKey);
    const destination = createPublicKey(policy.destinationPublicKey);
    if (
      source.asymmetricKeyType !== "ed25519" ||
      destination.asymmetricKeyType !== "ed25519" ||
      source
        .export({ type: "spki", format: "der" })
        .equals(destination.export({ type: "spki", format: "der" }))
    )
      return false;
    if (
      ![proof.sourceSignature, proof.destinationSignature].every((value) =>
        /^[0-9a-fA-F]{128}$/.test(value),
      )
    )
      return false;
    const payload = laneAcceptancePayload(proof);
    return (
      verify(null, payload, source, Buffer.from(proof.sourceSignature, "hex")) &&
      verify(null, payload, destination, Buffer.from(proof.destinationSignature, "hex"))
    );
  } catch {
    return false;
  }
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

export function evaluateLaneAcceptance(
  evidence: LaneAcceptanceEvidence,
  proof?: SignedLaneAcceptance,
  policy?: LaneAcceptancePolicy,
): LaneAcceptanceReport {
  const prerequisites = REQUIREMENTS.filter(([key]) => !evidence[key]).map(([, label]) => label);
  if (proof === undefined || policy === undefined || !signedPaymentMatches(proof, policy)) {
    prerequisites.push(
      "independent signed source/destination payment with matching token representation, precision and network",
    );
  }
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
