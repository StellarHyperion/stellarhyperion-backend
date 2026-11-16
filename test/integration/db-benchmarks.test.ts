import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Database } from "../../src/db/pool.js";
import { applyBenchmarkMigrations, runDatabaseLoadBenchmark } from "../helpers.js";

const CONNECTION = process.env.TEST_DATABASE_URL;
const suite = CONNECTION === undefined ? describe.skip : describe;

suite("database load and bounded-latency benchmarks on real PostgreSQL (#142)", () => {
  let db: Database;

  beforeAll(async () => {
    db = Database.open(CONNECTION ?? "", { applicationName: "hyperion-db-benchmarks" });
    await db.query("DROP SCHEMA IF EXISTS hyperion_bench_isolated CASCADE");
    await db.query("CREATE SCHEMA hyperion_bench_isolated");
    await db.query("SET search_path TO hyperion_bench_isolated");
    await applyBenchmarkMigrations(db);
  });

  afterAll(async () => {
    await db.query("DROP SCHEMA IF EXISTS hyperion_bench_isolated CASCADE");
    await db.close();
  });

  it("executes medium-scale ingestion, replay, and indexed query plans within bounded latency", async () => {
    const report = await runDatabaseLoadBenchmark(db, { scale: "medium" });
    expect(report.passed).toBe(true);
    expect(report.planRegressions).toEqual([]);
    expect(report.latencyRegressions).toEqual([]);
  }, 45_000);
});
