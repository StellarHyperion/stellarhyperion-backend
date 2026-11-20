import { describe, expect, it } from "vitest";
import { RateLimitSimulator, RailRateLimitError, RailTimeoutError } from "../helpers.js";
import { RailError, type PendingTransfer, type RailClient } from "../../src/rails/types.js";

const transfer = (id = 1n): PendingTransfer => ({
  transferId: id,
  route: 0,
  originChain: "sepolia",
  destinationChain: "stellar-testnet",
  nonce: 18446744073709551615n,
  originTx: "source",
  status: "pending",
  checkFailures: 0,
  retryAttempts: 0,
  delivered: false,
});

describe("fault-only rail provider simulator", () => {
  it("targets faults by transfer independently of concurrent request order", async () => {
    const simulator = new RateLimitSimulator();
    simulator.simulateRetryAfter(45, 1n);
    simulator.simulateTimeout("intermittent timeout", 2n);
    const results = await Promise.allSettled([
      simulator.look(transfer(3n)),
      simulator.look(transfer(2n)),
      simulator.look(transfer(1n)),
    ]);
    expect(results[0]).toMatchObject({
      status: "fulfilled",
      value: { kind: "found", report: { status: "pending" } },
    });
    expect(results[1]).toMatchObject({ status: "rejected", reason: { kind: "transient" } });
    expect(results[2]).toMatchObject({
      status: "rejected",
      reason: { kind: "rateLimited", retryAfterMs: 45000 },
    });
    expect(simulator.backoffTimesObserved).toEqual([45]);
    expect(simulator.callsFor(1n)).toBe(1);
  });

  it.each(["pending", "attested", "delivered"] as const)(
    "strips every proof/execution field from a wrapped %s report",
    async (status) => {
      const wrapped: RailClient = {
        rail: "axelar-its",
        look: () =>
          Promise.resolve({
            kind: "found",
            report: {
              status,
              railStatus: "complete",
              reference: "private-reference",
              attestedAt: new Date(),
              forwardTxHash: "0x1234",
              execution: { txHash: "0x5678", commandId: "0xabcd" },
              quarantine: {
                schema: "raw",
                providerReference: "private",
                payload: { delivered: true },
              },
              messageBytes: "private-message",
              attestationSignature: "private-signature",
            },
          }),
      };
      const simulator = new RateLimitSimulator(wrapped);
      expect(await simulator.look(transfer())).toEqual({
        kind: "found",
        report: {
          status: "pending",
          railStatus: "simulated_pending",
          reference: null,
          attestedAt: null,
        },
      });
      expect(() => simulator.simulateDelivered()).toThrow("cannot generate fake delivered");
    },
  );

  it("normalizes malformed provider responses through the same transient boundary as timeouts", async () => {
    const simulator = new RateLimitSimulator();
    simulator.simulateMalformed();
    await expect(simulator.look(transfer())).rejects.toMatchObject({
      kind: "transient",
      rail: "cctp",
    });
    expect(new RailRateLimitError("cctp", 45).retryAfterMs).toBe(45000);
    expect(new RailTimeoutError("cctp")).toBeInstanceOf(RailError);
  });

  it("replays intermittent fault rates deterministically with an injected random source", async () => {
    const outcomes = async () => {
      const samples = [0.1, 0.9, 0.2, 0.9, 0.9];
      const simulator = new RateLimitSimulator({
        timeoutRate: 0.5,
        malformedRate: 0.5,
        random: () => samples.shift() ?? 0.9,
      });
      return Promise.allSettled([
        simulator.look(transfer()),
        simulator.look(transfer()),
        simulator.look(transfer()),
      ]);
    };
    const first = await outcomes(),
      second = await outcomes();
    expect(first.map((result) => result.status)).toEqual(["rejected", "rejected", "fulfilled"]);
    expect(second.map((result) => result.status)).toEqual(first.map((result) => result.status));
  });

  it("rejects invalid rates, delays, random samples and Retry-After bounds", async () => {
    for (const rate of [NaN, Infinity, -1, 2])
      expect(() => new RateLimitSimulator({ timeoutRate: rate })).toThrow(RangeError);
    expect(() => new RateLimitSimulator({ latencyMs: -1 })).toThrow(RangeError);
    const simulator = new RateLimitSimulator({ timeoutRate: 1, random: () => NaN });
    await expect(simulator.look(transfer())).rejects.toThrow(RangeError);
    expect(() => simulator.simulateRetryAfter(Infinity)).toThrow(RangeError);
    expect(() => simulator.simulateRetryAfter(-1)).toThrow(RangeError);
  });

  it("cancels a delayed request before a provider call and can reset queued faults", async () => {
    const simulator = new RateLimitSimulator({ latencyMs: 1000 });
    const controller = new AbortController();
    const request = simulator.look(transfer(), controller.signal);
    controller.abort();
    await expect(request).rejects.toMatchObject({ kind: "transient" });
    expect(simulator.callCount).toBe(0);
    simulator.simulateTimeout();
    simulator.reset();
    expect(simulator.backoffTimesObserved).toEqual([]);
    expect(simulator.callsFor(1n)).toBe(0);
  });
});
