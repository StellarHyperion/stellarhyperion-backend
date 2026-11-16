/** Axelar status lookup uses the API root and a searchGMP JSON method. */
import type { Queryable } from "../../db/pool.js";
import type {
  AttestationStatus,
  PendingTransfer,
  RailClient,
  RailLookup,
  RailReport,
} from "../types.js";
import { RailError } from "../types.js";
import {
  extractProviderReference,
  recordQuarantinedAxelarSchema,
  type AxelarSchemaDriftKind,
  type AxelarSchemaParserRegistry,
  type QuarantinedAxelarEntryInput,
} from "./quarantine.js";

export {
  AxelarSchemaParserRegistry,
  MAX_QUARANTINE_PAYLOAD_BYTES,
  MAX_QUARANTINE_RECORDS_PER_TRANSFER,
  extractProviderReference,
  listQuarantinedAxelarRecords,
  recordQuarantinedAxelarSchema,
  replayQuarantinedAxelarRecords,
  sanitizeAndBoundPayload,
  type AxelarSchemaDriftKind,
  type AxelarSchemaParser,
  type QuarantinedAxelarEntryInput,
  type QuarantinedAxelarRecord,
  type ReplayQuarantineOptions,
  type ReplayQuarantineResult,
} from "./quarantine.js";

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

export interface GmpOptions {
  readonly timeoutMs?: number;
  /** Injected so the unit suite can answer without a network. */
  readonly fetch?: typeof globalThis.fetch;
  /** Called once per status value this build does not know. */
  readonly onUnknownStatus?: (status: string) => void;
  /** Optional database handle for persisting drifted status payloads into quarantine. */
  readonly quarantineDb?: Queryable | undefined;
  /** Optional parser registry for custom or newly supported Axelar response schemas. */
  readonly parserRegistry?: AxelarSchemaParserRegistry | undefined;
  /** Optional hook notified whenever a drifted payload is quarantined. */
  readonly onQuarantine?: ((entry: QuarantinedAxelarEntryInput) => void) | undefined;
}

interface RowDrift {
  readonly kind: AxelarSchemaDriftKind;
  readonly observedStatus: string | null;
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
    const firstPage = await this.fetchPage(transfer.originTx, signal);
    if (firstPage.kind === "non_data_envelope") {
      return this.handleNonDataEnvelope(firstPage.body, transfer);
    }

    const rows = firstPage.rows;
    const hash = normalized(transfer.originTx);
    const matched = rows.filter((item) =>
      [
        item.call?.transactionHash,
        typeof item.call?.parentMessageID === "string"
          ? item.call.parentMessageID.split("-")[0]
          : undefined,
      ].some((value) => normalized(value) === hash),
    );

    const executed = matched.find((item) => this.previewExecution(item) !== undefined);
    if (executed) {
      return this.finalizeRow(executed, transfer);
    }

    let selected = matched[0];
    // A Stellar ITS call executes first on the hub. The source lookup may return only that row.
    // Follow the explicitly linked child, and require its parent and message id to match.
    let remaining = 4;
    for (const parent of matched) {
      const parentId = typeof parent.message_id === "string" ? parent.message_id : parent.id;
      const children =
        parent.executed !== null && typeof parent.executed === "object"
          ? parent.executed.childMessageIDs
          : undefined;
      if (typeof parentId !== "string" || !Array.isArray(children)) continue;
      for (const childId of children) {
        if (remaining <= 0) break;
        if (typeof childId !== "string" || !/^0x[0-9a-fA-F]{64}-\d+$/.test(childId)) continue;
        remaining -= 1;
        const forwardedPage = await this.fetchPage(childId.split("-")[0] ?? "", signal);
        if (forwardedPage.kind !== "rows") continue;
        const child = forwardedPage.rows.find(
          (item) =>
            normalized(item.call?.parentMessageID) === normalized(parentId) &&
            normalized(item.message_id ?? item.id) === normalized(childId),
        );
        if (!child) continue;
        if (this.previewExecution(child) !== undefined) {
          return this.finalizeRow(child, transfer);
        }
        selected = child;
      }
    }

