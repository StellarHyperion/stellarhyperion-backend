import { describe, expect, it } from "vitest";
import { recordEvmDeploymentRevision, rewindEvmEvents } from "../../src/chains/evm/store.js";
import type { Queryable } from "../../src/db/pool.js";

describe("deployment-scoped EVM history", () => {
  it("backfills unknown legacy activation before retiring it and validates immutable identity", async () => {
    const queries: string[] = [];
    const db: Queryable = {
      query(sql) {
        queries.push(sql);
        return Promise.resolve({ rows: [], rowCount: 1 });
      },
    };
    await recordEvmDeploymentRevision(db, {
      chainKey: "sepolia",
      chainId: 1,
      deploymentRevision: 2,
      contract: "0xnew",
      startBlock: 20n,
      previousRevision: 1,
      previousContract: "0xold",
      previousCursor: 19n,
      previousCursorHash: "hash",
    });
    expect(queries).toHaveLength(3);
    expect(queries[0]).toContain("NULL) ON CONFLICT");
    expect(queries[1]).toContain("IS NOT DISTINCT FROM EXCLUDED.start_block");
    expect(queries[2]).toContain("retired_block");
  });

  it("rejects an existing revision with a conflicting router rather than silently accepting it", async () => {
    await expect(
      recordEvmDeploymentRevision(
        { query: () => Promise.resolve({ rows: [], rowCount: 0 }) },
        {
          chainKey: "sepolia",
          chainId: 1,
          deploymentRevision: 1,
          contract: "0xnew",
          startBlock: 20n,
          previousRevision: null,
          previousContract: null,
          previousCursor: null,
          previousCursorHash: null,
        },
      ),
    ).rejects.toThrow("conflicting immutable");
  });

  it("retains other-router and earlier-revision provenance during orphan cleanup", async () => {
    const queries: { sql: string; params: readonly unknown[] }[] = [];
    await rewindEvmEvents(
      {
        query(sql, params = []) {
          queries.push({ sql, params });
          return Promise.resolve({ rows: [], rowCount: 0 });
        },
      },
      "sepolia",
      "0xrouter",
      20n,
      2,
    );
    const source = queries.filter(({ sql }) => sql.includes("FROM source_event"));
    expect(source.length).toBeGreaterThan(0);
    for (const query of source) {
      expect(query.sql).toContain("deployment_revision = $4");
      expect(query.params).toEqual(["sepolia", "0xrouter", "20", 2]);
    }
    const quarantine = queries.find(({ sql }) => sql.includes("DELETE FROM evm_log_quarantine"));
    expect(quarantine?.sql).toContain("lower(contract) = lower($2)");
    expect(quarantine?.params).toEqual(["sepolia", "0xrouter", "20"]);
  });
});
