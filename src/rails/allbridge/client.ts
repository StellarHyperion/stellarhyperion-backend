import type { Hex } from "viem";

import { admitAllbridgeLane, type AppConfig } from "../../config/config.js";
import {
  RailError,
  type AttestationStatus,
  type PendingTransfer,
  type RailClient,
  type RailLookup,
} from "../types.js";
import { computeAllbridgeIntentHash, verifyAllbridgeValidatorQuorum } from "./events.js";

export interface AllbridgeClientOptions {
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

interface RawAllbridgeIntentResponse {
  readonly status?: unknown;
  readonly messageHash?: unknown;
  readonly sourceChainSymbol?: unknown;
  readonly destinationChainSymbol?: unknown;
  readonly sourceNonce?: unknown;
  readonly recipient?: unknown;
  readonly sourceAmount?: unknown;
  readonly signatures?: unknown;
  readonly destinationTxHash?: unknown;
  readonly attestedAt?: unknown;
}

export class AllbridgeClient implements RailClient {
  readonly rail = "allbridge";
  private readonly baseUrl: string;
  private readonly request: typeof globalThis.fetch;

  constructor(
    baseUrl: string,
    private readonly config: Pick<AppConfig, "network" | "deployments" | "rails">,
    private readonly options: AllbridgeClientOptions = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.request = options.fetch ?? globalThis.fetch;
  }

