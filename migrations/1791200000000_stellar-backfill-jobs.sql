-- Up Migration

-- Separate durable replay progress for bounded Stellar historical-provider backfill jobs.
--
-- Backfill jobs replay past `[from_ledger, to_ledger]` intervals through an explicitly configured
-- historical event provider without touching `indexer_cursor`, so live watcher progress is never
-- overwritten or rewound. Progress is persisted per completed ledger boundary in
-- `completed_ledger` and `resume_cursor` so interrupted jobs resume deterministically, while
-- unsupported providers or unverifiable ledger ranges remain `unresolved`.
CREATE TABLE stellar_backfill_job (
  id                bigserial PRIMARY KEY,
  chain_key         text NOT NULL,
  contract          text NOT NULL,
  from_ledger       numeric(20, 0) NOT NULL,
  to_ledger         numeric(20, 0) NOT NULL,
  completed_ledger  numeric(20, 0),
  resume_cursor     text,
  status            text NOT NULL DEFAULT 'pending'
                      CONSTRAINT stellar_backfill_job_status_check
                      CHECK (status IN ('pending', 'running', 'completed', 'unresolved')),
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  CONSTRAINT stellar_backfill_job_bounds_check
    CHECK (from_ledger >= 1 AND to_ledger >= from_ledger),
  CONSTRAINT stellar_backfill_job_progress_check
    CHECK (
      completed_ledger IS NULL
      OR (completed_ledger >= from_ledger AND completed_ledger <= to_ledger)
    ),
  CONSTRAINT stellar_backfill_job_completion_check
    CHECK (
      (status = 'completed' AND completed_ledger = to_ledger AND completed_at IS NOT NULL)
      OR (status <> 'completed' AND completed_at IS NULL)
    ),
  CONSTRAINT stellar_backfill_job_range_key
    UNIQUE (chain_key, contract, from_ledger, to_ledger)
);

CREATE INDEX stellar_backfill_job_active_idx
  ON stellar_backfill_job (chain_key, contract, from_ledger)
  WHERE status IN ('pending', 'running', 'unresolved');

COMMENT ON TABLE stellar_backfill_job IS
  'Bounded historical-provider replay jobs for Stellar router events, tracked separately from live indexer_cursor progress.';

-- Down Migration

DROP INDEX IF EXISTS stellar_backfill_job_active_idx;
DROP TABLE IF EXISTS stellar_backfill_job;
