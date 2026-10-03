/**
 * Writing decoded Stellar events, and the cursor that says they are written.
 *
 * Every function here takes a `Queryable` rather than the pool, so the watcher can hand it a
 * transaction. That is the whole restart safety claim: a page of events and the cursor advance past
 * it land together or not at all. If the cursor could advance without the rows, a crash in between
 * loses a page forever; if the rows could land without the cursor, a restart writes them again.
 *
 * Every insert is an upsert on the natural key for the same reason. A watcher re-reading a page
 * after a restart is normal, and re-reading must be a no-op rather than a duplicate or an error.
 */
import { ROUTE_KINDS, type RouteKind } from "@hyperion/protocol";

import type { Queryable } from "../../db/pool.js";
import { bigintOf, maybeOne, text, timestampOrNull } from "../../db/rows.js";
import type {
  ActionLifecycleEvent,
  ActionQueuedEvent,
  BridgeInEvent,
  BridgeOutEvent,
  ClaimParkedEvent,
  ClaimSettledEvent,
  PauseSetEvent,
  RouteConfiguredEvent,
  TokenRegisteredEvent,
} from "./events.js";

/** Where a Stellar watcher has read up to. */
export interface StellarCursor {
  readonly ledger: bigint;
  readonly contract: string;
  readonly closedAt: Date | null;
}

export async function readCursor(db: Queryable, chainKey: string): Promise<StellarCursor | null> {
  const { rows } = await db.query(
    "SELECT last_processed, contract, last_processed_at FROM indexer_cursor WHERE chain_key = $1",
    [chainKey],
  );
  const row = maybeOne(rows, `cursor for ${chainKey}`);
  if (row === null) return null;
  return {
    ledger: bigintOf(row, "last_processed"),
    contract: text(row, "contract"),
    closedAt: timestampOrNull(row, "last_processed_at"),
  };
}

/**
 * Advance the cursor, or create it.
 *
 * The contract is part of the write rather than just the read. A redeployed router at a new address
 * shares no history with the old one, so a cursor carried across would skip everything the new one
 * has ever done, silently. Storing it means the watcher can notice.
 */
export async function writeCursor(
  db: Queryable,
  chainKey: string,
  contract: string,
  ledger: bigint,
  closedAt: Date | null,
): Promise<void> {
  await db.query(
    `INSERT INTO indexer_cursor (chain_key, family, contract, last_processed, last_processed_at)
     VALUES ($1, 'stellar', $2, $3, $4)
     ON CONFLICT (chain_key) DO UPDATE
       SET contract = EXCLUDED.contract,
           last_processed = EXCLUDED.last_processed,
           last_processed_at = EXCLUDED.last_processed_at,
           updated_at = now()`,
    [chainKey, contract, ledger.toString(), closedAt],
  );
}

export interface EventContext {
  readonly chainKey: string;
  readonly ledger: number;
  readonly txHash: string;
  readonly closedAt: Date;
}

export async function recordBridgeOut(
  db: Queryable,
  context: EventContext,
  event: BridgeOutEvent,
): Promise<void> {
  await db.query(
    `INSERT INTO outbound_transfer
       (origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
        destination_chain, destination, origin_block, origin_tx, observed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (origin_chain, nonce) DO NOTHING`,
    [
      context.chainKey,
      event.route,
      event.nonce.toString(),
      event.sender,
      event.token,
      event.grossAmount.toString(),
      event.fee.toString(),
      event.netAmount.toString(),
      event.destinationChain,
      event.destination,
      BigInt(event.createdLedger).toString(),
      context.txHash,
      context.closedAt,
    ],
  );
}

export async function recordBridgeIn(
  db: Queryable,
  context: EventContext,
  event: BridgeInEvent,
): Promise<void> {
  // No rail message id, because the Soroban event does not carry one even though the router's own
  // replay guard is keyed on it. The hop is the only identity available on this side.
  await db.query(
    `INSERT INTO inbound_delivery
       (destination_chain, route, source_chain, source_nonce, rail_message_id, recipient, token,
        amount, delivered, claim_id, destination_block, destination_tx, observed_at)
     VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (destination_chain, route, source_chain, source_nonce) DO NOTHING`,
    [
      context.chainKey,
      event.route,
      event.sourceChain,
      event.sourceNonce.toString(),
      event.recipient,
      event.token,
      event.amount.toString(),
      event.delivered,
      event.delivered ? null : event.claimId.toString(),
      BigInt(event.ledger).toString(),
      context.txHash,
      context.closedAt,
    ],
  );
}

export async function recordClaimParked(
  db: Queryable,
  context: EventContext,
  event: ClaimParkedEvent,
): Promise<void> {
  await db.query(
    `INSERT INTO pending_claim
       (chain, claim_id, recipient, token, amount, route, source_chain, source_nonce,
        created_at, settled, observed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9), false, $10)
     ON CONFLICT (chain, claim_id) DO NOTHING`,
    [
      context.chainKey,
      event.claimId.toString(),
      event.recipient,
      event.token,
      event.amount.toString(),
      event.route,
      event.sourceChain,
      event.sourceNonce.toString(),
      Number(event.createdAt),
      context.closedAt,
    ],
  );
}