  async look(transfer: PendingTransfer, signal?: AbortSignal): Promise<RailLookup> {
    const admission = admitAllbridgeLane(
      this.config,
      transfer.originChain,
      transfer.destinationChain,
    );
    if (!admission.enabled) {
      throw new RailError(
        this.rail,
        "permanent",
        `Allbridge lane ${transfer.originChain}->${transfer.destinationChain} is disabled (${admission.reason})`,
      );
    }
    const { lane } = admission;

    const response = await this.send(transfer, signal);
    if (response.status === 404) {
      return { kind: "missing" };
    }
    if (response.status === 429) {
      const retryHeader = response.headers.get("retry-after");
      const retrySeconds = retryHeader === null ? Number.NaN : Number.parseInt(retryHeader, 10);
      const retryMs =
        Number.isFinite(retrySeconds) && retrySeconds > 0 ? retrySeconds * 1_000 : 60_000;
      throw new RailError(this.rail, "rateLimited", "rate limited", retryMs);
    }
    if (!response.ok) {
      throw new RailError(
        this.rail,
        response.status >= 500 ? "transient" : "permanent",
        `http ${String(response.status)}`,
      );
    }

    let rawJson: unknown;
    try {
      rawJson = await response.json();
    } catch (cause) {
      throw new RailError(this.rail, "transient", `response was not json: ${describe(cause)}`);
    }

    if (rawJson === null || typeof rawJson !== "object" || Array.isArray(rawJson)) {
      return { kind: "missing" };
    }
    const body = rawJson as RawAllbridgeIntentResponse;

    const rawStatus = typeof body.status === "string" ? body.status : "pending";
    if (rawStatus === "not_found" || rawStatus === "missing") {
      return { kind: "missing" };
    }

    const messageHash = requireHex32(body.messageHash, "messageHash", this.rail);
    const sourceChainSymbol = requireNonEmptyString(
      body.sourceChainSymbol,
      "sourceChainSymbol",
      this.rail,
    );
    const destinationChainSymbol = requireNonEmptyString(
      body.destinationChainSymbol,
      "destinationChainSymbol",
      this.rail,
    );
    const sourceNonce = requireDecimalBigint(body.sourceNonce, "sourceNonce", this.rail);
    const recipient = requireNonEmptyString(body.recipient, "recipient", this.rail);
    const sourceAmount = requireDecimalBigint(body.sourceAmount, "sourceAmount", this.rail);

    if (
      sourceChainSymbol !== lane.origin.chainSymbol ||
      destinationChainSymbol !== lane.destination.chainSymbol ||
      sourceNonce !== transfer.nonce
    ) {
      throw new RailError(
        this.rail,
        "permanent",
        "signed intent chain symbol or nonce does not match pending transfer",
      );
    }

    const destinationPool = lane.destination.pools[lane.symbol];
    if (destinationPool === undefined) {
      throw new RailError(this.rail, "permanent", "missing destination pool in admitted lane");
    }

    let expectedHash: Hex;
    try {
      expectedHash = computeAllbridgeIntentHash({
        sourceChainSymbol,
        destinationChainSymbol,
        sourceNonce,
        recipient,
        sourceAmount,
        destinationPool,
      });
    } catch (cause) {
      throw new RailError(this.rail, "permanent", describe(cause));
    }

    if (expectedHash.toLowerCase() !== messageHash.toLowerCase()) {
      throw new RailError(
        this.rail,
        "permanent",
        `signed intent hash ${messageHash} disagrees with canonical message hash ${expectedHash}`,
      );
    }

    const signatures = parseSignatures(body.signatures, this.rail);
    const trustDisclosure = await verifyAllbridgeValidatorQuorum(
      expectedHash,
      signatures,
      lane.destination.validatorTrust,
    );

    // Validator quorum signatures can at most establish `attested`, never `delivered`, even when
    // the off-chain Allbridge status endpoint reports `completed` or `delivered`.
    let mappedStatus: Exclude<AttestationStatus, "delivered">;
    if (rawStatus === "failed" || rawStatus === "rejected") {
      mappedStatus = "failed";
    } else if (rawStatus === "expired") {
      mappedStatus = "expired";
    } else if (trustDisclosure.quorumSatisfied) {
      mappedStatus = "attested";
    } else {
      mappedStatus = "pending";
    }

    const destinationTxHash =
      typeof body.destinationTxHash === "string" &&
      /^0x[0-9a-fA-F]{64}$/.test(body.destinationTxHash)
        ? (body.destinationTxHash.toLowerCase() as Hex)
        : undefined;

    const attestedAt =
      typeof body.attestedAt === "number" && body.attestedAt > 0
        ? new Date(body.attestedAt * 1_000)
        : typeof body.attestedAt === "string" && !Number.isNaN(Date.parse(body.attestedAt))
          ? new Date(body.attestedAt)
          : null;

    const quorumTag = `quorum:${String(trustDisclosure.verifiedSigners.length)}/${String(trustDisclosure.requiredSignatures)}`;

    return {
      kind: "found",
      report: {
        status: mappedStatus,
        railStatus: `${rawStatus}/${quorumTag}`,
        reference: expectedHash,
        attestedAt: trustDisclosure.quorumSatisfied ? attestedAt : null,
        ...(destinationTxHash !== undefined ? { forwardTxHash: destinationTxHash } : {}),
        allbridge: {
          messageHash: expectedHash,
          sourceChainSymbol,
          destinationChainSymbol,
          sourceNonce,
          recipient,
          sourceAmount,
          signatures,
          ...(destinationTxHash !== undefined ? { destinationTxHash } : {}),
          trustDisclosure,
        },
      },
    };
  }

  private async send(transfer: PendingTransfer, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 15_000);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    const query = new URLSearchParams({
      originChain: transfer.originChain,
      destinationChain: transfer.destinationChain,
      nonce: transfer.nonce.toString(),
      txHash: transfer.originTx,
    });
    try {
      return await this.request(`${this.baseUrl}/v1/intents?${query.toString()}`, {
        method: "GET",
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

function requireHex32(value: unknown, field: string, rail: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new RailError(rail, "transient", `invalid 32-byte hex field ${field}`);
  }
  return value.toLowerCase() as Hex;
}

function requireNonEmptyString(value: unknown, field: string, rail: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RailError(rail, "transient", `missing string field ${field}`);
  }
  return value;
}

function requireDecimalBigint(value: unknown, field: string, rail: string): bigint {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  throw new RailError(rail, "transient", `invalid integer-string field ${field}`);
}

function parseSignatures(value: unknown, rail: string): readonly Hex[] {
  if (!Array.isArray(value)) {
    throw new RailError(rail, "transient", "signatures must be an array");
  }
  const out: Hex[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && /^0x[0-9a-fA-F]{130}$/.test(entry)) {
      out.push(entry.toLowerCase() as Hex);
    }
  }
  return out;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
