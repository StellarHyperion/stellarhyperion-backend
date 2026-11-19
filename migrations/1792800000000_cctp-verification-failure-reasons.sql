-- Up Migration

ALTER TABLE rail_attestation
  ADD COLUMN verification_failure text CHECK (
    verification_failure IN (
      'forward_tx_missing',
      'message_missing',
      'invalid_message',
      'configuration_unavailable',
      'source_transfer_missing',
      'source_domain_mismatch',
      'destination_domain_mismatch',
      'messenger_mismatch',
      'source_adapter_mismatch',
      'token_mismatch',
      'recipient_mismatch',
      'amount_mismatch',
      'fee_mismatch',
      'finality_mismatch',
      'receipt_missing',
      'receipt_mismatch',
      'mint_missing',
      'receipt_reverted',
      'confirmations_pending',
      'non_canonical_receipt'
    )
  );

COMMENT ON COLUMN rail_attestation.verification_failure IS
  'Bounded CCTP evidence mismatch category. A non-null value is diagnostic only and never proves or rejects delivery.';

-- Down Migration

ALTER TABLE rail_attestation
  DROP COLUMN verification_failure;
