import type { AppConfig } from "../config/config.js";
import type { Queryable } from "./pool.js";
export const API_READ_TABLES = [
  "hyperion_database_identity",
  "pgmigrations",
  "outbound_transfer",
  "inbound_delivery",
  "pending_claim",
  "rail_attestation",
  "rail_attestation_history",
  "keeper_submission",
  "keeper_checkpoint",
  "route_health",
  "indexer_cursor",
  "indexer_worker_heartbeat",
  "stellar_history_gap",
  "indexed_history_digest",
  "axelar_delivery_evidence",
  "axelar_status_quarantine",
  "evm_backfill_job",
  "evm_log_quarantine",
  "evm_scan_provenance",
];
/** Environment labels are verified against a provisioned database identity, never trusted alone.
 * Explicit local development/test configuration remains usable without production provisioning. */
export async function checkDatabasePolicy(db: Queryable, config: AppConfig): Promise<void> {
  if (config.deploymentEnvironment === "development" && config.nodeEnv !== "production") return;
  let identity;
  try {
    identity = (
      await db.query(
        "SELECT environment FROM public.hyperion_database_identity WHERE singleton = true",
      )
    ).rows[0];
  } catch {
    throw new Error(
      "HYPERION_DATABASE_ENV requires a provisioned database identity before startup.",
    );
  }
  if (
    identity?.environment !== config.databaseEnvironment ||
    config.databaseEnvironment !== config.deploymentEnvironment
  )
    throw new Error(
      "HYPERION_DATABASE_ENV must match the provisioned database identity and hosting environment; preview and production require separate databases.",
    );
  if (config.databaseRole !== "read-only") return;
  let role;
  try {
    role = (
      await db.query(
        `SELECT r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolbypassrls,
    (SELECT coalesce(bool_or(has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')),false)
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')) AS can_write,
    EXISTS (SELECT 1 FROM pg_roles inherited WHERE inherited.rolname <> current_user
      AND pg_has_role(current_user,inherited.oid,'MEMBER')
      AND (inherited.rolsuper OR inherited.rolcreatedb OR inherited.rolcreaterole OR inherited.rolbypassrls
        OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')
            AND has_table_privilege(inherited.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')))) AS can_escalate,
    has_schema_privilege(current_user,'public','CREATE') AS can_create,
    (SELECT bool_and(coalesce(has_table_privilege(current_user,to_regclass('public.'||name),'SELECT'),false)) FROM unnest($1::text[]) AS required(name)) AS can_read
   FROM pg_roles r WHERE r.rolname=current_user`,
        [API_READ_TABLES],
      )
    ).rows[0];
  } catch {
    throw new Error("HYPERION_DATABASE_ROLE could not verify database privileges.");
  }
  if (
    role?.rolsuper !== false ||
    role.rolcreatedb !== false ||
    role.rolcreaterole !== false ||
    role.rolbypassrls !== false ||
    role.can_write !== false ||
    role.can_escalate !== false ||
    role.can_create !== false ||
    role.can_read !== true
  )
    throw new Error(
      "HYPERION_DATABASE_ROLE read-only requires a dedicated nonprivileged role with required SELECT grants and no public-table write privileges.",
    );
}
