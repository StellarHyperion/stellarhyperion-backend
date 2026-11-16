/**
 * Resumable SSE event cursors, bounded transition journal, and backpressure controller
 * for `/v1/transfers/:id/stream` and `/api/v1/transfers/:id/stream`.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { FormattedTransfer, TransferLifecycleStage } from "./routes/transfers.js";

export type SseEventKind = "transfer_update" | "complete";

export type ResyncReason =
  | "expired"
  | "evicted"
  | "transfer_mismatch"
  | "malformed_cursor"
  | "conflicting_cursor"
  | "invalid_state";

export interface SseCursorPayload {
  readonly v: 1;
  readonly transferId: string;
  readonly seq: number;
  readonly event: SseEventKind;
  readonly stage: TransferLifecycleStage;
  readonly digest: string;
  readonly issuedAtMs: number;
}

export interface JournaledSseFrame {
  readonly seq: number;
  readonly cursor: string;
  readonly event: SseEventKind;
  readonly stage: TransferLifecycleStage;
  readonly digest: string;
  readonly data: string;
  readonly issuedAtMs: number;
}

export interface TransferStreamOptions {
  /** Maximum age of an accepted resume cursor in milliseconds. Defaults to 15 minutes. */
  readonly cursorTtlMs?: number;
  /** Maximum distinct transfers retained in the in-memory transition ring. Defaults to 512. */
  readonly maxTrackedTransfers?: number;
  /** Maximum frames retained per transfer before older cursors require resync. Defaults to 32. */
  readonly maxEventsPerTransfer?: number;
  /** Maximum queued SSE frames while a client socket is backpressured. Defaults to 16. */
  readonly maxPendingFrames?: number;
  /** Maximum queued UTF-8 bytes while a client socket is backpressured. Defaults to 65536. */
  readonly maxBufferedBytes?: number;
  /** Maximum time in milliseconds to wait for socket `drain` before closing. Defaults to 5000. */
  readonly drainTimeoutMs?: number;
  /** Suggested EventSource reconnect delay in milliseconds. Defaults to 1000. */
  readonly retryDelayMs?: number;
  /** Optional clock override for deterministic unit tests. */
  readonly now?: () => number;
}

export interface StreamRuntimeDiagnostics {
  readonly activeStreams: number;
  readonly trackedTransfers: number;
}

const CURSOR_PREFIX = "hyp1.";
const MAX_CURSOR_LENGTH = 512;
const VALID_STAGES = new Set<TransferLifecycleStage>([
  "initiated",
  "attesting",
  "attested",
  "delivering",
  "delivered",
  "parked",
  "settled",
  "failed",
]);

function stageRank(stage: TransferLifecycleStage): number {
  switch (stage) {
    case "initiated":
      return 0;
    case "attesting":
      return 1;
    case "attested":
    case "delivering":
      return 2;
    case "parked":
      return 3;
    case "delivered":
    case "settled":
    case "failed":
      return 4;
  }
}

export function computeTransferDigest(serializedTransfer: string): string {
  return createHash("sha256").update(serializedTransfer).digest("hex").slice(0, 16);
}

