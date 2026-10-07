/**
 * Axelar's GMP status, which is where an Axelar transfer lives between the two chains.
 *
 * `POST /gmp/searchGMP` with the source transaction hash. The convention for "not indexed yet" is
 * the exact opposite of Circle's: Axelar answers 200 with `{"data":[],"total":0}` where Circle
 * answers 404. Both mean the same thing and neither is a failure, which is why the two clients
 * cannot share a "missing" check and why `RailLookup` has a `missing` case at all.
 *
 * The status mapping is deliberately incomplete, and that is the honest position rather than a gap.
 * Every GMP row on testnet right now reports `status: executed` with `simplified_status: received`,
 * and the API refuses a page size above twenty five, so the rest of the enum could not be observed.
 * The values below are the ones Axelar documents; anything else is recorded verbatim and logged
 * once without moving our own status, which is the same treatment the chain watchers give an event
 * tag they have never seen. Inventing the remainder of somebody else's enum would file transfers
 * under states that may not exist.
 */
import type {
  AttestationStatus,
  PendingTransfer,
  RailClient,
  RailLookup,
  RailReport,
} from "../types.js";
import { RailError } from "../types.js";

/**
 * Axelar's statuses, mapped onto ours.
 *
 * `executed` is the only one confirmed against live data. The others are from Axelar's own
 * documentation of the GMP lifecycle, and an unlisted value is reported rather than guessed.
 *
 * Note that `executed` maps to `attested` and not to `delivered`. Axelar saying it executed the
 * message is Axelar's account of its own work; `delivered` in this schema means an
 * `inbound_delivery` row exists, which is our index saying the money arrived. The two agree
 * almost always, and when they do not the one backed by a log on the destination chain is the one
 * worth believing.
 */
const MAPPING: Readonly<Record<string, AttestationStatus>> = {
  called: "pending",
  confirming: "pending",
  confirmed: "pending",
  approving: "pending",
  approved: "attested",
  executing: "attested",
  executed: "attested",
  error: "failed",
  insufficient_fee: "pending",
};

/**
 * Flags that explain a stuck transfer, in the order worth reporting.
 *
 * All of these are booleans on the row rather than part of the status, so a transfer can be
 * `called` forever with the reason sitting in a field nobody reads. The first three are the
 * recoverable ones and are precisely what the keeper exists to fix, so they stay `pending`; the
 * rest describe a call that will never work.
 */
const RECOVERABLE_FLAGS = [
  "is_insufficient_fee",
  "is_not_enough_gas",
  "not_enough_gas_to_execute",
] as const;

const FATAL_FLAGS = [
  "is_invalid_amount",
  "is_invalid_call",
  "is_invalid_contract_address",
  "is_invalid_destination_chain",
  "is_invalid_payload_hash",
  "is_invalid_source_address",
  "is_invalid_symbol",
] as const;

interface GmpRow {
  readonly status?: unknown;
  readonly simplified_status?: unknown;
  readonly message_id?: unknown;
  readonly command_id?: unknown;
  readonly executed?: { readonly block_timestamp?: unknown } | null;
  readonly approved?: { readonly block_timestamp?: unknown } | null;
  readonly [flag: string]: unknown;
}

export interface GmpOptions {
  readonly timeoutMs?: number;
  /** Injected so the unit suite can answer without a network. */
  readonly fetch?: typeof globalThis.fetch;
  /** Called once per status value this build does not know. */
  readonly onUnknownStatus?: (status: string) => void;
}

export class AxelarGmpClient implements RailClient {
  readonly rail = "axelar";
  private readonly baseUrl: string;
  private readonly request: typeof globalThis.fetch;
  private readonly reported = new Set<string>();

  constructor(
    baseUrl: string,
    private readonly options: GmpOptions = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.request = options.fetch ?? globalThis.fetch;
  }

  async look(transfer: PendingTransfer, signal?: AbortSignal): Promise<RailLookup> {
    const response = await this.send({ txHash: transfer.originTx }, signal);

    if (response.status === 429) {
      throw new RailError(this.rail, "rateLimited", "rate limited", 60_000);
    }
    if (!response.ok) {
      const kind = response.status >= 500 ? "transient" : "permanent";
      throw new RailError(this.rail, kind, `http ${String(response.status)}`);
    }

    let body: { readonly data?: unknown };
    try {
      body = (await response.json()) as { readonly data?: unknown };
    } catch (cause) {
      throw new RailError(this.rail, "transient", `response was not json: ${describe(cause)}`);
    }

    const rows = Array.isArray(body.data) ? (body.data as GmpRow[]) : [];
    const row = rows[0];
    // An empty array is Axelar's way of saying it has not indexed the transaction yet, and that
    // is what every transfer looks like for its first few blocks.
    if (row === undefined) return { kind: "missing" };

    return { kind: "found", report: this.reportFor(row) };
  }

  private reportFor(row: GmpRow): RailReport {
    const status = typeof row.status === "string" ? row.status : "";
    const simplified = typeof row.simplified_status === "string" ? row.simplified_status : null;
    const flags = [...RECOVERABLE_FLAGS, ...FATAL_FLAGS].filter((flag) => row[flag] === true);

    let mapped = MAPPING[status];
    if (mapped === undefined) {
      // A status this build has never seen. Reported once and then left alone: the row keeps the
      // rail's own word, and our status stays pending so the transfer keeps being polled rather
      // than being written off on the strength of a string nobody has read.
      if (!this.reported.has(status)) {
        this.reported.add(status);
        this.options.onUnknownStatus?.(status);
      }
      mapped = "pending";
    }
    // A fatal flag outranks the status. Axelar will happily report `called` on a message whose
    // destination address is invalid, and that is never going to arrive.
    if (FATAL_FLAGS.some((flag) => row[flag] === true)) mapped = "failed";

    const words = [status, simplified, ...flags].filter((part): part is string => part !== null);
    return {
      status: mapped,
      railStatus: words.join("/"),
      // The message id, because that is what Axelar's support asks for.
      reference: typeof row.message_id === "string" ? row.message_id : null,
      attestedAt: stampOf(row.approved) ?? stampOf(row.executed),
    };
  }

  private async send(payload: unknown, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 15_000);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    try {
      return await this.request(`${this.baseUrl}/gmp/searchGMP`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
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

/** Axelar reports its timestamps in unix seconds, inside the stage object they belong to. */
function stampOf(stage: { readonly block_timestamp?: unknown } | null | undefined): Date | null {
  const seconds = stage?.block_timestamp;
  if (typeof seconds !== "number" || seconds <= 0) return null;
  return new Date(seconds * 1000);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export { MAPPING as AXELAR_STATUS_MAPPING, FATAL_FLAGS, RECOVERABLE_FLAGS };
