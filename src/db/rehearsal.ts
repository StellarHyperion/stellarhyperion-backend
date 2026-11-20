/**
 * Schema-safe backup and restore rehearsals for indexed history (#60).
 *
 * A rehearsal exports a representative indexed dataset, restores it into a dedicated empty
 * database at the same schema version, and proves the restore is faithful: row counts, the
 * existing monetary history digests and a fingerprint of the cursor and provenance joins must all
 * match what the source recorded at export time.
 *
 * Every value travels as PostgreSQL text, so full-width identifiers, numeric(78,0) amounts and
 * timestamps round-trip exactly; nothing is parsed into a JavaScript number on the way through.
 *
 * Safety:
 *   * A target whose provisioned identity is production or preview is refused unless the caller
 *     passes `allowProtectedTarget`, which the CLI only sets from two independent explicit
 *     switches. Even then restore never writes into a non-empty table.
 *   * The snapshot holds indexed rows and digests only. It carries no connection string and no
 *     configuration, and error messages from this module never include one.
 */
import { createHash } from "node:crypto";
import { computeHistoryDigest, type HistoryDigestResult } from "../chains/writers.js";
import type { Queryable, Transactional } from "./pool.js";

export const REHEARSAL_FORMAT = "hyperion-rehearsal/1";

/** Parents before children, so foreign keys hold at every insert. */
export const REHEARSAL_TABLES = [
  "indexer_cursor",
  "outbound_transfer",
  "axelar_delivery_evidence",
  "inbound_delivery",
  "pending_claim",
  "admin_action",
  "source_event",
  "source_event_conflict",
  "source_event_link",
  "ingestion_rejection",
] as const;
export type RehearsalTable = (typeof REHEARSAL_TABLES)[number];

/** A representative dataset, not a production dump: larger tables are refused at export. */
export const MAX_REHEARSAL_ROWS_PER_TABLE = 100_000;
const INSERT_BATCH_ROWS = 200;
const U64_MAX = 18446744073709551615n;

export class RehearsalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RehearsalError";
  }
}

export interface RehearsalTableData {
  readonly columns: readonly string[];
  /** Every value as PostgreSQL text, or null. */
  readonly rows: readonly (readonly (string | null)[])[];
}

export interface RehearsalJoinFingerprint {
  /** Per cursor: indexed source events at or below it, and beyond it. */
  readonly cursors: readonly {
    readonly chainKey: string;
    readonly contract: string;
    readonly lastProcessed: string;
    readonly sourceEventsThrough: number;
    readonly sourceEventsBeyond: number;
  }[];
  /** Provenance links per materialized record kind and role. */
  readonly links: Readonly<Record<string, number>>;
  /** Links whose materialized record does not exist. Must be zero. */
  readonly danglingLinks: number;
  /** Arrivals whose source transfer does not exist. Must be zero. */
  readonly danglingDeliveries: number;
}

export interface RehearsalManifest {
  readonly counts: Readonly<Record<string, number>>;
  readonly digests: readonly {
    readonly chainKey: string;
    readonly rowCount: number;
    readonly digest: string;
    readonly monetarySummary: HistoryDigestResult["monetarySummary"];
  }[];
  readonly joins: RehearsalJoinFingerprint;
  /** SHA-256 over the serialized tables, so a modified snapshot is refused at restore. */
  readonly payloadSha256: string;
}

export interface RehearsalSnapshot {
  readonly format: typeof REHEARSAL_FORMAT;
  readonly schemaVersion: string;
  readonly exportedAt: string;
  readonly tables: Readonly<Record<string, RehearsalTableData>>;
  readonly manifest: RehearsalManifest;
}

export interface RehearsalTargetOptions {
  /** Permit a target provisioned as production or preview. Only set from explicit operator config. */
  readonly allowProtectedTarget?: boolean;
}

const quoteIdent = (name: string) => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new RehearsalError("Unexpected identifier.");
  return `"${name}"`;
};

async function schemaVersion(db: Queryable): Promise<string> {
  let rows;
  try {
    rows = (await db.query("SELECT name FROM pgmigrations ORDER BY name DESC LIMIT 1")).rows;
  } catch {
    throw new RehearsalError("The database has no migration history; apply migrations first.");
  }
  const name = rows[0]?.name;
  if (typeof name !== "string") throw new RehearsalError("The database has no applied migrations.");
  return name;
}

