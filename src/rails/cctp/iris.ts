/**
 * Circle's Iris, which is where a CCTP transfer lives between the burn and the mint.
 *
 * Lookup is by the source transaction hash, which the indexer already has in
 * `outbound_transfer.origin_tx`. The alternative is deriving the message hash from the burn, and
 * there is no reason to: `GET /v2/messages/{domain}?transactionHash=` takes the hash directly, and
 * the `railRef` on a CCTP `BridgeOut` is a word of zeroes anyway.
 *
 * Three things measured against the sandbox rather than assumed, because all three change what the
 * code has to do:
 *
 * A 404 is the pending state. An unknown transaction comes back `404` with
 * `{"error":"Message not found for provided parameters"}`, and that is what every transfer looks
 * like for the first minute of its life. Classifying a 4xx as a failure the way the Soroban RPC
 * client does would make the normal case look broken and would spend the backoff on it. A 400,
 * `{"error":"Invalid source domain id"}`, genuinely is permanent.
 *
 * There are two error body shapes. The API reference documents `{code, message}` and the live
 * sandbox returns `{error}`. Both are read, because a client that only understands the documented
 * one reports "unparseable" for every real error it ever sees.
 *
 * A 429 is not an ordinary retry. Circle's documented behaviour is that exceeding forty requests a
 * second blocks *every* request for the next five minutes, so it is reported as its own error kind
 * with that wait attached, and the pass holds off rather than doubling from a second.
 */
import { CHAINS, IRIS_API, isChainKey, type NetworkMode } from "@hyperion/protocol";

import type {
  PendingTransfer,
  RailClient,
  RailLookup,
  RailReport,
  AttestationStatus,
} from "../types.js";
import { RailError } from "../types.js";

/** Circle's own status values. */
const PENDING = "pending_confirmations";
const COMPLETE = "complete";

const ATTESTED_STATUSES = new Set([
  "complete",
  "completed",
  "attested",
  "signed",
  "fast_complete",
  "fast_attested",
]);

const FAILED_STATUSES = new Set(["failed", "canceled", "cancelled"]);
const EXPIRED_STATUSES = new Set(["expired"]);

/** What Circle asks for after a 429, which it does not put in a header. */
const RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;

export interface FastAttestationMetadata {
  readonly signature?: unknown;
  readonly attestation?: unknown;
  readonly timestamp?: unknown;
  readonly attestationTimestamp?: unknown;
  readonly expirationBlock?: unknown;
  readonly status?: unknown;
}

export interface IrisMessage {
  readonly message?: unknown;
  readonly messageBytes?: unknown;
  readonly rawMessage?: unknown;
  readonly eventNonce?: unknown;
  readonly messageId?: unknown;
  readonly id?: unknown;
  readonly attestation?: unknown;
  readonly signature?: unknown;
  readonly attestationSignature?: unknown;
  readonly attestationTimestamp?: unknown;
  readonly attestedAt?: unknown;
  readonly timestamp?: unknown;
  readonly createdAt?: unknown;
  readonly status?: unknown;
  readonly delayReason?: unknown;
  readonly fastAttestation?: FastAttestationMetadata | null;
  readonly isFastTransfer?: unknown;
  readonly fastTransfer?: unknown;
  readonly attestationType?: unknown;
  // Both levels nullable, because the reference says `decodedMessage` is null when decoding
  // fails and `decodedMessageBody` is itself nullable inside it.
  readonly decodedMessage?: {
    readonly decodedMessageBody?: { readonly expirationBlock?: unknown } | null;
  } | null;
}

