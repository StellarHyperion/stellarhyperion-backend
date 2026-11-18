/**
 * Operational diagnostics bundle CLI command (#113).
 *
 * Usage:
 *   npm run diagnostics -- [--output <file>] [--compact]
 */
import { writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { loadConfig } from "../config/config.js";
import { ConfigError } from "../config/env.js";
import { Database } from "../db/pool.js";
import { generateDiagnosticsBundle } from "../diagnostics/bundle.js";

interface CliArgs {
  readonly outputPath: string | null;
  readonly compact: boolean;
  readonly help: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let outputPath: string | null = null;
  let compact = false;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--compact") {
      compact = true;
    } else if (arg === "--output" || arg === "-o") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        throw new Error(`${arg} requires a file path`);
      }
      outputPath = next;
      i += 1;
    } else if (arg?.startsWith("--output=")) {
      outputPath = arg.slice("--output=".length);
    } else {
      throw new Error(`unknown argument: ${arg ?? ""}`);
    }
  }

  return { outputPath, compact, help };
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      "Usage: diagnostics [--output <path> | -o <path>] [--compact]\n" +
        "Generates a sanitized, read-only operational diagnostics bundle.\n",
    );
    return;
  }

  const config = (() => {
    try {
      return loadConfig();
    } catch (error) {
      if (error instanceof ConfigError) {
        process.stderr.write(`\n${error.message}\n\n`);
        process.exit(78);
      }
      throw error;
    }
  })();

  const db = Database.open(config.databaseUrl, {
    applicationName: "hyperion-diagnostics",
    maxConnections: 2,
    statementTimeoutMs: 15_000,
  });

  try {
    const bundle = await generateDiagnosticsBundle({ config, db });
    const json = JSON.stringify(bundle, null, args.compact ? undefined : 2);
    if (args.outputPath !== null) {
      const target = resolvePath(process.cwd(), args.outputPath);
      writeFileSync(target, `${json}\n`, "utf8");
      process.stderr.write(`Diagnostics bundle written to ${target}\n`);
    } else {
      process.stdout.write(`${json}\n`);
    }
  } finally {
    await db.close();
  }
}

await run();