async function columnsOf(db: Queryable, table: RehearsalTable): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1
        AND is_generated = 'NEVER' AND coalesce(identity_generation, '') <> 'ALWAYS'
      ORDER BY ordinal_position`,
    [table],
  );
  const columns = rows.map((row) => String(row.column_name));
  if (columns.length === 0) throw new RehearsalError(`Table ${table} is missing from the schema.`);
  return columns;
}

function payloadDigest(tables: Readonly<Record<string, RehearsalTableData>>): string {
  const hash = createHash("sha256");
  for (const table of REHEARSAL_TABLES) {
    const data = tables[table];
    hash.update(JSON.stringify([table, data?.columns ?? [], data?.rows ?? []]));
  }
  return hash.digest("hex");
}

async function chainsOf(db: Queryable): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT origin_chain AS chain FROM outbound_transfer
     UNION SELECT destination_chain FROM inbound_delivery
     UNION SELECT chain FROM pending_claim
     ORDER BY 1`,
  );
  return rows.map((row) => String(row.chain));
}

async function joinFingerprint(db: Queryable): Promise<RehearsalJoinFingerprint> {
  const cursors = (
    await db.query(
      `SELECT c.chain_key, c.contract, c.last_processed::text AS last_processed,
              count(e.id) FILTER (WHERE e.block_number <= c.last_processed)::int AS through,
              count(e.id) FILTER (WHERE e.block_number > c.last_processed)::int AS beyond
         FROM indexer_cursor c
         LEFT JOIN source_event e ON e.chain_key = c.chain_key AND e.contract = c.contract
        GROUP BY c.chain_key, c.contract, c.last_processed
        ORDER BY c.chain_key`,
    )
  ).rows.map((row) => ({
    chainKey: String(row.chain_key),
    contract: String(row.contract),
    lastProcessed: String(row.last_processed),
    sourceEventsThrough: Number(row.through),
    sourceEventsBeyond: Number(row.beyond),
  }));
  const links: Record<string, number> = {};
  for (const row of (
    await db.query(
      `SELECT record_kind || ':' || role AS key, count(*)::int AS n
         FROM source_event_link GROUP BY 1 ORDER BY 1`,
    )
  ).rows)
    links[String(row.key)] = Number(row.n);
  const dangling = await db.query(
    `SELECT count(*)::int AS n FROM source_event_link l
      WHERE NOT CASE l.record_kind
        WHEN 'outbound_transfer' THEN EXISTS
          (SELECT 1 FROM outbound_transfer t WHERE t.id::text = l.record_key)
        WHEN 'inbound_delivery' THEN EXISTS
          (SELECT 1 FROM inbound_delivery d WHERE d.id::text = l.record_key)
        WHEN 'pending_claim' THEN EXISTS
          (SELECT 1 FROM pending_claim p WHERE p.chain || ':' || p.claim_id::text = l.record_key)
        WHEN 'admin_action' THEN EXISTS
          (SELECT 1 FROM admin_action a WHERE a.chain || ':' || a.action_id::text = l.record_key)
        ELSE false END`,
  );
  const deliveries = await db.query(
    `SELECT count(*)::int AS n FROM inbound_delivery d
      WHERE d.source_transfer_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM outbound_transfer t WHERE t.id = d.source_transfer_id)`,
  );
  return {
    cursors,
    links,
    danglingLinks: Number(dangling.rows[0]?.n ?? 0),
    danglingDeliveries: Number(deliveries.rows[0]?.n ?? 0),
  };
}

async function measure(db: Queryable): Promise<Omit<RehearsalManifest, "payloadSha256">> {
  const counts: Record<string, number> = {};
  for (const table of REHEARSAL_TABLES)
    counts[table] = Number(
      (await db.query(`SELECT count(*)::int AS n FROM ${quoteIdent(table)}`)).rows[0]?.n ?? 0,
    );
  const digests = [];
  for (const chainKey of await chainsOf(db)) {
    const result = await computeHistoryDigest(db, {
      chainKey,
      startBlock: 0n,
      endBlock: U64_MAX,
      recordKind: "all",
    });
    digests.push({
      chainKey,
      rowCount: result.rowCount,
      digest: result.digest,
      monetarySummary: result.monetarySummary,
    });
  }
  return { counts, digests, joins: await joinFingerprint(db) };
}

