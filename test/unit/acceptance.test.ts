import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";

import {
  evaluateLaneAcceptance,
  laneAcceptancePayload,
  type SignedLaneAcceptance,
} from "../../src/rails/acceptance.js";
import { validateConcurrencyDatabase, runConcurrent } from "../helpers.js";

const source = generateKeyPairSync("ed25519");
const destination = generateKeyPairSync("ed25519");
const policy = {
  network: "testnet",
  sourceChain: "stellar-testnet",
  destinationChain: "ethereum-sepolia",
  token: "USDC",
  representation: "ITS-Stellar-USDC",
  decimals: 7,
  sourcePublicKey: source.publicKey.export({ type: "spki", format: "pem" }).toString(),
  destinationPublicKey: destination.publicKey.export({ type: "spki", format: "pem" }).toString(),
};
const proof: SignedLaneAcceptance = {
  network: policy.network,
  sourceChain: policy.sourceChain,
  destinationChain: policy.destinationChain,
  token: policy.token,
  representation: policy.representation,
  decimals: policy.decimals,
  sourceTransaction: "a".repeat(64),
  sourceBlockHash: "b".repeat(64),
  destinationTransaction: "c".repeat(64),
  destinationBlockHash: "d".repeat(64),
  amount: "18446744073709551615",
  sourceSignature: "",
  destinationSignature: "",
};
const signed = {
  ...proof,
  sourceSignature: sign(null, laneAcceptancePayload(proof), source.privateKey).toString("hex"),
  destinationSignature: sign(null, laneAcceptancePayload(proof), destination.privateKey).toString(
    "hex",
  ),
};

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
    expect(evaluateLaneAcceptance(complete, signed, policy)).toMatchObject({ state: "accepted" });
  });

  it("does not let provider discovery alone activate a lane", () => {
    const report = evaluateLaneAcceptance(
      {
        ...complete,
        destinationReceiptVerified: false,
        paymentMatched: false,
      },
      signed,
      policy,
    );
    expect(report.state).toBe("blocked");
    expect(report.prerequisites).toEqual([
      "finalized destination receipt",
      "canonical destination payment",
    ]);
  });

  it("retains every missing prerequisite for operator review", () => {
    const report = evaluateLaneAcceptance(
      {
        ...complete,
        sourceIndexed: false,
        networkMatched: false,
      },
      signed,
      policy,
    );
    expect(report.reason).toContain("source indexing");
    expect(report.reason).toContain("network identity");
  });

  it("blocks boolean-only or source-only mock evidence and one reviewer signing twice", () => {
    expect(evaluateLaneAcceptance(complete).state).toBe("blocked");
    expect(
      evaluateLaneAcceptance(complete, { ...signed, destinationSignature: "" }, policy).state,
    ).toBe("blocked");
    expect(
      evaluateLaneAcceptance(complete, signed, {
        ...policy,
        destinationPublicKey: policy.sourcePublicKey,
      }).state,
    ).toBe("blocked");
  });

  it.each(["network", "representation", "token", "sourceChain", "destinationChain"] as const)(
    "rejects changed %s identity",
    (key) => {
      expect(evaluateLaneAcceptance(complete, signed, { ...policy, [key]: "other" }).state).toBe(
        "blocked",
      );
    },
  );

  it("binds precision, full-width amount and canonical public references to both signatures", () => {
    for (const mutation of [
      { decimals: 6 },
      { amount: "1" },
      { destinationBlockHash: "e".repeat(64) },
    ]) {
      expect(evaluateLaneAcceptance(complete, { ...signed, ...mutation }, policy).state).toBe(
        "blocked",
      );
    }
    expect(evaluateLaneAcceptance(complete, signed, { ...policy, decimals: 6 }).state).toBe(
      "blocked",
    );
  });
});

describe("isolated concurrency configuration", () => {
  it("requires explicit separate configuration before targeting a remote or production database", () => {
    expect(() => validateConcurrencyDatabase("postgres://localhost/hyperion_test")).not.toThrow();
    expect(() =>
      validateConcurrencyDatabase("postgres://localhost/hyperion_session_305"),
    ).not.toThrow();
    expect(() => validateConcurrencyDatabase("postgres://localhost/production")).toThrow(
      "dedicated local test",
    );
    expect(() => validateConcurrencyDatabase("postgres://remote.example/hyperion_test")).toThrow(
      "dedicated local test",
    );
    expect(() =>
      validateConcurrencyDatabase("postgres://remote.example/hyperion_test", true),
    ).not.toThrow();
  });
  it("retains failed worker results and bounds concurrency", async () => {
    expect(
      await runConcurrent(2, (worker) =>
        worker ? Promise.reject(new Error("boundary")) : Promise.resolve("ok"),
      ),
    ).toMatchObject([{ status: "fulfilled", value: "ok" }, { status: "rejected" }]);
    await expect(runConcurrent(33, () => Promise.resolve())).rejects.toThrow("between 1 and 32");
  });
});
