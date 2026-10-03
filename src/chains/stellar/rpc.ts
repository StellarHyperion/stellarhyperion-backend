/**
 * The two Soroban RPC calls the watcher makes.
 *
 * Hand rolled over `fetch` rather than taken from the Stellar SDK, for one reason: with
 * `xdrFormat: "json"` the RPC decodes ScVals itself, so the only thing an SDK would add here is a
 * large dependency and an XDR codec in the hot path to recover values that already arrived as JSON.
 *
 * Every failure is thrown as a `StellarRpcError` naming the method, so a poller's backoff log says
 * which call is failing rather than just that something is.
 */

export class StellarRpcError extends Error {
  constructor(
    readonly method: string,
    reason: string,
    readonly retryable: boolean,
  ) {
    super(`${method}: ${reason}`);
    this.name = "StellarRpcError";
  }
}

export interface LatestLedger {
  readonly sequence: number;
  /** Unix seconds, as the chain reports it. Lag is measured against this, not against our clock. */
  readonly closeTime: number;
  readonly protocolVersion: number;
}

export interface EventsPage {
  readonly events: readonly unknown[];
  /** Resume token. Pass it back as `cursor` to continue from exactly after the last event. */
  readonly cursor: string | null;
  readonly latestLedger: number;
  /**
   * The earliest ledger this node still holds.
   *
   * Worth reading on every page rather than once at startup. The window moves forward constantly,
   * and a watcher that falls behind it has a gap it cannot close from this source, which is a thing
   * to say out loud rather than to paper over.
   */
  readonly oldestLedger: number;
}

export interface EventsQuery {
  readonly contractIds: readonly string[];
  /** Mutually exclusive with `cursor`, and the RPC rejects a request carrying both. */
  readonly startLedger?: number;
  readonly cursor?: string;
  readonly limit: number;
}

interface RpcResponse {
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

/**
 * The one method the watcher needs, named so the watcher depends on the call and not the class.
 *
 * `StellarRpc` satisfies it without saying so. That is what lets the watcher suite drive a fake
 * that reproduces the measured window semantics instead of reaching a real node.
 */
export interface EventSource {
  events(query: EventsQuery, signal?: AbortSignal): Promise<EventsPage>;
}

export interface StellarRpcOptions {
  readonly timeoutMs?: number;
}

export class StellarRpc {
  constructor(
    private readonly url: string,
    private readonly options: StellarRpcOptions = {},
  ) {}

  async latestLedger(signal?: AbortSignal): Promise<LatestLedger> {
    const result = await this.call("getLatestLedger", {}, signal);
    const body = result as { sequence?: unknown; closeTime?: unknown; protocolVersion?: unknown };
    if (typeof body.sequence !== "number") {
      throw new StellarRpcError("getLatestLedger", "no ledger sequence in the response", true);
    }
    return {
      sequence: body.sequence,
      closeTime: Number(body.closeTime ?? 0),
      protocolVersion: Number(body.protocolVersion ?? 0),
    };
  }

  /**
   * One page of contract events.
   *
   * Filters on `contractIds` only. The RPC's topic filter matches on an exact segment count, and
   * the router's events carry two, three and four topics, so filtering by topic needs one filter
   * entry per shape and silently drops any event whose shape was forgotten. Pulling every event
   * from one contract and switching on the tag locally costs a little bandwidth and cannot lose an
   * event that way.
   */
  async events(query: EventsQuery, signal?: AbortSignal): Promise<EventsPage> {
    if (query.startLedger === undefined && query.cursor === undefined) {
      throw new StellarRpcError("getEvents", "needs either a startLedger or a cursor", false);
    }
    if (query.startLedger !== undefined && query.cursor !== undefined) {
      throw new StellarRpcError("getEvents", "takes a startLedger or a cursor, never both", false);
    }

    const params: Record<string, unknown> = {
      filters: [{ type: "contract", contractIds: [...query.contractIds] }],
      pagination:
        query.cursor === undefined
          ? { limit: query.limit }
          : { cursor: query.cursor, limit: query.limit },
      // The whole reason this file does not need an XDR codec.
      xdrFormat: "json",
    };
    if (query.startLedger !== undefined) params.startLedger = query.startLedger;

    const result = await this.call("getEvents", params, signal);
    const body = result as {
      events?: unknown;
      cursor?: unknown;
      latestLedger?: unknown;
      oldestLedger?: unknown;
    };
    if (!Array.isArray(body.events)) {
      throw new StellarRpcError("getEvents", "no events array in the response", true);
    }
    return {
      events: body.events,
      cursor: typeof body.cursor === "string" && body.cursor.length > 0 ? body.cursor : null,
      latestLedger: Number(body.latestLedger ?? 0),
      oldestLedger: Number(body.oldestLedger ?? 0),
    };
  }

  private async call(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 20_000);
    // Either the caller stopping us or the request taking too long ends the attempt. Without the
    // timeout a hung connection holds a poller tick open forever, and the poller's whole promise is
    // that one tick runs at a time.
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: combined,
      });
    } catch (cause) {
      const aborted = signal?.aborted === true;
      throw new StellarRpcError(method, aborted ? "cancelled" : describe(cause), !aborted);
    }

    if (!response.ok) {
      // 429 and 5xx are worth retrying. A 4xx that is not 429 means the request was wrong and
      // retrying it will be wrong the same way.
      const retryable = response.status === 429 || response.status >= 500;
      throw new StellarRpcError(method, `http ${String(response.status)}`, retryable);
    }

    let body: RpcResponse;
    try {
      body = (await response.json()) as RpcResponse;
    } catch (cause) {
      throw new StellarRpcError(method, `response was not json: ${describe(cause)}`, true);
    }

    if (body.error !== undefined) {
      const message = body.error.message ?? "unspecified";
      // The one error worth recognising by content. It means the cursor or start ledger has fallen
      // out of the node's retention window, which no amount of retrying fixes.
      const outOfWindow = /ledger range|must be within/i.test(message);
      throw new StellarRpcError(method, message, !outOfWindow);
    }
    if (body.result === undefined) {
      throw new StellarRpcError(method, "response carried neither a result nor an error", true);
    }
    return body.result;
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