/** Export a bounded, text-exact snapshot of the indexed history tables. Read-only. */
export async function exportRehearsalDataset(
  db: Queryable,
  now: Date = new Date(),
): Promise<RehearsalSnapshot> {
  const version = await schemaVersion(db);
  const tables: Record<string, RehearsalTableData> = {};
  for (const table of REHEARSAL_TABLES) {
    const columns = await columnsOf(db, table);
    const count = Number(
      (await db.query(`SELECT count(*)::int AS n FROM ${quoteIdent(table)}`)).rows[0]?.n ?? 0,
    );
    if (count > MAX_REHEARSAL_ROWS_PER_TABLE)
      throw new RehearsalError(
        `${table} has ${String(count)} rows; rehearsals are limited to ${String(MAX_REHEARSAL_ROWS_PER_TABLE)} per table.`,
      );
    const select = columns.map((c) => `${quoteIdent(c)}::text AS ${quoteIdent(c)}`).join(", ");
    const order = columns.map((_c, index) => String(index + 1)).join(", ");
    const { rows } = await db.query(`SELECT ${select} FROM ${quoteIdent(table)} ORDER BY ${order}`);
    tables[table] = {
      columns,
      rows: rows.map((row) =>
        columns.map((c) => {
          const cell = row[c];
          if (cell === null || cell === undefined) return null;
          // Every column was selected as ::text, so anything else is a driver surprise.
          if (typeof cell !== "string") throw new RehearsalError(`${table}.${c} was not text.`);
          return cell;
        }),
      ),
    };
  }
  const measured = await measure(db);
  return {
    format: REHEARSAL_FORMAT,
    schemaVersion: version,
    exportedAt: now.toISOString(),
    tables,
    manifest: { ...measured, payloadSha256: payloadDigest(tables) },
  };
}

/**
 * Refuse a target that is provisioned as production or preview unless explicitly allowed.
 * A database without a provisioned identity is treated as a dedicated local database.
 */
export async function assertRehearsalTarget(
  db: Queryable,
  options: RehearsalTargetOptions = {},
): Promise<"development" | "preview" | "production" | "unprovisioned"> {
  let environment: unknown = null;
  try {
    environment = (
      await db.query("SELECT environment FROM hyperion_database_identity WHERE singleton = true")
    ).rows[0]?.environment;
  } catch {
    environment = null;
  }
  if (environment === "production" || environment === "preview") {
    if (options.allowProtectedTarget !== true)
      throw new RehearsalError(
        `Refusing to restore into a ${environment} database. Rehearsals target a dedicated database; a protected target needs explicit operator configuration.`,
      );
    return environment;
  }
  return environment === "development" ? "development" : "unprovisioned";
}

/** Parse and integrity-check a snapshot read from disk. */
export function parseRehearsalSnapshot(json: string): RehearsalSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new RehearsalError("Snapshot is not valid JSON.");
  }
  const snapshot = value as Record<string, unknown> | null;
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    snapshot.format !== REHEARSAL_FORMAT ||
    typeof snapshot.schemaVersion !== "string" ||
    typeof snapshot.tables !== "object" ||
    snapshot.tables === null ||
    typeof snapshot.manifest !== "object" ||
    snapshot.manifest === null
  )
    throw new RehearsalError(`Snapshot is not a ${REHEARSAL_FORMAT} file.`);
  const tables = snapshot.tables as Record<string, unknown>;
  for (const table of REHEARSAL_TABLES) {
    const data = tables[table] as { columns?: unknown; rows?: unknown } | undefined;
    const columns = data?.columns;
    const rows = data?.rows;
    if (
      !Array.isArray(columns) ||
      !columns.every((column) => typeof column === "string") ||
      !Array.isArray(rows) ||
      rows.length > MAX_REHEARSAL_ROWS_PER_TABLE ||
      rows.some(
        (row: unknown) =>
          !Array.isArray(row) ||
          row.length !== columns.length ||
          row.some((cell: unknown) => cell !== null && typeof cell !== "string"),
      )
    )
      throw new RehearsalError(`Snapshot table ${table} is malformed.`);
  }
  const parsed = snapshot as unknown as RehearsalSnapshot;
  if (payloadDigest(parsed.tables) !== parsed.manifest.payloadSha256)
    throw new RehearsalError("Snapshot payload does not match its manifest digest.");
  return parsed;
}

