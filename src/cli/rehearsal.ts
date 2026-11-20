/**
 * Backup and restore rehearsal CLI (#60).
 *
 * Usage:
 *   npm run rehearsal -- export   --output <file>     source: DATABASE_URL (read-only)
 *   npm run rehearsal -- restore  --input <file>      target: HYPERION_REHEARSAL_DATABASE_URL
 *   npm run rehearsal -- validate --input <file>      target: HYPERION_REHEARSAL_DATABASE_URL
 *   npm run rehearsal -- rehearse [--output <file>]   export from source, restore, validate
 *
 * The target comes only from HYPERION_REHEARSAL_DATABASE_URL, never from DATABASE_URL, and must
 * not be the same database as the source. A target provisioned as production or preview is
 * refused unless both --allow-protected-target and HYPERION_REHEARSAL_ALLOW_PROTECTED=true are
 * set. Restore never writes into a non-empty table.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { Database } from "../db/pool.js";
import {
  exportRehearsalDataset,
  parseRehearsalSnapshot,
  RehearsalError,
  restoreRehearsalDataset,
  validateRehearsalRestore,
  type RehearsalSnapshot,
} from "../db/rehearsal.js";
import { sanitizeDiagnosticText } from "../logging/logger.js";

export type RehearsalCommand = "export" | "restore" | "validate" | "rehearse";

export interface RehearsalArgs {
  readonly command: RehearsalCommand | null;
  readonly input: string | null;
  readonly output: string | null;
  readonly allowProtectedTarget: boolean;
  readonly help: boolean;
}

export function parseRehearsalArgs(argv: readonly string[]): RehearsalArgs {
  let command: RehearsalCommand | null = null;
  let input: string | null = null;
  let output: string | null = null;
  let allowProtectedTarget = false;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-"))
        throw new RehearsalError(`${arg} needs a path`);
      i += 1;
      return next;
    };
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--input" || arg === "-i") input = value();
    else if (arg === "--output" || arg === "-o") output = value();
    else if (arg === "--allow-protected-target") allowProtectedTarget = true;
    else if (
      command === null &&
      (arg === "export" || arg === "restore" || arg === "validate" || arg === "rehearse")
    )
      command = arg;
    else throw new RehearsalError(`unknown argument: ${arg ?? ""}`);
  }
  return { command, input, output, allowProtectedTarget, help };
}

/** Both switches must be set: a flag alone, or an environment variable alone, is not enough. */
export function protectedTargetAllowed(
  args: RehearsalArgs,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return args.allowProtectedTarget && env.HYPERION_REHEARSAL_ALLOW_PROTECTED === "true";
}

/** Resolve source and target connection strings, refusing a target that is the source. */
export function rehearsalConnections(
  command: RehearsalCommand,
  env: NodeJS.ProcessEnv = process.env,
): { readonly source: string | null; readonly target: string | null } {
  const present = (value: string | undefined) => {
    const trimmed = value?.trim() ?? "";
    return trimmed.length > 0 ? trimmed : null;
  };
  const source = present(env.DATABASE_URL);
  const target = present(env.HYPERION_REHEARSAL_DATABASE_URL);
  const needsSource = command === "export" || command === "rehearse";
  const needsTarget = command !== "export";
  if (needsSource && source === null) throw new RehearsalError("DATABASE_URL is not set.");
  if (needsTarget && target === null)
    throw new RehearsalError(
      "HYPERION_REHEARSAL_DATABASE_URL is not set; rehearsals restore only into an explicitly named dedicated database.",
    );
  if (needsTarget && source !== null && target !== null && sameDatabase(source, target))
    throw new RehearsalError("The rehearsal target must not be the source database.");
  return { source: needsSource ? source : null, target: needsTarget ? target : null };
}

function sameDatabase(a: string, b: string): boolean {
  const key = (raw: string) => {
    try {
      const url = new URL(raw);
      return `${url.hostname.toLowerCase()}:${url.port || "5432"}/${url.pathname.replace(/^\//, "")}`;
    } catch {
      return raw;
    }
  };
  return key(a) === key(b);
}

async function withDatabase<T>(
  connection: string,
  options: { readonly readOnly?: boolean },
  work: (db: Database) => Promise<T>,
): Promise<T> {
  const db = Database.open(connection, {
    applicationName: "hyperion-rehearsal",
    maxConnections: 2,
    statementTimeoutMs: 120_000,
    ...(options.readOnly ? { readOnly: true } : {}),
  });
  try {
    return await work(db);
  } finally {
    await db.close();
  }
}

function writeSnapshot(path: string, snapshot: RehearsalSnapshot): void {
  writeFileSync(resolvePath(path), `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
}

async function run(): Promise<void> {
  const args = parseRehearsalArgs(process.argv.slice(2));
  if (args.help || args.command === null) {
    process.stdout.write(
      "Usage: rehearsal <export|restore|validate|rehearse> [--input <file>] [--output <file>] [--allow-protected-target]\n",
    );
    return;
  }
  const { source, target } = rehearsalConnections(args.command);
  const allowProtectedTarget = protectedTargetAllowed(args);
  const read = () => {
    if (args.input === null) throw new RehearsalError("--input is required.");
    return parseRehearsalSnapshot(readFileSync(resolvePath(args.input), "utf8"));
  };

  let snapshot: RehearsalSnapshot | null = null;
  if (args.command === "export" || args.command === "rehearse") {
    if (source === null) throw new RehearsalError("DATABASE_URL is not set.");
    snapshot = await withDatabase(source, { readOnly: true }, (db) => exportRehearsalDataset(db));
    if (args.output !== null) writeSnapshot(args.output, snapshot);
    else if (args.command === "export") throw new RehearsalError("--output is required.");
    process.stdout.write(
      `exported ${Object.entries(snapshot.manifest.counts)
        .map(([table, n]) => `${table}=${String(n)}`)
        .join(" ")} at ${snapshot.schemaVersion}\n`,
    );
    if (args.command === "export") return;
  }
  snapshot ??= read();
  const restored = snapshot;
  if (target === null) throw new RehearsalError("HYPERION_REHEARSAL_DATABASE_URL is not set.");
  await withDatabase(target, {}, async (db) => {
    if (args.command === "restore" || args.command === "rehearse") {
      await restoreRehearsalDataset(db, restored, { allowProtectedTarget });
      process.stdout.write("restored into the rehearsal database\n");
    }
    if (args.command === "restore") return;
    const result = await validateRehearsalRestore(db, restored.manifest);
    if (!result.ok) {
      for (const mismatch of result.mismatches) process.stderr.write(`mismatch: ${mismatch}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write("validated: counts, monetary digests and joins match the source\n");
  });
}

const invokedDirectly = process.argv[1] !== undefined && /rehearsal\.[jt]s$/.test(process.argv[1]);
if (invokedDirectly)
  run().catch((error: unknown) => {
    process.stderr.write(
      `Rehearsal failed: ${sanitizeDiagnosticText(error instanceof Error ? error.message : String(error))}\n`,
    );
    process.exitCode = 1;
  });
