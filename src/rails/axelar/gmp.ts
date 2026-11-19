/** Axelar status lookup uses the API root and a searchGMP JSON method. */
import type {
  AttestationStatus,
  PendingTransfer,
  RailClient,
  RailLookup,
  RailReport,
} from "../types.js";
import { RailError } from "../types.js";

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
  readonly fetch?: typeof globalThis.fetch;
  readonly onUnknownStatus?: (status: string) => void;
}
const SECRET_KEY =
  /(?:authorization|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|credential|signer|seed|mnemonic|private[_-]?key|cookie)/i;
const MAX_STATUS_ROWS = 100;
const MAX_QUARANTINE_BYTES = 16_384;
const MAX_STRING = 512;

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
    const matched = rows.filter(
      (item): item is GmpRow =>
        isObject(item) &&
        [
          callOf(item)?.transactionHash,
          typeof callOf(item)?.parentMessageID === "string"
            ? (callOf(item)?.parentMessageID as string).split("-")[0]
            : undefined,
        ].some((value) => normalized(value) === hash),
    );
    const executed = matched.find((item) => this.reportFor(item).execution !== undefined);
    if (executed) return { kind: "found", report: this.reportFor(executed) };
    let selected = matched[0];
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
          (item): item is GmpRow =>
            isObject(item) &&
            normalized(callOf(item)?.parentMessageID) === normalized(parentId) &&
            normalized(item.message_id ?? item.id) === normalized(childId),
        );
        if (!child) continue;
        if (this.reportFor(child).execution)
          return { kind: "found", report: this.reportFor(child) };
        selected = child;
      }
    }
    if (selected) return { kind: "found", report: this.reportFor(selected) };
    const unsupportedIndex = rows.findIndex((item) => !isSupportedRow(item));
    if (unsupportedIndex !== -1) {
      const unsupported = rows[unsupportedIndex];
      const row = isObject(unsupported) ? unsupported : {};
      return {
        kind: "found",
        report: {
          status: "pending",
          railStatus: "unsupported_schema",
          reference: null,
          attestedAt: null,
          quarantine: {
            schema: "unsupported_row",
            providerReference:
              typeof row.message_id === "string"
                ? safeString(row.message_id)
                : typeof row.id === "string"
                  ? safeString(row.id)
                  : null,
            payload: bounded(unsupported),
          },
        },
      };
    }
    return { kind: "missing" };
  }
  private async rowsFor(txHash: string, signal?: AbortSignal): Promise<unknown[]> {
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
    if (!isObject(body) || !Array.isArray(body.data))
      throw new RailError(this.rail, "transient", "status API returned an invalid data field");
    if (body.data.length > MAX_STATUS_ROWS)
      throw new RailError(this.rail, "transient", "status API returned too many data rows");
    return body.data as unknown[];
  }
  private reportFor(row: GmpRow): RailReport {
    const status = typeof row.status === "string" ? row.status : "";
    const simplified = typeof row.simplified_status === "string" ? row.simplified_status : null;
    const flags = [...RECOVERABLE_FLAGS, ...FATAL_FLAGS].filter((flag) => row[flag] === true);
    let mapped = MAPPING[status];
    if (mapped === undefined) {
      if (!this.reported.has(status) && this.reported.size < 64) {
        this.reported.add(status);
        this.options.onUnknownStatus?.(safeString(status));
      }
      mapped = "pending";
    }
    if (FATAL_FLAGS.some((flag) => row[flag] === true)) mapped = "failed";
    const words = [status, simplified, ...flags]
      .filter((part): part is string => part !== null)
      .map(safeString);
    const unsupportedStatus = MAPPING[status] === undefined;
    const unsupportedSchema = !isSupportedRow(row);
    return {
      status: mapped,
      railStatus: words.join("/"),
      reference:
        typeof row.message_id === "string"
          ? safeString(row.message_id)
          : typeof row.id === "string"
            ? safeString(row.id)
            : null,
      attestedAt: stampOf(row.approved) ?? stampOf(row.executed),
      ...(flags.length > 0
        ? {
            providerFailure: {
              kind: FATAL_FLAGS.some((flag) => row[flag] === true)
                ? ("fatal" as const)
                : ("recoverable" as const),
              signals: flags,
            },
          }
        : {}),
      ...(unsupportedStatus || unsupportedSchema
        ? {
            quarantine: {
              schema: unsupportedSchema ? "unsupported_row" : "unsupported_status",
              providerReference:
                typeof row.message_id === "string"
                  ? safeString(row.message_id)
                  : typeof row.id === "string"
                    ? safeString(row.id)
                    : null,
              payload: bounded(row),
            },
          }
        : {}),
      ...(typeof row.executed?.transactionHash === "string" &&
      /^0x[0-9a-fA-F]{64}$/.test(row.executed.transactionHash) &&
      typeof row.command_id === "string" &&
      /^0x[0-9a-fA-F]{64}$/.test(row.command_id)
        ? {
            execution: {
              txHash: row.executed.transactionHash as `0x${string}`,
              commandId: row.command_id as `0x${string}`,
            },
          }
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
function stampOf(stage: { readonly block_timestamp?: unknown } | null | undefined): Date | null {
  const seconds = stage?.block_timestamp;
  if (
    typeof seconds !== "number" ||
    !Number.isFinite(seconds) ||
    seconds <= 0 ||
    seconds > 8_640_000_000_000
  )
    return null;
  return new Date(seconds * 1000);
}
function describe(cause: unknown): string {
  return safeString(cause instanceof Error ? cause.message : String(cause));
}
function normalized(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase().replace(/^0x/, "") : "";
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function callOf(row: Record<string, unknown>): GmpRow["call"] {
  return row.call as GmpRow["call"];
}
function isSupportedRow(value: unknown): boolean {
  if (!isObject(value) || typeof value.status !== "string" || value.status.length === 0)
    return false;
  for (const stage of ["executed", "approved"]) {
    const item = value[stage];
    if (
      item !== undefined &&
      item !== null &&
      (!isObject(item) ||
        (item.block_timestamp !== undefined &&
          (typeof item.block_timestamp !== "number" || !Number.isFinite(item.block_timestamp))) ||
        (item.transactionHash !== undefined && typeof item.transactionHash !== "string"))
    )
      return false;
  }
  for (const flag of [...RECOVERABLE_FLAGS, ...FATAL_FLAGS])
    if (value[flag] !== undefined && typeof value[flag] !== "boolean") return false;
  for (const key of ["status", "simplified_status", "message_id", "id", "command_id"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") return false;
  }
  if (value.call !== undefined && value.call !== null) {
    if (!isObject(value.call)) return false;
    if (value.call.transactionHash !== undefined && typeof value.call.transactionHash !== "string")
      return false;
    if (value.call.parentMessageID !== undefined && typeof value.call.parentMessageID !== "string")
      return false;
  }
  return true;
}
export function bounded(value: unknown): unknown {
  const sanitized = sanitize(value, 0);
  const serialized = JSON.stringify(sanitized);
  if (serialized.length <= MAX_QUARANTINE_BYTES) return sanitized;
  return { truncated: true, preview: serialized.slice(0, MAX_QUARANTINE_BYTES - 128) };
}
function sanitize(value: unknown, depth: number): unknown {
  if (typeof value === "string") return safeString(value).slice(0, MAX_STRING);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (depth >= 8) return "[depth limited]";
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => sanitize(item, depth + 1));
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return value.description ?? "[symbol]";
  if (typeof value === "function") return "[function]";
  if (!isObject(value)) return "[unsupported]";
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 64)
      .map(([key, item]) => [
        key.slice(0, 128),
        SECRET_KEY.test(key) ? "[redacted]" : sanitize(item, depth + 1),
      ]),
  );
}
export function safeString(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, "$1 [redacted]")
    .replace(
      /\b(?:authorization|password|secret|api[_-]?key|access[_-]?token|private[_-]?key)\s*[:=]\s*[^,;\s]+/gi,
      "[redacted]",
    )
    .replace(
      /([?&](?:api[_-]?key|access[_-]?token|token|password|secret)=)[^&#\s]*/gi,
      "$1[redacted]",
    )
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[redacted]@")
    .slice(0, MAX_STRING);
}
export { MAPPING as AXELAR_STATUS_MAPPING, FATAL_FLAGS, RECOVERABLE_FLAGS };
