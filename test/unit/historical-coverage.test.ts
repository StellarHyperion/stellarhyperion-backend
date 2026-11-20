import { describe, expect, it } from "vitest";
import type { Queryable } from "../../src/db/pool.js";
import { readHistoricalCoverage } from "../../src/http/historical-coverage.js";

it("reports absent historical observations explicitly", async () => {
  const db: Queryable = {
    query: () =>
      Promise.resolve({
        rowCount: 1,
        rows: [
          {
            snapshot: {
              historyGaps: { open: "0", reconciling: "0", reconciled: "0" },
              sources: [],
            },
          },
        ],
      }),
  };
  expect((await readHistoricalCoverage(db, [])).historicalCoverage).toMatchObject({
    unresolved: 0,
    unknown: true,
  });
});
describe("historical coverage schema availability", () => {
  it.each(["42P01", "42703"])("keeps a %s schema gap unknown", async (code) => {
    const db: Queryable = {
      query: () => {
        return Promise.reject(Object.assign(new Error("private database detail"), { code }));
      },
    };
    const metrics = await readHistoricalCoverage(db, []);
    expect(metrics.historicalCoverage).toMatchObject({ unresolved: null, unknown: true });
    expect(JSON.stringify(metrics)).not.toContain("private");
  });
  it("propagates operational database failures", async () => {
    const db: Queryable = {
      query: () => {
        return Promise.reject(Object.assign(new Error("timeout"), { code: "57014" }));
      },
    };
    await expect(readHistoricalCoverage(db, [])).rejects.toMatchObject({ code: "57014" });
  });
});
