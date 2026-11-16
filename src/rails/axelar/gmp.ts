/** Axelar status lookup uses the API root and a searchGMP JSON method. */
import type {
  AttestationStatus,
  PendingTransfer,
  RailClient,
  RailExecutionCandidate,
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
    const executedRows: GmpRow[] = matched.filter(
      (item) => this.reportFor(item).execution !== undefined,
    );

    let selected = matched[0];
    // A Stellar ITS call executes first on the hub. The source lookup may return only that row.
    // Follow the explicitly linked child, and require its parent and message id to match.
    if (executedRows.length === 0) {
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
          const matchingChildren = forwarded.filter(
            (item) =>
              normalized(item.call?.parentMessageID) === normalized(parentId) &&
              normalized(item.message_id ?? item.id) === normalized(childId),
          );
          for (const child of matchingChildren) {
            if (this.reportFor(child).execution !== undefined) {
              executedRows.push(child);
            } else {
              selected = child;
            }
          }
        }
      }
    }

    if (executedRows.length > 0) {
      return { kind: "found", report: this.combineExecutedRows(executedRows) };
    }
    return selected ? { kind: "found", report: this.reportFor(selected) } : { kind: "missing" };
  }

  private combineExecutedRows(rows: readonly GmpRow[]): RailReport {
    const firstRow = rows[0];
    if (firstRow === undefined) {
      throw new Error("combineExecutedRows requires at least one row");
    }
    const base = this.reportFor(firstRow);
    const withoutExecution: RailReport = {
      status: base.status,
      railStatus: base.railStatus,
      reference: base.reference,
      attestedAt: base.attestedAt,
    };

    // Group by commandId and message reference to detect conflicting provider execution claims
    // while collapsing exact duplicate records deterministically.
    const txByCommand = new Map<string, string>();
    const conflictedCommands = new Set<string>();
    const pairByRef = new Map<string, string>();
    const conflictedRefs = new Set<string>();
    const deduped = new Map<string, { candidate: RailExecutionCandidate; row: GmpRow }>();

    for (const row of rows) {
      const report = this.reportFor(row);
      const exec = report.execution;
      if (exec === undefined) continue;

      const cmdKey = exec.commandId.toLowerCase();
      const txKey = exec.txHash.toLowerCase();
      const pairKey = `${cmdKey}:${txKey}`;
      const refRaw =
        typeof row.message_id === "string"
          ? row.message_id
          : typeof row.id === "string"
            ? row.id
            : null;
      const refKey = refRaw !== null ? refRaw.toLowerCase() : null;

      const prevTx = txByCommand.get(cmdKey);
      if (prevTx !== undefined && prevTx !== txKey) {
        conflictedCommands.add(cmdKey);
      } else {
        txByCommand.set(cmdKey, txKey);
      }

      if (refKey !== null) {
        const prevPair = pairByRef.get(refKey);
        if (prevPair !== undefined && prevPair !== pairKey) {
          conflictedRefs.add(refKey);
        } else {
          pairByRef.set(refKey, pairKey);
        }
      }

      if (!deduped.has(pairKey)) {
        deduped.set(pairKey, {
          candidate: {
            txHash: exec.txHash,
            commandId: exec.commandId,
            ...(refRaw !== null ? { reference: refRaw } : {}),
          },
          row,
        });
      }
    }

    const validEntries = [...deduped.values()]
      .filter(({ candidate }) => {
        if (conflictedCommands.has(candidate.commandId.toLowerCase())) {
          return false;
        }
        if (
          candidate.reference !== undefined &&
          candidate.reference !== null &&
          conflictedRefs.has(candidate.reference.toLowerCase())
        ) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        const cmdCmp = a.candidate.commandId
          .toLowerCase()
          .localeCompare(b.candidate.commandId.toLowerCase());
        if (cmdCmp !== 0) return cmdCmp;
        return a.candidate.txHash.toLowerCase().localeCompare(b.candidate.txHash.toLowerCase());
      });

    if (validEntries.length === 0) {
      return withoutExecution;
    }

    if (validEntries.length === 1) {
      const single = validEntries[0];
      if (single === undefined) return withoutExecution;
      const singleReport = this.reportFor(single.row);
      return {
        ...singleReport,
        executions: [single.candidate],
      };
    }

    return {
      ...withoutExecution,
      reference: null,
      executions: validEntries.map((entry) => entry.candidate),
    };
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
