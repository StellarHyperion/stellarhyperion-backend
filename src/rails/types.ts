/**
 * The part of a transfer's life neither chain can tell you about, and one vocabulary for it.
 *
 * A transfer leaves one chain and arrives on another, and in between it exists only as an entry in
 * a rail's own API. Each rail names those states differently: Circle says `pending_confirmations`
 * and `complete`, Axelar says `called`, `approved`, `executed`, `error`. An operator reading one
 * table should not have to learn four sets of words, so everything is mapped onto the five the
 * schema's check constraint allows, and the rail's own word is kept verbatim alongside it so a
 * support question can be taken straight to them.
 *
 * `missing` is a state and not an error, which is the single most important thing in this file.
 * Both rails report a transfer they have not indexed yet, and they report it differently: Circle
 * returns 404 and Axelar returns 200 with an empty array. Treating either as a failure would make
 * every transfer in flight look broken and would spend the backoff on the normal case.
 */

/**
 * Hyperion's own five words.
 *
 * `delivered` is deliberately not something a rail tells us. It means an `inbound_delivery` row
 * exists for the hop, which is our own index saying the money arrived, and that is a stronger
 * claim than any rail's opinion about whether it will.
 */
export type AttestationStatus = "pending" | "attested" | "delivered" | "failed" | "expired";

/** Terminal states. Nothing polls a transfer again once it reaches one. */
export const TERMINAL: readonly AttestationStatus[] = ["delivered", "failed", "expired"];

export type RecoverableTerminalStatus = "failed" | "expired";

export function isTerminal(status: AttestationStatus): boolean {
  return TERMINAL.includes(status);
}

export function isRecoverableTerminalStatus(
  status: AttestationStatus,
): status is RecoverableTerminalStatus {
  return status === "failed" || status === "expired";
}

export interface RailReport {
  readonly forwardTxHash?: `0x${string}`;
  readonly execution?: { readonly txHash: `0x${string}`; readonly commandId: `0x${string}` };
  readonly status: AttestationStatus;
  /**
   * The rail's own word for it, verbatim.
   *
   * Where a rail also explains a delay, the explanation is appended rather than dropped:
   * `pending_confirmations/insufficient_fee` is still Circle's vocabulary, and the reason is the
   * difference between a transfer that is progressing and one that will sit forever until somebody
   * tops up a fee.
   */
  readonly railStatus: string;
  /** The identifier to quote at the rail's support. Circle's event nonce, Axelar's message id. */
  readonly reference: string | null;
  readonly attestedAt: Date | null;
  readonly message?: string | null;
  readonly messageBytes?: string | null;
  readonly attestation?: string | null;
  readonly attestationSignature?: string | null;
  readonly attestationTimestamp?: Date | null;
  readonly fastTransfer?: boolean;
}

export type RailLookup =
  /** The rail has not indexed this transfer yet. Normal, and not a failure. */
  { readonly kind: "missing" } | { readonly kind: "found"; readonly report: RailReport };

export type RailErrorKind =
  /** Worth another go: a timeout, a 5xx, a body that did not parse. */
  | "transient"
  /** Will be wrong the same way next time: a malformed request, an unsupported domain. */
  | "permanent"
  /**
   * The rail has asked us to stop for a while.
   *
   * Circle's documented behaviour is the reason this is its own kind rather than a transient with
   * a status code: exceeding forty requests a second blocks *every* request for the next five
   * minutes. A poller that backed off a second and tried again would spend those five minutes
   * refreshing the block.
   */
  | "rateLimited";

export class RailError extends Error {
  constructor(
    readonly rail: string,
    readonly kind: RailErrorKind,
    reason: string,
    /** How long the rail has asked us to wait, when it says. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(`${rail}: ${reason}`);
    this.name = "RailError";
  }
}

/** One transfer waiting on a rail, as the queue hands it over. */
export interface PendingTransfer {
  readonly transferId: bigint;
  readonly route: number;
  readonly originChain: string;
  readonly destinationChain: string;
  readonly nonce: bigint;
  readonly originTx: string;
  /** Null until the first check. */
  readonly status: AttestationStatus | null;
  readonly checkFailures: number;
  /** True when an inbound delivery already exists, which settles it without asking the rail. */
  readonly delivered: boolean;
}

/** What a rail client has to offer the pass that polls it. */
export interface RailClient {
  readonly rail: string;
  /** Throws `RailError`; returns `missing` rather than throwing for a transfer not yet indexed. */
  look(transfer: PendingTransfer, signal?: AbortSignal): Promise<RailLookup>;
}

export type RequeueSelector =
  { readonly transferId: bigint } | { readonly originChain: string; readonly nonce: bigint };

export interface RequeueTransferRequest {
  readonly selector: RequeueSelector;
  readonly reviewedBy: string;
  readonly reason: string;
  readonly evidenceReference?: string | null | undefined;
  readonly at?: Date | undefined;
}

export interface PreservedTransferIdentity {
  readonly transferId: bigint;
  readonly originChain: string;
  readonly route: number;
  readonly nonce: bigint;
  readonly sender: string;
  readonly token: string;
  readonly grossAmount: bigint;
  readonly fee: bigint;
  readonly netAmount: bigint;
  readonly destinationChain: string;
  readonly destination: string;
  readonly railRef: string | null;
  readonly originBlock: bigint;
  readonly originTx: string;
  readonly originLogIndex: number | null;
}

export interface RequeueAuditEntry {
  readonly id: bigint;
  readonly transferId: bigint;
  readonly route: number;
  readonly originChain: string;
  readonly nonce: bigint;
  readonly priorStatus: RecoverableTerminalStatus;
  readonly newStatus: "pending";
  readonly priorRailStatus: string | null;
  readonly priorRailReference: string | null;
  readonly priorCheckFailures: number;
  readonly reviewedBy: string;
  readonly reviewedReason: string;
  readonly evidenceReference: string | null;
  readonly requeuedAt: Date;
}

export type RequeueRefusalCode =
  "not_found" | "missing_attestation" | "already_delivered" | "not_terminal";

export type RequeueTransferOutcome =
  | {
      readonly kind: "requeued";
      readonly audit: RequeueAuditEntry;
      readonly transfer: PreservedTransferIdentity;
    }
  | {
      readonly kind: "refused";
      readonly code: RequeueRefusalCode;
      readonly detail: string;
      readonly currentStatus: AttestationStatus | null;
      readonly transfer?: PreservedTransferIdentity | undefined;
    };
