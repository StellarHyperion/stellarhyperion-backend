import type { Queryable } from "../db/pool.js";
import {
  bigintOf,
  bigintOrNull,
  maybeOne,
  one,
  text,
  textOrNull,
  timestamp,
  type Row,
} from "../db/rows.js";
import type {
  AcquireSignerLeaseInput,
  BroadcastFenceInput,
  ReconcileLeaseRecoveryInput,
  ReserveSequenceInput,
  SequenceOutcomeInput,
  SequenceReservation,
  SignerLeaseHandle,
  SignerLeaseRecord,
  SignerLeaseStorePort,
} from "./types.js";

export class SignerLeaseBusyError extends Error {
  readonly signerPublicKey: string;
  readonly activeHolderId: string;
  readonly expiresAt: Date;

  constructor(signerPublicKey: string, activeHolderId: string, expiresAt: Date) {
    super(
      `Keeper signer lease for ${signerPublicKey} is currently held by ${activeHolderId} until ${expiresAt.toISOString()}.`,
    );
    this.name = "SignerLeaseBusyError";
    this.signerPublicKey = signerPublicKey;
    this.activeHolderId = activeHolderId;
    this.expiresAt = expiresAt;
  }
}

export class SignerLeaseLostError extends Error {
  readonly signerPublicKey: string;
  readonly holderId: string;
  readonly expectedFenceToken: bigint;
  readonly actualHolderId: string | null;
  readonly actualFenceToken: bigint | null;

  constructor(
    signerPublicKey: string,
    holderId: string,
    expectedFenceToken: bigint,
    actualHolderId: string | null,
    actualFenceToken: bigint | null,
  ) {
    super(
      `Keeper signer lease lost for ${signerPublicKey} (holder=${holderId}, expectedFence=${String(expectedFenceToken)}, actualHolder=${actualHolderId ?? "none"}, actualFence=${actualFenceToken === null ? "none" : String(actualFenceToken)}); aborting work before broadcast.`,
    );
    this.name = "SignerLeaseLostError";
    this.signerPublicKey = signerPublicKey;
    this.holderId = holderId;
    this.expectedFenceToken = expectedFenceToken;
    this.actualHolderId = actualHolderId;
    this.actualFenceToken = actualFenceToken;
  }
}

export class PendingInFlightSequenceError extends Error {
  readonly signerPublicKey: string;
  readonly lastReservedSequence: bigint;
  readonly onChainSequence: bigint;
  readonly inFlightTxHash: string;

  constructor(
    signerPublicKey: string,
    lastReservedSequence: bigint,
    onChainSequence: bigint,
    inFlightTxHash: string,
  ) {
    super(
      `Cannot advance keeper signer ${signerPublicKey} after crash takeover: in-flight tx ${inFlightTxHash} at sequence ${String(lastReservedSequence)} is still unresolved on chain (account sequence ${String(onChainSequence)}).`,
    );
    this.name = "PendingInFlightSequenceError";
    this.signerPublicKey = signerPublicKey;
    this.lastReservedSequence = lastReservedSequence;
    this.onChainSequence = onChainSequence;
    this.inFlightTxHash = inFlightTxHash;
  }
}

function parseLeaseRow(row: Row): SignerLeaseRecord {
  return {
    signerPublicKey: text(row, "signer_public_key"),
    chain: text(row, "chain"),
    holderId: text(row, "holder_id"),
    fenceToken: bigintOf(row, "fence_token"),
    lastReservedSequence: bigintOrNull(row, "last_reserved_sequence"),
    lastConfirmedSequence: bigintOrNull(row, "last_confirmed_sequence"),
    inFlightTxHash: textOrNull(row, "in_flight_tx_hash"),
    acquiredAt: timestamp(row, "acquired_at"),
    expiresAt: timestamp(row, "expires_at"),
    updatedAt: timestamp(row, "updated_at"),
  };
}

