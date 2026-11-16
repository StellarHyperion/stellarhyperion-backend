-- Up Migration

CREATE TABLE stellar_scan_journal (
  id bigserial PRIMARY KEY,
  chain_key text NOT NULL,
  contract text NOT NULL,
  requested_from_ledger numeric(20, 0) NOT NULL,
  requested_to_ledger numeric(20, 0) NOT NULL,
  committed_from_ledger numeric(20, 0),
  committed_through_ledger numeric(20, 0),
  decoded_count integer NOT NULL DEFAULT 0 CHECK (decoded_count >= 0),
  skipped_count integer NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  pages_read integer NOT NULL DEFAULT 0 CHECK (pages_read >= 0),
  status text NOT NULL CHECK (status IN ('completed', 'noop', 'interrupted')),
  interruption_reason text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stellar_scan_journal_committed_bounds CHECK (
    (
      status = 'completed'
      AND committed_from_ledger IS NOT NULL
      AND committed_through_ledger IS NOT NULL
      AND committed_through_ledger >= committed_from_ledger
    )
    OR (
      status IN ('noop', 'interrupted')
      AND committed_from_ledger IS NULL
      AND committed_through_ledger IS NULL
    )
  )
);

CREATE INDEX stellar_scan_journal_chain_idx
  ON stellar_scan_journal (chain_key, contract, id DESC);

CREATE OR REPLACE FUNCTION record_stellar_scan_noncommit(
  p_chain_key text,
  p_contract text,
  p_requested_from numeric,
  p_requested_to numeric,
  p_decoded integer,
  p_skipped integer,
  p_pages integer,
  p_status text,
  p_reason text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO stellar_scan_journal (
    chain_key,
    contract,
    requested_from_ledger,
    requested_to_ledger,
    committed_from_ledger,
    committed_through_ledger,
    decoded_count,
    skipped_count,
    pages_read,
    status,
    interruption_reason
  ) VALUES (
    p_chain_key,
    p_contract,
    p_requested_from,
    p_requested_to,
    NULL,
    NULL,
    p_decoded,
    p_skipped,
    p_pages,
    p_status,
    p_reason
  );
END;
$$;

-- Down Migration

DROP FUNCTION IF EXISTS record_stellar_scan_noncommit(
  text, text, numeric, numeric, integer, integer, integer, text, text
);
DROP INDEX IF EXISTS stellar_scan_journal_chain_idx;
DROP TABLE IF EXISTS stellar_scan_journal;
