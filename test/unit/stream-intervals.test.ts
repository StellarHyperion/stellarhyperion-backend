import { describe, expect, it } from "vitest";

import { transferStreamIntervals } from "../../src/http/stream-intervals.js";

describe("transfer stream timer bounds", () => {
  it("preserves default and normal client intervals", () => {
    expect(transferStreamIntervals({})).toEqual({ poll: 1000, heartbeat: 15_000 });
    expect(
      transferStreamIntervals({ pollIntervalMs: "5000", heartbeatIntervalMs: "30000" }),
    ).toEqual({ poll: 5000, heartbeat: 30_000 });
  });

  it("accepts both boundaries and clamps values just outside them", () => {
    expect(
      transferStreamIntervals({ pollIntervalMs: "1000", heartbeatIntervalMs: "5000" }),
    ).toEqual({
      poll: 1000,
      heartbeat: 5000,
    });
    expect(
      transferStreamIntervals({ pollIntervalMs: "30000", heartbeatIntervalMs: "60000" }),
    ).toEqual({
      poll: 30_000,
      heartbeat: 60_000,
    });
    expect(transferStreamIntervals({ pollIntervalMs: "999", heartbeatIntervalMs: "4999" })).toEqual(
      {
        poll: 1000,
        heartbeat: 5000,
      },
    );
    expect(
      transferStreamIntervals({ pollIntervalMs: "30001", heartbeatIntervalMs: "60001" }),
    ).toEqual({
      poll: 30_000,
      heartbeat: 60_000,
    });
  });

  it.each(["2147483648", "9007199254740993", "1e309", "Infinity"])(
    "caps %s instead of allowing Node to overflow it into a one-millisecond timer",
    (value) => {
      expect(
        transferStreamIntervals({ pollIntervalMs: value, heartbeatIntervalMs: value }),
      ).toEqual({ poll: 30_000, heartbeat: 60_000 });
    },
  );

  it.each(["-1", "1", "-Infinity"])("enforces minimum intervals for %s", (value) => {
    expect(transferStreamIntervals({ pollIntervalMs: value, heartbeatIntervalMs: value })).toEqual({
      poll: 1000,
      heartbeat: 5000,
    });
  });

  it.each(["invalid", "NaN", ""])("uses defaults for invalid input %s", (value) => {
    expect(transferStreamIntervals({ pollIntervalMs: value, heartbeatIntervalMs: value })).toEqual({
      poll: 1000,
      heartbeat: 15_000,
    });
  });
});
