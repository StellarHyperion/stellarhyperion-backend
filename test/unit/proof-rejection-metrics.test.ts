import { describe, expect, it } from "vitest";
import type { Queryable } from "../../src/db/pool.js";
import { readProofRejectionMetrics } from "../../src/http/proof-rejection-metrics.js";

const result = (rows: Record<string, unknown>[]) => ({ rows, rowCount: rows.length });
describe("bounded proof rejection aggregates", () => {
  it("retains available categories when an older schema lacks another source", async () => {
    let call = 0;
    const db: Queryable = {
      query: () => {
        if (++call === 1) return Promise.resolve(result([{ category: "recipient", count: "3" }]));
        if (call === 2)
          return Promise.reject(
            Object.assign(new Error("private provider connection"), { code: "42703" }),
          );
        return Promise.resolve(result([{ category: "provider_inconsistency", count: "2" }]));
      },
    };
    const metrics = await readProofRejectionMetrics(db);
    expect(metrics.total.recipient).toBe(3);
    expect(metrics.total.provider_inconsistency).toBe(2);
    expect(metrics.coverage).toEqual({
      version: 1,
      known: false,
      sources: { cctp: true, its: false, ingestion: true },
    });
    expect(JSON.stringify(metrics)).not.toContain("private");
  });
  it("does not turn a database failure into a clean zero", async () => {
    const db: Queryable = {
      query: () => {
        return Promise.reject(Object.assign(new Error("unavailable"), { code: "57014" }));
      },
    };
    await expect(readProofRejectionMetrics(db)).rejects.toMatchObject({ code: "57014" });
  });
  it.each([
    [{ category: "https://user:private@provider/?token=private", count: "1" }],
    [{ category: "amount", count: "9007199254740992" }],
    [{ category: "amount", count: "-1" }],
  ])("rejects invalid aggregate labels or inexact counts", async (row) => {
    const db: Queryable = { query: () => Promise.resolve(result([row])) };
    await expect(readProofRejectionMetrics(db)).rejects.toThrow();
  });
});
