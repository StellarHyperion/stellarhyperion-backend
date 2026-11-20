-- Up Migration
CREATE TABLE indexer_worker_run (
  run_id uuid PRIMARY KEY,
  execution_id uuid NOT NULL,
  worker_name text NOT NULL CHECK (worker_name ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  worker_kind text NOT NULL CHECK (worker_kind IN ('chain','rail','keeper','other')),
  chain_key text CHECK (chain_key ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  state text NOT NULL CHECK (state IN ('running','caught_up','failed','stopped')),
  successful_ticks bigint NOT NULL DEFAULT 0 CHECK (successful_ticks >= 0),
  failed_ticks bigint NOT NULL DEFAULT 0 CHECK (failed_ticks >= 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_caught_up_at timestamptz,
  stopped_at timestamptz
);
CREATE INDEX indexer_worker_run_execution ON indexer_worker_run(execution_id,worker_name);
CREATE INDEX indexer_worker_run_recency ON indexer_worker_run(updated_at DESC,run_id);

ALTER TABLE stellar_scan_journal ADD COLUMN run_id uuid REFERENCES indexer_worker_run(run_id);
ALTER TABLE evm_scan_provenance ADD COLUMN run_id uuid REFERENCES indexer_worker_run(run_id);
ALTER TABLE rail_attestation_history ADD COLUMN run_id uuid REFERENCES indexer_worker_run(run_id);
CREATE INDEX stellar_scan_journal_run ON stellar_scan_journal(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX evm_scan_provenance_run ON evm_scan_provenance(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX rail_attestation_history_run ON rail_attestation_history(run_id) WHERE run_id IS NOT NULL;

-- This transaction-local setting is populated by Database.transaction from the internal
-- generated worker context. It is correlation metadata and grants no delivery authority.
CREATE FUNCTION correlate_worker_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.run_id := nullif(current_setting('hyperion.worker_run_id',true),'')::uuid;
  RETURN NEW;
END $$;
CREATE TRIGGER stellar_scan_run BEFORE INSERT ON stellar_scan_journal
  FOR EACH ROW EXECUTE FUNCTION correlate_worker_run();
CREATE TRIGGER evm_scan_run BEFORE INSERT ON evm_scan_provenance
  FOR EACH ROW EXECUTE FUNCTION correlate_worker_run();
CREATE TRIGGER rail_transition_run BEFORE INSERT ON rail_attestation_history
  FOR EACH ROW EXECUTE FUNCTION correlate_worker_run();
COMMENT ON TABLE indexer_worker_run IS 'Restart-safe worker history. caught_up means the latest poll found no further eligible work, not proof of destination delivery. running, failed, and stopped are partial. Legacy scans remain uncorrelated.';

-- Down Migration
DROP TRIGGER rail_transition_run ON rail_attestation_history;
DROP TRIGGER evm_scan_run ON evm_scan_provenance;
DROP TRIGGER stellar_scan_run ON stellar_scan_journal;
DROP FUNCTION correlate_worker_run();
ALTER TABLE rail_attestation_history DROP COLUMN run_id;
ALTER TABLE evm_scan_provenance DROP COLUMN run_id;
ALTER TABLE stellar_scan_journal DROP COLUMN run_id;
DROP TABLE indexer_worker_run;