/**
 * Restore a snapshot into a dedicated, empty database at the same schema version. All tables are
 * written in one transaction, so a failed restore leaves the target as it was.
 */
export async function restoreRehearsalDataset(
  db: Transactional,
  snapshot: RehearsalSnapshot,
  options: RehearsalTargetOptions = {},
): Promise<Readonly<Record<string, number>>> {
  await assertRehearsalTarget(db, options);
  if (payloadDigest(snapshot.tables) !== snapshot.manifest.payloadSha256)
    throw new RehearsalError("Snapshot payload does not match its manifest digest.");
  const version = await schemaVersion(db);
  if (version !== snapshot.schemaVersion)
    throw new RehearsalError(
      `Target schema is at ${version} but the snapshot was taken at ${snapshot.schemaVersion}; migrate the target to the same version first.`,
    );
  return db.transaction(async (tx) => {
    const restored: Record<string, number> = {};
    for (const table of REHEARSAL_TABLES) {
      const existing = Number(
        (await tx.query(`SELECT count(*)::int AS n FROM ${quoteIdent(table)}`)).rows[0]?.n ?? 0,
      );
      if (existing > 0)
        throw new RehearsalError(`Target table ${table} is not empty; restore never overwrites.`);
      const data = snapshot.tables[table];
      if (!data) throw new RehearsalError(`Snapshot is missing ${table}.`);
      const columns = await columnsOf(tx, table);
      if (columns.join(",") !== data.columns.join(","))
        throw new RehearsalError(`Target columns for ${table} differ from the snapshot.`);
      for (let start = 0; start < data.rows.length; start += INSERT_BATCH_ROWS) {
        const batch = data.rows.slice(start, start + INSERT_BATCH_ROWS);
        const params: (string | null)[] = [];
        const tuples = batch.map((row) => {
          const slots = row.map((cell) => {
            params.push(cell);
            return `$${String(params.length)}`;
          });
          return `(${slots.join(", ")})`;
        });
        await tx.query(
          `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(", ")})
           VALUES ${tuples.join(", ")}`,
          params,
        );
      }
      if (columns.includes("id"))
        await tx.query(
          `SELECT setval(seq, greatest((SELECT coalesce(max(id), 0) FROM ${quoteIdent(table)}), 1),
                         (SELECT count(*) > 0 FROM ${quoteIdent(table)}))
             FROM pg_get_serial_sequence($1, 'id') AS seq WHERE seq IS NOT NULL`,
          [table],
        );
      restored[table] = data.rows.length;
    }
    return restored;
  });
}

export interface RehearsalValidation {
  readonly ok: boolean;
  readonly mismatches: readonly string[];
}

/** Recompute counts, monetary digests and join fingerprint on the target and compare. */
export async function validateRehearsalRestore(
  db: Queryable,
  manifest: RehearsalManifest,
): Promise<RehearsalValidation> {
  const actual = await measure(db);
  const mismatches: string[] = [];
  for (const table of REHEARSAL_TABLES)
    if (actual.counts[table] !== manifest.counts[table])
      mismatches.push(
        `count ${table}: expected ${String(manifest.counts[table])}, restored ${String(actual.counts[table])}`,
      );
  const expectedDigests = new Map(manifest.digests.map((entry) => [entry.chainKey, entry]));
  const actualDigests = new Map(actual.digests.map((entry) => [entry.chainKey, entry]));
  for (const chainKey of new Set([...expectedDigests.keys(), ...actualDigests.keys()])) {
    const expected = expectedDigests.get(chainKey);
    const restored = actualDigests.get(chainKey);
    if (expected?.digest !== restored?.digest)
      mismatches.push(`digest ${chainKey}: history digest differs`);
    else if (
      JSON.stringify(expected?.monetarySummary) !== JSON.stringify(restored?.monetarySummary)
    )
      mismatches.push(`digest ${chainKey}: monetary summary differs`);
  }
  if (JSON.stringify(actual.joins) !== JSON.stringify(manifest.joins))
    mismatches.push("joins: cursor or provenance join fingerprint differs");
  if (actual.joins.danglingLinks !== 0)
    mismatches.push(`joins: ${String(actual.joins.danglingLinks)} dangling provenance links`);
  if (actual.joins.danglingDeliveries !== 0)
    mismatches.push(`joins: ${String(actual.joins.danglingDeliveries)} dangling deliveries`);
  return { ok: mismatches.length === 0, mismatches };
}
