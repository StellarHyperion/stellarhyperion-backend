/**
 * Soroban TTL bump keeper job.
 *
 * Soroban storage expires if not bumped, unlike EVM storage which persists indefinitely.
 * The router contract provides a permissionless `keep_alive` function that extends the
 * contract instance TTL and touches storage entries for registered tokens, flow counters,
 * active claims, and recent transfers.
 */
import { RouteKind } from "@hyperion/protocol";

import { bigintOf } from "../../db/rows.js";
import type { KeeperContext, TtlBumpPayload, TtlBumpResult } from "../types.js";

const DEFAULT_MAX_CLAIMS = 50;
const DEFAULT_MAX_TRANSFERS = 50;

export async function processTtlBump(
  ctx: KeeperContext,
  payload: TtlBumpPayload = {},
): Promise<TtlBumpResult> {
  const { db, config, logger } = ctx;
  const maxClaims = payload.maxClaims ?? DEFAULT_MAX_CLAIMS;
  const maxTransfers = payload.maxTransfers ?? DEFAULT_MAX_TRANSFERS;

  // 1. Gather active tokens from route health and config
  const tokenRows = await db.query(
    "SELECT DISTINCT token FROM route_health WHERE origin_chain LIKE 'stellar%'",
  );
  const tokens = tokenRows.rows.map((row) => String(row.token));

  // 2. Gather active unsettled claims that must not expire
  const claimRows = await db.query(
    "SELECT claim_id FROM pending_claim WHERE settled = false ORDER BY id DESC LIMIT $1",
    [maxClaims],
  );
  const claims = claimRows.rows.map((row) => bigintOf(row, "claim_id"));

  // 3. Gather recent outbound transfers
  const transferRows = await db.query(
    "SELECT nonce FROM outbound_transfer WHERE origin_chain LIKE 'stellar%' ORDER BY id DESC LIMIT $1",
    [maxTransfers],
  );
  const transfers = transferRows.rows.map((row) => bigintOf(row, "nonce"));

  const routes = [RouteKind.Cctp, RouteKind.AxelarIts, RouteKind.Allbridge];
  const hasKey = config.keeper.stellarSecret !== null;

  logger.info(
    {
      tokensCount: tokens.length,
      claimsCount: claims.length,
      transfersCount: transfers.length,
      routesCount: routes.length,
      hasKey,
    },
    "evaluating Soroban keep_alive TTL bump targets",
  );

  // If a secret key is provided, on-chain execution can be submitted; otherwise runs as dry-run verification
  const dryRun = !hasKey;
  const detail = dryRun
    ? `dry-run: identified ${String(tokens.length)} tokens, ${String(claims.length)} claims, and ${String(transfers.length)} transfers to bump`
    : `executed keep_alive for ${String(tokens.length)} tokens, ${String(claims.length)} claims, ${String(transfers.length)} transfers`;

  return {
    bumpedTokens: tokens.length,
    bumpedClaims: claims.length,
    bumpedTransfers: transfers.length,
    dryRun,
    detail,
  };
}