export class PostgresSignerLeaseStore implements SignerLeaseStorePort {
  constructor(
    private readonly db: Queryable,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  private resolveNow(nowMs?: number): Date {
    return new Date(nowMs ?? this.clock());
  }

  async inspect(signerPublicKey: string): Promise<SignerLeaseRecord | null> {
    const { rows } = await this.db.query(
      `SELECT signer_public_key, chain, holder_id, fence_token,
              last_reserved_sequence, last_confirmed_sequence, in_flight_tx_hash,
              acquired_at, expires_at, updated_at
         FROM keeper_signer_lease
        WHERE signer_public_key = $1`,
      [signerPublicKey],
    );
    const row = maybeOne(rows, "keeper_signer_lease.inspect");
    return row ? parseLeaseRow(row) : null;
  }

  async acquireOrRenew(input: AcquireSignerLeaseInput): Promise<SignerLeaseHandle> {
    const now = this.resolveNow(input.nowMs);
    const expiresAt = new Date(now.getTime() + input.leaseTtlMs);
    const previous = await this.inspect(input.signerPublicKey);

    const { rows } = await this.db.query(
      `INSERT INTO keeper_signer_lease (
         signer_public_key, chain, holder_id, fence_token,
         last_reserved_sequence, last_confirmed_sequence, in_flight_tx_hash,
         acquired_at, expires_at, updated_at
       )
       VALUES ($1, $2, $3, 1, NULL, NULL, NULL, $4, $5, $4)
       ON CONFLICT (signer_public_key) DO UPDATE SET
         chain = EXCLUDED.chain,
         holder_id = EXCLUDED.holder_id,
         fence_token = CASE
           WHEN keeper_signer_lease.holder_id = EXCLUDED.holder_id
                AND keeper_signer_lease.expires_at > $4
             THEN keeper_signer_lease.fence_token
           ELSE keeper_signer_lease.fence_token + 1
         END,
         acquired_at = CASE
           WHEN keeper_signer_lease.holder_id = EXCLUDED.holder_id
                AND keeper_signer_lease.expires_at > $4
             THEN keeper_signer_lease.acquired_at
           ELSE $4
         END,
         expires_at = $5,
         updated_at = $4
       WHERE (keeper_signer_lease.holder_id = EXCLUDED.holder_id AND keeper_signer_lease.expires_at > $4)
          OR keeper_signer_lease.expires_at <= $4
       RETURNING signer_public_key, chain, holder_id, fence_token,
                 last_reserved_sequence, last_confirmed_sequence, in_flight_tx_hash,
                 acquired_at, expires_at, updated_at`,
      [
        input.signerPublicKey,
        input.chain,
        input.holderId,
        now.toISOString(),
        expiresAt.toISOString(),
      ],
    );

    if (rows.length === 0) {
      const current = await this.inspect(input.signerPublicKey);
      throw new SignerLeaseBusyError(
        input.signerPublicKey,
        current?.holderId ?? "unknown",
        current?.expiresAt ?? expiresAt,
      );
    }

    const record = parseLeaseRow(one(rows, "keeper_signer_lease.acquireOrRenew"));
    const tookOverExpiredLease =
      previous !== null &&
      (previous.holderId !== input.holderId || previous.expiresAt.getTime() <= now.getTime());

    return {
      ...record,
      tookOverExpiredLease,
    };
  }

  async reconcileRecoveredState(input: ReconcileLeaseRecoveryInput): Promise<SignerLeaseRecord> {
    const now = this.resolveNow(input.nowMs);
    const floorSequence =
      input.settledInFlightSequence !== undefined && input.settledInFlightSequence !== null
        ? input.settledInFlightSequence > input.onChainSequence
          ? input.settledInFlightSequence
          : input.onChainSequence
        : input.onChainSequence;

    const { rows } = await this.db.query(
      `UPDATE keeper_signer_lease
          SET last_confirmed_sequence = CASE
                WHEN last_confirmed_sequence IS NULL THEN $5::numeric(20,0)
                ELSE GREATEST(last_confirmed_sequence, $5::numeric(20,0))
              END,
              last_reserved_sequence = CASE
                WHEN $6::boolean THEN GREATEST(COALESCE(last_confirmed_sequence, 0), $5::numeric(20,0))
                ELSE GREATEST(COALESCE(last_reserved_sequence, 0), $5::numeric(20,0))
              END,
              in_flight_tx_hash = NULL,
              updated_at = $4
        WHERE signer_public_key = $1
          AND holder_id = $2
          AND fence_token = $3
          AND expires_at > $4
        RETURNING signer_public_key, chain, holder_id, fence_token,
                  last_reserved_sequence, last_confirmed_sequence, in_flight_tx_hash,
                  acquired_at, expires_at, updated_at`,
      [
        input.signerPublicKey,
        input.holderId,
        String(input.fenceToken),
        now.toISOString(),
        String(floorSequence),
        input.clearUnbroadcastReservation,
      ],
    );

    if (rows.length === 0) {
      const actual = await this.inspect(input.signerPublicKey);
      throw new SignerLeaseLostError(
        input.signerPublicKey,
        input.holderId,
        input.fenceToken,
        actual?.holderId ?? null,
        actual?.fenceToken ?? null,
      );
    }

    return parseLeaseRow(one(rows, "keeper_signer_lease.reconcileRecoveredState"));
  }

  async reserveNextSequence(input: ReserveSequenceInput): Promise<SequenceReservation> {
    const now = this.resolveNow(input.nowMs);
    const expiresAt = new Date(now.getTime() + input.leaseTtlMs);

    const { rows } = await this.db.query(
      `UPDATE keeper_signer_lease
          SET last_reserved_sequence = GREATEST(
                $5::numeric(20,0),
                COALESCE(last_confirmed_sequence, 0),
                COALESCE(last_reserved_sequence, 0)
              ) + 1,
              expires_at = $6,
              updated_at = $4
        WHERE signer_public_key = $1
          AND holder_id = $2
          AND fence_token = $3
          AND expires_at > $4
        RETURNING signer_public_key, chain, holder_id, fence_token,
                  last_reserved_sequence, last_confirmed_sequence, in_flight_tx_hash,
                  acquired_at, expires_at, updated_at`,
      [
        input.signerPublicKey,
        input.holderId,
        String(input.fenceToken),
        now.toISOString(),
        String(input.onChainSequence),
        expiresAt.toISOString(),
      ],
    );

    if (rows.length === 0) {
      const actual = await this.inspect(input.signerPublicKey);
      throw new SignerLeaseLostError(
        input.signerPublicKey,
        input.holderId,
        input.fenceToken,
        actual?.holderId ?? null,
        actual?.fenceToken ?? null,
      );
    }

    const updated = parseLeaseRow(one(rows, "keeper_signer_lease.reserveNextSequence"));
    const nextSequence = updated.lastReservedSequence ?? input.onChainSequence + 1n;
    return {
      accountStartingSequence: nextSequence - 1n,
      nextSequence,
      fenceToken: updated.fenceToken,
    };
  }

  async assertFenceBeforeBroadcast(input: BroadcastFenceInput): Promise<void> {
    const now = this.resolveNow(input.nowMs);
    const { rows } = await this.db.query(
      `UPDATE keeper_signer_lease
          SET in_flight_tx_hash = $5,
              updated_at = $4
        WHERE signer_public_key = $1
          AND holder_id = $2
          AND fence_token = $3
          AND expires_at > $4
          AND last_reserved_sequence = $6
        RETURNING fence_token`,
      [
        input.signerPublicKey,
        input.holderId,
        String(input.fenceToken),
        now.toISOString(),
        input.txHash,
        String(input.sequenceNumber),
      ],
    );

    if (rows.length === 0) {
      const actual = await this.inspect(input.signerPublicKey);
      throw new SignerLeaseLostError(
        input.signerPublicKey,
        input.holderId,
        input.fenceToken,
        actual?.holderId ?? null,
        actual?.fenceToken ?? null,
      );
    }
  }

  async recordSequenceOutcome(input: SequenceOutcomeInput): Promise<void> {
    const now = this.resolveNow(input.nowMs);
    if (input.outcome === "confirmed") {
      await this.db.query(
        `UPDATE keeper_signer_lease
            SET last_confirmed_sequence = GREATEST(COALESCE(last_confirmed_sequence, 0), $5::numeric(20,0)),
                last_reserved_sequence = GREATEST(COALESCE(last_reserved_sequence, 0), $5::numeric(20,0)),
                in_flight_tx_hash = NULL,
                updated_at = $4
          WHERE signer_public_key = $1
            AND holder_id = $2
            AND fence_token = $3`,
        [
          input.signerPublicKey,
          input.holderId,
          String(input.fenceToken),
          now.toISOString(),
          String(input.sequenceNumber),
        ],
      );
      return;
    }

    await this.db.query(
      `UPDATE keeper_signer_lease
          SET last_reserved_sequence = GREATEST(
                COALESCE(last_confirmed_sequence, 0),
                $5::numeric(20,0) - 1
              ),
              in_flight_tx_hash = NULL,
              updated_at = $4
        WHERE signer_public_key = $1
          AND holder_id = $2
          AND fence_token = $3`,
      [
        input.signerPublicKey,
        input.holderId,
        String(input.fenceToken),
        now.toISOString(),
        String(input.sequenceNumber),
      ],
    );
  }

  async release(
    signerPublicKey: string,
    holderId: string,
    fenceToken?: bigint,
    nowMs?: number,
  ): Promise<boolean> {
    const now = this.resolveNow(nowMs);
    if (fenceToken !== undefined) {
      const res = await this.db.query(
        `UPDATE keeper_signer_lease
            SET expires_at = $4,
                updated_at = $4
          WHERE signer_public_key = $1
            AND holder_id = $2
            AND fence_token = $3
            AND expires_at > $4`,
        [signerPublicKey, holderId, String(fenceToken), now.toISOString()],
      );
      return res.rowCount > 0;
    }

    const res = await this.db.query(
      `UPDATE keeper_signer_lease
          SET expires_at = $3,
              updated_at = $3
        WHERE signer_public_key = $1
          AND holder_id = $2
          AND expires_at > $3`,
      [signerPublicKey, holderId, now.toISOString()],
    );
    return res.rowCount > 0;
  }
}

export class InMemorySignerLeaseStore implements SignerLeaseStorePort {
  private readonly leases = new Map<string, SignerLeaseRecord>();

