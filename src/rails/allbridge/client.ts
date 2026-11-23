import { createHash } from "node:crypto";
import { RailError, type PendingTransfer, type RailClient, type RailLookup } from "../types.js";
import { sanitizeRailDiagnostic } from "../diagnostics.js";
import type { AllbridgeSignedIntent } from "./intent.js";

export interface AllbridgeClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly providerId?: string;
  readonly timeoutMs?: number;
}
export const MAX_ALLBRIDGE_RESPONSE_BYTES = 128 * 1024;
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : "";
}
function integer(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : -1;
}

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        abort = () => {
          reject(new RailError("allbridge", "transient", "provider request budget exhausted"));
        };
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

/** Explicit commissioned provider adapter; no runtime registration without validated lane metadata. */
export class AllbridgeClient implements RailClient {
  readonly rail = "allbridge";
  private readonly baseUrl: string;
  private readonly request: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: AllbridgeClientOptions) {
    const url = new URL(options.baseUrl);
    if (
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        )) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        "Allbridge provider requires a reviewed HTTPS endpoint without embedded credentials or query parameters.",
      );
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.request = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 45_000)
      throw new RangeError("Allbridge provider timeout is outside supported bounds.");
  }

  get providerId(): string | undefined {
    return this.options.providerId;
  }

  async look(transfer: PendingTransfer, signal?: AbortSignal): Promise<RailLookup> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    combined.throwIfAborted();
    let response: Response;
    try {
      response = await abortable(
        this.request(
          `${this.baseUrl}/v1/transfers?sourceTransaction=${encodeURIComponent(transfer.originTx)}`,
          {
            signal: combined,
            redirect: "error",
            headers: { accept: "application/json" },
          },
        ),
        combined,
      );
    } catch {
      throw new RailError(this.rail, "transient", "provider request unavailable");
    }
    if (response.status === 404) {
      await response.body?.cancel();
      return { kind: "missing" };
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429)
        throw new RailError(this.rail, "rateLimited", "rate limited", 60_000);
      throw new RailError(
        this.rail,
        response.status >= 500 ? "transient" : "permanent",
        `http ${String(response.status)}`,
      );
    }
    let body: unknown;
    const reader = response.body?.getReader() as
      ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const declared = response.headers.get("content-length");
      if (
        declared !== null &&
        (!/^\d+$/.test(declared) || Number(declared) > MAX_ALLBRIDGE_RESPONSE_BYTES)
      )
        throw new Error("resource limit");
      if (!reader) throw new Error("missing body");
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      for (;;) {
        combined.throwIfAborted();
        const part = await abortable(reader.read(), combined);
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_ALLBRIDGE_RESPONSE_BYTES) throw new Error("resource limit");
        chunks.push(part.value);
      }
      combined.throwIfAborted();
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new RailError(
        this.rail,
        "transient",
        "provider response invalid or exceeds resource budget",
      );
    } finally {
      await reader?.cancel().catch(() => undefined);
    }
    if (!object(body))
      throw new RailError(this.rail, "transient", "provider response schema unavailable");
    const row = object(body.transfer) ? body.transfer : body;
    const raw = object(row.intent) ? row.intent : null;
    if (raw === null) return { kind: "missing" };
    const intent: AllbridgeSignedIntent = {
      messageId: text(raw.messageId),
      sourceChain: text(raw.sourceChain),
      destinationChain: text(raw.destinationChain),
      sourceChainId: integer(raw.sourceChainId),
      destinationChainId: integer(raw.destinationChainId),
      sourceTransaction: text(raw.sourceTransaction),
      sourceBlockHash: text(raw.sourceBlockHash),
      nonce: text(raw.nonce),
      token: text(raw.token),
      recipient: text(raw.recipient),
      amount: text(raw.amount),
      validatorEpoch: integer(raw.validatorEpoch),
      signature: text(raw.signature),
    };
    if (
      !/^(0x)?[0-9a-fA-F]{64}$/.test(intent.messageId) ||
      intent.sourceTransaction.toLowerCase() !== transfer.originTx.toLowerCase() ||
      intent.sourceChain !== transfer.originChain ||
      intent.destinationChain !== transfer.destinationChain
    ) {
      return {
        kind: "found",
        report: {
          status: "pending",
          railStatus: "unsupported_schema",
          reference: null,
          attestedAt: null,
          quarantine: {
            schema: "unsupported_allbridge_intent",
            providerReference: null,
            payload: { digest: createHash("sha256").update(JSON.stringify(row)).digest("hex") },
          },
        },
      };
    }
    const payment = object(row.destinationPayment) ? row.destinationPayment : null;
    return {
      kind: "found",
      report: {
        status: "pending",
        railStatus: sanitizeRailDiagnostic(text(row.status)) ?? "intent_discovered",
        reference: intent.messageId,
        attestedAt: null,
        allbridgeIntent: intent,
        allbridgeDestinationPayment:
          payment === null
            ? null
            : {
                transactionHash: text(payment.transactionHash),
                blockHash: text(payment.blockHash),
                blockNumber: text(payment.blockNumber),
                logIndex: integer(payment.logIndex),
                recipient: text(payment.recipient),
                token: text(payment.token),
                amount: text(payment.amount),
                finalized: payment.finalized === true,
                reverted: payment.reverted === true,
              },
      },
    };
  }
}
