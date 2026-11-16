-- Up Migration

-- Durable record of Stellar ledger intervals that fell outside an RPC node's retention window
-- before the live watcher could read them.
--
-- A caught-up cursor in `indexer_cursor` only proves where the live watcher currently sits; it
-- does not prove every historical ledger before that cursor was read if retention moved ahead of
-- the watcher. Recording unavailable `[from_ledger, to_ledger]` intervals explicitly allows
-- `/ready` and `/v1/metrics` to distinguish cursor freshness from historical completeness until an
-- archive backfill reconciles and closes each gap.
CREATE TABLE stellar_history_gap (
  id                  bigserial PRIMARY KEY,
  chain_key           text NOT NULL,
  contract            text NOT NULL,
  from_ledger         numeric(20, 0) NOT NULL,
  to_ledger           numeric(20, 0) NOT NULL,
  reconciled_through  numeric(20, 0),
  status              text NOT NULL DEFAULT 'open'
                        CONSTRAINT stellar_history_gap_status_check
                        CHECK (status IN ('open', 'reconciling', 'closed')),
  reason              text NOT NULL,
  detected_at         timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  reconciled_at       timestamptz,
  CONSTRAINT stellar_history_gap_bounds_check
    CHECK (from_ledger >= 0 AND to_ledger >= from_ledger),
  CONSTRAINT stellar_history_gap_progress_check
    CHECK (
      reconciled_through IS NULL
      OR (reconciled_through >= from_ledger AND reconciled_through <= to_ledger)
    ),
  CONSTRAINT stellar_history_gap_closed_check
    CHECK (
      (status = 'closed' AND reconciled_at IS NOT NULL AND reconciled_through = to_ledger)
      OR (status <> 'closed' AND reconciled_at IS NULL)
    ),
  CONSTRAINT stellar_history_gap_interval_key
    UNIQUE (chain_key, contract, from_ledger, to_ledger)
);

CREATE INDEX stellar_history_gap_open_idx
  ON stellar_history_gap (chain_key, contract, from_ledger)
  WHERE status <> 'closed';

COMMENT ON TABLE stellar_history_gap IS
  'Unavailable Stellar ledger intervals missed due to RPC retention limits, tracked until archive backfill reconciles them.';

-- Down Migration

DROP INDEX IF EXISTS stellar_history_gap_open_idx;
DROP TABLE IF EXISTS stellar_history_gap;
