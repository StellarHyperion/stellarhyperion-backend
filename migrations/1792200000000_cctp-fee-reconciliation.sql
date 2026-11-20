-- Up Migration

ALTER TABLE inbound_delivery
  ADD COLUMN cctp_burned_amount_source_units numeric(78, 0),
  ADD COLUMN cctp_forwarding_budget_destination_units numeric(78, 0),
  ADD COLUMN cctp_executed_deduction_destination_units numeric(78, 0),
  ADD COLUMN cctp_actual_payout_destination_units numeric(78, 0),
  ADD CONSTRAINT inbound_delivery_cctp_reconciliation_complete CHECK (
    (cctp_burned_amount_source_units IS NULL
      AND cctp_forwarding_budget_destination_units IS NULL
      AND cctp_executed_deduction_destination_units IS NULL
      AND cctp_actual_payout_destination_units IS NULL)
    OR
    (cctp_burned_amount_source_units IS NOT NULL
      AND cctp_forwarding_budget_destination_units IS NOT NULL
      AND cctp_executed_deduction_destination_units IS NOT NULL
      AND cctp_actual_payout_destination_units IS NOT NULL)
  ),
  ADD CONSTRAINT inbound_delivery_cctp_reconciliation_valid CHECK (
    cctp_burned_amount_source_units IS NULL
    OR (
      cctp_burned_amount_source_units > 0
      AND cctp_burned_amount_source_units % 10 = 0
      AND cctp_forwarding_budget_destination_units >= 0
      AND cctp_executed_deduction_destination_units >= 0
      AND cctp_executed_deduction_destination_units
        <= cctp_forwarding_budget_destination_units
      AND cctp_actual_payout_destination_units > 0
      AND cctp_actual_payout_destination_units = amount
      AND div(cctp_burned_amount_source_units, 10)
        = cctp_executed_deduction_destination_units
          + cctp_actual_payout_destination_units
    )
  );

COMMENT ON COLUMN inbound_delivery.cctp_burned_amount_source_units IS
  'Verified CCTP source USDC burn in seven-decimal integer base units.';
COMMENT ON COLUMN inbound_delivery.cctp_forwarding_budget_destination_units IS
  'Verified CCTP maximum forwarding fee in six-decimal native-USDC integer base units.';
COMMENT ON COLUMN inbound_delivery.cctp_executed_deduction_destination_units IS
  'Verified CCTP executed fee deduction in six-decimal native-USDC integer base units.';
COMMENT ON COLUMN inbound_delivery.cctp_actual_payout_destination_units IS
  'Verified native-USDC mint payout in six-decimal integer base units; equal to inbound_delivery.amount.';

-- Down Migration

ALTER TABLE inbound_delivery
  DROP CONSTRAINT inbound_delivery_cctp_reconciliation_valid,
  DROP CONSTRAINT inbound_delivery_cctp_reconciliation_complete,
  DROP COLUMN cctp_burned_amount_source_units,
  DROP COLUMN cctp_forwarding_budget_destination_units,
  DROP COLUMN cctp_executed_deduction_destination_units,
  DROP COLUMN cctp_actual_payout_destination_units;
