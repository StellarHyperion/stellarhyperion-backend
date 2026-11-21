# Migration reports

Build first with `npm run build`, then run `npm run migration:report` with
`DATABASE_URL` set. The command uses a read-only connection and exits nonzero
if migration history, constraints, a verified backup boundary, or migration-lock
availability cannot be established. It holds node-pg-migrate's actual advisory lock
while reading a repeatable-read snapshot. It does not apply migrations or create backups.

Record an operator-verified backup in `migration_backup_boundary` before maintenance.
`HYPERION_MIGRATION_BACKUP_ID` selects a specific recorded boundary. Destructive
rollback SQL, unknown statements, and migrations without executable rollback SQL
require restoration from that backup; dropping a table or column is data loss.

For an EVM router replacement, increase `EVM_DEPLOYMENT_REVISION_SEPOLIA`
(or the corresponding chain suffix) explicitly from its default of 1 and update the
deployment record's router and activation block. Older processes cannot reactivate
retired routers. Reusing an address requires an activation block after the prior
cursor. Historical legacy activation blocks remain unknown when they were never
persisted; their router identity and retirement boundary are retained.