export function isIrisMessage(value: unknown): value is IrisMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const msg = value as Record<string, unknown>;

  const recognizedKeys = [
    "status",
    "message",
    "messageBytes",
    "rawMessage",
    "eventNonce",
    "messageId",
    "id",
    "attestation",
    "signature",
    "attestationSignature",
    "attestationTimestamp",
    "attestedAt",
    "timestamp",
    "createdAt",
    "delayReason",
    "fastAttestation",
    "isFastTransfer",
    "fastTransfer",
    "attestationType",
    "decodedMessage",
  ];
  if (!recognizedKeys.some((k) => k in msg)) return false;

  if ("status" in msg && msg.status !== null && typeof msg.status !== "string") return false;
  if ("message" in msg && msg.message !== null && typeof msg.message !== "string") return false;
  if ("messageBytes" in msg && msg.messageBytes !== null && typeof msg.messageBytes !== "string") {
    return false;
  }
  if ("rawMessage" in msg && msg.rawMessage !== null && typeof msg.rawMessage !== "string") {
    return false;
  }
  if ("attestation" in msg && msg.attestation !== null && typeof msg.attestation !== "string") {
    return false;
  }
  if ("signature" in msg && msg.signature !== null && typeof msg.signature !== "string") {
    return false;
  }
  if (
    "attestationSignature" in msg &&
    msg.attestationSignature !== null &&
    typeof msg.attestationSignature !== "string"
  ) {
    return false;
  }
  if (
    "eventNonce" in msg &&
    msg.eventNonce !== null &&
    typeof msg.eventNonce !== "string" &&
    typeof msg.eventNonce !== "number"
  ) {
    return false;
  }
  if (
    "fastAttestation" in msg &&
    msg.fastAttestation !== null &&
    (typeof msg.fastAttestation !== "object" || Array.isArray(msg.fastAttestation))
  ) {
    return false;
  }
  if (
    "decodedMessage" in msg &&
    msg.decodedMessage !== null &&
    (typeof msg.decodedMessage !== "object" || Array.isArray(msg.decodedMessage))
  ) {
    return false;
  }
  return true;
}

export interface IrisEnvelope {
  readonly messages?: readonly unknown[];
  readonly data?: readonly unknown[];
  readonly message?: unknown;
  readonly pagination?: unknown;
  readonly sourceTxHash?: unknown;
}

export type IrisResponsePayload = readonly unknown[] | IrisEnvelope;

export function isIrisResponsePayload(value: unknown): value is IrisResponsePayload {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return true;
  const obj = value as Record<string, unknown>;
  const hasMessages = "messages" in obj;
  const hasData = "data" in obj;
  const hasMessage = "message" in obj;
  if (!hasMessages && !hasData && !hasMessage) {
    return false;
  }
  if (hasMessages && !Array.isArray(obj.messages)) return false;
  if (hasData && !Array.isArray(obj.data)) return false;
  if (
    hasMessage &&
    obj.message !== null &&
    (typeof obj.message !== "object" || Array.isArray(obj.message))
  ) {
    return false;
  }
  if (
    "pagination" in obj &&
    (typeof obj.pagination !== "object" || obj.pagination === null || Array.isArray(obj.pagination))
  ) {
    return false;
  }
  return true;
}

export function isIrisEnvelope(value: IrisResponsePayload): value is IrisEnvelope {
  return !Array.isArray(value);
}

export interface IrisOptions {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Injected so the unit suite can answer without a network. */
  readonly fetch?: typeof globalThis.fetch;
  readonly page?: number;
  readonly pageSize?: number;
}

export class IrisClient implements RailClient {
  readonly rail = "cctp";
  private readonly baseUrl: string;
  private readonly request: typeof globalThis.fetch;

  constructor(
    network: NetworkMode,
    private readonly options: IrisOptions = {},
  ) {
    // From the shared registry rather than a constant here. There is one description of where
    // Circle lives and the backend is not allowed its own opinion about it.
    this.baseUrl = (options.baseUrl ?? IRIS_API[network]).replace(/\/+$/, "");
    this.request = options.fetch ?? globalThis.fetch;
  }