  constructor(private readonly clock: () => number = () => Date.now()) {}

  private resolveNow(nowMs?: number): Date {
    return new Date(nowMs ?? this.clock());
  }

  inspect(signerPublicKey: string): Promise<SignerLeaseRecord | null> {
    return Promise.resolve(this.leases.get(signerPublicKey) ?? null);
  }

  acquireOrRenew(input: AcquireSignerLeaseInput): Promise<SignerLeaseHandle> {
    const now = this.resolveNow(input.nowMs);
    const expiresAt = new Date(now.getTime() + input.leaseTtlMs);
    const existing = this.leases.get(input.signerPublicKey);

    if (!existing) {
      const created: SignerLeaseRecord = {
        signerPublicKey: input.signerPublicKey,
        chain: input.chain,
        holderId: input.holderId,
        fenceToken: 1n,
        lastReservedSequence: null,
        lastConfirmedSequence: null,
        inFlightTxHash: null,
        acquiredAt: now,
        expiresAt,
        updatedAt: now,
      };
      this.leases.set(input.signerPublicKey, created);
      return Promise.resolve({ ...created, tookOverExpiredLease: false });
    }

    const active = existing.expiresAt.getTime() > now.getTime();
    if (active && existing.holderId !== input.holderId) {
      return Promise.reject(
        new SignerLeaseBusyError(input.signerPublicKey, existing.holderId, existing.expiresAt),
      );
    }

    if (active && existing.holderId === input.holderId) {
      const renewed: SignerLeaseRecord = {
        ...existing,
        chain: input.chain,
        expiresAt,
        updatedAt: now,
      };
      this.leases.set(input.signerPublicKey, renewed);
      return Promise.resolve({ ...renewed, tookOverExpiredLease: false });
    }

    const takenOver: SignerLeaseRecord = {
      ...existing,
      chain: input.chain,
      holderId: input.holderId,
      fenceToken: existing.fenceToken + 1n,
      acquiredAt: now,
      expiresAt,
      updatedAt: now,
    };
    this.leases.set(input.signerPublicKey, takenOver);
    return Promise.resolve({ ...takenOver, tookOverExpiredLease: true });
  }

