import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { AddressKind, encodeStellarAddress } from "@hyperion/protocol";
import pino from "pino";

import { createServerlessRuntime, type ServerlessRuntime } from "../api/index.js";
import { buildIndexer } from "../src/chains/runner.js";
import {
  settleClaim,
  writeAttestation,
  writeClaim,
  writeHealthSample,
  writeInbound,
  writeOutbound,
} from "../src/chains/writers.js";
import { loadConfig } from "../src/config/config.js";
import type { Database, Queryable, QueryResultRows } from "../src/db/pool.js";
import { buildServer } from "../src/http/server.js";

const LOCAL_TESTNET_DEPLOYMENTS = fileURLToPath(
  new URL("./fixtures/deployments-testnet.json", import.meta.url),
);

const MIGRATION_FILES = [
  "1790900000000_initial-schema.sql",
  "1791000000000_cursor-block-hash.sql",
  "1791100000000_cursor-autovacuum-tuning.sql",
] as const;

function dynHex(seed: number, bytesLen: number): `0x${string}` {
  const out: string[] = [];
  for (let i = 0; i < bytesLen; i += 1) {
    out.push(((seed + i * 23) & 0xff).toString(16).padStart(2, "0"));
  }
  return `0x${out.join("")}`;
}

export interface ParityFixtureIds {
  readonly deliveredTxHash: string;
  readonly parkedNonce: string;
  readonly settledClaimId: string;
  readonly wideNonce: string;
  readonly wideNetAmount: string;
  readonly stellarSender: string;
  readonly evmRecipientAddress: string;
}

export interface TrackedDatabaseHandle {
  readonly db: Database;
  readonly stats: {
    openCalls: number;
    closeCalls: number;
    pingCalls: number;
    queryCalls: number;
  };
  disposeEngine(): Promise<void>;
}

