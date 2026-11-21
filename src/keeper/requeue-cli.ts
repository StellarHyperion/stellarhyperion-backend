import { Queue } from "bullmq";
import { rpc } from "@stellar/stellar-sdk";

import { loadConfig } from "../config/config.js";
import { Database } from "../db/pool.js";
import { createKeeperRedis, KEEPER_QUEUE_NAME, requeueFailedKeeperJob } from "./queue.js";

interface Arguments {
  readonly jobId: string;
  readonly reviewedBy: string;
  readonly reason: string;
}

const HELP = `Usage: npm run keeper:requeue -- --job-id <id> --reviewed-by <operator> --reason "<review reason>"

Reconcile pending public Stellar transactions, then retry one failed supported keeper job.
`;

function parseArguments(argv: readonly string[]): Arguments | null {
  if (argv.length === 1 && argv[0] === "--help") {
    process.stdout.write(HELP);
    return null;
  }
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option !== "--job-id" && option !== "--reviewed-by" && option !== "--reason")
      throw new Error("Unknown argument; use --help for supported options.");
    if (values.has(option)) throw new Error(`${option} may only be specified once.`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`${option} requires a value.`);
    values.set(option, value);
    index += 1;
  }
  const jobId = values.get("--job-id");
  const reviewedBy = values.get("--reviewed-by");
  const reason = values.get("--reason");
  if (!jobId?.trim()) throw new Error("--job-id is required.");
  if (!reviewedBy?.trim()) throw new Error("--reviewed-by is required.");
  if (!reason?.trim()) throw new Error("--reason is required.");
  return { jobId, reviewedBy, reason };
}

async function main(): Promise<void> {
  let args: Arguments | null;
  try {
    args = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Invalid arguments"}\n\n${HELP}`,
    );
    process.exitCode = 2;
    return;
  }
  if (args === null) return;

  let db: Database | undefined;
  const config = loadConfig();
  const redis = createKeeperRedis(config.redisUrl);
  let queue: Queue | undefined;
  try {
    db = Database.open(config.databaseUrl, {
      maxConnections: 2,
      applicationName: "hyperion-keeper-requeue",
    });
    await redis.connect();
    queue = new Queue(KEEPER_QUEUE_NAME, { connection: redis });
    const chain = config.indexer.stellar;
    if (!chain) throw new Error("No Stellar deployment is configured.");
    await requeueFailedKeeperJob(
      queue,
      db,
      config,
      args.jobId,
      args.reviewedBy,
      args.reason,
      new rpc.Server(chain.rpcUrl, { timeout: 15_000 }),
    );
    process.stdout.write(`Requeued failed keeper job ${args.jobId} after review.\n`);
  } catch {
    process.stderr.write(
      "Keeper job recovery failed; verify the job, database, Redis, and Stellar network state.\n",
    );
    process.exitCode = 1;
  } finally {
    await queue?.close();
    redis.disconnect();
    await db?.close();
  }
}

await main();
