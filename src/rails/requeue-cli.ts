import { buildIndexer } from "../chains/runner.js";
import { loadConfig } from "../config/config.js";
import { Database } from "../db/pool.js";
import { createLogger } from "../logging/logger.js";

interface Arguments {
  readonly transferId: bigint;
  readonly reviewedBy: string;
  readonly reason: string;
  readonly evaluateNow: boolean;
}

function parseArguments(argv: readonly string[]): Arguments | null {
  if (argv.length === 1 && argv[0] === "--help") {
    process.stdout.write(
      'Usage: npm run rail:requeue -- --transfer-id <id> --reviewed-by <operator> --reason "<review reason>" [--evaluate-now]\n',
    );
    return null;
  }

  const values = new Map<string, string>();
  let evaluateNow = false;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--evaluate-now") {
      if (evaluateNow) throw new Error("--evaluate-now may only be specified once");
      evaluateNow = true;
      continue;
    }
    if (option !== "--transfer-id" && option !== "--reviewed-by" && option !== "--reason") {
      throw new Error(`unknown argument: ${option ?? ""}`);
    }
    if (values.has(option)) throw new Error(`${option} may only be specified once`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${option} requires a value`);
    }
    values.set(option, value);
    index += 1;
  }

  const id = values.get("--transfer-id");
  if (id === undefined || !/^[1-9]\d*$/.test(id)) {
    throw new Error("--transfer-id must be a positive decimal integer");
  }
  const transferId = BigInt(id);
  if (transferId > 9_223_372_036_854_775_807n) {
    throw new Error("--transfer-id exceeds the database identifier range");
  }
  const reviewedBy = values.get("--reviewed-by");
  if (reviewedBy === undefined || reviewedBy.trim().length === 0) {
    throw new Error("--reviewed-by is required");
  }
  const reason = values.get("--reason");
  if (reason === undefined || reason.trim().length === 0) {
    throw new Error("--reason is required");
  }
  return { transferId, reviewedBy, reason, evaluateNow };
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (args === null) return;

  const config = loadConfig();
  const logger = createLogger(config);
  const db = Database.open(config.databaseUrl, { applicationName: "hyperion-rail-requeue" });
  try {
    const indexer = buildIndexer({ config, logger, db });
    const result = await indexer.requeueTransfer(
      {
        transferId: args.transferId,
        reviewedBy: args.reviewedBy,
        reason: args.reason,
      },
      { evaluateNow: args.evaluateNow },
    );
    process.stdout.write(
      `Requeued transfer ${result.transferId.toString()} from ${result.priorStatus} to pending on route ${String(result.route)}${args.evaluateNow ? " and evaluated it immediately" : ""}.\n`,
    );
  } finally {
    await db.close();
  }
}

await main();