export async function createSeededParityDatabase(): Promise<{
  readonly handle: TrackedDatabaseHandle;
  readonly ids: ParityFixtureIds;
}> {
  const pg = new PGlite();

  for (const file of MIGRATION_FILES) {
    const fullPath = fileURLToPath(new URL(`../migrations/${file}`, import.meta.url));
    const sql = readFileSync(fullPath, "utf8").split(/^--\s*Down Migration\b/m)[0] ?? "";
    await pg.exec(sql);
  }

  const stats = {
    openCalls: 0,
    closeCalls: 0,
    pingCalls: 0,
    queryCalls: 0,
  };

  const runQuery = async (
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResultRows> => {
    stats.queryCalls += 1;
    const normalizedParams = params.map((p) => (p instanceof Date ? p.toISOString() : p));
    const res = await pg.query(sql, normalizedParams);
    const int8Cols = res.fields.filter((f) => f.dataTypeID === 20).map((f) => f.name);
    const rows = res.rows.map((raw) => {
      const copy = { ...(raw as Record<string, unknown>) };
      for (const col of int8Cols) {
        const val = copy[col];
        if (typeof val === "number" || typeof val === "bigint") {
          copy[col] = String(val);
        }
      }
      return copy;
    });
    return { rows, rowCount: res.affectedRows ?? rows.length };
  };

  const dbLike = {
    query: runQuery,
    async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
      await pg.exec("BEGIN");
      try {
        const result = await work({ query: runQuery });
        await pg.exec("COMMIT");
        return result;
      } catch (err) {
        await pg.exec("ROLLBACK");
        throw err;
      }
    },
    async ping(): Promise<void> {
      stats.pingCalls += 1;
      await pg.query("SELECT 1");
    },
    close(): Promise<void> {
      stats.closeCalls += 1;
      return Promise.resolve();
    },
  } as unknown as Database;

  const fixedTime = new Date("2026-10-15T10:00:00.000Z");
  const deliveredTime = new Date("2026-10-15T10:02:00.000Z");

  const stellarSender = encodeStellarAddress(AddressKind.Account, dynHex(0x11, 32));
  const stellarMuxed = encodeStellarAddress(AddressKind.MuxedAccount, dynHex(0x12, 32), 9001n);
  const stellarToken = encodeStellarAddress(AddressKind.Contract, dynHex(0x13, 32));
  const stellarRouter = encodeStellarAddress(AddressKind.Contract, dynHex(0x14, 32));

  const evmRecipient = dynHex(0x21, 20).toLowerCase();
  const evmRecipientWord = `0x${"0".repeat(24)}${evmRecipient.slice(2)}`;
  const evmToken = dynHex(0x22, 20).toLowerCase();
  const evmSettler = dynHex(0x23, 20).toLowerCase();

  const deliveredTxHash = dynHex(0x31, 32);
  const parkedTxHash = dynHex(0x32, 32);
  const settledTxHash = dynHex(0x33, 32);
  const destDeliveredTx = dynHex(0x41, 32);
  const destParkedTx = dynHex(0x42, 32);
  const destSettledTx = dynHex(0x43, 32);

  const wideNonce = ((1n << 63n) + 19n).toString();
  const wideGross = (1n << 210n) + 50_000n;
  const wideFee = 50_000n;
  const wideNet = 1n << 210n;
  const parkedNonce = "77";
  const settledClaimId = ((1n << 63n) + 88n).toString();

  await dbLike.transaction(async (tx) => {
    // 1. Delivered wide-integer Stellar -> Sepolia transfer
    await writeOutbound(
      tx,
      {
        chainKey: "stellar-testnet",
        block: 5_000_100n,
        txHash: deliveredTxHash,
        logIndex: null,
        observedAt: fixedTime,
      },
      {
        route: 0,
        nonce: BigInt(wideNonce),
        sender: stellarSender,
        token: stellarToken,
        grossAmount: wideGross,
        fee: wideFee,
        netAmount: wideNet,
        destinationChain: "sepolia",
        destination: evmRecipientWord,
        railRef: null,
      },
    );
    await writeInbound(
      tx,
      {
        chainKey: "sepolia",
        block: 8_100_050n,
        txHash: destDeliveredTx,
        logIndex: 0,
        observedAt: deliveredTime,
      },
      {
        route: 0,
        sourceChain: "stellar-testnet",
        sourceNonce: BigInt(wideNonce),
        railMessageId: dynHex(0x51, 32),
        recipient: evmRecipient,
        token: evmToken,
        amount: wideNet,
        delivered: true,
        claimId: null,
      },
    );

    // 2. Parked claim transfer (unsettled)
    await writeOutbound(
      tx,
      {
        chainKey: "sepolia",
        block: 8_100_010n,
        txHash: parkedTxHash,
        logIndex: 0,
        observedAt: fixedTime,
      },
      {
        route: 1,
        nonce: BigInt(parkedNonce),
        sender: evmRecipient,
        token: evmToken,
        grossAmount: 9_009_000n,
        fee: 9_000n,
        netAmount: 9_000_000n,
        destinationChain: "stellar-testnet",
        destination: stellarMuxed,
        railRef: dynHex(0x52, 32),
      },
    );
    await writeClaim(
      tx,
      {
        chainKey: "stellar-testnet",
        block: 5_000_120n,
        txHash: destParkedTx,
        logIndex: null,
        observedAt: deliveredTime,
      },
      {
        claimId: 404n,
        recipient: stellarSender,
        token: stellarToken,
        amount: 9_000_000n,
        route: 1,
        sourceChain: "sepolia",
        sourceNonce: BigInt(parkedNonce),
        createdAt: deliveredTime,
      },
    );
    await writeInbound(
      tx,
      {
        chainKey: "stellar-testnet",
        block: 5_000_120n,
        txHash: destParkedTx,
        logIndex: null,
        observedAt: deliveredTime,
      },
      {
        route: 1,
        sourceChain: "sepolia",
        sourceNonce: BigInt(parkedNonce),
        railMessageId: null,
        recipient: stellarSender,
        token: stellarToken,
        amount: 9_000_000n,
        delivered: false,
        claimId: 404n,
      },
    );

    // 3. Settled claim transfer
    await writeOutbound(
      tx,
      {
        chainKey: "stellar-testnet",
        block: 5_000_130n,
        txHash: settledTxHash,
        logIndex: null,
        observedAt: fixedTime,
      },
      {
        route: 0,
        nonce: 88n,
        sender: stellarSender,
        token: stellarToken,
        grossAmount: 4_004_000n,
        fee: 4_000n,
        netAmount: 4_000_000n,
        destinationChain: "sepolia",
        destination: evmRecipientWord,
        railRef: null,
      },
    );
    await writeClaim(
      tx,
      {
        chainKey: "sepolia",
        block: 8_100_060n,
        txHash: destSettledTx,
        logIndex: 0,
        observedAt: fixedTime,
      },
      {
        claimId: BigInt(settledClaimId),
        recipient: evmRecipient,
        token: evmToken,
        amount: 4_000_000n,
        route: 0,
        sourceChain: "stellar-testnet",
        sourceNonce: 88n,
        createdAt: fixedTime,
      },
    );
    await writeInbound(
      tx,
      {
        chainKey: "sepolia",
        block: 8_100_060n,
        txHash: destSettledTx,
        logIndex: 1,
        observedAt: fixedTime,
      },
      {
        route: 0,
        sourceChain: "stellar-testnet",
        sourceNonce: 88n,
        railMessageId: dynHex(0x53, 32),
        recipient: evmRecipient,
        token: evmToken,
        amount: 4_000_000n,
        delivered: false,
        claimId: BigInt(settledClaimId),
      },
    );
    await settleClaim(
      tx,
      {
        chainKey: "sepolia",
        block: 8_100_070n,
        txHash: dynHex(0x44, 32),
        logIndex: 0,
        observedAt: deliveredTime,
      },
      BigInt(settledClaimId),
      evmSettler,
    );

    // Record attestation on the parked transfer (`attested`, NOT `delivered`)
    const parkedIdRes = await tx.query(
      "SELECT id FROM outbound_transfer WHERE origin_chain = 'sepolia' AND nonce = $1",
      [parkedNonce],
    );
    const rawParkedId = parkedIdRes.rows[0]?.id;
    const parkedId =
      typeof rawParkedId === "string" || typeof rawParkedId === "number" ? BigInt(rawParkedId) : 1n;
    await writeAttestation(tx, {
      transferId: parkedId,
      route: 1,
      status: "attested",
      railStatus: "executed",
      railReference: "axelar-gmp-77",
      attestedAt: fixedTime,
      checkedAt: deliveredTime,
      checkFailures: 0,
      lastError: null,
    });

    // Route health sample + cursor state
    await writeHealthSample(
      tx,
      {
        chainKey: "stellar-testnet",
        block: 5_000_130n,
        txHash: settledTxHash,
        logIndex: null,
        observedAt: fixedTime,
      },
      {
        originChain: "stellar-testnet",
        destinationChain: "sepolia",
        route: 0,
        token: stellarToken,
        available: true,
        blocker: 0,
        flowAvailable: 250_000_000n,
      },
    );
    await tx.query(
      `INSERT INTO indexer_cursor (chain_key, family, contract, last_processed, last_processed_hash, updated_at)
       VALUES ('stellar-testnet', 'stellar', $1, 5000130, NULL, $2),
              ('sepolia', 'evm', $3, 8100070, $4, $2)`,
      [stellarRouter, deliveredTime.toISOString(), dynHex(0x29, 20), dynHex(0x61, 32)],
    );
  });

  return {
    handle: {
      db: dbLike,
      stats,
      async disposeEngine(): Promise<void> {
        await pg.close();
      },
    },
    ids: {
      deliveredTxHash,
      parkedNonce,
      settledClaimId,
      wideNonce,
      wideNetAmount: wideNet.toString(),
      stellarSender,
      evmRecipientAddress: evmRecipient,
    },
  };
}

