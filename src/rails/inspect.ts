/**
 * Read-only operator CLI for inspecting rail backlog age, missing proof stages, destinations, and
 * retry classes without starting watchers or mutating database state.
 */
import { pathToFileURL } from "node:url";

import { loadConfig } from "../config/config.js";
import { ConfigError } from "../config/env.js";
import { Database, type Queryable, type Transactional } from "../db/pool.js";
import {
  BacklogValidationError,
  formatBacklogReportText,
  inspectRailBacklog,
  type InspectRailBacklogOptions,
} from "./backlog.js";
import type { BacklogRetryClass, MissingProofStage } from "./types.js";

export interface ParsedBacklogCliArgs {
  readonly help: boolean;
  readonly format: "json" | "table";
  readonly options: InspectRailBacklogOptions;
}

export interface BacklogCliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const HELP_TEXT = `Usage: npm run rails:backlog -- [options]

Read-only inspection of unfinalized rail transfers, missing proof stages, and retry classes.

Options:
  --route <0..3>             Filter to a single rail route (repeatable; default: 0,1)
  --destination <chain>      Filter to a single destination chain key
  --stage <stage>            provider_discovery | destination_receipt_verification | attestation_reconciliation
  --retry-class <class>      never_checked | cooling_down | overdue | retry_overdue | exhausted
  --overdue-only             Include only overdue or exhausted candidates
  --limit <1..200>           Page size (default: 50)
  --sort <asc|desc>          Order by observed_at (default: asc, oldest first)
  --cursor <token>           Opaque keyset cursor from previous page
  --format <table|json>      Output format (default: table)
  --help                     Print this usage summary
`;

export function parseBacklogCliArgs(argv: readonly string[]): ParsedBacklogCliArgs {
  let help = false;
  let format: "json" | "table" = "table";
  const routes: number[] = [];
  let destinationChain: string | undefined;
  let stage: MissingProofStage | undefined;
  let retryClass: BacklogRetryClass | undefined;
  let overdueOnly = false;
  let limit: number | undefined;
  let sort: "asc" | "desc" | undefined;
  let cursor: string | undefined;

  const takeValue = (flag: string, index: number): string => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new BacklogValidationError("missing_argument", `missing value for ${flag}`);
    }
    return next;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--overdue-only") {
      overdueOnly = true;
      continue;
    }
    if (arg === "--route") {
      const val = takeValue(arg, i);
      i += 1;
      if (!/^\d+$/.test(val)) {
        throw new BacklogValidationError("invalid_routes", "--route must be an integer 0..3");
      }
      routes.push(Number(val));
      continue;
    }
    if (arg === "--destination") {
      destinationChain = takeValue(arg, i);
      i += 1;
      continue;
    }
    if (arg === "--stage") {
      const val = takeValue(arg, i);
      i += 1;
      if (
        val !== "provider_discovery" &&
        val !== "destination_receipt_verification" &&
        val !== "attestation_reconciliation"
      ) {
        throw new BacklogValidationError("invalid_stage", `invalid --stage: ${val}`);
      }
      stage = val;
      continue;
    }
    if (arg === "--retry-class") {
      const val = takeValue(arg, i);
      i += 1;
      if (
        val !== "never_checked" &&
        val !== "cooling_down" &&
        val !== "overdue" &&
        val !== "retry_overdue" &&
        val !== "exhausted"
      ) {
        throw new BacklogValidationError("invalid_retry_class", `invalid --retry-class: ${val}`);
      }
      retryClass = val;
      continue;
    }
    if (arg === "--limit") {
      const val = takeValue(arg, i);
      i += 1;
      if (!/^\d+$/.test(val)) {
        throw new BacklogValidationError("invalid_limit", "--limit must be a positive integer");
      }
      limit = Number(val);
      continue;
    }
    if (arg === "--sort") {
      const val = takeValue(arg, i);
      i += 1;
      if (val !== "asc" && val !== "desc") {
        throw new BacklogValidationError("invalid_sort", "--sort must be 'asc' or 'desc'");
      }
      sort = val;
      continue;
    }
    if (arg === "--cursor") {
      cursor = takeValue(arg, i);
      i += 1;
      continue;
    }
    if (arg === "--format") {
      const val = takeValue(arg, i);
      i += 1;
      if (val !== "json" && val !== "table") {
        throw new BacklogValidationError("invalid_format", "--format must be 'table' or 'json'");
      }
      format = val;
      continue;
    }

    throw new BacklogValidationError("unknown_flag", `unknown option: ${arg}`);
  }

  return {
    help,
    format,
    options: {
      ...(routes.length > 0 ? { routes } : {}),
      destinationChain,
      stage,
      retryClass,
      overdueOnly,
      limit,
      sort,
      cursor,
    },
  };
}

export async function runBacklogCli(
  argv: readonly string[],
  io: BacklogCliIo = {
    stdout: (line) => process.stdout.write(line),
    stderr: (line) => process.stderr.write(line),
  },
  injected?: {
    readonly db: Queryable | Transactional;
    readonly recheckAfterMs?: number;
    readonly maxCheckFailures?: number;
    readonly now?: () => Date;
  },
): Promise<number> {
  let parsed: ParsedBacklogCliArgs;
  try {
    parsed = parseBacklogCliArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`Error: ${message}\n\n${HELP_TEXT}`);
    return 2;
  }

  if (parsed.help) {
    io.stdout(HELP_TEXT);
    return 0;
  }

  if (injected !== undefined) {
    try {
      const report = await inspectRailBacklog(injected.db, {
        ...parsed.options,
        recheckAfterMs: injected.recheckAfterMs,
        maxCheckFailures: injected.maxCheckFailures,
        now: injected.now,
      });
      io.stdout(
        parsed.format === "json"
          ? `${JSON.stringify(report, null, 2)}\n`
          : formatBacklogReportText(report),
      );
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      io.stderr(`Error: ${message}\n`);
      return error instanceof BacklogValidationError ? 2 : 1;
    }
  }

  let config;
  try {
    config = loadConfig({
      env: {
        ...process.env,
        KEEPER_ENABLED: "false",
        INDEXER_ENABLED: "false",
        RAILS_ENABLED: "false",
      },
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      io.stderr(`\n${error.message}\n\n`);
      return 78;
    }
    throw error;
  }

  const db = Database.open(config.databaseUrl, {
    applicationName: "hyperion-rails-backlog",
  });

  try {
    const report = await inspectRailBacklog(db, {
      ...parsed.options,
      recheckAfterMs: config.rails.recheckAfterMs,
      maxCheckFailures: config.rails.maxCheckFailures,
    });
    io.stdout(
      parsed.format === "json"
        ? `${JSON.stringify(report, null, 2)}\n`
        : formatBacklogReportText(report),
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`Error: ${message}\n`);
    return error instanceof BacklogValidationError ? 2 : 1;
  } finally {
    await db.close();
  }
}

const isDirectMain =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectMain) {
  const exitCode = await runBacklogCli(process.argv.slice(2));
  process.exit(exitCode);
}
