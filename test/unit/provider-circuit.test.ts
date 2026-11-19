import { describe, expect, it } from "vitest";

import { ProviderCircuitBreaker, safeCircuitKey } from "../../src/rails/circuit.js";

describe("provider circuit breaker", () => {
  it("opens after repeated failures and admits only one bounded probe", () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    const breaker = new ProviderCircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 1_000,
      now: () => at,
    });

    breaker.recordFailure("cctp", "Bearer super-secret", at);
    expect(breaker.isPaused("cctp", at)).toBe(false);
    breaker.recordFailure("cctp", "timeout", at);

    expect(breaker.isPaused("cctp", at)).toBe(true);
    expect(breaker.snapshot()[0]).toMatchObject({
      key: "cctp",
      state: "open",
      failures: 2,
      lastReason: "timeout",
    });
    expect(JSON.stringify(breaker.snapshot())).not.toContain("super-secret");

    const later = new Date(at.getTime() + 1_001);
    expect(breaker.isPaused("cctp", later)).toBe(false);
    expect(breaker.allow("cctp", later)).toBe(true);
    expect(breaker.allow("cctp", later)).toBe(false);
    expect(breaker.snapshot()[0]?.state).toBe("half-open");

    breaker.recordSuccess("cctp");
    expect(breaker.snapshot()).toEqual([]);
    expect(breaker.allow("cctp", later)).toBe(true);
  });

  it("doubles the cooldown when a probe fails", () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    const breaker = new ProviderCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 1_000,
      maxCooldownMs: 10_000,
      now: () => at,
    });

    breaker.recordFailure("axelar", "initial", at);
    expect(breaker.snapshot()[0]?.nextProbeAt).toBe("2026-01-01T00:00:01.000Z");

    const probeAt = new Date(at.getTime() + 1_001);
    expect(breaker.allow("axelar", probeAt)).toBe(true);
    breaker.recordFailure("axelar", "probe failed", probeAt);
    expect(breaker.snapshot()[0]?.nextProbeAt).toBe("2026-01-01T00:00:03.001Z");
  });

  it("redacts credentials from circuit identities and reasons", () => {
    expect(safeCircuitKey("https://user:pass@example.com:8443/v1?token=secret")).toBe(
      "https://example.com:8443",
    );
    expect(safeCircuitKey("password=hunter2")).not.toContain("hunter2");
    expect(safeCircuitKey("")).toBe("unknown");
  });
});