export interface EntrypointComparisonReport {
  readonly transferListMatches: boolean;
  readonly transferByNonceMatches: boolean;
  readonly transferByTxMatches: boolean;
  readonly notFoundEnvelopeMatches: boolean;
  readonly claimsListMatches: boolean;
  readonly claimByIdMatches: boolean;
  readonly routeHealthMatches: boolean;
  readonly metricsDataCountsMatch: boolean;
  readonly serverlessReadyBody: Record<string, unknown>;
  readonly continuousReadyBody: Record<string, unknown>;
}

async function fetchJsonViaServerlessHttp(
  server: Server,
  path: string,
): Promise<{ readonly status: number; readonly body: unknown; readonly headers: Headers }> {
  const addr = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${String(addr.port)}${path}`);
  const body: unknown = await res.json();
  return { status: res.status, body, headers: res.headers };
}

export async function compareServerlessAndContinuousEntrypoints(options: {
  readonly dbHandle: TrackedDatabaseHandle;
  readonly ids: ParityFixtureIds;
}): Promise<{
  readonly report: EntrypointComparisonReport;
  readonly runtime: ServerlessRuntime;
}> {
  const { dbHandle, ids } = options;
  const startedAt = new Date("2026-10-15T09:55:00.000Z");
  const logger = pino({ level: "silent" });

  // 1. Continuous entrypoint (buildIndexer + buildServer, matching src/main.ts)
  const continuousConfig = loadConfig({
    env: {
      DATABASE_URL: "postgres://hyperion:not-a-real-password@127.0.0.1:5433/hyperion",
      REDIS_URL: "redis://127.0.0.1:6380",
      HYPERION_NETWORK: "testnet",
      HYPERION_DEPLOYMENTS_FILE: LOCAL_TESTNET_DEPLOYMENTS,
      NODE_ENV: "test",
      INDEXER_ENABLED: "true",
      RAILS_ENABLED: "true",
      KEEPER_ENABLED: "false",
    },
  });
  const indexer = buildIndexer({
    config: continuousConfig,
    logger,
    db: dbHandle.db,
  });
  const continuousApp = buildServer({
    config: continuousConfig,
    logger,
    db: dbHandle.db,
    readiness: indexer.readiness,
    startedAt,
  });
  await continuousApp.ready();

  // 2. Serverless API-only entrypoint (createServerlessRuntime from api/index.ts over real HTTP)
  const serverlessRuntime = createServerlessRuntime({
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgres://hyperion:unused@127.0.0.1:5433/hyperion",
      HYPERION_NETWORK: "testnet",
      HYPERION_DEPLOYMENTS_FILE: LOCAL_TESTNET_DEPLOYMENTS,
    },
    startedAt,
    createLoggerFn: () => logger,
    openDatabase: () => {
      dbHandle.stats.openCalls += 1;
      return dbHandle.db;
    },
  });

  const httpServer = createServer((req, res) => {
    void serverlessRuntime.handler(req, res);
  });
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });

  try {
    const comparePath = async (path: string): Promise<boolean> => {
      const [contRes, slsRes] = await Promise.all([
        continuousApp.inject({ method: "GET", url: path }),
        fetchJsonViaServerlessHttp(httpServer, path),
      ]);
      if (contRes.statusCode !== slsRes.status) return false;
      const contBody: unknown = contRes.json();
      if (path.endsWith("/not-a-real-tx")) {
        const a = contBody as Record<string, unknown>;
        const b = slsRes.body as Record<string, unknown>;
        return a.error === b.error && a.message === b.message;
      }
      return JSON.stringify(contBody) === JSON.stringify(slsRes.body);
    };

    const transferListMatches = await comparePath("/v1/transfers?limit=20&offset=0");
    const transferByNonceMatches = await comparePath(
      `/v1/transfers/stellar-testnet/${ids.wideNonce}`,
    );
    const transferByTxMatches = await comparePath(`/v1/transfers/by-tx/${ids.deliveredTxHash}`);
    const notFoundEnvelopeMatches = await comparePath("/v1/transfers/by-tx/not-a-real-tx");
    const claimsListMatches = await comparePath("/v1/claims?limit=20");
    const claimByIdMatches = await comparePath(`/v1/claims/sepolia/${ids.settledClaimId}`);
    const routeHealthMatches = await comparePath("/v1/routes/health");

    const [contMetricsRes, slsMetricsRes] = await Promise.all([
      continuousApp.inject({ method: "GET", url: "/v1/metrics" }),
      fetchJsonViaServerlessHttp(httpServer, "/v1/metrics"),
    ]);
    const contMetrics = contMetricsRes.json<Record<string, unknown>>();
    const slsMetrics = slsMetricsRes.body as Record<string, unknown>;
    const metricsDataCountsMatch =
      contMetricsRes.statusCode === 200 &&
      slsMetricsRes.status === 200 &&
      JSON.stringify({
        service: contMetrics.service,
        network: contMetrics.network,
        transfers: contMetrics.transfers,
        claims: contMetrics.claims,
        railAttestations: contMetrics.railAttestations,
        cursors: contMetrics.cursors,
      }) ===
        JSON.stringify({
          service: slsMetrics.service,
          network: slsMetrics.network,
          transfers: slsMetrics.transfers,
          claims: slsMetrics.claims,
          railAttestations: slsMetrics.railAttestations,
          cursors: slsMetrics.cursors,
        });

    const [contReadyRes, slsReadyRes] = await Promise.all([
      continuousApp.inject({ method: "GET", url: "/ready" }),
      fetchJsonViaServerlessHttp(httpServer, "/ready"),
    ]);

    return {
      report: {
        transferListMatches,
        transferByNonceMatches,
        transferByTxMatches,
        notFoundEnvelopeMatches,
        claimsListMatches,
        claimByIdMatches,
        routeHealthMatches,
        metricsDataCountsMatch,
        serverlessReadyBody: slsReadyRes.body as Record<string, unknown>,
        continuousReadyBody: contReadyRes.json<Record<string, unknown>>(),
      },
      runtime: serverlessRuntime,
    };
  } finally {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
    await indexer.stop();
    await continuousApp.close();
  }
}