    return selected ? this.finalizeRow(selected, transfer) : { kind: "missing" };
  }

  private async fetchPage(
    txHash: string,
    signal?: AbortSignal,
  ): Promise<
    | { readonly kind: "rows"; readonly rows: GmpRow[] }
    | { readonly kind: "non_data_envelope"; readonly body: unknown }
  > {
    const response = await this.send({ txHash }, signal);
    if (response.status === 429)
      throw new RailError(this.rail, "rateLimited", "rate limited", 60_000);
    if (!response.ok)
      throw new RailError(
        this.rail,
        response.status >= 500 ? "transient" : "permanent",
        `http ${String(response.status)}`,
      );
    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      throw new RailError(this.rail, "transient", `response was not json: ${describe(cause)}`);
    }
    if (
      body !== null &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      Array.isArray((body as { readonly data?: unknown }).data)
    ) {
      return { kind: "rows", rows: (body as { readonly data: GmpRow[] }).data };
    }
    return { kind: "non_data_envelope", body };
  }

  private async handleNonDataEnvelope(
    body: unknown,
    transfer: PendingTransfer,
  ): Promise<RailLookup> {
    const customParser = this.options.parserRegistry?.findParser(body) ?? null;
    if (customParser !== null) {
      return clampProviderLookup(customParser.parse(body, transfer));
    }

    const driftedItem = findMatchingEnvelopeRecord(body, transfer.originTx);
    if (driftedItem === null) {
      throw new RailError(this.rail, "transient", "status API returned an invalid data field");
    }

    const providerReference =
      extractProviderReference(driftedItem) ?? extractProviderReference(body);
    const observedStatus = readObservedStatusLabel(driftedItem);

    await this.quarantine({
      transfer,
      providerReference,
      driftKind: "unsupported_envelope",
      observedStatus,
      rawPayload: driftedItem,
    });

    return {
      kind: "found",
      report: {
        status: "pending",
        railStatus:
          observedStatus !== null
            ? `quarantined:unsupported_envelope/${observedStatus}`
            : "quarantined:unsupported_envelope",
        reference: providerReference,
        attestedAt: null,
      },
    };
  }

  private previewExecution(
    row: GmpRow,
  ): { readonly txHash: `0x${string}`; readonly commandId: `0x${string}` } | undefined {
    if (detectRowDrift(row) !== null) {
      return undefined;
    }
    if (
      row.executed !== null &&
      typeof row.executed === "object" &&
      typeof row.executed.transactionHash === "string" &&
      /^0x[0-9a-fA-F]{64}$/.test(row.executed.transactionHash) &&
      typeof row.command_id === "string" &&
      /^0x[0-9a-fA-F]{64}$/.test(row.command_id)
    ) {
      return {
        txHash: row.executed.transactionHash as `0x${string}`,
        commandId: row.command_id as `0x${string}`,
      };
    }
    return undefined;
  }

  private async finalizeRow(row: GmpRow, transfer: PendingTransfer): Promise<RailLookup> {
    const drift = detectRowDrift(row);
    if (drift !== null) {
      const customParser = this.options.parserRegistry?.findParser(row) ?? null;
      if (customParser !== null) {
        return clampProviderLookup(customParser.parse(row, transfer));
      }

      if (
        drift.kind === "unknown_status" &&
        typeof row.status === "string" &&
        !this.reported.has(row.status)
      ) {
        this.reported.add(row.status);
        this.options.onUnknownStatus?.(row.status);
      }

      const providerReference = extractProviderReference(row);
      await this.quarantine({
        transfer,
        providerReference,
        driftKind: drift.kind,
        observedStatus: drift.observedStatus,
        rawPayload: row,
      });

      const fatal = FATAL_FLAGS.some((flag) => row[flag] === true);
      const flags = [...RECOVERABLE_FLAGS, ...FATAL_FLAGS].filter((flag) => row[flag] === true);
      const simplified = typeof row.simplified_status === "string" ? row.simplified_status : null;
      const labelStatus = typeof row.status === "string" ? row.status : `quarantined:${drift.kind}`;
      const words = [labelStatus, simplified, ...flags].filter(
        (part): part is string => part !== null && part.length > 0,
      );

      return {
        kind: "found",
        report: {
          status: fatal ? "failed" : "pending",
          railStatus: words.length > 0 ? words.join("/") : `quarantined:${drift.kind}`,
          reference: providerReference,
          attestedAt: null,
        },
      };
    }

    return { kind: "found", report: this.reportFor(row) };
  }

  private reportFor(row: GmpRow): RailReport {
    const status = typeof row.status === "string" ? row.status : "";
    const simplified = typeof row.simplified_status === "string" ? row.simplified_status : null;
    const flags = [...RECOVERABLE_FLAGS, ...FATAL_FLAGS].filter((flag) => row[flag] === true);

    let mapped = MAPPING[status] ?? "pending";
    if (FATAL_FLAGS.some((flag) => row[flag] === true)) mapped = "failed";

    const words = [status, simplified, ...flags].filter((part): part is string => part !== null);
    const execution = this.previewExecution(row);

    return {
      status: mapped,
      railStatus: words.join("/"),
      // The message id, because that is what Axelar's support asks for.
      reference:
        typeof row.message_id === "string" ? row.message_id : extractProviderReference(row),
      attestedAt: stampOf(row.approved) ?? stampOf(row.executed),
      ...(execution !== undefined ? { execution } : {}),
    };
  }

  private async quarantine(entry: QuarantinedAxelarEntryInput): Promise<void> {
    this.options.onQuarantine?.(entry);
    if (this.options.quarantineDb !== undefined) {
      await recordQuarantinedAxelarSchema(this.options.quarantineDb, entry);
    }
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

function detectRowDrift(row: GmpRow): RowDrift | null {
  if (row.status === undefined || row.status === null || typeof row.status !== "string") {
    return {
      kind: "invalid_status_type",
      observedStatus: row.status === undefined || row.status === null ? null : typeof row.status,
    };
  }

  if (MAPPING[row.status] === undefined) {
    return {
      kind: "unknown_status",
      observedStatus: row.status,
    };
  }

  if (row.executed !== undefined && row.executed !== null) {
    if (typeof row.executed !== "object" || Array.isArray(row.executed)) {
      return {
        kind: "unsupported_execution_shape",
        observedStatus: row.status,
      };
    }
    const execRecord = row.executed as Record<string, unknown>;
    if ("tx_hash" in execRecord || "txHash" in execRecord) {
      return {
        kind: "unsupported_execution_shape",
        observedStatus: row.status,
      };
    }
    if (
      execRecord.transactionHash !== undefined &&
      (typeof execRecord.transactionHash !== "string" ||
        !/^0x[0-9a-fA-F]{64}$/.test(execRecord.transactionHash))
    ) {
      return {
        kind: "unsupported_execution_shape",
        observedStatus: row.status,
      };
    }
  }

  if ("commandId" in row) {
    return {
      kind: "unsupported_execution_shape",
      observedStatus: row.status,
    };
  }

  if (
    row.command_id !== undefined &&
    row.command_id !== null &&
    (typeof row.command_id !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(row.command_id))
  ) {
    return {
      kind: "unsupported_execution_shape",
      observedStatus: row.status,
    };
  }

  return null;
}

function findMatchingEnvelopeRecord(body: unknown, originTx: string): unknown {
  if (body === null || typeof body !== "object") return null;
  const target = normalized(originTx);
  if (target.length === 0) return null;

  const matchesOrigin = (candidate: unknown): boolean => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      return false;
    }
    const rec = candidate as Record<string, unknown>;
    for (const key of ["txHash", "tx_hash", "sourceTxHash", "source_tx_hash", "transactionHash"]) {
      if (normalized(rec[key]) === target) return true;
    }
    if (rec.call !== null && typeof rec.call === "object" && !Array.isArray(rec.call)) {
      const callObj = rec.call as Record<string, unknown>;
      if (normalized(callObj.transactionHash) === target) return true;
      if (
        typeof callObj.parentMessageID === "string" &&
        normalized(callObj.parentMessageID.split("-")[0]) === target
      ) {
        return true;
      }
    }
    return false;
  };

  if (Array.isArray(body)) {
    const items = body as readonly unknown[];
    return items.find((item) => matchesOrigin(item)) ?? null;
  }

  const root = body as Record<string, unknown>;
  if (matchesOrigin(root)) return root;

  for (const key of ["messages", "items", "records", "gmp", "result", "results"]) {
    const nested = root[key];
    if (Array.isArray(nested)) {
      const items = nested as readonly unknown[];
      const found = items.find((item) => matchesOrigin(item));
      if (found !== undefined) return found;
    } else if (nested !== null && typeof nested === "object") {
      if (matchesOrigin(nested)) return nested;
      const innerObj = nested as Record<string, unknown>;
      for (const innerKey of ["items", "messages", "data", "records"]) {
        const list = innerObj[innerKey];
        if (Array.isArray(list)) {
          const items = list as readonly unknown[];
          const found = items.find((item) => matchesOrigin(item));
          if (found !== undefined) return found;
        }
      }
    }
  }

  return null;
}

function readObservedStatusLabel(item: unknown): string | null {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
  const rec = item as Record<string, unknown>;
  for (const key of ["status", "state", "phase", "simplified_status"]) {
    const value = rec[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim().slice(0, 64);
    }
  }
  return null;
}

function clampProviderLookup(lookup: RailLookup): RailLookup {
  if (lookup.kind === "missing") return lookup;
  if (lookup.report.status !== "delivered") return lookup;
  return {
    kind: "found",
    report: {
      ...lookup.report,
      status: "attested",
    },
  };
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