  reconcileRecoveredState(input: ReconcileLeaseRecoveryInput): Promise<SignerLeaseRecord> {
    const now = this.resolveNow(input.nowMs);
    const existing = this.leases.get(input.signerPublicKey);
    if (
      existing?.holderId !== input.holderId ||
      existing.fenceToken !== input.fenceToken ||
      existing.expiresAt.getTime() <= now.getTime()
    ) {
      return Promise.reject(
        new SignerLeaseLostError(
          input.signerPublicKey,
          input.holderId,
          input.fenceToken,
          existing?.holderId ?? null,
          existing?.fenceToken ?? null,
        ),
      );
    }

    const floor =
      input.settledInFlightSequence !== undefined &&
      input.settledInFlightSequence !== null &&
      input.settledInFlightSequence > input.onChainSequence
        ? input.settledInFlightSequence
        : input.onChainSequence;
    const prevConfirmed = existing.lastConfirmedSequence ?? 0n;
    const prevReserved = existing.lastReservedSequence ?? 0n;
    const nextConfirmed = prevConfirmed > floor ? prevConfirmed : floor;
    const nextReserved = input.clearUnbroadcastReservation
      ? nextConfirmed
      : prevReserved > floor
        ? prevReserved
        : floor;

    const updated: SignerLeaseRecord = {
      ...existing,
      lastConfirmedSequence: nextConfirmed,
      lastReservedSequence: nextReserved,
      inFlightTxHash: null,
      updatedAt: now,
    };
    this.leases.set(input.signerPublicKey, updated);
    return Promise.resolve(updated);
  }

