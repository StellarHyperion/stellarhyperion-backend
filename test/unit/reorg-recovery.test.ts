import { describe, expect, it } from "vitest";
import { readCommittedReorgRecovery, reorgRecoveryState } from "../../src/http/reorg-recovery.js";

describe("durable reorg recovery reporting", () => {
  it("reads committed journal evidence after restart without inventing detected depth", async () => {
    const journal = await readCommittedReorgRecovery({
      query(sql) {
        expect(sql).toContain("WHERE reorg_detected");
        expect(sql).toContain("LIMIT 512");
        return Promise.resolve({
          rows: [
            {
              chain_key: "sepolia",
              reorgs: "2",
              replayed_logs: "7",
              last_recovery_at: new Date(0),
            },
          ],
          rowCount: 1,
        });
      },
    });
    expect(journal).toEqual([
      {
        chain: "sepolia",
        reorgs: 2,
        replayedLogs: 7,
        lastRecoveryAt: new Date(0).toISOString(),
        detectedDepth: null,
      },
    ]);
  });

  it.each([
    { committedRecoveries: 0, pending: true, stale: false, failures: 1, state: "degraded" },
    { committedRecoveries: 1, pending: true, stale: false, failures: 0, state: "ready" },
    { committedRecoveries: 1, pending: false, stale: true, failures: 0, state: "ready" },
    { committedRecoveries: 1, pending: false, stale: false, failures: 1, state: "ready" },
    { committedRecoveries: 1, pending: false, stale: false, failures: 0, state: "degraded" },
  ])("reports unresolved or stale recovery as requiring intervention: %j", (input) => {
    expect(reorgRecoveryState(input)).toBe("operator_intervention");
  });

  it("distinguishes a healthy committed recovery from no recovery", () => {
    const healthy = {
      committedRecoveries: 1,
      pending: false,
      stale: false,
      failures: 0,
      state: "ready",
    };
    expect(reorgRecoveryState(healthy)).toBe("automatic");
    expect(reorgRecoveryState({ ...healthy, committedRecoveries: 0 })).toBe("none");
  });
});