  async look(transfer: PendingTransfer, signal?: AbortSignal): Promise<RailLookup> {
    const domain = domainFor(transfer.originChain);
    let url = `${this.baseUrl}/v2/messages/${String(domain)}?transactionHash=${transfer.originTx}`;
    if (this.options.page !== undefined) {
      url += `&page=${encodeURIComponent(String(this.options.page))}`;
    }
    if (this.options.pageSize !== undefined) {
      url += `&pageSize=${encodeURIComponent(String(this.options.pageSize))}`;
    }

    const response = await this.send(url, signal);

    if (response.status === 404) return { kind: "missing" };
    if (response.status === 429) {
      throw new RailError(
        this.rail,
        "rateLimited",
        "rate limited, and Circle blocks every request for five minutes after one",
        RATE_LIMIT_COOLDOWN_MS,
      );
    }
    if (!response.ok) {
      const detail = await describeError(response);
      // 5xx is worth another go. Any other 4xx was a bad request and will be bad the same way.
      const kind = response.status >= 500 ? "transient" : "permanent";
      throw new RailError(this.rail, kind, `http ${String(response.status)}: ${detail}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      throw new RailError(this.rail, "transient", `response was not json: ${describe(cause)}`);
    }

    if (!isIrisResponsePayload(body)) {
      throw new RailError(this.rail, "transient", "invalid iris response payload format");
    }

    let rawList: readonly unknown[] = [];
    if (Array.isArray(body)) {
      rawList = body;
    } else if (isIrisEnvelope(body)) {
      if (Array.isArray(body.data) && body.data.length > 0) {
        rawList = body.data;
      } else if (Array.isArray(body.messages) && body.messages.length > 0) {
        rawList = body.messages;
      } else if (Array.isArray(body.data)) {
        rawList = body.data;
      } else if (Array.isArray(body.messages)) {
        rawList = body.messages;
      } else if (body.message !== undefined && body.message !== null) {
        rawList = [body.message];
      }
    }

    const messages = rawList.filter(isIrisMessage);
    if (rawList.length > 0 && messages.length === 0) {
      throw new RailError(this.rail, "transient", "invalid iris message in response payload");
    }
    const message = messages[0];
    // A 200 with no messages is the same situation as a 404 and both happen. Reporting it as a
    // failure would be reporting the normal case.
    if (message === undefined) return { kind: "missing" };

    return { kind: "found", report: reportFor(message) };
  }

  private async send(url: string, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 15_000);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    try {
      return await this.request(url, {
        headers: { accept: "application/json" },
        signal: combined,
      });
    } catch (cause) {
      const aborted = signal?.aborted === true;
      throw new RailError(
        this.rail,
        aborted ? "permanent" : "transient",
        aborted ? "cancelled" : describe(cause),
      );
    }
  }
}

/**
 * Map one Iris message onto our vocabulary.
 *
 * Circle has two statuses and we have five, so three of ours cannot come from `status` and do not
 * pretend to. `delivered` comes from our own inbound index and never from here. `failed` has no
 * Iris equivalent at all. `expired` is read from the burn's own `expirationBlock`, which is the
 * only thing Circle offers that means a transfer will not complete as it stands.
 */
export function reportFor(message: IrisMessage): RailReport {
  const rawStatus =
    typeof message.status === "string"
      ? message.status
      : typeof message.fastAttestation?.status === "string"
        ? message.fastAttestation.status
        : "";
  const statusLower = rawStatus.toLowerCase();
  const delay = typeof message.delayReason === "string" ? message.delayReason : null;
  const nonce =
    typeof message.eventNonce === "string"
      ? message.eventNonce
      : typeof message.eventNonce === "number"
        ? String(message.eventNonce)
        : typeof message.messageId === "string"
          ? message.messageId
          : typeof message.id === "string"
            ? message.id
            : null;

  let mapped: AttestationStatus;
  if (ATTESTED_STATUSES.has(statusLower)) {
    mapped = "attested";
  } else if (FAILED_STATUSES.has(statusLower)) {
    mapped = "failed";
  } else if (EXPIRED_STATUSES.has(statusLower)) {
    mapped = "expired";
  } else {
    mapped = "pending";
  }

  const attested = mapped === "attested";

  const messageBytes =
    typeof message.message === "string"
      ? message.message
      : typeof message.messageBytes === "string"
        ? message.messageBytes
        : typeof message.rawMessage === "string"
          ? message.rawMessage
          : null;

  let attestationSignature: string | null = null;
  if (
    typeof message.attestation === "string" &&
    message.attestation.length > 0 &&
    message.attestation !== "PENDING"
  ) {
    attestationSignature = message.attestation;
  } else if (typeof message.signature === "string") {
    attestationSignature = message.signature;
  } else if (typeof message.attestationSignature === "string") {
    attestationSignature = message.attestationSignature;
  } else if (typeof message.fastAttestation === "object" && message.fastAttestation !== null) {
    const fast = message.fastAttestation;
    if (typeof fast.signature === "string") {
      attestationSignature = fast.signature;
    } else if (typeof fast.attestation === "string" && fast.attestation !== "PENDING") {
      attestationSignature = fast.attestation;
    }
  }

  let attestationTimestamp: Date | null = null;
  const rawTimestamp =
    message.attestationTimestamp ??
    message.attestedAt ??
    message.timestamp ??
    message.createdAt ??
    (typeof message.fastAttestation === "object" && message.fastAttestation !== null
      ? (message.fastAttestation.timestamp ?? message.fastAttestation.attestationTimestamp)
      : undefined);

  if (rawTimestamp instanceof Date) {
    attestationTimestamp = rawTimestamp;
  } else if (typeof rawTimestamp === "number") {
    attestationTimestamp = new Date(rawTimestamp < 1e11 ? rawTimestamp * 1000 : rawTimestamp);
  } else if (typeof rawTimestamp === "string") {
    const parsed = new Date(rawTimestamp);
    if (!Number.isNaN(parsed.getTime())) {
      attestationTimestamp = parsed;
    }
  }

  const isFast =
    message.isFastTransfer === true ||
    message.fastTransfer === true ||
    message.attestationType === "fast" ||
    statusLower.includes("fast") ||
    Boolean(message.fastAttestation);

  let railStatus = delay === null ? rawStatus : `${rawStatus}/${delay}`;
  railStatus = appendExpiry(railStatus, message);

  return {
    status: mapped,
    railStatus,
    reference: nonce,
    attestedAt: attested ? (attestationTimestamp ?? new Date()) : null,
    message: messageBytes,
    messageBytes,
    attestation: attestationSignature,
    attestationSignature,
    attestationTimestamp,
    fastTransfer: isFast,
  };
}

/**
 * Show a fast transfer's expiry block without claiming to have judged it.
 *
 * `expired` is one of our five states and this client cannot decide it. `expirationBlock` is a
 * block number on the source chain, and comparing it against anything needs that chain's current
 * height, which this client has no connection to and should not open one for. Guessing would be
 * worse than not knowing in a specific way: a transfer wrongly marked expired is terminal, so it
 * stops being polled and stops being chased.
 *
 * So the number goes into the rail's own status string, where an operator can see it, and the
 * comparison waits for whoever has both numbers. The EVM watcher already tracks the height per
 * chain, so the natural home is the pass once it is given that.
 */
function appendExpiry(railStatus: string, message: IrisMessage): string {
  const raw =
    message.decodedMessage?.decodedMessageBody?.expirationBlock ??
    (typeof message.fastAttestation === "object" && message.fastAttestation !== null
      ? message.fastAttestation.expirationBlock
      : undefined);
  if (typeof raw !== "string" && typeof raw !== "number") return railStatus;
  try {
    const block = BigInt(raw);
    return block > 0n && !railStatus.includes("expires@")
      ? `${railStatus} expires@${block.toString()}`
      : railStatus;
  } catch {
    return railStatus;
  }
}

/** Updated and expanded CCTP domain mappings across ecosystems. */
export const CCTP_DOMAINS: Readonly<Record<string, number>> = {
  ethereum: 0,
  sepolia: 0,
  avalanche: 1,
  "avalanche-fuji": 1,
  fuji: 1,
  optimism: 2,
  "optimism-sepolia": 2,
  arbitrum: 3,
  "arbitrum-sepolia": 3,
  noble: 4,
  solana: 5,
  "solana-devnet": 5,
  base: 6,
  "base-sepolia": 6,
  polygon: 7,
  "polygon-amoy": 7,
  sui: 8,
  "sui-testnet": 8,
  aptos: 9,
  "aptos-testnet": 9,
  arc: 26,
  "arc-testnet": 26,
  stellar: 27,
  "stellar-testnet": 27,
};

/**
 * Which CCTP domain a chain is, read straight off the shared registry or updated domain mapping.
 *
 * Permanent rather than transient when there is none: a chain with no CCTP domain cannot have
 * burned through CCTP, so the transfer was filed under the wrong rail and retrying the lookup
 * will keep being wrong in the same way.
 */
export function domainFor(chainKey: string): number {
  const normalized = chainKey.toLowerCase();
  if (normalized in CCTP_DOMAINS) {
    const domain = CCTP_DOMAINS[normalized];
    if (domain !== undefined) return domain;
  }
  // Guarded rather than cast. The chain key arrives from a database column, so asserting it is a
  // registry key would turn a renamed chain into an undefined read three lines later.
  const domain = isChainKey(chainKey) ? CHAINS[chainKey].cctpDomain : null;
  if (domain === null) {
    throw new RailError(
      "cctp",
      "permanent",
      `${chainKey} has no CCTP domain in the chain registry, so it cannot have burned through CCTP`,
    );
  }
  return domain;
}

async function describeError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown; message?: unknown };
    // Two shapes, both real: the reference documents `{code, message}` and the sandbox returns
    // `{error}`.
    if (typeof body.error === "string") return body.error;
    if (typeof body.message === "string") return body.message;
    return "no reason given";
  } catch {
    return "no reason given";
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export { PENDING as IRIS_PENDING, COMPLETE as IRIS_COMPLETE, RATE_LIMIT_COOLDOWN_MS };