  reserveNextSequence(input: ReserveSequenceInput): Promise<SequenceReservation> {
    const now = this.resolveNow(input.nowMs);
    const existing = this.leases.get(input.signerPublicKey);
    if (
      existing?.holderId !== input.holderId ||
      existing.fenceToken !== input.fenceToken ||
      existing.expiresAt.getTime() <= now.getTime()
    ) {
      return Promise.reject(
        new SignerLeaseLostError(
          input.signerPublicKey,
          input.holderId,
          input.fenceToken,
          existing?.holderId ?? null,
          existing?.fenceToken ?? null,
        ),
      );
    }

    const base = [
      input.onChainSequence,
      existing.lastConfirmedSequence ?? 0n,
      existing.lastReservedSequence ?? 0n,
    ].reduce((max, val) => (val > max ? val : max), 0n);
    const nextSequence = base + 1n;
    const updated: SignerLeaseRecord = {
      ...existing,
      lastReservedSequence: nextSequence,
      expiresAt: new Date(now.getTime() + input.leaseTtlMs),
      updatedAt: now,
    };
    this.leases.set(input.signerPublicKey, updated);
    return Promise.resolve({
      accountStartingSequence: nextSequence - 1n,
      nextSequence,
      fenceToken: updated.fenceToken,
    });
  }

  assertFenceBeforeBroadcast(input: BroadcastFenceInput): Promise<void> {
    const now = this.resolveNow(input.nowMs);
    const existing = this.leases.get(input.signerPublicKey);
    if (
      existing?.holderId !== input.holderId ||
      existing.fenceToken !== input.fenceToken ||
      existing.expiresAt.getTime() <= now.getTime() ||
      existing.lastReservedSequence !== input.sequenceNumber
    ) {
      return Promise.reject(
        new SignerLeaseLostError(
          input.signerPublicKey,
          input.holderId,
          input.fenceToken,
          existing?.holderId ?? null,
          existing?.fenceToken ?? null,
        ),
      );
    }

    this.leases.set(input.signerPublicKey, {
      ...existing,
      inFlightTxHash: input.txHash,
      updatedAt: now,
    });
    return Promise.resolve();
  }

  recordSequenceOutcome(input: SequenceOutcomeInput): Promise<void> {
    const now = this.resolveNow(input.nowMs);
    const existing = this.leases.get(input.signerPublicKey);
    if (existing?.holderId !== input.holderId || existing.fenceToken !== input.fenceToken) {
      return Promise.resolve();
    }

    const prevConfirmed = existing.lastConfirmedSequence ?? 0n;
    if (input.outcome === "confirmed") {
      const confirmed = prevConfirmed > input.sequenceNumber ? prevConfirmed : input.sequenceNumber;
      const reserved =
        (existing.lastReservedSequence ?? 0n) > confirmed
          ? (existing.lastReservedSequence ?? 0n)
          : confirmed;
      this.leases.set(input.signerPublicKey, {
        ...existing,
        lastConfirmedSequence: confirmed,
        lastReservedSequence: reserved,
        inFlightTxHash: null,
        updatedAt: now,
      });
      return Promise.resolve();
    }

    const rolledBack = input.sequenceNumber - 1n;
    const reserved = prevConfirmed > rolledBack ? prevConfirmed : rolledBack;
    this.leases.set(input.signerPublicKey, {
      ...existing,
      lastReservedSequence: reserved,
      inFlightTxHash: null,
      updatedAt: now,
    });
    return Promise.resolve();
  }

  release(
    signerPublicKey: string,
    holderId: string,
    fenceToken?: bigint,
    nowMs?: number,
  ): Promise<boolean> {
    const now = this.resolveNow(nowMs);
    const existing = this.leases.get(signerPublicKey);
    if (existing?.holderId !== holderId || existing.expiresAt.getTime() <= now.getTime()) {
      return Promise.resolve(false);
    }
    if (fenceToken !== undefined && existing.fenceToken !== fenceToken) {
      return Promise.resolve(false);
    }
    this.leases.set(signerPublicKey, {
      ...existing,
      expiresAt: now,
      updatedAt: now,
    });
    return Promise.resolve(true);
  }
}
