import type { rpc } from "@stellar/stellar-sdk";
import type { AppConfig } from "../config/config.js";
import { textOrNull } from "../db/rows.js";
import type { Transactional } from "../db/pool.js";

export class KeeperMaintenancePausedError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "KeeperMaintenancePausedError";
  }
}

export class KeeperSpendingCapReachedError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "KeeperSpendingCapReachedError";
  }
}

export interface SpendingDecision {
  readonly paused: boolean;
  readonly allowed: boolean;
  readonly detail: string;
}

interface SpendingWindow {
  readonly kind: "daily" | "ledger";
  readonly key: string;
  readonly cap: string;
}

export async function reserveKeeperSpending(
  config: AppConfig,
  db: Transactional,
  chainKey: string,
  signer: string,
  amountStroops: bigint,
  client: rpc.Server,
): Promise<SpendingDecision> {
  if (amountStroops < 0n) throw new Error("Keeper reservation amount cannot be negative.");
  const dayKey = new Date().toISOString().slice(0, 10);
  if (config.keeper.paused) {
    await db.query(
      `INSERT INTO keeper_spending_audit(chain_key,signer,window_kind,window_key,decision,amount_stroops,detail)
       VALUES ($1,$2,'daily',$3,'paused',$4,'maintenance paused by KEEPER_PAUSED')`,
      [chainKey, signer, dayKey, amountStroops.toString()],
    );
    return { paused: true, allowed: false, detail: "Keeper maintenance is paused." };
  }

  const latest = await client.getLatestLedger();
  const ledger = BigInt(String(latest.sequence));
  if (ledger < 0n) throw new Error("Keeper ledger sequence is invalid.");
  const width = BigInt(config.keeper.ledgerWindowLedgers);
  if (width <= 0n) throw new Error("Keeper ledger window must be positive.");
  const windows: readonly SpendingWindow[] = [
    { kind: "daily", key: dayKey, cap: config.keeper.dailyCapStroops },
    {
      kind: "ledger",
      key: ((ledger / width) * width).toString(),
      cap: config.keeper.ledgerCapStroops,
    },
  ];

  return db.transaction(async (tx) => {
    const active: {
      readonly window: SpendingWindow;
      readonly spent: bigint;
      readonly cap: bigint;
      readonly override: string | null;
      readonly reason: string | null;
    }[] = [];
    for (const window of windows) {
      const inserted = await tx.query(
        `INSERT INTO keeper_spending_window
           (chain_key,signer,window_kind,window_key,spent_stroops,cap_stroops,override_stroops,override_reason)
         VALUES ($1,$2,$3,$4,0,$5,$6,$7)
         ON CONFLICT (chain_key,signer,window_kind,window_key) DO NOTHING
         RETURNING window_key`,
        [
          chainKey,
          signer,
          window.kind,
          window.key,
          config.keeper.overrideStroops ?? window.cap,
          config.keeper.overrideStroops,
          config.keeper.overrideReason,
        ],
      );
      if (inserted.rows.length > 0) {
        await tx.query(
          `INSERT INTO keeper_spending_audit
             (chain_key,signer,window_kind,window_key,decision,amount_stroops,detail)
           VALUES ($1,$2,$3,$4,'reset',0,$5)`,
          [
            chainKey,
            signer,
            window.kind,
            window.key,
            `new spending window; cap=${config.keeper.overrideStroops ?? window.cap} stroops`,
          ],
        );
      }

      const result = await tx.query(
        `SELECT spent_stroops,cap_stroops,override_stroops,override_reason
         FROM keeper_spending_window
         WHERE chain_key=$1 AND signer=$2 AND window_kind=$3 AND window_key=$4
         FOR UPDATE`,
        [chainKey, signer, window.kind, window.key],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("Keeper spending window could not be established.");
      const previousOverride = textOrNull(row, "override_stroops");
      const previousReason = textOrNull(row, "override_reason");
      const effectiveCap = config.keeper.overrideStroops ?? window.cap;
      if (
        previousOverride !== config.keeper.overrideStroops ||
        previousReason !== config.keeper.overrideReason
      ) {
        await tx.query(
          `INSERT INTO keeper_spending_audit
             (chain_key,signer,window_kind,window_key,decision,amount_stroops,detail)
           VALUES ($1,$2,$3,$4,'override',0,$5)`,
          [
            chainKey,
            signer,
            window.kind,
            window.key,
            config.keeper.overrideStroops === null
              ? "operator spending override cleared"
              : `operator spending override set to ${config.keeper.overrideStroops} stroops: ${config.keeper.overrideReason}`,
          ],
        );
      }
      await tx.query(
        `UPDATE keeper_spending_window
         SET cap_stroops=$5,override_stroops=$6,override_reason=$7,updated_at=now()
         WHERE chain_key=$1 AND signer=$2 AND window_kind=$3 AND window_key=$4`,
        [
          chainKey,
          signer,
          window.kind,
          window.key,
          effectiveCap,
          config.keeper.overrideStroops,
          config.keeper.overrideReason,
        ],
      );
      active.push({
        window,
        spent: BigInt(String(row.spent_stroops)),
        cap: BigInt(effectiveCap),
        override: config.keeper.overrideStroops,
        reason: config.keeper.overrideReason,
      });
    }

    for (const { window, spent, cap } of active) {
      if (spent + amountStroops > cap) {
        const detail = `spending cap reached: spent=${spent.toString()} cap=${cap.toString()}`;
        await tx.query(
          `INSERT INTO keeper_spending_audit
             (chain_key,signer,window_kind,window_key,decision,amount_stroops,detail)
           VALUES ($1,$2,$3,$4,'paused',$5,$6)`,
          [chainKey, signer, window.kind, window.key, amountStroops.toString(), detail],
        );
        return {
          paused: false,
          allowed: false,
          detail: `Keeper ${window.kind} spending cap reached.`,
        };
      }
    }

    for (const { window, cap, override, reason } of active) {
      await tx.query(
        `UPDATE keeper_spending_window
         SET spent_stroops=spent_stroops+$5,updated_at=now()
         WHERE chain_key=$1 AND signer=$2 AND window_kind=$3 AND window_key=$4`,
        [chainKey, signer, window.kind, window.key, amountStroops.toString()],
      );
      await tx.query(
        `INSERT INTO keeper_spending_audit
           (chain_key,signer,window_kind,window_key,decision,amount_stroops,detail)
         VALUES ($1,$2,$3,$4,'reserved',$5,$6)`,
        [
          chainKey,
          signer,
          window.kind,
          window.key,
          amountStroops.toString(),
          override === null
            ? `configured spending cap reservation; cap=${cap.toString()} stroops`
            : `explicit override: ${reason}`,
        ],
      );
    }
    return { paused: false, allowed: true, detail: "Spending cap reservation committed." };
  });
}
