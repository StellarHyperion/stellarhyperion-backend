import type {
    PendingTransfer,
    RailClient,
    RailLookup,
    RailReport,
} from "../types.js";
import { RailError } from "../types.js";

export interface AllbridgeClientOptions {
    readonly baseUrl: string;
    readonly fetch?: typeof globalThis.fetch;
    readonly providerId?: string;
}

const SECRET = /(?:authorization|password|secret|api[_-]?key|access[_-]?token|credential|signer|seed|mnemonic|cookie)/i;

function object(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : null;
}

function safe(value: unknown): unknown {
    if (!object(value)) return value;
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
        if (!SECRET.test(key)) copy[key] = safe(item);
    }
    return copy;
}

export class AllbridgeClient implements RailClient {
    readonly rail = "allbridge";
    private readonly baseUrl: string;
    private readonly request: typeof globalThis.fetch;

    constructor(private readonly options: AllbridgeClientOptions) {
        this.baseUrl = options.baseUrl.replace(/\/+$/, "");
        this.request = options.fetch ?? globalThis.fetch;
    }

    get providerId(): string | undefined {
        return this.options.providerId;
    }

    async look(transfer: PendingTransfer, signal?: AbortSignal): Promise<RailLookup> {
        const url = `${this.baseUrl}/v1/transfers?sourceTransaction=${encodeURIComponent(transfer.originTx)}`;
        let response: Response;
        try {
            response = await this.request(
                url,
                signal === undefined
                    ? { headers: { accept: "application/json" } }
                    : { signal, headers: { accept: "application/json" } },
            );
        } catch (error) {
            throw new RailError(this.rail, "transient", `provider request failed: ${error instanceof Error ? error.name : "unknown"}`);
        }
        if (response.status === 404) return { kind: "missing" };
        if (response.status === 429) throw new RailError(this.rail, "rateLimited", "rate limited", 60_000);
        if (!response.ok) throw new RailError(this.rail, response.status >= 500 ? "transient" : "permanent", `http ${String(response.status)}`);

        let body: unknown;
        try {
            body = await response.json();
        } catch {
            throw new RailError(this.rail, "transient", "provider returned invalid JSON");
        }
        if (!object(body)) throw new RailError(this.rail, "transient", "provider returned an invalid response");

        const row = object(body.transfer) ? body.transfer : body;
        const intent = object(row.intent) ? row.intent : null;
        const payment = object(row.destinationPayment) ? row.destinationPayment : null;
        if (intent === null) return { kind: "missing" };

        const messageId = text(intent.messageId) ?? text(row.messageId);
        const sourceTransaction = text(intent.sourceTransaction) ?? text(row.sourceTransaction);
        if (messageId === null || sourceTransaction === null) {
            return {
                kind: "found",
                report: {
                    status: "pending",
                    railStatus: "unsupported_schema",
                    reference: null,
                    attestedAt: null,
                    quarantine: { schema: "unsupported_allbridge_intent", providerReference: null, payload: safe(row) },
                },
            };
        }

        const report: RailReport = {
            status: "pending",
            railStatus: text(row.status) ?? "intent_discovered",
            reference: messageId,
            attestedAt: null,
            allbridgeIntent: {
                messageId,
                sourceChain: text(intent.sourceChain) ?? "",
                destinationChain: text(intent.destinationChain) ?? "",
                sourceTransaction,
                sourceBlockHash: text(intent.sourceBlockHash) ?? "",
                nonce: text(intent.nonce) ?? "",
                token: text(intent.token) ?? "",
                recipient: text(intent.recipient) ?? "",
                amount: text(intent.amount) ?? "",
                signature: text(intent.signature) ?? "",
            },
            ...(payment === null
                ? { allbridgeDestinationPayment: null }
                : {
                    allbridgeDestinationPayment: {
                        transactionHash: text(payment.transactionHash) ?? "",
                        blockHash: text(payment.blockHash) ?? "",
                        blockNumber: text(payment.blockNumber) ?? "",
                        logIndex: typeof payment.logIndex === "number" && Number.isSafeInteger(payment.logIndex) ? payment.logIndex : -1,
                        recipient: text(payment.recipient) ?? "",
                        token: text(payment.token) ?? "",
                        amount: text(payment.amount) ?? "",
                        finalized: payment.finalized === true,
                        reverted: payment.reverted === true,
                    },
                }),
        };
        return { kind: "found", report };
    }
}
