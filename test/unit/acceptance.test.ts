import { describe, expect, it } from "vitest";

import { evaluateLaneAcceptance } from "../../src/rails/acceptance.js";

const complete = {
  sourceIndexed: true,
  providerDiscovered: true,
  destinationReceiptVerified: true,
  paymentMatched: true,
  tokenMatched: true,
  amountMatched: true,
  networkMatched: true,
};

describe("lane acceptance", () => {
  it("accepts only independently verified source and destination evidence", () => {
    expect(evaluateLaneAcceptance(complete)).toMatchObject({ state: "accepted" });
  });

  it("does not let provider discovery alone activate a lane", () => {
    const report = evaluateLaneAcceptance({
      ...complete,
      destinationReceiptVerified: false,
      paymentMatched: false,
    });
    expect(report.state).toBe("blocked");
    expect(report.prerequisites).toEqual([
      "finalized destination receipt",
      "canonical destination payment",
    ]);
  });

  it("retains every missing prerequisite for operator review", () => {
    const report = evaluateLaneAcceptance({
      ...complete,
      sourceIndexed: false,
      networkMatched: false,
    });
    expect(report.reason).toContain("source indexing");
    expect(report.reason).toContain("network identity");
  });
});
