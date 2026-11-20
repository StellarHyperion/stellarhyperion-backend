-- Up Migration

-- A CCTP message is identified by its full 32-byte nonce and exact digest. The same message
-- already credited to a different source transfer is reported as its own bounded category rather
-- than surfacing as a unique-index violation on inbound_delivery_by_message.
ALTER TABLE rail_attestation
  DROP CONSTRAINT IF EXISTS rail_attestation_verification_failure_check;

ALTER TABLE rail_attestation
  ADD CONSTRAINT rail_attestation_verification_failure_check CHECK (
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
      'non_canonical_receipt',
      'message_already_delivered'
    )
  );

-- Down Migration

UPDATE rail_attestation SET verification_failure = NULL
 WHERE verification_failure = 'message_already_delivered';

ALTER TABLE rail_attestation
  DROP CONSTRAINT IF EXISTS rail_attestation_verification_failure_check;

ALTER TABLE rail_attestation
  ADD CONSTRAINT rail_attestation_verification_failure_check CHECK (
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
