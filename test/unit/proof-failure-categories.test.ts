import {
  emptyProofFailureCategories,
  normalizeProofFailureReason,
} from "../../src/http/proof-failure-categories.js";

describe("proof failure categories", () => {
  it("maps provider wording to the bounded public vocabulary", () => {
    expect(normalizeProofFailureReason("recipient address mismatch")).toBe("recipient");
    expect(normalizeProofFailureReason("token manager differs")).toBe("token");
    expect(normalizeProofFailureReason("amount exceeds decimals")).toBe("amount");
    expect(normalizeProofFailureReason("receipt is not final")).toBe("finality");
    expect(normalizeProofFailureReason("unexpected provider payload")).toBe("provider_inconsistency");
  });

  it("always exposes every category, including zero counts", () => {
    expect(emptyProofFailureCategories()).toEqual({
      recipient: 0,
      token: 0,
      amount: 0,
      finality: 0,
      provider_inconsistency: 0,
    });
  });
});
