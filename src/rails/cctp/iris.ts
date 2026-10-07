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

/** Circle's own two status values. There is no third, and notably no failure status. */
const PENDING = "pending_confirmations";
const COMPLETE = "complete";

/** What Circle asks for after a 429, which it does not put in a header. */
const RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;

interface IrisMessage {
  readonly message?: unknown;
  readonly eventNonce?: unknown;
  readonly attestation?: unknown;
  readonly status?: unknown;
  readonly delayReason?: unknown;
  // Both levels nullable, because the reference says `decodedMessage` is null when decoding
  // fails and `decodedMessageBody` is itself nullable inside it.
  readonly decodedMessage?: {
    readonly decodedMessageBody?: { readonly expirationBlock?: unknown } | null;
  } | null;
}

export interface IrisOptions {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Injected so the unit suite can answer without a network. */
  readonly fetch?: typeof globalThis.fetch;
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
    const url = `${this.baseUrl}/v2/messages/${String(domain)}?transactionHash=${transfer.originTx}`;

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

    let body: { readonly messages?: unknown };
    try {
      body = (await response.json()) as { readonly messages?: unknown };
    } catch (cause) {
      throw new RailError(this.rail, "transient", `response was not json: ${describe(cause)}`);
    }

    const messages = Array.isArray(body.messages) ? (body.messages as IrisMessage[]) : [];
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
  const status = typeof message.status === "string" ? message.status : "";
  const delay = typeof message.delayReason === "string" ? message.delayReason : null;
  const nonce = typeof message.eventNonce === "string" ? message.eventNonce : null;
  const attested = status === COMPLETE;

  // Kept verbatim, with the delay appended rather than dropped. `insufficient_fee` is the
  // difference between a transfer that is progressing and one that will sit until somebody
  // reattests it, and that distinction is invisible from the status alone.
  const railStatus = delay === null ? status : `${status}/${delay}`;

  const mapped: AttestationStatus = attested ? "attested" : "pending";

  return {
    status: mapped,
    // The expiry block is surfaced rather than acted on. See the note below.
    railStatus: appendExpiry(railStatus, message),
    reference: nonce,
    // Iris does not timestamp the attestation, so the moment we first saw it complete is the
    // honest answer. The writer only ever sets this column once, so it is the first such moment.
    attestedAt: attested ? new Date() : null,
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
  const raw = message.decodedMessage?.decodedMessageBody?.expirationBlock;
  if (typeof raw !== "string" && typeof raw !== "number") return railStatus;
  const block = BigInt(raw);
  return block > 0n ? `${railStatus} expires@${block.toString()}` : railStatus;
}

/**
 * Which CCTP domain a chain is, read straight off the shared registry.
 *
 * Permanent rather than transient when there is none: a chain with no CCTP domain cannot have
 * burned through CCTP, so the transfer was filed under the wrong rail and retrying the lookup
 * will keep being wrong in the same way.
 */
function domainFor(chainKey: string): number {
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