export function encodeSseCursor(payload: SseCursorPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${CURSOR_PREFIX}${encoded}`;
}

export function decodeSseCursor(raw: string): SseCursorPayload | null {
  const trimmed = raw.trim();
  if (
    trimmed.length <= CURSOR_PREFIX.length ||
    trimmed.length > MAX_CURSOR_LENGTH ||
    !trimmed.startsWith(CURSOR_PREFIX)
  ) {
    return null;
  }

  try {
    const jsonText = Buffer.from(trimmed.slice(CURSOR_PREFIX.length), "base64url").toString("utf8");
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    if (parsed.v !== 1) return null;
    if (typeof parsed.transferId !== "string" || parsed.transferId.length === 0) return null;
    if (
      typeof parsed.seq !== "number" ||
      !Number.isInteger(parsed.seq) ||
      parsed.seq < 1 ||
      parsed.seq > Number.MAX_SAFE_INTEGER
    ) {
      return null;
    }
    if (parsed.event !== "transfer_update" && parsed.event !== "complete") return null;
    if (
      typeof parsed.stage !== "string" ||
      !VALID_STAGES.has(parsed.stage as TransferLifecycleStage)
    ) {
      return null;
    }
    if (typeof parsed.digest !== "string" || !/^[0-9a-f]{16}$/.test(parsed.digest)) return null;
    if (
      typeof parsed.issuedAtMs !== "number" ||
      !Number.isFinite(parsed.issuedAtMs) ||
      parsed.issuedAtMs <= 0
    ) {
      return null;
    }

    return {
      v: 1,
      transferId: parsed.transferId,
      seq: parsed.seq,
      event: parsed.event,
      stage: parsed.stage as TransferLifecycleStage,
      digest: parsed.digest,
      issuedAtMs: parsed.issuedAtMs,
    };
  } catch {
    return null;
  }
}

export type CursorExtractionResult =
  | { readonly kind: "none" }
  | { readonly kind: "present"; readonly raw: string }
  | { readonly kind: "error"; readonly reason: ResyncReason };

export function extractRequestedCursor(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  queryCursor: string | undefined,
): CursorExtractionResult {
  const rawHeader = headers["last-event-id"];
  let headerToken: string | null = null;

  if (Array.isArray(rawHeader)) {
    const nonEmpty = rawHeader.map((item) => item.trim()).filter((item) => item.length > 0);
    if (nonEmpty.length > 1 && new Set(nonEmpty).size > 1) {
      return { kind: "error", reason: "conflicting_cursor" };
    }
    headerToken = nonEmpty[0] ?? null;
  } else if (typeof rawHeader === "string") {
    const trimmed = rawHeader.trim();
    if (trimmed.length > 0) {
      headerToken = trimmed;
    }
  }

  const trimmedQuery = queryCursor?.trim() ?? "";
  const queryToken = trimmedQuery.length > 0 ? trimmedQuery : null;

  if (headerToken !== null && queryToken !== null && headerToken !== queryToken) {
    return { kind: "error", reason: "conflicting_cursor" };
  }

  const chosen = headerToken ?? queryToken;
  if (chosen === null) {
    return { kind: "none" };
  }
  return { kind: "present", raw: chosen };
}

export function formatSseFrame(frame: JournaledSseFrame, retryDelayMs?: number): string {
  const retryPrefix = retryDelayMs !== undefined ? `retry: ${String(retryDelayMs)}\n` : "";
  return `${retryPrefix}id: ${frame.cursor}\nevent: ${frame.event}\ndata: ${frame.data}\n\n`;
}

export interface ResyncPayload {
  readonly error: "resync_required";
  readonly reason: ResyncReason;
  readonly transferId: string;
  readonly snapshotUrl: string;
  readonly streamUrl: string;
  readonly latestCursor: string | null;
  readonly instructions: string;
}

export function formatResyncEvent(payload: ResyncPayload): string {
  return `event: resync_required\ndata: ${JSON.stringify(payload)}\n\n`;
}

function isFinalized(transfer: FormattedTransfer): boolean {
  return (
    transfer.destination.delivered || transfer.stage === "delivered" || transfer.stage === "settled"
  );
}

/**
 * Synthesize intermediate committed lifecycle milestones that are provably present on the current
 * database record when a client reconnects across transitions that occurred while no live poller
 * was observing the transfer.
 *
 * Provider attestation (`stage: "delivering"`) never sets `destination.delivered = true`.
 */
function synthesizeIntermediateSnapshots(
  baselineStage: TransferLifecycleStage,
  current: FormattedTransfer,
): readonly FormattedTransfer[] {
  const baseRank = stageRank(baselineStage);
  const currentRank = stageRank(current.stage);
  if (currentRank <= baseRank) {
    return [];
  }

  const synthesized: FormattedTransfer[] = [];

  if (
    baseRank < stageRank("delivering") &&
    currentRank > stageRank("delivering") &&
    current.rail?.attestedAt !== null &&
    current.rail?.attestedAt !== undefined
  ) {
    synthesized.push({
      ...current,
      stage: "delivering",
      destination: {
        ...current.destination,
        token: null,
        amount: null,
        symbol: null,
        decimals: null,
        delivered: false,
        block: null,
        txHash: null,
        deliveredAt: null,
      },
      rail: {
        ...current.rail,
        status: "attested",
      },
      claim: null,
    });
  }

  if (
    baseRank < stageRank("parked") &&
    current.stage === "settled" &&
    current.claim?.settled === true
  ) {
    synthesized.push({
      ...current,
      stage: "parked",
      claim: {
        id: current.claim.id,
        settled: false,
      },
    });
  }

  return synthesized;
}

interface TransferJournalBucket {
  nextSeq: number;
  evictedThroughSeq: number;
  frames: JournaledSseFrame[];
  lastTouchedAtMs: number;
}

export type ResumeResolution =
  | {
      readonly ok: true;
      readonly replayFrames: readonly JournaledSseFrame[];
      readonly latestUpdateFrame: JournaledSseFrame;
      readonly finalized: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: ResyncReason;
      readonly latestCursor: string | null;
    };

export class TransferStreamJournal {
  private readonly buckets = new Map<string, TransferJournalBucket>();
  private readonly cursorTtlMs: number;
  private readonly maxTrackedTransfers: number;
  private readonly maxEventsPerTransfer: number;
  private readonly now: () => number;
  private activeStreams = 0;

  constructor(options: TransferStreamOptions = {}) {
    this.cursorTtlMs = options.cursorTtlMs ?? 15 * 60 * 1000;
    this.maxTrackedTransfers = options.maxTrackedTransfers ?? 512;
    this.maxEventsPerTransfer = options.maxEventsPerTransfer ?? 32;
    this.now = options.now ?? (() => Date.now());
  }

  diagnostics(): StreamRuntimeDiagnostics {
    return {
      activeStreams: this.activeStreams,
      trackedTransfers: this.buckets.size,
    };
  }

  onStreamOpen(): void {
    this.activeStreams += 1;
  }

  onStreamClose(): void {
    if (this.activeStreams > 0) {
      this.activeStreams -= 1;
    }
  }

  /**
   * Record the current transfer state for a fresh connection (no resume cursor) and return the
   * initial frames (`transfer_update`, plus `complete` when already finalized).
   */
  recordInitial(transfer: FormattedTransfer): {
    readonly frames: readonly JournaledSseFrame[];
    readonly latestUpdateFrame: JournaledSseFrame;
  } {
    const nowMs = this.now();
    this.pruneExpiredBuckets(nowMs);
    const bucket = this.ensureBucket(transfer.id, nowMs);

    const latestUpdate = this.findLatestEvent(bucket, "transfer_update");
    if (latestUpdate !== null) {
      const synthesized = synthesizeIntermediateSnapshots(latestUpdate.stage, transfer);
      for (const snap of synthesized) {
        this.appendSnapshotIfChanged(bucket, snap, false, nowMs);
      }
    }

    const updateFrame = this.appendSnapshotIfChanged(bucket, transfer, true, nowMs);
    if (!isFinalized(transfer)) {
      return { frames: [updateFrame], latestUpdateFrame: updateFrame };
    }

    const completeFrame = this.ensureCompleteFrame(bucket, updateFrame, nowMs);
    return { frames: [updateFrame, completeFrame], latestUpdateFrame: updateFrame };
  }

  /**
   * Record a polled transfer observation during an open SSE stream and return any newly committed
   * frames since `lastDigest`.
   */
  recordPolled(
    transfer: FormattedTransfer,
    lastStage: TransferLifecycleStage,
    lastDigest: string,
  ): {
    readonly frames: readonly JournaledSseFrame[];
    readonly latestStage: TransferLifecycleStage;
    readonly latestDigest: string;
    readonly finalized: boolean;
  } {
    const serialized = JSON.stringify(transfer);
    const currentDigest = computeTransferDigest(serialized);
    if (currentDigest === lastDigest) {
      return {
        frames: [],
        latestStage: lastStage,
        latestDigest: lastDigest,
        finalized: isFinalized(transfer),
      };
    }

    const nowMs = this.now();
    const bucket = this.ensureBucket(transfer.id, nowMs);
    const emitted: JournaledSseFrame[] = [];

    const synthesized = synthesizeIntermediateSnapshots(lastStage, transfer);
    for (const snap of synthesized) {
      const prevLatest = this.findLatestEvent(bucket, "transfer_update");
      const snapFrame = this.appendSnapshotIfChanged(bucket, snap, false, nowMs);
      if (prevLatest?.seq !== snapFrame.seq) {
        emitted.push(snapFrame);
      }
    }

    const prevUpdate = this.findLatestEvent(bucket, "transfer_update");
    const updateFrame = this.appendSnapshotIfChanged(bucket, transfer, false, nowMs);
    if (prevUpdate?.seq !== updateFrame.seq || emitted.length === 0) {
      emitted.push(updateFrame);
    }

    const finalized = isFinalized(transfer);
    if (finalized) {
      const completeFrame = this.ensureCompleteFrame(bucket, updateFrame, nowMs);
      emitted.push(completeFrame);
    }

    return {
      frames: emitted,
      latestStage: transfer.stage,
      latestDigest: updateFrame.digest,
      finalized,
    };
  }

  /**
   * Validate a client-supplied cursor and resolve all missed frames up to `current`.
   */
  resolveResume(
    transferId: string,
    rawCursor: string,
    current: FormattedTransfer,
  ): ResumeResolution {
    const nowMs = this.now();
    this.pruneExpiredBuckets(nowMs);

    const existingBucket = this.buckets.get(transferId);
    const latestKnownCursor = existingBucket?.frames.at(-1)?.cursor ?? null;

    const decoded = decodeSseCursor(rawCursor);
    if (decoded === null) {
      return { ok: false, reason: "malformed_cursor", latestCursor: latestKnownCursor };
    }
    if (decoded.transferId !== transferId) {
      return { ok: false, reason: "transfer_mismatch", latestCursor: latestKnownCursor };
    }
    if (decoded.issuedAtMs > nowMs + 60_000) {
      return { ok: false, reason: "malformed_cursor", latestCursor: latestKnownCursor };
    }
    if (nowMs - decoded.issuedAtMs > this.cursorTtlMs) {
      return { ok: false, reason: "expired", latestCursor: latestKnownCursor };
    }

    const finalized = isFinalized(current);

    if (existingBucket !== undefined && existingBucket.frames.length > 0) {
      if (decoded.seq <= existingBucket.evictedThroughSeq) {
        const synced = this.recordInitial(current);
        return {
          ok: false,
          reason: "evicted",
          latestCursor: synced.frames.at(-1)?.cursor ?? null,
        };
      }

      const matchedIndex = existingBucket.frames.findIndex(
        (frame) =>
          frame.seq === decoded.seq &&
          frame.digest === decoded.digest &&
          frame.event === decoded.event,
      );
      if (matchedIndex === -1) {
        const synced = this.recordInitial(current);
        return {
          ok: false,
          reason: "invalid_state",
          latestCursor: synced.frames.at(-1)?.cursor ?? null,
        };
      }

      const latestBeforeSync = this.findLatestEvent(existingBucket, "transfer_update");
      const baselineStage = latestBeforeSync?.stage ?? decoded.stage;
      for (const snap of synthesizeIntermediateSnapshots(baselineStage, current)) {
        this.appendSnapshotIfChanged(existingBucket, snap, false, nowMs);
      }
      const latestUpdateFrame = this.appendSnapshotIfChanged(existingBucket, current, true, nowMs);
      if (finalized) {
        this.ensureCompleteFrame(existingBucket, latestUpdateFrame, nowMs);
      }

      // Re-locate matched frame in case ring buffer shifted while appending new transitions.
      if (decoded.seq <= existingBucket.evictedThroughSeq) {
        return {
          ok: false,
          reason: "evicted",
          latestCursor: existingBucket.frames.at(-1)?.cursor ?? null,
        };
      }

      const updatedMatchIndex = existingBucket.frames.findIndex(
        (frame) => frame.seq === decoded.seq,
      );
      if (updatedMatchIndex === -1) {
        return {
          ok: false,
          reason: "evicted",
          latestCursor: existingBucket.frames.at(-1)?.cursor ?? null,
        };
      }

      return {
        ok: true,
        replayFrames: existingBucket.frames.slice(updatedMatchIndex + 1),
        latestUpdateFrame,
        finalized,
      };
    }

    // Stateless resume path: no prior in-memory bucket for this transfer on this replica.
    if (stageRank(decoded.stage) > stageRank(current.stage)) {
      const synced = this.recordInitial(current);
      return {
        ok: false,
        reason: "invalid_state",
        latestCursor: synced.frames.at(-1)?.cursor ?? null,
      };
    }

    const currentSerialized = JSON.stringify(current);
    const currentDigest = computeTransferDigest(currentSerialized);
    if (decoded.event === "complete" && !finalized) {
      const synced = this.recordInitial(current);
      return {
        ok: false,
        reason: "invalid_state",
        latestCursor: synced.frames.at(-1)?.cursor ?? null,
      };
    }

    const bucket = this.ensureBucket(transferId, nowMs);
    bucket.nextSeq = decoded.seq + 1;

    const replayFrames: JournaledSseFrame[] = [];
    for (const snap of synthesizeIntermediateSnapshots(decoded.stage, current)) {
      replayFrames.push(this.appendSnapshotIfChanged(bucket, snap, false, nowMs));
    }

    let latestUpdateFrame: JournaledSseFrame;
    if (currentDigest === decoded.digest) {
      latestUpdateFrame = {
        seq: decoded.seq,
        cursor: encodeSseCursor(decoded),
        event: "transfer_update",
        stage: current.stage,
        digest: currentDigest,
        data: currentSerialized,
        issuedAtMs: decoded.issuedAtMs,
      };
      bucket.frames.push(latestUpdateFrame);
      if (finalized && decoded.event !== "complete") {
        replayFrames.push(this.ensureCompleteFrame(bucket, latestUpdateFrame, nowMs));
      }
    } else {
      latestUpdateFrame = this.appendSnapshotIfChanged(bucket, current, true, nowMs);
      replayFrames.push(latestUpdateFrame);
      if (finalized) {
        replayFrames.push(this.ensureCompleteFrame(bucket, latestUpdateFrame, nowMs));
      }
    }

    return {
      ok: true,
      replayFrames,
      latestUpdateFrame,
      finalized,
    };
  }

  private ensureBucket(transferId: string, nowMs: number): TransferJournalBucket {
    const existing = this.buckets.get(transferId);
    if (existing !== undefined) {
      existing.lastTouchedAtMs = nowMs;
      // Refresh insertion order for LRU eviction.
      this.buckets.delete(transferId);
      this.buckets.set(transferId, existing);
      return existing;
    }

    while (this.buckets.size >= this.maxTrackedTransfers) {
      const oldestKey = this.buckets.keys().next().value;
      if (oldestKey === undefined) break;
      this.buckets.delete(oldestKey);
    }

    const created: TransferJournalBucket = {
      nextSeq: 1,
      evictedThroughSeq: 0,
      frames: [],
      lastTouchedAtMs: nowMs,
    };
    this.buckets.set(transferId, created);
    return created;
  }

  private findLatestEvent(
    bucket: TransferJournalBucket,
    event: SseEventKind,
  ): JournaledSseFrame | null {
    for (let index = bucket.frames.length - 1; index >= 0; index -= 1) {
      const candidate = bucket.frames[index];
      if (candidate?.event === event) {
        return candidate;
      }
    }
    return null;
  }

  private appendSnapshotIfChanged(
    bucket: TransferJournalBucket,
    transfer: FormattedTransfer,
    returnExistingWhenUnchanged: boolean,
    nowMs: number,
  ): JournaledSseFrame {
    const data = JSON.stringify(transfer);
    const digest = computeTransferDigest(data);
    const latestUpdate = this.findLatestEvent(bucket, "transfer_update");
    if (latestUpdate !== null && latestUpdate.digest === digest) {
      if (returnExistingWhenUnchanged) {
        return latestUpdate;
      }
      return latestUpdate;
    }

    const seq = bucket.nextSeq;
    bucket.nextSeq += 1;
    const cursor = encodeSseCursor({
      v: 1,
      transferId: transfer.id,
      seq,
      event: "transfer_update",
      stage: transfer.stage,
      digest,
      issuedAtMs: nowMs,
    });
    const frame: JournaledSseFrame = {
      seq,
      cursor,
      event: "transfer_update",
      stage: transfer.stage,
      digest,
      data,
      issuedAtMs: nowMs,
    };
    this.pushBoundedFrame(bucket, frame);
    return frame;
  }

  private ensureCompleteFrame(
    bucket: TransferJournalBucket,
    updateFrame: JournaledSseFrame,
    nowMs: number,
  ): JournaledSseFrame {
    const latestComplete = this.findLatestEvent(bucket, "complete");
    if (latestComplete !== null && latestComplete.digest === updateFrame.digest) {
      return latestComplete;
    }

    const seq = bucket.nextSeq;
    bucket.nextSeq += 1;
    const transferId = decodeSseCursor(updateFrame.cursor)?.transferId ?? "";
    const cursor = encodeSseCursor({
      v: 1,
      transferId,
      seq,
      event: "complete",
      stage: updateFrame.stage,
      digest: updateFrame.digest,
      issuedAtMs: nowMs,
    });
    const frame: JournaledSseFrame = {
      seq,
      cursor,
      event: "complete",
      stage: updateFrame.stage,
      digest: updateFrame.digest,
      data: updateFrame.data,
      issuedAtMs: nowMs,
    };
    this.pushBoundedFrame(bucket, frame);
    return frame;
  }

  private pushBoundedFrame(bucket: TransferJournalBucket, frame: JournaledSseFrame): void {
    bucket.frames.push(frame);
    while (bucket.frames.length > this.maxEventsPerTransfer) {
      const evicted = bucket.frames.shift();
      if (evicted !== undefined && evicted.seq > bucket.evictedThroughSeq) {
        bucket.evictedThroughSeq = evicted.seq;
      }
    }
  }

  private pruneExpiredBuckets(nowMs: number): void {
    for (const [transferId, bucket] of this.buckets.entries()) {
      if (nowMs - bucket.lastTouchedAtMs > this.cursorTtlMs * 2) {
        this.buckets.delete(transferId);
      }
    }
  }
}

export interface BoundedSseWriterOptions {
  readonly requestRaw: IncomingMessage;
  readonly responseRaw: ServerResponse;
  readonly maxPendingFrames: number;
  readonly maxBufferedBytes: number;
  readonly drainTimeoutMs: number;
  readonly onClose: () => void;
}

/**
 * Bounded SSE writer that respects Node stream backpressure (`write() === false`), skips heartbeat
 * comments while congested, bounds buffered frames/bytes, evicts stalled readers on drain timeout,
 * and detaches all socket listeners on teardown.
 */
export class BoundedSseWriter {
  private readonly requestRaw: IncomingMessage;
  private readonly responseRaw: ServerResponse;
  private readonly maxPendingFrames: number;
  private readonly maxBufferedBytes: number;
  private readonly drainTimeoutMs: number;
  private readonly onCloseCallback: () => void;

  private readonly pendingChunks: string[] = [];
  private bufferedBytes = 0;
  private waitingForDrain = false;
  private endRequested = false;
  private closed = false;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly handleSocketClose = (): void => {
    this.close();
  };

  private readonly handleDrain = (): void => {
    this.clearDrainTimer();
    this.waitingForDrain = false;
    this.flushPending();
  };

  constructor(options: BoundedSseWriterOptions) {
    this.requestRaw = options.requestRaw;
    this.responseRaw = options.responseRaw;
    this.maxPendingFrames = options.maxPendingFrames;
    this.maxBufferedBytes = options.maxBufferedBytes;
    this.drainTimeoutMs = options.drainTimeoutMs;
    this.onCloseCallback = options.onClose;

    this.requestRaw.on("close", this.handleSocketClose);
    this.responseRaw.on("close", this.handleSocketClose);
    this.responseRaw.on("error", this.handleSocketClose);
  }

  isClosed(): boolean {
    return this.closed || this.responseRaw.writableEnded || this.responseRaw.destroyed;
  }

  isBackpressured(): boolean {
    return this.waitingForDrain;
  }

  writeFrame(chunk: string): boolean {
    if (this.isClosed() || this.endRequested) {
      return false;
    }

    if (this.waitingForDrain) {
      return this.enqueueChunk(chunk);
    }

    const flushed = this.responseRaw.write(chunk);
    if (!flushed) {
      this.armDrainWait();
    }
    return true;
  }

  writeHeartbeat(commentChunk: string): void {
    if (this.isClosed() || this.waitingForDrain || this.endRequested) {
      return;
    }
    const flushed = this.responseRaw.write(commentChunk);
    if (!flushed) {
      this.armDrainWait();
    }
  }

  endStream(): void {
    if (this.isClosed()) {
      this.close();
      return;
    }
    this.endRequested = true;
    if (!this.waitingForDrain && this.pendingChunks.length === 0) {
      if (!this.responseRaw.writableEnded && !this.responseRaw.destroyed) {
        this.responseRaw.end();
      }
      this.close();
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.pendingChunks.length = 0;
    this.bufferedBytes = 0;
    this.waitingForDrain = false;
    this.clearDrainTimer();

    this.requestRaw.off("close", this.handleSocketClose);
    this.responseRaw.off("close", this.handleSocketClose);
    this.responseRaw.off("error", this.handleSocketClose);
    this.responseRaw.off("drain", this.handleDrain);

    this.onCloseCallback();
  }

  private enqueueChunk(chunk: string): boolean {
    const byteLength = Buffer.byteLength(chunk, "utf8");
    if (
      this.pendingChunks.length >= this.maxPendingFrames ||
      this.bufferedBytes + byteLength > this.maxBufferedBytes
    ) {
      this.evictSlowReader();
      return false;
    }

    this.pendingChunks.push(chunk);
    this.bufferedBytes += byteLength;
    return true;
  }

  private flushPending(): void {
    if (this.isClosed()) {
      this.close();
      return;
    }

    while (this.pendingChunks.length > 0) {
      const next = this.pendingChunks.shift();
      if (next === undefined) break;
      this.bufferedBytes -= Buffer.byteLength(next, "utf8");
      const flushed = this.responseRaw.write(next);
      if (!flushed) {
        this.armDrainWait();
        return;
      }
    }

    if (this.endRequested) {
      if (!this.responseRaw.writableEnded && !this.responseRaw.destroyed) {
        this.responseRaw.end();
      }
      this.close();
    }
  }

  private armDrainWait(): void {
    if (this.waitingForDrain || this.isClosed()) {
      return;
    }
    this.waitingForDrain = true;
    this.responseRaw.once("drain", this.handleDrain);
    this.drainTimer = setTimeout(() => {
      this.evictSlowReader();
    }, this.drainTimeoutMs);
    this.drainTimer.unref();
  }

  private clearDrainTimer(): void {
    if (this.drainTimer !== null) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
  }

  private evictSlowReader(): void {
    if (!this.responseRaw.writableEnded && !this.responseRaw.destroyed) {
      this.responseRaw.end();
    }
    this.close();
  }
}
