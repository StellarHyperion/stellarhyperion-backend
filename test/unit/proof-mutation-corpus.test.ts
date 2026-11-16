import { describe, expect, it } from "vitest";

import { loadProofMutationOracle, runDestinationProofMutationCorpus } from "../helpers.js";

describe("Destination-proof mutation corpus (#139)", () => {
  it("runs all 34 CCTP and Axelar ITS receipt and message mutations against the independent expected result oracle with zero mismatches", async () => {
    const oracle = loadProofMutationOracle();
    const report = await runDestinationProofMutationCorpus();

    expect(report.totalCases).toBe(oracle.cases.length);
    expect(report.totalCases).toBe(34);
    expect(report.mismatches).toEqual([]);
    expect(report.allMatched).toBe(true);
    expect(report.passedCases).toBe(34);
  }, 30_000);

  it("rejects every mutated recipient, amount, fee, token, domain, sender, commandId, non-mint transfer, and non-canonical block hash across both verifiers", async () => {
    const report = await runDestinationProofMutationCorpus();

    const rejectedMutations = report.records.filter(
      (r) => r.mutationKind !== "valid_baseline" && r.mutationKind !== "harmless_noise",
    );
    expect(rejectedMutations.length).toBe(29);

    for (const item of rejectedMutations) {
      expect(item.actualAccepted, `${item.caseId} should be rejected`).toBe(false);
      expect(item.actualLogIndex).toBeNull();
      expect(item.verifiedAmount).toBeNull();
      expect(item.matchesExpected).toBe(true);
    }

    // Explicitly verify canonical block hash rejection on both CCTP and ITS.
    const canonicalHashCases = report.records.filter(
      (r) => r.mutationKind === "canonical_hash_mismatch",
    );
    expect(canonicalHashCases.map((c) => c.caseId)).toEqual([
      "cctp_mutated_canonical_block_hash",
      "its_mutated_canonical_block_hash",
    ]);
    for (const item of canonicalHashCases) {
      expect(item.actualAccepted).toBe(false);
      expect(item.mutatedField).toBe("block.hash");
    }
  }, 30_000);

  it("preserves valid proofs when harmless unrelated logs are interleaved and records exact mutation and verifier output fields", async () => {
    const report = await runDestinationProofMutationCorpus();

    const acceptedCases = report.records.filter(
      (r) => r.mutationKind === "valid_baseline" || r.mutationKind === "harmless_noise",
    );
    expect(acceptedCases.map((c) => c.caseId)).toEqual([
      "cctp_baseline_valid",
      "cctp_harmless_unrelated_logs_interleaved",
      "cctp_harmless_other_recipient_mint_in_same_tx",
      "its_baseline_valid",
      "its_harmless_unrelated_logs_interleaved",
    ]);

    for (const item of acceptedCases) {
      expect(item.actualAccepted).toBe(true);
      expect(item.actualLogIndex).toBe(item.expectedLogIndex);
      expect(item.verifiedAmount).toMatch(/^[1-9][0-9]*$/);
      expect(item.verifiedRecipient).toMatch(/^0x[0-9a-f]{40}$/);
      expect(item.verifiedToken).toMatch(/^0x[0-9a-f]{40}$/);
      expect(item.description.length).toBeGreaterThan(10);
      expect(item.mutatedField.length).toBeGreaterThan(0);
    }

    const cctpNoise = acceptedCases.find(
      (c) => c.caseId === "cctp_harmless_unrelated_logs_interleaved",
    );
    expect(cctpNoise?.verifiedAmount).toBe("99600000");

    const itsNoise = acceptedCases.find(
      (c) => c.caseId === "its_harmless_unrelated_logs_interleaved",
    );
    expect(itsNoise?.verifiedAmount).toBe("42500000");
  }, 30_000);
});
