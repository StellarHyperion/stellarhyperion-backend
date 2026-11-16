/** Axelar status lookup uses the API root and a searchGMP JSON method. */
import type {
  AttestationStatus,
  PaymentUncertainty,
  PendingTransfer,
  RailClient,
  RailLookup,
  RailProviderSignalKind,
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
  gas_unpaid: "pending",
};

/**
 * Flags that explain a stuck transfer, in the order worth reporting.
 *
 * All of these are booleans on the row rather than part of the status, so a transfer can be
 * `called` forever with the reason sitting in a field nobody reads. The first three are
 * recoverable, so they stay `pending`; the
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

export interface GmpRow {
  readonly status?: unknown;
  readonly simplified_status?: unknown;
  readonly message_id?: unknown;
  readonly id?: unknown;
  readonly call?: { readonly transactionHash?: unknown; readonly parentMessageID?: unknown } | null;
  readonly command_id?: unknown;
  readonly executed?: {
    readonly block_timestamp?: unknown;
    readonly transactionHash?: unknown;
    readonly childMessageIDs?: unknown;
  } | null;
  readonly approved?: { readonly block_timestamp?: unknown } | null;
  readonly [flag: string]: unknown;
}

export interface AxelarProviderClassification {
  readonly status: AttestationStatus;
  readonly providerSignal: RailProviderSignalKind;
  readonly unknownStatus: string | null;
  readonly execution?: { readonly txHash: `0x${string}`; readonly commandId: `0x${string}` };
  readonly paymentUncertainty?: PaymentUncertainty;
}

export function classifyAxelarGmpRow(row: GmpRow): AxelarProviderClassification {
  const status = typeof row.status === "string" ? row.status : "";
  const simplified = typeof row.simplified_status === "string" ? row.simplified_status : null;

  const hasFatalFlag = FATAL_FLAGS.some((flag) => row[flag] === true);
  if (hasFatalFlag) {
    return {
      status: "failed",
      providerSignal: "message_failed",
      unknownStatus: null,
    };
  }

  const hasRecoverableGasSignal =
    RECOVERABLE_FLAGS.some((flag) => row[flag] === true) ||
    status === "insufficient_fee" ||
    status === "gas_unpaid" ||
    simplified === "insufficient_fee" ||
    simplified === "gas_unpaid";

  if (hasRecoverableGasSignal) {
    return {
      status: "pending",
      providerSignal: "recoverable_gas_failure",
      unknownStatus: null,
    };
  }

  if (status === "error") {
    return {
      status: "failed",
      providerSignal: "message_failed",
      unknownStatus: null,
    };
  }

  const validExecution =
    typeof row.executed?.transactionHash === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test(row.executed.transactionHash) &&
    typeof row.command_id === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test(row.command_id)
      ? {
          txHash: row.executed.transactionHash as `0x${string}`,
          commandId: row.command_id as `0x${string}`,
        }
      : undefined;

  if (status === "executed") {
    return {
      status: "attested",
      providerSignal: "candidate_executed",
      unknownStatus: null,
      ...(validExecution !== undefined
        ? { execution: validExecution }
        : {
            paymentUncertainty: {
              kind: "payout_unverified",
              reason: "missing_execution_coordinates",
            },
          }),
    };
  }

  if (status === "approved" || status === "executing") {
    return {
      status: "attested",
      providerSignal: "candidate_approved",
      unknownStatus: null,
      ...(validExecution !== undefined ? { execution: validExecution } : {}),
    };
  }

  if (
    status === "called" ||
    status === "confirming" ||
    status === "confirmed" ||
    status === "approving"
  ) {
    return {
      status: "pending",
      providerSignal: "in_progress",
      unknownStatus: null,
    };
  }

  return {
    status: "pending",
    providerSignal: "unknown_status",
    unknownStatus: status,
  };
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
    const rows = await this.rowsFor(transfer.originTx, signal);
    const hash = normalized(transfer.originTx);
    const matched = rows.filter((item) =>
      [
        item.call?.transactionHash,
        typeof item.call?.parentMessageID === "string"
          ? item.call.parentMessageID.split("-")[0]
          : undefined,
      ].some((value) => normalized(value) === hash),
    );
    const executed = matched.find((item) => this.reportFor(item).execution !== undefined);
    if (executed) return { kind: "found", report: this.reportFor(executed) };
    let selected = matched[0];
    // A Stellar ITS call executes first on the hub. The source lookup may return only that row.
    // Follow the explicitly linked child, and require its parent and message id to match.
    let remaining = 4;
    for (const parent of matched) {
      const parentId = typeof parent.message_id === "string" ? parent.message_id : parent.id;
      const children = parent.executed?.childMessageIDs;
      if (typeof parentId !== "string" || !Array.isArray(children)) continue;
      for (const childId of children) {
        if (remaining <= 0) break;
        if (typeof childId !== "string" || !/^0x[0-9a-fA-F]{64}-\d+$/.test(childId)) continue;
        remaining -= 1;
        const forwarded = await this.rowsFor(childId.split("-")[0] ?? "", signal);
        const child = forwarded.find(
          (item) =>
            normalized(item.call?.parentMessageID) === normalized(parentId) &&
            normalized(item.message_id ?? item.id) === normalized(childId),
        );
        if (!child) continue;
        if (this.reportFor(child).execution)
          return { kind: "found", report: this.reportFor(child) };
        selected = child;
      }
    }
    return selected ? { kind: "found", report: this.reportFor(selected) } : { kind: "missing" };
  }

  private async rowsFor(txHash: string, signal?: AbortSignal): Promise<GmpRow[]> {
    const response = await this.send({ txHash }, signal);
    if (response.status === 429)
      throw new RailError(this.rail, "rateLimited", "rate limited", 60_000);
    if (!response.ok)
      throw new RailError(
        this.rail,
        response.status >= 500 ? "transient" : "permanent",
        `http ${String(response.status)}`,
      );
    let body: { readonly data?: unknown };
    try {
      body = (await response.json()) as { readonly data?: unknown };
    } catch (cause) {
      throw new RailError(this.rail, "transient", `response was not json: ${describe(cause)}`);
    }
    if (!Array.isArray(body.data))
      throw new RailError(this.rail, "transient", "status API returned an invalid data field");
    return body.data as GmpRow[];
  }

  private reportFor(row: GmpRow): RailReport {
    const status = typeof row.status === "string" ? row.status : "";
    const simplified = typeof row.simplified_status === "string" ? row.simplified_status : null;
    const flags = [...RECOVERABLE_FLAGS, ...FATAL_FLAGS].filter((flag) => row[flag] === true);
    const classified = classifyAxelarGmpRow(row);

    if (classified.unknownStatus !== null && !this.reported.has(classified.unknownStatus)) {
      this.reported.add(classified.unknownStatus);
      this.options.onUnknownStatus?.(classified.unknownStatus);
    }

    const words = [status, simplified, ...flags].filter((part): part is string => part !== null);
    return {
      status: classified.status,
      providerSignal: classified.providerSignal,
      railStatus: words.join("/"),
      // The message id, because that is what Axelar's support asks for.
      reference: typeof row.message_id === "string" ? row.message_id : null,
      attestedAt: stampOf(row.approved) ?? stampOf(row.executed),
      ...(classified.execution !== undefined ? { execution: classified.execution } : {}),
      ...(classified.paymentUncertainty !== undefined
        ? { paymentUncertainty: classified.paymentUncertainty }
        : {}),
    };
  }

  private async send(payload: unknown, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 15_000);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    try {
      return await this.request(this.baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ ...(payload as Record<string, unknown>), method: "searchGMP" }),
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

function normalized(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase().replace(/^0x/, "") : "";
}
