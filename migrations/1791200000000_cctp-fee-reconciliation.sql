-- Up Migration

CREATE TABLE cctp_fee_reconciliation (
  transfer_id BIGINT PRIMARY KEY REFERENCES outbound_transfer (id) ON DELETE CASCADE,
  source_decimals INTEGER NOT NULL CHECK (source_decimals = 7),
  destination_decimals INTEGER NOT NULL CHECK (destination_decimals = 6),
  source_burned_amount NUMERIC(78, 0) NOT NULL CHECK (source_burned_amount >= 0),
  cctp_burn_amount NUMERIC(78, 0) NOT NULL CHECK (cctp_burn_amount >= 0),
  forwarding_budget_max_fee NUMERIC(78, 0) NOT NULL CHECK (forwarding_budget_max_fee >= 0),
  executed_fee_deduction NUMERIC(78, 0) CHECK (
    executed_fee_deduction IS NULL OR executed_fee_deduction >= 0
  ),
  planned_min_payout NUMERIC(78, 0) NOT NULL CHECK (planned_min_payout >= 0),
  actual_mint_payout NUMERIC(78, 0) CHECK (
    actual_mint_payout IS NULL OR actual_mint_payout >= 0
  ),
  status TEXT NOT NULL CHECK (status IN ('pending', 'reconciled', 'failed')),
  diagnostic_code TEXT,
  diagnostic_detail TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cctp_fee_reconciliation_settlement_invariant CHECK (
    status <> 'reconciled' OR (
      executed_fee_deduction IS NOT NULL
      AND actual_mint_payout IS NOT NULL
      AND source_burned_amount = cctp_burn_amount * 10
      AND cctp_burn_amount = executed_fee_deduction + actual_mint_payout
      AND executed_fee_deduction <= forwarding_budget_max_fee
      AND actual_mint_payout >= planned_min_payout
    )
  )
);

CREATE INDEX cctp_fee_reconciliation_status_idx
  ON cctp_fee_reconciliation (status);

-- Down Migration

DROP INDEX IF EXISTS cctp_fee_reconciliation_status_idx;
DROP TABLE IF EXISTS cctp_fee_reconciliation;
