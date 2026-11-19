/**
 * Read-only operator CLI for inspecting rail backlog age and missing proof stages.
 */
import { pathToFileURL } from "node:url";

import { loadConfig } from "../config/config.js";
import { ConfigError } from "../config/env.js";
import { Database, type Transactional } from "../db/pool.js";
import {
  BacklogValidationError,
  formatBacklogReportText,
  inspectRailBacklog,
  sanitizeRailDiagnostic,
  type InspectRailBacklogOptions,
} from "./backlog.js";
import type { MissingProofStage, RailRetryClass } from "./types.js";

export interface ParsedBacklogArguments {
  readonly help: boolean;
  readonly format: "table" | "json";
  readonly options: InspectRailBacklogOptions;
}

export interface BacklogCliIo {
  readonly stdout: (output: string) => void;
  readonly stderr: (output: string) => void;
}

const HELP = `Usage: npm run rails:backlog -- [options]

Read-only inspection of active rail transfers and their missing proof stage.

Options:
  --route <0..3>          Filter by rail route (repeatable; default: 0,1)
  --destination <chain>   Filter by destination chain
  --stage <stage>         provider_discovery | destination_receipt_verification | attestation_reconciliation
  --retry-class <class>   transient | rate_limited | permanent | exhausted
  --overdue-only          Return only candidates whose retry is due
  --limit <1..200>        Page size (default: 50)
  --sort <asc|desc>       Sort by observed time and transfer id (default: asc)
  --cursor <token>        Continue from a prior page
  --format <table|json>   Output format (default: table)
  --help                  Show this help
`;

export function parseBacklogArguments(argv: readonly string[]): ParsedBacklogArguments {
  let help = false;
  let format: "table" | "json" = "table";
  let destinationChain: string | undefined;
  let stage: MissingProofStage | undefined;
  let retryClass: RailRetryClass | undefined;
  let overdueOnly = false;
  let limit: number | undefined;
  let sort: "asc" | "desc" | undefined;
  let cursor: string | undefined;
  const routes: number[] = [];

  const takeValue = (option: string, index: number): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new BacklogValidationError("missing_argument", `${option} requires a value`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--help" || option === "-h") {
      help = true;
    } else if (option === "--overdue-only") {
      overdueOnly = true;
    } else if (option === "--route") {
      const value = takeValue(option, index);
      if (!/^\d+$/.test(value)) {
        throw new BacklogValidationError(
          "invalid_routes",
          "--route must be an integer from 0 to 3",
        );
      }
      routes.push(Number(value));
      index += 1;
    } else if (option === "--destination") {
      destinationChain = takeValue(option, index);
      index += 1;
    } else if (option === "--stage") {
      const value = takeValue(option, index);
      if (
        value !== "provider_discovery" &&
        value !== "destination_receipt_verification" &&
        value !== "attestation_reconciliation"
      ) {
        throw new BacklogValidationError("invalid_stage", `unknown proof stage: ${value}`);
      }
      stage = value;
      index += 1;
    } else if (option === "--retry-class") {
      const value = takeValue(option, index);
      if (
        value !== "transient" &&
        value !== "rate_limited" &&
        value !== "permanent" &&
        value !== "exhausted"
      ) {
        throw new BacklogValidationError("invalid_retry_class", `unknown retry class: ${value}`);
      }
      retryClass = value;
      index += 1;
    } else if (option === "--limit") {
      const value = takeValue(option, index);
      if (!/^\d+$/.test(value)) {
        throw new BacklogValidationError("invalid_limit", "--limit must be a positive integer");
      }
      limit = Number(value);
      index += 1;
    } else if (option === "--sort") {
      const value = takeValue(option, index);
      if (value !== "asc" && value !== "desc") {
        throw new BacklogValidationError("invalid_sort", "--sort must be asc or desc");
      }
      sort = value;
      index += 1;
    } else if (option === "--cursor") {
      cursor = takeValue(option, index);
      index += 1;
    } else if (option === "--format") {
      const value = takeValue(option, index);
      if (value !== "table" && value !== "json") {
        throw new BacklogValidationError("invalid_format", "--format must be table or json");
      }
      format = value;
      index += 1;
    } else {
      throw new BacklogValidationError("unknown_option", `unknown option: ${option ?? ""}`);
    }
  }

  return {
    help,
    format,
    options: {
      ...(routes.length > 0 ? { routes } : {}),
      ...(destinationChain === undefined ? {} : { destinationChain }),
      ...(stage === undefined ? {} : { stage }),
      ...(retryClass === undefined ? {} : { retryClass }),
      overdueOnly,
      ...(limit === undefined ? {} : { limit }),
      ...(sort === undefined ? {} : { sort }),
      ...(cursor === undefined ? {} : { cursor }),
    },
  };
}

export async function runBacklogCli(
  argv: readonly string[],
  io: BacklogCliIo = {
    stdout: (output) => process.stdout.write(output),
    stderr: (output) => process.stderr.write(output),
  },
  injected?: {
    readonly db: Transactional;
    readonly recheckAfterMs?: number;
    readonly maxCheckFailures?: number;
    readonly now?: () => Date;
  },
): Promise<number> {
  let parsed: ParsedBacklogArguments;
  try {
    parsed = parseBacklogArguments(argv);
  } catch (error) {
    io.stderr(`Error: ${safeError(error)}\n\n${HELP}`);
    return 2;
  }
  if (parsed.help) {
    io.stdout(HELP);
    return 0;
  }

  let db = injected?.db;
  let ownedDb: Database | undefined;
  let recheckAfterMs = injected?.recheckAfterMs;
  let maxCheckFailures = injected?.maxCheckFailures;
  try {
    if (db === undefined) {
      const config = loadConfig({
        env: {
          ...process.env,
          INDEXER_ENABLED: "false",
          RAILS_ENABLED: "false",
          KEEPER_ENABLED: "false",
        },
      });
      recheckAfterMs = config.rails.recheckAfterMs;
      maxCheckFailures = config.rails.maxCheckFailures;
      ownedDb = Database.open(config.databaseUrl, { applicationName: "hyperion-rails-backlog" });
      db = ownedDb;
    }

    const report = await inspectRailBacklog(db, {
      ...parsed.options,
      ...(recheckAfterMs === undefined ? {} : { recheckAfterMs }),
      ...(maxCheckFailures === undefined ? {} : { maxCheckFailures }),
      ...(injected?.now === undefined ? {} : { now: injected.now }),
    });
    io.stdout(
      parsed.format === "json"
        ? `${JSON.stringify(report, null, 2)}\n`
        : formatBacklogReportText(report),
    );
    return 0;
  } catch (error) {
    io.stderr(`Error: ${safeError(error)}\n`);
    if (error instanceof ConfigError) return 78;
    return error instanceof BacklogValidationError ? 2 : 1;
  } finally {
    await ownedDb?.close();
  }
}

function safeError(error: unknown): string {
  return error instanceof Error
    ? (sanitizeRailDiagnostic(error.message) ?? "an unexpected error occurred")
    : "an unexpected error occurred";
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  process.exitCode = await runBacklogCli(process.argv.slice(2));
}
