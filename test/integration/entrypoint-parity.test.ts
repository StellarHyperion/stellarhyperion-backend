import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeApp, getApp, getDb } from "../../api/index.js";
import { startContinuousApplication } from "../../src/main.js";
import { loadConfig } from "../../src/config/config.js";
import { API_READ_TABLES } from "../../src/db/policy.js";
import { Database } from "../../src/db/pool.js";
import { writeOutbound, writeInbound, writeClaim } from "../../src/chains/writers.js";
import { completeEnv, validateConcurrencyDatabase } from "../helpers.js";

const connection = process.env.TEST_DATABASE_URL;
const suite = connection ? describe : describe.skip;
const U64_MAX = (1n << 64n) - 1n;
const AMOUNT = (1n << 100n) + 12345n;
const MESSAGE_ID = `0x${"ff".repeat(32)}`;
const OBSERVED = new Date("2026-11-22T10:00:00Z");

async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  if (address === null || typeof address === "string") throw new Error("no test port");
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => {
      if (error) reject(error);
      else resolve();
    }),
  );
  return address.port;
}

suite("indexed API semantics across serverless and continuous entrypoints", () => {
  let admin: Database;
  let opened = false;
  let originalIdentity: readonly Record<string, unknown>[] = [];
  let roleCreated = false;
  let environment: Record<string, string | undefined>;
  const role = `hyperion_parity_${process.pid}`;
  const ids: string[] = [];
  let token = "";

  beforeAll(async () => {
    validateConcurrencyDatabase(connection ?? "");
    admin = Database.open(connection ?? "");
    opened = true;
    originalIdentity = (await admin.query("SELECT environment FROM hyperion_database_identity"))
      .rows;
    await admin.query("DELETE FROM hyperion_database_identity");
    await admin.query("INSERT INTO hyperion_database_identity(environment) VALUES ('preview')");
    await admin.query(
      `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
    roleCreated = true;
    await admin.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await admin.query(
      `GRANT SELECT ON ${API_READ_TABLES.map((name) => `public.${name}`).join(",")} TO "${role}"`,
    );
    const reader = new URL(connection ?? "");
    reader.username = role;
    reader.password = "";
    environment = completeEnv({
      DATABASE_URL: reader.toString(),
      REDIS_URL: "",
      NODE_ENV: "test",
      LOG_LEVEL: "fatal",
      VERCEL_ENV: "preview",
      HYPERION_DATABASE_ENV: "preview",
      HYPERION_DATABASE_ROLE: "read-only",
      INDEXER_ENABLED: "false",
      RAILS_ENABLED: "false",
      KEEPER_ENABLED: "false",
      HTTP_HOST: "127.0.0.1",
      DEPLOYMENT_MODE: "api-only",
    });
    for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
    const source = loadConfig().deployments.networks["stellar-testnet"];
    const asset = source?.tokens.USDC;
    if (!source || !asset || !("sacId" in asset))
      throw new Error("missing Stellar test deployment");
    token = asset.sacId;
    for (const [index, parked] of [false, true].entries()) {
      const nonce = U64_MAX - BigInt(index);
      const originTx = `0x${String(index + 1).repeat(64)}`;
      const recipient = `0x${"12".repeat(20)}`;
      await admin.transaction(async (tx) => {
        await writeOutbound(
          tx,
          {
            chainKey: "stellar-testnet",
            router: source.router,
            block: 5555n + BigInt(index),
            txHash: originTx,
            logIndex: null,
            observedAt: OBSERVED,
          },
          {
            route: 0,
            nonce,
            sender: token,
            token,
            grossAmount: AMOUNT + 300n,
            fee: 300n,
            netAmount: AMOUNT,
            destinationChain: "sepolia",
            destination: `0x${"00".repeat(12)}${recipient.slice(2)}`,
            railRef: null,
          },
        );
        const row = (
          await tx.query(
            "SELECT id::text AS id FROM outbound_transfer WHERE origin_chain=$1 AND origin_router=$2 AND nonce=$3",
            ["stellar-testnet", source.router, nonce.toString()],
          )
        ).rows[0];
        if (typeof row?.id !== "string") throw new Error("missing seeded transfer");
        ids.push(row.id);
        await writeInbound(
          tx,
          {
            chainKey: "sepolia",
            router: "parity-destination-router",
            block: 9007199254740993n + BigInt(index),
            txHash: `0x${String(index + 3).repeat(64)}`,
            logIndex: index + 7,
            observedAt: OBSERVED,
          },
          {
            sourceTransferId: BigInt(row.id),
            route: 0,
            sourceChain: "stellar-testnet",
            sourceNonce: nonce,
            railMessageId: parked ? `0x${"ee".repeat(32)}` : MESSAGE_ID,
            recipient,
            token: `0x${"34".repeat(20)}`,
            amount: AMOUNT,
            delivered: !parked,
            claimId: parked ? U64_MAX : null,
          },
        );
        if (parked)
          await writeClaim(
            tx,
            {
              chainKey: "sepolia",
              router: "parity-destination-router",
              block: 9007199254740994n,
              txHash: `0x${"4".repeat(64)}`,
              logIndex: 8,
              observedAt: OBSERVED,
            },
            {
              claimId: U64_MAX,
              recipient,
              token: `0x${"34".repeat(20)}`,
              amount: AMOUNT,
              route: 0,
              sourceChain: "stellar-testnet",
              sourceNonce: nonce,
              createdAt: OBSERVED,
            },
          );
      });
    }
  });

  afterAll(async () => {
    await closeApp();
    if (opened) {
      if (roleCreated) {
        await admin.query(`DROP OWNED BY "${role}"`);
        await admin.query(`DROP ROLE "${role}"`);
      }
      await admin.query("DELETE FROM pending_claim WHERE chain='sepolia' AND claim_id=$1", [
        U64_MAX.toString(),
      ]);
      await admin.query("DELETE FROM inbound_delivery WHERE source_transfer_id=ANY($1::bigint[])", [
        ids,
      ]);
      await admin.query("DELETE FROM outbound_transfer WHERE id=ANY($1::bigint[])", [ids]);
      await admin.query("DELETE FROM hyperion_database_identity");
      for (const row of originalIdentity)
        await admin.query("INSERT INTO hyperion_database_identity(environment) VALUES ($1)", [
          row.environment,
        ]);
      await admin.close();
    }
    vi.unstubAllEnvs();
  });

  it("preserves exact indexed transfers, claims and database rows across both real startups and restarts", async () => {
    const before = (
      await admin.query(
        "SELECT row_to_json(t) AS row FROM outbound_transfer t WHERE id=ANY($1::bigint[]) ORDER BY id",
        [ids],
      )
    ).rows;
    const signalCounts = ["SIGINT", "SIGTERM", "unhandledRejection"].map((name) =>
      process.listenerCount(name),
    );
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const apps = await Promise.all(Array.from({ length: 8 }, () => getApp()));
      const api = apps[0];
      if (!api) throw new Error("missing serverless app");
      expect(new Set(apps).size).toBe(1);
      const apiDb = getDb();
      if (!apiDb) throw new Error("missing serverless database");
      vi.stubEnv("DEPLOYMENT_MODE", "custom");
      vi.stubEnv("HTTP_PORT", String(await freePort()));
      const continuous = await startContinuousApplication();
      vi.stubEnv("DEPLOYMENT_MODE", "api-only");
      try {
        for (const url of [
          "/v1/transfers",
          ...ids.map((id) => `/v1/transfers/${id}`),
          "/v1/claims",
        ]) {
          const first = await api.inject({ method: "GET", url });
          const second = await continuous.server.inject({ method: "GET", url });
          expect(first.statusCode, url).toBe(200);
          expect(second.statusCode, url).toBe(200);
          expect(first.json(), url).toEqual(second.json());
        }
        const delivered = (
          await api.inject({ method: "GET", url: `/v1/transfers/${ids[0]}` })
        ).json();
        expect(delivered.origin).toMatchObject({
          nonce: U64_MAX.toString(),
          token,
          grossAmount: (AMOUNT + 300n).toString(),
          fee: "300",
          netAmount: AMOUNT.toString(),
          block: "5555",
        });
        expect(delivered.destination).toMatchObject({
          amount: AMOUNT.toString(),
          delivered: true,
          block: "9007199254740993",
        });
        expect(delivered.stage).toBe("delivered");
        const parked = (await api.inject({ method: "GET", url: `/v1/transfers/${ids[1]}` })).json();
        expect(parked.stage).toBe("parked");
        expect(parked.destination.delivered).toBe(false);
        expect(parked.claim.id).toBe(U64_MAX.toString());
        const ready = (await api.inject({ method: "GET", url: "/ready" })).json();
        expect(ready).not.toHaveProperty("workerRuns");
        expect(ready).not.toHaveProperty("runCorrelation");
        expect(ready.meaning).toContain("Background workers are not started or assessed");
        expect(apiDb.poolSnapshot().totalConnections).toBeLessThanOrEqual(2);
        await expect(
          apiDb.query("UPDATE outbound_transfer SET fee=0 WHERE id=$1", [ids[0]]),
        ).rejects.toThrow();
      } finally {
        await Promise.all([continuous.stop("parity-test"), continuous.stop("parity-test-repeat")]);
        await Promise.all([closeApp(), closeApp()]);
      }
      expect(apiDb.poolSnapshot().totalConnections).toBe(0);
      expect(continuous.db.poolSnapshot().totalConnections).toBe(0);
      await vi.waitFor(async () => {
        const rows = (
          await admin.query(
            "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE usename=$1",
            [role],
          )
        ).rows;
        expect(rows[0]?.count).toBe(0);
      });
      expect(
        ["SIGINT", "SIGTERM", "unhandledRejection"].map((name) => process.listenerCount(name)),
      ).toEqual(signalCounts);
      expect(
        (
          await admin.query(
            "SELECT row_to_json(t) AS row FROM outbound_transfer t WHERE id=ANY($1::bigint[]) ORDER BY id",
            [ids],
          )
        ).rows,
      ).toEqual(before);
    }
  });
});