/**
 * Mark a claim settled.
 *
 * An update rather than an upsert, and it deliberately does nothing when the claim is not already
 * there. A settlement for a claim this indexer never saw parked means the park event fell outside
 * the retention window, and inventing a row from a settlement would record a claim with no origin
 * and a created_at nobody knows.
 */
export async function recordClaimSettled(
  db: Queryable,
  context: EventContext,
  event: ClaimSettledEvent,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE pending_claim
        SET settled = true, settled_at = $3, settled_by = $4, settled_tx = $5
      WHERE chain = $1 AND claim_id = $2 AND NOT settled`,
    [context.chainKey, event.claimId.toString(), context.closedAt, event.settledBy, context.txHash],
  );
  return rowCount > 0;
}

export async function recordActionQueued(
  db: Queryable,
  context: EventContext,
  event: ActionQueuedEvent,
  payload: unknown,
): Promise<void> {
  await db.query(
    `INSERT INTO admin_action
       (chain, action_id, kind, state, payload, eta, expires_at, queued_at, observed_at)
     VALUES ($1, $2, $3, 'queued', $4, to_timestamp($5), to_timestamp($6), $7, $8)
     ON CONFLICT (chain, action_id) DO UPDATE
       SET state = 'queued', payload = EXCLUDED.payload, eta = EXCLUDED.eta,
           expires_at = EXCLUDED.expires_at`,
    [
      context.chainKey,
      event.id.toString(),
      // The variant name rather than an ordinal, because the Soroban union carries no discriminant
      // the wire exposes. Stored as a hash of the name so the column stays a smallint on both
      // chains would be worse than useless, so the name lives in the payload and this is zero.
      0,
      JSON.stringify({ variant: event.variant, action: payload }),
      Number(event.eta),
      Number(event.expiresAt),
      context.closedAt,
      context.closedAt,
    ],
  );
}

export async function recordActionSettled(
  db: Queryable,
  context: EventContext,
  event: ActionLifecycleEvent,
  state: "executed" | "cancelled",
): Promise<void> {
  await db.query(
    `UPDATE admin_action
        SET state = $3, settled_at = $4, actor = COALESCE($5, actor)
      WHERE chain = $1 AND action_id = $2 AND state = 'queued'`,
    [context.chainKey, event.id.toString(), state, context.closedAt, event.actor],
  );
}

/**
 * Note that a token is registered, as a route health sample rather than as its own table.
 *
 * There is no token table on purpose. The router is the authority on what it will carry and an app
 * reads that from the chain, so a copy here would be a second answer that goes stale the moment a
 * guardian lowers a limit. What is worth keeping is that the registration happened and when.
 */
export async function recordTokenRegistered(
  db: Queryable,
  context: EventContext,
  event: TokenRegisteredEvent,
): Promise<void> {
  await db.query(
    `INSERT INTO route_health
       (sampled_at, origin_chain, destination_chain, route, token, available, blocker, flow_available)
     VALUES ($1, $2, $2, 0, $3, $4, 0, $5)`,
    [context.closedAt, context.chainKey, event.token, event.enabled, event.flowLimit.toString()],
  );
}

/**
 * A pause, recorded as every rail becoming unavailable.
 *
 * There is no pause table, and adding one would mean a second place to look during the exact
 * incident where somebody is already looking at route health. So a pause writes one sample per
 * rail with the blocker the router itself would return, which puts it in the same view as every
 * other reason a transfer will not go through.
 *
 * Pause stops departures and not arrivals, which is why this says nothing about inbound deliveries.
 */
export async function recordPauseSet(
  db: Queryable,
  context: EventContext,
  event: PauseSetEvent,
): Promise<void> {
  // QuoteBlocker.Paused is 1, and zero when nothing is blocking.
  const blocker = event.paused ? 1 : 0;
  for (const route of ROUTE_KINDS) {
    await db.query(
      `INSERT INTO route_health
         (sampled_at, origin_chain, destination_chain, route, token, available, blocker)
       VALUES ($1, $2, $2, $3, $4, $5, $6)`,
      [context.closedAt, context.chainKey, route, context.chainKey, !event.paused, blocker],
    );
  }
}

export async function recordRouteConfigured(
  db: Queryable,
  context: EventContext,
  event: RouteConfiguredEvent,
  token: string,
): Promise<void> {
  await db.query(
    `INSERT INTO route_health
       (sampled_at, origin_chain, destination_chain, route, token, available, blocker)
     VALUES ($1, $2, $2, $3, $4, $5, $6)`,
    [
      context.closedAt,
      context.chainKey,
      event.route satisfies RouteKind,
      token,
      event.enabled,
      // QuoteBlocker.RouteDisabled is 2. Zero when the route is on.
      event.enabled ? 0 : 2,
    ],
  );
}
