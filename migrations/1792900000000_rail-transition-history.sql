-- Up Migration
CREATE TABLE rail_attestation_history (
  id bigserial PRIMARY KEY,
  transfer_id bigint NOT NULL REFERENCES outbound_transfer(id) ON DELETE CASCADE,
  route smallint NOT NULL CHECK (route BETWEEN 0 AND 3),
  old_status text NOT NULL CHECK (old_status IN ('unobserved','pending','attested','delivered','failed','expired')),
  new_status text NOT NULL CHECK (new_status IN ('pending','attested','delivered','failed','expired')),
  reason text NOT NULL CHECK (length(reason) <= 80),
  rail_status text NOT NULL CHECK (length(rail_status) <= 256),
  evidence_reference text NOT NULL CHECK (length(evidence_reference) <= 256),
  observed_at timestamptz NOT NULL
);
CREATE INDEX rail_attestation_history_by_transfer ON rail_attestation_history(transfer_id,id);
COMMENT ON TABLE rail_attestation_history IS 'Atomic observable lifecycle changes bound to the exact source transfer. Identical polling is omitted; repeated real reconciliations are retained.';

CREATE FUNCTION record_rail_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  reconciliation text := '';
  previous_status text := 'unobserved';
BEGIN
  IF TG_OP = 'UPDATE' THEN
    previous_status := OLD.status;
    IF (NEW.status,NEW.rail_status,NEW.rail_reference,NEW.retry_class)
        IS NOT DISTINCT FROM (OLD.status,OLD.rail_status,OLD.rail_reference,OLD.retry_class) THEN
      RETURN NEW;
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND
      ((OLD.status IN ('delivered','failed','expired')) OR
       (OLD.status = 'attested' AND NEW.status = 'pending')) THEN
      reconciliation := coalesce(current_setting('hyperion.rail_reconcile_reason',true),'');
      IF coalesce(current_setting('hyperion.rail_reconcile_transfer',true),'') <> NEW.transfer_id::text
        OR reconciliation NOT IN ('operator_requeue','destination_proof_reorg') THEN
        RAISE EXCEPTION 'rail backward transition requires explicit reconciliation' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  INSERT INTO rail_attestation_history
    (transfer_id,route,old_status,new_status,reason,rail_status,evidence_reference,observed_at)
  VALUES (NEW.transfer_id,NEW.route,previous_status,NEW.status,
    CASE WHEN reconciliation <> '' THEN reconciliation
         WHEN NEW.retry_class IS NOT NULL THEN NEW.retry_class
         ELSE 'status_change' END,
    CASE WHEN NEW.rail_status ~ '^[A-Za-z0-9_. -]+$' AND length(NEW.rail_status) <= 256 THEN NEW.rail_status ELSE '' END,
    CASE WHEN NEW.rail_reference ~ '^(0x)?[0-9a-fA-F]{64}$|^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$|^(iris|axelar|cctp|msg|message)-[A-Za-z0-9_-]{1,128}$'
         THEN NEW.rail_reference ELSE '' END,
    coalesce(NEW.last_checked_at,now()));
  RETURN NEW;
END $$;
CREATE TRIGGER rail_transition AFTER INSERT OR UPDATE ON rail_attestation
  FOR EACH ROW EXECUTE FUNCTION record_rail_transition();
INSERT INTO rail_attestation_history
  (transfer_id,route,old_status,new_status,reason,rail_status,evidence_reference,observed_at)
SELECT transfer_id,route,'unobserved',status,'migration_baseline','','',coalesce(last_checked_at,now())
FROM rail_attestation;

-- Down Migration
DROP TRIGGER rail_transition ON rail_attestation;
DROP FUNCTION record_rail_transition();
DROP TABLE rail_attestation_history;
