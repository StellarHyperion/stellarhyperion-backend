import { AddressKind, encodeStellarAddress } from "@hyperion/protocol";
import type { Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { writeOutbound } from "../../src/chains/writers.js";
import { Database } from "../../src/db/pool.js";
import { IrisClient } from "../../src/rails/cctp/iris.js";
import { RailPass } from "../../src/rails/pass.js";
import { applyRailSimulatorMigrations, createRailProviderSimulator } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const CONNECTION = process.env.TEST_DATABASE_URL;
const suite = CONNECTION === undefined ? describe.skip : describe;

function hexWord(seed: number, len: number): Hex {
  const out: string[] = [];
  for (let i = 0; i < len; i += 1) {
    out.push(((seed + i * 31) & 0xff).toString(16).padStart(2, "0"));
  }
  return `0x${out.join("")}`;
}

suite("rail-provider rate-limit simulator against real Postgres (#143)", () => {
  let db: Database;

  beforeAll(async () => {
    db = Database.open(CONNECTION ?? "", { applicationName: "hyperion-rail-sim-test" });
    await db.query("DROP SCHEMA IF EXISTS rail_sim_test CASCADE");
    await db.query("CREATE SCHEMA rail_sim_test");
    await db.query("SET search_path TO rail_sim_test");
    await applyRailSimulatorMigrations(db);
  });

  afterAll(async () => {
    await db.query("DROP SCHEMA IF EXISTS rail_sim_test CASCADE");
    await db.close();
  });

  it("persists Retry-After cooldown across RailPass restarts and never writes fake delivered rows", async () => {
    const { logger } = capturingLogger();
    let clockMs = Date.parse("2026-10-16T18:00:00.000Z");
    const now = () => new Date(clockMs);

    const dest = encodeStellarAddress(AddressKind.Account, hexWord(0x11, 32));
    await db.transaction(async (tx) => {
      await writeOutbound(
        tx,
        {
          chainKey: "sepolia",
          block: 500n,
          txHash: hexWord(0x22, 32),
          logIndex: 0,
          observedAt: now(),
        },
        {
          route: 0,
          nonce: 301n,
          sender: hexWord(0x33, 20),
          token: hexWord(0x44, 20),
          grossAmount: 1_001_000n,
          fee: 1_000n,
          netAmount: 1_000_000n,
          destinationChain: "stellar-testnet",
          destination: dest,
          railRef: null,
        },
      );
    });

    const simulator = createRailProviderSimulator({ now });
    simulator.enqueue(
      "cctp",
      { kind: "rate_limit", retryAfterSeconds: 60 },
      { kind: "iris_attested", status: "complete", eventNonce: "801" },
    );

    const makePass = () =>
      new RailPass({
        route: 0,
        client: new IrisClient("testnet", {
          baseUrl: "https://iris-sim.example.invalid",
          fetch: simulator.fetch,
          now,
        }),
        db,
        logger,
        batchSize: 10,
        recheckAfterMs: 1_000,
        maxCheckFailures: 5,
        now,
      });

    await makePass().tick(AbortSignal.timeout(5_000));
    expect(simulator.requestCount("cctp")).toBe(1);

    clockMs += 20_000;
    const restarted = makePass();
    await restarted.tick(AbortSignal.timeout(5_000));
    expect(simulator.requestCount("cctp")).toBe(1);

    clockMs += 45_000;
    await restarted.tick(AbortSignal.timeout(5_000));
    expect(simulator.requestCount("cctp")).toBe(2);

    const att = await db.query("SELECT status FROM rail_attestation");
    expect(att.rows).toEqual([{ status: "attested" }]);
  });
});
